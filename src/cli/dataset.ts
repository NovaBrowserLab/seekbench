import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../core/config.ts";
import { toJsonl } from "../core/jsonl.ts";
import { createModel } from "../core/model.ts";
import { markdownTable, textTable } from "../core/report.ts";
import { loadScenario } from "../core/scenarios.ts";
import type { SynthTemplate } from "../core/types.ts";
import { importLog, readLogQueries } from "../dataset/import-log.ts";
import { datasetStats, statsTable } from "../dataset/stats.ts";
import { reviewSample, synthesize } from "../dataset/synth.ts";
import { formatIssue, validateScenarios } from "../dataset/validate.ts";
import {
	COMMON_OPTIONS,
	interruptible,
	list,
	PositiveInt,
	parseOption,
	progressPrinter,
	scenarioIds,
	UsageError,
} from "./shared.ts";

const DATASET_OPTIONS = {
	...COMMON_OPTIONS,
	scenarios: { type: "string" },
	"scenarios-dir": { type: "string" },
} as const;

async function selectedScenarios(values: {
	config: string;
	scenarios?: string;
	"scenarios-dir"?: string;
}) {
	const { config, root } = await loadConfig(values.config);
	const dir =
		values["scenarios-dir"] === undefined
			? resolve(root, config.scenariosDir)
			: resolve(values["scenarios-dir"]);
	const ids = list(values.scenarios);
	return {
		config,
		root,
		dir,
		ids: ids.length > 0 ? ids : await scenarioIds(dir),
	};
}

/** seekbench dataset:validate: 校验题库, 有错误时退出码为 1. */
export async function validateCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values } = parseArgs({ args, options: DATASET_OPTIONS });
	if (values.help) {
		console.log(help);
		return 0;
	}
	const { dir, ids } = await selectedScenarios(values);
	const { issues, scenarios } = await validateScenarios(dir, ids);
	for (const issue of issues) console.log(formatIssue(issue));
	const errors = issues.filter((issue) => issue.level === "error").length;
	const cases = scenarios.reduce((sum, { cases }) => sum + cases.length, 0);
	console.log(
		`${ids.length} 个场景, ${cases} 条用例, ${errors} 个错误, ${issues.length - errors} 个警告`,
	);
	return errors > 0 ? 1 : 0;
}

/** seekbench dataset:stats: 按场景、层、来源、语言输出数量与长度分布. */
export async function statsCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { ...DATASET_OPTIONS, markdown: { type: "boolean" } },
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	const { dir, ids } = await selectedScenarios(values);
	const scenarios = await Promise.all(ids.map((id) => loadScenario(dir, id)));
	const table = statsTable(datasetStats(scenarios));
	console.log(values.markdown ? markdownTable(table) : textTable(table));
	return 0;
}

/** 追加 JSONL 行; 文件末尾缺换行时先补上. */
async function appendLines(path: string, items: readonly unknown[]) {
	if (items.length === 0) return;
	await mkdir(dirname(path), { recursive: true });
	const prefix =
		existsSync(path) && !(await readFile(path, "utf8")).match(/(^|\n)$/)
			? "\n"
			: "";
	await appendFile(path, prefix + toJsonl(items));
}

/** seekbench dataset:synth: 按场景里的模板合成 B 层用例, 追加到用例文件, 并抽样写入复核队列. */
export async function synthCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			...DATASET_OPTIONS,
			template: { type: "string" },
			seed: { type: "string" },
			"dry-run": { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	const { config, root, dir, ids } = await selectedScenarios(values);
	const synth = config.synth;
	if (!synth) throw new UsageError("配置里没有 synth, 先配置合成用的模型");
	const plans: Array<{
		loaded: Awaited<ReturnType<typeof loadScenario>>;
		template: SynthTemplate;
		need: number;
	}> = [];
	for (const id of ids) {
		const loaded = await loadScenario(dir, id);
		for (const template of loaded.scenario.synth ?? []) {
			if (values.template !== undefined && template.id !== values.template)
				continue;
			const have = loaded.cases.filter(
				(kase) => kase.source === `synth:${template.id}`,
			).length;
			const need = Math.max(0, template.count - have);
			console.log(
				`${id}/${template.id}: 已有 ${have}, 目标 ${template.count}, 需要合成 ${need}`,
			);
			if (need > 0) plans.push({ loaded, template, need });
		}
	}
	if (plans.length === 0 || values["dry-run"]) return 0;
	const handle = createModel(synth, process.env);
	if (handle === null) throw new UsageError(`缺少环境变量 ${synth.apiKeyEnv}`);

	const interrupt = interruptible("正在中断合成");
	try {
		for (const { loaded, template, need } of plans) {
			const { scenario } = loaded;
			const printer = progressPrinter(`${scenario.id}/${template.id} `);
			const existing = (await loadScenario(dir, scenario.id)).cases;
			const result = await synthesize(handle, {
				scenario,
				template,
				existing,
				count: need,
				batchSize: synth.batchSize,
				temperature: synth.temperature,
				seed: values.seed ?? `${scenario.id}|${template.id}|${existing.length}`,
				signal: interrupt.signal,
				onProgress: (progress) => printer.update(progress),
			});
			printer.end({ done: result.cases.length, total: need });
			await appendLines(resolve(dir, scenario.casesFile), result.cases);
			const queue = reviewSample(
				result.cases,
				synth.reviewRatio,
				`${scenario.id}|${template.id}|review`,
			);
			await appendLines(
				resolve(root, config.reviewDir, `${scenario.id}.jsonl`),
				queue,
			);
			console.log(
				`${scenario.id}/${template.id}: 新增 ${result.cases.length} 条, 丢弃近似重复 ${result.duplicates}、无效 ${result.invalid}; 调用 ${result.calls} 次 (输入 ${result.inputTokens} / 输出 ${result.outputTokens} tokens); ${queue.length} 条进入复核队列`,
			);
		}
	} finally {
		interrupt.dispose();
	}
	console.log("题库有变动, 公开结果前记得升对应场景的 version.");
	return 0;
}

/** seekbench dataset:import-log <file>: 导入私有查询日志, 脱敏后按场景粗分, 写到本机的私有目录. */
export async function importLogCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			...COMMON_OPTIONS,
			batch: { type: "string" },
			format: { type: "string" },
			"min-length": { type: "string" },
			names: { type: "string" },
			out: { type: "string" },
		},
		allowPositionals: true,
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	const file = positionals[0];
	if (file === undefined) throw new UsageError("缺少日志文件路径");
	const { config, root } = await loadConfig(values.config);
	const batch =
		values.batch ??
		basename(file, extname(file))
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-");
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(batch))
		throw new UsageError(`--batch 只能包含小写字母、数字与连字符: ${batch}`);
	const format = parseOption(
		z.enum(["csv", "jsonl"]),
		values.format ?? (extname(file).toLowerCase() === ".csv" ? "csv" : "jsonl"),
		"format",
	);
	const names = values.names
		? (await readFile(values.names, "utf8"))
				.split("\n")
				.map((name) => name.trim())
				.filter((name) => name !== "")
		: [];
	const result = importLog(
		readLogQueries(await readFile(file, "utf8"), format),
		{
			batch,
			minLength: values["min-length"]
				? parseOption(PositiveInt, values["min-length"], "min-length")
				: 2,
			names,
		},
	);

	const outDir = values.out
		? resolve(values.out)
		: resolve(root, config.privateDir, batch);
	const scenariosDir = resolve(root, config.scenariosDir);
	await mkdir(outDir, { recursive: true });
	const rows: string[][] = [];
	for (const [id, cases] of [...result.byScenario].sort()) {
		await writeFile(join(outDir, `${id}.cases.jsonl`), toJsonl(cases));
		const template = join(scenariosDir, `${id}.json`);
		if (existsSync(template)) {
			const { synth: _, ...scenario } = JSON.parse(
				await readFile(template, "utf8"),
			) as Record<string, unknown>;
			await writeFile(
				join(outDir, `${id}.json`),
				`${JSON.stringify({ ...scenario, version: `log-${batch}`, casesFile: `${id}.cases.jsonl` }, null, "\t")}\n`,
			);
		}
		rows.push([
			id,
			String(cases.length),
			existsSync(template) ? "" : "没有同名公开场景, 未生成场景文件",
		]);
	}
	console.log(textTable({ header: ["场景", "用例", "备注"], rows }));
	const { dropped } = result;
	console.log(
		`丢弃: 个人信息 ${dropped.pii}${
			Object.keys(result.pii).length > 0
				? ` (${Object.entries(result.pii)
						.map(([label, count]) => `${label} ${count}`)
						.join(", ")})`
				: ""
		}, 过短 ${dropped.short}, 人名 ${dropped.name}, 重复 ${dropped.duplicate}`,
	);
	console.log(
		`写入 ${outDir}. 该目录不提交; 用 seekbench run --scenarios-dir ${outDir} --scenarios <场景> 评测`,
	);
	return 0;
}
