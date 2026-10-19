import type { Agreement } from "../core/types.ts";

/** (人工等级, 裁判等级) 的一对. */
export type GradePair = readonly [human: number, judge: number];

/** 混淆矩阵, 行为人工等级, 列为裁判等级. */
export function confusionMatrix(
	pairs: readonly GradePair[],
	maxGrade: number,
): number[][] {
	const matrix = Array.from({ length: maxGrade + 1 }, () =>
		Array<number>(maxGrade + 1).fill(0),
	);
	for (const [human, judge] of pairs) {
		const row = matrix[human];
		if (row && judge >= 0 && judge <= maxGrade)
			row[judge] = (row[judge] ?? 0) + 1;
	}
	return matrix;
}

/**
 * 二次加权 Kappa: 1 - Σ w·O / Σ w·E, 权重 w = (i - j)² / (K - 1)², E 由两边的边际分布相乘得到.
 * 期望不一致为 0 (两边都只用了同一个等级) 时无定义, 返回 null.
 */
export function weightedKappa(
	pairs: readonly GradePair[],
	maxGrade: number,
): number | null {
	const n = pairs.length;
	if (n === 0 || maxGrade === 0) return null;
	const observed = confusionMatrix(pairs, maxGrade);
	const rows = observed.map((row) =>
		row.reduce((sum, value) => sum + value, 0),
	);
	const cols =
		observed[0]?.map((_, j) =>
			observed.reduce((sum, row) => sum + (row[j] ?? 0), 0),
		) ?? [];
	let disagreement = 0;
	let expected = 0;
	for (let i = 0; i <= maxGrade; i++) {
		for (let j = 0; j <= maxGrade; j++) {
			const weight = (i - j) ** 2 / maxGrade ** 2;
			disagreement += weight * (observed[i]?.[j] ?? 0);
			expected += (weight * (rows[i] ?? 0) * (cols[j] ?? 0)) / n;
		}
	}
	return expected === 0 ? null : 1 - disagreement / expected;
}

export function agreement(
	pairs: readonly GradePair[],
	maxGrade: number,
): Agreement {
	const n = pairs.length;
	const rate = (count: number) => (n === 0 ? 0 : count / n);
	return {
		n,
		exact: rate(pairs.filter(([a, b]) => a === b).length),
		withinOne: rate(pairs.filter(([a, b]) => Math.abs(a - b) <= 1).length),
		kappa: weightedKappa(pairs, maxGrade),
	};
}
