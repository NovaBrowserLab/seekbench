import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Hit, SearchLang, type SearchSubject } from "../core/types.ts";
import { RateLimit, SubjectError, sleep } from "./_shared.ts";

/** 本地假被测对象, 用于验证评测流程与测试 Runner, 不发网络请求. */
export const MockConfig = z.strictObject({
	use: z.literal("mock"),
	/** 查询到结果列表的 JSON 文件, 相对配置文件所在目录. 未列出的查询返回生成的占位结果. */
	hitsFile: z.string().optional(),
	latencyMs: z.number().nonnegative().default(0),
	costPerCall: z.number().nonnegative().default(0),
	/** 这些查询抛出 HTTP 500. */
	failQueries: z.array(z.string()).default([]),
	/** 这些查询一直不返回, 直到调用方中止. */
	hangQueries: z.array(z.string()).default([]),
	langs: z.array(SearchLang).min(1).default(["zh", "en"]),
	rateLimit: RateLimit.optional(),
});
export type MockConfig = z.infer<typeof MockConfig>;

export const MockHits = z.record(z.string(), z.array(Hit));
export type MockHits = z.infer<typeof MockHits>;

/** 假被测对象的默认速率, 不对应任何供应商. */
export const mockRateLimit: RateLimit = { perSecond: 100 };

export interface MockOptions {
	hits?: MockHits;
	latencyMs?: number;
	costPerCall?: number;
	failQueries?: readonly string[];
	hangQueries?: readonly string[];
	langs?: readonly SearchLang[];
}

function placeholderHits(query: string, count: number): Hit[] {
	return Array.from({ length: count }, (_, index) => ({
		url: `https://example.com/search/${encodeURIComponent(query)}/${index + 1}`,
		title: `${query} #${index + 1}`,
		snippet: "",
		siteName: "example.com",
		favicon: null,
		publishedAt: null,
	}));
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

export function createMockSubject(
	id: string,
	options: MockOptions = {},
): SearchSubject {
	const {
		hits = {},
		latencyMs = 0,
		costPerCall = 0,
		failQueries = [],
		hangQueries = [],
		langs = ["zh", "en"],
	} = options;
	return {
		id,
		kind: "provider",
		langs,
		async search(query, { count, signal }) {
			if (hangQueries.includes(query)) await untilAborted(signal);
			if (latencyMs > 0) await sleep(latencyMs, signal);
			if (failQueries.includes(query)) {
				throw new SubjectError(id, "模拟的服务端错误", { status: 500 });
			}
			const list = (hits[query] ?? placeholderHits(query, count)).slice(
				0,
				count,
			);
			return {
				hits: list,
				totalEstimate: list.length,
				cost: costPerCall,
				calls: 1,
				diagnostics: { retries: 0, requestId: null },
			};
		},
	};
}

/** 按配置创建假被测对象; hitsFile 相对 root 解析. */
export async function loadMockSubject(
	id: string,
	config: MockConfig,
	root: string,
): Promise<SearchSubject> {
	let hits: MockHits = {};
	if (config.hitsFile !== undefined) {
		const file = resolve(root, config.hitsFile);
		const parsed = MockHits.safeParse(JSON.parse(await readFile(file, "utf8")));
		if (!parsed.success)
			throw new Error(`${file} 格式不符:\n${z.prettifyError(parsed.error)}`);
		hits = parsed.data;
	}
	return createMockSubject(id, { ...config, hits });
}
