import { z } from "zod";
import { mulberry32, seedFrom } from "../core/bootstrap.ts";
import { normalizeUrl } from "../core/normalize.ts";
import type { LoadedScenario } from "../core/scenarios.ts";
import { maxGradeOf } from "../core/scenarios.ts";
import type { Agreement, Case, CaseRecord, ScoredHit } from "../core/types.ts";
import { Grade } from "../core/types.ts";
import { agreement, type GradePair } from "./agreement.ts";
import { judgeCaseOf } from "./judge-run.ts";
import { judgmentKey } from "./rubric.ts";

/**
 * 人工复核文件 audit.jsonl 的一行. 只给复核人看裁判看到的内容, 不含裁判等级与被测对象,
 * 复核人填 grade (待填为 null), 可在 comment 里写理由.
 */
export const AuditItem = z.object({
	/** 裁判缓存键, judge:audit 据此找回裁判等级. */
	id: z.string(),
	scenario: z.string(),
	caseId: z.string(),
	query: z.string(),
	note: z.string().optional(),
	meanings: z.array(z.string()).optional(),
	url: z.string(),
	title: z.string(),
	snippet: z.string(),
	publishedAt: z.string().nullable(),
	grade: Grade.nullable(),
	comment: z.string().optional(),
});
export type AuditItem = z.infer<typeof AuditItem>;

/** 校准集 labels.jsonl 的一行: 一条人工确认过等级的结果. */
export const Label = z.object({
	scenario: z.string(),
	query: z.string(),
	note: z.string().optional(),
	meanings: z.array(z.string()).optional(),
	url: z.string(),
	title: z.string(),
	snippet: z.string(),
	publishedAt: z.string().nullable(),
	grade: Grade,
	/** 标注来源, 如 audit:<run-id>. */
	source: z.string().min(1),
	labeledAt: z.iso.datetime(),
});
export type Label = z.infer<typeof Label>;

function casesById(
	scenarios: readonly LoadedScenario[],
): Map<string, Map<string, Case>> {
	return new Map(
		scenarios.map(({ scenario, cases }) => [
			scenario.id,
			new Map(cases.map((kase) => [kase.id, kase])),
		]),
	);
}

/** 裁判给这条结果的等级; 被人工等级覆盖过的取覆盖前的裁判等级, 没有裁判等级时为 null. */
function judgeGradeOf(hit: ScoredHit): number | null {
	if (hit.gradeSource === "judge") return hit.grade;
	if (hit.gradeSource === "human") return hit.judgeGrade ?? null;
	return null;
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let index = out.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[out[index], out[other]] = [out[other] as T, out[index] as T];
	}
	return out;
}

export interface SampleOptions {
	size: number;
	/** 抽样种子; 同一运行同一种子抽到同一批. */
	seed: string;
	/** 运行时裁判是否抓正文, 决定缓存键. */
	fetch: boolean;
}

/**
 * 从裁判判定过的结果里按 (被测对象, 等级) 分层抽样: 各层轮流取一条, 直到抽满或取尽,
 * 这样少见的等级与每个被测对象都有代表. 内容相同的结果只抽一次, 输出顺序打乱.
 */
export function sampleAudit(
	records: readonly CaseRecord[],
	scenarios: readonly LoadedScenario[],
	options: SampleOptions,
): AuditItem[] {
	const cases = casesById(scenarios);
	const items = new Map<string, AuditItem>();
	const strata = new Map<string, string[]>();
	for (const record of records) {
		const kase = cases.get(record.scenario)?.get(record.caseId);
		if (!kase || record.error !== null) continue;
		const judgeCase = judgeCaseOf(kase);
		for (const hit of record.hits) {
			const grade = judgeGradeOf(hit);
			if (grade === null) continue;
			const id = judgmentKey(judgeCase, hit, options.fetch);
			const stratum = `${record.subject}|${grade}`;
			const members = strata.get(stratum) ?? [];
			if (!members.includes(id)) members.push(id);
			strata.set(stratum, members);
			if (items.has(id)) continue;
			items.set(id, {
				id,
				scenario: record.scenario,
				caseId: record.caseId,
				query: kase.query,
				...(kase.note !== undefined && { note: kase.note }),
				...(kase.gold?.meanings && { meanings: kase.gold.meanings }),
				url: hit.url,
				title: hit.title,
				snippet: hit.snippet,
				publishedAt: hit.publishedAt,
				grade: null,
			});
		}
	}
	const random = mulberry32(seedFrom(options.seed));
	const queues = [...strata.keys()]
		.sort()
		.map((stratum) => shuffle(strata.get(stratum) ?? [], random));
	const picked = new Set<string>();
	while (
		picked.size < options.size &&
		queues.some((queue) => queue.length > 0)
	) {
		for (const queue of queues) {
			if (picked.size >= options.size) break;
			while (queue.length > 0) {
				const id = queue.shift() as string;
				if (picked.has(id)) continue;
				picked.add(id);
				break;
			}
		}
	}
	return shuffle(
		[...picked].map((id) => items.get(id) as AuditItem),
		random,
	);
}

export interface AuditResult {
	agreement: Agreement;
	/** 已填等级的条数中, 在运行明细里找不到裁判等级的条数. */
	unmatched: number;
	/** 尚未填写等级的条数. */
	pending: number;
	/** 已填等级的复核项, 转成校准集标注. */
	labels: Label[];
}

/** 把复核人填的等级与运行明细里的裁判等级逐条比较. */
export function auditRun(
	items: readonly AuditItem[],
	records: readonly CaseRecord[],
	scenarios: readonly LoadedScenario[],
	options: { fetch: boolean; runId: string; now?: Date },
): AuditResult {
	const cases = casesById(scenarios);
	const judged = new Map<string, number>();
	for (const record of records) {
		const kase = cases.get(record.scenario)?.get(record.caseId);
		if (!kase) continue;
		const judgeCase = judgeCaseOf(kase);
		for (const hit of record.hits) {
			const grade = judgeGradeOf(hit);
			if (grade === null) continue;
			judged.set(
				`${record.scenario}|${judgmentKey(judgeCase, hit, options.fetch)}`,
				grade,
			);
		}
	}
	const pairs: GradePair[] = [];
	const labels: Label[] = [];
	let unmatched = 0;
	let pending = 0;
	const labeledAt = (options.now ?? new Date()).toISOString();
	for (const item of items) {
		if (item.grade === null) {
			pending++;
			continue;
		}
		const { id: _, caseId: __, comment: ___, grade, ...content } = item;
		labels.push({
			...content,
			grade,
			source: `audit:${options.runId}`,
			labeledAt,
		});
		const judge = judged.get(`${item.scenario}|${item.id}`);
		if (judge === undefined) unmatched++;
		else pairs.push([grade, judge]);
	}
	const maxGrade = Math.max(
		3,
		...scenarios.map(({ scenario }) => maxGradeOf(scenario)),
	);
	return { agreement: agreement(pairs, maxGrade), unmatched, pending, labels };
}

/**
 * 用复核人填的等级覆盖运行明细里对应结果的裁判等级, 覆盖前的裁判等级留在 judgeGrade.
 * 复核文件里等级被清空的条目恢复为裁判等级, 所以可以反复执行. 返回新明细与被覆盖的结果条数.
 */
export function applyAudit(
	items: readonly AuditItem[],
	records: readonly CaseRecord[],
	scenarios: readonly LoadedScenario[],
	options: { fetch: boolean },
): { records: CaseRecord[]; applied: number } {
	const cases = casesById(scenarios);
	const human = new Map(
		items.map((item) => [`${item.scenario}|${item.id}`, item.grade]),
	);
	let applied = 0;
	const out = records.map((record) => {
		const kase = cases.get(record.scenario)?.get(record.caseId);
		if (!kase) return record;
		const judgeCase = judgeCaseOf(kase);
		return {
			...record,
			hits: record.hits.map((hit): ScoredHit => {
				const judge = judgeGradeOf(hit);
				if (judge === null) return hit;
				const grade = human.get(
					`${record.scenario}|${judgmentKey(judgeCase, hit, options.fetch)}`,
				);
				const { judgeGrade: _, ...rest } = hit;
				if (grade === undefined || grade === null)
					return { ...rest, grade: judge, gradeSource: "judge" };
				applied++;
				return { ...rest, grade, gradeSource: "human", judgeGrade: judge };
			}),
		};
	});
	return { records: out, applied };
}

/** 标注的去重键: 同一场景下裁判看到的内容相同即为同一条. */
export function labelKey(
	label: Omit<Label, "grade" | "source" | "labeledAt">,
): string {
	return `${label.scenario}|${judgmentKey(
		{ query: label.query, note: label.note, meanings: label.meanings },
		{
			normalizedUrl: normalizeUrl(label.url) ?? label.url,
			title: label.title,
			snippet: label.snippet,
			publishedAt: label.publishedAt,
		},
		false,
	)}`;
}
