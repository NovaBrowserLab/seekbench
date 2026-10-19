import { z } from "zod";
import type { SearchSubject } from "../core/types.ts";
import { apiKeyEnvOf, type RateLimit } from "./_shared.ts";
import { BochaConfig, bochaRateLimit, createBochaSubject } from "./bocha.ts";
import { BraveConfig, braveRateLimit, createBraveSubject } from "./brave.ts";
import {
	createDeepseekSubject,
	DeepseekConfig,
	deepseekRateLimit,
} from "./deepseek.ts";
import { createExaSubject, ExaConfig, exaRateLimit } from "./exa.ts";
import { loadMockSubject, MockConfig, mockRateLimit } from "./mock.ts";
import {
	createTavilySubject,
	TavilyConfig,
	tavilyRateLimit,
} from "./tavily.ts";

/** 配置文件中一个被测对象的声明, 按 use 区分适配器或策略. */
export const SubjectConfig = z.discriminatedUnion("use", [
	MockConfig,
	BochaConfig,
	BraveConfig,
	DeepseekConfig,
	ExaConfig,
	TavilyConfig,
]);
export type SubjectConfig = z.infer<typeof SubjectConfig>;

export interface SubjectContext {
	/** 配置文件所在目录, 声明中的相对路径以它为基准. */
	root: string;
	/** 读取密钥的环境变量. */
	env: Readonly<Record<string, string | undefined>>;
	fetch?: typeof fetch;
}

/** 缺少密钥时也能创建, 供回放使用; 直连前用 missingEnv 检查. */
export async function createSubject(
	id: string,
	config: SubjectConfig,
	context: SubjectContext,
): Promise<SearchSubject> {
	const options = {
		id,
		env: context.env,
		...(context.fetch && { fetch: context.fetch }),
	};
	switch (config.use) {
		case "mock":
			return loadMockSubject(id, config, context.root);
		case "bocha":
			return createBochaSubject(config, options);
		case "brave":
			return createBraveSubject(config, options);
		case "deepseek":
			return createDeepseekSubject(config, options);
		case "exa":
			return createExaSubject(config, options);
		case "tavily":
			return createTavilySubject(config, options);
	}
}

/** 直连需要而环境里没有的密钥变量名; 不需要密钥或已提供时为 null. */
export function missingEnv(
	config: SubjectConfig,
	env: Readonly<Record<string, string | undefined>>,
): string | null {
	if (config.use === "mock") return null;
	const name = apiKeyEnvOf(config.use, config);
	return env[name] ? null : name;
}

/** 声明里没写 rateLimit 时用适配器的默认速率. */
export function rateLimitOf(config: SubjectConfig): RateLimit {
	if (config.rateLimit) return config.rateLimit;
	switch (config.use) {
		case "mock":
			return mockRateLimit;
		case "bocha":
			return bochaRateLimit;
		case "brave":
			return braveRateLimit;
		case "deepseek":
			return deepseekRateLimit;
		case "exa":
			return exaRateLimit;
		case "tavily":
			return tavilyRateLimit;
	}
}
