import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type RateLimit, sleep, TokenBucket } from "../src/adapters/_shared.ts";
import { createMockSubject } from "../src/adapters/mock.ts";
import {
	CASES_ARCHIVE,
	CASES_FILE,
	executeRun,
	type RunnerSubject,
	readProgress,
} from "../src/core/runner.ts";
import type { LoadedScenario } from "../src/core/scenarios.ts";
import type {
	Case,
	RunPlan,
	Scenario,
	SearchSubject,
} from "../src/core/types.ts";

const scenarioBase: Scenario = {
	id: "mini",
	version: "1",
	lang: "en",
	intent: "navigational",
	description: "d",
	rubric: "r",
	k: 10,
	casesFile: "mini.cases.jsonl",
};

function makeCases(queries: readonly string[]): Case[] {
	return queries.map((query, index) => ({
		id: `c${index}`,
		query,
		tier: "A",
		source: "handwritten",
		gold: { targets: ["a.com"] },
	}));
}

function loaded(
	cases: Case[],
	scenario: Partial<Scenario> = {},
): LoadedScenario {
	return { scenario: { ...scenarioBase, ...scenario }, cases, casesHash: "h" };
}

function makePlan(settings: Partial<RunPlan["settings"]> = {}): RunPlan {
	return {
		mode: "live",
		settings: {
			reps: 1,
			timeoutMs: 1000,
			concurrency: 8,
			filters: {},
			...settings,
		},
		scenarios: [],
		subjects: [],
	};
}

function runner(
	subject: SearchSubject,
	limit: RateLimit = { perSecond: 10_000 },
): RunnerSubject {
	return { subject, limiter: new TokenBucket(limit) };
}

async function tempRunDir(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "seekbench-")), "run");
}

function run(
	runDir: string,
	scenarios: LoadedScenario[],
	subjects: Record<string, RunnerSubject>,
	plan = makePlan(),
	signal?: AbortSignal,
	onProgress?: (progress: { done: number }) => void,
) {
	return executeRun({
		runId: "test",
		runDir,
		startedAt: new Date().toISOString(),
		plan,
		scenarios,
		subjects: new Map(Object.entries(subjects)),
		...(signal && { signal }),
		...(onProgress && { onProgress }),
	});
}

/** 记录调用次数与最大在途数的被测对象. */
function countingSubject(delayMs = 0) {
	const stats = { calls: 0, inflight: 0, maxInflight: 0 };
	const subject: SearchSubject = {
		id: "counting",
		kind: "provider",
		langs: ["en"],
		async search(_query, { signal }) {
			stats.calls++;
			stats.inflight++;
			stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
			try {
				if (delayMs > 0) await sleep(delayMs, signal);
				return { hits: [], totalEstimate: 0, cost: 0.001, calls: 1 };
			} finally {
				stats.inflight--;
			}
		},
	};
	return { subject, stats };
}

describe("executeRun", () => {
	it("每个 (用例, 被测对象, 重复) 执行一次, 明细按计划排序, 完成后归档", async () => {
		const runDir = await tempRunDir();
		const hits = {
			q0: [
				{
					url: "https://a.com/",
					title: "",
					snippet: "",
					siteName: null,
					favicon: null,
					publishedAt: null,
				},
			],
		};
		const result = await run(
			runDir,
			[loaded(makeCases(["q0", "q1"]))],
			{
				a: runner(createMockSubject("a", { hits, latencyMs: 5 })),
				b: runner(createMockSubject("b", { hits })),
			},
			makePlan({ reps: 3 }),
		);
		expect(result.interrupted).toBe(false);
		expect(
			result.records.map((r) => `${r.caseId}/${r.subject}/${r.rep}`),
		).toEqual([
			"c0/a/0",
			"c0/a/1",
			"c0/a/2",
			"c0/b/0",
			"c0/b/1",
			"c0/b/2",
			"c1/a/0",
			"c1/a/1",
			"c1/a/2",
			"c1/b/0",
			"c1/b/1",
			"c1/b/2",
		]);
		const first = result.records[0];
		expect(first?.hits[0]?.target).toBe(true);
		expect(first?.hits[0]?.grade).toBe(3);
		expect(first?.latencyMs).toBeGreaterThanOrEqual(4);
		expect(result.records[6]?.hits).toHaveLength(10);

		expect(existsSync(join(runDir, CASES_FILE))).toBe(false);
		const archived = gunzipSync(await readFile(join(runDir, CASES_ARCHIVE)))
			.toString("utf8")
			.trim()
			.split("\n");
		expect(archived).toHaveLength(12);
		const progress = await readProgress(runDir);
		expect(progress.status).toBe("finished");
		expect(progress.done).toBe(12);
		expect(progress.total).toBe(12);
	});

	it("错误与超时记进明细, 不配合 signal 的被测对象也按时超时", async () => {
		const stuck: SearchSubject = {
			id: "stuck",
			kind: "provider",
			langs: ["en"],
			search: () => new Promise(() => {}),
		};
		const runDir = await tempRunDir();
		const result = await run(
			runDir,
			[loaded(makeCases(["ok", "boom", "hang"]))],
			{
				mock: runner(
					createMockSubject("mock", {
						failQueries: ["boom"],
						hangQueries: ["hang"],
					}),
				),
				stuck: runner(stuck),
			},
			makePlan({ timeoutMs: 50 }),
		);
		const byKey = new Map(
			result.records.map((r) => [`${r.caseId}/${r.subject}`, r]),
		);
		expect(byKey.get("c0/mock")?.error).toBeNull();
		expect(byKey.get("c1/mock")?.error).toEqual({
			kind: "error",
			message: "mock: 模拟的服务端错误",
			status: 500,
		});
		expect(byKey.get("c1/mock")?.hits).toEqual([]);
		for (const key of ["c2/mock", "c0/stuck", "c1/stuck", "c2/stuck"]) {
			const record = byKey.get(key);
			expect(record?.error?.kind).toBe("timeout");
			expect(record?.latencyMs).toBeGreaterThanOrEqual(40);
			expect(record?.latencyMs).toBeLessThan(1000);
		}
		expect((await readProgress(runDir)).errors).toBe(5);
	});

	it("被测对象返回不合规的结构时记为错误", async () => {
		const broken = {
			id: "broken",
			kind: "provider",
			langs: ["en"],
			search: async () => ({ hits: [{ url: 1 }] }),
		} as unknown as SearchSubject;
		const result = await run(await tempRunDir(), [loaded(makeCases(["q"]))], {
			broken: runner(broken),
		});
		expect(result.records[0]?.error?.kind).toBe("error");
		expect(result.records[0]?.error?.message).toContain("返回结构不符");
	});

	it("全局在途请求不超过上限", async () => {
		const { subject, stats } = countingSubject(10);
		await run(
			await tempRunDir(),
			[loaded(makeCases(Array.from({ length: 20 }, (_, i) => `q${i}`)))],
			{ counting: runner(subject) },
			makePlan({ concurrency: 3 }),
		);
		expect(stats.calls).toBe(20);
		expect(stats.maxInflight).toBe(3);
	});

	it("按被测对象的令牌桶限速", async () => {
		const { subject } = countingSubject();
		const started = performance.now();
		await run(
			await tempRunDir(),
			[loaded(makeCases(Array.from({ length: 6 }, (_, i) => `q${i}`)))],
			{ counting: runner(subject, { perSecond: 50, burst: 1 }) },
		);
		expect(performance.now() - started).toBeGreaterThanOrEqual(90);
	});

	it("跳过不支持该语言的被测对象, mixed 场景按查询判断语言", async () => {
		const result = await run(
			await tempRunDir(),
			[loaded(makeCases(["Steam 官网", "steam store"]), { lang: "mixed" })],
			{ en: runner(createMockSubject("en", { langs: ["en"] })) },
		);
		expect(result.records.map((r) => r.caseId)).toEqual(["c1"]);
		expect(result.interrupted).toBe(false);
	});

	it("中断后续跑: 已完成的不重跑, 半行被截掉", async () => {
		const runDir = await tempRunDir();
		const scenarios = [
			loaded(makeCases(Array.from({ length: 6 }, (_, i) => `q${i}`))),
		];
		const plan = makePlan({ reps: 2, concurrency: 1 });
		const controller = new AbortController();
		const first = countingSubject(2);
		const interrupted = await run(
			runDir,
			scenarios,
			{ counting: runner(first.subject) },
			plan,
			controller.signal,
			({ done }) => {
				if (done >= 5) controller.abort();
			},
		);
		expect(interrupted.interrupted).toBe(true);
		expect(interrupted.records).toHaveLength(5);
		expect((await readProgress(runDir)).status).toBe("interrupted");
		await appendFile(join(runDir, CASES_FILE), '{"scenario":"mi');

		const second = countingSubject();
		const resumed = await run(
			runDir,
			scenarios,
			{ counting: runner(second.subject) },
			plan,
		);
		expect(resumed.interrupted).toBe(false);
		expect(resumed.records).toHaveLength(12);
		expect(second.stats.calls).toBe(7);
		const keys = resumed.records.map((r) => `${r.caseId}/${r.rep}`);
		expect(new Set(keys).size).toBe(12);
		const progress = await readProgress(runDir);
		expect(progress.status).toBe("finished");
		expect(progress.done).toBe(12);
	});
});
