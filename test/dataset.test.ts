import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { scenarioIds } from "../src/cli/shared.ts";
import type { ModelHandle } from "../src/core/model.ts";
import type { Case, Scenario } from "../src/core/types.ts";
import {
	classifyQuery,
	importLog,
	parseCsv,
	readLogQueries,
	screenQuery,
} from "../src/dataset/import-log.ts";
import { datasetStats } from "../src/dataset/stats.ts";
import { reviewSample, synthesize } from "../src/dataset/synth.ts";
import {
	bigramSimilarity,
	editDistance,
	isNearDuplicate,
	normalizeQuery,
} from "../src/dataset/text.ts";
import { validateScenarios } from "../src/dataset/validate.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const scenariosDir = join(root, "datasets/scenarios");

describe("text", () => {
	it("编辑距离按码点计", () => {
		expect(editDistance("kitten", "sitting")).toBe(3);
		expect(editDistance("官网", "官方网站")).toBe(2);
		expect(editDistance("", "abc")).toBe(3);
	});

	it("二元组相似度", () => {
		expect(bigramSimilarity("abcd", "abcd")).toBe(1);
		expect(bigramSimilarity("abcd", "wxyz")).toBe(0);
		expect(bigramSimilarity("ab", "abc")).toBeCloseTo(2 / 3, 12);
	});

	it("归一化后相同、轻微改写与调换词序视为近似重复", () => {
		expect(normalizeQuery("  Rust   ASYNC  book ")).toBe("rust async book");
		expect(isNearDuplicate("Ｒｕｓｔ async book", "rust async book")).toBe(
			true,
		);
		expect(isNearDuplicate("rust async book", "rust async books")).toBe(true);
		expect(
			isNearDuplicate("Java 21 虚拟线程教程", "虚拟线程教程 Java 21"),
		).toBe(true);
		expect(isNearDuplicate("rust async book", "go concurrency patterns")).toBe(
			false,
		);
		expect(isNearDuplicate("Java 21 教程", "Python 3.13 教程")).toBe(false);
	});
});

describe("import-log", () => {
	const options = { minLength: 2, names: ["张三丰"] };

	it("丢弃带个人信息、过短或含名单人名的查询", () => {
		expect(screenQuery("联系 test@example.com", options)).toMatchObject({
			ok: false,
			reason: "pii",
			detail: "邮箱",
		});
		expect(screenQuery("13812345678 是谁", options)).toMatchObject({
			reason: "pii",
			detail: "手机号",
		});
		expect(screenQuery("11010519491231002X", options)).toMatchObject({
			reason: "pii",
			detail: "身份证号",
		});
		expect(screenQuery("6222021234567890123", options)).toMatchObject({
			reason: "pii",
			detail: "银行卡号",
		});
		expect(screenQuery("李四的手机号", options)).toMatchObject({
			reason: "pii",
		});
		expect(screenQuery("张三丰 太极拳", options)).toMatchObject({
			reason: "name",
		});
		expect(screenQuery("a", options)).toMatchObject({ reason: "short" });
		expect(screenQuery("go", options)).toMatchObject({ reason: "short" });
		expect(screenQuery("淘", { ...options })).toMatchObject({
			reason: "short",
		});
		expect(screenQuery(" 淘宝 ", options)).toEqual({ ok: true, query: "淘宝" });
		expect(screenQuery("12306", options)).toEqual({ ok: true, query: "12306" });
	});

	it("按规则粗分到场景", () => {
		expect(classifyQuery("Steam 官网")).toBe("nav-zh");
		expect(classifyQuery("淘宝")).toBe("nav-zh");
		expect(classifyQuery("vlc download")).toBe("nav-en");
		expect(classifyQuery("怎么配置 nginx 反向代理")).toBe("howto-zh");
		expect(classifyQuery("rust async tutorial")).toBe("howto-en");
		expect(classifyQuery("本周 AI 新闻")).toBe("fresh-zh");
		expect(
			classifyQuery("TypeError: Cannot read properties of undefined"),
		).toBe("longtail-en");
		expect(classifyQuery("四天工作制对生产率影响的研究证据")).toBe(
			"research-zh",
		);
		expect(classifyQuery("讲清楚虚拟线程调度原理和实现细节的长文")).toBe(
			"descriptive-zh",
		);
		expect(
			classifyQuery("essay on why large monorepos slowly fail at scale"),
		).toBe("descriptive-en");
	});

	it("CSV 取 query 列, 支持引号与转义; JSONL 取 query 字段", () => {
		expect(parseCsv('a,b\n"x, y","say ""hi"""\r\n\n1,2')).toEqual([
			["a", "b"],
			["x, y", 'say "hi"'],
			["1", "2"],
		]);
		expect(
			readLogQueries('time,Query\n1,淘宝\n2,"vlc, download"\n', "csv"),
		).toEqual(["淘宝", "vlc, download"]);
		expect(readLogQueries("淘宝\n京东\n", "csv")).toEqual(["淘宝", "京东"]);
		expect(readLogQueries('{"query":"淘宝"}\n"京东"\n', "jsonl")).toEqual([
			"淘宝",
			"京东",
		]);
	});

	it("去重后编号, 来源为批次", () => {
		const result = importLog(
			["淘宝", "淘宝 ", "a@b.co 邮件", "vlc download", "x"],
			{
				batch: "b1",
				minLength: 2,
				names: [],
			},
		);
		expect(result.dropped).toEqual({ pii: 1, short: 1, name: 0, duplicate: 1 });
		expect(result.pii).toEqual({ 邮箱: 1 });
		expect(result.byScenario.get("nav-zh")).toEqual([
			{ id: "log-b1-00001", query: "淘宝", tier: "B", source: "log:b1" },
		]);
		expect(result.byScenario.get("nav-en")?.[0]?.id).toBe("log-b1-00002");
	});
});

const scenario: Scenario = {
	id: "howto-en",
	version: "1",
	lang: "en",
	intent: "informational",
	description: "d",
	rubric: "r",
	k: 10,
	casesFile: "x.jsonl",
	synth: [{ id: "lang", instruction: "编程语言的教程查询", count: 4 }],
};

function scriptedSynth(
	batches: string[][],
	prompts: string[] = [],
): ModelHandle {
	let call = 0;
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			prompts.push(JSON.stringify(options.prompt));
			const queries = (batches[call++] ?? []).map((query) => ({
				query,
				note: `意图: ${query}`,
			}));
			return {
				content: [{ type: "text", text: JSON.stringify({ queries }) }],
				finishReason: { unified: "stop", raw: undefined },
				usage: {
					inputTokens: {
						total: 10,
						noCache: 10,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 5, text: 5, reasoning: undefined },
				},
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

describe("synth", () => {
	const existing: Case[] = [
		{
			id: "a1",
			query: "rust async book",
			tier: "A",
			source: "handwritten",
			note: "n",
		},
		{
			id: "lang-007",
			query: "python asyncio tutorial",
			tier: "B",
			source: "synth:lang",
		},
	];

	it("去掉与已有及同批近似重复的, 不够就再要, 编号接着已有的最大序号", async () => {
		const prompts: string[] = [];
		const result = await synthesize(
			scriptedSynth(
				[
					[
						"rust async books",
						"go channels guide",
						"Go channels guide",
						"",
						"kotlin coroutines intro",
					],
					["swift concurrency tutorial", "zig allocator docs"],
				],
				prompts,
			),
			{
				scenario,
				template: scenario.synth?.[0] as NonNullable<Scenario["synth"]>[number],
				existing,
				count: 4,
				batchSize: 5,
				temperature: 1,
				seed: "s",
			},
		);
		expect(result.cases.map((kase) => [kase.id, kase.query])).toEqual([
			["lang-008", "go channels guide"],
			["lang-009", "kotlin coroutines intro"],
			["lang-010", "swift concurrency tutorial"],
			["lang-011", "zig allocator docs"],
		]);
		expect(result.cases[0]).toMatchObject({
			tier: "B",
			source: "synth:lang",
			note: "意图: go channels guide",
		});
		expect(result.duplicates).toBe(2);
		expect(result.invalid).toBe(1);
		expect(result.calls).toBe(2);
		expect(prompts[0]).toContain("编程语言的教程查询");
		expect(prompts[0]).toContain("python asyncio tutorial");
	});

	it("连续凑不出新查询时停下", async () => {
		const result = await synthesize(scriptedSynth([]), {
			scenario,
			template: scenario.synth?.[0] as NonNullable<Scenario["synth"]>[number],
			existing,
			count: 4,
			batchSize: 5,
			temperature: 1,
			seed: "s",
		});
		expect(result.cases).toEqual([]);
		expect(result.calls).toBe(4);
	});

	it("按比例抽样进复核队列, 至少一条", () => {
		const cases = Array.from({ length: 25 }, (_, index) => ({
			id: `t-${index}`,
			query: `q${index}`,
			tier: "B" as const,
			source: "synth:t" as const,
		}));
		expect(reviewSample(cases, 0.1, "s")).toHaveLength(3);
		expect(reviewSample(cases.slice(0, 2), 0.1, "s")).toHaveLength(1);
		expect(reviewSample(cases, 0, "s")).toEqual([]);
		expect(reviewSample(cases, 0.1, "s")[0]?.status).toBe("pending");
	});
});

describe("validate", () => {
	it("仓库里的题库没有错误", async () => {
		const { issues } = await validateScenarios(
			scenariosDir,
			await scenarioIds(scenariosDir),
		);
		expect(issues.filter((issue) => issue.level === "error")).toEqual([]);
	});

	it("报告场景内重复、无法解析的 gold 与缺失的标注", async () => {
		const dir = await mkdtemp(join(tmpdir(), "seekbench-validate-"));
		const base = { version: "1", lang: "en", description: "d", rubric: "r" };
		await writeFile(
			join(dir, "a.json"),
			JSON.stringify({
				...base,
				id: "a",
				intent: "navigational",
				casesFile: "a.jsonl",
			}),
		);
		await writeFile(
			join(dir, "a.jsonl"),
			[
				{
					id: "1",
					query: "Gmail",
					tier: "A",
					source: "handwritten",
					gold: { mustDomains: ["gmail.com"] },
				},
				{ id: "2", query: "gmail ", tier: "B", source: "synth:none" },
			]
				.map((item) => JSON.stringify(item))
				.join("\n"),
		);
		await writeFile(
			join(dir, "b.json"),
			JSON.stringify({
				...base,
				id: "b",
				intent: "informational",
				casesFile: "b.jsonl",
			}),
		);
		await writeFile(
			join(dir, "b.jsonl"),
			`${JSON.stringify({ id: "1", query: "gmail", tier: "A", source: "handwritten", gold: { targets: ["gmail.com"] } })}\n`,
		);
		await writeFile(join(dir, "c.json"), "{}");
		const { issues } = await validateScenarios(dir, ["a", "b", "c"]);
		const summary = issues.map(
			(issue) => `${issue.level} ${issue.scenario}/${issue.caseId ?? ""}`,
		);
		expect(summary).toEqual([
			"error c/",
			"warning a/1",
			"warning a/2",
			"warning a/2",
			"error a/2",
			"warning b/1",
		]);
	});
});

describe("stats", () => {
	it("按场景统计层、来源、语言与长度, 末行合计", () => {
		const rows = datasetStats([
			{
				scenario: { ...scenario, id: "s1" },
				casesHash: "h",
				cases: [
					{ id: "1", query: "淘宝", tier: "A", source: "handwritten" },
					{ id: "2", query: "vlc download", tier: "B", source: "synth:x" },
					{ id: "3", query: "jd", tier: "B", source: "log:b" },
				],
			},
		]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			cases: 3,
			tiers: { A: 1, B: 2 },
			sources: { handwritten: 1, synth: 1, log: 1 },
			langs: { zh: 1, en: 2 },
			length: { p50: 2, max: 12 },
		});
		expect(rows[1]?.scenario).toBe("合计");
	});
});
