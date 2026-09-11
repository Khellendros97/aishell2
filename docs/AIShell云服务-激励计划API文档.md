# AIShell 云服务 · 激励计划 API 文档

面向 AIShell 桌面客户端的开放接口说明。覆盖：skill 上传登记（上传 skillhub 成功后通知云平台核实计分）、工单处理报告提交与查询、积分规则/明细/排行榜查询。

- 认证：所有接口均需登录会话（Bearer access token 或 Cookie），与客户端其他云服务接口一致。
- 能力开关：`GET /api/auth/me` 下发的 `capabilities.incentive` 为 false 时本组接口全部返回 `403 {"error":"激励计划尚未开启","code":"INCENTIVE_NOT_ENABLED"}`，客户端应隐藏相关入口。
- 错误格式：统一 `{"error":"中文提示"}` + 合适 HTTP 状态码。

---

## 一、skill 上传登记

客户端将 skill 上传到 skillhub **成功后**，调用本接口登记。平台会匿名回查 skillhub 明细接口，以 `ownerDisplayName` 与当前登录用户姓名比对核实归属——**客户端声明的任何作者信息都不被信任，无需也无法上报 ownerId**。

核实通过（verified）后按当前规则入账「skill 上传」积分（默认 20 分/个）。同一 `namespace/slug` 全平台只能登记成功一次。

### POST /api/incentive/skill-uploads

请求体（JSON）：

```json
{ "namespace": "global", "slug": "my-deploy-skill" }
```

- `namespace`：可空，缺省 `global`；团队空间填团队名。仅允许字母数字开头 + `._-`，最长 128。
- `slug`：必填，同上字符约束。

响应：

| 状态 | 含义 |
|---|---|
| 201 Created | 首次登记并核实通过，返回登记记录（已入账） |
| 200 OK | 本人此前已登记过该 skill（幂等，不重复计分） |
| 400 | namespace/slug 格式无效 |
| 403 | skill 作者不是当前用户（防冒领，记录一条 rejected 供管理端审计） |
| 404 | skillhub 上不存在该 skill（请确认 namespace/slug 或稍后再试——刚上传可能有可见性延迟） |
| 409 | 该 skill 已被他人登记 |
| 502 | 回查 skillhub 失败，可稍后重试 |
| 503 | 平台未配置 skillhub 地址 |

响应体（200/201）：

```json
{
  "id": 1, "userId": 7, "namespace": "global", "slug": "my-deploy-skill",
  "ownerName": "张三", "status": "verified", "reason": "", "createdAt": "2026-09-10T12:00:00+08:00"
}
```

### GET /api/incentive/skill-uploads/mine

本人登记记录（含未通过的），返回 `{"items": SkillUploadRecord[]}`，按时间倒序，最多 200 条。

---

## 二、工单处理报告

提交处理报告（支持多附件），管理员审核通过（approved）后入账「工单报告」积分（默认 20 分/条）。

### POST /api/incentive/ticket-reports

单次 `multipart/form-data`：

- 文本字段：`title`（必填 ≤120 字符）、`content`（必填 ≤10000 字符）、`ticketRef`（选填，工单号或链接 ≤255 字符）
- 文件字段：多个文件重复使用 `attachments` 字段
- 限制：每单最多 10 个附件，单文件 ≤ 20 MiB，单次合计 ≤ 100 MiB，每用户累计 ≤ 1 GiB
- 附件类型：常见图片、PDF、Office/ODF、文本/日志、zip/7z/rar/tar.gz 等；脚本、可执行文件、SVG、HTML 会被拒绝（服务端做扩展名白名单 + 文件签名检查）

响应 201 Created，返回报告对象：

```json
{
  "id": 1, "reporterId": 7, "reporterName": "张三", "reporterDept": "研发部",
  "title": "工单 #1024 磁盘扩容", "content": "...", "ticketRef": "TICKET-1024",
  "status": "pending", "reviewComment": "", "reviewerName": "", "reviewedAt": null,
  "createdAt": "...", "updatedAt": "...",
  "attachments": [{ "id": 1, "filename": "steps.md", "contentType": "text/markdown", "sizeBytes": 128, "sha256": "...", "downloadURL": "/api/incentive/ticket-reports/1/attachments/1" }],
  "attachmentCount": 1
}
```

### GET /api/incentive/ticket-reports

本人报告列表。查询参数：`status`（pending/approved/rejected）、`page`（默认 1）、`pageSize`（默认 20，最大 100）。

返回 `{"items": [...], "total", "page", "pageSize"}`，按提交时间倒序。`status` 为 approved 时表示已入账积分；rejected 时 `reviewComment` 含管理员意见。

### GET /api/incentive/ticket-reports/:id

本人报告详情（他人报告返回 404）。

### GET /api/incentive/ticket-reports/:id/attachments/:attachmentId

附件下载（本人或管理员）。强制 `Content-Disposition: attachment` + `nosniff`。

---

## 三、积分展示（客户端直接查看）

本节三组接口均为**登录即可读**，用于客户端内置「激励计划」页：规则说明 + 本人明细 + 全员排行榜（含查看任一成员的明细）。全部为只读 GET，无副作用。

### 3.1 维度键对照表（客户端展示务必按此映射中文）

**同一个维度在两处使用不同命名的键，不要在客户端直接复用**：

| 规则接口键（camelCase） | 明细/排行接口键（snake_case） | 中文名称 | 计分单位 |
|---|---|---|---|
| `aiTool` | `ai_tool` | AI 工具调用 | 次 |
| `manualOps` | `manual_ops` | 人工命令/sftp | 次 |
| `ticketReport` | `ticket_report` | 工单报告 | 条 |
| `skillUpload` | `skill_upload` | skill 上传 | 个 |
| `skillReference` | `skill_reference` | skill 被引用 | 次 |
| `feedback` | `feedback` | 问题反馈 | 次 |

`byDimension` 与 `items[].dimension` 用 snake_case，且**只包含已得分的维度**（无该维度流水时键不存在，客户端按缺省 0 处理）。建议客户端内置一张 snake_case → 中文的映射表用于渲染。

### 3.2 GET /api/incentive/rules

当前生效的计分规则（管理员可在后台调整，改后即时生效，客户端每次进入页面拉取即可）：

```json
{
  "aiTool":         { "enabled": true, "points": 1 },
  "manualOps":      { "enabled": true, "points": 5 },
  "ticketReport":   { "enabled": true, "points": 20 },
  "skillUpload":    { "enabled": true, "points": 20 },
  "skillReference": { "enabled": true, "points": 1 },
  "feedback":       { "enabled": true, "points": 10 }
}
```

每个维度 `enabled` 为 false 表示该维度已停用（不再入账，存量流水保留），客户端可置灰展示。

> 一期仅 `skillUpload`、`ticketReport` 两个维度有实际数据；其余维度待时间线上报对接后开启采集。

### 3.3 GET /api/incentive/points/mine

本人积分汇总 + 明细分页。

查询参数：`page`（默认 1）、`pageSize`（默认 20，最大 100）。

```json
{
  "userId": 7, "userName": "张三", "userDept": "研发部",
  "total": 40,
  "byDimension": { "skill_upload": 20, "ticket_report": 20 },
  "items": [
    { "id": 3, "userId": 7, "dimension": "ticket_report", "points": 20,
      "sourceType": "ticket_report", "sourceId": "1",
      "note": "工单报告「工单 #1024 磁盘扩容」审核通过",
      "createdAt": "2026-09-10T12:38:43+08:00" }
  ],
  "itemTotal": 2, "page": 1, "pageSize": 20
}
```

字段语义（易混，务必区分）：

- **`total`**：积分总分（各维度分值之和，用于展示"我的积分"）。
- **`byDimension`**：各维度得分小计，键为 snake_case，仅含有分的维度。
- **`itemTotal`**：**流水条数**（不是分值），用于算分页页码；而 `total` 是分值。二者不可混用。
- `items`：按 `createdAt` 倒序（同时间按 id 倒序）。`note` 是人类可读的入账说明，可直接展示；`sourceType`/`sourceId` 为溯源标识（如工单报告 id），需要深链时使用。

### 3.4 GET /api/incentive/points/users/:id

查看**任意用户**的积分明细，响应结构与 3.3 完全一致（`userId`/`userName`/`userDept` 为该用户）——全员公开透明，这是激励计划的既定规则。

- `:id` 从排行榜条目的 `userId` 取得。
- 用户不存在返回 404 `{"error":"用户不存在"}`。

### 3.5 GET /api/incentive/points/leaderboard

全员积分排行榜，**按总分降序、无分页**（全员一次返回）；同分并列名次（1、1、3 式竞赛排名）。含各维度小计，前端点击某成员即可用其 `userId` 调 3.4 看明细。

```json
{
  "items": [
    { "rank": 1, "userId": 7, "name": "张三", "dept": "研发部", "total": 40,
      "byDimension": { "skill_upload": 20, "ticket_report": 20 } }
  ],
  "generatedAt": "2026-09-10T12:36:56+08:00"
}
```

- 无人得分时 `items` 为空数组。
- `generatedAt` 为服务端生成时间，客户端可用于提示"榜单更新于 …"。
- 返回的 `name`/`dept` 即用户姓名与部门，无需另调用户接口。

---

## 客户端集成建议

1. **上传 skill 成功后自动登记**：上传流程（浏览器自动化）拿到 skill 的 `namespace/slug` 后调 `POST /api/incentive/skill-uploads`。收到 404（刚上传可能不可见）或 502 时可延迟重试；409/403 为终态，不要重试。
2. **工单报告**：若客户端内嵌报告提交入口，按上述 multipart 约定提交；也可引导用户到工作台「工单报告」页面提交。
3. **激励计划页数据流**（对应第三节）：
   - 进入页面：并行拉 `rules`（展示计分规则）+ `points/mine`（本人总分与明细）+ `leaderboard`（排行）；
   - 实时性：排行榜建议 15–30 秒轮询（服务端无推送）；`points/mine` 在页面可见或操作后刷新即可；
   - 查看他人明细：点排行榜某行 → 用其 `userId` 调 `points/users/:id`，分页行为与本人明细一致；
   - 「我的排名」：在 `leaderboard.items` 中按本人 `userId` 查找 `rank`。
4. **能力开关**：`GET /api/auth/me` 的 `capabilities.incentive` 为 false 时，隐藏所有激励入口，不要调本节接口（会 403）。
