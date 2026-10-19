# exa：Exa Search API

| 项目 | 说明 |
| --- | --- |
| 端点 | `POST https://api.exa.ai/search` |
| 鉴权 | `x-api-key: <EXA_API_KEY>` |
| 类型 | `type` 默认 `auto`，可配置 `instant` / `fast`；deep 系列慢且贵，不适合与普通搜索比 |
| 条数 | `numResults` 1 到 100 |
| 摘要 | 请求 `contents.highlights`，多段用 ` … ` 连接；总长由 `highlightsMaxCharacters` 控制，默认 500 |
| 时效 | `startPublishedDate`：当前时间减去窗口 |
| 站点 | `includeDomains` |
| 计费 | 优先用响应里的 `costDollars.total`；没有时按价目表估算：`auto` / `fast` 7 美元每千次、`instant` 4 美元，含 10 条结果与正文、highlights，超出 10 条每千条 1 美元 |
| 限速 | `/search` 10 次每秒 |
| 录制日期 | 2026-10-19 |

**怪癖**

- 不返回站点名；`favicon` 可能是空串，归一化为 `null`。
- `publishedDate` 经常缺失。
- 请求 id 在响应体的 `requestId`。
