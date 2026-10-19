# deepseek：DeepSeek Search 接口

文档：<https://api-docs.deepseek.com/zh-cn/guides/search/>

| 项目 | 说明 |
| --- | --- |
| 端点 | `POST https://api.deepseek.com/v1/tools/search` |
| 鉴权 | `Authorization: Bearer <DEEPSEEK_API_KEY>`，与模型 API 共用密钥 |
| 条数 | `count` 1 到 50 |
| 时效 | 没有参数，在查询后追加 `after:YYYY-MM-DD` 语法 |
| 站点 | 在查询后追加 `site:` 语法 |
| 摘要 | 默认用短摘要 `snippet`（100 到 200 字）；配置 `summary: true` 改用长摘要 `summary`（600 到 800 字） |
| 计费 | 5 元每千次成功请求；结果为空的请求不计费 |
| 限速 | 账号级 5 次每秒 |
| 录制日期 | 2026-10-19 |

**怪癖**

- 查询长度上限 128 个字符。
- 每条结果另有 `rerank_score`（0 到 3）与 `authority`（0 到 4），适配器不使用，保留在原始响应里。
- 请求 id 取响应头 `x-ds-trace-id`。
