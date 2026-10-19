import { parsePattern } from "../core/normalize.ts";
import { type LoadedScenario, loadScenario } from "../core/scenarios.ts";
import { normalizeQuery } from "./text.ts";

export interface Issue {
	level: "error" | "warning";
	scenario: string;
	caseId?: string;
	message: string;
}

/**
 * 校验一组场景: schema 与用例 id 唯一 (由 loadScenario 保证)、gold 域名与 URL 能否解析、
 * 场景内与跨场景的重复查询、各层的标注要求. 场景内重复与无法解析的 gold 是错误, 其余是警告.
 */
export async function validateScenarios(
	dir: string,
	ids: readonly string[],
): Promise<{ issues: Issue[]; scenarios: LoadedScenario[] }> {
	const issues: Issue[] = [];
	const scenarios: LoadedScenario[] = [];
	for (const id of ids) {
		try {
			scenarios.push(await loadScenario(dir, id));
		} catch (error) {
			issues.push({
				level: "error",
				scenario: id,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const seen = new Map<string, { scenario: string; caseId: string }>();
	for (const { scenario, cases } of scenarios) {
		const issue = (
			level: Issue["level"],
			caseId: string | undefined,
			message: string,
		) =>
			issues.push({
				level,
				scenario: scenario.id,
				...(caseId !== undefined && { caseId }),
				message,
			});
		const templates = new Set<string>();
		for (const template of scenario.synth ?? []) {
			if (templates.has(template.id))
				issue("error", undefined, `合成模板 id 重复: ${template.id}`);
			templates.add(template.id);
		}
		const local = new Map<string, string>();
		for (const kase of cases) {
			const gold = kase.gold;
			for (const [field, patterns] of [
				["targets", gold?.targets],
				["mustDomains", gold?.mustDomains],
				["badDomains", gold?.badDomains],
			] as const) {
				for (const pattern of patterns ?? []) {
					if (parsePattern(pattern) === null)
						issue("error", kase.id, `${field} 无法解析: ${pattern}`);
				}
			}
			if (kase.tier === "A" && gold === undefined)
				issue("warning", kase.id, "A 层用例没有 gold");
			if (
				kase.tier === "A" &&
				scenario.intent === "navigational" &&
				!gold?.targets
			)
				issue("warning", kase.id, "导航场景的 A 层用例没有 targets");
			if (
				kase.tier === "A" &&
				scenario.intent === "ambiguous" &&
				!gold?.meanings
			)
				issue("warning", kase.id, "歧义场景的 A 层用例没有 meanings");
			if (kase.tier === "B" && kase.note === undefined)
				issue("warning", kase.id, "B 层用例没有意图说明, 裁判只能参考场景说明");
			if (
				kase.source.startsWith("synth:") &&
				!templates.has(kase.source.slice("synth:".length))
			)
				issue("warning", kase.id, `来源 ${kase.source} 不对应任何合成模板`);

			const normalized = normalizeQuery(kase.query);
			const duplicate = local.get(normalized);
			if (duplicate !== undefined)
				issue("error", kase.id, `与用例 ${duplicate} 的查询重复`);
			else local.set(normalized, kase.id);
			const other = seen.get(normalized);
			if (other && other.scenario !== scenario.id)
				issue(
					"warning",
					kase.id,
					`与 ${other.scenario} 的用例 ${other.caseId} 查询相同`,
				);
			else if (!other)
				seen.set(normalized, { scenario: scenario.id, caseId: kase.id });
		}
	}
	return { issues, scenarios };
}

export function formatIssue(issue: Issue): string {
	const where = issue.caseId
		? `${issue.scenario}/${issue.caseId}`
		: issue.scenario;
	return `${issue.level === "error" ? "错误" : "警告"} ${where}: ${issue.message}`;
}
