import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SubjectConfig } from "../adapters/index.ts";

/** 被测对象 id, 如 brave、fusion:brave+exa、http:my-pipeline@1. */
const SubjectId = z
	.string()
	.regex(/^[a-z0-9][a-z0-9:+@._-]*$/, "只能包含小写字母、数字与 : + @ . _ -");

export const Config = z.strictObject({
	/** 场景文件目录, 相对配置文件所在目录. */
	scenariosDir: z.string().default("datasets/scenarios"),
	/** 运行记录目录, 相对配置文件所在目录. */
	runsDir: z.string().default("runs"),
	/** 全局在途请求上限. */
	concurrency: z.int().positive().default(32),
	/** 单次调用的超时. */
	timeoutMs: z.int().positive().default(10_000),
	/** 每条用例对每个被测对象的重复次数. */
	reps: z.int().positive().default(3),
	subjects: z.record(SubjectId, SubjectConfig),
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
