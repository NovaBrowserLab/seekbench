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
} from "./_shared.ts";

/** Exa 搜索. 见 docs/adapters/exa.md. */
export const ExaConfig = ProviderBase.extend({
	use: z.literal("exa"),
	/** 搜索类型; deep 系列慢且贵, 不适合与普通搜索直接比. */
	type: z.enum(["instant", "fast", "auto"]).default("auto"),
	/** 摘要取 highlights, 这是它的总长度上限. */
	highlightsMaxCharacters: z.int().positive().default(500),
});
export type ExaConfig = z.infer<typeof ExaConfig>;

/** /search 默认 10 QPS. */
export const exaRateLimit: RateLimit = { perSecond: 10 };

/** 每千次请求的美元价格, 含 10 条结果与正文、highlights. */
const PRICE_PER_1K: Record<ExaConfig["type"], number> = {
	instant: 4,
	fast: 7,
	auto: 7,
};

/** 超过 10 条的部分每千条 1 美元. */
const PRICE_PER_EXTRA_RESULT = 0.001;

const INCLUDED_RESULTS = 10;

const MAX_COUNT = 100;

const WINDOW_DAYS: Record<Freshness, number> = {
	day: 1,
	week: 7,
	month: 31,
	year: 365,
};

const ExaResult = z.object({
	title: z.string().nullish(),
	url: z.string(),
	publishedDate: z.string().nullish(),
	favicon: z.string().nullish(),
	highlights: z.array(z.string()).nullish(),
	text: z.string().nullish(),
});

export const ExaResponse = z.object({
	requestId: z.string().nullish(),
	results: z.array(ExaResult),
	costDollars: z.object({ total: z.number().nonnegative() }).nullish(),
});
export type ExaResponse = z.infer<typeof ExaResponse>;

/** 响应没带 costDollars 时按价目表估算. */
export function exaCost(type: ExaConfig["type"], results: number): number {
	return (
		PRICE_PER_1K[type] / 1000 +
		Math.max(0, results - INCLUDED_RESULTS) * PRICE_PER_EXTRA_RESULT
	);
}

export function exaDefinition(
	config: ExaConfig,
): ProviderDefinition<ExaResponse> {
	return {
		name: "exa",
		defaultBaseUrl: "https://api.exa.ai/search",
		schema: ExaResponse,
		request(query, options, { apiKey, baseUrl, now }) {
			const since = options.freshness
				? new Date(now.getTime() - WINDOW_DAYS[options.freshness] * 86_400_000)
				: null;
			return {
				url: baseUrl,
				init: {
					method: "POST",
					headers: {
						"x-api-key": apiKey,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						query,
						type: config.type,
						numResults: Math.min(options.count, MAX_COUNT),
						contents: {
							highlights: { maxCharacters: config.highlightsMaxCharacters },
						},
						...(options.site && { includeDomains: [options.site] }),
						...(since && { startPublishedDate: since.toISOString() }),
					}),
				},
			};
		},
		parse(data, { options }) {
			return {
				hits: data.results.map((result) => ({
					url: result.url,
					title: stripHtml(result.title ?? ""),
					snippet: stripHtml(
						result.highlights?.join(" … ") ?? result.text?.slice(0, 500) ?? "",
					),
					siteName: null,
					favicon: result.favicon ?? null,
					publishedAt: toIsoDate(result.publishedDate),
				})),
				totalEstimate: null,
				cost:
					data.costDollars?.total ??
					exaCost(config.type, Math.min(options.count, MAX_COUNT)),
				billable: true,
				requestId: data.requestId ?? null,
			};
		},
	};
}

export function createExaSubject(
	config: ExaConfig,
	options: Omit<ProviderSubjectOptions, "config">,
) {
	return providerSubject(exaDefinition(config), { ...options, config });
}
