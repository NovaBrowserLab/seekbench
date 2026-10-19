import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CassetteStore, cassetteKey } from "../src/core/cassette.ts";
import { loadConfig, stableHash } from "../src/core/config.ts";
import { parseJsonl, toJsonl } from "../src/core/jsonl.ts";
import { readArchive } from "../src/core/runner.ts";
import { loadScenario } from "../src/core/scenarios.ts";
import { Run } from "../src/core/types.ts";
import { AuditItem, Label } from "../src/judge/audit.ts";
import { type CachedJudgment, JudgmentCache } from "../src/judge/cache.ts";
import { judgeCaseOf } from "../src/judge/judge-run.ts";
import { judgmentKey, rubricHash } from "../src/judge/rubric.ts";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

/** 去掉供应商密钥的环境, 保证测试不联网. */
const keylessEnv = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => !name.endsWith("_API_KEY")),
);

/** 用 Node 直接运行 CLI 源码, 同时验证代码能被原生类型擦除执行. */
function seekbench(args: readonly string[]) {
	return execFileAsync(
		process.execPath,
		[join(root, "src/cli/index.ts"), ...args],
		{ cwd: root, env: keylessEnv },
	);
}

const PROVIDERS = ["bocha", "brave", "deepseek", "exa", "tavily"] as const;

/** 用录制的真实响应 (test/fixtures/adapters/) 搭一份 nav-zh 第一条用例的录制. */
async function fixtureCassettes(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "seekbench-cassettes-"));
	const store = new CassetteStore(dir);
	const { config } = await loadConfig(join(root, "seekbench.config.ts"));
	for (const id of PROVIDERS) {
		const fixture = JSON.parse(
			await readFile(
				join(root, "test/fixtures/adapters", `${id}.json`),
				"utf8",
			),
		);
		await store.put(
			{ subject: id, scenario: "nav-zh", version: "1" },
			{
				key: cassetteKey(id, fixture.query, fixture.request),
				subject: id,
				query: fixture.query,
				request: fixture.request,
				configHash: stableHash(config.subjects[id]),
				recordedAt: fixture.recordedAt,
				latencyMs: 100,
				response: {
					hits: [],
					totalEstimate: null,
					raw: fixture.raw,
					cost: 0,
					calls: 1,
				},
			},
		);
	}
	return dir;
}

describe("CLI", () => {
	it("mock 被测对象跑通 smoke 场景, 汇总与手算一致, report 生成报告", async () => {
		const runsDir = await mkdtemp(join(tmpdir(), "seekbench-cli-"));
		const { stdout } = await seekbench([
			"run",
			"--scenarios",
			"smoke",
			"--subjects",
			"mock",
			"--reps",
			"2",
			"--runs-dir",
			runsDir,
			"--no-judge",
		]);
		expect(stdout).toContain("smoke@1");

		const [runId] = await readdir(runsDir);
		if (runId === undefined) throw new Error("没有生成运行目录");
		const run = Run.parse(
			JSON.parse(await readFile(join(runsDir, runId, "run.json"), "utf8")),
		);
		expect(run.judge).toBeNull();
		expect(run.subjects.map((subject) => subject.id)).toEqual(["mock"]);
		expect(run.summary).toHaveLength(1);
		const [row] = run.summary;
		if (row === undefined) throw new Error("没有汇总");
		expect(row.tier).toBe("A");
		expect(row.cases).toBe(6);
		expect(row.executions).toBe(12);

		/** 各值的推算见 test/fixtures/smoke.mock.json 与 smoke 场景的 gold. */
		const means = Object.fromEntries(
			Object.entries(row.quality).map(([metric, estimate]) => [
				metric,
				estimate === null ? null : estimate.mean,
			]),
		);
		const ndcg12306 = 1 / Math.log2(3);
		expect(means.hit1).toBe(0.5);
		expect(means.hit3).toBe(1);
		expect(means.mrr).toBeCloseTo(0.6, 12);
		expect(means.ndcg).toBeCloseTo((2 + 2 * ndcg12306) / 4, 12);
		expect(means.p5).toBeCloseTo(0.16, 12);
		expect(means.coverage).toBeCloseTo(8 / 9, 12);
		expect(means.risk).toBeCloseTo(1 / 3, 12);
		expect(means.fresh).toBe(0);
		expect(means.freshUnknown).toBe(0.5);
		expect(means.diversity).toBeCloseTo(1.4 / 6, 12);
		expect(means.meaningCoverage).toBeNull();
		expect(row.quality.hit1?.n).toBe(4);
		expect(row.quality.mrr?.n).toBe(5);
		expect(row.judgedRate).toBeCloseTo(7 / 15, 12);
		expect(row.robustness.duplicateRate).toBeCloseTo(1 / 16, 12);
		expect(row.robustness.errorRate).toBe(0);
		expect(row.robustness.emptyRate).toBe(0);
		expect(row.latency?.p50).toBeGreaterThanOrEqual(15);

		const report = await seekbench(["report", runId, "--runs-dir", runsDir]);
		const output = report.stdout.trim();
		expect(output).toBe(join(runsDir, runId, "report.md"));
		const markdown = await readFile(output, "utf8");
		expect(markdown).toContain(`# seekbench 运行报告 ${runId}`);
		expect(markdown).toContain("| mock | A | 6 | 0.50 [");
	});

	it("replay 不需要密钥, 从录制的原始响应跑出五家导航对比", async () => {
		const runsDir = await mkdtemp(join(tmpdir(), "seekbench-cli-"));
		const { stdout, stderr } = await seekbench([
			"run",
			"--scenarios",
			"nav-zh",
			"--subjects",
			PROVIDERS.join(","),
			"--mode",
			"replay",
			"--limit",
			"1",
			"--runs-dir",
			runsDir,
			"--cassettes-dir",
			await fixtureCassettes(),
			"--no-judge",
		]);
		expect(stderr).not.toContain("注意");
		const [runId] = await readdir(runsDir);
		if (runId === undefined) throw new Error("没有生成运行目录");
		const run = Run.parse(
			JSON.parse(await readFile(join(runsDir, runId, "run.json"), "utf8")),
		);
		expect(run.mode).toBe("replay");
		expect(run.settings.filters.limit).toBe(1);
		expect(run.subjects.map((subject) => subject.cassetteDate)).toEqual(
			PROVIDERS.map(() => "2026-10-19"),
		);
		const hit1 = Object.fromEntries(
			run.summary.map((row) => [row.subject, row.quality.hit1?.mean]),
		);
		expect(hit1).toEqual({
			bocha: 0,
			brave: 1,
			deepseek: 1,
			exa: 1,
			tavily: 0,
		});
		for (const row of run.summary) {
			expect(row.robustness.errorRate).toBe(0);
			expect(row.latency?.p50).toBe(100);
		}
		for (const id of PROVIDERS) expect(stdout).toContain(id);
	});

	it("live 模式跳过缺密钥的被测对象, 全部缺失时报参数错误", async () => {
		const error = await seekbench([
			"run",
			"--scenarios",
			"nav-zh",
			"--subjects",
			"brave,exa",
		]).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 2 });
		const { stderr } = error as { stderr: string };
		expect(stderr).toContain("跳过 brave: 缺少环境变量 BRAVE_API_KEY");
		expect(stderr).toContain("没有可运行的被测对象");
	});

	it("录制与回放不接受 --reps, --refresh 只用于 record", async () => {
		await expect(
			seekbench([
				"run",
				"--scenarios",
				"smoke",
				"--mode",
				"replay",
				"--reps",
				"2",
			]),
		).rejects.toMatchObject({ code: 2 });
		await expect(
			seekbench([
				"run",
				"--scenarios",
				"smoke",
				"--mode",
				"replay",
				"--refresh",
			]),
		).rejects.toMatchObject({ code: 2 });
	});

	it("参数错误时退出码为 2", async () => {
		await expect(seekbench(["run"])).rejects.toMatchObject({ code: 2 });
		await expect(
			seekbench(["run", "--scenarios", "smoke", "--bogus"]),
		).rejects.toMatchObject({
			code: 2,
		});
		await expect(seekbench(["frobnicate"])).rejects.toMatchObject({ code: 2 });
	});

	it("没有命令时打印帮助", async () => {
		const { stdout } = await seekbench([]);
		expect(stdout).toContain("seekbench run --scenarios");
	});

	it("裁判只用缓存时完成打分, 抽样复核与校准走通", async () => {
		const dir = await mkdtemp(join(tmpdir(), "seekbench-judge-"));
		const config = join(dir, "seekbench.config.ts");
		await writeFile(
			config,
			`export default ${JSON.stringify({
				scenariosDir: join(root, "datasets/scenarios"),
				subjects: {
					mock: {
						use: "mock",
						hitsFile: join(root, "test/fixtures/smoke.mock.json"),
					},
				},
				judge: {
					baseUrl: "https://judge.invalid",
					model: "test-judge",
					apiKeyEnv: "SEEKBENCH_TEST_JUDGE_KEY",
				},
			})};\n`,
		);
		await seekbench([
			"run",
			"--config",
			config,
			"--scenarios",
			"smoke",
			"--no-judge",
		]);
		const [runId] = await readdir(join(dir, "runs"));
		if (runId === undefined) throw new Error("没有生成运行目录");
		const runDir = join(dir, "runs", runId);

		/** 预先写好裁判缓存: 等级取 URL 长度模 4, 歧义用例标含义 0. */
		const { scenario, cases } = await loadScenario(
			join(root, "datasets/scenarios"),
			"smoke",
		);
		const cache = new JudgmentCache(join(dir, "judgments"), "test-judge");
		const shard = { scenario: "smoke", rubric: rubricHash(scenario, false) };
		const judgments = new Map<string, CachedJudgment>();
		for (const record of await readArchive(runDir)) {
			const kase = cases.find((item) => item.id === record.caseId);
			if (!kase) continue;
			for (const hit of record.hits) {
				if (hit.grade !== null) continue;
				judgments.set(judgmentKey(judgeCaseOf(kase), hit, false), {
					reason: "r",
					grade: hit.url.length % 4,
					sourceTier: "reputable",
					stale: "fresh",
					...(kase.gold?.meanings && { meaning: "0" as const }),
				});
			}
		}
		await cache.put(shard, judgments);

		const judged = await seekbench(["judge", "--config", config]);
		expect(judged.stderr).toContain(`缓存命中 ${judgments.size}`);
		const run = Run.parse(
			JSON.parse(await readFile(join(runDir, "run.json"), "utf8")),
		);
		expect(run.judge).toMatchObject({
			model: "test-judge",
			usage: { cached: judgments.size, failed: 0 },
		});
		expect(run.summary[0]?.judgedRate).toBe(1);
		expect(run.summary[0]?.quality.meaningCoverage).not.toBeNull();

		await seekbench(["judge:sample", "--config", config, "--size", "4"]);
		const auditPath = join(runDir, "audit.jsonl");
		const items = parseJsonl(
			await readFile(auditPath, "utf8"),
			AuditItem,
			auditPath,
		);
		expect(items).toHaveLength(4);
		await writeFile(
			auditPath,
			toJsonl(
				items.map((item) => ({
					...item,
					grade: judgments.get(item.id)?.grade ?? null,
				})),
			),
		);
		await expect(
			seekbench(["judge:sample", "--config", config]),
		).rejects.toMatchObject({ code: 2 });

		const audited = await seekbench(["judge:audit", "--config", config]);
		expect(audited.stdout).toContain("一致率 100.0%");
		const after = Run.parse(
			JSON.parse(await readFile(join(runDir, "run.json"), "utf8")),
		);
		expect(after.judge?.audit).toMatchObject({ n: 4, exact: 1 });
		const labelsPath = join(dir, "datasets/calibration/labels.jsonl");
		expect(
			parseJsonl(await readFile(labelsPath, "utf8"), Label, labelsPath),
		).toHaveLength(4);

		const report = await seekbench(["report", "--config", config]);
		expect(await readFile(report.stdout.trim(), "utf8")).toContain(
			"| 人工复核 | 4 条, 一致率 100.0%",
		);

		const calibrated = await seekbench([
			"judge:calibrate",
			"--config",
			config,
		]).catch((error: { code: number; stdout: string }) => error);
		expect(calibrated.stdout).toContain("test-judge: 4 条, 一致率 100.0%");
	});
});
