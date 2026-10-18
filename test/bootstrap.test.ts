import { describe, expect, it } from "vitest";
import { bootstrapMean, mulberry32, seedFrom } from "../src/core/bootstrap.ts";

describe("seedFrom", () => {
	it("是 32 位 FNV-1a", () => {
		expect(seedFrom("")).toBe(0x811c9dc5);
		expect(seedFrom("a")).toBe(0xe40c292c);
	});
});

describe("mulberry32", () => {
	it("同一种子得到同一序列, 取值在 [0, 1)", () => {
		const a = mulberry32(42);
		const b = mulberry32(42);
		for (let i = 0; i < 1000; i++) {
			const value = a();
			expect(value).toBe(b());
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});
});

describe("bootstrapMean", () => {
	it("空样本为 null", () => {
		expect(bootstrapMean([])).toBeNull();
	});

	it("常数样本的区间退化为一点", () => {
		expect(bootstrapMean([0.5, 0.5, 0.5])).toEqual({
			mean: 0.5,
			low: 0.5,
			high: 0.5,
			n: 3,
		});
	});

	it("同一种子可复现, 不同种子一般不同", () => {
		const values = [0.13, 0.42, 0.77, 0.05, 0.91, 0.38, 0.66, 0.2];
		expect(bootstrapMean(values, { seed: 7 })).toEqual(
			bootstrapMean(values, { seed: 7 }),
		);
		expect(bootstrapMean(values, { seed: 7 })).not.toEqual(
			bootstrapMean(values, { seed: 8 }),
		);
	});

	it("50 个 0 与 50 个 1: 均值 0.5, 95% 区间约为 ±0.098", () => {
		const values = [...Array(50).fill(0), ...Array(50).fill(1)];
		const estimate = bootstrapMean(values, { seed: 1 });
		expect(estimate?.mean).toBe(0.5);
		expect(estimate?.n).toBe(100);
		expect(estimate?.low).toBeGreaterThan(0.36);
		expect(estimate?.low).toBeLessThan(0.44);
		expect(estimate?.high).toBeGreaterThan(0.56);
		expect(estimate?.high).toBeLessThan(0.64);
	});

	it("置信水平越高区间越宽", () => {
		const values = [0.1, 0.4, 0.35, 0.8, 0.9, 0.2, 0.55];
		const narrow = bootstrapMean(values, { confidence: 0.8, seed: 3 });
		const wide = bootstrapMean(values, { confidence: 0.99, seed: 3 });
		if (!narrow || !wide) throw new Error("应有估计");
		expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
	});
});
