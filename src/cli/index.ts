import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { TokenBucket } from "../adapters/_shared.ts";
import {
	createSubject,
	missingEnv,
	rateLimitOf,
	SubjectConfig,
} from "../adapters/index.ts";
import { CassetteStore } from "../core/cassette.ts";
import { type Config, loadConfig, stableHash } from "../core/config.ts";
import { renderReport, renderTable, summarize } from "../core/report.ts";
import {
	executeRun,
	type RunnerSubject,
	readProgress,
} from "../core/runner.ts";
import {
	filterCases,
	type LoadedScenario,
	loadScenario,
} from "../core/scenarios.ts";
import {
	type CaseRecord,
	Run,
	RunMode,
	type RunPlan,
	Tier,
} from "../core/types.ts";

const HELP = `seekbench: 搜索场景 Benchmark

用法:
  seekbench run --scenarios <ids> [--subjects <ids>] [选项]
  seekbench run --resume <run-id>
  seekbench report [run-id]

run 选项:
  --scenarios <ids>     场景 id, 逗号分隔
  --subjects <ids>      被测对象 id, 逗号分隔; 省略时为配置里的全部
  --mode <mode>         live 直连 (默认) / record 直连并录制 / replay 只读录制, 不需要密钥
  --reps <n>            每条用例对每个被测对象的重复次数, 只用于 live
  --concurrency <n>     全局在途请求上限
  --timeout <ms>        单次调用超时
  --tier <A|B>          只跑某一层的用例
  --source <prefix>     只跑来源以此开头的用例, 如 handwritten、synth
  --limit <n>           每个场景只跑过滤后的前 n 条用例
  --region <name>       标注机器所在区域, 写入运行记录
  --resume <run-id>     续跑中断的运行, 沿用它的计划

通用选项:
  --config <path>       配置文件, 默认 seekbench.config.ts
  --runs-dir <dir>      运行记录目录, 覆盖配置里的 runsDir
  --cassettes-dir <dir> 录制目录, 覆盖配置里的 cassettesDir
  -h, --help            显示帮助

live 与 record 模式从环境变量读密钥, 缺密钥的被测对象跳过并告警.
report 不带 run-id 时取最近一次完成的运行.`;

const COMMON_OPTIONS = {
	config: { type: "string", default: "seekbench.config.ts" },
	"runs-dir": { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

const PositiveInt = z.coerce.number().int().positive();

/** 参数错误, 退出码 2 并打印帮助. */
class UsageError extends Error {}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

function parseOption<T>(schema: z.ZodType<T>, value: string, name: string): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new UsageError(`--${name} 的值无效: ${value}`);
	return parsed.data;
}

function newRunId(): string {
	return `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
}

function runsDirOf(
	config: Config,
	root: string,
	override: string | undefined,
): string {
	return override === undefined
		? resolve(root, config.runsDir)
		: resolve(override);
}

async function loadScenarios(
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

/** 终端里原地刷新的进度行; 非终端只在结束时输出一行. */
function progressPrinter() {
	const tty = process.stderr.isTTY;
	let last = 0;
	return {
		update({
			done,
			total,
			errors,
		}: {
			done: number;
			total: number;
			errors: number;
		}) {
			const now = Date.now();
			if (!tty || (now - last < 100 && done < total)) return;
			last = now;
			process.stderr.write(`\r${done}/${total} 已完成, ${errors} 个错误`);
		},
		end({
			done,
			total,
			errors,
		}: {
			done: number;
			total: number;
			errors: number;
		}) {
			process.stderr.write(
				`${tty ? "\r" : ""}${done}/${total} 已完成, ${errors} 个错误\n`,
			);
		},
	};
}

async function runCommand(args: string[]): Promise<number> {
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
			"cassettes-dir": { type: "string" },
			region: { type: "string" },
			resume: { type: "string" },
		},
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	const { config, root } = await loadConfig(values.config);
	const runsDir = runsDirOf(config, root, values["runs-dir"]);
	const scenariosDir = resolve(root, config.scenariosDir);
	const cassettes = new CassetteStore(
		values["cassettes-dir"] === undefined
			? resolve(root, config.cassettesDir)
			: resolve(values["cassettes-dir"]),
	);
	const env = process.env;

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
			throw new UsageError(`运行 ${runId} 已完成`);
		startedAt = progress.startedAt;
		plan = progress.plan;
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
			...(values.region ? { region: values.region } : {}),
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
	const controller = new AbortController();
	const onInterrupt = () => {
		if (controller.signal.aborted) process.exit(130);
		process.stderr.write("\n正在中断, 等待在途请求结束; 再按一次立即退出\n");
		controller.abort();
	};
	process.on("SIGINT", onInterrupt);
	const printer = progressPrinter();
	let last = { done: 0, total: 0, errors: 0 };
	const result = await executeRun({
		runId,
		runDir,
		startedAt,
		plan,
		scenarios,
		subjects,
		cassettes,
		signal: controller.signal,
		onProgress: (progress) => {
			last = progress;
			printer.update(progress);
		},
	}).finally(() => process.off("SIGINT", onInterrupt));
	printer.end(last);
	if (result.configMismatch.length > 0) {
		process.stderr.write(
			`注意: ${result.configMismatch.join(", ")} 的录制所用配置与当前配置不同, 回放结果按录制时的请求得出\n`,
		);
	}
	if (result.interrupted) {
		process.stderr.write(`已中断. 续跑: seekbench run --resume ${runId}\n`);
		return 130;
	}

	const run: Run = {
		id: runId,
		startedAt,
		finishedAt: new Date().toISOString(),
		mode: plan.mode,
		...(plan.region !== undefined && { region: plan.region }),
		settings: plan.settings,
		scenarios: plan.scenarios.map(({ casesHash: _, ...scenario }) => scenario),
		subjects: plan.subjects.map(({ config: _, ...subject }) => {
			const cassetteDate = oldestRecording(result.records, subject.id);
			return cassetteDate ? { ...subject, cassetteDate } : subject;
		}),
		judge: null,
		summary: summarize(
			result.records,
			scenarios,
			plan.subjects.map((subject) => subject.id),
		),
	};
	await writeFile(
		join(runDir, "run.json"),
		`${JSON.stringify(run, null, 2)}\n`,
	);
	console.log(`\n${renderTable(run)}\n`);
	console.log(`运行记录: ${join(runDir, "run.json")}`);
	console.log(`生成报告: seekbench report ${runId}`);
	return 0;
}

/** 被测对象用到的最早录制日期, 没有录制时为 null. */
function oldestRecording(
	records: readonly CaseRecord[],
	subject: string,
): string | null {
	let oldest: string | null = null;
	for (const record of records) {
		if (record.subject !== subject || record.recordedAt === undefined) continue;
		if (oldest === null || record.recordedAt < oldest)
			oldest = record.recordedAt;
	}
	return oldest?.slice(0, 10) ?? null;
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

async function reportCommand(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: COMMON_OPTIONS,
		allowPositionals: true,
	});
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	let runsDir: string;
	if (values["runs-dir"] !== undefined) runsDir = resolve(values["runs-dir"]);
	else if (existsSync(values.config)) {
		const { config, root } = await loadConfig(values.config);
		runsDir = runsDirOf(config, root, undefined);
	} else runsDir = resolve("runs");
	const runId = positionals[0] ?? (await latestRun(runsDir));
	const file = join(runsDir, runId, "run.json");
	if (!existsSync(file)) throw new UsageError(`找不到 ${file}`);
	const parsed = Run.safeParse(JSON.parse(await readFile(file, "utf8")));
	if (!parsed.success)
		throw new Error(`${file} 格式不符:\n${z.prettifyError(parsed.error)}`);
	const output = join(runsDir, runId, "report.md");
	await writeFile(output, renderReport(parsed.data));
	console.log(output);
	return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
	const [command, ...args] = argv;
	try {
		switch (command) {
			case "run":
				return await runCommand(args);
			case "report":
				return await reportCommand(args);
			case undefined:
			case "help":
			case "-h":
			case "--help":
				console.log(HELP);
				return 0;
			default:
				throw new UsageError(`未知命令: ${command}`);
		}
	} catch (error) {
		if (
			error instanceof UsageError ||
			(error instanceof TypeError && "code" in error)
		) {
			console.error(`${error.message}\n\n${HELP}`);
			return 2;
		}
		console.error(error instanceof Error ? error.message : error);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
