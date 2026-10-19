import type { TokenBucket } from "../adapters/_shared.ts";
import type { ModelHandle } from "../core/model.ts";
import { Semaphore } from "../core/runner.ts";
import type { LoadedScenario } from "../core/scenarios.ts";
import type {
	Case,
	CaseRecord,
	RunJudge,
	Scenario,
	ScoredHit,
} from "../core/types.ts";
import type { CachedJudgment, JudgmentCache } from "./cache.ts";
import { fetchPageText } from "./fetch-page.ts";
import { JudgeFatalError, judgeBatch } from "./llm-judge.ts";
import {
	type JudgeCase,
	type JudgeItem,
	judgmentKey,
	rubricHash,
} from "./rubric.ts";

export function judgeCaseOf(kase: Case): JudgeCase {
	return {
		query: kase.query,
		note: kase.note,
		meanings: kase.gold?.meanings,
	};
}

/** 一条用例 (或一条标注查询) 下待判定的结果. */
export interface JudgeGroup {
	scenario: Scenario;
	kase: JudgeCase;
	items: readonly JudgeItem[];
}

export interface ResolveOptions {
	cache: JudgmentCache;
	/** 为 null 时只用缓存, 缓存里没有的结果保持未判定. */
	handle: ModelHandle | null;
	fetch: boolean;
	maxItemsPerCall: number;
	concurrency: number;
	limiter: TokenBucket;
	/** 提示词里的今天, YYYY-MM-DD. */
	today: string;
	signal?: AbortSignal;
	fetchPage?: (url: string, signal?: AbortSignal) => Promise<string | null>;
	onProgress?: (progress: { done: number; total: number }) => void;
}

export interface ResolveResult {
	/** 键为 JudgeItem.key. */
	judgments: Map<string, CachedJudgment>;
	usage: NonNullable<RunJudge["usage"]>;
	/** 没有可用的裁判模型而缓存里也没有的条数. */
	uncached: number;
	/** 调用失败的批次的错误信息, 去重后最多保留几条. */
	errors: string[];
	interrupted: boolean;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		out.push(items.slice(index, index + size));
	}
	return out;
}

/**
 * 取得每组结果的裁判判定: 先查缓存, 其余按 maxItemsPerCall 分批送裁判, 新判定写回缓存.
 * 单批失败只让这批结果保持未判定; 鉴权一类的错误中止全部调用并抛出.
 */
export async function resolveJudgments(
	groups: readonly JudgeGroup[],
	options: ResolveOptions,
): Promise<ResolveResult> {
	const { cache, handle, fetch } = options;
	const fetchPage = options.fetchPage ?? fetchPageText;
	const usage = {
		items: 0,
		cached: 0,
		failed: 0,
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
	};
	const judgments = new Map<string, CachedJudgment>();
	const errors = new Set<string>();
	let uncached = 0;
	const jobs: Array<{ group: JudgeGroup; items: JudgeItem[] }> = [];
	for (const group of groups) {
		const shard = {
			scenario: group.scenario.id,
			rubric: rubricHash(group.scenario, fetch),
		};
		const misses: JudgeItem[] = [];
		for (const item of group.items) {
			usage.items++;
			const cached = await cache.get(shard, item.key);
			if (cached) {
				judgments.set(item.key, cached);
				usage.cached++;
			} else misses.push(item);
		}
		if (misses.length === 0) continue;
		if (handle === null) uncached += misses.length;
		else
			for (const items of chunk(misses, options.maxItemsPerCall))
				jobs.push({ group, items });
	}

	const internal = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, internal.signal])
		: internal.signal;
	const slots = new Semaphore(options.concurrency);
	let fatal: unknown = null;
	let done = 0;
	options.onProgress?.({ done, total: jobs.length });
	if (handle !== null) {
		await Promise.all(
			jobs.map(async ({ group, items }) => {
				try {
					await options.limiter.take(signal);
					await slots.acquire(signal);
				} catch {
					return;
				}
				try {
					const batch = fetch
						? await Promise.all(
								items.map(async (item) => ({
									...item,
									content: await fetchPage(item.url, signal),
								})),
							)
						: items;
					const result = await judgeBatch(handle, {
						scenario: group.scenario,
						kase: group.kase,
						items: batch,
						today: options.today,
						signal,
					});
					usage.calls += result.usage.calls;
					usage.inputTokens += result.usage.inputTokens;
					usage.outputTokens += result.usage.outputTokens;
					usage.failed += items.length - result.judgments.size;
					for (const [key, judgment] of result.judgments)
						judgments.set(key, judgment);
					await cache.put(
						{
							scenario: group.scenario.id,
							rubric: rubricHash(group.scenario, fetch),
						},
						result.judgments,
					);
				} catch (error) {
					if (signal.aborted) return;
					if (error instanceof JudgeFatalError) {
						fatal ??= error;
						internal.abort();
						return;
					}
					usage.failed += items.length;
					if (errors.size < 5)
						errors.add(error instanceof Error ? error.message : String(error));
				} finally {
					slots.release();
				}
				done++;
				options.onProgress?.({ done, total: jobs.length });
			}),
		);
	}
	if (fatal !== null) throw fatal;
	return {
		judgments,
		usage,
		uncached,
		errors: [...errors],
		interrupted: options.signal?.aborted ?? false,
	};
}

export interface JudgeRunResult extends Omit<ResolveResult, "judgments"> {
	/** 填入裁判等级后的明细, 顺序与输入一致. */
	records: CaseRecord[];
}

/**
 * 给运行明细里规则没有判定的结果打裁判分. 一条用例在所有被测对象下的结果合并成一组、按缓存键去重,
 * 同一次调用里一起判定.
 */
export async function judgeRecords(
	scenarios: readonly LoadedScenario[],
	records: readonly CaseRecord[],
	options: ResolveOptions,
): Promise<JudgeRunResult> {
	const { fetch } = options;
	const cases = new Map<string, Map<string, Case>>();
	const scenarioById = new Map<string, Scenario>();
	for (const { scenario, cases: list } of scenarios) {
		scenarioById.set(scenario.id, scenario);
		cases.set(scenario.id, new Map(list.map((kase) => [kase.id, kase])));
	}
	const keyOf = (record: CaseRecord, hit: ScoredHit): string | null => {
		const kase = cases.get(record.scenario)?.get(record.caseId);
		return kase ? judgmentKey(judgeCaseOf(kase), hit, fetch) : null;
	};

	const groups = new Map<
		string,
		{ scenario: Scenario; kase: JudgeCase; items: Map<string, JudgeItem> }
	>();
	for (const record of records) {
		if (record.error !== null) continue;
		const scenario = scenarioById.get(record.scenario);
		const kase = cases.get(record.scenario)?.get(record.caseId);
		if (!scenario || !kase) continue;
		const id = JSON.stringify([record.scenario, record.caseId]);
		let group = groups.get(id);
		if (!group) {
			group = { scenario, kase: judgeCaseOf(kase), items: new Map() };
			groups.set(id, group);
		}
		for (const hit of record.hits) {
			if (hit.grade !== null) continue;
			const key = judgmentKey(group.kase, hit, fetch);
			if (group.items.has(key)) continue;
			group.items.set(key, {
				key,
				url: hit.url,
				title: hit.title,
				snippet: hit.snippet,
				publishedAt: hit.publishedAt,
			});
		}
	}
	const { judgments, ...rest } = await resolveJudgments(
		[...groups.values()].map((group) => ({
			...group,
			items: [...group.items.values()],
		})),
		options,
	);

	const judged = records.map((record) => {
		const kase = cases.get(record.scenario)?.get(record.caseId);
		return {
			...record,
			hits: record.hits.map((hit) => {
				if (hit.grade !== null || record.error !== null) return hit;
				const key = keyOf(record, hit);
				const judgment = key === null ? undefined : judgments.get(key);
				if (!judgment) return hit;
				return {
					...hit,
					grade: judgment.grade,
					gradeSource: "judge" as const,
					meaning: kase?.gold?.meanings ? (judgment.meaning ?? null) : null,
					judgment: {
						reason: judgment.reason,
						sourceTier: judgment.sourceTier,
						stale: judgment.stale,
					},
				};
			}),
		};
	});
	return { records: judged, ...rest };
}
