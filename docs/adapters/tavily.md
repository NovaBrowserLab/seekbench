# tavily：Tavily Search API

| 项目 | 说明 |
| --- | --- |
| 端点 | `POST https://api.tavily.com/search` |
| 鉴权 | `Authorization: Bearer <TAVILY_API_KEY>` |
| 深度 | `search_depth` 默认 `basic`，可配置 `ultra-fast` / `fast` / `advanced` |
| 主题 | `topic` 默认 `general`，可配置 `news` / `finance` |
| 条数 | `max_results` 0 到 20 |
| 时效 | `time_range`：`day` / `week` / `month` / `year` |
| 站点 | `include_domains` |
| 其他 | 打开 `include_favicon`、`include_published_date`、`include_usage` |
| 计费 | 按 credit：`advanced` 2 个，其余 1 个；按量付费 0.008 美元每 credit。优先用响应里的 `usage.credits` |
| 限速 | 开发密钥 100 次每分钟，生产密钥 1000 次每分钟 |
| 录制日期 | 2026-10-19 |

**怪癖**

- 返回条数常少于 `max_results`。
- 摘要 `content` 是页面片段，常含导航栏文字。
- 不返回站点名；请求 id 在响应体的 `request_id`。
