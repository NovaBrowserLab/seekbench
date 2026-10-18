import { z } from "zod";

/** 逐行解析并校验 JSONL, 空行跳过. 出错时报告文件与行号. */
export function parseJsonl<T>(
	text: string,
	schema: z.ZodType<T>,
	label: string,
): T[] {
	const items: T[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`${label}:${index + 1} 不是合法的 JSON`);
		}
		const parsed = schema.safeParse(value);
		if (!parsed.success) {
			throw new Error(
				`${label}:${index + 1} 格式不符:\n${z.prettifyError(parsed.error)}`,
			);
		}
		items.push(parsed.data);
	}
	return items;
}

export function toJsonl(items: readonly unknown[]): string {
	return items.map((item) => `${JSON.stringify(item)}\n`).join("");
}
