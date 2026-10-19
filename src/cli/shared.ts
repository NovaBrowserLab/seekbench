import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type Config, type LoadedConfig, loadConfig } from "../core/config.ts";
import {
	filterCases,
	type LoadedScenario,
	loadScenario,
} from "../core/scenarios.ts";
import { Run, type RunPlan } from "../core/types.ts";

export const COMMON_OPTIONS = {
	config: { type: "string", default: "seekbench.config.ts" },
	"runs-dir": { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

export const PositiveInt = z.coerce.number().int().positive();

/** 参数错误, 退出码 2 并打印帮助. */
export class UsageError extends Error {}

export function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

export function parseOption<T>(
	schema: z.ZodType<T>,
	value: string,
	name: string,
): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new UsageError(`--${name} 的值无效: ${value}`);
	return parsed.data;
}

export function runsDirOf(
	config: Config,
	root: string,
	override: string | undefined,
): string {
	return override === undefined
		? resolve(root, config.runsDir)
		: resolve(override);
}

/** 读取场景并按计划的过滤条件筛选用例. 计划里记录了用例文件哈希时, 文件有改动即报错. */
export async function loadScenarios(
	dir: string,
	plan: Pick<RunPlan, "scenarios" | "settings">,
	ids: readonly string[],
): Promise<LoadedScenario[]> {
	const loaded: LoadedScenario[] = [];
	for (const id of ids) {
		const scenario = await loadScenario(dir, id);
		const planned = plan.scenarios.find((item) => item.id === id);
		if (planned && planned.casesHash !== scenario.casesHash) {
			throw new Error(`场景 ${id} 的用例文件在运行开始后有改动, 无法续跑`);
		}
		loaded.push({
			...scenario,
			cases: filterCases(scenario.cases, plan.settings.filters),
		});
	}
	return loaded;
}

/** 场景目录下全部场景的 id, 按文件名排序. */
export async function scenarioIds(dir: string): Promise<string[]> {
	const entries = await readdir(dir);
	return entries
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.sort();
}

export interface Progress {
	done: number;
	total: number;
	errors?: number;
}

function progressLine({ done, total, errors }: Progress, label: string) {
	return `${label}${done}/${total} 已完成${errors === undefined ? "" : `, ${errors} 个错误`}`;
}

/** 终端里原地刷新的进度行; 非终端只在结束时输出一行. */
export function progressPrinter(label = "") {
	const tty = process.stderr.isTTY;
	let last = 0;
	return {
		update(progress: Progress) {
			const now = Date.now();
			if (!tty || (now - last < 100 && progress.done < progress.total)) return;
			last = now;
			process.stderr.write(`\r${progressLine(progress, label)}`);
		},
		end(progress: Progress) {
			process.stderr.write(
				`${tty ? "\r" : ""}${progressLine(progress, label)}\n`,
			);
		},
	};
}

/** 配置文件存在时读取; report 一类只读命令在没有配置文件时用默认目录. */
export async function loadConfigIfExists(
	path: string,
): Promise<LoadedConfig | null> {
	return existsSync(path) ? await loadConfig(path) : null;
}

export async function readRun(runDir: string): Promise<Run> {
	const file = join(runDir, "run.json");
	if (!existsSync(file)) throw new UsageError(`找不到 ${file}`);
	const parsed = Run.safeParse(JSON.parse(await readFile(file, "utf8")));
	if (!parsed.success)
		throw new Error(`${file} 格式不符:\n${z.prettifyError(parsed.error)}`);
	return parsed.data;
}

export async function writeRun(runDir: string, run: Run): Promise<void> {
	await writeFile(
		join(runDir, "run.json"),
		`${JSON.stringify(run, null, 2)}\n`,
	);
}

/** 运行的 SIGINT 处理: 第一次请求中止, 第二次立即退出. 返回中止信号与解除函数. */
export function interruptible(message: string): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const onInterrupt = () => {
		if (controller.signal.aborted) process.exit(130);
		process.stderr.write(`\n${message}; 再按一次立即退出\n`);
		controller.abort();
	};
	process.on("SIGINT", onInterrupt);
	return {
		signal: controller.signal,
		dispose: () => process.off("SIGINT", onInterrupt),
	};
}
