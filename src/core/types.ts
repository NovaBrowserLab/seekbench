import { z } from "zod";

/** 查询语言. 被测对象只区分中英文. */
export const SearchLang = z.enum(["zh", "en"]);
export type SearchLang = z.infer<typeof SearchLang>;

/** 场景语言. mixed 表示场景内中英文混合, 逐条按查询判断. */
export const ScenarioLang = z.enum(["zh", "en", "mixed"]);
export type ScenarioLang = z.infer<typeof ScenarioLang>;

export const Intent = z.enum([
	"navigational",
	"informational",
	"descriptive",
	"fresh",
	"ambiguous",
	"research",
	"longtail",
]);
export type Intent = z.infer<typeof Intent>;

export const Freshness = z.enum(["day", "week", "month", "year"]);
export type Freshness = z.infer<typeof Freshness>;

/** 标注层级: A 层有人工 gold, B 层只有意图说明. */
export const Tier = z.enum(["A", "B"]);
export type Tier = z.infer<typeof Tier>;

/** 用例来源: 手写 / 按模板合成 / 公开数据集 / 日志导入批次. */
export const CaseSource = z.union([
	z.literal("handwritten"),
	z.templateLiteral(["synth:", z.string().min(1)]),
	z.templateLiteral(["public:", z.string().min(1)]),
	z.templateLiteral(["log:", z.string().min(1)]),
]);
export type CaseSource = z.infer<typeof CaseSource>;

/** 域名, 不带协议与路径. */
const Domain = z
	.string()
	.regex(/^[^\s/:?#]+\.[^\s/:?#]+$/, "应为不带协议与路径的域名");

/** 目标: URL 或域名, 可带路径, 按前缀匹配. */
const Target = z
	.string()
	.regex(
		/^(https?:\/\/)?[^\s/:?#]+\.[^\s/:?#]+(\/\S*)?$/,
		"应为 URL 或域名 (可带路径)",
	);

/** 合成 B 层用例的一个模板: 生成哪一类查询. */
export const SynthTemplate = z.strictObject({
	id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
	/** 交给模型的生成说明: 这一类查询长什么样、覆盖哪些主题、避免什么. */
	instruction: z.string().min(1),
	/** 目标条数, dataset:synth 补足到这个数为止. */
	count: z.int().positive(),
});
export type SynthTemplate = z.infer<typeof SynthTemplate>;

export const Scenario = z.strictObject({
	id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
	/** 题库版本, 用例变更即升版本; 不同版本的结果不可比. */
	version: z.string().min(1),
	lang: ScenarioLang,
	intent: Intent,
	/** 这类查询在真实产品里对应什么用法. */
	description: z.string().min(1),
	/** 交给裁判的打分说明. */
	rubric: z.string().min(1),
	/** 等级刻度, 下标即等级, 每一级写出可执行的定义. 省略时用默认的 0 到 3 刻度, 上限 0 到 4. */
	scale: z.array(z.string().min(1)).min(4).max(5).optional(),
	/** 评测深度. */
	k: z.int().positive().default(10),
	/** 用例 JSONL 的路径, 相对场景文件所在目录. */
	casesFile: z.string().min(1),
	/** 合成 B 层用例的模板. */
	synth: z.array(SynthTemplate).min(1).optional(),
});
export type Scenario = z.infer<typeof Scenario>;

export const Gold = z.strictObject({
	/** 导航类的目标 URL 或域名, 命中即满分. */
	targets: z.array(Target).min(1).optional(),
	/** 应当出现的权威域名, 算覆盖率. */
	mustDomains: z.array(Domain).min(1).optional(),
	/** 仿冒、内容农场等, 出现即记 0. */
	badDomains: z.array(Domain).min(1).optional(),
	/** 结果发布时间应在此窗口内. */
	freshWithinDays: z.int().positive().optional(),
	/** 歧义查询的各个含义. 上限 4 个, 与裁判输出的 meaning 枚举一致. */
	meanings: z.array(z.string().min(1)).min(2).max(4).optional(),
});
export type Gold = z.infer<typeof Gold>;

export const CaseOptions = z.strictObject({
	freshness: Freshness.optional(),
	site: Domain.optional(),
});

export const Case = z.strictObject({
	id: z.string().min(1),
	query: z.string().trim().min(1),
	tier: Tier,
	source: CaseSource,
	/** 查询的真实意图, 供裁判与人工阅读. */
	note: z.string().optional(),
	gold: Gold.optional(),
	options: CaseOptions.optional(),
});
export type Case = z.infer<typeof Case>;

export const SearchOptions = z.object({
	lang: SearchLang,
	count: z.int().positive(),
	freshness: Freshness.optional(),
	site: z.string().optional(),
	signal: z.instanceof(AbortSignal).optional(),
});
export type SearchOptions = z.infer<typeof SearchOptions>;

export const Hit = z.object({
	url: z.string().min(1),
	title: z.string(),
	/** 纯文本摘要. */
	snippet: z.string(),
	siteName: z.string().nullable(),
	favicon: z.string().nullable(),
	publishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Hit = z.infer<typeof Hit>;

export const SubjectResponse = z.object({
	hits: z.array(Hit),
	totalEstimate: z.number().nonnegative().nullable(),
	/** 原始响应, 只在 record 模式写入录制. */
	raw: z.unknown().optional(),
	/** 本次调用的美元费用, 由适配器按计费模型算出. */
	cost: z.number().nonnegative(),
	/** 实际发出的请求数, 策略会大于 1. */
	calls: z.int().nonnegative(),
	/** 适配器的诊断信息: 重试次数与供应商返回的请求 id. */
	diagnostics: z
		.object({
			retries: z.int().nonnegative(),
			requestId: z.string().nullable(),
		})
		.optional(),
});
export type SubjectResponse = z.infer<typeof SubjectResponse>;

export const SubjectKind = z.enum(["provider", "strategy"]);
export type SubjectKind = z.infer<typeof SubjectKind>;

/** 被测对象: 给一个查询, 返回一组排好序的结果. 供应商适配器与策略共用此接口. */
export interface SearchSubject {
	readonly id: string;
	readonly kind: SubjectKind;
	readonly langs: readonly SearchLang[];
	search(query: string, options: SearchOptions): Promise<SubjectResponse>;
	/** 从录制的原始响应重新归一化, 归一化逻辑修正后回放不必重新请求. 没有原始响应的被测对象不实现. */
	replay?(raw: unknown, query: string, options: SearchOptions): SubjectResponse;
}

/** 相关性等级. 默认刻度 0 到 3, 上限 0 到 4. */
export const Grade = z.int().min(0).max(4);

/** 等级的来源: 按标注的规则、LLM 裁判, 或人工复核 (覆盖裁判等级). */
export const GradeSource = z.enum(["rule", "judge", "human"]);

/** 来源层级: 官方或一手 / 可靠媒体、文档、机构 / 论坛、问答、个人博客 / 内容农场、仿冒、广告页. */
export const SourceTier = z.enum([
	"official",
	"reputable",
	"ugc",
	"suspicious",
]);

/** 内容是否已过时, 按内容判断, 与发布时间无关. */
export const Staleness = z.enum(["fresh", "stale", "unknown"]);

/** 歧义场景下结果所属的含义: 用例 meanings 的下标, 都不是则为 other. */
export const Meaning = z.enum(["0", "1", "2", "3", "other"]);
export type Meaning = z.infer<typeof Meaning>;

/** 裁判对单条结果的结构化输出, 同时作为模型的结构化输出约束与解析校验. */
export const Judgment = z.object({
	/** 一句话理由, 先于等级生成, 提高一致性, 也供人工复核阅读. */
	reason: z.string().max(200),
	/** 相关性等级, nDCG 等指标的输入. 取值范围由 rubric 的刻度决定, 默认 0 到 3. */
	grade: z.literal([0, 1, 2, 3]),
	sourceTier: SourceTier,
	stale: Staleness,
	meaning: Meaning.optional(),
});
export type Judgment = z.infer<typeof Judgment>;

/** 按刻度与用例的含义数生成裁判输出 schema: grade 取刻度内的整数, meaning 只列出该用例存在的下标. */
export function judgmentSchema(options: { maxGrade: 3 | 4; meanings: number }) {
	const grades =
		options.maxGrade === 4
			? ([0, 1, 2, 3, 4] as const)
			: ([0, 1, 2, 3] as const);
	const indexes = Meaning.options.slice(0, Math.min(options.meanings, 4));
	const base = z.object({
		reason: z.string().max(200),
		grade: z.literal(grades),
		sourceTier: SourceTier,
		stale: Staleness,
	});
	return indexes.length > 0
		? base.extend({ meaning: z.enum([...indexes, "other"]) })
		: base;
}

export const RunMode = z.enum(["live", "record", "replay"]);
export type RunMode = z.infer<typeof RunMode>;

/** 归一化并打过规则分的一条结果, 写入运行明细. */
export const ScoredHit = Hit.extend({
	/** 去重截断后的名次, 从 1 开始. */
	rank: z.int().positive(),
	normalizedUrl: z.string(),
	/** 注册域名. */
	domain: z.string(),
	/** 命中 gold.targets. */
	target: z.boolean(),
	/** 命中 gold.badDomains. */
	bad: z.boolean(),
	/** 相对 gold.freshWithinDays 的时效判断; 用例没有时效要求时为 null. */
	fresh: z.enum(["in", "out", "unknown"]).nullable(),
	/** 未判定为 null. */
	grade: Grade.nullable(),
	gradeSource: GradeSource.nullable(),
	/** 裁判标注的含义, 歧义场景用. */
	meaning: Meaning.nullable(),
	/** 人工复核覆盖前的裁判等级, 只在 gradeSource 为 human 时有. */
	judgeGrade: Grade.optional(),
	/** 裁判给出等级时的其余字段. */
	judgment: z
		.object({
			reason: z.string(),
			sourceTier: SourceTier,
			stale: Staleness,
		})
		.optional(),
});
export type ScoredHit = z.infer<typeof ScoredHit>;

export const ExecutionError = z.object({
	kind: z.enum(["timeout", "error"]),
	message: z.string(),
	/** 供应商返回的 HTTP 状态, 没有则为 null. */
	status: z.int().nullable(),
});
export type ExecutionError = z.infer<typeof ExecutionError>;

/** 一次执行 (场景, 用例, 被测对象, 重复序号) 的明细, cases.jsonl 的一行. */
export const CaseRecord = z.object({
	scenario: z.string(),
	caseId: z.string(),
	subject: z.string(),
	rep: z.int().nonnegative(),
	startedAt: z.iso.datetime(),
	latencyMs: z.number().nonnegative(),
	cost: z.number().nonnegative(),
	calls: z.int().nonnegative(),
	retries: z.int().nonnegative(),
	requestId: z.string().nullable(),
	totalEstimate: z.number().nullable(),
	/** 被测对象返回的原始条数, 归一化之前. */
	rawCount: z.int().nonnegative(),
	/** 归一化后与前面重复而丢弃的条数. */
	duplicates: z.int().nonnegative(),
	/** URL 无法解析而丢弃的条数. */
	invalid: z.int().nonnegative(),
	hits: z.array(ScoredHit),
	error: ExecutionError.nullable(),
	/** 结果的录制时间, 只在 record 与 replay 模式有. */
	recordedAt: z.iso.datetime().optional(),
});
export type CaseRecord = z.infer<typeof CaseRecord>;

export const QualityMetric = z.enum([
	"hit1",
	"hit3",
	"hitK",
	"mrr",
	"ndcg",
	"p5",
	"coverage",
	"meaningCoverage",
	"risk",
	"fresh",
	"freshUnknown",
	"diversity",
]);
export type QualityMetric = z.infer<typeof QualityMetric>;

/** 场景级指标的点估计与 bootstrap 置信区间. n 为参与计算的用例数. */
export const Estimate = z.object({
	mean: z.number(),
	low: z.number(),
	high: z.number(),
	n: z.int().nonnegative(),
});
export type Estimate = z.infer<typeof Estimate>;

/** 场景 × 被测对象 × 层的聚合结果. */
export const ScenarioSummary = z.object({
	scenario: z.string(),
	version: z.string(),
	subject: z.string(),
	tier: z.enum(["A", "B", "all"]),
	cases: z.int().nonnegative(),
	executions: z.int().nonnegative(),
	/** 不适用的指标为 null. */
	quality: z.record(QualityMetric, Estimate.nullable()),
	/** 有等级的结果占全部结果的比例. */
	judgedRate: z.number().nullable(),
	robustness: z.object({
		errorRate: z.number(),
		timeoutRate: z.number(),
		emptyRate: z.number().nullable(),
		duplicateRate: z.number().nullable(),
	}),
	/** 成功执行的墙钟耗时, 毫秒. */
	latency: z
		.object({
			p50: z.number(),
			p90: z.number(),
			p99: z.number(),
			max: z.number(),
		})
		.nullable(),
	cost: z.object({ per1k: z.number(), callsMean: z.number() }),
});
export type ScenarioSummary = z.infer<typeof ScenarioSummary>;

export const RunSettings = z.object({
	reps: z.int().positive(),
	timeoutMs: z.int().positive(),
	concurrency: z.int().positive(),
	filters: z.object({
		tier: Tier.optional(),
		source: z.string().optional(),
		/** 每个场景只取过滤后的前若干条用例. */
		limit: z.int().positive().optional(),
	}),
});
export type RunSettings = z.infer<typeof RunSettings>;

export const RunScenario = z.object({
	id: z.string(),
	version: z.string(),
	lang: ScenarioLang,
	intent: Intent,
	k: z.int().positive(),
	description: z.string(),
	cases: z.int().nonnegative(),
});
export type RunScenario = z.infer<typeof RunScenario>;

export const RunSubject = z.object({
	id: z.string(),
	kind: SubjectKind,
	configHash: z.string(),
	cassetteDate: z.string().optional(),
});

/** 一次运行的计划快照, 写入 progress.json, 续跑时不依赖当前配置文件. */
export const RunPlan = z.object({
	mode: RunMode,
	/** record 模式下重新请求已有录制的条目. 默认复用, 只补录缺的. */
	refresh: z.boolean().optional(),
	region: z.string().optional(),
	/** 用 --scenarios-dir 覆盖了场景目录时记录其绝对路径, 续跑与裁判沿用. */
	scenariosDir: z.string().optional(),
	settings: RunSettings,
	scenarios: z.array(RunScenario.extend({ casesHash: z.string() })),
	subjects: z.array(
		RunSubject.extend({ config: z.record(z.string(), z.unknown()) }),
	),
});
export type RunPlan = z.infer<typeof RunPlan>;

export const Progress = z.object({
	runId: z.string(),
	status: z.enum(["running", "interrupted", "finished"]),
	startedAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	plan: RunPlan,
	total: z.int().nonnegative(),
	done: z.int().nonnegative(),
	errors: z.int().nonnegative(),
});
export type Progress = z.infer<typeof Progress>;

/** 人工抽样复核与裁判的一致程度. */
export const Agreement = z.object({
	/** 参与比较的条数. */
	n: z.int().nonnegative(),
	/** 等级完全一致的比例. */
	exact: z.number(),
	/** 等级相差不超过 1 的比例. */
	withinOne: z.number(),
	/** 二次加权 Kappa; 样本里只有一种等级时无定义, 为 null. */
	kappa: z.number().nullable(),
});
export type Agreement = z.infer<typeof Agreement>;

export const RunJudge = z.object({
	model: z.string(),
	/** 裁判提示词模板的版本; 各场景的 rubric 另有哈希, 见裁判缓存的文件名. */
	rubricVersion: z.string(),
	fetch: z.boolean(),
	/** 送裁判的结果条数, 其中命中缓存与未能判定的条数, 以及实际调用次数与 token 用量. */
	usage: z
		.object({
			items: z.int().nonnegative(),
			cached: z.int().nonnegative(),
			failed: z.int().nonnegative(),
			calls: z.int().nonnegative(),
			inputTokens: z.int().nonnegative(),
			outputTokens: z.int().nonnegative(),
		})
		.optional(),
	/** 人工抽样复核的结果, judge:audit 写入. 可选; 没有时成绩只按裁判等级计算. */
	audit: Agreement.extend({
		/** 等级被人工等级覆盖的结果条数 (同一内容在多个被测对象里各算一条). */
		applied: z.int().nonnegative().optional(),
	}).optional(),
});
export type RunJudge = z.infer<typeof RunJudge>;

/** run.json: 一次运行的自包含记录. */
export const Run = z.object({
	id: z.string(),
	startedAt: z.iso.datetime(),
	finishedAt: z.iso.datetime(),
	mode: RunMode,
	region: z.string().optional(),
	settings: RunSettings,
	scenarios: z.array(RunScenario),
	subjects: z.array(RunSubject),
	judge: RunJudge.nullable(),
	weights: z.record(z.string(), z.number()).optional(),
	summary: z.array(ScenarioSummary),
});
export type Run = z.infer<typeof Run>;
