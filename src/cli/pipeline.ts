import { resolve } from "node:path";
import { TokenBucket } from "../adapters/_shared.ts";
import type { Config } from "../core/config.ts";
import { createModel } from "../core/model.ts";
import { summarize } from "../core/report.ts";
import type { LoadedScenario } from "../core/scenarios.ts";
import type { CaseRecord, Run, RunJudge, RunPlan } from "../core/types.ts";
import { JudgmentCache } from "../judge/cache.ts";
import { judgeRecords } from "../judge/judge-run.ts";
import { JUDGE_PROMPT_VERSION } from "../judge/rubric.ts";
import { progressPrinter } from "./shared.ts";

export interface JudgeStepOptions {
	config: Config;
	root: string;
	env: Readonly<Record<string, string | undefined>>;
	scenarios: readonly LoadedScenario[];
	records: readonly CaseRecord[];
	/** 覆盖配置里的 fetch. */
	fetch?: boolean | undefined;
	/** 覆盖配置里的 judgmentsDir. */
	judgmentsDir?: string | undefined;
	signal?: AbortSignal;
}

export interface JudgeStepResult {
	records: CaseRecord[];
	judge: RunJudge;
	interrupted: boolean;
}

/**
 * 运行收尾的裁判步骤: 给规则没有判定的结果打裁判分, 打印用量. 缺密钥时只用缓存, 并提示有多少条没能判定.
 * 配置里没有裁判时不应调用.
 */
export async function judgeStep(
	options: JudgeStepOptions,
): Promise<JudgeStepResult> {
	const judge = options.config.judge;
	if (!judge) throw new Error("配置里没有 judge");
	const fetch = options.fetch ?? judge.fetch;
	const handle = createModel(judge, options.env);
	if (handle === null) {
		process.stderr.write(
			`裁判缺少环境变量 ${judge.apiKeyEnv}, 只使用已有的裁判缓存\n`,
		);
	}
	const cache = new JudgmentCache(
		options.judgmentsDir === undefined
			? resolve(options.root, options.config.judgmentsDir)
			: resolve(options.judgmentsDir),
		judge.model,
	);
	const printer = progressPrinter("裁判 ");
	let last = { done: 0, total: 0 };
	const result = await judgeRecords(options.scenarios, options.records, {
		cache,
		handle,
		fetch,
		maxItemsPerCall: judge.maxItemsPerCall,
		concurrency: judge.concurrency,
		limiter: new TokenBucket(judge.rateLimit),
		today: new Date().toISOString().slice(0, 10),
		...(options.signal && { signal: options.signal }),
		onProgress: (progress) => {
			last = progress;
			printer.update(progress);
		},
	});
	if (last.total > 0) printer.end(last);
	const { usage } = result;
	process.stderr.write(
		`裁判 ${judge.model}: ${usage.items} 条结果, 缓存命中 ${usage.cached}, 调用 ${usage.calls} 次 (输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} tokens), 未能判定 ${usage.failed + result.uncached}\n`,
	);
	for (const message of result.errors)
		process.stderr.write(`裁判调用失败: ${message}\n`);
	return {
		records: result.records,
		judge: {
			model: judge.model,
			rubricVersion: JUDGE_PROMPT_VERSION,
			fetch,
			usage: { ...usage, failed: usage.failed + result.uncached },
		},
		interrupted: result.interrupted,
	};
}

/** 清掉明细里的裁判等级与覆盖它的人工等级, 重新判定前用; 规则等级保留. */
export function clearJudgments(records: readonly CaseRecord[]): CaseRecord[] {
	return records.map((record) => ({
		...record,
		hits: record.hits.map((hit) => {
			if (hit.gradeSource !== "judge" && hit.gradeSource !== "human")
				return hit;
			const { judgment: _, judgeGrade: __, ...rest } = hit;
			return { ...rest, grade: null, gradeSource: null, meaning: null };
		}),
	}));
}

/** 被测对象用到的最早录制日期, 没有录制时为 null. */
function oldestRecording(
	records: readonly CaseRecord[],
	subject: string,
): string | null {
	let oldest: string | null = null;
	for (const record of records) {
		if (record.subject !== subject || record.recordedAt === undefined) continue;
		if (oldest === null || record.recordedAt < oldest)
			oldest = record.recordedAt;
	}
	return oldest?.slice(0, 10) ?? null;
}

/** 由计划与全部明细组装 run.json. */
export function buildRun(options: {
	runId: string;
	startedAt: string;
	finishedAt: string;
	plan: RunPlan;
	records: readonly CaseRecord[];
	scenarios: readonly LoadedScenario[];
	judge: RunJudge | null;
}): Run {
	const { plan, records } = options;
	return {
		id: options.runId,
		startedAt: options.startedAt,
		finishedAt: options.finishedAt,
		mode: plan.mode,
		...(plan.region !== undefined && { region: plan.region }),
		settings: plan.settings,
		scenarios: plan.scenarios.map(({ casesHash: _, ...scenario }) => scenario),
		subjects: plan.subjects.map(({ config: _, ...subject }) => {
			const cassetteDate = oldestRecording(records, subject.id);
			return cassetteDate ? { ...subject, cassetteDate } : subject;
		}),
		judge: options.judge,
		summary: summarize(
			records,
			options.scenarios,
			plan.subjects.map((subject) => subject.id),
		),
	};
}
