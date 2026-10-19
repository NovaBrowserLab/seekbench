import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
	Hit,
	SearchOptions,
	SearchSubject,
	SubjectResponse,
} from "../core/types.ts";

/** 可中止的等待, 中止时以 AbortError 拒绝. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return delay(ms, undefined, signal ? { signal } : undefined);
}

export interface SubjectErrorOptions {
	status?: number | null;
	retryAfterMs?: number | null;
	requestId?: string | null;
	cause?: unknown;
}

/** 被测对象调用失败. 带被测对象 id 与 HTTP 状态, 供重试判断与运行明细记录. */
export class SubjectError extends Error {
	readonly subject: string;
	readonly status: number | null;
	/** 供应商要求的最短重试间隔, 来自 Retry-After. */
	readonly retryAfterMs: number | null;
	readonly requestId: string | null;
	/** 失败前已重试的次数, 由 withRetry 填写. */
	retries = 0;

	constructor(
		subject: string,
		message: string,
		options: SubjectErrorOptions = {},
	) {
		super(`${subject}: ${message}`, { cause: options.cause });
		this.name = "SubjectError";
		this.subject = subject;
		this.status = options.status ?? null;
		this.retryAfterMs = options.retryAfterMs ?? null;
		this.requestId = options.requestId ?? null;
	}

	/** 429 与 5xx 可重试; 其他 4xx 与解析失败重试也不会变好. */
	get retryable(): boolean {
		return this.status === 429 || (this.status !== null && this.status >= 500);
	}
}

export interface RetryOptions {
	/** 首次请求之外最多重试几次. */
	retries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	signal?: AbortSignal;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
}

/**
 * 对可重试的 SubjectError 做指数退避重试, 默认最多 3 次. 间隔为 base × 2^n 乘以 0.5 到 1 的随机因子,
 * 且不短于 Retry-After, 不长于 maxDelayMs. 返回值带实际重试次数, 写进响应的诊断字段.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<{ value: T; retries: number }> {
	const {
		retries = 3,
		baseDelayMs = 500,
		maxDelayMs = 8000,
		signal,
		sleep: wait = sleep,
		random = Math.random,
	} = options;
	for (let attempt = 0; ; attempt++) {
		try {
			return { value: await fn(), retries: attempt };
		} catch (error) {
			if (!(error instanceof SubjectError)) throw error;
			error.retries = attempt;
			if (!error.retryable || attempt >= retries || signal?.aborted)
				throw error;
			const backoff = baseDelayMs * 2 ** attempt * (0.5 + random() * 0.5);
			await wait(
				Math.min(maxDelayMs, Math.max(backoff, error.retryAfterMs ?? 0)),
				signal,
			);
		}
	}
}

/** Retry-After 头: 秒数或 HTTP 日期. 无法解析时返回 null. */
export function parseRetryAfter(
	value: string | null,
	now = Date.now(),
): number | null {
	if (value === null || value.trim() === "") return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export const RateLimit = z.object({
	/** 每秒补充的令牌数. */
	perSecond: z.number().positive(),
	/** 桶容量, 即允许的突发请求数. 默认取每秒速率, 至少为 1. */
	burst: z.int().positive().optional(),
});
export type RateLimit = z.infer<typeof RateLimit>;

export interface Clock {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const systemClock: Clock = { now: () => performance.now(), sleep };

/**
 * 令牌桶限速器. 令牌按速率连续补充; 取令牌时先预占, 余额为负则按欠额等待,
 * 所以等待顺序即调用顺序. 放弃等待时归还预占的令牌.
 */
export class TokenBucket {
	readonly #perMs: number;
	readonly #capacity: number;
	readonly #clock: Clock;
	#tokens: number;
	#updatedAt: number;

	constructor(limit: RateLimit, clock: Clock = systemClock) {
		this.#perMs = limit.perSecond / 1000;
		this.#capacity = limit.burst ?? Math.max(1, Math.floor(limit.perSecond));
		this.#clock = clock;
		this.#tokens = this.#capacity;
		this.#updatedAt = clock.now();
	}

	async take(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const now = this.#clock.now();
		this.#tokens = Math.min(
			this.#capacity,
			this.#tokens + (now - this.#updatedAt) * this.#perMs,
		);
		this.#updatedAt = now;
		this.#tokens -= 1;
		if (this.#tokens >= 0) return;
		try {
			await this.#clock.sleep(-this.#tokens / this.#perMs, signal);
		} catch (error) {
			this.#tokens += 1;
			throw error;
		}
	}
}

export interface RequestJsonOptions<T> {
	subject: string;
	url: string | URL;
	init?: RequestInit;
	schema: z.ZodType<T>;
	/** 供应商返回请求 id 的响应头. */
	requestIdHeader?: string;
	fetch?: typeof fetch;
}

/**
 * 发请求并按 schema 解析 JSON 响应. 非 2xx、非 JSON 与结构不符都抛出带 HTTP 状态的 SubjectError.
 * 返回解析后的数据、原始响应与请求 id.
 */
export async function requestJson<T>(
	options: RequestJsonOptions<T>,
): Promise<{ data: T; raw: unknown; requestId: string | null }> {
	const { subject } = options;
	const response = await (options.fetch ?? fetch)(options.url, options.init);
	const requestId = options.requestIdHeader
		? response.headers.get(options.requestIdHeader)
		: null;
	const status = response.status;
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new SubjectError(
			subject,
			`HTTP ${status} ${body.slice(0, 200)}`.trim(),
			{
				status,
				retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
				requestId,
			},
		);
	}
	let raw: unknown;
	try {
		raw = await response.json();
	} catch (cause) {
		throw new SubjectError(subject, "响应不是合法的 JSON", {
			status,
			requestId,
			cause,
		});
	}
	const parsed = options.schema.safeParse(raw);
	if (!parsed.success) {
		throw new SubjectError(
			subject,
			`响应结构不符:\n${z.prettifyError(parsed.error)}`,
			{
				status,
				requestId,
			},
		);
	}
	return { data: parsed.data, raw, requestId };
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	middot: "·",
};

/** 去掉 HTML 标签、解码常见实体并压缩空白, 供应商的摘要与标题统一转成纯文本. */
export function stripHtml(text: string): string {
	return text
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
			if (entity[0] === "#") {
				const code =
					entity[1] === "x" || entity[1] === "X"
						? Number.parseInt(entity.slice(2), 16)
						: Number.parseInt(entity.slice(1), 10);
				return Number.isFinite(code) && code > 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: match;
			}
			return ENTITIES[entity.toLowerCase()] ?? match;
		})
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * 把供应商返回的发布时间转成带时区的 ISO 8601. 只有日期时取当天零点;
 * 有时间而没有时区时按 defaultOffset 解释 (如 +08:00). 无法解析时返回 null.
 */
export function toIsoDate(
	value: string | null | undefined,
	defaultOffset = "Z",
): string | null {
	if (value === null || value === undefined) return null;
	let text = value.trim();
	if (text === "") return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(text))
		text = `${text}T00:00:00${defaultOffset}`;
	else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text))
		text = `${text.replace(" ", "T")}${defaultOffset}`;
	const time = Date.parse(text);
	if (Number.isNaN(time)) return null;
	const date = new Date(time);
	const year = date.getUTCFullYear();
	return year < 1990 || year > 9999 ? null : date.toISOString();
}

/** 人民币计价的供应商按此固定汇率折算美元; 需要精确费用时在配置里用 pricePer1k 覆盖. */
export const USD_PER_CNY = 0.14;

/** 各供应商声明共有的配置项. */
export const ProviderBase = z.strictObject({
	/** 读取 API 密钥的环境变量名, 默认为 <供应商>_API_KEY. */
	apiKeyEnv: z
		.string()
		.regex(/^[A-Z_][A-Z0-9_]*$/)
		.optional(),
	/** 覆盖接口地址, 如走代理或私有部署. */
	baseUrl: z.url().optional(),
	rateLimit: RateLimit.optional(),
	/** 覆盖默认计费: 每千次计费请求的美元价格. */
	pricePer1k: z.number().nonnegative().optional(),
});

/** 适配器解析一次响应的结果. */
export interface ParsedResponse {
	hits: Hit[];
	totalEstimate: number | null;
	/** 按默认计费模型算出的美元费用. */
	cost: number;
	/** 本次请求是否计费; 配置了 pricePer1k 时按它计价. */
	billable: boolean;
	/** 响应体里的请求 id. */
	requestId?: string | null;
}

export interface ParseContext {
	/** 被测对象 id, 用于错误信息. */
	id: string;
	query: string;
	options: SearchOptions;
}

/** 一家供应商的请求构造与响应解析, 由 providerSubject 包装成被测对象. */
export interface ProviderDefinition<T> {
	/** 适配器名, 也用于默认的环境变量名与错误信息. */
	name: string;
	defaultBaseUrl: string;
	schema: z.ZodType<T>;
	/** 返回请求 id 的响应头. */
	requestIdHeader?: string;
	request(
		query: string,
		options: SearchOptions,
		context: { apiKey: string; baseUrl: string; now: Date },
	): { url: string | URL; init: RequestInit };
	/** 解析已通过 schema 校验的响应. 响应体里报告的错误在这里抛出 SubjectError, 可重试的错误会重试. */
	parse(data: T, context: ParseContext): ParsedResponse;
}

export interface ProviderSubjectOptions {
	id: string;
	config: z.infer<typeof ProviderBase>;
	env: Readonly<Record<string, string | undefined>>;
	fetch?: typeof fetch;
	retry?: Omit<RetryOptions, "signal">;
	now?: () => Date;
}

export function apiKeyEnvOf(
	name: string,
	config: z.infer<typeof ProviderBase>,
): string {
	return config.apiKeyEnv ?? `${name.toUpperCase()}_API_KEY`;
}

/**
 * 把供应商定义包装成被测对象: 鉴权、超时、429 与 5xx 重试、响应校验与计费都在这里统一处理.
 * 缺少密钥时仍可创建, 用于回放; 此时 search 抛错.
 */
export function providerSubject<T>(
	definition: ProviderDefinition<T>,
	options: ProviderSubjectOptions,
): SearchSubject {
	const { id, config } = options;
	const keyEnv = apiKeyEnvOf(definition.name, config);
	const baseUrl = config.baseUrl ?? definition.defaultBaseUrl;
	const now = options.now ?? (() => new Date());
	const finish = (
		parsed: ParsedResponse,
		raw: unknown,
		retries: number,
		requestId: string | null,
	): SubjectResponse => ({
		hits: parsed.hits.map((hit) => ({
			...hit,
			siteName: hit.siteName || null,
			favicon: hit.favicon || null,
		})),
		totalEstimate: parsed.totalEstimate,
		raw,
		cost: !parsed.billable
			? 0
			: config.pricePer1k !== undefined
				? config.pricePer1k / 1000
				: parsed.cost,
		calls: 1,
		diagnostics: { retries, requestId: parsed.requestId ?? requestId },
	});
	return {
		id,
		kind: "provider",
		langs: ["zh", "en"],
		async search(query, searchOptions) {
			const apiKey = options.env[keyEnv];
			if (!apiKey) throw new SubjectError(id, `缺少环境变量 ${keyEnv}`);
			const { url, init } = definition.request(query, searchOptions, {
				apiKey,
				baseUrl,
				now: now(),
			});
			const context = { id, query, options: searchOptions };
			const { value, retries } = await withRetry(
				async () => {
					const response = await requestJson({
						subject: id,
						url,
						init: {
							...init,
							...(searchOptions.signal && { signal: searchOptions.signal }),
						},
						schema: definition.schema,
						...(definition.requestIdHeader && {
							requestIdHeader: definition.requestIdHeader,
						}),
						...(options.fetch && { fetch: options.fetch }),
					});
					return {
						...response,
						parsed: definition.parse(response.data, context),
					};
				},
				{
					...options.retry,
					...(searchOptions.signal && { signal: searchOptions.signal }),
				},
			);
			return finish(value.parsed, value.raw, retries, value.requestId);
		},
		replay(raw, query, searchOptions) {
			const data = definition.schema.safeParse(raw);
			if (!data.success) {
				throw new SubjectError(
					id,
					`录制的响应结构不符:\n${z.prettifyError(data.error)}`,
				);
			}
			return finish(
				definition.parse(data.data, { id, query, options: searchOptions }),
				raw,
				0,
				null,
			);
		},
	};
}
