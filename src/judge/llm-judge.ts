import {
	APICallError,
	generateText,
	NoObjectGeneratedError,
	Output,
	RetryError,
} from "ai";
import { z } from "zod";
import { mulberry32, seedFrom } from "../core/bootstrap.ts";
import type { ModelHandle } from "../core/model.ts";
import type { Scenario } from "../core/types.ts";
import type { CachedJudgment } from "./cache.ts";
import {
	batchSchema,
	buildPrompt,
	type JudgeCase,
	type JudgeItem,
} from "./rubric.ts";

export interface BatchUsage {
	calls: number;
	inputTokens: number;
	outputTokens: number;
}

export interface BatchResult {
	/** 键为 JudgeItem.key. 两次尝试后仍没有合法判定的结果不在其中. */
	judgments: Map<string, CachedJudgment>;
	usage: BatchUsage;
}

/** 鉴权失败、模型不存在一类错误, 继续调用也不会好, 中止整个裁判步骤. */
export class JudgeFatalError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "JudgeFatalError";
	}
}

function apiStatus(error: unknown): number | null {
	const cause = RetryError.isInstance(error) ? error.lastError : error;
	return APICallError.isInstance(cause) ? (cause.statusCode ?? null) : null;
}

/** Fisher-Yates 洗牌, 种子取自查询与本批结果, 同一批输入得到同一顺序. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
	const random = mulberry32(seed);
	const out = [...items];
	for (let index = out.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[out[index], out[other]] = [out[other] as T, out[index] as T];
	}
	return out;
}

/** 从模型输出里逐项取出合法的判定; 单项不合法只丢这一项, 留待重试. */
function collect(
	output: unknown,
	ids: ReadonlyMap<string, JudgeItem>,
	itemSchema: z.ZodType<CachedJudgment & { id: string }>,
	into: Map<string, CachedJudgment>,
): void {
	const list = z.object({ judgments: z.array(z.unknown()) }).safeParse(output);
	if (!list.success) return;
	for (const raw of list.data.judgments) {
		const id = z.object({ id: z.string() }).safeParse(raw);
		if (!id.success) continue;
		const item = ids.get(id.data.id);
		if (!item || into.has(item.key)) continue;
		const parsed = itemSchema.safeParse(raw);
		if (!parsed.success) continue;
		const { id: _, ...judgment } = parsed.data;
		into.set(item.key, judgment);
	}
}

function parseJson(text: string | undefined): unknown {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export interface JudgeBatchOptions {
	scenario: Scenario;
	kase: JudgeCase;
	items: readonly JudgeItem[];
	/** 提示词里的今天, YYYY-MM-DD. */
	today: string;
	signal?: AbortSignal;
}

/**
 * 一次调用判定一条查询下的一批结果: 打乱顺序、以 r1, r2… 编号后送裁判, temperature 为 0.
 * 输出不合法或缺项时, 对缺的那些再试一次; 仍缺的不返回, 由调用方记为未判定.
 */
export async function judgeBatch(
	handle: ModelHandle,
	options: JudgeBatchOptions,
): Promise<BatchResult> {
	const { scenario, kase } = options;
	const schema = batchSchema(scenario, kase.meanings?.length ?? 0);
	const itemSchema = schema.shape.judgments.element as z.ZodType<
		CachedJudgment & { id: string }
	>;
	const schemaText = handle.structuredOutputs
		? undefined
		: JSON.stringify(z.toJSONSchema(schema));
	const usage: BatchUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
	const judgments = new Map<string, CachedJudgment>();

	for (let attempt = 0; attempt < 2; attempt++) {
		const pending = options.items.filter((item) => !judgments.has(item.key));
		if (pending.length === 0) break;
		const order = shuffle(
			pending,
			seedFrom(`${kase.query}|${attempt}|${pending.map((i) => i.key).join()}`),
		);
		const ids = new Map(order.map((item, index) => [`r${index + 1}`, item]));
		const prompt = buildPrompt(
			scenario,
			kase,
			[...ids].map(([id, item]) => ({ id, item })),
			{ today: options.today, schemaText },
		);
		usage.calls++;
		let output: unknown;
		try {
			const result = await generateText({
				model: handle.model,
				system: prompt.system,
				prompt: prompt.prompt,
				output: Output.object({ schema }),
				temperature: 0,
				maxRetries: 3,
				providerOptions: handle.providerOptions,
				...(options.signal && { abortSignal: options.signal }),
			});
			usage.inputTokens += result.usage.inputTokens ?? 0;
			usage.outputTokens += result.usage.outputTokens ?? 0;
			output = result.output;
		} catch (error) {
			if (NoObjectGeneratedError.isInstance(error)) {
				usage.inputTokens += error.usage?.inputTokens ?? 0;
				usage.outputTokens += error.usage?.outputTokens ?? 0;
				output = parseJson(error.text);
			} else {
				const status = apiStatus(error);
				if (status === 401 || status === 403 || status === 404) {
					throw new JudgeFatalError(
						`裁判接口返回 HTTP ${status}, 检查密钥与模型名`,
						{ cause: error },
					);
				}
				throw error;
			}
		}
		collect(output, ids, itemSchema, judgments);
	}
	return { judgments, usage };
}
