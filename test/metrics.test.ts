import { describe, expect, it } from "vitest";
import {
	coverage,
	dcg,
	domainDiversity,
	freshnessRates,
	hitAtK,
	meaningCoverage,
	ndcgAtK,
	percentile,
	precisionAtK,
	qualityMetrics,
	reciprocalRank,
	riskRate,
	scoreHits,
} from "../src/core/metrics.ts";
import { normalizeHits } from "../src/core/normalize.ts";
import type { Case, Hit } from "../src/core/types.ts";

function hit(url: string, publishedAt: string | null = null): Hit {
	return {
		url,
		title: "",
		snippet: "",
		siteName: null,
		favicon: null,
		publishedAt,
	};
}

describe("hitAtK", () => {
	it("只看前 k 条", () => {
		expect(hitAtK([false, true, false], 1)).toBe(0);
		expect(hitAtK([false, true, false], 2)).toBe(1);
		expect(hitAtK([false, true], 10)).toBe(1);
	});

	it("空结果为 0", () => {
		expect(hitAtK([], 3)).toBe(0);
	});
});

describe("reciprocalRank", () => {
	it("取第一条等级 ≥ 2 的倒数排名", () => {
		expect(reciprocalRank([0, 1, 2, 3])).toBeCloseTo(1 / 3);
		expect(reciprocalRank([3])).toBe(1);
		expect(reciprocalRank([null, 2])).toBe(0.5);
	});

	it("全 0、空结果为 0", () => {
		expect(reciprocalRank([0, 0, 0])).toBe(0);
		expect(reciprocalRank([])).toBe(0);
	});

	it("门槛可调", () => {
		expect(reciprocalRank([2, 3], 3)).toBe(0.5);
	});
});

describe("nDCG", () => {
	/** 维基百科 Discounted cumulative gain 词条的示例: 6 条结果, 判定集另有两篇 3 分与 2 分的文档. */
	const grades = [3, 2, 3, 0, 1, 2];
	const judged = [3, 2, 3, 0, 1, 2, 3, 2];

	it("DCG@6 = 6.861", () => {
		expect(dcg(grades, 6)).toBeCloseTo(6.8611, 4);
	});

	it("nDCG@6 = 0.785, 理想排序取判定集", () => {
		expect(ndcgAtK(grades, judged, 6)).toBeCloseTo(0.785, 3);
	});

	/** pytrec_eval README 示例的已知输出: q1 = 0.5, q2 = 0.6934264036172708. */
	it("与 pytrec_eval 的示例输出一致", () => {
		expect(ndcgAtK([0, 0, 1], [0, 1, 0], 1000)).toBeCloseTo(0.5, 12);
		expect(ndcgAtK([0, 1, 1], [1, 1], 1000)).toBeCloseTo(
			0.6934264036172708,
			12,
		);
	});

	it("全 3 且理想也全 3 时为 1", () => {
		expect(ndcgAtK([3, 3, 3], [3, 3, 3], 3)).toBe(1);
	});

	it("理想 DCG 为 0 时无定义", () => {
		expect(ndcgAtK([0, 0], [0, 0, 0], 10)).toBeNull();
		expect(ndcgAtK([], [], 10)).toBeNull();
	});

	it("空结果为 0", () => {
		expect(ndcgAtK([], [3], 10)).toBe(0);
	});

	it("k 大于结果数时按实际条数算, 理想排序仍取前 k 条", () => {
		expect(ndcgAtK([3], [3, 3], 10)).toBeCloseTo(
			3 / (3 + 3 / Math.log2(3)),
			12,
		);
	});

	it("未判定按 0 计", () => {
		expect(ndcgAtK([null, 3], [3], 10)).toBeCloseTo(1 / Math.log2(3), 12);
	});
});

describe("precisionAtK", () => {
	it("分母固定为 k", () => {
		expect(precisionAtK([3, 0, 2, null, 1], 5)).toBe(0.4);
		expect(precisionAtK([3], 5)).toBe(0.2);
		expect(precisionAtK([3, 3, 3, 3, 3, 3], 5)).toBe(1);
		expect(precisionAtK([], 5)).toBe(0);
	});
});

describe("coverage", () => {
	it("mustDomains 中出现的比例, 子域算命中", () => {
		const urls = ["https://docs.python.org/3", "https://realpython.com/x"];
		expect(
			coverage(urls, ["python.org", "realpython.com", "w3schools.com"]),
		).toBeCloseTo(2 / 3);
	});

	it("空结果为 0", () => {
		expect(coverage([], ["python.org"])).toBe(0);
	});

	it("相似但不同的域名不算", () => {
		expect(coverage(["https://notpython.org/"], ["python.org"])).toBe(0);
	});
});

describe("meaningCoverage", () => {
	it("只算等级 ≥ 2 的结果覆盖的含义, other 不算", () => {
		const hits = [
			{ grade: 3, meaning: "0" as const },
			{ grade: 1, meaning: "1" as const },
			{ grade: 2, meaning: "other" as const },
			{ grade: 2, meaning: "0" as const },
		];
		expect(meaningCoverage(hits, 2)).toBe(0.5);
		expect(meaningCoverage([], 3)).toBe(0);
	});
});

describe("riskRate", () => {
	it("命中风险域名的比例", () => {
		expect(riskRate([true, false, false, false])).toBe(0.25);
		expect(riskRate([false])).toBe(0);
	});

	it("空结果无定义", () => {
		expect(riskRate([])).toBeNull();
	});
});

describe("freshnessRates", () => {
	it("时效率与未知率分开统计", () => {
		expect(freshnessRates(["in", "out", "unknown", "in"])).toEqual({
			fresh: 0.5,
			unknown: 0.25,
		});
	});

	it("空结果无定义", () => {
		expect(freshnessRates([])).toBeNull();
	});
});

describe("domainDiversity", () => {
	it("不同注册域名数除以 k", () => {
		expect(domainDiversity(["a.com", "a.com", "b.com"], 10)).toBe(0.2);
		expect(domainDiversity(["a.com", "b.com", "c.com"], 2)).toBe(1);
		expect(domainDiversity([], 10)).toBe(0);
	});
});

describe("percentile", () => {
	it("相邻顺序统计量之间线性插值", () => {
		expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
		expect(percentile([1, 2, 3, 4], 90)).toBeCloseTo(3.7);
		expect(percentile([1, 2, 3, 4], 0)).toBe(1);
		expect(percentile([1, 2, 3, 4], 100)).toBe(4);
		expect(percentile([5], 99)).toBe(5);
	});

	it("空样本为 null", () => {
		expect(percentile([], 50)).toBeNull();
	});
});

describe("scoreHits", () => {
	const now = new Date("2026-10-01T00:00:00Z");
	const kase: Case = {
		id: "c",
		query: "q",
		tier: "A",
		source: "handwritten",
		gold: {
			targets: ["example.com"],
			badDomains: ["evil.example", "phish.example.com"],
			freshWithinDays: 7,
		},
	};

	it("风险优先于目标, 目标优先于时效", () => {
		const { hits } = normalizeHits(
			[
				hit("https://phish.example.com/login", "2026-09-30T00:00:00Z"),
				hit("https://www.example.com/docs/intro", "2020-01-01T00:00:00Z"),
				hit("https://other.org/a", "2020-01-01T00:00:00Z"),
				hit("https://other.org/b", "2026-09-28T00:00:00Z"),
				hit("https://other.org/c"),
				hit("https://other.org/d", "2026-10-05T00:00:00Z"),
				hit("https://evil.example/"),
			],
			10,
		);
		const scored = scoreHits(hits, kase, now);
		expect(
			scored.map((h) => [h.rank, h.target, h.bad, h.fresh, h.grade]),
		).toEqual([
			[1, true, true, "in", 0],
			[2, true, false, "out", 3],
			[3, false, false, "out", 0],
			[4, false, false, "in", null],
			[5, false, false, "unknown", null],
			[6, false, false, "in", null],
			[7, false, true, "unknown", 0],
		]);
		expect(scored[0]?.gradeSource).toBe("rule");
		expect(scored[3]?.gradeSource).toBeNull();
	});

	it("没有时效要求时 fresh 为 null", () => {
		const { hits } = normalizeHits(
			[hit("https://a.com/", "2020-01-01T00:00:00Z")],
			10,
		);
		const scored = scoreHits(
			hits,
			{ id: "c", query: "q", tier: "B", source: "synth:t" },
			now,
		);
		expect(scored[0]?.fresh).toBeNull();
		expect(scored[0]?.grade).toBeNull();
	});
});

describe("qualityMetrics", () => {
	const now = new Date("2026-10-01T00:00:00Z");
	const kase: Case = {
		id: "c",
		query: "q",
		tier: "A",
		source: "handwritten",
		gold: {
			targets: ["b.com"],
			mustDomains: ["a.com", "z.com"],
			badDomains: ["c.com"],
		},
	};
	const scored = scoreHits(
		normalizeHits(
			[hit("https://a.com/"), hit("https://b.com/"), hit("https://c.com/")],
			10,
		).hits,
		kase,
		now,
	);

	it("按 gold 计算各项指标", () => {
		const values = qualityMetrics(scored, kase, 10, [3, 0], false);
		expect(values.hit1).toBe(0);
		expect(values.hit3).toBe(1);
		expect(values.hitK).toBe(1);
		expect(values.mrr).toBe(0.5);
		expect(values.ndcg).toBeCloseTo(1 / Math.log2(3), 12);
		expect(values.p5).toBe(0.2);
		expect(values.coverage).toBe(0.5);
		expect(values.risk).toBeCloseTo(1 / 3);
		expect(values.diversity).toBeCloseTo(0.3);
		expect(values.meaningCoverage).toBeNull();
		expect(values.fresh).toBeNull();
	});

	it("结果池中没有已判定结果时, 依赖等级的指标不适用", () => {
		const values = qualityMetrics(scored, kase, 10, null, false);
		expect(values.mrr).toBeNull();
		expect(values.ndcg).toBeNull();
		expect(values.p5).toBeNull();
	});

	it("出错的执行按空结果计", () => {
		const values = qualityMetrics([], kase, 10, [3], false);
		expect(values.hit1).toBe(0);
		expect(values.mrr).toBe(0);
		expect(values.ndcg).toBe(0);
		expect(values.coverage).toBe(0);
		expect(values.risk).toBeNull();
		expect(values.diversity).toBe(0);
	});

	it("没有对应标注的指标为 null", () => {
		const bare: Case = { id: "c", query: "q", tier: "B", source: "synth:t" };
		const values = qualityMetrics([], bare, 10, null, false);
		expect(values.hit1).toBeNull();
		expect(values.coverage).toBeNull();
		expect(values.risk).toBeNull();
		expect(values.fresh).toBeNull();
	});
});
