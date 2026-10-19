# seekbench

通用的搜索场景 Benchmark，为搜索服务与搜索策略的选型提供依据。

[English](#english)

## 它回答什么

- 在某一类场景下（官网导航、教程查找、时效新闻、歧义查询、研究型问题），哪家搜索服务的结果更好？
- 同一家服务在不同场景下差多少，值不值得按场景分流？
- 查询改写、多家融合、搜索后重排这些策略，比单家直连好多少，多花多少时延和费用？
- 服务升级或策略改动后，有没有退步？

## 它怎么测

- **场景题库**：查询按场景组织，每个场景带打分说明。一部分由人工标注目标网页、权威域名与风险域名，其余由模型按场景合成、人工抽样复核。
- **被测对象**：搜索服务的适配器，以及由适配器组合而成的策略。两者对评测器暴露同一个接口，任何能「给一个查询、返回一组排好序结果」的系统都能接入。
- **打分**：先按标注做规则判断，其余交给 LLM 裁判给出 0 到 3 的相关性等级；裁判位置盲、来源盲，每次正式评测附人工抽样复核。
- **指标**：质量（Hit@k、MRR、nDCG@k、覆盖率、风险率、时效率等，附置信区间）、时延（p50 / p90 / p99）、费用（每千次查询）。结论按场景给出，不做脱离场景的总排名。
- **录制回放**：供应商响应可录制到本机，改打分逻辑后离线重跑不重复付费。

## 使用

Node.js 24 与 pnpm 12 的版本固定在 `package.json` 的 `devEngines` 里，装好 pnpm 后它会按需下载这两个版本。

```bash
pnpm install
pnpm seekbench run --scenarios smoke --subjects mock   # 用假被测对象跑流程自检场景
pnpm seekbench report                                   # 为最近一次运行生成 runs/<run-id>/report.md
```

接入的搜索服务有博查、Brave、DeepSeek、Exa、Tavily，密钥从 `BOCHA_API_KEY` 等环境变量读取，也可以写在仓库根目录的 `.env` 里（不提交）。缺密钥的服务会被跳过。

```bash
# 直连并录制到 cassettes/, 再离线回放; 回放不需要密钥
pnpm seekbench run --scenarios nav-zh,nav-en --subjects bocha,brave,deepseek,exa,tavily --mode record
pnpm seekbench run --scenarios nav-zh,nav-en --subjects bocha,brave,deepseek,exa,tavily --mode replay
```

`--mode` 有三种：`live` 直连（默认，测时延用，可重复多次）、`record` 直连并写录制、`replay` 只读录制。`record` 默认跳过已录过的请求，只补录新增的用例或被测对象；要整体刷新快照时加 `--refresh`。录制只保存在本机，不提交；质量对比用回放保证可复现，时延用直连多次重复。

被测对象、并发、超时与重复次数在 `seekbench.config.ts` 里配置，各家适配器的参数、计费与限速见 [docs/adapters/](docs/adapters/README.md)；`pnpm seekbench --help` 列出全部参数。运行中断后用 `--resume <run-id>` 续跑。

## 结果

公开的运行结果放在 `results/`，每次包含汇总指标与报告。

## 状态

已有：数据模型、URL 规范化、按标注的规则打分、质量指标与置信区间、带全局并发上限与限速的 Runner（超时、续跑）、`run` 与 `report` 命令；博查、Brave、DeepSeek、Exa、Tavily 五家适配器与录制回放；中英文官网导航场景（`nav-zh`、`nav-en`）的人工标注题库。尚未接入 LLM 裁判与其余场景。设计文档见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。

---

## English

A general-purpose benchmark for search scenarios, to help choose search providers and approaches.

**What it answers**

- For a given kind of query (site navigation, tutorials, fresh news, ambiguous queries, research questions), which search provider returns the best results?
- How much does one provider vary across scenarios, and is routing by scenario worth it?
- How much do strategies such as query rewriting, multi-provider fusion or post-search reranking gain over a single provider, and at what cost in latency and money?
- Did a provider upgrade or a strategy change regress anything?

**How it works**

- **Scenario datasets**: queries grouped by scenario, each scenario with its own grading guidance. Part of each set is hand-labeled with target pages, authoritative domains and risky domains; the rest is synthesized per scenario and spot-checked by people.
- **Subjects**: provider adapters, and strategies composed from them. Both expose the same interface, so anything that takes a query and returns a ranked list can be benchmarked.
- **Scoring**: rule-based judgments from the labels first, then an LLM judge assigns 0 to 3 relevance grades, blind to rank and provider; every formal run includes a human audit sample.
- **Metrics**: quality (Hit@k, MRR, nDCG@k, coverage, risk rate, freshness, with confidence intervals), latency (p50 / p90 / p99) and cost per thousand queries. Conclusions are reported per scenario; there is no overall leaderboard without scenario context.
- **Record and replay**: provider responses can be recorded locally so scoring changes can be re-run offline without paying again.

**Usage**

Node.js 24 and pnpm 12 are pinned in `devEngines` in `package.json`; once pnpm is installed, it downloads the pinned versions when needed.

```bash
pnpm install
pnpm seekbench run --scenarios smoke --subjects mock   # pipeline self-check with the mock subject
pnpm seekbench report                                   # writes runs/<run-id>/report.md for the latest run
```

Supported providers are Bocha, Brave, DeepSeek, Exa and Tavily. API keys are read from environment variables such as `BOCHA_API_KEY`, or from a `.env` file in the repository root (never committed). Providers without a key are skipped.

```bash
# call providers and record to cassettes/, then replay offline; replay needs no keys
pnpm seekbench run --scenarios nav-zh,nav-en --subjects bocha,brave,deepseek,exa,tavily --mode record
pnpm seekbench run --scenarios nav-zh,nav-en --subjects bocha,brave,deepseek,exa,tavily --mode replay
```

`--mode` is `live` (default; for latency, repeatable), `record` (live plus recording) or `replay` (recordings only). `record` skips requests that are already recorded and only fills in new cases or subjects; add `--refresh` to re-record everything. Recordings stay on the local machine and are not committed; quality comparisons use replay for reproducibility, latency uses repeated live runs.

Subjects, concurrency, timeouts and repetitions are configured in `seekbench.config.ts`; adapter options, pricing and rate limits are in [docs/adapters/](docs/adapters/README.md) (Chinese). `pnpm seekbench --help` lists every option. Resume an interrupted run with `--resume <run-id>`.

**Results**

Published runs live in `results/`, each with summary metrics and a report.

**Status**

Available: data model, URL normalization, rule-based grading from labels, quality metrics with confidence intervals, a runner with a global concurrency cap and per-subject rate limits (timeouts, resume), the `run` and `report` commands; adapters for Bocha, Brave, DeepSeek, Exa and Tavily with record and replay; hand-labeled datasets for Chinese and English site navigation (`nav-zh`, `nav-en`). The LLM judge and the remaining scenarios are not in yet. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Chinese).

**License**

Apache-2.0, see [LICENSE](LICENSE).
