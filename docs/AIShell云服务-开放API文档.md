# AIShell 云服务 - 开放 API 文档（客户端接入）

> 适用对象：aishell2 客户端（托管模式）调用云平台代理能力。
> 配套文档：`AIShell云服务-OAuth2接入文档.md`（获取令牌）；本文档覆盖令牌获取之后的全部开放接口。

## 1. 总览

| 项目 | 说明 |
|---|---|
| 基址 | 构建期注入的 `AISHELL_SERVER_URL`（如 `https://cloud.example.com`） |
| 鉴权 | `Authorization: Bearer <access_token>`（OAuth2 换发，2 小时有效） |
| 错误格式 | 统一 JSON `{"error": "中文可读信息"}`（代理接口透传成功响应，错误为 JSON） |
| 上游密钥 | 服务端注入，客户端无需也不应持有任何上游 API Key |

所有接口均可在同源浏览器下用登录 Cookie 访问；客户端一律使用 Bearer 头。

## 2. LLM 对话 `POST /api/proxy/llm/v1/chat/completions`

OpenAI 兼容格式，请求体**原样透传**到模型上游（仅注入服务端保管的上游密钥）。

### 2.1 请求

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "你是企业助手" },
    { "role": "user", "content": "介绍 AIShell" }
  ],
  "stream": false,
  "temperature": 0.7
}
```

| 约束 | 值 |
|---|---|
| `model` | 必填，非空；未配置 → `400 请求的模型未配置`；已停用 → `503 请求的模型已停用` |
| 请求体大小 | ≤ 10 MB |
| `stream: true` | 上游 SSE 流式透传：`Content-Type: text/event-stream`，`X-Accel-Buffering: no`，边收边发 |
| 其余字段 | 透传，不校验（遵循所选上游模型实际支持） |

### 2.2 响应

- 状态码与 `Content-Type`、`Content-Encoding`、`Cache-Control`、`ETag`、`Retry-After`、`X-Request-Id`、`x-ratelimit-*` 响应头原样透传；
- 流式模式下 body 为 OpenAI SSE 事件流（`data: {...}`，终止于 `data: [DONE]`）；
- 上游 `Set-Cookie` 不会透传给客户端。

### 2.3 错误

| HTTP | 场景 |
|---|---|
| 400 | 缺 `model` / 请求体非 JSON |
| 401 | 未认证或 access_token 失效（用 refresh 轮换后重试） |
| 403 | 账号被禁用 |
| 429 | 达到上游配额（见 §5） |
| 502 | 模型上游暂时不可用 |
| 503 | 模型已停用 / 上游无可用 Key |

## 3. 搜索 `GET|POST /api/proxy/search`

> 服务端按上游配置适配搜索提供商（当前支持 `brave` / `bocha`，见 §3.3）；请求入口、鉴权、参数 `q`/`count` 对客户端完全不变，差异仅在**参数透传范围**与**响应体结构**。

### 3.1 请求

- `GET`：参数走 query string；
- `POST`：参数走 JSON body（≤ 1 MB），值支持**字符串 / 数字 / 布尔 / 数组**，其余类型 → 400；
- GET 与 POST 参数可混用（POST body 覆盖同名的 query 参数）；
- 必填 `q`：搜索关键词，缺失 → `400 搜索请求缺少 q 参数`；
- 其余参数的透传范围**取决于服务端配置的搜索提供商**：
  - `brave`：全部参数（`count`、`extra_snippets`、`country`、`freshness` 等）原样透传；
  - `bocha`：**仅映射 `q`→`query`、`count`→`count`**，其余参数静默忽略；`count` 无法解析为正整数时不发送（上游取默认值）。

```bash
# GET
curl "https://cloud.example.com/api/proxy/search?q=hello&count=2" -H "Authorization: Bearer <token>"

# POST
curl -X POST https://cloud.example.com/api/proxy/search \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"q":"hello","count":3}'
```

### 3.2 响应

成功时上游响应**原样透传**（状态码与响应头处理同 §2.2），body 结构取决于搜索提供商：

| 客户端字段 | Brave（`brave`） | 博查（`bocha`） |
|---|---|---|
| 结果数组 | `web.results[]` | `data.webPages.value[]` |
| 标题 | `title` | `name` |
| 链接 | `url` | `url` |
| 摘要 | `description` | `snippet`（`summary` 详细摘要需请求级开启，当前适配层未转发） |
| 站点/时间 | `page_age` 等 | `siteName`、`siteIcon`、`datePublished` |
| 外层包装 | 无 | `code` / `msg` / `log_id`（`code=200` 为成功） |

- `count` 上限：Brave 20 / 博查 50，超出行为由上游决定，网关不截断；
- 上游请求超时上限 30 秒；
- 错误体：网关自身错误为统一 JSON `{"error":"…"}`；上游错误的状态码与错误体**透传**，博查错误体为 `{"code":…,"msg":…}`，与 Brave 不同。

### 3.3 错误

错误码同 §2.3（额外：`503 搜索服务尚未配置/已停用`）。

### 3.4 搜索提供商说明

- 提供商由服务端上游配置决定，上游密钥均在服务端注入，客户端不感知鉴权差异；
- 国内部署推荐 `bocha`（博查）：Brave API 在部分网络不可达；微软 Bing Search API v7 已于 2025-08 退役，不再可用；
- 客户端按 §3.2 的实际响应结构解析即可；如需博查专有请求参数（`freshness`、`summary` 等），联系服务端在适配层补充映射后再使用。

## 4. 会话与用户接口

| 方法/路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 无 | 健康检查，返回 `{"status":"ok"}` |
| `GET /api/auth/me` | Bearer/Cookie | 当前用户 + 平台能力清单：`{"user":{…},"capabilities":{…}}`（见 §4.2） |
| `POST /api/auth/refresh` | Cookie/body | 轮换令牌：body `{"refreshToken":"…"}` 或携带 Cookie；响应 `{"user":…,"expiresIn":7200}`，新令牌写入 Cookie |
| `POST /api/auth/logout` | Cookie/body | 吊销 refresh token 并清 Cookie，返回 204 |
| `GET /api/usage` | Bearer/Cookie | **个人用量报表**：仅统计当前用户本人（见 §4.1） |

> 说明：客户端推荐用 OAuth 令牌端点续期（`/oauth/token` 的 `grant_type=refresh_token`，见 OAuth2 接入文档 §4.3）；`/api/auth/refresh` 为同源会话接口，二者签发的令牌同源等价，二选一即可。`/api/auth/login` 仅限管理员账号，员工客户端一律走 OAuth 授权流程。

### 4.1 个人用量 `GET /api/usage`

参数与聚合口径与管理端用量一致，但 `userId` 参数**强制忽略**（服务端固定按当前令牌用户统计），客户端无法越权查询他人数据。

| 参数 | 默认 | 说明 |
|---|---|---|
| `days` | 14 | 统计天数，1–90 |
| `kind` | 全部 | `llm` 或 `search` |
| `model` | 全部 | 模型名过滤（仅 LLM） |

响应结构：

```json
{
  "from": "2026-07-29",
  "to": "2026-08-11",
  "timezone": "UTC",
  "summary": {
    "requests": 128, "llmRequests": 100, "searchRequests": 28,
    "promptTokens": 123456, "completionTokens": 54321, "totalTokens": 177777,
    "averageLatencyMs": 214.5, "errorCount": 2
  },
  "daily": [ { "date": "2026-08-11", "requests": 12, "llmRequests": 9, "searchRequests": 3,
               "promptTokens": 0, "completionTokens": 0, "errorCount": 0 } ],
  "models": [ { "model": "gpt-4o", "requests": 80, "promptTokens": 0,
                "completionTokens": 0, "totalTokens": 0 } ],
  "breakdown": [ { "date": "2026-08-11", "userId": 7, "userName": "张三", "dept": "研发部",
                   "kind": "llm", "model": "gpt-4o", "requests": 5,
                   "promptTokens": 0, "completionTokens": 0, "totalTokens": 0,
                   "averageLatencyMs": 180.0, "errorCount": 0 } ]
}
```

- `summary` 不含 `activeUsers`（个人报表无此维度）；
- `daily` 按查询天数补齐为连续日期（无调用的日期为 0）；
- 计量口径：LLM 按 token 数、搜索按请求次数，UTC 自然日（与 §5 配额口径一致）。

### 4.2 能力清单（me 响应中的 capabilities）

客户端托管模式据此渲染模型下拉、搜索开关等（对应 CR-2.2 / CR-4.3）：

```json
{
  "user": { "id": 7, "name": "张三", "dept": "研发部", "role": "user", "status": "active" },
  "capabilities": {
    "models": ["deepseek-v4-flash"],
    "search": true,
    "knowledge": false
  }
}
```

- `models`：服务端**已启用**的 LLM 模型列表（上游 `model_id`），随上游配置实时变化；
- `search`：是否存在启用的搜索上游；
- `knowledge`：知识库服务尚未开放，恒为 `false`（开放后客户端再按 `true` 挂载 `kb_search` 工具，CR-5.1）。

## 5. 配额（429）语义

配额在服务端按**上游**配置，客户端不可见具体值：

| 类型 | 计量口径 | 触发 |
|---|---|---|
| 个人配额 `quota_user` | LLM：当日累计 token（prompt+completion）；搜索：当日请求次数 | 达到上限 → `429 个人…` |
| 全局配额 `quota_global` | 同上，按全平台当日累计 | 达到上限 → `429 全局…` |

按自然日（UTC）重置。客户端收到 429 应原样展示服务端中文错误，不自动重试。

## 6. 客户端接入要点（对照 CR-3 / CR-4）

1. **baseUrl 拼接**（CR-3.1）：`write_models_json` 的 provider 段写 `{ baseUrl: "<serverUrl>/api/proxy/llm/v1", apiKey: "$AISHELL_CLOUD_TOKEN" }`，spawn 时注入当前 access_token——与 §2 端点一致（`/api/proxy/llm/v1/chat/completions`）；
2. **搜索注入**（CR-4.1）：`AISHELL_SEARCH_URL=<serverUrl>/api/proxy/search`，token 同样经 env 注入；
3. **失败语义**（CR-3.2）：401/403 → 上浮服务端中文错误并触发登录失效处理；429 → 原样展示中文；502/503 → 提示上游暂时不可用，可提示稍后重试；
4. **请求前续期**：spawn/发起请求前按 CR-1.6 用 refresh_token 确保 access_token 未过期，避免请求中途 401；
5. 所有代理接口的 `model`/`q` 参数校验均在服务端完成，客户端无需预检。

## 7. 快速验证（curl）

```bash
BASE=https://cloud.example.com
TOKEN=<OAuth2 换发的 access_token>

# 健康检查
curl $BASE/api/health

# 当前用户
curl $BASE/api/auth/me -H "Authorization: Bearer $TOKEN"

# LLM 对话（流式）
curl -N $BASE/api/proxy/llm/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# 搜索
curl "$BASE/api/proxy/search?q=hello" -H "Authorization: Bearer $TOKEN"

# 个人用量报表
curl "$BASE/api/usage?days=14" -H "Authorization: Bearer $TOKEN"
```
