# AIShell 云服务 - 时间线云同步 API 文档（客户端接入）

> 适用对象：aishell2 客户端（托管模式）上报项目时间线（SSH 连接、远程命令、SFTP 传输、AI 会话）与管理本机标签的云端副本。
> 配套文档：`AIShell云服务-OAuth2接入文档.md`（获取令牌）、`AIShell云服务-用户反馈API文档.md`（错误格式惯例）。
> 本文档只描述客户端需要的开放接口。云端同时提供工作台「时间线」页（用户跨项目统一时间线）与管理后台「时间线」页（按用户排查，逐次查询写审计），均为网页端拉取式，客户端无需感知。
> 需求背景与完整规则见云端仓库 `docs/08-timeline-cloud-sync-requirements.md`。

## 1. 总览

| 项目 | 说明 |
|---|---|
| 基址 | 构建期注入的 `AISHELL_SERVER_URL`，与其他云服务接口同源 |
| 鉴权 | `Authorization: Bearer <access_token>`（OAuth2 换发）；401 走既有令牌刷新流程后重试 |
| 请求/响应 | `application/json`；时间戳一律为 epoch 毫秒（正整数） |
| 错误格式 | 统一 JSON `{"error":"中文可读信息","code":"稳定机器码","details":{...}}`（`details` 可缺省），错误码见 §7 |
| 数据范围 | 所有接口只触达当前登录用户本人的数据；多设备并行上报由服务端按 `(user_id, event_id)` 去重合并 |
| 能力开关 | 平台开关 `TIMELINE_SYNC_ENABLED` 关闭时，`GET /api/auth/me` 的 `capabilities.timelineSync=false`，全部 `/api/timeline/*` 返回 403 `TIMELINE_NOT_ENABLED` |

### 1.1 开启条件（客户端判定顺序）

1. 托管模式已登录；
2. `capabilities.timelineSync == true`（重启/重登时刷新，节奏与现有能力缓存一致）；
3. 本机设置「时间线云同步」开关打开（客户端本机设置，**不纳入** core_config 同步白名单）。

任一不满足：只写本地时间线文件，不上报、不排队。收到 403 `TIMELINE_NOT_ENABLED` 时应清空待传队列、暂停上报并刷新能力缓存。

### 1.2 接口清单

| 方法/路径 | 说明 |
|---|---|
| `POST /api/timeline/events` | 批量上报时间线事件（幂等，实时增量与历史回填共用） |
| `PUT /api/timeline/projects/{projectId}/tags` | 全量覆盖某项目的标签列表 |
| `GET /api/timeline/projects` | 本人项目清单（含事件数/最近时间），客户端可用于状态展示 |
| `GET /api/timeline/events` | 跨项目统一时间线查询（游标分页 + 筛选） |
| `GET /api/timeline/tags` | 本人标签名聚合（筛选下拉数据） |
| `DELETE /api/timeline/mine` | 清空本人全部云端时间线（事件 + 标签） |

## 2. 事件上报

```http
POST /api/timeline/events
Content-Type: application/json
Authorization: Bearer <access_token>

{
  "projectId": "3f6b8f2e-…",
  "projectName": "订单服务",
  "deviceHint": "macbook-pro-m3",
  "events": [
    { "id": "01JABCXYZ…", "ts": 1757395200000, "kind": "command",
      "summary": "$ cargo test", "detail": "…脱敏后输出…" },
    { "id": "01JABD001…", "ts": 1757395201500, "kind": "ssh_connect",
      "summary": "连接 order-1 (10.10.1.55:22)" }
  ]
}
```

```json
// 200
{ "accepted": 2, "duplicated": 0 }
```

### 2.1 字段约束

| 字段 | 约束 |
|---|---|
| `projectId` | 必填，≤64 字符；客户端项目 uuid（配置同步用户跨设备一致；未开配置同步的多设备「同名项目」在云端是不同项目，预期行为） |
| `projectName` | 必填，≤128 字符；上报时快照，展示以此为准，改名后新事件带新名字即可 |
| `deviceHint` | 可选，≤128 字符；排查用设备标识 |
| `events` | 必填，1..500 条；单批请求体 ≤2 MB（超限 400 或代理层 413） |
| `events[].id` | 必填，1..64 字符；规则见 §2.2 |
| `events[].ts` | 必填，正整数 epoch 毫秒 |
| `events[].kind` | 必填，10 类之一（见 §2.4） |
| `events[].summary` | 必填，1..512 字符 |
| `events[].detail` | 可选，≤4096 字符（**云端上限**，本地 16K 裁剪不变，上报前截断） |

违例整体 400 `INVALID_TIMELINE_PAYLOAD`，`details` 携带 `index`（出错事件下标）与 `reason`。**整批拒绝，不产生部分写入**，修正后可整批重发（幂等）。

### 2.2 事件 id（幂等去重的关键）

服务端以 `UNIQUE(user_id, event_id)` + `ON CONFLICT DO NOTHING` 去重：重复 id 静默跳过并计入 `duplicated`，不报错。因此**重试、多设备回填同一存量、水位文件丢失重传都是安全的**。

- 新事件：写入本地 jsonl 时生成 ULID（或 uuid v4）填入 `TimelineEntry.id`（新增可选字段，旧文件向后兼容）。
- 存量无 id 事件（回填场景）：读取侧补算确定性 id = `sha256(project_id + ts + kind + summary)` 取前 32 字符 hex。同一存量条目无论在哪台设备回填都得到同一 id，天然去重。

### 2.3 上报时机、水位与回填（客户端侧约定）

- 埋点写本地文件时同步入内存队列；每 60s 或满 200 条触发一次批量上报；退出时尽力 flush 一次（不阻塞退出）。上报失败（网络/5xx/429）保留水位，下周期整批重试，指数退避最长 10 分钟。
- 按项目维护 `last_uploaded_ts` 水位（本机独立小文件，原子写；不进 aishell.json、不进云同步）。水位只是**优化**：丢失最多浪费流量，服务端去重兜底，不产生脏数据。水位推进只以服务端 2xx 为准。
- 首次满足上报条件时回填本地现存时间线（最多 30 天），与实时上报共用本接口，**限速每分钟至多 2 批**；回填期间新事件正常入队（幂等保证不重）。
- 未登录/离线期间的历史**不回填**（避免首次登录突然回传海量历史）。
- 单用户云端事件总量上限 200,000 条，超限返回 413 `QUOTA_EXCEEDED`：客户端应暂停上报并提示用户（用户可删除云端时间线后恢复）。

### 2.4 事件类别枚举（服务端白名单校验）

`ssh_connect` / `ssh_disconnect` / `ssh_connect_failed` / `command` / `file_upload` / `file_download` / `ai_user` / `ai_assistant` / `ai_tool` / `skill`

未知类别整批 400。客户端新增类别必须与服务端版本同步发布。

类别语义（客户端 v1.1.2 起，服务端需 ≥ 迁移 0016）：

- `command`：**仅人工命令**（终端区块上报、SFTP 面板直执）。AI 的 run_command 不再另写 `command`，只由 `ai_tool` 事件覆盖（摘要带 `[本地]` / `[服务器 <名>]` 前缀）。
- `skill`：AI 用 read 工具读取 `<目录名>/SKILL.md` 时触发，**替换该次的 `ai_tool` 事件**（同一次读取不会两条都写）。技能名为 SKILL.md 的父目录名，摘要格式 `AI 读取技能 <name>（成功|失败，Nms）`，detail 为读取内容原文（无结构化 name 字段，按摘要解析）。

### 2.5 脱敏（上传侧强制，不改本地文件）

上报前对 `summary`/`detail` 复用 `redact.rs` 规则做凭据形态替换（`password=xxx`、Bearer token、AK/SK 等）。要求写进验收：

- 本地时间线文件保持原样；云端字段是脱敏后副本；
- 脱敏是尽力而为的形态匹配，**不承诺**捕获所有秘密形态——这是用户开关可见可关、管理端访问留痕、保留期有限（默认 90 天）等治理措施存在的原因。

## 3. 标签全量覆盖

```http
PUT /api/timeline/projects/{projectId}/tags
Content-Type: application/json

{ "tags": [
  { "ts": 1757395200000, "name": "发布", "color": "#4f8ef7",
    "anchorTs": 1757395200000, "anchorKind": "command" }
] }
```

```json
// 200
{ "saved": 1 }
```

- **全量覆盖语义**：请求体即该项目标签全集，服务端事务内先删后写；用户在本地增删标签后整体上传该项目列表（传空数组即清空该项目云端标签）。标签总量小（单项目几十个）、变更低频，无增量协议。
- 校验：单次 ≤200 条；`name` 1..64 字符（服务端 NFC 归一后存储）；`color` 必须 `#rrggbb`；`anchorKind` 限 10 类（含 `skill`——注意客户端上传器的标签净化白名单需同步包含 `skill`，否则打在 skill 事件上的标签不会上传）；`ts`/`anchorTs` 正整数。违例 400 `INVALID_TIMELINE_PAYLOAD`。
- 标签锚定 `(anchorTs, anchorKind)` 与本地一致；「同名标签两两配对构成选区」的配对计算统一在服务端做，客户端本地展示逻辑不受影响。

## 4. 查询（客户端可选）

客户端设置页如需展示云端状态可用以下接口；网页工作台/管理后台也走同一组语义。

### 4.1 项目清单

```http
GET /api/timeline/projects
→ { "items": [ { "projectId": "uuid", "projectName": "订单服务",
                "eventCount": 1234, "lastTs": 1757395200000 } ] }
```

### 4.2 统一时间线

```http
GET /api/timeline/events?projectId=&kinds=command,file_upload&keyword=&tag=发布
   &fromTs=&toTs=&cursor=&limit=100&includeDetail=1
→ { "items": [ { "eventId","ts","kind","summary","detail","projectId","projectName",
                 "tags": [ { "name","color","direct" } ] } ],
    "nextCursor": "…" }
```

- 不带 `projectId` 即全项目混合，`ts DESC` 排序；`nextCursor` 为空表示没有更多。游标为 `(ts, id)` 复合水位，翻页把上页 `nextCursor` 原样带回即可，同毫秒事件不会丢重。
- 筛选均可多值（逗号分隔）：`projectId`、`kinds`、`tag`（AND 语义，命中直接打标或标签对选区内）；`keyword` 对 `summary`+`detail` 做大小写不敏感子串匹配；`fromTs`/`toTs` 为 epoch 毫秒闭区间。
- `limit` 默认 100、上限 500；`includeDetail=0` 时响应不携带 `detail`。
- `tags[].direct`：`true` = 直接打标，`false` = 落在标签对选区内。

### 4.3 标签聚合

```http
GET /api/timeline/tags?projectId=
→ { "items": [ { "projectId": "uuid", "name": "发布", "color": "#4f8ef7" } ] }
```

## 5. 删除云端时间线

```http
DELETE /api/timeline/mine
→ { "deletedEvents": 1234, "deletedTags": 5 }
```

清空本人全部云端事件与标签（服务端写审计 `timeline.user_purge`）。本机时间线文件不受影响；删除后上报重新开始累积。客户端设置页的「删除云端时间线」按钮调此接口（需二次确认）。不提供单条删除（append-only 事实记录语义）。

## 6. 保留与配额一览

| 项 | 默认 | 服务端 env |
|---|---|---|
| 云端保留期 | 90 天（按事件时间清理，标签随锚点过期） | `TIMELINE_RETENTION_DAYS`（0 = 永久） |
| 单用户事件总量 | 200,000 条（超限 413） | `TIMELINE_MAX_EVENTS` |
| 单批条数 / 字节 | 500 条 / 2 MB | `TIMELINE_MAX_BATCH_ITEMS` / `TIMELINE_MAX_BATCH_BYTES` |
| 写入限流 | 30 批/分钟/用户（超限 429 + `Retry-After`） | 固定 |

## 7. 错误码

| code | HTTP | 场景与客户端处理 |
|---|---|---|
| `TIMELINE_NOT_ENABLED` | 403 | 平台能力关闭。清空队列、暂停上报并刷新能力缓存 |
| `INVALID_TIMELINE_PAYLOAD` | 400 | 字段/枚举/长度/批量超限，整批拒绝；按 `details.index`/`reason` 修正后重发 |
| `QUOTA_EXCEEDED` | 413 | 单用户事件总量超限。暂停上报并提示用户清理 |
| `RATE_LIMITED` | 429 | 写入限流，按 `Retry-After` 退避重试 |
| `UNAUTHORIZED` | 401 | 令牌过期，走既有刷新流程后重试 |
