import { describe, expect, it } from "vitest";
import { Case, Judgment, judgmentSchema, Scenario } from "../src/core/types.ts";

describe("Case", () => {
	const base = {
		id: "c",
		query: "Steam 官网",
		tier: "A",
		source: "handwritten",
	};

	it("来源只能是约定的几种前缀", () => {
		expect(Case.safeParse(base).success).toBe(true);
		expect(
			Case.safeParse({ ...base, source: "synth:nav-template" }).success,
		).toBe(true);
		expect(Case.safeParse({ ...base, source: "log:2026-10" }).success).toBe(
			true,
		);
		expect(Case.safeParse({ ...base, source: "synth:" }).success).toBe(false);
		expect(Case.safeParse({ ...base, source: "manual" }).success).toBe(false);
	});

	it("gold 域名不带协议与路径, 目标可以带", () => {
		expect(
			Case.safeParse({ ...base, gold: { mustDomains: ["python.org"] } })
				.success,
		).toBe(true);
		expect(
			Case.safeParse({ ...base, gold: { mustDomains: ["https://python.org"] } })
				.success,
		).toBe(false);
		expect(
			Case.safeParse({
				...base,
				gold: { targets: ["https://github.com/features/copilot"] },
			}).success,
		).toBe(true);
	});

	it("含义 2 到 4 个", () => {
		expect(Case.safeParse({ ...base, gold: { meanings: ["a"] } }).success).toBe(
			false,
		);
		expect(
			Case.safeParse({ ...base, gold: { meanings: ["a", "b", "c", "d"] } })
				.success,
		).toBe(true);
		expect(
			Case.safeParse({ ...base, gold: { meanings: ["a", "b", "c", "d", "e"] } })
				.success,
		).toBe(false);
	});

	it("拒绝未知字段", () => {
		expect(Case.safeParse({ ...base, golds: {} }).success).toBe(false);
	});
});

describe("Scenario", () => {
	it("k 默认 10", () => {
		const scenario = Scenario.parse({
			id: "nav-zh",
			version: "1",
			lang: "zh",
			intent: "navigational",
			description: "d",
			rubric: "r",
			casesFile: "nav-zh.cases.jsonl",
		});
		expect(scenario.k).toBe(10);
	});
});

describe("Judgment", () => {
	const judgment = {
		reason: "官网",
		grade: 3,
		sourceTier: "official",
		stale: "fresh",
	};

	it("默认刻度 0 到 3", () => {
		expect(Judgment.safeParse(judgment).success).toBe(true);
		expect(Judgment.safeParse({ ...judgment, grade: 4 }).success).toBe(false);
		expect(Judgment.safeParse({ ...judgment, grade: 2.5 }).success).toBe(false);
	});

	it("理由不超过 200 字", () => {
		expect(
			Judgment.safeParse({ ...judgment, reason: "长".repeat(201) }).success,
		).toBe(false);
	});

	it("按刻度与含义数生成", () => {
		const fine = judgmentSchema({ maxGrade: 4, meanings: 0 });
		expect(fine.safeParse({ ...judgment, grade: 4 }).success).toBe(true);
		const ambiguous = judgmentSchema({ maxGrade: 3, meanings: 2 });
		expect(ambiguous.safeParse({ ...judgment, meaning: "1" }).success).toBe(
			true,
		);
		expect(ambiguous.safeParse({ ...judgment, meaning: "other" }).success).toBe(
			true,
		);
		expect(ambiguous.safeParse({ ...judgment, meaning: "2" }).success).toBe(
			false,
		);
		expect(ambiguous.safeParse(judgment).success).toBe(false);
	});
});
