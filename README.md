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

## 结果

公开的运行结果放在 `results/`，每次包含汇总指标与报告。

## 状态

设计阶段。设计文档见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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

**Results**

Published runs live in `results/`, each with summary metrics and a report.

**Status**

Design stage. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Chinese).
