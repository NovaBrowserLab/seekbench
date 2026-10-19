import { percentile } from "../core/metrics.ts";
import type { Table } from "../core/report.ts";
import type { LoadedScenario } from "../core/scenarios.ts";
import type { Case } from "../core/types.ts";
import { charLength } from "./text.ts";

export interface ScenarioStats {
	scenario: string;
	version: string;
	intent: string;
	lang: string;
	cases: number;
	tiers: { A: number; B: number };
	/** 按来源类别: handwritten、synth、public、log. */
	sources: Record<string, number>;
	/** 按查询本身是否含汉字. */
	langs: { zh: number; en: number };
	/** 查询的字符数分布. */
	length: { p50: number; p90: number; max: number } | null;
}

function sourceKind(kase: Case): string {
	return kase.source.split(":")[0] ?? kase.source;
}

function statsOf(
	id: string,
	version: string,
	intent: string,
	lang: string,
	cases: readonly Case[],
): ScenarioStats {
	const lengths = cases.map((kase) => charLength(kase.query));
	const sources: Record<string, number> = {};
	for (const kase of cases) {
		const kind = sourceKind(kase);
		sources[kind] = (sources[kind] ?? 0) + 1;
	}
	const zh = cases.filter((kase) => /\p{Script=Han}/u.test(kase.query)).length;
	return {
		scenario: id,
		version,
		intent,
		lang,
		cases: cases.length,
		tiers: {
			A: cases.filter((kase) => kase.tier === "A").length,
			B: cases.filter((kase) => kase.tier === "B").length,
		},
		sources,
		langs: { zh, en: cases.length - zh },
		length:
			lengths.length === 0
				? null
				: {
						p50: percentile(lengths, 50) as number,
						p90: percentile(lengths, 90) as number,
						max: Math.max(...lengths),
					},
	};
}

/** 按场景统计用例数量、层、来源、语言与查询长度, 最后一行为合计. */
export function datasetStats(
	scenarios: readonly LoadedScenario[],
): ScenarioStats[] {
	const rows = scenarios.map(({ scenario, cases }) =>
		statsOf(
			scenario.id,
			scenario.version,
			scenario.intent,
			scenario.lang,
			cases,
		),
	);
	rows.push(
		statsOf(
			"合计",
			"",
			"",
			"",
			scenarios.flatMap(({ cases }) => cases),
		),
	);
	return rows;
}

const SOURCE_KINDS = ["handwritten", "synth", "log", "public"] as const;

export function statsTable(rows: readonly ScenarioStats[]): Table {
	return {
		header: [
			"场景",
			"版本",
			"意图",
			"语言",
			"用例",
			"A 层",
			"B 层",
			...SOURCE_KINDS,
			"中文查询",
			"英文查询",
			"长度 p50",
			"长度 p90",
			"最长",
		],
		rows: rows.map((row) => [
			row.scenario,
			row.version,
			row.intent,
			row.lang,
			String(row.cases),
			String(row.tiers.A),
			String(row.tiers.B),
			...SOURCE_KINDS.map((kind) => String(row.sources[kind] ?? 0)),
			String(row.langs.zh),
			String(row.langs.en),
			row.length ? String(Math.round(row.length.p50)) : "—",
			row.length ? String(Math.round(row.length.p90)) : "—",
			row.length ? String(row.length.max) : "—",
		]),
	};
}
