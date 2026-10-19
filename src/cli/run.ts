import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TokenBucket } from "../adapters/_shared.ts";
import {
	createSubject,
	missingEnv,
	rateLimitOf,
	SubjectConfig,
} from "../adapters/index.ts";
import { CassetteStore } from "../core/cassette.ts";
import { loadConfig, stableHash } from "../core/config.ts";
import { renderReport, renderTable } from "../core/report.ts";
import {
	executeRun,
	type RunnerSubject,
	readProgress,
	writeArchive,
} from "../core/runner.ts";
import type { LoadedScenario } from "../core/scenarios.ts";
import { type RunJudge, RunMode, type RunPlan, Tier } from "../core/types.ts";
import { buildRun, judgeStep } from "./pipeline.ts";
import {
	COMMON_OPTIONS,
	interruptible,
	list,
	loadConfigIfExists,
	loadScenarios,
	PositiveInt,
	parseOption,
	progressPrinter,
	readRun,
	runsDirOf,
	UsageError,
	writeRun,
} from "./shared.ts";

function newRunId(): string {
	return `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
}

export async function runCommand(
	args: string[],
	help: string,
): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			...COMMON_OPTIONS,
			scenarios: { type: "string" },
			subjects: { type: "string" },
			reps: { type: "string" },
			concurrency: { type: "string" },
			timeout: { type: "string" },
			tier: { type: "string" },
			source: { type: "string" },
			limit: { type: "string" },
			mode: { type: "string" },
			refresh: { type: "boolean" },
			"cassettes-dir": { type: "string" },
			"scenarios-dir": { type: "string" },
			"judgments-dir": { type: "string" },
			"no-judge": { type: "boolean" },
			"judge-fetch": { type: "boolean" },
			region: { type: "string" },
			resume: { type: "string" },
		},
	});
	if (values.help) {
		console.log(help);
		return 0;
	}
	const { config, root } = await loadConfig(values.config);
	const runsDir = runsDirOf(config, root, values["runs-dir"]);
	const scenariosDirOverride =
		values["scenarios-dir"] === undefined
			? undefined
			: resolve(values["scenarios-dir"]);
	let scenariosDir = scenariosDirOverride ?? resolve(root, config.scenariosDir);
	const cassettes = new CassetteStore(
		values["cassettes-dir"] === undefined
			? resolve(root, config.cassettesDir)
			: resolve(values["cassettes-dir"]),
	);
	const env = process.env;
	const judging = config.judge !== undefined && !values["no-judge"];
	if (values["judge-fetch"] && !judging)
		throw new UsageError("--judge-fetch 需要启用裁判");

	let runId: string;
	let startedAt: string;
	let plan: RunPlan;
	let scenarios: LoadedScenario[];
	const subjects = new Map<string, RunnerSubject>();

	if (values.resume !== undefined) {
		const {
			config: _,
			"runs-dir": __,
			"cassettes-dir": ___,
			"judgments-dir": ____,
			"no-judge": _____,
			"judge-fetch": ______,
			resume,
			...planOptions
		} = values;
		const conflicts = Object.keys(planOptions).filter(
			(name) => planOptions[name as keyof typeof planOptions] !== undefined,
		);
		if (conflicts.length > 0) {
			throw new UsageError(
				`续跑沿用原计划, 不能再指定 ${conflicts.map((name) => `--${name}`).join(", ")}`,
			);
		}
		runId = resume;
		const progress = await readProgress(join(runsDir, runId));
		if (progress.status === "finished")
			throw new UsageError(
				`运行 ${runId} 已完成; 重新打裁判分用 seekbench judge ${runId}`,
			);
		startedAt = progress.startedAt;
		plan = progress.plan;
		if (plan.scenariosDir !== undefined) scenariosDir = plan.scenariosDir;
		scenarios = await loadScenarios(
			scenariosDir,
			plan,
			plan.scenarios.map((scenario) => scenario.id),
		);
		for (const entry of plan.subjects) {
			const subjectConfig = SubjectConfig.parse(entry.config);
			subjects.set(entry.id, {
				subject: await createSubject(entry.id, subjectConfig, { root, env }),
				limiter: new TokenBucket(rateLimitOf(subjectConfig)),
			});
		}
	} else {
		const scenarioIds = list(values.scenarios);
		if (scenarioIds.length === 0) throw new UsageError("缺少 --scenarios");
		const subjectIds = list(values.subjects);
		const selected =
			subjectIds.length > 0 ? subjectIds : Object.keys(config.subjects);
		const mode = values.mode
			? parseOption(RunMode, values.mode, "mode")
			: "live";
		if (mode !== "live" && values.reps !== undefined)
			throw new UsageError("录制与回放每条只跑一次, 不能指定 --reps");
		if (mode !== "record" && values.refresh)
			throw new UsageError("--refresh 只用于 record 模式");
		const settings = {
			reps:
				mode !== "live"
					? 1
					: values.reps
						? parseOption(PositiveInt, values.reps, "reps")
						: config.reps,
			timeoutMs: values.timeout
				? parseOption(PositiveInt, values.timeout, "timeout")
				: config.timeoutMs,
			concurrency: values.concurrency
				? parseOption(PositiveInt, values.concurrency, "concurrency")
				: config.concurrency,
			filters: {
				...(values.tier !== undefined && {
					tier: parseOption(Tier, values.tier, "tier"),
				}),
				...(values.source !== undefined && { source: values.source }),
				...(values.limit !== undefined && {
					limit: parseOption(PositiveInt, values.limit, "limit"),
				}),
			},
		};
		scenarios = await loadScenarios(
			scenariosDir,
			{ scenarios: [], settings },
			scenarioIds,
		);
		const planSubjects: RunPlan["subjects"] = [];
		for (const id of selected) {
			const subjectConfig = config.subjects[id];
			if (!subjectConfig) throw new UsageError(`配置里没有被测对象 ${id}`);
			const missing = mode === "replay" ? null : missingEnv(subjectConfig, env);
			if (missing !== null) {
				process.stderr.write(`跳过 ${id}: 缺少环境变量 ${missing}\n`);
				continue;
			}
			const subject = await createSubject(id, subjectConfig, { root, env });
			subjects.set(id, {
				subject,
				limiter: new TokenBucket(rateLimitOf(subjectConfig)),
			});
			planSubjects.push({
				id,
				kind: subject.kind,
				configHash: stableHash(subjectConfig),
				config: subjectConfig,
			});
		}
		if (subjects.size === 0) throw new UsageError("没有可运行的被测对象");
		runId = newRunId();
		startedAt = new Date().toISOString();
		plan = {
			mode,
			...(values.refresh && { refresh: true }),
			...(values.region ? { region: values.region } : {}),
			...(scenariosDirOverride !== undefined && {
				scenariosDir: scenariosDirOverride,
			}),
			settings,
			scenarios: scenarios.map(({ scenario, cases, casesHash }) => ({
				id: scenario.id,
				version: scenario.version,
				lang: scenario.lang,
				intent: scenario.intent,
				k: scenario.k,
				description: scenario.description,
				cases: cases.length,
				casesHash,
			})),
			subjects: planSubjects,
		};
	}

	const runDir = join(runsDir, runId);
	process.stderr.write(`运行 ${runId}, 记录写入 ${runDir}\n`);
	const interrupt = interruptible("正在中断, 等待在途请求结束");
	const printer = progressPrinter();
	let last = { done: 0, total: 0, errors: 0 };
	try {
		const result = await executeRun({
			runId,
			runDir,
			startedAt,
			plan,
			scenarios,
			subjects,
			cassettes,
			signal: interrupt.signal,
			onProgress: (progress) => {
				last = progress;
				printer.update(progress);
			},
		});
		printer.end(last);
		if (result.reused > 0) {
			process.stderr.write(
				`复用已有录制 ${result.reused} 条, 未发请求; 加 --refresh 可全部重录\n`,
			);
		}
		if (result.configMismatch.length > 0) {
			process.stderr.write(
				`注意: ${result.configMismatch.join(", ")} 的录制所用配置与当前配置不同, 回放结果按录制时的请求得出\n`,
			);
		}
		if (result.interrupted) {
			process.stderr.write(`已中断. 续跑: seekbench run --resume ${runId}\n`);
			return 130;
		}

		let records = result.records;
		let judge: RunJudge | null = null;
		if (judging) {
			const judged = await judgeStep({
				config,
				root,
				env,
				scenarios,
				records,
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
			records = judged.records;
			judge = judged.judge;
			await writeArchive(runDir, records);
		}
		const run = buildRun({
			runId,
			startedAt,
			finishedAt: new Date().toISOString(),
			plan,
			records,
			scenarios,
			judge,
		});
		await writeRun(runDir, run);
		console.log(`\n${renderTable(run)}\n`);
		console.log(`运行记录: ${join(runDir, "run.json")}`);
		console.log(`生成报告: seekbench report ${runId}`);
		return 0;
	} finally {
		interrupt.dispose();
	}
}

/** runsDir 下最近一次完成 (有 run.json) 的运行. */
async function latestRun(runsDir: string): Promise<string> {
	const entries = existsSync(runsDir)
		? await readdir(runsDir, { withFileTypes: true })
		: [];
	const finished: Array<{ id: string; finishedAt: string }> = [];
	for (const entry of entries) {
		const file = join(runsDir, entry.name, "run.json");
		if (!entry.isDirectory() || !existsSync(file)) continue;
		const { finishedAt } = JSON.parse(await readFile(file, "utf8")) as {
			finishedAt: string;
		};
		finished.push({ id: entry.name, finishedAt });
	}
	finished.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
	const latest = finished[0];
	if (!latest) throw new UsageError(`${runsDir} 下没有完成的运行`);
	return latest.id;
}

/** 解析运行 id: 给了就用, 否则取最近一次完成的运行. 返回运行目录. */
export async function resolveRunDir(
	configPath: string,
	runsDirOverride: string | undefined,
	runId: string | undefined,
): Promise<{ runId: string; runDir: string }> {
	let runsDir: string;
	if (runsDirOverride !== undefined) runsDir = resolve(runsDirOverride);
	else {
		const loaded = await loadConfigIfExists(configPath);
		runsDir = loaded
			? runsDirOf(loaded.config, loaded.root, undefined)
			: resolve("runs");
	}
	const id = runId ?? (await latestRun(runsDir));
	return { runId: id, runDir: join(runsDir, id) };
}

export async function reportCommand(
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
	const { runDir } = await resolveRunDir(
		values.config,
		values["runs-dir"],
		positionals[0],
	);
	const run = await readRun(runDir);
	const output = join(runDir, "report.md");
	await writeFile(output, renderReport(run));
	console.log(output);
	return 0;
}
