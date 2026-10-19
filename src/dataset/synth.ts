import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { mulberry32, seedFrom } from "../core/bootstrap.ts";
import type { ModelHandle } from "../core/model.ts";
import type { Case, Scenario, SynthTemplate } from "../core/types.ts";
import { isNearDuplicate } from "./text.ts";

/** 每次调用给模型看的示例数与要求避开的已有查询数. */
const EXAMPLES = 12;
const AVOID = 60;

const SynthOutput = z.object({
	queries: z.array(
		z.object({
			query: z.string(),
			note: z.string(),
		}),
	),
});

/** 合成用例的人工复核队列 <reviewDir>/<场景>.jsonl 的一行. */
export const ReviewItem = z.object({
	caseId: z.string(),
	query: z.string(),
	note: z.string().optional(),
	/** pending 待复核; ok 无需修改; fixed 已在用例文件里改正; dropped 已从用例文件删除. */
	status: z.enum(["pending", "ok", "fixed", "dropped"]),
	comment: z.string().optional(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

function sample<T>(
	items: readonly T[],
	size: number,
	random: () => number,
): T[] {
	const pool = [...items];
	const out: T[] = [];
	while (out.length < size && pool.length > 0) {
		const index = Math.floor(random() * pool.length);
		out.push(pool.splice(index, 1)[0] as T);
	}
	return out;
}

export function synthPrompt(
	scenario: Scenario,
	template: SynthTemplate,
	options: {
		count: number;
		examples: readonly Pick<Case, "query" | "note">[];
		avoid: readonly string[];
		structuredOutputs: boolean;
	},
): { system: string; prompt: string } {
	const system = [
		"你在为一个开放网页搜索的评测集编写查询. 查询要像真实用户在搜索框里输入的那样: 长度、口语程度、错别字与缩写的比例都接近真实分布, 不要写成完整的问句范文.",
		"每条查询附一句意图说明 note: 用户真正想找什么、什么样的结果算好, 供评审判断. note 不要复述查询.",
		"同一批里的查询要彼此不同: 换主题、换说法、换细节, 不要只替换一两个词.",
		`只输出一个 JSON 对象, 形如 {"queries": [{"query": "...", "note": "..."}]}.`,
		...(options.structuredOutputs
			? []
			: ["", "JSON Schema:", JSON.stringify(z.toJSONSchema(SynthOutput))]),
	].join("\n");
	const lines = [
		"## 场景",
		scenario.description,
		"",
		"## 这一批要生成的查询",
		template.instruction,
		"",
		`生成 ${options.count} 条.`,
	];
	if (options.examples.length > 0) {
		lines.push(
			"",
			"## 示例 (同场景已有的查询, 风格参考, 不要照抄)",
			...options.examples.map(
				(example) =>
					`- ${example.query}${example.note ? ` (意图: ${example.note})` : ""}`,
			),
		);
	}
	if (options.avoid.length > 0) {
		lines.push(
			"",
			"## 已有的查询, 不要重复或只做轻微改写",
			...options.avoid.map((query) => `- ${query}`),
		);
	}
	return { system, prompt: lines.join("\n") };
}

export interface SynthOptions {
	scenario: Scenario;
	template: SynthTemplate;
	/** 场景里已有的全部用例, 用于示例、去重与编号. */
	existing: readonly Case[];
	/** 要新增的条数. */
	count: number;
	batchSize: number;
	temperature: number;
	seed: string;
	signal?: AbortSignal;
	onProgress?: (progress: { done: number; total: number }) => void;
}

export interface SynthResult {
	cases: Case[];
	/** 与已有或同批查询重复、近似重复而丢弃的条数. */
	duplicates: number;
	/** 空查询或超长而丢弃的条数. */
	invalid: number;
	calls: number;
	inputTokens: number;
	outputTokens: number;
}

/** 查询长度上限, 超过的视为模型输出了段落而不是查询. */
const MAX_QUERY_LENGTH = 120;

/**
 * 按模板合成 B 层用例: 每次调用要 batchSize 条, 去掉与已有用例及本批近似重复的, 直到凑够 count 条.
 * 连续多轮凑不出新的就停下, 返回已有的部分. 新用例的 id 为 <模板>-<序号>, 接着已有的最大序号编.
 */
export async function synthesize(
	handle: ModelHandle,
	options: SynthOptions,
): Promise<SynthResult> {
	const { scenario, template } = options;
	const random = mulberry32(seedFrom(options.seed));
	const known = options.existing.map((kase) => kase.query);
	const prefix = `${template.id}-`;
	let next =
		Math.max(
			0,
			...options.existing
				.filter((kase) => kase.id.startsWith(prefix))
				.map((kase) => Number(kase.id.slice(prefix.length)))
				.filter(Number.isFinite),
		) + 1;
	const result: SynthResult = {
		cases: [],
		duplicates: 0,
		invalid: 0,
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
	};
	const examplePool = [
		...options.existing.filter(
			(kase) => kase.source === `synth:${template.id}`,
		),
		...options.existing.filter((kase) => kase.tier === "A"),
	];
	const maxCalls = Math.ceil(options.count / options.batchSize) * 2 + 2;
	while (result.cases.length < options.count && result.calls < maxCalls) {
		options.signal?.throwIfAborted();
		const want = Math.min(
			options.batchSize,
			options.count - result.cases.length,
		);
		const prompt = synthPrompt(scenario, template, {
			count: want,
			examples: sample(examplePool, EXAMPLES, random),
			avoid: sample(known, AVOID, random),
			structuredOutputs: handle.structuredOutputs,
		});
		result.calls++;
		let output: z.infer<typeof SynthOutput> | null = null;
		try {
			const response = await generateText({
				model: handle.model,
				system: prompt.system,
				prompt: prompt.prompt,
				output: Output.object({ schema: SynthOutput }),
				temperature: options.temperature,
				maxRetries: 3,
				providerOptions: handle.providerOptions,
				...(options.signal && { abortSignal: options.signal }),
			});
			result.inputTokens += response.usage.inputTokens ?? 0;
			result.outputTokens += response.usage.outputTokens ?? 0;
			output = response.output;
		} catch (error) {
			if (!NoObjectGeneratedError.isInstance(error)) throw error;
			result.inputTokens += error.usage?.inputTokens ?? 0;
			result.outputTokens += error.usage?.outputTokens ?? 0;
			continue;
		}
		for (const item of output.queries) {
			if (result.cases.length >= options.count) break;
			const query = item.query.trim();
			const note = item.note.trim();
			if (query === "" || [...query].length > MAX_QUERY_LENGTH) {
				result.invalid++;
				continue;
			}
			if (known.some((other) => isNearDuplicate(query, other))) {
				result.duplicates++;
				continue;
			}
			known.push(query);
			result.cases.push({
				id: `${prefix}${String(next++).padStart(3, "0")}`,
				query,
				tier: "B",
				source: `synth:${template.id}`,
				...(note !== "" && { note }),
			});
		}
		options.onProgress?.({ done: result.cases.length, total: options.count });
	}
	return result;
}

/** 按比例随机抽取新用例写入复核队列, 至少一条. */
export function reviewSample(
	cases: readonly Case[],
	ratio: number,
	seed: string,
): ReviewItem[] {
	if (cases.length === 0 || ratio === 0) return [];
	const size = Math.max(1, Math.round(cases.length * ratio));
	return sample(cases, size, mulberry32(seedFrom(seed))).map((kase) => ({
		caseId: kase.id,
		query: kase.query,
		...(kase.note !== undefined && { note: kase.note }),
		status: "pending" as const,
	}));
}
