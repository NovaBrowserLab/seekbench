import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Run } from "../src/core/types.ts";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

/** 用 Node 直接运行 CLI 源码, 同时验证代码能被原生类型擦除执行. */
function seekbench(args: readonly string[]) {
	return execFileAsync(
		process.execPath,
		[join(root, "src/cli/index.ts"), ...args],
		{ cwd: root },
	);
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
