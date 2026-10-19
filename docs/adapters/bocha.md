# bocha：博查 Web Search API

| 项目 | 说明 |
| --- | --- |
| 端点 | `POST https://api.bocha.cn/v1/web-search` |
| 鉴权 | `Authorization: Bearer <BOCHA_API_KEY>` |
| 条数 | `count` 1 到 50 |
| 时效 | `freshness`：`oneDay` / `oneWeek` / `oneMonth` / `oneYear`，不限为 `noLimit` |
| 站点 | `include`：域名 |
| 摘要 | 默认用 `snippet`；配置 `summary: true` 时请求并改用长摘要 `summary` |
| 计费 | 目录价 0.036 元每次，按 `USD_PER_CNY` 折算美元 |
| 限速 | 随充值档位变化，官方文档需登录查看；默认 5 次每秒 |
| 录制日期 | 2026-10-19 |

**怪癖**

- 出错时 HTTP 状态之外，响应体里的 `code` 也会给出错误码，成功时为数字 `200`，出错时可能是字符串；适配器按 `code` 抛错。
- `datePublished` 是北京时间，可能不带时区，按 `+08:00` 解释；`dateLastCrawled` 末尾的 `Z` 实为北京时间，不使用。
- 请求 id 在响应体的 `log_id`。
- 不返回语言参数，中英文查询同一个端点。
