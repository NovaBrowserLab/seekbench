# 裁判与复核

设计见 [ARCHITECTURE.md §3.5](ARCHITECTURE.md#35-裁判judge)。本文是使用流程。

## 配置

`seekbench.config.ts` 的 `judge` 指定一个 OpenAI 兼容端点：

| 配置 | 说明 |
| --- | --- |
| `baseUrl`、`model`、`apiKeyEnv` | 接口地址、模型名、读取密钥的环境变量名 |
| `reasoningEffort` | 原样传给接口的 `reasoning_effort` |
| `structuredOutputs` | 接口支持 `json_schema` 时打开；默认关闭，用 `json_object` 并把 schema 写进提示词 |
| `rateLimit`、`concurrency` | 限速与在途调用数，默认每秒 5 次、8 个 |
| `maxItemsPerCall` | 一次调用最多判多少条结果，默认 50；一条查询的结果超过时拆成多次 |
| `fetch` | 是否抓网页正文一起送，默认否；命令行 `--judge-fetch` 覆盖 |
| `minKappa` | 校准通过的加权 Kappa 下限，默认 0.6 |
| `auditSize` | 人工复核抽样条数，默认 200 |

场景可以用 `scale` 换刻度（4 或 5 级，每级一句可执行的定义），省略时用默认的 0 到 3。

## 打分

`seekbench run` 跑完搜索后接着打裁判分，结果写进 `cases.jsonl.gz` 与 `run.json` 的 `judge`。规则已判定的结果（命中目标页、风险域名等）不送裁判。

- 缓存命中的不再调用，回放重跑不付裁判费用。
- 解析失败或漏判的条目单独重试一次，仍失败的记为未判定，不计 0 分；报告里的「判定率」是已判定结果的占比。
- 密钥无效、余额不足或模型不存在（401、402、403、404）时停止打分。中断或出错后用 `seekbench judge <run-id>` 补判，已判的走缓存。
- `--no-judge` 只做规则打分。

## 人工复核

可选。不做时成绩只按裁判等级计算；做了之后，复核过的结果改用人工等级。

1. `seekbench judge:sample <run-id>` 按 (被测对象, 等级) 分层抽样，写 `runs/<run-id>/audit.jsonl`。文件里只有裁判看到的内容（查询、意图说明、标题、URL、摘要、发布时间），没有裁判等级与被测对象。
2. 复核人逐行把 `grade` 从 `null` 改成等级，可在 `comment` 写理由。按场景的 rubric 判，拿不准时可以打开网页看，但等级仍以标题与摘要能支撑的为准。
3. `seekbench judge:audit <run-id>` 计算人工与裁判的完全一致率、相差不超过一级的比例与加权 Kappa，写进 `run.json` 与报告的「人工复核」一行；同时用人工等级覆盖对应结果的裁判等级并重算汇总，内容相同的结果在各被测对象里一起覆盖。已填的条目并入校准集 `datasets/calibration/labels.jsonl`。可以分几次填，每次都会重算；`seekbench judge` 重新打分会清掉人工等级，之后再执行一次 `judge:audit`。

## 校准

`seekbench judge:calibrate` 用校准集跑一遍裁判（走缓存），按场景与标注来源报告一致率、加权 Kappa 与混淆矩阵，Kappa 低于 `minKappa` 时以非零状态退出。换裁判模型、改提示词或 rubric 之前先过这一步。

校准集早期条数少，可以加 `--from-run <run-id>`，把该运行 A 层的规则判定一并作为标注：命中目标页记满分，命中风险域名记 0。
