# AIShell 云服务 —— 服务端需求文档

> 配套文档：《AIShell云服务-客户端需求文档.md》。接口契约以本文档为准，客户端文档引用本文档的需求编号（SR-xx）。

## 1. 背景与目标

公司统一采购 LLM / 搜索引擎 API，员工通过 AIShell 客户端经服务器转发使用，实现：

- API Key 集中保管在服务端，员工本地不接触真实 Key；
- 员工 API 消费按人统计、统一管理；
- 员工离职后在后台禁用账号，即刻失去 API 访问权限；
- 服务端同时承担官网介绍页、RAG 知识库、客户端版本发布与更新检查。

## 2. 角色

| 角色 | 说明 |
| --- | --- |
| 管理员 | 钉钉扫码登录后台网站；管理用户、上游 Key、知识库文档、版本发布；查看用量 |
| 员工（用户） | AIShell 客户端 OAuth 登录后使用转发接口；无后台访问权（除非同为管理员） |

## 3. 总体形态

单一服务进程，包含：

```
官网介绍页（静态，公开）
管理后台 SPA（钉钉登录）
HTTP API
  /api/auth/*      OAuth 登录、令牌签发与刷新
  /api/proxy/*     LLM / 搜索转发（员工令牌鉴权）
  /api/kb/*        知识库检索与文档管理
  /api/updates/*   版本检查与安装包下载
  /api/admin/*     后台管理接口（管理员鉴权）
```

- 技术栈：待决策（见 §10），推荐 Node + Fastify 或 Rust axum，单体 + 单数据库起步。
- 数据库：用户、令牌、上游 Key、知识库元数据、版本发布、用量日志。起步 SQLite（WAL）或 PostgreSQL，二选一，见 §10。

## 4. 功能需求

### SR-1 介绍页（官网落地页）

- SR-1.1 公网可访问的产品介绍页：AIShell 定位与核心功能简介（文案取材仓库 README：智能终端工作台、本地/SSH 终端、SFTP、文件管理、AI 助手）。
- SR-1.2 下载区：按平台（Windows x64 / macOS arm64 / macOS x64）列出当前最新版本安装包，附带版本号与发布日期；数据来自版本发布模块（SR-5），不硬编码。
- SR-1.3 下载走 `/api/updates/download/<releaseId>/<artifact>`（或预签名跳转），记录下载次数。
- SR-1.4 未登录可访问全部介绍页内容；页面同时给出「客户端内登录使用」的引导说明。

### SR-2 用户与认证

- SR-2.1 用户登录只走 OAuth 单点登录，不提供账号密码注册/登录。首个提供方为钉钉（企业员工场景），授权层按标准 OAuth2 授权码 + PKCE 抽象，后续可替换提供方（见 §10 待确认）。
- SR-2.2 两种客户端形态共用同一授权端点：
  - 管理后台（浏览器）：标准授权码流程，回调到后台地址；
  - AIShell 桌面端：授权码 + PKCE，回调走自定义协议 `aishell://auth/callback`（深链），服务端回调页负责把 code 带给桌面端。
- SR-2.3 登录成功后签发：`access_token`（JWT，短期，建议 ≤2h）+ `refresh_token`（长期，建议 30d，可吊销，哈希入库）。
- SR-2.4 首个完成登录的钉钉用户自动成为管理员；此后管理员可在后台把其他用户设为/取消管理员。
- SR-2.5 用户生命周期：`active` / `disabled`。管理员禁用任一用户后：
  - 其 refresh_token 立即吊销；
  - 代理层（SR-3）每次请求校验用户状态（短 TTL 缓存，≤60s 生效）；
  - 已签发的 access_token 因短期过期自然失效。
- SR-2.6 用户信息至少包含：钉钉 unionId（唯一键）、姓名、头像、部门、角色（admin/user）、状态、创建/最近登录时间。
- SR-2.7 提供 `GET /api/auth/me`：客户端凭 access_token 获取当前用户信息与服务端能力清单（可用的模型列表、搜索是否开放、知识库是否开放、当前最新版本号）。

### SR-3 API 转发

#### SR-3.1 LLM 转发

- SR-3.1.1 端点 `POST /api/proxy/llm/v1/chat/completions`，协议与上游 OpenAI 兼容端点保持一致（客户端 pi 与智能审批均以 `openai-completions` 协议直连，服务端必须透明转发请求体与 SSE 流式响应，不得缓冲整段）。
- SR-3.1.2 鉴权：`Authorization: Bearer <access_token>`；校验通过后代为注入上游真实 Key 转发，上游 Key 永不下发、永不出现在日志与错误信息中。
- SR-3.1.3 上游配置（后台管理）：每个模型一条记录 = { 展示名、上游 baseUrl、上游 apiKey（加密落库）、上游 modelId、是否启用、每用户/全局限额（可选） }。支持多家上游（DeepSeek、其他 OpenAI 兼容服务）。
- SR-3.1.4 客户端请求中的 `model` 字段映射到后台配置的模型；未配置/已停用的模型返回中文错误（透传上游错误时剥除敏感头）。
- SR-3.1.5 用量统计：按（用户、模型、日）记录请求次数与 prompt/completion token 数（从响应 usage 或流式末帧提取；提取失败至少记请求数）。后台提供按人/按模型/按时间的用量报表与 CSV 导出。
- SR-3.1.6 限额（一期可为仅告警）：达到限额的用户/模型，转发返回 429 + 中文错误。

#### SR-3.2 搜索转发

- SR-3.2.1 端点 `POST /api/proxy/search`（或 GET），参数与返回结构对齐 Brave Web Search API（`q`、`count`、`freshness` 等），使客户端现有 web_search 工具仅改 baseUrl 即可复用。
- SR-3.2.2 后台配置搜索引擎上游 Key（Brave，加密落库，可停用）。停用后接口返回中文错误引导。
- SR-3.2.3 按（用户、日）记录调用次数，纳入用量报表。

### SR-4 知识库（RAG）

- SR-4.1 管理员在后台上传文档：支持 md / txt / pdf / docx，单文件 ≤20MB；可编辑文档标题、分组（知识库集合）。
- SR-4.2 文档处理流水线：解析 → 分块（固定长度 + 重叠，参数可配）→ 向量化 → 入向量库。embedding 模型可配置（复用上游 LLM 服务商的 embedding 接口或独立配置）；处理状态（待处理/处理中/就绪/失败）后台可见，失败可重试。
- SR-4.3 检索接口 `POST /api/kb/search`：入参 { query, topK（默认 5，≤20）, kbId（可选，默认全部） }；出参为分块数组 { 文档标题、内容片段、相似度、来源定位 }。员工令牌鉴权，按（用户、日）记用量。
- SR-4.4 后台文档管理：列表、预览分块、删除（级联删向量）、重新处理。
- SR-4.5 一期知识库全员共享，不做按人/按部门授权（列为后续候选）。

### SR-5 版本发布与更新检查

- SR-5.1 后台发布管理：登记/上传版本 = { 版本号（semver）、发布日期、更新说明（Markdown）、各平台制品（安装包文件或外链） }；同一时刻每平台一个「最新版」。
- SR-5.2 更新检查端点 `GET /api/updates/latest`（公开，免登录，便于未登录客户端也能检查）：按客户端上报的 `target`（windows-x86_64 / darwin-aarch64 / darwin-x86_64）与当前版本返回：
  - 兼容 tauri-plugin-updater 的响应结构：`{ version, notes, pub_date, platforms: { <target>: { url, signature } } }`；无新版本时返回 204。
- SR-5.3 signature 字段来自 CI 构建时的 tauri 更新签名（minisign），管理员发布时随制品一并登记；未提供 signature 的发布在响应中省略 signature（客户端按「仅提示、手动下载」处理，见客户端 CR-6）。
- SR-5.4 与现有 GitHub Actions 发布流程（build-desktop.yml，tag v* → GitHub Release）的关系：一期允许管理员在后台直接登记 GitHub Release 制品外链，不必重复上传；二期可做一个按钮从 GitHub Release 同步版本与制品地址。

### SR-6 管理后台

- SR-6.1 钉钉扫码登录，仅 `active` 管理员可进入。
- SR-6.2 功能页：
  - 仪表盘：用户数、当日 LLM 请求数/token 数、搜索次数、知识库文档数、当前版本；
  - 用户管理（SR-2.5/2.6）；
  - 模型与搜索上游配置（SR-3.1.3 / SR-3.2.2）；
  - 用量报表（SR-3.1.5）；
  - 知识库文档管理（SR-4.4）；
  - 版本发布管理（SR-5.1）。
- SR-6.3 所有上游 Key 表单遵循「留空 = 保持原值」，显示位永不回显明文（与客户端密钥约束同规）。
- SR-6.4 管理操作记审计日志：操作者、动作、对象、时间。

## 5. 非功能需求

- NR-1 安全：全站 HTTPS；上游 Key 对称加密落库（密钥来自环境变量/密钥管理服务）；refresh_token 哈希落库；JWT 签名密钥环境注入；管理接口防 CSRF；代理接口限流防刷。
- NR-2 审计与日志：请求日志不落上游 Key 与授权头；用量数据保留 ≥1 年；审计日志 ≥1 年。
- NR-3 可用性：LLM 转发为长连接流式，网关超时 ≥5min；上游故障时返回中文可读错误并透传状态码语义。
- NR-4 部署：单容器交付（Dockerfile），数据卷挂载 SQLite 或外接 PostgreSQL；备份 = 数据库 + 上传文档目录。
- NR-5 规模假设：员工 ≤200 人并发不高，单体够用；不做多租户、不做计费系统对接。

## 6. 数据模型（核心实体）

```
User(id, dingtalk_union_id, name, avatar, dept, role, status, created_at, last_login_at)
RefreshToken(id, user_id, token_hash, expires_at, revoked_at)
UpstreamModel(id, name, base_url, api_key_enc, model_id, enabled, quota)
SearchUpstream(id, provider, api_key_enc, enabled)
KbDocument(id, kb_group, title, filename, size, status, error, created_at)
KbChunk(id, document_id, seq, content, embedding)
Release(id, version, notes, pub_date, latest)
ReleaseArtifact(id, release_id, target, url 或存储路径, signature, downloads)
UsageLlm(user_id, date, model, requests, prompt_tokens, completion_tokens)
UsageSearch(user_id, date, requests)
AuditLog(id, actor_id, action, target, detail, created_at)
```

## 7. API 一览（契约级）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | /api/auth/dingtalk/authorize?client=desktop\|admin | 公开 | 跳转钉钉授权页，desktop 附带 PKCE challenge 与深链回调 |
| GET | /api/auth/dingtalk/callback | 公开 | 授权回调；desktop 场景 302 到 `aishell://auth/callback?code=…` |
| POST | /api/auth/token | 公开 | code(+verifier) 换 access/refresh token |
| POST | /api/auth/refresh | refresh | 换新 token 对（refresh 轮转） |
| POST | /api/auth/logout | access | 吊销 refresh token |
| GET | /api/auth/me | access | 当前用户信息 + 能力清单（SR-2.7） |
| POST | /api/proxy/llm/v1/chat/completions | access | LLM 流式转发（SR-3.1） |
| POST/GET | /api/proxy/search | access | 搜索转发（SR-3.2） |
| POST | /api/kb/search | access | 知识库检索（SR-4.3） |
| GET | /api/kb/list | access | 知识库分组与文档清单（客户端展示用） |
| GET | /api/updates/latest?target=&current= | 公开 | 更新检查（SR-5.2） |
| GET | /api/updates/download/:releaseId/:artifactId | 公开 | 安装包下载/跳转 |
| — | /api/admin/* | admin | 用户/上游/知识库/发布/报表/审计 |

## 8. 非目标（一期不做）

- 按部门/按人的知识库权限隔离；
- 真实计费与支付对接；
- 多端在线状态管理、单点登出广播；
- 客户端 SSH 服务器配置的云端同步（后续候选，需另行评审密钥边界）。

## 9. 验收要点

1. 新用户钉钉授权后拿到 token，调 `/api/proxy/llm` 可流式对话，后台报表出现该用户用量；
2. 管理员禁用该用户后 60s 内其转发请求全部 401/403，refresh 同样失效；
3. 后台改上游 Key 后新请求立即用新 Key，客户端无感知；
4. 上传一份 md 文档，`/api/kb/search` 能按语义召回其分块；
5. 发布一个带 signature 的版本后，`/api/updates/latest` 对旧版本客户端返回 updater 兼容 JSON；
6. 介绍页未登录可访问，下载链接指向当前最新版并计数。

## 10. 待决策项

1. **员工端 OAuth 提供方**：需求原文「登陆走oauth单点登陆，后台网站使用钉钉登陆」。本文档默认两端统一钉钉，若员工侧另有企业 IdP（如企业微信/飞书/自研 SSO），授权层抽象不变，仅替换提供方实现。→ 需确认
2. 服务端技术栈：Node + Fastify vs Rust axum（团队两端均有经验，按运维偏好定）。
3. 数据库：SQLite（单机省心）vs PostgreSQL（后续扩展余地）。
4. 向量库：sqlite-vec / pgvector / 独立 Qdrant，随 §2/§3 决策联动。
5. 部署位置：公网（客户端任意网络可用）vs 公司内网（需 VPN）；影响介绍页是否同时承担对外官网职能。
