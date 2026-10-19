import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/adapters/_shared.ts";
import type { ModelHandle } from "../src/core/model.ts";
import { normalizeUrl, registrableDomain } from "../src/core/normalize.ts";
import type { LoadedScenario } from "../src/core/scenarios.ts";
import type {
	Case,
	CaseRecord,
	Scenario,
	ScoredHit,
} from "../src/core/types.ts";
import {
	agreement,
	confusionMatrix,
	weightedKappa,
} from "../src/judge/agreement.ts";
import {
	applyAudit,
	auditRun,
	labelKey,
	sampleAudit,
} from "../src/judge/audit.ts";
import { JudgmentCache } from "../src/judge/cache.ts";
import { calibrate, ruleLabels } from "../src/judge/calibrate.ts";
import { htmlToText } from "../src/judge/fetch-page.ts";
import { judgeRecords } from "../src/judge/judge-run.ts";
import { JudgeFatalError, judgeBatch } from "../src/judge/llm-judge.ts";
import { buildPrompt, judgmentKey, rubricHash } from "../src/judge/rubric.ts";

const scenario: Scenario = {
	id: "mini",
	version: "1",
	lang: "en",
	intent: "informational",
	description: "场景说明",
	rubric: "打分说明",
	k: 10,
	casesFile: "mini.cases.jsonl",
};

const cases: Case[] = [
	{
		id: "rust",
		query: "rust async book",
		tier: "A",
		source: "handwritten",
		note: "Rust 官方的异步编程书",
		gold: { targets: ["rust-lang.github.io/async-book"] },
	},
	{
		id: "apple",
		query: "apple event",
		tier: "B",
		source: "synth:t",
		note: "苹果发布会",
		gold: { meanings: ["Apple 公司的发布会", "水果"] },
	},
];

const loaded: LoadedScenario[] = [{ scenario, cases, casesHash: "h" }];

function hit(
	url: string,
	rank: number,
	extra: Partial<ScoredHit> = {},
): ScoredHit {
	const normalizedUrl = normalizeUrl(url) as string;
	return {
		url,
		title: `title of ${url}`,
		snippet: `snippet of ${url}`,
		siteName: null,
		favicon: null,
		publishedAt: null,
		rank,
		normalizedUrl,
		domain: registrableDomain(new URL(normalizedUrl).hostname),
		target: false,
		bad: false,
		fresh: null,
		grade: null,
		gradeSource: null,
		meaning: null,
		...extra,
	};
}

function record(
	subject: string,
	caseId: string,
	hits: ScoredHit[],
	error: CaseRecord["error"] = null,
): CaseRecord {
	return {
		scenario: "mini",
		caseId,
		subject,
		rep: 0,
		startedAt: "2026-10-19T00:00:00.000Z",
		latencyMs: 1,
		cost: 0,
		calls: 1,
		retries: 0,
		requestId: null,
		totalEstimate: null,
		rawCount: hits.length,
		duplicates: 0,
		invalid: 0,
		hits,
		error,
	};
}

const usage = {
	inputTokens: {
		total: 100,
		noCache: 100,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 20, text: 20, reasoning: undefined },
};

interface Seen {
	id: string;
	url: string;
}

/** 从提示词里读出 [rN] 与 URL 的对应, 按 respond 的返回生成裁判输出. */
function scriptedModel(
	respond: (items: Seen[], call: number) => unknown,
	prompts: string[] = [],
): ModelHandle {
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			const text = options.prompt
				.map((message) =>
					typeof message.content === "string"
						? message.content
						: message.content
								.map((part) => (part.type === "text" ? part.text : ""))
								.join(""),
				)
				.join("\n");
			prompts.push(text);
			const items = [
				...text.matchAll(/\[(r\d+)\]\n标题: .*\nURL: (.*)\n/g),
			].map(([, id, url]) => ({ id: id as string, url: url as string }));
			const output = respond(items, prompts.length);
			return {
				content: [
					{
						type: "text",
						text: typeof output === "string" ? output : JSON.stringify(output),
					},
				],
				finishReason: { unified: "stop", raw: undefined },
				usage,
				warnings: [],
			};
		},
	});
	return {
		id: "scripted",
		model,
		providerOptions: {},
		structuredOutputs: false,
	};
}

/** URL 里含 good 记 3, 其余记 1. */
function gradeByUrl(items: Seen[]) {
	return {
		judgments: items.map(({ id, url }) => ({
			id,
			reason: "理由",
			grade: url.includes("good") ? 3 : 1,
			sourceTier: "reputable",
			stale: "fresh",
		})),
	};
}

function judgeItem(url: string) {
	return {
		key: url,
		url,
		title: `title of ${url}`,
		snippet: "s",
		publishedAt: null,
	};
}

const rustCase = { query: "rust async book", note: "Rust 官方的异步编程书" };

describe("agreement", () => {
	it("二次加权 Kappa 与手算一致", () => {
		const human = [0, 1, 2, 3, 3, 2, 1, 0];
		const judge = [0, 2, 2, 3, 2, 1, 1, 1];
		const pairs = human.map(
			(grade, index) => [grade, judge[index] as number] as const,
		);
		expect(weightedKappa(pairs, 3)).toBeCloseTo(0.75, 12);
		expect(
			weightedKappa(
				[
					[0, 3],
					[3, 0],
					[1, 2],
					[2, 1],
				],
				3,
			),
		).toBeCloseTo(-1, 12);
		expect(
			weightedKappa(
				[
					[0, 0],
					[1, 1],
					[3, 3],
				],
				3,
			),
		).toBe(1);
	});

	it("两边都只用同一个等级时 Kappa 无定义", () => {
		expect(
			weightedKappa(
				[
					[2, 2],
					[2, 2],
				],
				3,
			),
		).toBeNull();
		expect(weightedKappa([], 3)).toBeNull();
	});

	it("一致率、相差 1 级以内与混淆矩阵", () => {
		const pairs = [
			[0, 0],
			[1, 2],
			[3, 1],
		] as const;
		expect(agreement(pairs, 3)).toMatchObject({
			n: 3,
			exact: 1 / 3,
			withinOne: 2 / 3,
		});
		expect(confusionMatrix(pairs, 3)).toEqual([
			[1, 0, 0, 0],
			[0, 0, 1, 0],
			[0, 0, 0, 0],
			[0, 1, 0, 0],
		]);
	});
});

describe("rubric", () => {
	it("rubric 或刻度变了哈希就变, 是否抓正文也计入", () => {
		const base = rubricHash(scenario, false);
		expect(rubricHash(scenario, false)).toBe(base);
		expect(rubricHash({ ...scenario, rubric: "新说明" }, false)).not.toBe(base);
		expect(
			rubricHash({ ...scenario, scale: ["0", "1", "2", "3", "4"] }, false),
		).not.toBe(base);
		expect(rubricHash(scenario, true)).not.toBe(base);
	});

	it("缓存键随摘要变化, 与名次、被测对象无关", () => {
		const a = hit("https://a.com/x", 1);
		const key = judgmentKey(rustCase, a, false);
		expect(judgmentKey(rustCase, { ...a, rank: 5 } as ScoredHit, false)).toBe(
			key,
		);
		expect(
			judgmentKey(rustCase, { ...a, snippet: "别的摘要" }, false),
		).not.toBe(key);
		expect(judgmentKey({ ...rustCase, note: "别的意图" }, a, false)).not.toBe(
			key,
		);
	});

	it("提示词含场景说明、刻度与含义, 不含名次", () => {
		const { system, prompt } = buildPrompt(
			scenario,
			{ query: "apple event", note: "n", meanings: ["公司", "水果"] },
			[{ id: "r1", item: judgeItem("https://a.com/") }],
			{ today: "2026-10-19", schemaText: "{}" },
		);
		expect(system).toContain("场景说明");
		expect(system).toContain("打分说明");
		expect(system).toContain("- 3 完全满足");
		expect(system).toContain("meaning");
		expect(system).toContain("JSON Schema:");
		expect(prompt).toContain("- 1: 水果");
		expect(prompt).toContain("[r1]");
		expect(prompt).not.toMatch(/名次|排名第/);
	});
});

describe("judgeBatch", () => {
	it("按编号对回每条结果, 输出顺序与输入无关", async () => {
		const items = [
			judgeItem("https://good.com/1"),
			judgeItem("https://bad.com/2"),
			judgeItem("https://good.com/3"),
		];
		const prompts: string[] = [];
		const result = await judgeBatch(scriptedModel(gradeByUrl, prompts), {
			scenario,
			kase: rustCase,
			items,
			today: "2026-10-19",
		});
		expect(result.usage).toEqual({
			calls: 1,
			inputTokens: 100,
			outputTokens: 20,
		});
		expect(
			Object.fromEntries(
				[...result.judgments].map(([key, j]) => [key, j.grade]),
			),
		).toEqual({
			"https://good.com/1": 3,
			"https://bad.com/2": 1,
			"https://good.com/3": 3,
		});
		expect(prompts[0]).toContain("JSON Schema:");
	});

	it("缺项或单项不合法时只对缺的那些再试一次", async () => {
		const items = [
			judgeItem("https://good.com/1"),
			judgeItem("https://x.com/2"),
		];
		const asked: number[] = [];
		const handle = scriptedModel((seen, call) => {
			asked.push(seen.length);
			const output = gradeByUrl(seen);
			if (call === 1) {
				const x = output.judgments.find((j) =>
					seen.find((s) => s.id === j.id)?.url.includes("x.com"),
				);
				if (x) x.grade = 9;
			}
			return output;
		});
		const result = await judgeBatch(handle, {
			scenario,
			kase: rustCase,
			items,
			today: "2026-10-19",
		});
		expect(asked).toEqual([2, 1]);
		expect(result.judgments.size).toBe(2);
		expect(result.usage.calls).toBe(2);
	});

	it("两次都不合法的结果不返回, 记为未判定", async () => {
		const result = await judgeBatch(
			scriptedModel(() => "不是 JSON"),
			{
				scenario,
				kase: rustCase,
				items: [judgeItem("https://a.com/")],
				today: "2026-10-19",
			},
		);
		expect(result.judgments.size).toBe(0);
		expect(result.usage.calls).toBe(2);
	});

	it("歧义用例要求 meaning, 且只能取已有含义的下标", async () => {
		const handle = scriptedModel((seen) => ({
			judgments: seen.map(({ id }, index) => ({
				id,
				reason: "r",
				grade: 2,
				sourceTier: "ugc",
				stale: "unknown",
				meaning: index === 0 ? "1" : "3",
			})),
		}));
		const result = await judgeBatch(handle, {
			scenario,
			kase: { query: "apple event", meanings: ["公司", "水果"] },
			items: [judgeItem("https://a.com/")],
			today: "2026-10-19",
		});
		expect([...result.judgments.values()][0]?.meaning).toBe("1");
	});

	it.each([401, 402])("HTTP %i 中止裁判", async (statusCode) => {
		const { APICallError } = await import("ai");
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new APICallError({
					message: "unauthorized",
					url: "https://example.com",
					requestBodyValues: {},
					statusCode,
					isRetryable: false,
				});
			},
		});
		await expect(
			judgeBatch(
				{ id: "m", model, providerOptions: {}, structuredOutputs: false },
				{
					scenario,
					kase: rustCase,
					items: [judgeItem("https://a.com/")],
					today: "2026-10-19",
				},
			),
		).rejects.toBeInstanceOf(JudgeFatalError);
	});
});

describe("JudgmentCache", () => {
	it("跨实例读回, 截掉中断留下的半行后继续追加", async () => {
		const dir = await mkdtemp(join(tmpdir(), "seekbench-judgments-"));
		const shard = { scenario: "mini", rubric: "abc" };
		const judgment = {
			reason: "r",
			grade: 2,
			sourceTier: "ugc",
			stale: "fresh",
		} as const;
		const first = new JudgmentCache(dir, "model/a");
		await first.put(shard, new Map([["k1", judgment]]));
		await appendFile(first.path(shard), '{"key":"k2","judg');
		const second = new JudgmentCache(dir, "model/a");
		expect(await second.get(shard, "k1")).toEqual(judgment);
		expect(await second.get(shard, "k2")).toBeNull();
		await second.put(shard, new Map([["k3", { ...judgment, grade: 3 }]]));
		const third = new JudgmentCache(dir, "model/a");
		expect((await third.get(shard, "k3"))?.grade).toBe(3);
		expect(first.path(shard)).toContain("model%2Fa");
	});
});

describe("judgeRecords", () => {
	const records = [
		record("p1", "rust", [
			hit("https://rust-lang.github.io/async-book/", 1, {
				target: true,
				grade: 3,
				gradeSource: "rule",
			}),
			hit("https://good.com/a", 2),
			hit("https://other.com/b", 3),
		]),
		record("p2", "rust", [
			hit("https://good.com/a", 1),
			hit("https://more.com/c", 2),
		]),
		record("p1", "apple", [hit("https://good.com/apple", 1)]),
		record("p2", "apple", [], { kind: "error", message: "x", status: 500 }),
	];

	async function options(handle: ModelHandle | null, dir?: string) {
		return {
			cache: new JudgmentCache(
				dir ?? (await mkdtemp(join(tmpdir(), "seekbench-judgments-"))),
				"scripted",
			),
			handle,
			fetch: false,
			maxItemsPerCall: 50,
			concurrency: 4,
			limiter: new TokenBucket({ perSecond: 1000 }),
			today: "2026-10-19",
		};
	}

	it("一条用例的结果合并去重后一次判定, 规则等级保留, 新判定写入缓存", async () => {
		const prompts: string[] = [];
		const dir = await mkdtemp(join(tmpdir(), "seekbench-judgments-"));
		const result = await judgeRecords(
			loaded,
			records,
			await options(
				scriptedModel(
					(seen) => ({
						judgments: gradeByUrl(seen).judgments.map((j) => ({
							...j,
							meaning: "0",
						})),
					}),
					prompts,
				),
				dir,
			),
		);
		expect(prompts).toHaveLength(2);
		expect(
			prompts.find((p) => p.includes("rust async book"))?.match(/\[r\d+\]/g),
		).toHaveLength(3);
		expect(result.usage).toMatchObject({
			items: 4,
			cached: 0,
			failed: 0,
			calls: 2,
		});
		const [rust1, rust2, apple] = result.records;
		expect(rust1?.hits.map((h) => [h.grade, h.gradeSource])).toEqual([
			[3, "rule"],
			[3, "judge"],
			[1, "judge"],
		]);
		expect(rust1?.hits[1]?.meaning).toBeNull();
		expect(rust1?.hits[1]?.judgment).toEqual({
			reason: "理由",
			sourceTier: "reputable",
			stale: "fresh",
		});
		expect(rust2?.hits.map((h) => h.grade)).toEqual([3, 1]);
		expect(apple?.hits[0]?.meaning).toBe("0");

		const replay = await judgeRecords(
			loaded,
			records,
			await options(null, dir),
		);
		expect(replay.usage).toMatchObject({ items: 4, cached: 4, calls: 0 });
		expect(replay.uncached).toBe(0);
		expect(replay.records).toEqual(result.records);
	});

	it("没有模型时只用缓存, 缓存里没有的保持未判定", async () => {
		const result = await judgeRecords(loaded, records, await options(null));
		expect(result.uncached).toBe(4);
		expect(result.records).toEqual(records);
	});

	it("单批调用失败只让这批保持未判定", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("网络错误");
			},
		});
		const result = await judgeRecords(
			loaded,
			records,
			await options({
				id: "m",
				model,
				providerOptions: {},
				structuredOutputs: false,
			}),
		);
		expect(result.usage.failed).toBe(4);
		expect(result.errors).toEqual(["网络错误"]);
	});

	it("按 maxItemsPerCall 分批", async () => {
		const prompts: string[] = [];
		const result = await judgeRecords(loaded, records, {
			...(await options(
				scriptedModel(
					(seen) => ({
						judgments: gradeByUrl(seen).judgments.map((j) => ({
							...j,
							meaning: "0",
						})),
					}),
					prompts,
				),
			)),
			maxItemsPerCall: 2,
		});
		expect(prompts).toHaveLength(3);
		expect(result.usage.calls).toBe(3);
	});
});

describe("audit", () => {
	const judged = [
		record("p1", "rust", [
			hit("https://a.com/1", 1, { grade: 3, gradeSource: "judge" }),
			hit("https://a.com/2", 2, { grade: 1, gradeSource: "judge" }),
			hit("https://a.com/3", 3, { grade: 0, gradeSource: "rule", bad: true }),
		]),
		record("p2", "rust", [
			hit("https://a.com/1", 1, { grade: 3, gradeSource: "judge" }),
			hit("https://b.com/1", 2, { grade: 2, gradeSource: "judge" }),
		]),
	];

	it("按 (被测对象, 等级) 轮流抽样, 同一内容只抽一次, 不含裁判等级", () => {
		const items = sampleAudit(judged, loaded, {
			size: 10,
			seed: "s",
			fetch: false,
		});
		expect(items.map((item) => item.url).sort()).toEqual([
			"https://a.com/1",
			"https://a.com/2",
			"https://b.com/1",
		]);
		expect(items.every((item) => item.grade === null)).toBe(true);
		expect(
			sampleAudit(judged, loaded, { size: 2, seed: "s", fetch: false }),
		).toHaveLength(2);
		expect(
			sampleAudit(judged, loaded, { size: 2, seed: "s", fetch: false }),
		).toEqual(
			sampleAudit(judged, loaded, { size: 2, seed: "s", fetch: false }),
		);
	});

	it("小样本时每层至少一条", () => {
		const items = sampleAudit(judged, loaded, {
			size: 3,
			seed: "x",
			fetch: false,
		});
		const grades = new Set(items.map((item) => item.url));
		expect(grades.has("https://a.com/2")).toBe(true);
		expect(grades.has("https://b.com/1")).toBe(true);
	});

	it("比较人工等级与裁判等级, 已填的转成标注", () => {
		const items = sampleAudit(judged, loaded, {
			size: 10,
			seed: "s",
			fetch: false,
		});
		const filled = items.map((item) => ({
			...item,
			grade:
				item.url === "https://a.com/2"
					? null
					: item.url === "https://b.com/1"
						? 1
						: 3,
		}));
		const result = auditRun(filled, judged, loaded, {
			fetch: false,
			runId: "run-1",
			now: new Date("2026-10-19T00:00:00Z"),
		});
		expect(result.pending).toBe(1);
		expect(result.unmatched).toBe(0);
		expect(result.agreement).toMatchObject({ n: 2, exact: 0.5, withinOne: 1 });
		expect(result.labels).toHaveLength(2);
		expect(result.labels[0]).toMatchObject({
			source: "audit:run-1",
			scenario: "mini",
		});
		expect(new Set(result.labels.map(labelKey)).size).toBe(2);
	});

	it("人工等级覆盖裁判等级, 清空后恢复, 一致率仍与裁判等级比较", () => {
		const items = sampleAudit(judged, loaded, {
			size: 10,
			seed: "s",
			fetch: false,
		});
		const filled = items.map((item) => ({
			...item,
			grade: item.url === "https://a.com/1" ? 1 : null,
		}));
		const applied = applyAudit(filled, judged, loaded, { fetch: false });
		expect(applied.applied).toBe(2);
		const first = applied.records[0]?.hits[0];
		expect(first).toMatchObject({
			grade: 1,
			gradeSource: "human",
			judgeGrade: 3,
		});
		expect(applied.records[0]?.hits[1]).toMatchObject({
			grade: 1,
			gradeSource: "judge",
		});
		expect(applied.records[0]?.hits[2]?.gradeSource).toBe("rule");
		expect(
			auditRun(filled, applied.records, loaded, { fetch: false, runId: "r" })
				.agreement,
		).toMatchObject({ n: 1, exact: 0 });

		const cleared = applyAudit(
			filled.map((item) => ({ ...item, grade: null })),
			applied.records,
			loaded,
			{ fetch: false },
		);
		expect(cleared.applied).toBe(0);
		expect(cleared.records).toEqual(judged);
	});
});

describe("calibrate", () => {
	it("规则标注只取风险域名与目标本身", () => {
		const records = [
			record("p1", "rust", [
				hit("https://rust-lang.github.io/async-book/", 1, {
					target: true,
					grade: 3,
					gradeSource: "rule",
				}),
				hit(
					"https://rust-lang.github.io/async-book/01_getting_started/01_chapter.html",
					2,
					{ target: true, grade: 3, gradeSource: "rule" },
				),
				hit("https://scam.example/", 3, {
					bad: true,
					grade: 0,
					gradeSource: "rule",
				}),
				hit("https://other.com/", 4),
			]),
			record("p1", "apple", [
				hit("https://scam.example/", 1, {
					bad: true,
					grade: 0,
					gradeSource: "rule",
				}),
			]),
		];
		const labels = ruleLabels(records, loaded, "run-1");
		expect(labels.map((label) => [label.url, label.grade])).toEqual([
			["https://rust-lang.github.io/async-book/", 3],
			["https://scam.example/", 0],
		]);
	});

	it("对标注跑裁判, 按场景与来源报告一致程度", async () => {
		const labels = [
			{ url: "https://good.com/1", grade: 3, source: "audit:r" },
			{ url: "https://good.com/2", grade: 2, source: "audit:r" },
			{ url: "https://bad.com/3", grade: 1, source: "rule:r" },
			{ url: "https://bad.com/4", grade: 0, source: "rule:r" },
		].map((label) => ({
			scenario: "mini",
			query: "rust async book",
			title: `title of ${label.url}`,
			snippet: "s",
			publishedAt: null,
			labeledAt: "2026-10-19T00:00:00.000Z",
			...label,
		}));
		const result = await calibrate(
			[
				...labels,
				{ ...labels[0], scenario: "gone" } as (typeof labels)[number],
			],
			new Map([["mini", scenario]]),
			{
				cache: new JudgmentCache(
					await mkdtemp(join(tmpdir(), "seekbench-judgments-")),
					"scripted",
				),
				handle: scriptedModel(gradeByUrl),
				fetch: false,
				maxItemsPerCall: 50,
				concurrency: 2,
				limiter: new TokenBucket({ perSecond: 1000 }),
				today: "2026-10-19",
			},
		);
		expect(result.skipped).toBe(1);
		expect(result.overall).toMatchObject({ n: 4, exact: 0.5, withinOne: 1 });
		expect(result.bySource.map((row) => row.source)).toEqual(["audit", "rule"]);
		expect(result.matrix[2]).toEqual([0, 0, 0, 1]);
		expect(result.usage.calls).toBe(1);
	});
});

describe("fetch-page", () => {
	it("去掉脚本、样式与导航后取正文", () => {
		expect(
			htmlToText(
				"<html><head><title>t</title><script>var a=1</script></head><body><nav>菜单</nav><p>正文 &amp; 内容</p><style>p{}</style></body></html>",
			),
		).toBe("正文 & 内容");
	});
});
