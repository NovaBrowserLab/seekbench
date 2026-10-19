# brave：Brave Search Web Search API

| 项目 | 说明 |
| --- | --- |
| 端点 | `GET https://api.search.brave.com/res/v1/web/search` |
| 鉴权 | `X-Subscription-Token: <BRAVE_API_KEY>` |
| 条数 | `count` 最多 20 |
| 语言 | `search_lang`：中文查询为 `zh-hans`，英文为 `en` |
| 时效 | `freshness`：`pd` / `pw` / `pm` / `py` |
| 站点 | 在 `q` 后追加 `site:` 语法 |
| 其他 | `result_filter=web`；`country` 默认不传，可在配置里指定 |
| 计费 | Search 套餐 5 美元每千次请求，每月含 5 美元额度 |
| 限速 | Search 套餐 50 次每秒 |
| 录制日期 | 2026-10-19 |

**怪癖**

- 标题与摘要带 `<strong>` 等标签与 HTML 实体，归一化时去掉。
- `page_age` 不带时区，按 UTC 解释；很多结果没有这个字段。
- 不返回结果总数，也没有请求 id。
