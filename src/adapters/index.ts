import { z } from "zod";
import type { SearchSubject } from "../core/types.ts";
import type { RateLimit } from "./_shared.ts";
import { loadMockSubject, MockConfig, mockRateLimit } from "./mock.ts";

/** 配置文件中一个被测对象的声明, 按 use 区分适配器或策略. */
export const SubjectConfig = z.discriminatedUnion("use", [MockConfig]);
export type SubjectConfig = z.infer<typeof SubjectConfig>;

export interface SubjectContext {
	/** 配置文件所在目录, 声明中的相对路径以它为基准. */
	root: string;
}

export async function createSubject(
	id: string,
	config: SubjectConfig,
	context: SubjectContext,
): Promise<SearchSubject> {
	switch (config.use) {
		case "mock":
			return loadMockSubject(id, config, context.root);
	}
}

/** 声明里没写 rateLimit 时用适配器的默认速率. */
export function rateLimitOf(config: SubjectConfig): RateLimit {
	if (config.rateLimit) return config.rateLimit;
	switch (config.use) {
		case "mock":
			return mockRateLimit;
	}
}
