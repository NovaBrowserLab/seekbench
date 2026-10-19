import { z } from "zod";
import { stableHash } from "../core/config.ts";
import { maxGradeOf } from "../core/scenarios.ts";
import { type Case, judgmentSchema, type Scenario } from "../core/types.ts";

/** 裁判提示词模板的版本. 改提示词即升版本, 旧缓存随之失效. */
export const JUDGE_PROMPT_VERSION = "1";

/** 默认的 0 到 3 刻度, 下标即等级. */
export const DEFAULT_SCALE: readonly string[] = [
	"无用: 对这个查询没有价值, 或有害. 无关、错误、已过时、仿冒站点、内容农场、广告页.",
	"沾边: 与查询有关, 但用户还要再跳转、筛选或自己拼凑. 只覆盖查询的一部分, 或是入口页、列表页、相关话题.",
	"相关: 内容对题、可用, 但不是最好的那一条. 回答了问题但不权威、不完整, 或是转述、二手整理.",
	"完全满足: 这一条就能解决查询的意图, 用户不需要再看别的结果. 导航类是目标站点本身; 信息类是直接回答问题的权威或一手来源; 时效类是窗口内且内容对题.",
];

export function scaleOf(scenario: Scenario): readonly string[] {
	return scenario.scale ?? DEFAULT_SCALE;
}

/** 场景打分规则的哈希: 提示词版本、场景说明、rubric、刻度与是否抓正文, 任何一项变了裁判缓存都不再复用. */
export function rubricHash(scenario: Scenario, fetch: boolean): string {
	return stableHash({
		prompt: JUDGE_PROMPT_VERSION,
		description: scenario.description,
		rubric: scenario.rubric,
		scale: scaleOf(scenario),
		fetch,
	});
}

/** 送裁判的一条结果. 不含名次与被测对象, 保证位置盲、来源盲. */
export interface JudgeItem {
	/** 裁判缓存的键, 见 judgmentKey. */
	key: string;
	url: string;
	title: string;
	snippet: string;
	publishedAt: string | null;
	/** --judge-fetch 时抓取的正文节选. */
	content?: string | null;
}

/** 裁判看到的用例信息. */
export type JudgeCase = Pick<Case, "query" | "note"> & {
	meanings?: readonly string[] | undefined;
};

/**
 * 一条结果在裁判眼里的全部内容的哈希, 作为缓存键: 查询、意图说明、含义、规范化 URL、标题、摘要、发布时间与是否抓正文.
 * 不同被测对象返回同一 URL 但摘要不同时分别判定, 因为摘要质量本身就是被测的一部分.
 */
export function judgmentKey(
	kase: JudgeCase,
	hit: {
		normalizedUrl: string;
		title: string;
		snippet: string;
		publishedAt: string | null;
	},
	fetch: boolean,
): string {
	return stableHash({
		query: kase.query,
		note: kase.note ?? null,
		meanings: kase.meanings ?? null,
		url: hit.normalizedUrl,
		title: hit.title,
		snippet: hit.snippet,
		publishedAt: hit.publishedAt,
		fetch,
	});
}

/** 一次调用的输出 schema: 每条结果一项, id 在前, 理由先于等级. */
export function batchSchema(scenario: Scenario, meanings: number) {
	const item = judgmentSchema({ maxGrade: maxGradeOf(scenario), meanings });
	return z.object({
		judgments: z.array(z.object({ id: z.string(), ...item.shape })),
	});
}

export interface JudgePrompt {
	system: string;
	prompt: string;
}

/** 正文节选的长度上限, 字符数. */
export const CONTENT_LIMIT = 2000;

/**
 * 组装一次调用的提示词. items 已打乱, 以 id 区分; schemaText 非空时把输出 schema 写进系统提示词,
 * 供不支持 json_schema 的接口使用. today 让裁判判断内容是否过时.
 */
export function buildPrompt(
	scenario: Scenario,
	kase: JudgeCase,
	items: ReadonlyArray<{ id: string; item: JudgeItem }>,
	options: { today: string; schemaText?: string | undefined },
): JudgePrompt {
	const scale = scaleOf(scenario);
	const grades = scale
		.map((definition, grade) => `- ${grade} ${definition}`)
		.reverse()
		.join("\n");
	const meanings = kase.meanings ?? [];
	const system = [
		"你是搜索结果的相关性评审员. 给定一个搜索查询和它的真实意图, 逐条评估候选结果对这个查询的价值.",
		"你只能看到每条结果的标题、URL、摘要与发布时间. 候选结果的顺序是随机的, 与排名无关; 不要因为结果来自哪个搜索服务而加减分. 摘要写得差就按摘要判断, 不要替它脑补页面内容.",
		"",
		"## 场景",
		scenario.description,
		"",
		"## 打分说明",
		scenario.rubric,
		"",
		"## 等级",
		grades,
		"两级之间拿不准时取低的一级.",
		"",
		"## 其余字段",
		"- reason: 一句话理由, 不超过 100 字, 先写理由再定等级.",
		"- sourceTier: official 官方或一手; reputable 可靠媒体、文档、机构; ugc 论坛、问答、个人博客; suspicious 内容农场、仿冒、广告页.",
		"- stale: 按内容判断是否已经过时, 与发布时间无关. fresh 未过时; stale 已过时; unknown 无法判断.",
		...(meanings.length > 0
			? ["- meaning: 这条结果对应查询的哪个含义, 填含义编号; 都不对应填 other."]
			: []),
		"",
		"## 输出",
		`只输出一个 JSON 对象, 形如 {"judgments": [{"id": "r1", "reason": "...", "grade": 0, "sourceTier": "official", "stale": "fresh"${meanings.length > 0 ? ', "meaning": "0"' : ""}}]}. 每条候选结果恰好一项, id 与输入一致.`,
		...(options.schemaText ? ["", "JSON Schema:", options.schemaText] : []),
	].join("\n");
	const lines = [
		`今天是 ${options.today}.`,
		"",
		`查询: ${kase.query}`,
		`意图: ${kase.note ?? "见场景说明"}`,
	];
	if (meanings.length > 0) {
		lines.push(
			"含义:",
			...meanings.map((meaning, index) => `- ${index}: ${meaning}`),
		);
	}
	lines.push("", `候选结果 (${items.length} 条):`);
	for (const { id, item } of items) {
		lines.push(
			"",
			`[${id}]`,
			`标题: ${item.title || "(无)"}`,
			`URL: ${item.url}`,
			`发布时间: ${item.publishedAt ?? "未知"}`,
			`摘要: ${item.snippet || "(无)"}`,
		);
		if (item.content) lines.push(`正文节选: ${item.content}`);
	}
	return { system, prompt: lines.join("\n") };
}
