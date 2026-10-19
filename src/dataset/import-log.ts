import type { Case } from "../core/types.ts";
import { charLength, normalizeQuery } from "./text.ts";

/** 个人信息的模式. 命中的查询整条丢弃, 不做局部打码: 带这些信息的查询本身就是个人化的. */
const PII_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	["邮箱", /[\w.+-]+@[\w-]+(\.[\w-]+)+/],
	["手机号", /(?<!\d)(\+?86[- ]?)?1[3-9]\d{9}(?!\d)/],
	["电话", /(?<!\d)0\d{2,3}[- ]?\d{7,8}(?!\d)/],
	["身份证号", /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/],
	["银行卡号", /(?<!\d)\d{16,19}(?!\d)/],
	["个人信息查询", /手机号码?|电话号码|家庭住址|身份证号/],
];

export type DropReason = "pii" | "short" | "name" | "duplicate";

export type ScreenResult =
	| { ok: true; query: string }
	| { ok: false; reason: DropReason; detail?: string };

/**
 * 脱敏筛查: 丢弃带个人信息、过短或含名单里人名的查询. 人名无法可靠地自动识别, 由调用方提供名单.
 * 中文查询少于 minLength 个字符、不含汉字的查询少于 minLength + 1 个字符视为过短.
 */
export function screenQuery(
	raw: string,
	options: { minLength: number; names: readonly string[] },
): ScreenResult {
	const query = raw.replace(/\s+/g, " ").trim();
	for (const [label, pattern] of PII_PATTERNS) {
		if (pattern.test(query)) return { ok: false, reason: "pii", detail: label };
	}
	const han = /\p{Script=Han}/u.test(query);
	if (charLength(query) < options.minLength + (han ? 0 : 1))
		return { ok: false, reason: "short" };
	if (options.names.some((name) => name !== "" && query.includes(name)))
		return { ok: false, reason: "name" };
	return { ok: true, query };
}

const LONGTAIL =
	/error|exception|failed|traceback|undefined|errno|segfault|0x[0-9a-f]{4,}|报错|异常|错误码|::|=>|\(\)/i;
const FRESH =
	/最新|今天|今日|本周|昨天|近期|新闻|latest|today|this week|yesterday|news|\b20\d\d\b/i;
const NAVIGATIONAL =
	/官网|官方网站|登录|登陆|下载|首页|official site|log ?in|sign ?in|download|homepage/i;
const HOWTO =
	/如何|怎么|怎样|教程|入门|指南|步骤|配置|how to|tutorial|guide|getting started|setup|install/i;
const RESEARCH =
	/对比|比较|影响|研究|证据|情况|条件|分析|趋势|vs\.?|versus|evidence|impact|comparison|study|research/i;

/** 查询的长度档: 中文按字符, 英文按词. */
function isLong(query: string, han: boolean, hanChars: number, words: number) {
	return han
		? charLength(query) >= hanChars
		: query.split(/\s+/).length >= words;
}

/**
 * 按规则把一条查询粗分到场景: 先看语言, 再依次匹配长尾 (报错、代码)、时效、导航、教程、研究、描述性,
 * 都不匹配的短查询归导航, 其余归教程类信息查找. 歧义无法靠规则判断, 不会分到歧义场景.
 */
export function classifyQuery(query: string): string {
	const han = /\p{Script=Han}/u.test(query);
	const lang = han ? "zh" : "en";
	let intent: string;
	if (LONGTAIL.test(query)) intent = "longtail";
	else if (FRESH.test(query)) intent = "fresh";
	else if (NAVIGATIONAL.test(query)) intent = "nav";
	else if (HOWTO.test(query)) intent = "howto";
	else if (RESEARCH.test(query) && isLong(query, han, 12, 6))
		intent = "research";
	else if (isLong(query, han, 15, 7)) intent = "descriptive";
	else if (!isLong(query, han, 7, 3)) intent = "nav";
	else intent = "howto";
	return `${intent}-${lang}`;
}

/** 极简 CSV 解析: 支持引号包裹、引号转义与字段内换行. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] as string;
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index++;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"' && field === "") quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += char;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/**
 * 从日志文件取出查询. CSV 取表头里名为 query 的列, 没有这一列时取第一列 (首行视为数据);
 * JSONL 每行是带 query 字段的对象或一个字符串.
 */
export function readLogQueries(
	text: string,
	format: "csv" | "jsonl",
): string[] {
	if (format === "jsonl") {
		return text
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line, index) => {
				const value: unknown = JSON.parse(line);
				if (typeof value === "string") return value;
				if (
					value !== null &&
					typeof value === "object" &&
					"query" in value &&
					typeof value.query === "string"
				)
					return value.query;
				throw new Error(`第 ${index + 1} 行没有 query 字段`);
			});
	}
	const rows = parseCsv(text);
	const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
	const column = header.indexOf("query");
	return (column === -1 ? rows : rows.slice(1)).map(
		(row) => row[Math.max(column, 0)] ?? "",
	);
}

export interface ImportResult {
	/** 按场景 id 分组的新用例. */
	byScenario: Map<string, Case[]>;
	dropped: Record<DropReason, number>;
	/** 命中各类个人信息模式的条数. */
	pii: Record<string, number>;
}

/** 筛查、去重并分到场景. 用例 id 为 log-<批次>-<序号>, 来源 log:<批次>, 都是 B 层, 意图说明待补. */
export function importLog(
	queries: readonly string[],
	options: { batch: string; minLength: number; names: readonly string[] },
): ImportResult {
	const byScenario = new Map<string, Case[]>();
	const dropped: Record<DropReason, number> = {
		pii: 0,
		short: 0,
		name: 0,
		duplicate: 0,
	};
	const pii: Record<string, number> = {};
	const seen = new Set<string>();
	let index = 0;
	for (const raw of queries) {
		const screened = screenQuery(raw, options);
		if (!screened.ok) {
			dropped[screened.reason]++;
			if (screened.detail)
				pii[screened.detail] = (pii[screened.detail] ?? 0) + 1;
			continue;
		}
		const normalized = normalizeQuery(screened.query);
		if (seen.has(normalized)) {
			dropped.duplicate++;
			continue;
		}
		seen.add(normalized);
		const scenario = classifyQuery(screened.query);
		const list = byScenario.get(scenario) ?? [];
		list.push({
			id: `log-${options.batch}-${String(++index).padStart(5, "0")}`,
			query: screened.query,
			tier: "B",
			source: `log:${options.batch}`,
		});
		byScenario.set(scenario, list);
	}
	return { byScenario, dropped, pii };
}
