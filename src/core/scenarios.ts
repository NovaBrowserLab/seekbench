import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { parseJsonl } from "./jsonl.ts";
import { Case, Scenario, type Tier } from "./types.ts";

export interface LoadedScenario {
	scenario: Scenario;
	cases: Case[];
	/** 用例文件内容的 sha256, 续跑时据此确认题库没变. */
	casesHash: string;
}

/** 读取 <dir>/<id>.json 与它引用的用例文件, 校验 schema 与用例 id 唯一. */
export async function loadScenario(
	dir: string,
	id: string,
): Promise<LoadedScenario> {
	const file = join(dir, `${id}.json`);
	const parsed = Scenario.safeParse(JSON.parse(await readFile(file, "utf8")));
	if (!parsed.success)
		throw new Error(`${file} 格式不符:\n${z.prettifyError(parsed.error)}`);
	const scenario = parsed.data;
	if (scenario.id !== id)
		throw new Error(`${file} 的 id 为 ${scenario.id}, 应与文件名一致`);
	const casesPath = resolve(dirname(file), scenario.casesFile);
	const text = await readFile(casesPath, "utf8");
	const cases = parseJsonl(text, Case, casesPath);
	const seen = new Set<string>();
	for (const kase of cases) {
		if (seen.has(kase.id))
			throw new Error(`${casesPath} 中用例 id 重复: ${kase.id}`);
		seen.add(kase.id);
	}
	return {
		scenario,
		cases,
		casesHash: createHash("sha256").update(text).digest("hex"),
	};
}

/** 场景刻度的最高等级: 默认 0 到 3, 场景自带刻度时取其长度减 1. */
export function maxGradeOf(scenario: Scenario): 3 | 4 {
	return scenario.scale?.length === 5 ? 4 : 3;
}

export interface CaseFilters {
	tier?: Tier | undefined;
	/** 按前缀匹配, 如 synth 匹配所有 synth:<模板>. */
	source?: string | undefined;
	/** 只取过滤后的前若干条. */
	limit?: number | undefined;
}

export function filterCases(
	cases: readonly Case[],
	filters: CaseFilters,
): Case[] {
	const matched = cases.filter(
		(kase) =>
			(filters.tier === undefined || kase.tier === filters.tier) &&
			(filters.source === undefined || kase.source.startsWith(filters.source)),
	);
	return filters.limit === undefined
		? matched
		: matched.slice(0, filters.limit);
}
