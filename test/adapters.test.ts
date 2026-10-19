import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	SubjectError,
	stripHtml,
	toIsoDate,
	USD_PER_CNY,
} from "../src/adapters/_shared.ts";
import { deepseekQuery } from "../src/adapters/deepseek.ts";
import { exaCost } from "../src/adapters/exa.ts";
import {
	createSubject,
	missingEnv,
	rateLimitOf,
	SubjectConfig,
} from "../src/adapters/index.ts";
import { tavilyCost } from "../src/adapters/tavily.ts";
import { Hit, type SearchOptions } from "../src/core/types.ts";

const PROVIDERS = ["bocha", "brave", "deepseek", "exa", "tavily"] as const;
type Provider = (typeof PROVIDERS)[number];

/** 录制的真实响应, 见 test/fixtures/adapters/. */
interface Fixture {
	query: string;
	request: SearchOptions;
	raw: unknown;
}

function fixture(name: Provider): Fixture {
	return JSON.parse(
		readFileSync(
			new URL(`fixtures/adapters/${name}.json`, import.meta.url),
			"utf8",
		),
	);
}

interface Captured {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
}

/** 按顺序返回给定响应并记录请求的 fetch. */
function fakeFetch(responses: Array<() => Response>) {
	const requests: Captured[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		requests.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: init?.headers as Record<string, string>,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
		});
		const next = responses.shift();
		if (!next) throw new Error("没有更多响应");
		return next();
	};
	return { fetch, requests };
}

const json =
	(body: unknown, status = 200) =>
	() =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

function subject(
	use: Provider,
	extra: Record<string, unknown> = {},
	fetch?: typeof globalThis.fetch,
	env: Record<string, string> = { [`${use.toUpperCase()}_API_KEY`]: "secret" },
) {
	return createSubject(use, SubjectConfig.parse({ use, ...extra }), {
		root: ".",
		env,
		...(fetch && { fetch }),
	});
}

const zhOptions: SearchOptions = { lang: "zh", count: 10 };

describe("录制响应的归一化", () => {
	const expected: Record<
		Provider,
		{
			count: number;
			first: Partial<Hit>;
			cost: number;
			requestId: string | null;
		}
	> = {
		bocha: {
			count: 10,
			first: {
				url: "https://www.bilibili.com/read/cv24840142",
				siteName: "哔哩哔哩",
				publishedAt: "2023-07-06T17:30:00.000Z",
			},
			cost: 0.036 * USD_PER_CNY,
			requestId: "a324ded487e0e7f4",
		},
		brave: {
			count: 10,
			first: {
				url: "https://store.steampowered.com/",
				title: "Welcome to Steam",
				siteName: "Steam",
				publishedAt: "2026-10-15T21:33:26.000Z",
			},
			cost: 0.005,
			requestId: null,
		},
		deepseek: {
			count: 10,
			first: { siteName: "Steam", publishedAt: null },
			cost: 0.005 * USD_PER_CNY,
			requestId: null,
		},
		exa: {
			count: 10,
			first: {
				url: "https://store.steampowered.com/",
				title: "Welcome to Steam",
				siteName: null,
				favicon: null,
			},
			cost: 0.007,
			requestId: "8f885855af5e39debcbb333862ba1ae2",
		},
		tavily: {
			count: 6,
			first: {
				title: "歡迎來到 Steam",
				publishedAt: "2026-10-02T04:00:00.000Z",
			},
			cost: 0.008,
			requestId: "2aad8097-b6e6-461b-8dec-646ffac3d453",
		},
	};

	for (const name of PROVIDERS) {
		it(name, async () => {
			const { query, request, raw } = fixture(name);
			const response = (await subject(name)).replay?.(raw, query, request);
			if (!response) throw new Error("没有 replay");
			const want = expected[name];
			expect(response.hits).toHaveLength(want.count);
			expect(response.hits[0]).toMatchObject(want.first);
			expect(response.cost).toBeCloseTo(want.cost, 10);
			expect(response.calls).toBe(1);
			expect(response.raw).toBe(raw);
			for (const hit of response.hits) {
				expect(Hit.safeParse(hit).success).toBe(true);
				expect(hit.title).not.toMatch(/<[a-z/]/i);
				expect(hit.snippet).not.toMatch(/<[a-z/]/i);
				expect(hit.snippet).not.toMatch(/\s{2}/);
			}
			const viaFetch = fakeFetch([json(raw)]);
			const live = await (await subject(name, {}, viaFetch.fetch)).search(
				query,
				request,
			);
			expect(live.hits).toEqual(response.hits);
			expect(live.diagnostics?.requestId ?? null).toBe(want.requestId);
		});
	}
});

describe("请求构造", () => {
	it("brave: GET, 密钥在头里, 时效与站点映射到参数与 site: 语法, 条数不超过 20", async () => {
		const { fetch, requests } = fakeFetch([json({ web: { results: [] } })]);
		await (await subject("brave", { country: "US" }, fetch)).search("rust", {
			lang: "en",
			count: 50,
			freshness: "week",
			site: "github.com",
		});
		const [request] = requests;
		const url = new URL(request?.url ?? "");
		expect(request?.method).toBe("GET");
		expect(request?.headers["X-Subscription-Token"]).toBe("secret");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			q: "rust site:github.com",
			count: "20",
			search_lang: "en",
			result_filter: "web",
			country: "US",
			freshness: "pw",
		});
	});

	it("bocha: POST JSON, 时效与站点映射到 freshness 与 include", async () => {
		const { fetch, requests } = fakeFetch([
			json({ code: 200, data: { webPages: { value: [] } } }),
		]);
		await (await subject("bocha", {}, fetch)).search("q", {
			...zhOptions,
			freshness: "month",
			site: "gov.cn",
		});
		expect(requests[0]?.headers.Authorization).toBe("Bearer secret");
		expect(requests[0]?.body).toEqual({
			query: "q",
			count: 10,
			summary: false,
			freshness: "oneMonth",
			include: "gov.cn",
		});
	});

	it("deepseek: 时效与站点写进查询语法", () => {
		const now = new Date("2026-10-19T12:00:00Z");
		expect(deepseekQuery("q", {}, now)).toBe("q");
		expect(deepseekQuery("q", { freshness: "week", site: "a.com" }, now)).toBe(
			"q site:a.com after:2026-10-12",
		);
	});

	it("exa: highlights 作摘要, 时效转成起始发布日期", async () => {
		const { fetch, requests } = fakeFetch([json({ results: [] })]);
		await (await subject("exa", { type: "fast" }, fetch)).search("q", {
			lang: "en",
			count: 5,
			freshness: "day",
			site: "a.com",
		});
		const body = requests[0]?.body ?? {};
		expect(requests[0]?.headers["x-api-key"]).toBe("secret");
		expect(body).toMatchObject({
			query: "q",
			type: "fast",
			numResults: 5,
			contents: { highlights: { maxCharacters: 500 } },
			includeDomains: ["a.com"],
		});
		const since = Date.parse(String(body.startPublishedDate));
		expect(Date.now() - since).toBeGreaterThan(86_000_000);
		expect(Date.now() - since).toBeLessThan(87_000_000);
	});

	it("tavily: 请求 favicon、发布时间与用量, 时效映射到 time_range", async () => {
		const { fetch, requests } = fakeFetch([json({ results: [] })]);
		await (await subject("tavily", {}, fetch)).search("q", {
			lang: "en",
			count: 30,
			freshness: "year",
		});
		expect(requests[0]?.body).toEqual({
			query: "q",
			search_depth: "basic",
			topic: "general",
			max_results: 20,
			include_favicon: true,
			include_published_date: true,
			include_usage: true,
			time_range: "year",
		});
	});
});

describe("错误与重试", () => {
	it("缺少密钥时 search 抛错, 不发请求; missingEnv 报告变量名", async () => {
		const { fetch, requests } = fakeFetch([]);
		const brave = await subject("brave", {}, fetch, {});
		await expect(brave.search("q", zhOptions)).rejects.toThrow(
			"缺少环境变量 BRAVE_API_KEY",
		);
		expect(requests).toHaveLength(0);
		const config = SubjectConfig.parse({ use: "exa", apiKeyEnv: "MY_EXA" });
		expect(missingEnv(config, {})).toBe("MY_EXA");
		expect(missingEnv(config, { MY_EXA: "k" })).toBeNull();
		expect(missingEnv(SubjectConfig.parse({ use: "mock" }), {})).toBeNull();
	});

	it("429 后重试成功, 重试次数写进诊断字段", async () => {
		const { fetch, requests } = fakeFetch([
			json({ error: "rate" }, 429),
			json({ results: [] }),
		]);
		const config = SubjectConfig.parse({ use: "deepseek" });
		const deepseek = await createSubject("deepseek", config, {
			root: ".",
			env: { DEEPSEEK_API_KEY: "k" },
			fetch,
		});
		const response = await deepseek.search("q", {
			...zhOptions,
			signal: AbortSignal.timeout(5000),
		});
		expect(requests).toHaveLength(2);
		expect(response.diagnostics?.retries).toBe(1);
		expect(response.cost).toBe(0);
	});

	it("401 不重试, 抛出带状态的 SubjectError", async () => {
		const { fetch, requests } = fakeFetch([json({ error: "bad key" }, 401)]);
		const error = await (await subject("tavily", {}, fetch))
			.search("q", zhOptions)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SubjectError);
		expect((error as SubjectError).status).toBe(401);
		expect(requests).toHaveLength(1);
	});

	it("bocha 在响应体里报告的错误按 code 处理", async () => {
		const { fetch } = fakeFetch([
			json({ code: "403", msg: "You do not have enough money", log_id: "x" }),
		]);
		const error = await (await subject("bocha", {}, fetch))
			.search("q", zhOptions)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SubjectError);
		expect((error as SubjectError).status).toBe(403);
		expect((error as SubjectError).message).toContain("enough money");
	});
});

describe("计费", () => {
	it("deepseek 无结果不计费", async () => {
		const deepseek = await subject("deepseek");
		expect(deepseek.replay?.({ results: [] }, "q", zhOptions).cost).toBe(0);
	});

	it("pricePer1k 覆盖默认价格", async () => {
		const { query, request, raw } = fixture("bocha");
		const bocha = await subject("bocha", { pricePer1k: 3 });
		expect(bocha.replay?.(raw, query, request).cost).toBeCloseTo(0.003, 10);
	});

	it("exa 没有 costDollars 时按类型与超出 10 条的条数估算", () => {
		expect(exaCost("auto", 10)).toBeCloseTo(0.007, 10);
		expect(exaCost("instant", 10)).toBeCloseTo(0.004, 10);
		expect(exaCost("fast", 25)).toBeCloseTo(0.007 + 0.015, 10);
	});

	it("tavily 优先用响应里的 credit, 否则按深度估算", () => {
		expect(tavilyCost("basic", undefined)).toBeCloseTo(0.008, 10);
		expect(tavilyCost("advanced", null)).toBeCloseTo(0.016, 10);
		expect(tavilyCost("advanced", 1)).toBeCloseTo(0.008, 10);
	});

	it("没有声明速率时用适配器默认值", () => {
		expect(rateLimitOf(SubjectConfig.parse({ use: "deepseek" }))).toEqual({
			perSecond: 5,
		});
		expect(
			rateLimitOf(
				SubjectConfig.parse({ use: "brave", rateLimit: { perSecond: 1 } }),
			),
		).toEqual({ perSecond: 1 });
	});
});

describe("stripHtml", () => {
	it("去标签、解码实体、压缩空白", () => {
		expect(
			stripHtml(
				"<strong>Rust</strong> &amp; async\n\n  book &#39;s &#x4e2d;&nbsp;x",
			),
		).toBe("Rust & async book 's 中 x");
		expect(stripHtml("&unknown; &#0;")).toBe("&unknown; &#0;");
	});
});

describe("toIsoDate", () => {
	it("各种供应商格式转成 UTC ISO 8601", () => {
		expect(toIsoDate("2024-07-22T00:00:00+08:00")).toBe(
			"2024-07-21T16:00:00.000Z",
		);
		expect(toIsoDate("2024-07-22 08:00:00", "+08:00")).toBe(
			"2024-07-22T00:00:00.000Z",
		);
		expect(toIsoDate("2024-07-22")).toBe("2024-07-22T00:00:00.000Z");
		expect(toIsoDate("2026-10-15T21:33:26")).toBe("2026-10-15T21:33:26.000Z");
		expect(toIsoDate("Mon, 14 Jul 2025 10:00:00 GMT")).toBe(
			"2025-07-14T10:00:00.000Z",
		);
	});

	it("空值、无法解析与离谱年份返回 null", () => {
		expect(toIsoDate(null)).toBeNull();
		expect(toIsoDate("")).toBeNull();
		expect(toIsoDate("3 days ago")).toBeNull();
		expect(toIsoDate("0001-01-01T00:00:00Z")).toBeNull();
	});
});
