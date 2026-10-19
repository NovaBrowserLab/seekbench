import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TokenBucket } from "../adapters/_shared.ts";
import { type Config, loadConfig } from "../core/config.ts";
import { parseJsonl, toJsonl } from "../core/jsonl.ts";
import { createModel } from "../core/model.ts";
import {
	formatNumber,
	formatRate,
	type Table,
	textTable,
} from "../core/report.ts";
import { readArchive, readProgress, writeArchive } from "../core/runner.ts";
import { loadScenario } from "../core/scenarios.ts";
import type { Agreement, Scenario } from "../core/types.ts";
import {
	AuditItem,
	auditRun,
	Label,
	labelKey,
	sampleAudit,
} from "../judge/audit.ts";
import { JudgmentCache } from "../judge/cache.ts";
import { calibrate, ruleLabels } from "../judge/calibrate.ts";
import { buildRun, clearJudgments, judgeStep } from "./pipeline.ts";
import { resolveRunDir } from "./run.ts";
import {
	COMMON_OPTIONS,
	interruptible,
	loadScenarios,
	PositiveInt,
	parseOption,
	progressPrinter,
	readRun,
	scenarioIds,
	UsageError,
	writeRun,
} from "./shared.ts";

export const AUDIT_FILE = "audit.jsonl";

function requireJudge(config: Config): NonNullable<Config["judge"]> {
	if (!config.judge) throw new UsageError("配置里没有 judge, 先配置裁判模型");
	return config.judge;
}

/** 读取一次完成的运行: 计划、明细与按计划筛过的场景. 题库在运行后有改动时报错, 因为缓存键依赖用例的意图说明. */
async function loadFinishedRun(config: Config, root: string, runDir: string) {
	const progress = await readProgress(runDir);
	if (progress.status !== "finished")
		throw new UsageError(
			`运行 ${progress.runId} 尚未完成, 先用 seekbench run --resume ${progress.runId} 续跑`,
		);
	const scenarios = await loadScenarios(
		progress.plan.scenariosDir ?? resolve(root, config.scenariosDir),
		progress.plan,
		progress.plan.scenarios.map((scenario) => scenario.id),
	);
	return { progress, scenarios, records: await readArchive(runDir) };
}

/** seekbench judge <run-id>: 对一次完成的运行重新打裁判分, 用于裁判中断后继续、换裁判或只录制未打分的运行. */
export async function judgeCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			...COMMON_OPTIONS,
			"judgments-dir": { type: "string" },
			"judge-fetch": { type: "boolean" },
		},
		allowPositionals: true,
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	const { config, root } = await loadConfig(values.config);
	requireJudge(config);
	const { runId, runDir } = await resolveRunDir(
		values.config,
		values["runs-dir"],
		positionals[0],
	);
	const { progress, scenarios, records } = await loadFinishedRun(
		config,
		root,
		runDir,
	);
	const interrupt = interruptible("正在中断裁判");
	try {
		const judged = await judgeStep({
			config,
			root,
			env: process.env,
			scenarios,
			records: clearJudgments(records),
			fetch: values["judge-fetch"],
			judgmentsDir: values["judgments-dir"],
			signal: interrupt.signal,
		});
		if (judged.interrupted) {
			process.stderr.write(
				`裁判已中断, 已判定的结果留在裁判缓存里. 继续: seekbench judge ${runId}\n`,
			);
			return 130;
		}
		await writeArchive(runDir, judged.records);
		const previous = existsSync(join(runDir, "run.json"))
			? await readRun(runDir)
			: null;
		const run = buildRun({
			runId,
			startedAt: progress.startedAt,
			finishedAt: previous?.finishedAt ?? progress.updatedAt,
			plan: progress.plan,
			records: judged.records,
			scenarios,
			judge: judged.judge,
		});
		await writeRun(runDir, run);
		if (previous?.judge?.audit)
			process.stderr.write(
				"重新打分后原有的人工复核结果已失效, 需要重新抽样复核\n",
			);
		console.log(join(runDir, "run.json"));
		return 0;
	} finally {
		interrupt.dispose();
	}
}

/** seekbench judge:sample <run-id>: 分层抽样, 写出待人工填写等级的 audit.jsonl. */
export async function sampleCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			...COMMON_OPTIONS,
			size: { type: "string" },
			seed: { type: "string" },
			force: { type: "boolean" },
		},
		allowPositionals: true,
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	const { config, root } = await loadConfig(values.config);
	const { runId, runDir } = await resolveRunDir(
		values.config,
		values["runs-dir"],
		positionals[0],
	);
	const run = await readRun(runDir);
	if (!run.judge)
		throw new UsageError(
			`运行 ${runId} 没有裁判等级, 先用 seekbench judge ${runId}`,
		);
	const output = join(runDir, AUDIT_FILE);
	if (existsSync(output) && !values.force) {
		const existing = parseJsonl(
			await readFile(output, "utf8"),
			AuditItem,
			output,
		);
		if (existing.some((item) => item.grade !== null))
			throw new UsageError(`${output} 已有填写的等级; 确认要覆盖时加 --force`);
	}
	const { scenarios, records } = await loadFinishedRun(config, root, runDir);
	const size = values.size
		? parseOption(PositiveInt, values.size, "size")
		: (config.judge?.auditSize ?? 200);
	const items = sampleAudit(records, scenarios, {
		size,
		seed: values.seed ?? runId,
		fetch: run.judge.fetch,
	});
	await writeFile(output, toJsonl(items));
	process.stderr.write(
		`抽出 ${items.length} 条. 逐行填写 grade (等级定义见各场景的刻度), 可在 comment 里写理由, 然后运行 seekbench judge:audit ${runId}\n`,
	);
	console.log(output);
	return 0;
}

function agreementLine(agreement: Agreement): string {
	return `${agreement.n} 条, 一致率 ${formatRate(agreement.exact)}, 相差不超过 1 级 ${formatRate(agreement.withinOne)}, 加权 Kappa ${agreement.kappa === null ? "—" : formatNumber(agreement.kappa)}`;
}

async function readLabels(path: string): Promise<Label[]> {
	return existsSync(path)
		? parseJsonl(await readFile(path, "utf8"), Label, path)
		: [];
}

/** seekbench judge:audit <run-id>: 比较人工填写的等级与裁判等级, 写入 run.json, 并把复核结果并入校准集. */
export async function auditCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: COMMON_OPTIONS,
		allowPositionals: true,
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	const { config, root } = await loadConfig(values.config);
	const { runId, runDir } = await resolveRunDir(
		values.config,
		values["runs-dir"],
		positionals[0],
	);
	const run = await readRun(runDir);
	if (!run.judge) throw new UsageError(`运行 ${runId} 没有裁判等级`);
	const input = join(runDir, AUDIT_FILE);
	if (!existsSync(input))
		throw new UsageError(
			`找不到 ${input}, 先用 seekbench judge:sample ${runId}`,
		);
	const items = parseJsonl(await readFile(input, "utf8"), AuditItem, input);
	const { scenarios, records } = await loadFinishedRun(config, root, runDir);
	const result = auditRun(items, records, scenarios, {
		fetch: run.judge.fetch,
		runId,
	});
	if (result.labels.length === 0)
		throw new UsageError(`${input} 里还没有填写等级`);
	if (result.pending > 0)
		process.stderr.write(
			`还有 ${result.pending} 条没有填写, 本次只比较已填的\n`,
		);
	if (result.unmatched > 0)
		process.stderr.write(
			`${result.unmatched} 条在运行明细里找不到对应的裁判等级, 未计入一致率\n`,
		);
	await writeRun(runDir, {
		...run,
		judge: { ...run.judge, audit: result.agreement },
	});

	const labelsPath = resolve(root, config.calibrationFile);
	const merged = new Map(
		(await readLabels(labelsPath)).map((label) => [labelKey(label), label]),
	);
	for (const label of result.labels) merged.set(labelKey(label), label);
	await mkdir(dirname(labelsPath), { recursive: true });
	await writeFile(labelsPath, toJsonl([...merged.values()]));
	console.log(`人工复核: ${agreementLine(result.agreement)}`);
	console.log(`校准集: ${labelsPath} (${merged.size} 条)`);
	return 0;
}

/** seekbench judge:calibrate: 用校准集评估当前裁判, Kappa 低于及格线时退出码为 1. */
export async function calibrateCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			...COMMON_OPTIONS,
			"from-run": { type: "string" },
			"judgments-dir": { type: "string" },
		},
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	const { config, root } = await loadConfig(values.config);
	const judge = requireJudge(config);
	const scenariosDir = resolve(root, config.scenariosDir);
	const scenarios = new Map<string, Scenario>();
	for (const id of await scenarioIds(scenariosDir))
		scenarios.set(id, (await loadScenario(scenariosDir, id)).scenario);

	const labels = await readLabels(resolve(root, config.calibrationFile));
	if (values["from-run"] !== undefined) {
		const { runId, runDir } = await resolveRunDir(
			values.config,
			values["runs-dir"],
			values["from-run"],
		);
		const finished = await loadFinishedRun(config, root, runDir);
		const anchors = ruleLabels(finished.records, finished.scenarios, runId);
		process.stderr.write(
			`从运行 ${runId} 的规则判定取 ${anchors.length} 条标注\n`,
		);
		labels.push(...anchors);
	}
	if (labels.length === 0)
		throw new UsageError(
			"校准集为空: 先用 judge:sample 与 judge:audit 人工复核一次运行, 或用 --from-run 取 A 层的规则判定",
		);

	const handle = createModel(judge, process.env);
	if (handle === null)
		process.stderr.write(
			`缺少环境变量 ${judge.apiKeyEnv}, 只使用已有的裁判缓存\n`,
		);
	const printer = progressPrinter("裁判 ");
	let last = { done: 0, total: 0 };
	const interrupt = interruptible("正在中断校准");
	let result: Awaited<ReturnType<typeof calibrate>>;
	try {
		result = await calibrate(labels, scenarios, {
			cache: new JudgmentCache(
				values["judgments-dir"] === undefined
					? resolve(root, config.judgmentsDir)
					: resolve(values["judgments-dir"]),
				judge.model,
			),
			handle,
			fetch: false,
			maxItemsPerCall: judge.maxItemsPerCall,
			concurrency: judge.concurrency,
			limiter: new TokenBucket(judge.rateLimit),
			today: new Date().toISOString().slice(0, 10),
			signal: interrupt.signal,
			onProgress: (progress) => {
				last = progress;
				printer.update(progress);
			},
		});
	} finally {
		interrupt.dispose();
	}
	if (last.total > 0) printer.end(last);
	if (interrupt.signal.aborted) return 130;
	for (const message of result.errors)
		process.stderr.write(`裁判调用失败: ${message}\n`);

	const rows = (
		entries: ReadonlyArray<{ id: string; agreement: Agreement }>,
		label: string,
	): Table => ({
		header: [label, "条数", "一致率", "相差 ≤ 1", "加权 Kappa"],
		rows: entries.map(({ id, agreement }) => [
			id,
			String(agreement.n),
			formatRate(agreement.exact),
			formatRate(agreement.withinOne),
			agreement.kappa === null ? "—" : formatNumber(agreement.kappa),
		]),
	});
	const grades = Array.from({ length: result.maxGrade + 1 }, (_, g) =>
		String(g),
	);
	console.log(`裁判 ${judge.model}: ${agreementLine(result.overall)}\n`);
	console.log(
		`${textTable(
			rows(
				result.byScenario.map(({ scenario, agreement }) => ({
					id: scenario,
					agreement,
				})),
				"场景",
			),
		)}\n`,
	);
	console.log(
		`${textTable(
			rows(
				result.bySource.map(({ source, agreement }) => ({
					id: source,
					agreement,
				})),
				"来源",
			),
		)}\n`,
	);
	console.log(
		`${textTable({
			header: ["人工 \\ 裁判", ...grades],
			rows: result.matrix.map((row, grade) => [
				String(grade),
				...row.map(String),
			]),
		})}\n`,
	);
	if (result.skipped > 0)
		process.stderr.write(`${result.skipped} 条标注的场景已不存在, 已跳过\n`);
	if (result.unjudged > 0)
		process.stderr.write(`${result.unjudged} 条标注没有得到裁判等级, 未计入\n`);
	const kappa = result.overall.kappa;
	const passed = kappa !== null && kappa >= judge.minKappa;
	console.log(
		passed
			? `达标: 加权 Kappa ${formatNumber(kappa)} ≥ ${judge.minKappa}`
			: `不达标: 加权 Kappa ${kappa === null ? "无定义" : formatNumber(kappa)} < ${judge.minKappa}, 不应采用这个裁判配置`,
	);
	return passed ? 0 : 1;
}
