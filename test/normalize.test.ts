import { describe, expect, it } from "vitest";
import {
	matchesPattern,
	normalizeHits,
	normalizeUrl,
	parsePattern,
	registrableDomain,
} from "../src/core/normalize.ts";
import type { Hit } from "../src/core/types.ts";

function hit(url: string): Hit {
	return {
		url,
		title: url,
		snippet: "",
		siteName: null,
		favicon: null,
		publishedAt: null,
	};
}

describe("normalizeUrl", () => {
	it("去掉跟踪参数与片段, 其余参数排序, 主机名小写, 路径大小写保留", () => {
		expect(
			normalizeUrl(
				"https://Example.com/Path/?utm_source=x&b=2&a=1&gclid=1#frag",
			),
		).toBe("https://example.com/Path?a=1&b=2");
	});

	it("中文站点常见的跟踪参数", () => {
		expect(
			normalizeUrl("https://www.bilibili.com/video/BV1?vd_source=abc&p=2"),
		).toBe("https://bilibili.com/video/BV1?p=2");
		expect(
			normalizeUrl("https://detail.tmall.com/item.htm?id=1&spm=a.b.c"),
		).toBe("https://detail.tmall.com/item.htm?id=1");
	});

	it("统一为 https, 折叠 www", () => {
		expect(normalizeUrl("http://www.12306.cn/index/")).toBe(
			"https://12306.cn/index",
		);
	});

	it("折叠移动端子域", () => {
		expect(normalizeUrl("https://m.zhihu.com/question/1")).toBe(
			"https://zhihu.com/question/1",
		);
		expect(normalizeUrl("https://mobile.twitter.com/x")).toBe(
			"https://twitter.com/x",
		);
		expect(normalizeUrl("https://wap.example.cn/a")).toBe(
			"https://example.cn/a",
		);
	});

	it("只折叠首级子域, 注册域名本身不动", () => {
		expect(normalizeUrl("https://blog.m.example.com/")).toBe(
			"https://blog.m.example.com/",
		);
		expect(normalizeUrl("https://m.co.uk/")).toBe("https://m.co.uk/");
		expect(normalizeUrl("https://www.m.example.com/")).toBe(
			"https://m.example.com/",
		);
	});

	it("去掉路径尾部斜杠, 根路径保留", () => {
		expect(normalizeUrl("https://a.com/x//")).toBe("https://a.com/x");
		expect(normalizeUrl("https://a.com")).toBe("https://a.com/");
	});

	it("去掉默认端口与凭据", () => {
		expect(normalizeUrl("https://user:pw@a.com:443/x")).toBe("https://a.com/x");
	});

	it("中文路径与已编码路径得到同一结果", () => {
		const encoded = "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87";
		expect(normalizeUrl("https://zh.wikipedia.org/wiki/中文")).toBe(encoded);
		expect(normalizeUrl(encoded)).toBe(encoded);
	});

	it("无法解析或不是 http(s) 时返回 null", () => {
		expect(normalizeUrl("not a url")).toBeNull();
		expect(normalizeUrl("ftp://a.com/x")).toBeNull();
		expect(normalizeUrl("javascript:alert(1)")).toBeNull();
	});
});

describe("registrableDomain", () => {
	it("计入私有后缀", () => {
		expect(registrableDomain("rust-lang.github.io")).toBe(
			"rust-lang.github.io",
		);
		expect(registrableDomain("docs.python.org")).toBe("python.org");
		expect(registrableDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
	});

	it("IP 原样返回", () => {
		expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
	});
});

describe("gold 模式匹配", () => {
	const matches = (url: string, pattern: string) => {
		const parsed = parsePattern(pattern);
		const normalized = normalizeUrl(url);
		if (parsed === null || normalized === null) throw new Error("无法解析");
		return matchesPattern(normalized, parsed);
	};

	it("域名匹配自身与子域", () => {
		expect(matches("https://store.steampowered.com/", "steampowered.com")).toBe(
			true,
		);
		expect(matches("https://steampowered.com/", "steampowered.com")).toBe(true);
		expect(matches("https://notsteampowered.com/", "steampowered.com")).toBe(
			false,
		);
		expect(
			matches("https://help.steampowered.com/", "store.steampowered.com"),
		).toBe(false);
	});

	it("路径按段前缀匹配", () => {
		const pattern = "github.com/features/copilot";
		expect(matches("https://github.com/features/copilot", pattern)).toBe(true);
		expect(
			matches("https://github.com/features/copilot/plans?x=1", pattern),
		).toBe(true);
		expect(matches("https://github.com/features/copilotx", pattern)).toBe(
			false,
		);
		expect(matches("https://github.com/features", pattern)).toBe(false);
	});

	it("模式与结果同样规范化", () => {
		expect(
			matches("http://12306.cn/index/", "https://www.12306.cn/index/"),
		).toBe(true);
		expect(matches("https://m.zhihu.com/q/1", "zhihu.com")).toBe(true);
	});
});

describe("normalizeHits", () => {
	it("按规范化 URL 去重, 保留首次出现与原有顺序, 再截断到 k 条", () => {
		const result = normalizeHits(
			[
				hit("https://a.com/x?utm_source=1"),
				hit("not a url"),
				hit("https://b.com/"),
				hit("http://www.a.com/x/"),
				hit("https://c.com/"),
				hit("https://d.com/"),
			],
			3,
		);
		expect(result.hits.map((h) => h.normalizedUrl)).toEqual([
			"https://a.com/x",
			"https://b.com/",
			"https://c.com/",
		]);
		expect(result.hits[0]?.url).toBe("https://a.com/x?utm_source=1");
		expect(result.hits[0]?.domain).toBe("a.com");
		expect(result.duplicates).toBe(1);
		expect(result.invalid).toBe(1);
	});

	it("空列表", () => {
		expect(normalizeHits([], 10)).toEqual({
			hits: [],
			duplicates: 0,
			invalid: 0,
		});
	});
});
