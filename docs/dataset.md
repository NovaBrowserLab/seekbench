# 题库

数据模型与分层见 [ARCHITECTURE.md §3.1](ARCHITECTURE.md#31-场景与用例dataset)。本文是标注规范与工具用法。

## 文件

每个场景两个文件，放在 `datasets/scenarios/`：`<id>.json` 是场景定义，`<id>.cases.jsonl` 每行一条用例。用例有变动（增删、改查询或 gold）就升场景的 `version`，不同版本的结果不可比。

## A 层标注

- `note` 写用户真正想找什么、什么样的结果算好，供裁判与复核人阅读，不复述查询。中文场景用中文写，英文场景用英文写。
- `targets` 只放确认可访问的规范页面，写到能唯一确定目标的最短前缀；有多个合理的落地页时都列上。
- `mustDomains` 放这类查询应当出现的权威来源，如官方文档、标准组织、项目仓库。
- `badDomains` 放仿冒站、内容农场、下载站等，出现即记 0。
- 歧义场景的每条用例都要有 `meanings`。

## 命令

| 命令 | 说明 |
| --- | --- |
| `seekbench dataset:validate` | 校验题库：错误（无法解析、场景内重复、模板 id 重复）以非零状态退出；警告（跨场景重复、A 层缺标注、B 层缺意图说明）只提示。单测里也会跑一遍 |
| `seekbench dataset:stats` | 按场景列出用例数、层、来源、语言与查询长度；`--markdown` 输出 Markdown 表格 |
| `seekbench dataset:synth` | 按场景的 `synth` 模板合成 B 层用例，见下文 |
| `seekbench dataset:import-log <file>` | 导入私有查询日志，见下文 |

## 合成 B 层

场景 JSON 的 `synth` 列出模板，每个模板一段生成要求与目标条数。`dataset:synth` 只补到目标条数为止，重复执行不会多合成；`--dry-run` 先看各模板还差多少。

- 合成用配置里的 `synth` 端点，每次调用要 `batchSize` 条，示例取同场景已有的查询。
- 与已有查询近似重复的丢弃：归一化后编辑距离不超过较长者的 20%，或字符二元组相似度不低于 0.8。
- 新用例追加到用例文件，id 为 `<模板>-<序号>`，来源 `synth:<模板>`。
- 按 `reviewRatio`（默认 10%）随机抽样写入 `datasets/review/<场景>.jsonl`。复核人逐条看查询与意图说明：没问题把 `status` 改成 `ok`；在用例文件里改过的标 `fixed`；删掉的标 `dropped`，可在 `comment` 写原因。复核队列随题库一起提交。

## 导入日志

`dataset:import-log` 读 CSV（取名为 `query` 的列，没有时取第一列）或 JSONL（每行带 `query` 字段的对象或一个字符串）：

1. 带邮箱、手机号、电话、身份证号、银行卡号的查询整条丢弃，过短的（默认中文查询少于 2 个字符、其他少于 3 个字符）也丢弃。人名无法可靠识别，用 `--names <file>` 提供名单，一行一个。
2. 去重后按规则粗分到 `<意图>-<语言>` 场景，都标为 B 层、来源 `log:<批次>`。歧义无法靠规则判断，不会分到歧义场景。
3. 结果写到 `datasets/private/<批次>/`，同时复制同名公开场景的定义，用 `seekbench run --scenarios-dir datasets/private/<批次> --scenarios <场景>` 评测。该目录不提交。
