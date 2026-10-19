import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SubjectConfig } from "../adapters/index.ts";
import { ModelEndpoint } from "./model.ts";

/** 被测对象 id, 如 brave、fusion:brave+exa、http:my-pipeline@1. */
const SubjectId = z
	.string()
	.regex(/^[a-z0-9][a-z0-9:+@._-]*$/, "只能包含小写字母、数字与 : + @ . _ -");

export const JudgeConfig = ModelEndpoint.extend({
	/** 抓取网页正文一起送裁判, 默认只看标题与摘要. */
	fetch: z.boolean().default(false),
	/** 一次调用最多送多少条结果; 一条查询的结果超过时分几次送. */
	maxItemsPerCall: z.int().positive().default(50),
	/** 校准的及格线: 加权 Kappa 低于它不采用该裁判. */
	minKappa: z.number().min(0).max(1).default(0.6),
	/** 人工抽样复核的默认条数. */
	auditSize: z.int().positive().default(200),
});
export type JudgeConfig = z.infer<typeof JudgeConfig>;

export const SynthConfig = ModelEndpoint.extend({
	/** 新合成的用例按此比例抽样写入人工复核队列. */
	reviewRatio: z.number().min(0).max(1).default(0.1),
	/** 一次调用生成多少条. */
	batchSize: z.int().positive().default(25),
	temperature: z.number().min(0).max(2).default(1),
});
export type SynthConfig = z.infer<typeof SynthConfig>;

export const Config = z.strictObject({
	/** 场景文件目录, 相对配置文件所在目录. */
	scenariosDir: z.string().default("datasets/scenarios"),
	/** 运行记录目录, 相对配置文件所在目录. */
	runsDir: z.string().default("runs"),
	/** 录制目录, 相对配置文件所在目录. */
	cassettesDir: z.string().default("cassettes"),
	/** 裁判缓存目录, 相对配置文件所在目录. */
	judgmentsDir: z.string().default("judgments"),
	/** 人工复核过的标注, 裁判校准集; 相对配置文件所在目录. */
	calibrationFile: z.string().default("datasets/calibration/labels.jsonl"),
	/** 导入的私有查询日志, 不提交; 相对配置文件所在目录. */
	privateDir: z.string().default("datasets/private"),
	/** 合成用例的人工复核队列目录, 相对配置文件所在目录. */
	reviewDir: z.string().default("datasets/review"),
	/** 全局在途请求上限. */
	concurrency: z.int().positive().default(32),
	/** 单次调用的超时. */
	timeoutMs: z.int().positive().default(10_000),
	/** 每条用例对每个被测对象的重复次数. */
	reps: z.int().positive().default(3),
	subjects: z.record(SubjectId, SubjectConfig),
	/** LLM 裁判. 省略时只有规则打分. */
	judge: JudgeConfig.optional(),
	/** 合成 B 层用例的模型, dataset:synth 用. */
	synth: SynthConfig.optional(),
});
export type Config = z.infer<typeof Config>;
export type ConfigInput = z.input<typeof Config>;

/** 只为配置文件提供类型提示, 原样返回. */
export function defineConfig(config: ConfigInput): ConfigInput {
	return config;
}

export interface LoadedConfig {
	config: Config;
	/** 配置文件所在目录. */
	root: string;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
	const file = resolve(path);
	const module = await import(pathToFileURL(file).href);
	const parsed = Config.safeParse(module.default);
	if (!parsed.success) {
		throw new Error(`配置文件 ${path} 无效:\n${z.prettifyError(parsed.error)}`);
	}
	return { config: parsed.data, root: dirname(file) };
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** 键排序后序列化的 sha256 前 12 位, 同一份配置得到同一个哈希. */
export function stableHash(value: unknown): string {
	return createHash("sha256")
		.update(stableStringify(value))
		.digest("hex")
		.slice(0, 12);
}
