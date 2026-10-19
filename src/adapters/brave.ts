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

/** Brave Search 网页搜索. 见 docs/adapters/brave.md. */
export const BraveConfig = ProviderBase.extend({
	use: z.literal("brave"),
	/** 结果所属国家, 两位国家代码; 不填由服务端决定. */
	country: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.optional(),
});
export type BraveConfig = z.infer<typeof BraveConfig>;

/** Search 套餐的默认速率. */
export const braveRateLimit: RateLimit = { perSecond: 50 };

/** Search 套餐 5 美元每千次请求. */
const PRICE_PER_REQUEST = 0.005;

/** 单页条数上限. */
const MAX_COUNT = 20;

const FRESHNESS: Record<Freshness, string> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

const BraveResult = z.object({
	title: z.string().nullish(),
	url: z.string(),
	description: z.string().nullish(),
	/** 页面时间, ISO 8601, 通常不带时区. */
	page_age: z.string().nullish(),
	profile: z.object({ name: z.string().nullish() }).nullish(),
	meta_url: z
		.object({
			hostname: z.string().nullish(),
			favicon: z.string().nullish(),
		})
		.nullish(),
});

export const BraveResponse = z.object({
	web: z.object({ results: z.array(BraveResult).default([]) }).nullish(),
});
export type BraveResponse = z.infer<typeof BraveResponse>;

export function braveDefinition(
	config: BraveConfig,
): ProviderDefinition<BraveResponse> {
	return {
		name: "brave",
		defaultBaseUrl: "https://api.search.brave.com/res/v1/web/search",
		schema: BraveResponse,
		request(query, options, { apiKey, baseUrl }) {
			const url = new URL(baseUrl);
			const q = options.site ? `${query} site:${options.site}` : query;
			url.searchParams.set("q", q);
			url.searchParams.set("count", String(Math.min(options.count, MAX_COUNT)));
			url.searchParams.set(
				"search_lang",
				options.lang === "zh" ? "zh-hans" : "en",
			);
			url.searchParams.set("result_filter", "web");
			if (config.country) url.searchParams.set("country", config.country);
			if (options.freshness)
				url.searchParams.set("freshness", FRESHNESS[options.freshness]);
			return {
				url,
				init: {
					headers: {
						Accept: "application/json",
						"X-Subscription-Token": apiKey,
					},
				},
			};
		},
		parse(data) {
			return {
				hits: (data.web?.results ?? []).map((result) => ({
					url: result.url,
					title: stripHtml(result.title ?? ""),
					snippet: stripHtml(result.description ?? ""),
					siteName: result.profile?.name ?? result.meta_url?.hostname ?? null,
					favicon: result.meta_url?.favicon ?? null,
					publishedAt: toIsoDate(result.page_age),
				})),
				totalEstimate: null,
				cost: PRICE_PER_REQUEST,
				billable: true,
			};
		},
	};
}

export function createBraveSubject(
	config: BraveConfig,
	options: Omit<ProviderSubjectOptions, "config">,
) {
	return providerSubject(braveDefinition(config), { ...options, config });
}
