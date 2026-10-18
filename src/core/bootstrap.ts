import { mean, percentile } from "./metrics.ts";
import type { Estimate } from "./types.ts";

/** 32 位种子的伪随机数生成器 (mulberry32), 让同一份数据的置信区间可复现. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** 字符串的 FNV-1a 哈希, 用作种子: 每个指标的区间只取决于它自己的标识, 与计算顺序无关. */
export function seedFrom(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export interface BootstrapOptions {
	resamples?: number;
	confidence?: number;
	seed?: number;
}

/** 均值与百分位 bootstrap 置信区间: 对样本有放回重采样, 取重采样均值分布的两侧分位数. 空样本返回 null. */
export function bootstrapMean(
	values: readonly number[],
	options: BootstrapOptions = {},
): Estimate | null {
	const center = mean(values);
	if (center === null) return null;
	const { resamples = 1000, confidence = 0.95, seed = 0 } = options;
	const random = mulberry32(seed);
	const n = values.length;
	const means: number[] = [];
	for (let r = 0; r < resamples; r++) {
		let sum = 0;
		for (let i = 0; i < n; i++)
			sum += values[Math.floor(random() * n)] as number;
		means.push(sum / n);
	}
	const tail = ((1 - confidence) / 2) * 100;
	return {
		mean: center,
		low: percentile(means, tail) as number,
		high: percentile(means, 100 - tail) as number,
		n,
	};
}
