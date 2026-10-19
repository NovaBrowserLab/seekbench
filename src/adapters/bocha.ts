import { z } from "zod";
import type { Freshness } from "../core/types.ts";
import {
	ProviderBase,
	type ProviderDefinition,
	type ProviderSubjectOptions,
	providerSubject,
	type RateLimit,
	SubjectError,
	stripHtml,
	toIsoDate,
	USD_PER_CNY,
} from "./_shared.ts";

/** 博查 Web Search API. 见 docs/adapters/bocha.md. */
export const BochaConfig = ProviderBase.extend({
	use: z.literal("bocha"),
	/** 请求长摘要并用它代替短摘要. */
	summary: z.boolean().default(false),
});
export type BochaConfig = z.infer<typeof BochaConfig>;

/** 官方限速随充值档位变化, 取保守值. */
export const bochaRateLimit: RateLimit = { perSecond: 5 };

/** 目录价 0.036 元每次. */
const PRICE_PER_REQUEST = 0.036 * USD_PER_CNY;

const MAX_COUNT = 50;

const FRESHNESS: Record<Freshness, string> = {
	day: "oneDay",
	week: "oneWeek",
	month: "oneMonth",
	year: "oneYear",
};

const BochaPage = z.object({
	name: z.string().nullish(),
	url: z.string(),
	snippet: z.string().nullish(),
	summary: z.string().nullish(),
	siteName: z.string().nullish(),
	siteIcon: z.string().nullish(),
	/** 北京时间, 可能带或不带时区. */
	datePublished: z.string().nullish(),
});

/** 成功时 code 为数字 200; 出错时 code 可能是字符串, 并带 msg 或 message. */
export const BochaResponse = z.object({
	code: z.union([z.number(), z.string()]),
	log_id: z.string().nullish(),
	msg: z.string().nullish(),
	message: z.string().nullish(),
	data: z
		.object({
			webPages: z
				.object({
					totalEstimatedMatches: z.number().nullish(),
					value: z.array(BochaPage).default([]),
				})
				.nullish(),
		})
		.nullish(),
});
export type BochaResponse = z.infer<typeof BochaResponse>;

export function bochaDefinition(
	config: BochaConfig,
): ProviderDefinition<BochaResponse> {
	return {
		name: "bocha",
		defaultBaseUrl: "https://api.bocha.cn/v1/web-search",
		schema: BochaResponse,
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
						count: Math.min(options.count, MAX_COUNT),
						summary: config.summary,
						freshness: options.freshness
							? FRESHNESS[options.freshness]
							: "noLimit",
						...(options.site && { include: options.site }),
					}),
				},
			};
		},
		parse(data, { id }) {
			if (Number(data.code) !== 200) {
				const status = Number(data.code);
				throw new SubjectError(
					id,
					`code ${data.code} ${data.msg ?? data.message ?? ""}`.trim(),
					{
						status: Number.isInteger(status) ? status : null,
						requestId: data.log_id ?? null,
					},
				);
			}
			const pages = data.data?.webPages;
			return {
				hits: (pages?.value ?? []).map((page) => ({
					url: page.url,
					title: stripHtml(page.name ?? ""),
					snippet: stripHtml(
						(config.summary ? page.summary : null) ?? page.snippet ?? "",
					),
					siteName: page.siteName ?? null,
					favicon: page.siteIcon ?? null,
					publishedAt: toIsoDate(page.datePublished, "+08:00"),
				})),
				totalEstimate: pages?.totalEstimatedMatches ?? null,
				cost: PRICE_PER_REQUEST,
				billable: true,
				requestId: data.log_id ?? null,
			};
		},
	};
}

export function createBochaSubject(
	config: BochaConfig,
	options: Omit<ProviderSubjectOptions, "config">,
) {
	return providerSubject(bochaDefinition(config), { ...options, config });
}
