import {
	matchesPattern,
	type NormalizedHit,
	parsePattern,
	type UrlPattern,
} from "./normalize.ts";
import type { Case, Meaning, QualityMetric, ScoredHit } from "./types.ts";

/** 等级达到此值视为相关, MRR 与 P@5 用. */
export const RELEVANT_GRADE = 2;

/** 规则判定的满分等级. */
const TARGET_GRADE = 3;

const DAY_MS = 86_400_000;

/** 未判定的等级按 0 计, 与 trec_eval 对未判文档的处理一致; 判定率在汇总里单独报告. */
function gain(grade: number | null | undefined): number {
	return grade ?? 0;
}

/** 前 k 条是否含目标, 1 或 0. */
export function hitAtK(targets: readonly boolean[], k: number): number {
	return targets.slice(0, k).some(Boolean) ? 1 : 0;
}

/** 第一条等级达到门槛的结果的倒数排名, 没有则为 0. */
export function reciprocalRank(
	grades: readonly (number | null)[],
	threshold = RELEVANT_GRADE,
): number {
	const index = grades.findIndex((grade) => gain(grade) >= threshold);
	return index === -1 ? 0 : 1 / (index + 1);
}

/** 折损累计增益, 线性增益, 折损 log2(名次 + 1). */
export function dcg(grades: readonly (number | null)[], k: number): number {
	let sum = 0;
	for (const [index, grade] of grades.slice(0, k).entries()) {
		sum += gain(grade) / Math.log2(index + 2);
	}
	return sum;
}

/** nDCG@k. 理想排序取 idealGrades 降序的前 k 条; 理想 DCG 为 0 时指标无定义, 返回 null. */
export function ndcgAtK(
	grades: readonly (number | null)[],
	idealGrades: readonly number[],
	k: number,
): number | null {
	const ideal = dcg(
		[...idealGrades].sort((a, b) => b - a),
		k,
	);
	return ideal === 0 ? null : dcg(grades, k) / ideal;
}

/** 前 k 条中等级达到门槛的比例, 分母固定为 k. */
export function precisionAtK(
	grades: readonly (number | null)[],
	k: number,
	threshold = RELEVANT_GRADE,
): number {
	return (
		grades.slice(0, k).filter((grade) => gain(grade) >= threshold).length / k
	);
}

/** mustDomains 中至少命中一条结果的比例. urls 为规范化后的结果 URL. */
export function coverage(
	urls: readonly string[],
	mustDomains: readonly string[],
): number {
	const found = mustDomains
		.map(parsePattern)
		.filter(
			(pattern) =>
				pattern !== null && urls.some((url) => matchesPattern(url, pattern)),
		);
	return found.length / mustDomains.length;
}

/** 至少有一条相关结果的含义占全部含义的比例. */
export function meaningCoverage(
	hits: readonly { grade: number | null; meaning: Meaning | null }[],
	meaningCount: number,
	threshold = RELEVANT_GRADE,
): number {
	const covered = new Set<string>();
	for (const hit of hits) {
		if (
			hit.meaning !== null &&
			hit.meaning !== "other" &&
			gain(hit.grade) >= threshold
		) {
			covered.add(hit.meaning);
		}
	}
	return covered.size / meaningCount;
}

/** 结果中命中风险域名的比例; 没有结果时为 null. */
export function riskRate(bad: readonly boolean[]): number | null {
	return bad.length === 0 ? null : bad.filter(Boolean).length / bad.length;
}

/** 结果中发布时间在窗口内的比例, 与缺失发布时间的比例; 没有结果时为 null. */
export function freshnessRates(
	fresh: readonly ("in" | "out" | "unknown")[],
): { fresh: number; unknown: number } | null {
	if (fresh.length === 0) return null;
	const count = (value: string) =>
		fresh.filter((item) => item === value).length;
	return {
		fresh: count("in") / fresh.length,
		unknown: count("unknown") / fresh.length,
	};
}

/** 不同注册域名数除以 k. */
export function domainDiversity(domains: readonly string[], k: number): number {
	return new Set(domains.slice(0, k)).size / k;
}

export function mean(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 百分位数, 在相邻两个顺序统计量之间线性插值 (与 numpy 默认方法一致). p 取 0 到 100. */
export function percentile(
	values: readonly number[],
	p: number,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const position = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	const low = sorted[lower] as number;
	const high = sorted[upper] as number;
	return low + (high - low) * (position - lower);
}

function parsePatterns(patterns: readonly string[] | undefined): UrlPattern[] {
	return (patterns ?? [])
		.map(parsePattern)
		.filter((pattern) => pattern !== null);
}

/**
 * 按 gold 标注给结果打规则分: 命中 badDomains 记 0, 命中 targets 记 3, 发布时间超出时效窗口记 0, 其余留给裁判.
 * 风险优先于目标, 目标优先于时效. now 为执行时刻, 时效窗口相对它计算; 发布时间晚于 now 视为窗口内.
 */
export function scoreHits(
	hits: readonly NormalizedHit[],
	kase: Case,
	now: Date,
): ScoredHit[] {
	const targets = parsePatterns(kase.gold?.targets);
	const bad = parsePatterns(kase.gold?.badDomains);
	const windowDays = kase.gold?.freshWithinDays;
	return hits.map((hit, index) => {
		const isTarget = targets.some((pattern) =>
			matchesPattern(hit.normalizedUrl, pattern),
		);
		const isBad = bad.some((pattern) =>
			matchesPattern(hit.normalizedUrl, pattern),
		);
		let fresh: ScoredHit["fresh"] = null;
		if (windowDays !== undefined) {
			if (hit.publishedAt === null) fresh = "unknown";
			else
				fresh =
					now.getTime() - Date.parse(hit.publishedAt) <= windowDays * DAY_MS
						? "in"
						: "out";
		}
		let grade: number | null = null;
		if (isBad) grade = 0;
		else if (isTarget) grade = TARGET_GRADE;
		else if (fresh === "out") grade = 0;
		return {
			...hit,
			rank: index + 1,
			target: isTarget,
			bad: isBad,
			fresh,
			grade,
			gradeSource: grade === null ? null : "rule",
			meaning: null,
		};
	});
}

export type QualityValues = Record<QualityMetric, number | null>;

/**
 * 一次执行的质量指标. hits 已截断到 k 条; 出错的执行传空列表, 按用户拿到空结果计.
 * idealGrades 为该用例在本次运行所有被测对象结果池中的等级, 池中没有任何已判定结果时为 null,
 * 此时依赖等级的指标不适用. 依赖某项 gold 的指标在用例没有该标注时为 null.
 */
export function qualityMetrics(
	hits: readonly ScoredHit[],
	kase: Case,
	k: number,
	idealGrades: readonly number[] | null,
	meaningLabeled: boolean,
): QualityValues {
	const gold = kase.gold;
	const grades = hits.map((hit) => hit.grade);
	const hasTargets = (gold?.targets?.length ?? 0) > 0;
	const targets = hits.map((hit) => hit.target);
	const freshness =
		gold?.freshWithinDays === undefined
			? null
			: freshnessRates(hits.map((hit) => hit.fresh ?? "unknown"));
	return {
		hit1: hasTargets ? hitAtK(targets, 1) : null,
		hit3: hasTargets ? hitAtK(targets, 3) : null,
		hitK: hasTargets ? hitAtK(targets, k) : null,
		mrr: idealGrades === null ? null : reciprocalRank(grades),
		ndcg: idealGrades === null ? null : ndcgAtK(grades, idealGrades, k),
		p5: idealGrades === null ? null : precisionAtK(grades, 5),
		coverage: gold?.mustDomains
			? coverage(
					hits.map((hit) => hit.normalizedUrl),
					gold.mustDomains,
				)
			: null,
		meaningCoverage:
			gold?.meanings && meaningLabeled
				? meaningCoverage(hits, gold.meanings.length)
				: null,
		risk: gold?.badDomains ? riskRate(hits.map((hit) => hit.bad)) : null,
		fresh: freshness?.fresh ?? null,
		freshUnknown: freshness?.unknown ?? null,
		diversity: domainDiversity(
			hits.map((hit) => hit.domain),
			k,
		),
	};
}
