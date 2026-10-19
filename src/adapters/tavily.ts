import { z } from "zod";
import {
	ProviderBase,
	type ProviderDefinition,
	type ProviderSubjectOptions,
	providerSubject,
	type RateLimit,
	stripHtml,
	toIsoDate,
} from "./_shared.ts";

/** Tavily 搜索. 见 docs/adapters/tavily.md. */
export const TavilyConfig = ProviderBase.extend({
	use: z.literal("tavily"),
	/** advanced 每次 2 个 credit, 其余 1 个. */
	searchDepth: z
		.enum(["ultra-fast", "fast", "basic", "advanced"])
		.default("basic"),
	topic: z.enum(["general", "news", "finance"]).default("general"),
});
export type TavilyConfig = z.infer<typeof TavilyConfig>;

/** 开发密钥 100 次每分钟. */
export const tavilyRateLimit: RateLimit = { perSecond: 100 / 60 };

/** 按量付费 0.008 美元每 credit. */
const PRICE_PER_CREDIT = 0.008;

const MAX_COUNT = 20;

const TavilyResult = z.object({
	title: z.string().nullish(),
	url: z.string(),
	content: z.string().nullish(),
	favicon: z.string().nullish(),
	published_date: z.string().nullish(),
});

export const TavilyResponse = z.object({
	request_id: z.string().nullish(),
	results: z.array(TavilyResult),
	usage: z.object({ credits: z.number().nonnegative().nullish() }).nullish(),
});
export type TavilyResponse = z.infer<typeof TavilyResponse>;

/** 响应里有实际消耗的 credit 就用它, 否则按搜索深度估算. */
export function tavilyCost(
	depth: TavilyConfig["searchDepth"],
	credits: number | null | undefined,
): number {
	return (credits ?? (depth === "advanced" ? 2 : 1)) * PRICE_PER_CREDIT;
}

export function tavilyDefinition(
	config: TavilyConfig,
): ProviderDefinition<TavilyResponse> {
	return {
		name: "tavily",
		defaultBaseUrl: "https://api.tavily.com/search",
		schema: TavilyResponse,
		request(query, options, { apiKey, baseUrl }) {
			return {
				url: baseUrl,
				init: {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						query,
						search_depth: config.searchDepth,
						topic: config.topic,
						max_results: Math.min(options.count, MAX_COUNT),
						include_favicon: true,
						include_published_date: true,
						include_usage: true,
						...(options.freshness && { time_range: options.freshness }),
						...(options.site && { include_domains: [options.site] }),
					}),
				},
			};
		},
		parse(data) {
			return {
				hits: data.results.map((result) => ({
					url: result.url,
					title: stripHtml(result.title ?? ""),
					snippet: stripHtml(result.content ?? ""),
					siteName: null,
					favicon: result.favicon ?? null,
					publishedAt: toIsoDate(result.published_date),
				})),
				totalEstimate: null,
				cost: tavilyCost(config.searchDepth, data.usage?.credits),
				billable: true,
				requestId: data.request_id ?? null,
			};
		},
	};
}

export function createTavilySubject(
	config: TavilyConfig,
	options: Omit<ProviderSubjectOptions, "config">,
) {
	return providerSubject(tavilyDefinition(config), { ...options, config });
}
