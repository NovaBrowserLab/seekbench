import { getDomain, parse } from "tldts";
import type { Hit } from "./types.ts";

/** 计入私有后缀 (github.io、vercel.app 等), 让托管在同一平台上的不同站点算作不同域名. */
const TLDTS_OPTIONS = { allowPrivateDomains: true };

/** 只携带来源或会话信息、不影响页面内容的查询参数. */
const TRACKING_PARAMS = new Set([
	"gclid",
	"gclsrc",
	"dclid",
	"gbraid",
	"wbraid",
	"fbclid",
	"msclkid",
	"yclid",
	"twclid",
	"ttclid",
	"igshid",
	"mc_cid",
	"mc_eid",
	"_hsenc",
	"_hsmi",
	"mkt_tok",
	"ref_src",
	"spm",
	"scm",
	"vd_source",
	"share_source",
	"share_medium",
	"bd_vid",
]);

/** 折叠掉的首级子域: 桌面版、移动版与 www 视为同一站点. */
const FOLDED_SUBDOMAINS = new Set(["www", "m", "mobile", "wap"]);

function isTrackingParam(name: string): boolean {
	const key = name.toLowerCase();
	return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

function foldHost(hostname: string): string {
	const info = parse(hostname, TLDTS_OPTIONS);
	if (info.isIp || !info.domain || !info.subdomain) return hostname;
	const labels = info.subdomain.split(".");
	if (labels[0] !== undefined && FOLDED_SUBDOMAINS.has(labels[0]))
		labels.shift();
	return labels.length > 0 ? `${labels.join(".")}.${info.domain}` : info.domain;
}

/**
 * 规范化 URL, 作为去重、gold 匹配与裁判缓存的键.
 * 统一为 https, 去掉片段、凭据与跟踪参数, 其余参数排序, 折叠 www 与移动端子域, 去掉路径尾部斜杠.
 * 路径大小写保留, 因为服务端通常区分. 无法解析或不是 http(s) 时返回 null.
 */
export function normalizeUrl(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	url.protocol = "https:";
	url.hash = "";
	url.username = "";
	url.password = "";
	url.hostname = foldHost(url.hostname);
	const params = [...url.searchParams]
		.filter(([name]) => !isTrackingParam(name))
		.sort(([a, av], [b, bv]) => (a === b ? compare(av, bv) : compare(a, b)));
	url.search = new URLSearchParams(params).toString();
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
		url.pathname = url.pathname.replace(/\/+$/, "");
	}
	return url.href;
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** 注册域名; IP 与无公共后缀的主机名原样返回. */
export function registrableDomain(hostname: string): string {
	return getDomain(hostname, TLDTS_OPTIONS) ?? hostname;
}

/** 预先规范化的 gold 模式: 主机名按后缀匹配, 路径按段前缀匹配. */
export interface UrlPattern {
	host: string;
	/** 空串表示不限路径. */
	path: string;
}

/** 解析 gold 中的 URL 或域名 (可带路径). 无法解析时返回 null. */
export function parsePattern(pattern: string): UrlPattern | null {
	const withScheme = /^https?:\/\//i.test(pattern)
		? pattern
		: `https://${pattern}`;
	const normalized = normalizeUrl(withScheme);
	if (normalized === null) return null;
	const url = new URL(normalized);
	return { host: url.hostname, path: url.pathname === "/" ? "" : url.pathname };
}

/** 主机名等于模式主机或是其子域, 且路径等于模式路径或在其之下. */
export function matchesPattern(
	normalizedUrl: string,
	pattern: UrlPattern,
): boolean {
	const url = new URL(normalizedUrl);
	const hostMatches =
		url.hostname === pattern.host || url.hostname.endsWith(`.${pattern.host}`);
	if (!hostMatches) return false;
	if (pattern.path === "") return true;
	return (
		url.pathname === pattern.path || url.pathname.startsWith(`${pattern.path}/`)
	);
}

export interface NormalizedHit extends Hit {
	normalizedUrl: string;
	domain: string;
}

export interface NormalizedHits {
	hits: NormalizedHit[];
	/** 与前面某条规范化 URL 相同而丢弃的条数. */
	duplicates: number;
	/** URL 无法解析而丢弃的条数. */
	invalid: number;
}

/** 规范化 URL、按规范化 URL 去重 (保留首次出现), 再截断到 k 条. 不改变原有顺序. */
export function normalizeHits(hits: readonly Hit[], k: number): NormalizedHits {
	const seen = new Set<string>();
	const out: NormalizedHit[] = [];
	let duplicates = 0;
	let invalid = 0;
	for (const hit of hits) {
		const normalizedUrl = normalizeUrl(hit.url);
		if (normalizedUrl === null) {
			invalid++;
			continue;
		}
		if (seen.has(normalizedUrl)) {
			duplicates++;
			continue;
		}
		seen.add(normalizedUrl);
		out.push({
			...hit,
			normalizedUrl,
			domain: registrableDomain(new URL(normalizedUrl).hostname),
		});
	}
	return { hits: out.slice(0, k), duplicates, invalid };
}
