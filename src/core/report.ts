import { bootstrapMean, seedFrom } from "./bootstrap.ts";
import {
	mean,
	percentile,
	type QualityValues,
	qualityMetrics,
} from "./metrics.ts";
import type { LoadedScenario } from "./scenarios.ts";
import {
	type Case,
	type CaseRecord,
	type Estimate,
	type Intent,
	QualityMetric,
	type Run,
	type RunScenario,
	type ScenarioSummary,
} from "./types.ts";

/** 每类意图在报告里优先展示的指标. */
export const PRIMARY_METRICS: Record<Intent, readonly QualityMetric[]> = {
	navigational: ["hit1", "hit3", "risk"],
	informational: ["ndcg", "coverage"],
	descriptive: ["ndcg", "p5"],
	fresh: ["fresh", "ndcg"],
	ambiguous: ["meaningCoverage", "ndcg"],
	research: ["coverage", "diversity", "ndcg"],
	longtail: ["mrr"],
};

export function metricLabel(metric: QualityMetric, k: number): string {
	const labels: Record<QualityMetric, string> = {
		hit1: "Hit@1",
		hit3: "Hit@3",
		hitK: `Hit@${k}`,
		mrr: "MRR",
		ndcg: `nDCG@${k}`,
		p5: "P@5",
		coverage: "覆盖率",
		meaningCoverage: "含义覆盖",
		risk: "风险率",
		fresh: "时效率",
		freshUnknown: "时效未知率",
		diversity: "域名多样性",
	};
	return labels[metric];
}

function groupBy<T>(
	items: readonly T[],
	key: (item: T) => string,
): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const id = key(item);
		const group = groups.get(id);
		if (group) group.push(item);
		else groups.set(id, [item]);
	}
	return groups;
}

/** 同一用例多次重复的指标取均值, 不适用的指标保持 null. */
function averageReps(values: readonly QualityValues[]): QualityValues {
	const out = {} as QualityValues;
	for (const metric of QualityMetric.options) {
		const present = values
			.map((value) => value[metric])
			.filter((value) => value !== null);
		out[metric] = mean(present);
	}
	return out;
}

/** 用例在全部被测对象结果池中的等级, 同一规范化 URL 取最高等级; 池中没有已判定结果时为 null. */
function pooledGrades(records: readonly CaseRecord[]): number[] | null {
	const best = new Map<string, number>();
	for (const record of records) {
		for (const hit of record.hits) {
			if (hit.grade === null) continue;
			best.set(
				hit.normalizedUrl,
				Math.max(best.get(hit.normalizedUrl) ?? 0, hit.grade),
			);
		}
	}
	return best.size > 0 ? [...best.values()] : null;
}

function summarizeGroup(
	scenario: LoadedScenario["scenario"],
	subject: string,
	tier: ScenarioSummary["tier"],
	cases: readonly Case[],
	perCase: ReadonlyMap<string, QualityValues>,
	records: readonly CaseRecord[],
): ScenarioSummary {
	const quality = {} as Record<QualityMetric, Estimate | null>;
	for (const metric of QualityMetric.options) {
		const values = cases
			.map((kase) => perCase.get(kase.id)?.[metric] ?? null)
			.filter((value) => value !== null);
		quality[metric] = bootstrapMean(values, {
			seed: seedFrom(`${scenario.id}|${subject}|${tier}|${metric}`),
		});
	}
	const successes = records.filter((record) => record.error === null);
	const hits = successes.flatMap((record) => record.hits);
	const rawCount = successes.reduce((sum, record) => sum + record.rawCount, 0);
	const duplicates = successes.reduce(
		(sum, record) => sum + record.duplicates,
		0,
	);
	const latencies = successes.map((record) => record.latencyMs);
	const rate = (count: number, total: number) =>
		total === 0 ? null : count / total;
	return {
		scenario: scenario.id,
		version: scenario.version,
		subject,
		tier,
		cases: cases.length,
		executions: records.length,
		quality,
		judgedRate: rate(
			hits.filter((hit) => hit.grade !== null).length,
			hits.length,
		),
		robustness: {
			errorRate: rate(records.length - successes.length, records.length) ?? 0,
			timeoutRate:
				rate(
					records.filter((record) => record.error?.kind === "timeout").length,
					records.length,
				) ?? 0,
			emptyRate: rate(
				successes.filter((record) => record.hits.length === 0).length,
				successes.length,
			),
			duplicateRate: rate(duplicates, rawCount),
		},
		latency:
			latencies.length === 0
				? null
				: {
						p50: percentile(latencies, 50) as number,
						p90: percentile(latencies, 90) as number,
						p99: percentile(latencies, 99) as number,
						max: Math.max(...latencies),
					},
		cost: {
			per1k:
				(records.reduce((sum, record) => sum + record.cost, 0) /
					records.length) *
				1000,
			callsMean: mean(records.map((record) => record.calls)) ?? 0,
		},
	};
}

/**
 * 按场景 × 被测对象 × 层聚合. 逐条用例先对重复取均值, 再对用例做 bootstrap 置信区间.
 * 出错的执行按空结果计入质量指标, 错误率另行报告. 场景内有多个层时额外给出 all 一行.
 */
export function summarize(
	records: readonly CaseRecord[],
	scenarios: readonly LoadedScenario[],
	subjects: readonly string[],
): ScenarioSummary[] {
	const summary: ScenarioSummary[] = [];
	const byScenario = groupBy(records, (record) => record.scenario);
	for (const { scenario, cases } of scenarios) {
		const scenarioRecords = byScenario.get(scenario.id) ?? [];
		const byCase = groupBy(scenarioRecords, (record) => record.caseId);
		const ideal = new Map<string, number[] | null>();
		const labeled = new Map<string, boolean>();
		for (const [caseId, caseRecords] of byCase) {
			ideal.set(caseId, pooledGrades(caseRecords));
			labeled.set(
				caseId,
				caseRecords.some((record) =>
					record.hits.some((hit) => hit.meaning !== null),
				),
			);
		}
		const bySubject = groupBy(scenarioRecords, (record) => record.subject);
		for (const subject of subjects) {
			const subjectRecords = bySubject.get(subject);
			if (!subjectRecords) continue;
			const recordsByCase = groupBy(subjectRecords, (record) => record.caseId);
			const perCase = new Map<string, QualityValues>();
			for (const kase of cases) {
				const reps = recordsByCase.get(kase.id);
				if (!reps) continue;
				perCase.set(
					kase.id,
					averageReps(
						reps.map((record) =>
							qualityMetrics(
								record.error === null ? record.hits : [],
								kase,
								scenario.k,
								ideal.get(kase.id) ?? null,
								labeled.get(kase.id) ?? false,
							),
						),
					),
				);
			}
			const covered = cases.filter((kase) => perCase.has(kase.id));
			const tiers = [...new Set(covered.map((kase) => kase.tier))].sort();
			const groups: Array<[ScenarioSummary["tier"], Case[]]> = tiers.map(
				(tier) => [tier, covered.filter((kase) => kase.tier === tier)],
			);
			if (tiers.length > 1) groups.push(["all", covered]);
			for (const [tier, group] of groups) {
				const ids = new Set(group.map((kase) => kase.id));
				summary.push(
					summarizeGroup(
						scenario,
						subject,
						tier,
						group,
						perCase,
						subjectRecords.filter((record) => ids.has(record.caseId)),
					),
				);
			}
		}
	}
	return summary;
}

function formatNumber(value: number): string {
	return value.toFixed(2);
}

function formatEstimate(estimate: Estimate | null): string {
	if (estimate === null) return "—";
	return `${formatNumber(estimate.mean)} [${formatNumber(estimate.low)}, ${formatNumber(estimate.high)}]`;
}

function formatRate(value: number | null): string {
	return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | undefined): string {
	return value === undefined ? "—" : `${Math.round(value)} ms`;
}

function formatCost(value: number): string {
	return `$${value.toFixed(2)}`;
}

interface Table {
	header: string[];
	rows: string[][];
}

function scenarioTable(
	scenario: RunScenario,
	rows: readonly ScenarioSummary[],
): Table {
	const metrics = PRIMARY_METRICS[scenario.intent];
	return {
		header: [
			"被测对象",
			"层",
			"用例",
			...metrics.map((metric) => metricLabel(metric, scenario.k)),
			"判定率",
			"错误率",
			"空结果率",
			"p50",
			"p90",
			"每千次费用",
			"调用倍数",
		],
		rows: rows.map((row) => [
			row.subject,
			row.tier,
			String(row.cases),
			...metrics.map((metric) => formatEstimate(row.quality[metric])),
			formatRate(row.judgedRate),
			formatRate(row.robustness.errorRate),
			formatRate(row.robustness.emptyRate),
			formatMs(row.latency?.p50),
			formatMs(row.latency?.p90),
			formatCost(row.cost.per1k),
			formatNumber(row.cost.callsMean),
		]),
	};
}

function detailTable(
	scenario: RunScenario,
	rows: readonly ScenarioSummary[],
): Table {
	return {
		header: [
			"被测对象",
			"层",
			...QualityMetric.options.map((metric) => metricLabel(metric, scenario.k)),
			"超时率",
			"重复 URL 率",
			"p99",
			"最大耗时",
		],
		rows: rows.map((row) => [
			row.subject,
			row.tier,
			...QualityMetric.options.map((metric) =>
				formatEstimate(row.quality[metric]),
			),
			formatRate(row.robustness.timeoutRate),
			formatRate(row.robustness.duplicateRate),
			formatMs(row.latency?.p99),
			formatMs(row.latency?.max),
		]),
	};
}

function markdownTable(table: Table): string {
	const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
	return [
		line(table.header),
		line(table.header.map(() => "---")),
		...table.rows.map(line),
	].join("\n");
}

/** 终端显示宽度, 全角字符按 2 计. */
function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1;
	}
	return width;
}

function textTable(table: Table): string {
	const widths = table.header.map((cell, column) =>
		Math.max(
			displayWidth(cell),
			...table.rows.map((row) => displayWidth(row[column] ?? "")),
		),
	);
	const line = (cells: readonly string[]) =>
		cells
			.map(
				(cell, column) =>
					cell + " ".repeat((widths[column] ?? 0) - displayWidth(cell)),
			)
			.join("  ")
			.trimEnd();
	return [line(table.header), ...table.rows.map(line)].join("\n");
}

function scenarioHeading(scenario: RunScenario): string {
	return `${scenario.id}@${scenario.version}  ${scenario.intent} · ${scenario.lang} · k=${scenario.k} · ${scenario.cases} 条用例`;
}

/** 运行结束时打印到终端的汇总表, 每个场景只列主要指标. */
export function renderTable(run: Run): string {
	return run.scenarios
		.map((scenario) => {
			const rows = run.summary.filter((row) => row.scenario === scenario.id);
			return `${scenarioHeading(scenario)}\n${textTable(scenarioTable(scenario, rows))}`;
		})
		.join("\n\n");
}

/** 录制超过这么多天, 报告里醒目提示; 时效类场景尤其不能据此选型. */
const STALE_CASSETTE_DAYS = 30;

function isStale(cassetteDate: string, runStartedAt: string): boolean {
	return (
		Date.parse(runStartedAt) - Date.parse(cassetteDate) >
		STALE_CASSETTE_DAYS * 86_400_000
	);
}

/** 一次运行的 Markdown 报告, 读者只看这一个文件就够. */
export function renderReport(run: Run): string {
	const judge = run.judge
		? `${run.judge.model} (rubric ${run.judge.rubricVersion}${run.judge.fetch ? ", 抓取正文" : ""})`
		: "未启用, 只有规则打分";
	const filters = [
		run.settings.filters.tier ? `层 ${run.settings.filters.tier}` : null,
		run.settings.filters.source ? `来源 ${run.settings.filters.source}*` : null,
		run.settings.filters.limit
			? `每场景前 ${run.settings.filters.limit} 条`
			: null,
	].filter((item) => item !== null);
	const meta: Table = {
		header: ["项目", "值"],
		rows: [
			["模式", run.mode],
			["开始", run.startedAt],
			["结束", run.finishedAt],
			["区域", run.region ?? "未标注"],
			["重复次数", String(run.settings.reps)],
			["单次超时", `${run.settings.timeoutMs} ms`],
			["全局并发", String(run.settings.concurrency)],
			["用例过滤", filters.length > 0 ? filters.join(", ") : "无"],
			["裁判", judge],
			[
				"被测对象",
				run.subjects
					.map(
						(subject) =>
							`${subject.id} (${subject.kind}, 配置 ${subject.configHash}${subject.cassetteDate ? `, 录制于 ${subject.cassetteDate}${isStale(subject.cassetteDate, run.startedAt) ? " **⚠ 已超过 30 天**" : ""}` : ""})`,
					)
					.join("<br>"),
			],
		],
	};
	const sections = run.scenarios.map((scenario) => {
		const rows = run.summary.filter((row) => row.scenario === scenario.id);
		return [
			`## ${scenario.id}@${scenario.version}`,
			"",
			`${scenario.description}`,
			"",
			`意图 ${scenario.intent}, 语言 ${scenario.lang}, k = ${scenario.k}, ${scenario.cases} 条用例.`,
			"",
			markdownTable(scenarioTable(scenario, rows)),
			"",
			"<details>",
			"<summary>全部指标</summary>",
			"",
			markdownTable(detailTable(scenario, rows)),
			"",
			"</details>",
		].join("\n");
	});
	return [
		`# seekbench 运行报告 ${run.id}`,
		"",
		markdownTable(meta),
		"",
		"指标后的方括号为对用例 bootstrap 重采样 1000 次的 95% 置信区间, — 表示不适用. 未判定的结果在依赖等级的指标里按 0 计, 判定率单独列出; nDCG 的理想排序取本次运行所有被测对象的结果池. 时延只在 live 模式有意义.",
		"",
		...sections.flatMap((section) => [section, ""]),
	].join("\n");
}
