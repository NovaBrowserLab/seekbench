import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

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
