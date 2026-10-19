import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { RateLimit } from "../adapters/_shared.ts";

/** 一个 OpenAI 兼容的模型端点. 裁判与题库合成各用一个, 互不影响. */
export const ModelEndpoint = z.strictObject({
	/** 接口地址, 不含 /chat/completions. */
	baseUrl: z.url(),
	model: z.string().min(1),
	/** 读取密钥的环境变量名. */
	apiKeyEnv: z.string().min(1),
	/** 原样传给接口的 reasoning_effort; 省略时用模型默认. */
	reasoningEffort: z.string().optional(),
	/** 接口支持 json_schema 结构化输出时打开; 关闭时用 json_object, schema 写进提示词. */
	structuredOutputs: z.boolean().default(false),
	rateLimit: RateLimit.default({ perSecond: 5 }),
	/** 同时在途的调用数. */
	concurrency: z.int().positive().default(8),
});
export type ModelEndpoint = z.infer<typeof ModelEndpoint>;

/** 调用模型所需的全部东西; 测试里用脚本化模型替换 model. */
export interface ModelHandle {
	/** 写入运行记录与缓存路径的模型名. */
	id: string;
	model: LanguageModel;
	/** 原样传给 generateText 的 providerOptions. */
	providerOptions: Record<string, Record<string, string>>;
	/** 关闭时 schema 不随请求发送, 调用方要把它写进提示词. */
	structuredOutputs: boolean;
}

const PROVIDER_NAME = "seekbench";

/** 按端点配置创建模型. 缺密钥时返回 null, 由调用方决定只用缓存还是报错. */
export function createModel(
	endpoint: ModelEndpoint,
	env: Readonly<Record<string, string | undefined>>,
	fetchImpl?: typeof fetch,
): ModelHandle | null {
	const apiKey = env[endpoint.apiKeyEnv];
	if (!apiKey) return null;
	const provider = createOpenAICompatible({
		name: PROVIDER_NAME,
		baseURL: endpoint.baseUrl,
		apiKey,
		supportsStructuredOutputs: endpoint.structuredOutputs,
		...(fetchImpl && { fetch: fetchImpl }),
	});
	return {
		id: endpoint.model,
		model: provider.chatModel(endpoint.model),
		providerOptions: endpoint.reasoningEffort
			? { [PROVIDER_NAME]: { reasoningEffort: endpoint.reasoningEffort } }
			: {},
		structuredOutputs: endpoint.structuredOutputs,
	};
}
