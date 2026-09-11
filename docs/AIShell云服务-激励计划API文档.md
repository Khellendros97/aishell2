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

## 三、积分规则 / 明细 / 排行榜

### GET /api/incentive/rules

当前生效的计分规则（登录即可见）：

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

维度与中文对照：`aiTool` AI 助手工具调用（次）、`manualOps` 人工 ssh 命令/sftp 运维（次）、`ticketReport` 工单报告审核通过（条）、`skillUpload` 上传 skill（个）、`skillReference` skill 被他人引用（次）、`feedback` 问题反馈（次）。

> 一期仅 `skillUpload`、`ticketReport` 两个维度有数据；其余维度待客户端时间线上报对接后开启采集。

### GET /api/incentive/points/mine

本人积分汇总与明细分页（`page`/`pageSize`）：

```json
{
  "userId": 7, "userName": "张三", "userDept": "研发部",
  "total": 40, "byDimension": { "skill_upload": 20, "ticket_report": 20 },
  "items": [{ "id": 3, "userId": 7, "dimension": "ticket_report", "points": 20, "sourceType": "ticket_report", "sourceId": "1", "note": "工单报告「工单 #1024 磁盘扩容」审核通过", "createdAt": "..." }],
  "itemTotal": 2, "page": 1, "pageSize": 20
}
```

### GET /api/incentive/points/users/:id

查看任意用户的积分明细（结构同上）——全员公开透明。用户不存在返回 404。

### GET /api/incentive/points/leaderboard

全员积分榜（登录即可见）：按总分降序，同分并列名次，含各维度小计。

```json
{
  "items": [{ "rank": 1, "userId": 7, "name": "张三", "dept": "研发部", "total": 40, "byDimension": { "skill_upload": 20 } }],
  "generatedAt": "..."
}
```

---

## 客户端集成建议

1. **上传 skill 成功后自动登记**：上传流程（浏览器自动化）拿到 skill 的 `namespace/slug` 后调 `POST /api/incentive/skill-uploads`。收到 404（刚上传可能不可见）或 502 时可延迟重试；409/403 为终态，不要重试。
2. **工单报告**：若客户端内嵌报告提交入口，按上述 multipart 约定提交；也可引导用户到工作台「工单报告」页面提交。
3. **积分榜轮询**：如需在客户端展示排名，建议 15–30 秒轮询 `leaderboard`；`points/mine` 展示本人明细。
