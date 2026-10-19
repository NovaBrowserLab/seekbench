# seekbench 技术架构

seekbench 是一个通用的搜索场景 Benchmark：用一个按场景组织、带标注的大规模查询集，对多家搜索服务与多种搜索策略做可复现的横向对比，输出质量、时延、费用三个维度的数据，为搜索选型提供依据。

本文描述边界、核心概念、数据模型、运行流程、技术选型与里程碑。文末列出后续待考量的问题。

## 1. 目标与边界

**要回答的问题：**

1. 在某一类搜索场景下（如中文官网导航、英文教程查找、时效新闻、研究型问题），哪家搜索服务的结果最好？
2. 同一家服务在不同场景下的表现差多少？是否值得按场景分流？
3. 一种策略（查询改写、多家融合、语义与关键词混合、搜索后抓取重排）相比单家直连，质量提升多少，多付出多少时延和费用？
4. 服务升级或策略改动后，有没有退步？

**衡量的三个维度：**

| 维度 | 说明 |
| --- | --- |
| 质量 | 结果与查询意图的相关性、权威性、覆盖面、时效、风险（仿冒、广告） |
| 时延 | 每次查询的墙钟耗时，看分布不看平均 |
| 费用 | 每千次查询的美元成本，按各家计费模型折算 |

**不做的事：**

- 不评测基于搜索结果生成的回答。被测对象止于「一组排好序的结果」；回答质量是下游系统的事。
- 不做固定语料库的检索榜单（BEIR、MS MARCO 那类）。seekbench 评测开放网页搜索，标注落在 URL 与域名上，不维护语料库。
- 不做人工标注平台。人工标注只用于校准裁判与抽样复核，用 JSON 文件维护。

**规模要求：** 题库总量定在 3000 条以上，分布在 12 个左右的场景，每个场景 150 到 400 条，之后持续扩充到 10000 条以上。题库怎么做到这个规模见 §3.1。

**场景覆盖要求：** 场景集合必须覆盖典型产品中的搜索用法：即时的官网导航与风险提示、带检索方向拆解的信息查找、歧义消解、多来源的研究型问题、描述性的语义查询。每个场景在 §3.1 的表里注明对应的产品用法。

## 2. 总体结构

```text
                    datasets/scenarios/*.jsonl            seekbench.config.ts
                    (查询 + 标注，分层，带版本)             (被测对象、裁判、场景权重)
                              │                                │
                              ▼                                ▼
                    ┌────────────────────────────────────────────────┐
                    │                    Runner                      │
                    │   场景 × 被测对象 × 重复次数 → 逐条执行并计时     │
                    └───────┬──────────────────────────┬─────────────┘
                            │                          │
            ┌───────────────▼──────────────┐   ┌───────▼──────────────────┐
            │          Subjects            │   │        Cassettes         │
            │  provider: bocha / brave /   │◄──│  live / record / replay  │
            │     exa / deepseek / tavily  │   │  按 (被测, 场景) 分片存储  │
            │  strategy: route / fusion /  │   └──────────────────────────┘
            │     rewrite / rerank / http  │
            └───────────────┬──────────────┘
                            │ 归一化结果 (Hit[])
                            ▼
            ┌──────────────────────────────┐   ┌──────────────────────────┐
            │           Scorer             │   │          Judge           │
            │  规则打分 (gold 域名/URL、    │◄──│  LLM 裁判，分级相关性     │
            │  风险、时效) + 裁判打分合并   │   │  缓存 + 人工抽样复核      │
            └───────────────┬──────────────┘   └──────────────────────────┘
                            │ 逐条指标
                            ▼
            ┌──────────────────────────────┐
            │    Aggregator + Reporter     │
            │  runs/<run>/ 明细与报告        │
            │  results/ 公开的运行结果       │
            └──────────────────────────────┘
```

五个部分的职责：

- **Datasets**：场景与用例，Benchmark 的「题库」，分层、带版本。
- **Subjects**：被测对象。供应商适配器是最小单位，策略是供应商的组合；两者对 Runner 暴露同一个接口。
- **Cassettes**：供应商原始响应的录制与回放，本机离线重跑打分时不重复花钱。
- **Scorer / Judge**：规则打分与 LLM 裁判打分，裁判结果缓存，每次正式评测附带人工抽样复核。
- **Reporter**：运行记录、报告、两次运行对比。

## 3. 核心概念与数据模型

所有类型用 Zod 定义，既做运行时校验也导出 TypeScript 类型。题库与录制用 JSONL（一行一条，便于分片、追加与流式读取），配置与汇总用 JSON。

### 3.1 场景与用例（Dataset）

**场景（Scenario）** 是一组意图相近的查询，加上这类查询该如何打分。场景是选型的单位：结论永远是「在某场景下 A 优于 B」，不给脱离场景的总排名。

```ts
interface Scenario {
  id: string;                 // 'nav-zh', 'howto-en', 'fresh-zh'
  version: string;            // 题库版本，用例变更即升版本；不同版本的结果不可比
  lang: 'zh' | 'en' | 'mixed';
  intent: 'navigational' | 'informational' | 'descriptive' | 'fresh'
        | 'ambiguous' | 'research' | 'longtail';
  description: string;        // 这类查询在真实产品里对应什么用法
  rubric: string;             // 交给裁判的打分说明：什么算相关、什么算权威、什么算过时
  k: number;                  // 评测深度，默认 10
  casesFile: string;          // 用例 JSONL 的路径
}

interface Case {
  id: string;
  query: string;
  tier: 'A' | 'B';            // 标注层级，见下文
  source: string;             // 来源：handwritten / synth:<模板> / public:<数据集> / log:<导入批次>
  note?: string;              // 查询的真实意图，供裁判与人工阅读；B 层由模型生成，人工抽样复核
  gold?: {
    targets?: string[];       // 导航类：目标 URL 或域名（前缀匹配），命中即满分
    mustDomains?: string[];   // 信息、研究类：应当出现的权威域名，算覆盖率
    badDomains?: string[];    // 仿冒、内容农场等，出现即记 0
    freshWithinDays?: number; // 时效类：结果发布时间应在此窗口内
    meanings?: string[];      // 歧义类：各个含义的简述，算含义覆盖
  };
  options?: { freshness?: 'day' | 'week' | 'month' | 'year'; site?: string };
}
```

**标注分层。** 几千条查询不可能条条人工写 gold，题库按标注强度分两层，报告按层分别汇总：

| 层 | 标注 | 规模 | 来源 |
| --- | --- | --- | --- |
| A | 人工写的 gold（目标、权威域名、风险域名、含义） | 每场景 30 到 60 条 | 手写，含产品演示查询 |
| B | 只有意图说明，全靠裁判打分 | 每场景 100 到 300 条 | 按场景模板用模型合成，人工抽样复核（比例可配，默认 10%） |

A 层是锚：裁判的校准集从 A 层来，B 层的裁判结果用 A 层的一致率来背书。

**场景。** 每个场景的规模取上表 A 加 B 的中位数，总量约 3000 条：

| 场景 | 语言 | 意图 | 典型查询 | 对应产品用法 | 主要指标 |
| --- | --- | --- | --- | --- | --- |
| `nav-zh` | 中文 | 导航 | 「Steam 官网」「12306」 | 普通搜索，官网置顶与风险提示 | Hit@1、Hit@3、风险率 |
| `nav-en` | 英文 | 导航 | "github copilot pricing" | 同上 | Hit@1、Hit@3、风险率 |
| `howto-zh` | 中文 | 信息 | 「合适的 Java 21 教程」 | 增强搜索，方向拆解 | nDCG@10、覆盖率 |
| `howto-en` | 英文 | 信息 | "rust async book" | 同上 | nDCG@10、覆盖率 |
| `descriptive-zh` | 中文 | 描述性 | 「讲清楚虚拟线程调度原理的长文」 | 增强搜索的语义方向 | nDCG@10、P@5 |
| `descriptive-en` | 英文 | 描述性 | "essay on why monorepos fail at scale" | 同上 | nDCG@10、P@5 |
| `fresh-zh` | 中文 | 时效 | 「本周 AI 新闻」 | 带时效过滤的搜索 | 时效率、nDCG@10 |
| `fresh-en` | 英文 | 时效 | "latest node lts release notes" | 同上 | 时效率、nDCG@10 |
| `ambiguous-zh` | 中文 | 歧义 | 「CSP 报名」「苹果发布会」 | 增强搜索的歧义消解 | 含义覆盖、nDCG@10 |
| `research-zh` | 中文 | 研究 | 「研究生 Spark 计划的申请条件与往年录取情况」 | 研究搜索，多来源 | 覆盖率、域名多样性、nDCG@10 |
| `research-en` | 英文 | 研究 | "evidence on 4-day work week productivity" | 同上 | 覆盖率、域名多样性、nDCG@10 |
| `longtail-en` | 英文 | 长尾 | 具体报错信息、冷门 API | 页内助手与追问 | MRR、空结果率 |
| `longtail-zh` | 中文 | 长尾 | 同上 | 同上 | MRR、空结果率 |

**题库工具链**（`seekbench dataset:*` 子命令）：

- `synth`：按场景模板与种子查询调用模型合成 B 层查询，去重（归一化后编辑距离与语义相似度双重去重），按配置的比例随机抽样写入复核队列。
- `import-log`：从私有查询日志文件（CSV 或 JSONL）导入，脱敏（去掉邮箱、手机号、身份证号等模式，丢弃过短与含个人姓名的查询），按语言与意图分类器粗分到场景，标 `source: log:<批次>`。导入结果写到 `datasets/private/`，该目录在 `.gitignore` 里，只在本机保存，不提交。
- `validate`：校验 schema、id 唯一、跨场景重复、gold 域名格式。
- `stats`：按场景、层、来源、语言输出数量与长度分布，报告里引用。

### 3.2 被测对象（Subject）

被测对象是「给一个查询，返回一组排好序的结果」的任何东西。两类：

- **Provider**：一家搜索服务的适配器，只负责把原始响应归一化。
- **Strategy**：供应商的组合或加工，如按语言分流、多家融合、查询改写、搜索后抓取重排。

两类暴露同一个接口：

```ts
interface SearchOptions {
  lang: 'zh' | 'en';
  count: number;
  freshness?: 'day' | 'week' | 'month' | 'year';
  site?: string;
  signal?: AbortSignal;
}

interface Hit {
  url: string;
  title: string;
  snippet: string;            // 纯文本
  siteName: string | null;
  favicon: string | null;
  publishedAt: string | null; // ISO 8601
}

interface SubjectResponse {
  hits: Hit[];
  totalEstimate: number | null;
  raw?: unknown;              // 原始响应，只在 record 模式写入录制，供日后重新归一化
  cost: number;               // 本次调用的美元费用，由适配器按计费模型算出
  calls: number;              // 策略会发多次请求，报告里要看到放大倍数
}

interface SearchSubject {
  readonly id: string;        // 'brave', 'fusion:brave+exa', 'http:my-pipeline@<版本>'
  readonly kind: 'provider' | 'strategy';
  readonly langs: readonly ('zh' | 'en')[];
  search(query: string, options: SearchOptions): Promise<SubjectResponse>;
  replay?(raw: unknown, query: string, options: SearchOptions): SubjectResponse; // 从录制的原始响应重新归一化
}
```

费用放在响应里而不是固定的每次单价，因为各家计费模型不同：有的按次，有的按返回条数，有的内容抓取另算。策略的费用是各次调用之和。

**第一批适配器**：博查、Brave、Exa、DeepSeek Search、Tavily。后续按需补充（阿里云 IQS、百度千帆、Serper、Jina 等），每家一个文件，不改核心。

**适配器规范**：

1. 只用原生 `fetch`，不装供应商 SDK；请求与响应结构用 Zod 描述，响应解析失败抛出带供应商名与 HTTP 状态的 `SubjectError`。
2. 超时由调用方的 `signal` 控制，默认 10 秒。
3. 对 429 与 5xx 做指数退避重试，最多 3 次，重试次数写进响应的诊断字段；4xx 其他错误不重试。
4. 每家一个令牌桶限速器，速率从配置读，默认取官方文档的免费档上限。
5. 费用计算写成纯函数，输入请求参数与响应，输出美元，单测覆盖各计费档。
6. 归一化只做字段映射与摘要去 HTML 标签，不做排序、去重、过滤；这些在核心层统一做，保证各家受同样处理。
7. 保留 `raw`，并记录供应商返回的请求 id（如有），排查问题时可对照。
8. 每家一份录制的响应作为测试夹具，单测断言归一化输出；测试不联网。
9. `docs/adapters/<id>.md` 记录端点、鉴权方式、计费模型、限速、已知怪癖与录制日期。

### 3.3 策略（Strategy）

策略是对 `SearchSubject` 的组合子，先实现四个：

| 策略 | 做什么 | 回答什么问题 |
| --- | --- | --- |
| `route` | 按查询语言或意图选供应商 | 分流比固定一家好多少 |
| `fusion` | 多家并行，RRF 融合排序 | 多付一倍钱换来多少质量 |
| `rewrite` | 先用模型改写或拆解查询，再搜索并合并 | 查询拆解这一步值不值 |
| `http` | 调用一个 HTTP 端点，要求返回 `SubjectResponse` 形状的 JSON | 把任何外部系统或自研流水线当黑盒评测 |

`http` 策略让任何系统都能被评测而不必改 seekbench：对方只要提供一个按约定返回 JSON 的端点。

### 3.4 指标（Metrics）

逐条用例计算，再按场景与层聚合。所有指标取前 `k` 条结果（默认 10）。

**相关性等级**：每条结果一个整数等级，默认 0 到 3。刻度是 rubric 的配置项，指标计算与刻度无关；要用更细的刻度，上限是 0 到 4，且每一级都必须像下面这样写出可执行的定义，否则裁判无法稳定区分。默认刻度的定义：

| 等级 | 名称 | 定义 | 判断依据 |
| --- | --- | --- | --- |
| 3 | 完全满足 | 这一条就能解决查询的意图，用户不需要再看别的结果 | 导航类是目标站点本身；信息类是直接回答问题的权威或一手来源；时效类是窗口内且内容对题 |
| 2 | 相关 | 内容对题、可用，但不是最好的那一条 | 回答了问题但不权威、不完整，或是转述、二手整理 |
| 1 | 沾边 | 与查询有关，但用户还要再跳转、筛选或自己拼凑 | 只覆盖查询的一部分，或是入口页、列表页、相关话题 |
| 0 | 无用 | 对这个查询没有价值，或有害 | 无关、错误、已过时、仿冒站点、内容农场、广告页 |

两级之间拿不准时取低的一级。规则能给出的判断优先：命中 `targets` 记 3；命中 `badDomains` 记 0；时效类且 `publishedAt` 超出窗口记 0。其余交给裁判。

**质量指标**：

| 指标 | 定义 | 适用 |
| --- | --- | --- |
| Hit@k | 前 k 条含任一 `targets` | 导航 |
| MRR | 第一条等级 ≥ 2 的结果的倒数排名 | 全部 |
| nDCG@k | 按等级算的折损累计增益，除以理想排序 | 信息、描述性、时效、研究 |
| P@5 | 前 5 条中等级 ≥ 2 的比例 | 全部 |
| 覆盖率 | `mustDomains` 中出现在前 k 条的比例 | 信息、研究 |
| 含义覆盖 | `meanings` 中至少有一条等级 ≥ 2 结果的含义占比，由裁判标注每条结果属于哪个含义 | 歧义 |
| 风险率 | 前 k 条中命中 `badDomains` 的比例 | 导航 |
| 时效率 | 前 k 条中 `publishedAt` 在窗口内的比例，缺失算未知单独统计 | 时效 |
| 域名多样性 | 前 k 条中不同注册域名数 / k | 研究、歧义 |

**健壮性指标**：错误率、超时率、空结果率、重复 URL 率（归一化后同一 URL 多次出现）。

**时延**：每条用例对每个被测对象重复 `reps` 次（默认 3，时延专项 5 到 10），记录每次墙钟耗时，按场景汇总 p50、p90、p99 与最大值。时延只在 live 模式有意义，报告里标明运行时间与机器所在区域。

**费用**：每千次查询的美元费用，等于场景内 `cost` 之和除以查询数再乘 1000。策略另报调用放大倍数（`calls` 的平均值）。

**综合分**：只在显式给出权重时计算，默认不算。权重写在配置里，按用途分档，例如「交互式搜索」看重时延，「后台研究」看重质量。公式和权重随结果一起写入文件，报告里不出现没有标注权重的总排名。

**置信区间**：每个场景级指标附 bootstrap 95% 置信区间（对用例重采样 1000 次）。题库上了规模之后，两家的差距是否显著才有意义，报告里用区间重叠与否来提示。

### 3.5 裁判（Judge）

LLM 裁判给每条结果打 §3.4 定义的等级，每次正式评测附带人工抽样复核。设计要点：

- **逐点打分，不做成对比较**。成对比较随被测对象数量平方增长，结果也无法缓存复用。
- **位置盲、来源盲**：裁判看不到结果在列表里的名次，也看不到来自哪家，只看 (查询, 意图说明, 标题, URL, 摘要, 发布时间)。同一次调用里把一条查询下各家的结果合并、去重、打乱后一起送，一条查询一次调用，减少费用也避免同一 URL 在不同家得到不同分。
- **输入只有标题与摘要**，默认不抓网页正文。摘要质量会影响得分，这是有意的：用户在结果页看到的也只有标题与摘要。可选 `--judge-fetch` 模式抓取正文后再判，用来回答「摘要差但页面好」的服务是否被低估。
- **结构化输出**：一个等级不足以说明一条结果好在哪、差在哪，裁判对每条结果输出几个字段。取值受限的字段一律用枚举，schema 同时作为模型的结构化输出约束与解析校验；temperature 为 0，解析失败重试一次，再失败记为未判定而不是 0：

  ```ts
  const Judgment = z.object({
    /** 一句话理由, 先于等级生成, 提高一致性, 也供人工复核阅读. */
    reason: z.string().max(200),
    /** 相关性等级, nDCG 等指标的输入. 取值范围由 rubric 的刻度决定, 默认 0 到 3. */
    grade: z.literal([0, 1, 2, 3]),
    /** 来源层级: 官方或一手 / 可靠媒体、文档、机构 / 论坛、问答、个人博客 / 内容农场、仿冒、广告页. */
    sourceTier: z.enum(['official', 'reputable', 'ugc', 'suspicious']),
    /** 内容是否已过时, 按内容判断, 与发布时间无关. */
    stale: z.enum(['fresh', 'stale', 'unknown']),
    /** 歧义场景下所属的含义, 取用例 meanings 的下标, 都不是则为 other. */
    meaning: z.enum(['0', '1', '2', '3', 'other']).optional(),
  });
  ```

  `sourceTier` 用于按场景算「前 k 条官方来源占比」一类指标，也让 rubric 可以按场景决定来源层级对等级的影响；`meaning` 的枚举按用例的 `meanings` 长度动态生成。
- **缓存**：键为 (裁判模型, 场景 rubric 版本, 查询, 归一化 URL, 摘要哈希)，存本机 `judgments/` 下的 JSONL。回放模式下裁判也走缓存，改打分逻辑后重跑不再付裁判费用。
- **校准**：A 层用例构成校准集，`seekbench judge:calibrate` 跑裁判并报告一致率与加权 Kappa。换裁判模型或改 rubric 都要先过校准，Kappa 低于 0.6 不采用。
- **人工抽样复核**：每次正式评测，`seekbench judge:sample` 按被测对象与等级分层随机抽 200 条 (查询, 结果, 裁判等级) 生成复核文件，人工填入等级后 `judge:audit` 计算一致率并写入该次运行的报告。复核过的标注并入校准集，校准集随每次发布增长。一致率写进报告，供读者判断该次结果的可信度。

裁判模型经 `ai` SDK 的 OpenAI 兼容端点接入，不绑定某一家。裁判与被测对象的模型互不影响：裁判是评测基础设施，被测的 `rewrite` 策略用什么模型是被测配置的一部分。

### 3.6 录制与回放（Cassette）

以 (被测对象 id, 查询, 选项) 的稳定序列化作为键，三种模式：

| 模式 | 行为 |
| --- | --- |
| `live` | 直连，不写录制。时延评测用 |
| `record` | 直连并写录制。同配置已录过的请求默认直接复用、不再请求，只补录缺的；`--refresh` 时全部重新请求并覆盖。建题库、扩题库或刷新快照时用 |
| `replay` | 只读录制 |

录制保存归一化后的 `hits`、`raw` 原始响应与录制时间。原始响应保留的原因：归一化逻辑修正后（比如摘要清洗），可以不重新付费地重跑。

**存储**：按 (被测对象, 场景) 分片，一片一个 gzip 压缩的 JSONL 文件，文件名含场景版本。录制与裁判缓存都只留在本机，目录在 `.gitignore` 里，不提交：它们是运行者的工作数据，复现靠重新运行 Benchmark，而不是靠拉别人的录制。

**时效**：时效类场景的回放只能验证打分逻辑，不能作为该场景的选型依据；报告里对每个被测对象标注录制日期，超过 30 天的录制醒目提示。

### 3.7 运行记录与结果（Run、Results）

一次运行写到 `runs/<run-id>/`，自包含，不依赖运行时配置：

```ts
interface Run {
  id: string;                 // <日期>-<短随机串>
  startedAt: string;
  finishedAt: string;
  mode: 'live' | 'record' | 'replay';
  region?: string;            // 机器所在区域，时延对比用
  scenarios: Array<{ id: string; version: string; cases: number }>;
  subjects: Array<{ id: string; kind: string; configHash: string; cassetteDate?: string }>;
  judge: { model: string; rubricVersion: string; fetch: boolean; auditAgreement?: number } | null;
  weights?: Record<string, number>;
  summary: ScenarioSummary[]; // 场景 × 被测对象 × 层的聚合指标与置信区间
}
```

目录内容：`run.json`（上面的结构）、`cases.jsonl.gz`（逐条明细：被测对象、用例、第几次重复、耗时、费用、hits 与等级、错误）、`report.md`、`audit.jsonl`（人工抽样复核）。`runs/` 在 `.gitignore` 里，是工作目录。

**公开结果**放 `results/<日期>-<题库版本>/`：公开某次运行时，把它的 `run.json`、`report.md` 与 `audit.jsonl` 复制进去提交。`report.md` 按场景列出各被测对象的主要指标、置信区间、时延 p50/p90、每千次费用、录制日期与裁判一致率，读者看这一个文件就够。没有发布流程，也没有门槛；公开的就是跑出来的结果。

## 4. 运行流程

```text
seekbench run --scenarios nav-zh,howto-en --subjects brave,bocha,exa --mode replay
```

1. 读配置，实例化被测对象；缺密钥的被测对象在 live 模式下跳过并告警，在 replay 模式下不需要密钥。
2. 读场景文件，校验 schema，固定用例顺序；可按层或按来源过滤。
3. 对每个 (场景, 用例, 被测对象, 重复序号) 组合执行搜索。全部是 I/O 等待，不需要线程：一个全局并发上限（默认 32 个在途请求）加每个被测对象自己的令牌桶限速器，瓶颈在各家的 QPS 配额而不在运行时。同一被测对象内按限速器排队，避免被限流把时延测歪。每次调用带超时（默认 10 秒），超时记为错误而不是无限等。进度持久化到 `runs/<run-id>/progress.json`，中断后 `--resume` 续跑。
4. 归一化：URL 规范化（去跟踪参数、统一大小写与尾部斜杠、移动端域名折叠）、按规范化 URL 去重、截断到 k 条。
5. 打分：先走规则，再把未判定的结果送裁判（先查缓存）。
6. 聚合并写运行记录，打印场景 × 被测对象的汇总表。
7. `seekbench report <run>` 生成 Markdown 报告；`seekbench compare <run-a> <run-b>` 输出逐指标差值、是否显著与退步最多的用例。

质量评测与时延评测分开跑：质量用 replay 保证可复现，时延用 live 多次重复。两者是不同的 run，榜单里分列。

## 5. 目录与技术选型

单个 pnpm 包，目录按职责划分；适配器变多、或要给外部当库用时，再拆成 workspace。

```text
seekbench/
  src/
    core/         types.ts (Zod)、runner.ts、normalize.ts、metrics.ts、bootstrap.ts、cassette.ts、report.ts
    adapters/     bocha.ts、brave.ts、exa.ts、deepseek.ts、tavily.ts、mock.ts、_shared.ts (重试、限速、费用)
    strategies/   route.ts、fusion.ts、rewrite.ts、http.ts
    judge/        rubric.ts、llm-judge.ts、cache.ts、calibrate.ts、sample.ts
    dataset/      synth.ts、import-log.ts、validate.ts、stats.ts
    cli/          index.ts：run、report、compare、record、judge:*、dataset:*
  datasets/
    scenarios/    <scenario>.json 与 <scenario>.cases.jsonl
    calibration/  labels.jsonl
    private/      导入的日志，不提交
  cassettes/      <subject>/<scenario>@<version>.jsonl.gz，本机，不提交
  judgments/      <judge-model>/<rubric-version>.jsonl，本机，不提交
  runs/           工作目录，不提交
  results/        公开的运行结果
  docs/           本文、adapters/、dataset.md（场景与标注规范）、judge.md（rubric 与复核流程）
  test/           metrics 用手算的期望值；adapters 用录制夹具；runner 用 mock 被测对象
  .github/workflows/  test.yml（PR 跑单测与 replay 冒烟）、bench.yml（仅手动触发）
  seekbench.config.ts
```

| 选择 | 理由 |
| --- | --- |
| TypeScript、Node 24、pnpm | 适配器就是 `fetch` 加 JSON 解析，裁判走 `ai` SDK；IR 指标公式简单，自行实现并用手算用例锁定即可 |
| `zod` 4 | 数据文件、裁判输出、供应商响应的校验与类型，一个方案解决三处 |
| `ai` + `@ai-sdk/openai-compatible` | 裁判、`rewrite` 策略、题库合成的模型接入；一个兼容端点接所有家，不逐家装 SDK |
| `node:util` `parseArgs` | CLI 参数解析，子命令不多，不引入 commander |
| 原生 `fetch` + `AbortSignal` | 所有适配器只用 `fetch`，形态一致、便于录制 |
| `tldts` | 注册域名提取，域名多样性与 gold 域名匹配用 |
| JSONL + gzip | 题库、录制、裁判缓存都是按行追加的数据，分片与流式读写友好 |
| `vitest`、Biome、lefthook、commitlint | 测试与工程规范 |
| GitHub Actions | PR 上跑单测与小规模 replay 冒烟；全量 Bench 的 workflow 只能手动触发，不定时、不随提交自动跑 |

## 6. 测试与验证顺序

1. `metrics.ts` 先于一切：每个指标有手算的期望值用例，包括等级全 0、全 3、k 大于结果数、结果为空等边界；nDCG 与公开实现（pytrec_eval 的已知输出）对几组数。
2. `normalize.ts`：URL 规范化与去重的用例集，中英文 URL、跟踪参数、移动端域名。
3. 适配器：每家一份录制响应做夹具，断言归一化输出、费用、重试与限速行为；不联网。
4. Runner：用 `mock` 被测对象跑一个微型场景，断言运行记录结构、错误与超时的记录方式、重复次数、中断续跑。
5. 裁判：用脚本化模型（固定输出）测解析、重试、缓存命中、抽样分层。
6. 题库工具：`validate` 对提交的题库全量校验；`synth` 的去重用构造的近似重复用例。
7. 端到端：用 `mock` 被测对象和一份提交进仓库的小规模录制跑全部场景，结果与基线对比，差异超阈值即 CI 失败。守住的是打分逻辑，不是供应商。

## 7. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 骨架 | 包结构、Zod 类型、metrics 与 normalize、bootstrap、mock 被测对象、`run` 与 `report` 命令 | mock 跑通一个手写场景，指标单测全绿 |
| M1 供应商与回放 | 博查、Brave、Exa、Tavily、DeepSeek Search 适配器与规范；录制回放；规则打分；`nav-zh`、`nav-en` 的 A 层 | replay 模式无密钥跑出五家导航对比表 |
| M2 裁判与题库工具 | LLM 裁判、缓存、校准、抽样复核；`dataset:synth`、`validate`、`stats`、`import-log`；`howto-*`、`descriptive-*` 扩到 B 层规模 | 校准 Kappa 达标；一次正式评测含人工复核 |
| M3 全量题库 | 其余场景补齐到 3000 条；`compare`；手动触发的 bench workflow | 公开第一份完整结果 |
| M4 策略 | `route`、`fusion`、`rewrite`、`http` 策略 | 回答「分流 / 融合 / 改写各值多少」 |
| M5 扩规模 | 题库到 10000 条，补充供应商 | 第二份结果，附与第一份的对比 |

## 8. 后续待考量

- **公开数据集**。ORCAS、Natural Questions、SimpleQA 一类带网页级标注的公开数据可以给题库补充真实用户查询，但许可证多限研究用途、URL 陈旧、点击不等于相关，中文几乎没有可用的。目前不接，题库靠 A、B 两层；将来规模或真实性不够时再评估。
- **Python 的 IR 评测库**。指标自行实现并用手算用例锁定；若后续分析需求变重，再考虑用 ranx 或 pytrec_eval 做交叉验证。
