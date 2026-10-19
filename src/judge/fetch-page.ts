import { stripHtml } from "../adapters/_shared.ts";
import { CONTENT_LIMIT } from "./rubric.ts";

/** 抓取正文最多读这么多字节, 避免大文件拖慢裁判. */
const MAX_BYTES = 2_000_000;

const TIMEOUT_MS = 10_000;

/** 去掉不含正文的元素后转纯文本. 只做粗提取, 够裁判判断页面讲什么即可. */
export function htmlToText(html: string): string {
	return stripHtml(
		html.replace(
			/<(head|script|style|noscript|svg|template|nav|footer)\b[\s\S]*?<\/\1\s*>/gi,
			" ",
		),
	);
}

async function readLimited(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => {});
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/** 抓取网页并取正文开头的一段, 供 --judge-fetch 使用. 非 HTML、非 2xx 或失败时返回 null. */
export async function fetchPageText(
	url: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	try {
		const response = await fetchImpl(url, {
			headers: {
				accept: "text/html,text/plain;q=0.9",
				"user-agent":
					"seekbench (+https://github.com/NovaBrowserLab/seekbench)",
			},
			redirect: "follow",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const type = response.headers.get("content-type") ?? "";
		if (!response.ok || !/text\/html|text\/plain/i.test(type)) {
			await response.body?.cancel().catch(() => {});
			return null;
		}
		const body = await readLimited(response);
		const text = /html/i.test(type) ? htmlToText(body) : stripHtml(body);
		return text === "" ? null : text.slice(0, CONTENT_LIMIT);
	} catch {
		if (signal?.aborted) throw signal.reason;
		return null;
	}
}
