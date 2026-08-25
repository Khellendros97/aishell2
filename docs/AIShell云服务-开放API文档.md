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
  "sessionId": "chat-2026-08-12-0001",
  "projectName": "aishell-cloud",
  "stream": false,
  "temperature": 0.7
}
```

| 约束 | 值 |
|---|---|
| `model` | 必填，非空；未配置 → `400 请求的模型未配置`；已停用 → `503 请求的模型已停用` |
| 请求体大小 | ≤ 10 MB |
| `stream: true` | 上游 SSE 流式透传：`Content-Type: text/event-stream`，`X-Accel-Buffering: no`，边收边发 |
| `sessionId` / `projectName` | **选填**，字符串：服务端记忆沉淀的会话/项目元数据（见下方「记忆元数据」说明） |
| 其余字段 | 透传，不校验（遵循所选上游模型实际支持） |

> **记忆元数据（选填）**：请求体顶层可带 `sessionId`（会话标识）、`projectName`（项目名），及可选 `memoryScope`（`shared`/`personal` 提示，服务端仅作参考，最终可见范围以服务端 AI 分类为准）。服务端据此**按会话聚合自动沉淀**（同一会话累计 8 条消息或 2000 字、或闲置 5 分钟触发一次沉淀）并写入卡片元数据追溯。**不携带 `sessionId` 的请求不触发自动沉淀**（旧客户端兼容：不产生无项目/会话标签的碎片卡片）。这些字段随 body 原样透传上游（OpenAI 兼容服务通常忽略未知字段），不影响对话。
>
> **无法修改请求体时**：若客户端（如 pi coding agent 封装）无法在 LLM 请求中携带上述字段，可在对话结束后调用 `POST /api/memories/sediment` 显式上报对话历史（见《记忆卡片 API 文档》§10），走完全相同的自动沉淀管线。

> **召回注入**：管理端开启「对话召回注入」时，服务端会在 `messages` 头部插入一条 `system` 消息（检索命中的**共享记忆 + 当前用户个人记忆**，可能与当前问题无关）；无命中或检索失败时不注入。客户端无需感知，但上游回答可能受注入内容影响。

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
| 429 | 达到上游配额（见 §6） |
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

## 4. 知识库（只读中转）

> 平台对企业知识库（自建 RAG）的开放读接口做**只读透传**（zero-credential：上游读接口匿名可访问，平台不保管也不透传任何知识库凭证）。响应为上游原生 JSON（**不是** OpenAI/搜索适配层结构），由客户端自行编排，例如把命中片段拼进 LLM 请求的 `system` 上下文。
>
> **平台不做服务端知识库注入**：客户端（含 `kb_search` 等工具）与「对话测试」工作台均通过下述接口自行检索；工作台「对话测试」会在**前端**把命中拼成 `system` 消息再发给 LLM（受系统设置「知识库注入」开关控制，默认开启）。管理端在「系统设置-知识库服务地址」配置上游地址。
>
> 所有 `/api/kb/*` 需登录（Bearer 或 Cookie）。未配置知识库地址 → `503`；上游不可达或返回错误 → `502`；上游状态码与响应体透传。

### 4.1 语义检索 `GET /api/kb/search`

| 参数 | 必填 | 说明 |
|---|---|---|
| `q` | 是 | 检索关键词（缺失时由上游决定，网关不校验） |
| `limit` | 否 | 返回条数 |
| `workspace_id` | 否 | 限定单个工作区；缺省为跨所有启用工作区全局检索 |

响应：**命中数组**（透传上游），单个元素：

```json
[
  {
    "chunk_id": 84785,
    "document_id": 1674,
    "document_title": "04-deployment-guide.md",
    "heading_path": "部署说明 / 部署步骤 / 3. 启动服务（按顺序）",
    "score": 994,
    "snippet": "…（含 <mark> 高亮的检索上下文片段）",
    "content_preview": "…",
    "content": "…",
    "workspace_id": 35,
    "workspace_name": "srun3-platform",
    "product_key": "srun3-platform",
    "product_name": "Srun3 平台",
    "product_type": "product_docs",
    "retrieval_type": "hybrid",
    "placeholder_penalized": false
  }
]
```

- `retrieval_type`：`hybrid`（语义+关键词混合）/ `keyword`（关键词）；
- 注入时可优先取 `document_title` / `heading_path` 作来源、`content_preview`/`snippet` 作摘要，控制上下文长度。

### 4.2 工作区清单 `GET /api/kb/workspaces`

响应：**工作区数组**（透传上游），常用字段：

| 字段 | 说明 |
|---|---|
| `id` / `name` | 工作区 ID / 名称（`id` 用于 `workspace_id`） |
| `workspace_type` | 类型（如 `inbox`/`product_docs`/`topic_docs`） |
| `product_key` / `product_name` | 关联产品标识 / 名称 |
| `description` | 描述 |
| `enabled` | 是否启用 |
| `canonical_doc_count` / `document_count` | 权威/累计文档数 |
| `created_at` / `updated_at` | 创建 / 更新时间 |

> 数组元素包含较多产品架构字段（`owner_*`、`upstream_systems`、`runtime_stack` 等），客户端按需取用即可。

### 4.3 已审核 FAQ `GET /api/kb/faq`

| 参数 | 说明 |
|---|---|
| `query` | 选填，关键词过滤 |
| `workspace_id` | 选填，限定工作区 |
| `limit` / `offset` | 选填，分页 |

响应（透传上游）：

```json
{
  "items": [
    {
      "id": 1111,
      "workspace_id": 48,
      "workspace_name": "srun4k",
      "question": "这个产品是做什么的？",
      "answer": "Srun Portal 认证相关产品资料…",
      "tags": [],
      "source_file": "11-faq.md",
      "confidence": 0.85,
      "review_status": "auto_accepted",
      "evidence_refs": [ { "type": "source_file", "source_file": "11-faq.md" } ],
      "updated_at": "2026-08-07T07:53:36.513101"
    }
  ],
  "limit": 3,
  "offset": 0
}
```

### 4.4 管理员配置 `GET|PUT /api/admin/settings/knowledge`

（管理员鉴权，客户端不可用。）

- `GET` → `{ "baseUrl": "http://10.10.1.89:8002" }`；
- `PUT`，body `{ "baseUrl": "…" }`；空串关闭知识库功能，响应回显规范化后的 `baseUrl`。

### 4.5 错误

| HTTP | 场景 |
|---|---|
| 401 | 未认证或 access_token 失效 |
| 502 | 知识库上游不可达 / 返回错误 |
| 503 | 知识库服务未配置 |

上游 4xx/5xx 与响应体**原样透传**（如缺失 `q` 等参数由其上游决定）。

## 5. 会话与用户接口

| 方法/路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 无 | 健康检查，返回 `{"status":"ok"}` |
| `GET /api/auth/me` | Bearer/Cookie | 当前用户 + 平台能力清单：`{"user":{…},"capabilities":{…}}`（见 §5.2） |
| `POST /api/auth/refresh` | Cookie/body | 轮换令牌：body `{"refreshToken":"…"}` 或携带 Cookie；响应 `{"user":…,"expiresIn":7200}`，新令牌写入 Cookie |
| `POST /api/auth/logout` | Cookie/body | 吊销 refresh token 并清 Cookie，返回 204 |
| `GET /api/usage` | Bearer/Cookie | **个人用量报表**：仅统计当前用户本人（见 §5.1） |

> 说明：客户端推荐用 OAuth 令牌端点续期（`/oauth/token` 的 `grant_type=refresh_token`，见 OAuth2 接入文档 §4.3）；`/api/auth/refresh` 为同源会话接口，二者签发的令牌同源等价，二选一即可。`/api/auth/login` 仅限管理员账号，员工客户端一律走 OAuth 授权流程。

### 5.1 个人用量 `GET /api/usage`

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
- 计量口径：LLM 按 token 数、搜索按请求次数，UTC 自然日（与 §6 配额口径一致）。

### 5.2 能力清单（me 响应中的 capabilities）

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
- `knowledge`：知识库只读中转是否已配置 —— 管理端「系统设置-知识库服务地址」或引导环境变量 `KNOWLEDGE_BASE_BASE_URL` 任一非空即为 `true`（语义与 §4 一致）。置 `true` 后客户端可按 CR-5.1 挂载 `kb_search`；注意当前实际接口为 **GET 透传**（§4.1），调用形态与历史需求中规划的 `POST /api/kb/search {query,topK}` 不同，挂载前需与服务端对齐。

## 6. 配额（429）语义

配额在服务端按**上游**配置，客户端不可见具体值：

| 类型 | 计量口径 | 触发 |
|---|---|---|
| 个人配额 `quota_user` | LLM：当日累计 token（prompt+completion）；搜索：当日请求次数 | 达到上限 → `429 个人…` |
| 全局配额 `quota_global` | 同上，按全平台当日累计 | 达到上限 → `429 全局…` |

按自然日（UTC）重置。客户端收到 429 应原样展示服务端中文错误，不自动重试。

## 7. 客户端接入要点（对照 CR-3 / CR-4）

1. **baseUrl 拼接**（CR-3.1）：`write_models_json` 的 provider 段写 `{ baseUrl: "<serverUrl>/api/proxy/llm/v1", apiKey: "$AISHELL_CLOUD_TOKEN" }`，spawn 时注入当前 access_token——与 §2 端点一致（`/api/proxy/llm/v1/chat/completions`）；
2. **搜索注入**（CR-4.1）：`AISHELL_SEARCH_URL=<serverUrl>/api/proxy/search`，token 同样经 env 注入；
3. **失败语义**（CR-3.2）：401/403 → 上浮服务端中文错误并触发登录失效处理；429 → 原样展示中文；502/503 → 提示上游暂时不可用，可提示稍后重试；
4. **请求前续期**：spawn/发起请求前按 CR-1.6 用 refresh_token 确保 access_token 未过期，避免请求中途 401；
5. 所有代理接口的 `model`/`q` 参数校验均在服务端完成，客户端无需预检；
6. **记忆沉淀元数据**：LLM 请求顶层传 `sessionId`（会话标识）与 `projectName`（项目名），服务端据此按会话聚合自动沉淀记忆（8 条/2000 字/闲置 5 分钟触发），并写入卡片标签与元数据便于追溯；**不带 `sessionId` 的请求不触发自动沉淀**。若客户端无法修改 LLM 请求体（pi coding agent 等封装）或希望对话结束立即沉淀，调用 `POST /api/memories/sediment` 上报对话历史（详见《记忆卡片 API 文档》§10）。
7. **知识库自行编排**（CR-5）：客户端（或 AI 扩展的 `kb_search` 工具）经 §4 接口检索知识库，把命中片段拼入 LLM 请求的 `system` 上下文或直接引用来源。平台**不在服务端注入**知识库，命中结构为上游原生 JSON（见 §4.1）；`POST /api/kb/search`、`/api/kb/list` 为历史需求文档中的规划形态，当前实现以 §4 的 GET 透传为准。

## 8. 快速验证（curl）

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

# 知识库语义检索
curl "$BASE/api/kb/search?q=部署&limit=5" -H "Authorization: Bearer $TOKEN"

# 知识库工作区列表 / FAQ
curl "$BASE/api/kb/workspaces" -H "Authorization: Bearer $TOKEN"
curl "$BASE/api/kb/faq?limit=5" -H "Authorization: Bearer $TOKEN"
```
