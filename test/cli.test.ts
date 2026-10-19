import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CassetteStore, cassetteKey } from "../src/core/cassette.ts";
import { loadConfig, stableHash } from "../src/core/config.ts";
import { Run } from "../src/core/types.ts";

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

	it("录制与回放不接受 --reps", async () => {
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
});
