# AIShell 云服务 - 用户反馈 API 文档（客户端接入）

> 适用对象：aishell2 客户端（托管模式）提交和查看用户反馈。
> 配套文档：`AIShell云服务-OAuth2接入文档.md`（获取令牌）、`AIShell云服务-开放API文档.md`（代理能力）。
> 本文档只描述登录用户可调用的开放接口。用户只能创建反馈、查看自己的反馈及下载自己的附件；管理员在后台处理反馈并更新状态，管理员管理接口不作为开放接口写入本文档。

## 1. 总览

| 项目 | 说明 |
|---|---|
| 基址 | 构建期注入的 `AISHELL_SERVER_URL`（如 `https://cloud.example.com`），与其他云服务接口同源 |
| 鉴权 | `Authorization: Bearer <access_token>`（OAuth2 换发）；同源浏览器请求亦可使用登录 Cookie |
| 创建请求 | `multipart/form-data`；由客户端/浏览器自动生成 boundary，不要手工设置 `Content-Type` |
| 错误格式 | 统一 JSON `{"error":"中文可读信息"}` |
| 数据范围 | 列表和详情只返回当前登录用户本人提交的反馈；不能通过修改 ID、查询参数或下载 URL 访问他人反馈 |
| 时间格式 | RFC 3339（例如 `2026-08-21T10:30:12+08:00`）；客户端按其中的时区偏移格式化展示 |

### 1.1 接口清单

| 方法/路径 | 说明 |
|---|---|
| `POST /api/feedback` | 提交一条用户反馈，可附带多个文件 |
| `GET /api/feedback` | 分页查询本人反馈，支持 `status` / `category` 过滤 |
| `GET /api/feedback/:id` | 查看本人某条反馈及附件元数据 |
| `GET /api/feedback/:id/attachments/:attachmentId` | 下载本人反馈中的指定附件 |

### 1.2 反馈对象

创建成功、详情和列表中的每条反馈都使用以下结构：

```json
{
  "id": 42,
  "reporterId": 7,
  "reporterName": "张三",
  "reporterDept": "研发部",
  "category": "bug",
  "title": "切换工作区后终端无法连接",
  "content": "切换到第二个工作区后，新开的终端一直显示连接中。",
  "status": "pending",
  "attachments": [
    {
      "id": 9,
      "filename": "terminal.log",
      "contentType": "text/plain",
      "sizeBytes": 18432,
      "sha256": "3a7bd3e2360a3d29eea436fcfb7e44c7f6ad5a0e8f2d6c1b4a5e9d3f7c8b2a1e",
      "createdAt": "2026-08-21T10:30:12+08:00",
      "downloadURL": "/api/feedback/42/attachments/9"
    }
  ],
  "attachmentCount": 1,
  "createdAt": "2026-08-21T10:30:12+08:00",
  "updatedAt": "2026-08-21T10:30:12+08:00"
}
```

| 字段 | 说明 |
|---|---|
| `id` | 反馈唯一标识；由服务端生成，客户端保存后用于详情查询 |
| `reporterId` | 提交者账号 ID；由当前登录会话确定，客户端无需上传 |
| `reporterName` / `reporterDept` | 提交者当前姓名和部门；由服务端按 `reporterId` 查询补充，用户资料变更后会随之更新 |
| `category` | `bug`（缺陷）/ `suggestion`（建议）/ `question`（问题）/ `other`（其他） |
| `title` | 反馈标题，最多 120 字 |
| `content` | 反馈正文，最多 10000 字 |
| `status` | `pending`（待处理）/ `processing`（处理中）/ `resolved`（已解决）/ `closed`（已关闭）；用户只读，不能通过开放接口修改 |
| `attachments` | 附件元数据数组；没有附件时为 `[]`，文件内容不嵌入 JSON |
| `attachmentCount` | 附件数量，与 `attachments.length` 一致 |
| `createdAt` / `updatedAt` | 创建时间和最近更新时间；状态被管理员更新时 `updatedAt` 会变化 |

### 1.3 附件对象

| 字段 | 说明 |
|---|---|
| `id` | 附件唯一标识 |
| `filename` | 上传时的文件名；用于下载时的默认文件名 |
| `contentType` | 服务端识别并保存的 MIME 类型 |
| `sizeBytes` | 文件大小，单位为字节 |
| `sha256` | 文件内容的 SHA-256 十六进制摘要 |
| `createdAt` | 附件上传时间 |
| `downloadURL` | 当前用户可用的下载地址；需继续携带 Bearer 或 Cookie，不是公开免鉴权地址 |

### 1.4 取值与上传限制

| 项目 | 约束 |
|---|---|
| `category` | 必填且只能是 `bug` / `suggestion` / `question` / `other` |
| `title` | 必填，去除首尾空白后不能为空，长度 ≤ 120 字 |
| `content` | 必填，去除首尾空白后不能为空，长度 ≤ 10000 字 |
| 附件数量 | 每条反馈最多 10 个附件；没有附件也可以提交 |
| 单个附件 | 文件必须非空且 ≤ 20 MB（20 × 1024 × 1024 字节） |
| 总附件大小 | 同一条反馈所有附件合计 ≤ 100 MB（100 × 1024 × 1024 字节） |
| 用户累计配额 | 默认每个用户的全部反馈附件累计 ≤ 1 GiB；部署方可调整，超限返回 `409` |
| 允许类型 | 常见图片、PDF、Office 文档、文本/日志文件，以及 `zip` / `7z` / `rar` / `tar.gz` 压缩包 |
| 拒绝类型 | 脚本、可执行文件、SVG、HTML 扩展名；结构化格式的文件签名不匹配时也会被拒绝 |

服务端按安全扩展名白名单校验文件名，并对图片、PDF、Office/ODF、常见压缩包检查文件签名，文本类拒绝包含 NUL 的二进制内容；下载 MIME 由服务端按扩展名生成，不采信客户端声明。该校验用于阻止简单的改名伪装，不等同于病毒扫描。允许的扩展名包括 `png` / `jpg` / `jpeg` / `gif` / `webp` / `bmp` / `ico` / `avif` / `heic`、`pdf`、`doc` / `docx` / `xls` / `xlsx` / `ppt` / `pptx` / `odt` / `ods` / `odp`、`txt` / `log` / `md` / `markdown` / `csv` / `tsv` / `json` / `xml` / `yaml` / `yml`，以及 `zip` / `7z` / `rar` / `tar` / `gz` / `tgz` / `bz2` / `xz` / `tar.gz`。`svg`、`html`、`htm`、脚本和可执行文件扩展名不在白名单中。

## 2. 提交反馈 `POST /api/feedback`

客户端使用 `multipart/form-data` 提交。`category`、`title`、`content` 是普通文本字段；`attachments` 是文件字段，同名字段可以重复，服务端按上传顺序接收多个文件。

### 2.1 请求字段

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `category` | 文本 | 是 | `bug` / `suggestion` / `question` / `other` |
| `title` | 文本 | 是 | 去除首尾空白后非空，≤ 120 字 |
| `content` | 文本 | 是 | 去除首尾空白后非空，≤ 10000 字 |
| `attachments` | 文件，可重复 | 否 | 最多 10 个；单个 ≤ 20 MB；合计 ≤ 100 MB；必须是允许类型 |

`reporterId`、`reporterName`、`reporterDept`、`status`、`createdAt`、`updatedAt` 由服务端生成或维护，客户端不得作为表单字段提交。反馈初始状态始终为 `pending`。

### 2.2 响应

成功返回 `201 Created`，body 为完整反馈对象（§1.2）。服务端成功接收文件后才会返回响应；响应中的 `attachments` 含每个文件的摘要和下载地址。

```json
{
  "id": 42,
  "reporterId": 7,
  "reporterName": "张三",
  "reporterDept": "研发部",
  "category": "bug",
  "title": "切换工作区后终端无法连接",
  "content": "切换到第二个工作区后，新开的终端一直显示连接中。",
  "status": "pending",
  "attachments": [],
  "attachmentCount": 0,
  "createdAt": "2026-08-21T10:30:12+08:00",
  "updatedAt": "2026-08-21T10:30:12+08:00"
}
```

### 2.3 完整 curl 示例

```bash
BASE=https://cloud.example.com
TOKEN=<OAuth2 换发的 access_token>

curl -X POST "$BASE/api/feedback" \
  -H "Authorization: Bearer $TOKEN" \
  -F "category=bug" \
  -F "title=切换工作区后终端无法连接" \
  -F "content=切换到第二个工作区后，新开的终端一直显示连接中。" \
  -F "attachments=@./diagnostics/terminal.log;type=text/plain" \
  -F "attachments=@./screenshots/terminal.png;type=image/png"
```

使用同源登录 Cookie 时，不要传 `Authorization`，浏览器或 curl 应携带 Cookie：

```bash
curl -X POST "$BASE/api/feedback" \
  -b "session=<登录 Cookie>" \
  -F "category=suggestion" \
  -F "title=希望支持自定义终端字体" \
  -F "content=设置页可以增加终端字体和字号配置。"
```

> `curl -F` 会自动设置正确的 `multipart/form-data; boundary=...`。不要额外写 `-H "Content-Type: multipart/form-data"`，否则可能缺少 boundary 导致服务端无法解析。

## 3. 分页查询本人反馈 `GET /api/feedback`

只返回当前登录用户本人提交的反馈，按 `createdAt` 倒序排列（最新提交在前）。管理员在后台看到的管理列表不属于本接口；本接口不会因为调用者具有管理员身份而返回其他用户的反馈。

### 3.1 查询参数

| 参数 | 必填 | 默认值 | 约束 |
|---|---:|---:|---|
| `page` | 否 | `1` | 从 1 开始的页码 |
| `pageSize` | 否 | `20` | 每页条数，正整数；服务端限制最大值为 100 |
| `status` | 否 | 不过滤 | `pending` / `processing` / `resolved` / `closed` |
| `category` | 否 | 不过滤 | `bug` / `suggestion` / `question` / `other` |

过滤条件可以组合使用。例如，查询本人第 2 页、每页 10 条的 bug：

```bash
curl "$BASE/api/feedback?page=2&pageSize=10&status=processing&category=bug" \
  -H "Authorization: Bearer $TOKEN"
```

### 3.2 分页响应

成功返回 `200 OK`。`items` 中每一项都是完整反馈对象；没有结果时 `items` 返回空数组，`total` 为 0，不返回错误。

```json
{
  "items": [
    {
      "id": 42,
      "reporterId": 7,
      "reporterName": "张三",
      "reporterDept": "研发部",
      "category": "bug",
      "title": "切换工作区后终端无法连接",
      "content": "切换到第二个工作区后，新开的终端一直显示连接中。",
      "status": "processing",
      "attachments": [],
      "attachmentCount": 0,
      "createdAt": "2026-08-21T10:30:12+08:00",
      "updatedAt": "2026-08-21T11:05:44+08:00"
    }
  ],
  "page": 2,
  "pageSize": 10,
  "total": 21
}
```

| 字段 | 说明 |
|---|---|
| `items` | 当前页的反馈对象数组 |
| `page` / `pageSize` | 服务端实际采用的页码和每页条数 |
| `total` | 过滤条件下当前用户反馈总数；客户端可据此与 `pageSize` 计算总页数 |

## 4. 查看反馈详情 `GET /api/feedback/:id`

查看当前用户本人提交的单条反馈及所有附件元数据。状态和附件信息以服务端最新结果为准。

```bash
curl "$BASE/api/feedback/42" \
  -H "Authorization: Bearer $TOKEN"
```

成功返回 `200 OK`，body 为完整反馈对象（§1.2）。反馈不存在或不属于当前用户时统一返回 `404`，不向调用者透露该 ID 是否属于其他用户。

## 5. 下载附件 `GET /api/feedback/:id/attachments/:attachmentId`

附件下载需要鉴权。只有当前用户本人反馈中的附件可以下载；`downloadURL` 就是该接口的相对地址，客户端也可以将其与 `BASE` 拼接成绝对地址。

成功返回 `200 OK` 及原始文件二进制内容，服务端应设置与附件对应的 `Content-Type`、`Content-Length` 和 `Content-Disposition: attachment; filename=...`。下载响应不是 JSON，下载失败时仍使用统一错误格式。

```bash
curl "$BASE/api/feedback/42/attachments/9" \
  -H "Authorization: Bearer $TOKEN" \
  -o ./terminal.log
```

使用 Cookie 下载：

```bash
curl "$BASE/api/feedback/42/attachments/9" \
  -b "session=<登录 Cookie>" \
  -OJ
```

> 下载地址不是公开链接，也不应脱离用户权限长期缓存或分享。附件 ID 与反馈 ID 不匹配、反馈不属于当前用户、附件不存在时，服务端统一返回 `404`。

## 6. 前端 `FormData` 示例

浏览器 `fetch` 直接将 `FormData` 作为 body。不要手动设置 `Content-Type`，浏览器需要自动补充 multipart boundary。下面示例使用 Bearer；同源 Cookie 场景可去掉 `Authorization`，并保留 `credentials: "include"`。

```ts
const BASE = import.meta.env.VITE_AISHELL_SERVER_URL;
const token = getAccessToken();

async function submitFeedback(
  category: "bug" | "suggestion" | "question" | "other",
  title: string,
  content: string,
  files: File[],
) {
  const form = new FormData();
  form.append("category", category);
  form.append("title", title);
  form.append("content", content);

  // 同名 attachments 字段重复追加，服务端接收为多个附件。
  for (const file of files) {
    form.append("attachments", file, file.name);
  }

  const response = await fetch(`${BASE}/api/feedback`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      // 不要在这里设置 Content-Type。
    },
    credentials: "include",
    body: form,
  });

  const data = await response.json();
  if (!response.ok) {
    // 服务端错误格式为 { error: "中文错误信息" }。
    throw new Error(data.error || "提交反馈失败");
  }
  return data;
}

// Cookie 鉴权版本：删除 headers.Authorization 即可。
```

客户端在选择文件时应提前提示并尽量拦截数量、单文件大小和总大小限制，但服务端校验是最终准入条件。客户端还应将服务端返回的 `status` 显示为只读，不能提供修改状态的控件或向 `FormData` 添加 `status` 字段。

## 7. 状态流转与管理员处理

反馈提交后状态为 `pending`。管理员在服务端后台查看反馈、处理问题并更新状态；用户通过列表或详情接口观察状态变化，但没有修改状态的开放接口。

| 状态 | 含义 | 用户可执行操作 |
|---|---|---|
| `pending` | 已提交，等待管理员处理 | 查看详情、下载自己的附件 |
| `processing` | 管理员正在处理 | 查看最新状态、下载自己的附件 |
| `resolved` | 管理员已处理/解决 | 查看处理后的状态、下载自己的附件 |
| `closed` | 反馈已关闭 | 查看记录、下载自己的附件 |

状态更新由管理员后台及其内部服务完成，不在客户端开放 API 中定义 `PUT`、`PATCH`、`DELETE` 或任何管理员查询接口。客户端不应依赖未公开的管理路径，也不能通过伪造 `status`、`reporterId` 或其他字段越权修改反馈。

## 8. 错误格式与错误表

除附件下载成功时返回二进制外，接口错误统一返回 JSON：

```json
{ "error": "中文可读错误信息" }
```

客户端应优先依据 HTTP 状态码处理，再展示或记录 `error` 文本；不要依赖中文错误文案进行程序分支。

| HTTP | 常见场景 | 响应示例 |
|---:|---|---|
| `400` | multipart 格式或请求大小不正确、分类/状态筛选值无效、必填字段为空或超长、附件数量/类型/大小超限 | `{"error":"反馈请求过大或格式不正确"}` |
| `401` | 未认证、Bearer token 缺失/失效，或登录 Cookie 失效 | `{"error":"未登录或登录已过期"}` |
| `403` | 当前账号被禁用 | `{"error":"账号已禁用"}` |
| `404` | 反馈不存在、不属于当前用户，或附件不存在/不属于该反馈 | `{"error":"反馈不存在"}` |
| `409` | 当前用户累计附件已达到部署配置的存储配额 | `{"error":"个人反馈附件累计不能超过 1073741824 字节"}` |
| `500` | 服务端查询或保存反馈失败 | `{"error":"保存反馈失败"}` |
| `503` | 附件存储未配置或暂时不可用 | `{"error":"反馈附件存储未配置"}` |

## 9. 快速验证（curl）

```bash
BASE=https://cloud.example.com
TOKEN=<OAuth2 换发的 access_token>

# 提交反馈（两个同名附件字段）
curl -X POST "$BASE/api/feedback" \
  -H "Authorization: Bearer $TOKEN" \
  -F "category=bug" \
  -F "title=切换工作区后终端无法连接" \
  -F "content=切换到第二个工作区后，新开的终端一直显示连接中。" \
  -F "attachments=@./diagnostics/terminal.log;type=text/plain" \
  -F "attachments=@./screenshots/terminal.png;type=image/png"

# 分页查询本人反馈
curl "$BASE/api/feedback?page=1&pageSize=20" \
  -H "Authorization: Bearer $TOKEN"

# 按状态和分类过滤
curl "$BASE/api/feedback?status=resolved&category=bug&page=1&pageSize=10" \
  -H "Authorization: Bearer $TOKEN"

# 查看详情（替换为真实反馈 ID）
curl "$BASE/api/feedback/<feedbackId>" \
  -H "Authorization: Bearer $TOKEN"

# 下载附件（替换为真实反馈 ID 和附件 ID）
curl "$BASE/api/feedback/<feedbackId>/attachments/<attachmentId>" \
  -H "Authorization: Bearer $TOKEN" \
  -o ./downloaded-attachment
```
