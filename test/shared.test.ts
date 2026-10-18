import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type Clock,
	parseRetryAfter,
	requestJson,
	SubjectError,
	TokenBucket,
	withRetry,
} from "../src/adapters/_shared.ts";

/** 手动推进的时钟: sleep 立即返回并把时间推到醒来的时刻, 记录每次等待. */
function fakeClock() {
	let now = 0;
	const sleeps: number[] = [];
	const clock: Clock = {
		now: () => now,
		async sleep(ms, signal) {
			signal?.throwIfAborted();
			sleeps.push(ms);
		},
	};
	return {
		clock,
		sleeps,
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("SubjectError", () => {
	it("429 与 5xx 可重试, 其他不可", () => {
		expect(new SubjectError("x", "m", { status: 429 }).retryable).toBe(true);
		expect(new SubjectError("x", "m", { status: 503 }).retryable).toBe(true);
		expect(new SubjectError("x", "m", { status: 400 }).retryable).toBe(false);
		expect(new SubjectError("x", "m").retryable).toBe(false);
	});

	it("消息带被测对象 id", () => {
		const error = new SubjectError("brave", "HTTP 500", { status: 500 });
		expect(error.message).toBe("brave: HTTP 500");
		expect(error.name).toBe("SubjectError");
		expect(error.subject).toBe("brave");
	});
});

describe("withRetry", () => {
	const noWait = { sleep: async () => {}, random: () => 1 };

	it("可重试错误最多重试 3 次, 返回重试次数", async () => {
		let calls = 0;
		const result = await withRetry(async () => {
			calls++;
			if (calls < 3) throw new SubjectError("x", "限流", { status: 429 });
			return "ok";
		}, noWait);
		expect(result).toEqual({ value: "ok", retries: 2 });
	});

	it("超过次数后抛出最后一次错误, 并记下重试次数", async () => {
		let calls = 0;
		const error = await withRetry(async () => {
			calls++;
			throw new SubjectError("x", "挂了", { status: 502 });
		}, noWait).catch((e: unknown) => e);
		expect(calls).toBe(4);
		expect(error).toBeInstanceOf(SubjectError);
		expect((error as SubjectError).retries).toBe(3);
	});

	it("其他 4xx 与非 SubjectError 不重试", async () => {
		let calls = 0;
		await expect(
			withRetry(async () => {
				calls++;
				throw new SubjectError("x", "参数错误", { status: 400 });
			}, noWait),
		).rejects.toThrow("参数错误");
		await expect(
			withRetry(async () => {
				calls++;
				throw new TypeError("网络错误");
			}, noWait),
		).rejects.toThrow("网络错误");
		expect(calls).toBe(2);
	});

	it("指数退避, 不短于 Retry-After, 不长于上限", async () => {
		const waits: number[] = [];
		let calls = 0;
		await withRetry(
			async () => {
				calls++;
				if (calls === 1) throw new SubjectError("x", "a", { status: 500 });
				if (calls === 2)
					throw new SubjectError("x", "b", { status: 429, retryAfterMs: 5000 });
				if (calls === 3)
					throw new SubjectError("x", "c", {
						status: 500,
						retryAfterMs: 60_000,
					});
				return null;
			},
			{
				baseDelayMs: 100,
				maxDelayMs: 8000,
				random: () => 0,
				sleep: async (ms) => {
					waits.push(ms);
				},
			},
		);
		expect(waits).toEqual([50, 5000, 8000]);
	});

	it("已中止时不再重试", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			withRetry(
				async () => {
					calls++;
					throw new SubjectError("x", "挂了", { status: 500 });
				},
				{ ...noWait, signal: controller.signal },
			),
		).rejects.toThrow("挂了");
		expect(calls).toBe(1);
	});
});

describe("parseRetryAfter", () => {
	it("秒数或 HTTP 日期", () => {
		const now = Date.parse("2026-10-01T00:00:00Z");
		expect(parseRetryAfter("2", now)).toBe(2000);
		expect(parseRetryAfter("Thu, 01 Oct 2026 00:00:03 GMT", now)).toBe(3000);
		expect(parseRetryAfter(null, now)).toBeNull();
		expect(parseRetryAfter("soon", now)).toBeNull();
	});
});

describe("TokenBucket", () => {
	it("桶满时可突发, 之后按速率排队", async () => {
		const { clock, sleeps } = fakeClock();
		const bucket = new TokenBucket({ perSecond: 2, burst: 2 }, clock);
		await bucket.take();
		await bucket.take();
		await bucket.take();
		await bucket.take();
		expect(sleeps).toEqual([500, 1000]);
	});

	it("令牌随时间补充, 不超过容量", async () => {
		const { clock, sleeps, advance } = fakeClock();
		const bucket = new TokenBucket({ perSecond: 1 }, clock);
		await bucket.take();
		advance(10_000);
		await bucket.take();
		await bucket.take();
		expect(sleeps).toEqual([1000]);
	});

	it("容量默认取每秒速率, 至少为 1", async () => {
		const { clock, sleeps } = fakeClock();
		const bucket = new TokenBucket({ perSecond: 0.5 }, clock);
		await bucket.take();
		await bucket.take();
		expect(sleeps).toEqual([2000]);
	});

	it("放弃等待时归还预占的令牌", async () => {
		const sleeps: number[] = [];
		const controller = new AbortController();
		const clock: Clock = {
			now: () => 0,
			async sleep(ms, signal) {
				sleeps.push(ms);
				if (signal === controller.signal) {
					controller.abort();
					signal.throwIfAborted();
				}
			},
		};
		const bucket = new TokenBucket({ perSecond: 1, burst: 1 }, clock);
		await bucket.take();
		await expect(bucket.take(controller.signal)).rejects.toThrow();
		await bucket.take();
		expect(sleeps).toEqual([1000, 1000]);
	});

	it("真实时钟下的速率", async () => {
		const bucket = new TokenBucket({ perSecond: 50, burst: 1 });
		const started = performance.now();
		for (let i = 0; i < 6; i++) await bucket.take();
		expect(performance.now() - started).toBeGreaterThanOrEqual(90);
	});
});

describe("requestJson", () => {
	const schema = z.object({ results: z.array(z.string()) });
	const stub = (response: Response) => async () => response;

	it("解析成功时返回数据、原始响应与请求 id", async () => {
		const result = await requestJson({
			subject: "x",
			url: "https://api.example/search",
			schema,
			requestIdHeader: "x-request-id",
			fetch: stub(
				new Response(JSON.stringify({ results: ["a"], extra: 1 }), {
					headers: { "x-request-id": "req-1" },
				}),
			),
		});
		expect(result.data).toEqual({ results: ["a"] });
		expect(result.raw).toEqual({ results: ["a"], extra: 1 });
		expect(result.requestId).toBe("req-1");
	});

	it("非 2xx 抛出带状态与 Retry-After 的 SubjectError", async () => {
		const error = await requestJson({
			subject: "x",
			url: "https://api.example/search",
			schema,
			fetch: stub(
				new Response("slow down", {
					status: 429,
					headers: { "retry-after": "3" },
				}),
			),
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SubjectError);
		expect((error as SubjectError).status).toBe(429);
		expect((error as SubjectError).retryAfterMs).toBe(3000);
		expect((error as SubjectError).message).toBe("x: HTTP 429 slow down");
	});

	it("不是 JSON 或结构不符时抛出不可重试的 SubjectError", async () => {
		const notJson = await requestJson({
			subject: "x",
			url: "https://api.example/search",
			schema,
			fetch: stub(new Response("<html>")),
		}).catch((e: unknown) => e);
		expect((notJson as SubjectError).status).toBe(200);
		expect((notJson as SubjectError).retryable).toBe(false);
		const wrongShape = await requestJson({
			subject: "x",
			url: "https://api.example/search",
			schema,
			fetch: stub(new Response(JSON.stringify({ results: "a" }))),
		}).catch((e: unknown) => e);
		expect((wrongShape as SubjectError).message).toContain("响应结构不符");
	});
});
