import { normalizeUrl, parsePattern } from "../core/normalize.ts";
import { type LoadedScenario, maxGradeOf } from "../core/scenarios.ts";
import type {
	Agreement,
	Case,
	CaseRecord,
	RunJudge,
	Scenario,
} from "../core/types.ts";
import { agreement, confusionMatrix, type GradePair } from "./agreement.ts";
import type { Label } from "./audit.ts";
import {
	type JudgeGroup,
	type ResolveOptions,
	resolveJudgments,
} from "./judge-run.ts";
import { type JudgeCase, type JudgeItem, judgmentKey } from "./rubric.ts";

export interface CalibrationResult {
	overall: Agreement;
	/** 按场景, 再按标注来源 (audit、rule、handwritten…) 的一致程度. */
	byScenario: Array<{ scenario: string; agreement: Agreement }>;
	bySource: Array<{ source: string; agreement: Agreement }>;
	/** 行为人工等级, 列为裁判等级. */
	matrix: number[][];
	maxGrade: number;
	/** 场景已不存在而跳过的标注数. */
	skipped: number;
	/** 裁判没有给出等级的标注数. */
	unjudged: number;
	usage: NonNullable<RunJudge["usage"]>;
	errors: string[];
}

/** 来源的类别, 去掉批次后缀: audit:2026-10-19-abc 归为 audit. */
function sourceKind(source: string): string {
	return source.split(":")[0] ?? source;
}

/**
 * 用校准集评估裁判: 对每条标注跑裁判 (先查缓存), 与人工等级比较, 报告一致率与二次加权 Kappa.
 * 标注自带查询、意图与结果内容, 不依赖当前题库; 场景只用来取 rubric.
 */
export async function calibrate(
	labels: readonly Label[],
	scenarios: ReadonlyMap<string, Scenario>,
	options: ResolveOptions,
): Promise<CalibrationResult> {
	const groups = new Map<
		string,
		{ scenario: Scenario; kase: JudgeCase; items: Map<string, JudgeItem> }
	>();
	const keyed: Array<{ label: Label; key: string }> = [];
	let skipped = 0;
	for (const label of labels) {
		const scenario = scenarios.get(label.scenario);
		if (!scenario) {
			skipped++;
			continue;
		}
		const kase: JudgeCase = {
			query: label.query,
			note: label.note,
			meanings: label.meanings,
		};
		const id = JSON.stringify([
			label.scenario,
			label.query,
			label.note ?? null,
			label.meanings ?? null,
		]);
		let group = groups.get(id);
		if (!group) {
			group = { scenario, kase, items: new Map() };
			groups.set(id, group);
		}
		const key = judgmentKey(
			kase,
			{
				normalizedUrl: normalizeUrl(label.url) ?? label.url,
				title: label.title,
				snippet: label.snippet,
				publishedAt: label.publishedAt,
			},
			options.fetch,
		);
		keyed.push({ label, key });
		group.items.set(key, {
			key,
			url: label.url,
			title: label.title,
			snippet: label.snippet,
			publishedAt: label.publishedAt,
		});
	}
	const jobs: JudgeGroup[] = [...groups.values()].map((group) => ({
		...group,
		items: [...group.items.values()],
	}));
	const { judgments, usage, errors } = await resolveJudgments(jobs, options);

	const maxGrade = Math.max(
		3,
		...[...groups.values()].map(({ scenario }) => maxGradeOf(scenario)),
	);
	const all: GradePair[] = [];
	const byScenario = new Map<string, GradePair[]>();
	const bySource = new Map<string, GradePair[]>();
	let unjudged = 0;
	for (const { label, key } of keyed) {
		const judgment = judgments.get(key);
		if (!judgment) {
			unjudged++;
			continue;
		}
		const pair: GradePair = [label.grade, judgment.grade];
		all.push(pair);
		const push = (map: Map<string, GradePair[]>, id: string) => {
			const list = map.get(id) ?? [];
			list.push(pair);
			map.set(id, list);
		};
		push(byScenario, label.scenario);
		push(bySource, sourceKind(label.source));
	}
	const rows = (map: Map<string, GradePair[]>) =>
		[...map.keys()]
			.sort()
			.map((id) => ({ id, agreement: agreement(map.get(id) ?? [], maxGrade) }));
	return {
		overall: agreement(all, maxGrade),
		byScenario: rows(byScenario).map(({ id, agreement }) => ({
			scenario: id,
			agreement,
		})),
		bySource: rows(bySource).map(({ id, agreement }) => ({
			source: id,
			agreement,
		})),
		matrix: confusionMatrix(all, maxGrade),
		maxGrade,
		skipped,
		unjudged,
		usage,
		errors,
	};
}

/** 命中的是 gold 目标本身 (域名的首页, 或带路径目标的那一页), 而不只是目标站点下的某页. */
function isExactTarget(
	normalizedUrl: string,
	targets: readonly string[],
): boolean {
	const url = new URL(normalizedUrl);
	return targets.some((target) => {
		const pattern = parsePattern(target);
		if (pattern === null || url.hostname !== pattern.host) return false;
		return pattern.path === ""
			? url.pathname === "/"
			: url.pathname === pattern.path;
	});
}

/**
 * 从一次运行的 A 层规则判定里取校准标注: 命中风险域名记 0, 命中目标本身记满分.
 * 只取这两种确定的判断; 目标站点下的其他页面按 rubric 可能只值 2, 不取.
 */
export function ruleLabels(
	records: readonly CaseRecord[],
	scenarios: readonly LoadedScenario[],
	runId: string,
	now = new Date(),
): Label[] {
	const cases = new Map<
		string,
		{ scenario: Scenario; cases: Map<string, Case> }
	>(
		scenarios.map(({ scenario, cases }) => [
			scenario.id,
			{ scenario, cases: new Map(cases.map((kase) => [kase.id, kase])) },
		]),
	);
	const labels = new Map<string, Label>();
	const labeledAt = now.toISOString();
	for (const record of records) {
		const entry = cases.get(record.scenario);
		const kase = entry?.cases.get(record.caseId);
		if (!entry || !kase || kase.tier !== "A" || record.error !== null) continue;
		for (const hit of record.hits) {
			if (hit.gradeSource !== "rule") continue;
			let grade: number | null = null;
			if (hit.bad) grade = 0;
			else if (
				hit.target &&
				isExactTarget(hit.normalizedUrl, kase.gold?.targets ?? [])
			)
				grade = maxGradeOf(entry.scenario);
			if (grade === null) continue;
			const label: Label = {
				scenario: record.scenario,
				query: kase.query,
				...(kase.note !== undefined && { note: kase.note }),
				...(kase.gold?.meanings && { meanings: kase.gold.meanings }),
				url: hit.url,
				title: hit.title,
				snippet: hit.snippet,
				publishedAt: hit.publishedAt,
				grade,
				source: `rule:${runId}`,
				labeledAt,
			};
			labels.set(
				`${record.scenario}|${hit.normalizedUrl}|${hit.title}|${hit.snippet}`,
				label,
			);
		}
	}
	return [...labels.values()];
}
