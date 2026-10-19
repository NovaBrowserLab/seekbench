/** 查询的归一化形式: NFKC、小写、压缩空白, 判断重复用. */
export function normalizeQuery(query: string): string {
	return query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 编辑距离 (Levenshtein), 按码点计. */
export function editDistance(a: string, b: string): number {
	const left = [...a];
	const right = [...b];
	let previous = Array.from({ length: right.length + 1 }, (_, j) => j);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + cost,
			);
		}
		previous = current;
	}
	return previous[right.length] ?? 0;
}

function bigrams(text: string): Map<string, number> {
	const chars = [...text.replace(/\s+/g, "")];
	const counts = new Map<string, number>();
	if (chars.length === 1) counts.set(chars[0] as string, 1);
	for (let index = 0; index + 1 < chars.length; index++) {
		const gram = `${chars[index]}${chars[index + 1]}`;
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	return counts;
}

/** 字符二元组的 Dice 系数, 0 到 1. 对词序调换、增删修饰词这类改写比编辑距离更敏感. */
export function bigramSimilarity(a: string, b: string): number {
	const left = bigrams(a);
	const right = bigrams(b);
	let total = 0;
	let shared = 0;
	for (const count of left.values()) total += count;
	for (const [gram, count] of right) {
		total += count;
		shared += Math.min(count, left.get(gram) ?? 0);
	}
	return total === 0 ? 0 : (2 * shared) / total;
}

/** 近似重复的阈值: 编辑距离不超过较长者的 20%, 或二元组相似度不低于 0.8. */
export const NEAR_DUPLICATE = { editRatio: 0.2, similarity: 0.8 } as const;

/** 两条查询归一化后相同或近似重复. */
export function isNearDuplicate(a: string, b: string): boolean {
	const left = normalizeQuery(a);
	const right = normalizeQuery(b);
	if (left === right) return true;
	const longest = Math.max([...left].length, [...right].length);
	if (editDistance(left, right) <= longest * NEAR_DUPLICATE.editRatio)
		return true;
	return bigramSimilarity(left, right) >= NEAR_DUPLICATE.similarity;
}

/** 字符数, 按码点计. */
export function charLength(text: string): number {
	return [...text].length;
}
