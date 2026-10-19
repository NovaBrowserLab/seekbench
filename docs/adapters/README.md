# 供应商适配器

每家一个文件（`src/adapters/<id>.ts`），只负责构造请求与把响应映射成 `Hit`；鉴权、超时、429 与 5xx 重试、响应校验、计费汇总由 `_shared.ts` 的 `providerSubject` 统一处理，排序、去重、截断在核心层统一做。

| 供应商 | 文档 |
| --- | --- |
| 博查 | [bocha.md](bocha.md) |
| Brave | [brave.md](brave.md) |
| DeepSeek | [deepseek.md](deepseek.md) |
| Exa | [exa.md](exa.md) |
| Tavily | [tavily.md](tavily.md) |

**共有配置项**（写在 `seekbench.config.ts` 的被测对象声明里）：

| 配置 | 说明 |
| --- | --- |
| `apiKeyEnv` | 读取密钥的环境变量名，默认 `<供应商>_API_KEY` |
| `baseUrl` | 覆盖接口地址 |
| `rateLimit` | `{ perSecond, burst? }`，默认取各家文档的上限 |
| `pricePer1k` | 每千次计费请求的美元价格，覆盖默认计费；人民币计价的供应商默认按固定汇率 `USD_PER_CNY = 0.14` 折算 |

同一家可以用不同配置声明多次，如 `exa-fast: { use: "exa", type: "fast" }`。

**测试夹具**：`test/fixtures/adapters/<id>.json` 是各家对查询「Steam 官网」的一次真实响应（裁掉了图片等无关字段），单测用它断言归一化输出，不联网。
