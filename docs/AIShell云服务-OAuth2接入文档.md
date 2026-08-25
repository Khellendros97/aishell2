# AIShell 云服务 - 第三方应用 OAuth2 接入文档

> 适用对象：aishell2 等需要调用云平台代理接口的第三方应用。
> 协议版本：OAuth 2.0 Authorization Code Flow（RFC 6749 子集），服务端实现于 `internal/oauth`。

## 1. 概述

第三方应用通过标准授权码流程接入云平台：

```
┌─────────┐ ①浏览器打开授权页  ┌──────────────┐ ②已登录→发 code / 未登录→跳登录页
│ 第三方应用 │ ───────────────▶ │  云平台        │
└─────────┘                    │  /oauth/authorize│
     │ ◀──── ③302 回跳 callback?code=…&state=… ────┘
     │
     │ ④POST /oauth/token (code + client_secret)
     │ ◀──── ⑤ access_token + refresh_token
     │
     │ ⑥Bearer access_token 调 /api/proxy/*（LLM / 搜索转发）
     └─────────────────────────────────────────────
```

- 用户**已登录**云平台（浏览器有会话 Cookie 或带 Bearer JWT）→ 直接签发一次性授权码，无需再次登录；
- 用户**未登录** → 302 跳转云平台登录页（`/admin/?next=…`），支持钉钉扫码或引导管理员账号登录，登录成功后自动回跳授权页继续。

## 2. 接入前置条件

1. 管理员在云平台管理后台 **OAuth 应用** 页面注册应用，登记**回调地址白名单**（每行一个，必须精确匹配）；
   - **回调地址是第三方应用自己接收授权码的地址**，不是云平台地址——用户授权后云平台 302 跳转到它并带上 `code`；
   - Web 应用：填服务端回调路由，如 `https://app.example.com/oauth/callback`；
   - 桌面应用（aishell2 形态）：填自定义协议深链，如 `aishell://auth/callback`（系统浏览器授权后唤起应用传 code）；深链地址需应用侧注册协议处理器；
2. 创建后一次性展示 `client_id` 与 `client_secret`（**明文仅此一次**，丢失需在后台重置）；
3. 后台可随时停用/删除应用（停用后 authorize 立即返回 403）、重置密钥。

## 3. 授权端点 `GET /oauth/authorize`

### 3.1 请求参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `client_id` | 是 | 注册应用获得的 client_id |
| `redirect_uri` | 是 | 必须与后台登记的某个回调地址**逐字符相等** |
| `response_type` | 是 | 固定 `code` |
| `state` | 推荐 | 应用自生成的防 CSRF 随机串（≤256 字符），回跳时原样带回 |

### 3.2 响应行为

| 场景 | 行为 |
|---|---|
| 应用不存在 | 400 HTML 错误页 |
| 应用已停用 | 403 HTML 错误页 |
| redirect_uri 不在白名单 | 400 HTML 错误页 |
| 用户已登录 | `302 → redirect_uri?code=…&state=…` |
| 用户未登录 | `302 → /admin/?next=<urlencode(原始授权地址)>`，登录成功后回跳继续授权 |

### 3.3 示例

```text
GET /oauth/authorize
    ?client_id=cdf477b0965931003e9949af059ab4f8ae4ff078e045bf16b430ba3a67e9ce73
    &redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback
    &response_type=code
    &state=csrftok123

# 已登录回跳（state 原样返回，应用必须校验一致）
302 Location: https://app.example.com/oauth/callback?code=7749f268…&state=csrftok123
```

## 4. 令牌端点 `POST /oauth/token`

支持 `application/x-www-form-urlencoded`（标准）与 `application/json` 两种请求体。

### 4.1 客户端认证

二选一：

- `Authorization: Basic base64(client_id:client_secret)`（推荐）
- 请求体携带 `client_id` + `client_secret`

认证失败返回 `401 invalid_client`。

### 4.2 授权码换令牌 `grant_type=authorization_code`

| 参数 | 说明 |
|---|---|
| `code` | authorize 回跳获得的授权码 |
| `redirect_uri` | 必须与 authorize 请求一致 |

成功响应（HTTP 200）：

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs…",
  "token_type": "Bearer",
  "expires_in": 7200,
  "refresh_token": "ca50b69b0e8f2f5f0dbcfc715213e59b…"
}
```

- `access_token`：站点会话 JWT，有效期 2 小时；
- `refresh_token`：有效期 30 天，**每次使用都会轮换**（旧值立即作废）；
- 授权码**一次性**：重复使用返回 `400 invalid_grant`；有效期 10 分钟。

### 4.3 刷新令牌 `grant_type=refresh_token`

| 参数 | 说明 |
|---|---|
| `refresh_token` | 上次换发的 refresh_token |

响应结构与 4.2 相同（access + 新 refresh）。建议 access_token 过期前主动轮换，避免请求中途 401。

### 4.4 示例

```bash
# 授权码换令牌
curl -X POST https://cloud.example.com/oauth/token \
  -u "cdf477b0…:8cf46133…" \
  -d "grant_type=authorization_code&code=7749f268…&redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback"

# 刷新令牌
curl -X POST https://cloud.example.com/oauth/token \
  -u "cdf477b0…:8cf46133…" \
  -d "grant_type=refresh_token&refresh_token=ca50b69b…"
```

## 5. 令牌使用

换发的 `access_token` 与登录会话 JWT 同源，用法完全一致：

```bash
# 调用代理接口（LLM 对话，OpenAI 兼容格式）
curl -X POST https://cloud.example.com/api/proxy/llm/v1/chat/completions \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# 搜索代理
curl "https://cloud.example.com/api/proxy/search?q=hello" \
  -H "Authorization: Bearer <access_token>"

# 当前用户信息
curl https://cloud.example.com/api/auth/me -H "Authorization: Bearer <access_token>"
```

- 上游密钥由服务端注入，客户端**无需也不应**持有任何上游 API Key；
- 配额在服务端按用户校验，超限返回 `429`；
- 401/403 表示令牌失效/账号被禁用 → 用 refresh_token 续期，失败则引导用户重新登录。

## 6. 安全约定（应用侧必须遵守）

| 项 | 要求 |
|---|---|
| `state` 校验 | 回跳时必须比对与发起时一致，防止 CSRF 授权注入 |
| `redirect_uri` | 只能使用后台登记的白名单地址；生产环境必须 HTTPS |
| 授权码 | 立即使用，不在日志/URL 中留存；10 分钟过期、一次性 |
| `client_secret` | 服务端应用妥善保管；**桌面/移动应用不要内嵌**（见 §7 差异说明） |
| `refresh_token` | 按密钥标准保管（如系统 keyring），仅存内存或加密存储 |

## 7. 与客户端需求文档（CR-1.2）的差异对照

aishell2 现有 `AIShell云服务-客户端需求文档.md` CR-1.2 设想的协议与本实现存在差异，**请以本文档为准调整客户端实现**：

| 项 | CR-1.2 旧约定 | 实际实现 | 影响 |
|---|---|---|---|
| 授权端点 | `/api/auth/dingtalk/authorize?client=desktop` | `/oauth/authorize?client_id=…`（标准 OAuth2，client_id 后台注册） | 端点与参数均需修改 |
| 令牌端点 | `/api/auth/token` | `/oauth/token` | 端点修改 |
| PKCE | 约定 code + verifier（S256） | **暂未实现**，当前用 client_secret 认证 | 桌面应用需等待服务端补 PKCE，或接受 client_secret 认证 |
| 回调形态 | `aishell://auth/callback` 深链 | 已支持：自定义 scheme 可登记白名单并正常回跳（服务端允许任意 `scheme://host/path` 形态） | 直接按 CR-1.3 登记即可 |
| 会话续期 | `/api/auth/refresh` | `/oauth/token` 的 `refresh_token` grant（或复用 `/api/auth/refresh` body 传 `refreshToken`） | 二选一，推荐前者 |

> 待办：桌面端建议服务端补 PKCE（S256）支持（`code_challenge` 可选参数，已登录态不受影响），届时本协议可完全对齐 OAuth 2.0 for Native Apps 最佳实践。

## 8. 错误码

| HTTP | `error` | 含义 | 处理建议 |
|---|---|---|---|
| 400 | `invalid_request` | 参数缺失/格式错误 | 检查请求参数 |
| 401 | `invalid_client` | client_id / client_secret 错误或应用停用 | 核对凭据；后台重置密钥 |
| 400 | `invalid_grant` | 授权码无效/已过期/已使用，或 refresh_token 失效 | 重新走授权流程 |
| 400 | `access_denied` | 用户账号被禁用 | 提示联系管理员 |
| 400 | `unsupported_grant_type` | grant_type 不支持 | 检查 grant_type 取值 |

错误响应为标准 OAuth 格式：

```json
{ "error": "invalid_grant", "error_description": "授权码无效或已过期" }
```

## 9. 最小可用流程（curl 全链路）

```bash
# ① 管理员登录后台 → OAuth 应用 → 新增，得到 client_id / client_secret
# ② 浏览器打开（未登录则先完成钉钉/引导账号登录，会自动回跳）
#    https://cloud.example.com/oauth/authorize?client_id=xxx&redirect_uri=...&response_type=code&state=abc
# ③ 回调地址收到 ?code=…&state=abc（校验 state）
# ④ 换令牌
curl -X POST https://cloud.example.com/oauth/token -u "client_id:client_secret" \
  -d "grant_type=authorization_code&code=…&redirect_uri=…"
# ⑤ 用 access_token 调 /api/proxy/llm/v1/chat/completions，过期走 4.3 续期
```
