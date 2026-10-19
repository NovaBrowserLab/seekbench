import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/adapters/_shared.ts";
import { createMockSubject } from "../src/adapters/mock.ts";
import {
	type CassetteEntry,
	CassetteStore,
	cassetteKey,
} from "../src/core/cassette.ts";
import { executeRun } from "../src/core/runner.ts";
import type { LoadedScenario } from "../src/core/scenarios.ts";
import type { RunMode, RunPlan, SearchSubject } from "../src/core/types.ts";

const shard = { subject: "fusion:a+b", scenario: "nav-zh", version: "1" };

function entry(query: string, url: string): CassetteEntry {
	const request = { lang: "zh" as const, count: 10 };
	return {
		key: cassetteKey(shard.subject, query, request),
		subject: shard.subject,
		query,
		request,
		configHash: "h",
		recordedAt: "2026-10-01T00:00:00.000Z",
		latencyMs: 12,
		response: {
			hits: [
				{
					url,
					title: "",
					snippet: "",
					siteName: null,
					favicon: null,
					publishedAt: null,
				},
			],
			totalEstimate: null,
			raw: { url },
			cost: 0.001,
			calls: 1,
		},
	};
}

describe("CassetteStore", () => {
	it("键只取决于被测对象、查询与请求参数, 与属性顺序无关", () => {
		expect(
			cassetteKey("a", "q", { lang: "zh", count: 10, site: "x.com" }),
		).toBe(cassetteKey("a", "q", { site: "x.com", count: 10, lang: "zh" }));
		expect(cassetteKey("a", "q", { lang: "zh", count: 10 })).not.toBe(
			cassetteKey("b", "q", { lang: "zh", count: 10 }),
		);
	});

	it("追加写入, 新实例能读回; 同键以后写的为准; compact 后只剩去重的一份", async () => {
		const dir = await mkdtemp(join(tmpdir(), "seekbench-cassette-"));
		const store = new CassetteStore(dir);
		expect(store.path(shard)).toBe(
			join(dir, "fusion%3Aa%2Bb", "nav-zh@1.jsonl.gz"),
		);
		await store.put(shard, entry("q1", "https://a.com/"));
		await store.put(shard, entry("q2", "https://b.com/"));
		await store.put(shard, entry("q1", "https://c.com/"));

		const reread = new CassetteStore(dir);
		const first = await reread.get(shard, entry("q1", "").key);
		expect(first?.response.hits[0]?.url).toBe("https://c.com/");
		expect((await reread.load(shard)).size).toBe(2);

		await store.compact();
		const lines = gunzipSync(await readFile(store.path(shard)))
			.toString("utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(2);
	});

	it("中断留下的不完整尾部被丢弃, 之前的录制仍可读", async () => {
		const dir = await mkdtemp(join(tmpdir(), "seekbench-cassette-"));
		const store = new CassetteStore(dir);
		await store.put(shard, entry("q1", "https://a.com/"));
		const partial = gzipSync(
			`${JSON.stringify(entry("q2", "https://b.com/"))}\n`,
		);
		await appendFile(
			store.path(shard),
			partial.subarray(0, partial.length - 12),
		);
		const reread = new CassetteStore(dir);
		expect(await reread.get(shard, entry("q1", "").key)).not.toBeNull();
	});
});

function scenario(): LoadedScenario {
	return {
		scenario: {
			id: "mini",
			version: "2",
			lang: "en",
			intent: "navigational",
			description: "d",
			rubric: "r",
			k: 10,
			casesFile: "x",
		},
		cases: ["q0", "q1"].map((query, index) => ({
			id: `c${index}`,
			query,
			tier: "A" as const,
			source: "handwritten" as const,
			gold: { targets: ["a.com"] },
		})),
		casesHash: "h",
	};
}

function plan(mode: RunMode, configHash = "cfg", refresh = false): RunPlan {
	return {
		mode,
		...(refresh && { refresh }),
		settings: { reps: 1, timeoutMs: 1000, concurrency: 4, filters: {} },
		scenarios: [],
		subjects: [{ id: "m", kind: "provider", configHash, config: {} }],
	};
}

async function runWith(
	mode: RunMode,
	subject: SearchSubject,
	cassettes: CassetteStore,
	configHash?: string,
	refresh?: boolean,
) {
	return executeRun({
		runId: "t",
		runDir: join(await mkdtemp(join(tmpdir(), "seekbench-")), "run"),
		startedAt: new Date().toISOString(),
		plan: plan(mode, configHash, refresh),
		scenarios: [scenario()],
		subjects: new Map([
			["m", { subject, limiter: new TokenBucket({ perSecond: 10_000 }) }],
		]),
		cassettes,
	});
}

describe("录制与回放", () => {
	const hits = {
		q0: [
			{
				url: "https://a.com/",
				title: "A",
				snippet: "",
				siteName: null,
				favicon: null,
				publishedAt: null,
			},
		],
	};

	it("record 录下成功的结果, replay 不调用被测对象而得到相同的明细", async () => {
		const dir = await mkdtemp(join(tmpdir(), "seekbench-cassette-"));
		const recorded = await runWith(
			"record",
			createMockSubject("m", { hits, failQueries: ["q1"], costPerCall: 0.002 }),
			new CassetteStore(dir),
		);
		expect(recorded.records.map((r) => r.error?.kind ?? "ok")).toEqual([
			"ok",
			"error",
		]);
		expect(recorded.records[0]?.recordedAt).toBeDefined();

		const silent: SearchSubject = {
			id: "m",
			kind: "provider",
			langs: ["en"],
			search: () => {
				throw new Error("回放不应发请求");
			},
		};
		const replayed = await runWith("replay", silent, new CassetteStore(dir));
		const [ok, missing] = replayed.records;
		expect(ok?.error).toBeNull();
		expect(ok?.hits[0]?.grade).toBe(3);
		expect(ok?.cost).toBe(0.002);
		expect(ok?.latencyMs).toBe(recorded.records[0]?.latencyMs);
		expect(ok?.recordedAt).toBe(recorded.records[0]?.recordedAt);
		expect(missing?.error?.message).toBe("录制中没有这条请求");
		expect(replayed.configMismatch).toEqual([]);
	});

	it("被测对象实现 replay 时从原始响应重新归一化, 配置变化会被报告", async () => {
		const dir = await mkdtemp(join(tmpdir(), "seekbench-cassette-"));
		const store = new CassetteStore(dir);
		const live = createMockSubject("m", { hits });
		await runWith(
			"record",
			{
				...live,
				search: async (query, options) => ({
					...(await live.search(query, options)),
					raw: { fixed: "https://a.com/fixed" },
				}),
			},
			store,
		);
		const renormalizing: SearchSubject = {
			...live,
			replay: (raw) => ({
				hits: [
					{
						url: (raw as { fixed: string }).fixed,
						title: "",
						snippet: "",
						siteName: null,
						favicon: null,
						publishedAt: null,
					},
				],
				totalEstimate: null,
				cost: 0,
				calls: 1,
			}),
		};
		const replayed = await runWith(
			"replay",
			renormalizing,
			new CassetteStore(dir),
			"changed",
		);
		expect(replayed.records[0]?.hits[0]?.url).toBe("https://a.com/fixed");
		expect(replayed.configMismatch).toEqual(["m"]);
	});

	it("record 默认复用同配置的已有录制, 只补录缺的; 配置变化或 --refresh 时重新请求", async () => {
		const dir = await mkdtemp(join(tmpdir(), "seekbench-cassette-"));
		const calls: string[] = [];
		const failing = new Set(["q1"]);
		const inner = createMockSubject("m", { hits });
		const counting: SearchSubject = {
			...inner,
			search: async (query, options) => {
				calls.push(query);
				if (failing.has(query)) throw new Error("暂时失败");
				return inner.search(query, options);
			},
		};
		const first = await runWith("record", counting, new CassetteStore(dir));
		expect(calls).toEqual(["q0", "q1"]);
		expect(first.reused).toBe(0);

		calls.length = 0;
		failing.clear();
		const second = await runWith("record", counting, new CassetteStore(dir));
		expect(calls).toEqual(["q1"]);
		expect(second.reused).toBe(1);
		expect(second.records[0]?.recordedAt).toBe(first.records[0]?.recordedAt);
		expect(second.records[0]?.hits[0]?.grade).toBe(3);

		calls.length = 0;
		await runWith("record", counting, new CassetteStore(dir), "changed");
		expect(calls).toEqual(["q0", "q1"]);

		calls.length = 0;
		const refreshed = await runWith(
			"record",
			counting,
			new CassetteStore(dir),
			"changed",
			true,
		);
		expect(calls).toEqual(["q0", "q1"]);
		expect(refreshed.reused).toBe(0);
	});
});
