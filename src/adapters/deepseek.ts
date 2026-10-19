import { z } from "zod";
import type { Freshness } from "../core/types.ts";
import {
	ProviderBase,
	type ProviderDefinition,
	type ProviderSubjectOptions,
	providerSubject,
	type RateLimit,
	stripHtml,
	toIsoDate,
	USD_PER_CNY,
} from "./_shared.ts";

/** DeepSeek Search 接口. 见 docs/adapters/deepseek.md. */
export const DeepseekConfig = ProviderBase.extend({
	use: z.literal("deepseek"),
	/** 用长摘要 summary 代替短摘要 snippet. */
	summary: z.boolean().default(false),
});
export type DeepseekConfig = z.infer<typeof DeepseekConfig>;

/** 账号级 Search QPS 上限. */
export const deepseekRateLimit: RateLimit = { perSecond: 5 };

/** 5 元每千次成功请求; 无结果的请求不计费. */
const PRICE_PER_REQUEST = 0.005 * USD_PER_CNY;

const MAX_COUNT = 50;

const WINDOW_DAYS: Record<Freshness, number> = {
	day: 1,
	week: 7,
	month: 31,
	year: 365,
};

const DeepseekResult = z.object({
	title: z.string().nullish(),
	url: z.string(),
	snippet: z.string().nullish(),
	summary: z.string().nullish(),
	site_name: z.string().nullish(),
	site_icon: z.string().nullish(),
	/** UTC 的 RFC 3339. */
	date: z.string().nullish(),
});

export const DeepseekResponse = z.object({
	results: z.array(DeepseekResult),
});
export type DeepseekResponse = z.infer<typeof DeepseekResponse>;

/** 接口没有时效与站点参数, 用文档列出的 after: 与 site: 查询语法表达. */
export function deepseekQuery(
	query: string,
	options: { freshness?: Freshness | undefined; site?: string | undefined },
	now: Date,
): string {
	const parts = [query];
	if (options.site) parts.push(`site:${options.site}`);
	if (options.freshness) {
		const since = new Date(
			now.getTime() - WINDOW_DAYS[options.freshness] * 86_400_000,
		);
		parts.push(`after:${since.toISOString().slice(0, 10)}`);
	}
	return parts.join(" ");
}

export function deepseekDefinition(
	config: DeepseekConfig,
): ProviderDefinition<DeepseekResponse> {
	return {
		name: "deepseek",
		defaultBaseUrl: "https://api.deepseek.com/v1/tools/search",
		schema: DeepseekResponse,
		requestIdHeader: "x-ds-trace-id",
		request(query, options, { apiKey, baseUrl, now }) {
			return {
				url: baseUrl,
				init: {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						query: deepseekQuery(query, options, now),
						count: Math.min(options.count, MAX_COUNT),
						need_content: false,
					}),
				},
			};
		},
		parse(data) {
			return {
				hits: data.results.map((result) => ({
					url: result.url,
					title: stripHtml(result.title ?? ""),
					snippet: stripHtml(
						(config.summary ? result.summary : result.snippet) ?? "",
					),
					siteName: result.site_name ?? null,
					favicon: result.site_icon ?? null,
					publishedAt: toIsoDate(result.date),
				})),
				totalEstimate: null,
				cost: PRICE_PER_REQUEST,
				billable: data.results.length > 0,
			};
		},
	};
}

export function createDeepseekSubject(
	config: DeepseekConfig,
	options: Omit<ProviderSubjectOptions, "config">,
) {
	return providerSubject(deepseekDefinition(config), { ...options, config });
}
