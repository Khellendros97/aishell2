# AIShell 云服务 - 记忆卡片 API 文档（客户端接入）

> 适用对象：aishell2 客户端（托管模式）调用云端记忆能力。
> 配套文档：`AIShell云服务-OAuth2接入文档.md`（获取令牌）、`AIShell云服务-开放API文档.md`（代理能力）。
> 记忆服务 = 自托管 mem0，卡片分**共享**（团队全员可见）与**个人**（仅本人可见）两种作用域；本文档覆盖客户端主动提交、查询、检索、提升记忆的全部开放接口。

## 1. 总览

| 项目 | 说明 |
|---|---|
| 基址 | 构建期注入的 `AISHELL_SERVER_URL`（如 `https://cloud.example.com`），与代理接口同源 |
| 鉴权 | `Authorization: Bearer <access_token>`（OAuth2 换发，2 小时有效）；同源浏览器下登录 Cookie 亦可 |
| 错误格式 | 统一 JSON `{"error": "中文可读信息"}` |
| 权限模型 | **创建者本人或管理员**可编辑/删除；其余登录用户只读。**个人卡片仅创建者本人可见**（管理员亦不可见他人个人记忆），共享卡片全员可见 |
| 来源 | `source: "manual"`（客户端/用户主动提交，原文保存）或 `"auto"`（对话流量 AI 自动沉淀，见 §9） |

### 1.1 接口清单

| 方法/路径 | 说明 |
|---|---|
| `POST /api/memories` | **主动提交**一条记忆（原文入库，不被 AI 改写；`scope` 决定共享/个人） |
| `POST /api/memories/sediment` | **上报对话历史**触发自动沉淀（客户端无法修改 LLM 请求体时使用，见 §10） |
| `GET /api/memories` | 拉取记忆卡片（`scope` 过滤：共享 / 个人 / 全部，见 §3） |
| `PUT /api/memories/{id}` | 编辑/纠正卡片（可带纠正说明） |
| `DELETE /api/memories/{id}` | 删除卡片（不可见，历史一并清除） |
| `GET /api/memories/{id}/history` | 单卡变更历史（留痕时间线） |
| `POST /api/memories/{id}/promote` | **个人卡片提升为共享**（显式操作，写入审计；见 §8） |
| `POST /api/memories/search` | 语义检索记忆（top-k，`scope` 过滤，见 §7） |

### 1.2 卡片对象（所有列表/创建响应的统一结构）

```json
{
  "id": "83d6beb5-2cdb-4c45-8c8a-123e8282813e",
  "content": "生产发布前必须冻结主干分支",
  "category": "编码规范",
  "tags": ["发布", "分支"],
  "creatorId": 7,
  "creatorName": "张三",
  "dept": "研发部",
  "source": "manual",
  "scope": "shared",
  "projectName": "aishell-cloud",
  "sessionId": "chat-2026-08-12-0001",
  "date": "2026-08-12",
  "createdAt": "2026-08-12 11:46",
  "updatedAt": "2026-08-12 11:46"
}
```

| 字段 | 说明 |
|---|---|
| `id` | mem0 生成的 UUID 字符串 |
| `content` | 记忆内容（手动提交为原文；自动沉淀为 AI 抽取事实） |
| `category` | 分类；新自动卡片恒有值（AI 分类，失败回退 `其他`），历史旧自动卡片可能为空，前端显示「未分类」 |
| `tags` | 标签数组（无标签时为 `[]`）；自动卡片含服务端生成的 `项目:` / `日期:` / `会话:` 标签 |
| `creatorId` / `creatorName` / `dept` | 创建者信息，**创建时快照**，不随改名/改部门更新 |
| `source` | `manual` / `auto` |
| `scope` | `shared`（团队共享）/ `personal`（仅本人可见）；存量旧卡片为空，按共享处理 |
| `projectName` / `sessionId` / `date` | 自动卡片元数据（来源见 §9）；手动卡片通常无，客户端可忽略 |
| `createdAt` / `updatedAt` | `YYYY-MM-DD HH:mm`（服务端本地时区） |

## 2. 主动提交 `POST /api/memories`

客户端「标记重要记忆」的入口：内容**原文保存**（`infer=false`，LLM 不改写），提交后立即可见（共享卡片全员可见，个人卡片仅本人可见）。

### 2.1 请求

```json
{
  "content": "生产发布前必须冻结主干分支",
  "category": "编码规范",
  "tags": ["发布", "分支"],
  "scope": "shared"
}
```

| 字段 | 约束 |
|---|---|
| `content` | 必填，≤ 2000 字（超限 → `400 记忆内容必填且不超过 2000 字`） |
| `category` | 必填，≤ 32 字；建议取固定分类：`编码规范 / 排障经验 / 提示词技巧 / 工具配置 / 业务流程 / 其他 / 个人记忆` |
| `tags` | 选填，≤ 8 个、每个 ≤ 24 字，空串自动剔除 |
| `scope` | 选填，`shared`（默认）/ `personal`；其他值 → `400`。共享入口提交 `shared`，个人工作记录/偏好等提交 `personal`。**未传时按分类联动**：分类选 `个人记忆` 则默认 `personal`，其余分类默认 `shared` |

> 创建者信息**无需客户端传**：服务端从当前会话快照 `creatorId/creatorName/dept`。

### 2.2 响应

`201 Created`，body 为完整卡片对象（§1.2），`id` 即为后续编辑/删除/查历史用的标识。

```bash
curl -X POST $BASE/api/memories \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"生产发布前必须冻结主干分支","category":"编码规范","tags":["发布"]}'
```

### 2.3 客户端推荐时机

- 用户显式「记住这条」/「加入团队记忆」操作（团队经验用 `scope:"shared"`，个人工作记录/偏好用 `scope:"personal"`）；
- 对话中被用户标记为重要、或客户端判定为高价值经验时（提示用户确认后提交，避免噪音）；
- 提交成功 → 本地记录 `id`；重复提交同一内容会生成重复卡片（服务端不做去重），客户端应自行幂等提示。

## 3. 列表 `GET /api/memories`

按 `scope` 查询参数拉取卡片（企业规模千级以内一次拉取；不分页）：

| `scope` 参数 | 返回内容 |
|---|---|
| 缺省 / `all` | **共享卡片 + 当前用户个人卡片** |
| `shared` | 仅共享卡片（含存量旧卡片） |
| `personal` | 仅当前用户个人卡片 |

> 所有 `scope` 下的列表均**按更新时间倒序**（最近更新的在前）。
> 个人卡片**只能看到当前用户自己的**：他人的个人卡片在任何 `scope` 下都不会出现（管理员同样不可见）。

### 3.1 响应

```json
{ "memories": [ /* §1.2 卡片对象数组 */ ] }
```

```bash
# 默认（共享 + 我的个人）
curl "$BASE/api/memories" -H "Authorization: Bearer $TOKEN"
# 仅共享
curl "$BASE/api/memories?scope=shared" -H "Authorization: Bearer $TOKEN"
# 仅我的个人
curl "$BASE/api/memories?scope=personal" -H "Authorization: Bearer $TOKEN"
```

## 4. 编辑/纠正 `PUT /api/memories/{id}`

仅**创建者本人或管理员**可调用；修改会写入变更历史（§6），可附加纠正说明留痕。
个人卡片仅本人可见，因此实际上只有创建者本人能编辑自己的个人卡片（管理员看不到他人个人卡片）。

### 4.1 请求

```json
{
  "content": "生产发布前必须冻结主干分支（含 hotfix 例外）",
  "category": "编码规范",
  "tags": ["发布", "分支", "hotfix"],
  "note": "补充 hotfix 例外说明"
}
```

字段约束同 §2.1；`note` 选填（≤ 512 字），写入历史与审计。

### 4.2 响应

`200 OK`，body `{"ok": true}`。

### 4.3 错误

| HTTP | 场景 |
|---|---|
| 403 | 非创建者且非管理员 → `{"error":"只能编辑自己上传的记忆卡片"}` |
| 404 | 卡片不存在 |

## 5. 删除 `DELETE /api/memories/{id}`

权限同 §4；删除后不可见，**变更历史一并清除，不可恢复**。

- 成功：`204 No Content`；
- 不存在：`404 {"error":"记忆卡片不存在"}`；
- 客户端删除前应二次确认（服务端无回收站）。

## 6. 变更历史 `GET /api/memories/{id}/history`

### 6.1 响应

```json
{
  "history": [
    {
      "event": "ADD",
      "value": "生产发布前必须冻结主干分支",
      "ts": "2026-08-12 11:46",
      "actor": "张三",
      "note": ""
    },
    {
      "event": "UPDATE",
      "value": "生产发布前必须冻结主干分支（含 hotfix 例外）",
      "ts": "2026-08-12 12:03",
      "actor": "李四(管理员代编辑)",
      "note": "补充 hotfix 例外说明"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `event` | `ADD`（新增）/ `UPDATE`（修订） |
| `value` | 该事件后的卡片内容快照 |
| `ts` | 事件时间 `YYYY-MM-DD HH:mm` |
| `actor` | 归属：`ADD` 且 `source=auto` → `AI 自动沉淀`；`ADD` → 创建者姓名；最近一次 `UPDATE` → 最近编辑者（管理员代编辑带 `(管理员代编辑)` 后缀）；更早的修订无法归属 → `—` |
| `note` | 最近一次修订的纠正说明；无 → 空串 |

时间线渲染建议：ADD 用「新增」、UPDATE 用「修订」区分，`actor + ts + value + note` 依次展示。

## 7. 语义检索 `POST /api/memories/search`

按语义相似度返回 top-k 命中；`scope` 缺省时检索**共享 + 当前用户个人**记忆（个人检索失败不阻断共享结果）。

### 7.1 请求

```json
{ "query": "Redis 密码去哪找", "topK": 5, "scope": "all" }
```

| 字段 | 约束 |
|---|---|
| `query` | 必填，非空 |
| `topK` | 选填，默认 10，clamp 1–20 |
| `scope` | 选填，`all`（默认，共享+当前用户个人）/ `shared` / `personal` |

### 7.2 响应

```json
{
  "results": [
    {
      "id": "b583edb2-…", "content": "测试环境的 Redis 密码统一放在配置中心 vault 里", "category": "排障经验",
      "tags": ["项目:aishell-cloud", "日期:2026-08-12"], "creatorId": 7, "creatorName": "张三", "dept": "研发部",
      "source": "auto", "scope": "shared", "createdAt": "2026-08-12 11:47", "updatedAt": "2026-08-12 11:47",
      "score": 0.334
    }
  ]
}
```

`results` 按相关度**降序**（`score` 为距离度量，值越小越相关，客户端按数组顺序取用即可）；`score` 语义未来可能随服务端调整，客户端不应依赖具体阈值。

## 8. 提升为共享 `POST /api/memories/{id}/promote`

将**本人个人卡片**提升为团队共享（原文保留，不被 AI 改写）。提升后原个人卡片消失，共享空间出现同一内容的共享卡片（新 `id`）。

- 适用：用户误把团队经验记成个人、或想共享个人工作成果时，在「我的个人记忆」中显式操作；
- 仅**卡片创建者本人**可调用（他人的个人卡片对调用方不可见）；**必须显式确认**，服务端写入审计日志；
- 成功：`200 {"ok": true, "id": "<新共享卡片 id>"}`；
- 不存在/不是本人个人卡片：`404 {"error":"个人记忆卡片不存在"}`。

```bash
curl -X POST $BASE/api/memories/<id>/promote -H "Authorization: Bearer $TOKEN"
```

## 9. 与自动沉淀的关系

| 通道 | 触发方 | 内容 | 何时可见 |
|---|---|---|---|
| **主动提交**（本文 §2） | 客户端/用户 | 原文保存，LLM 不改写 | 提交后立即可见 |
| 自动沉淀 | 服务端代理层（`infer=true`） | AI 从对话流量抽取事实，自动分类 `scope`/`category`/业务标签 | 对话响应完成后按批次入库（见下） |

- **批量触发**：服务端按会话聚合（LLM 请求携带 `sessionId` 时跨请求累计，见开放 API 文档 §2.1），同一会话累计 **8 条消息或 2000 字立即沉淀**，不足时**闲置 5 分钟**沉淀；**不携带 `sessionId` 的 LLM 请求不参与自动沉淀**（旧客户端兼容，需沉淀请用 §10 上报接口）；
- **自动分类**：每批由服务端独立 LLM 调用判断 `scope`（`shared`/`personal`，隐私优先：不确定一律个人）、`category`（固定分类表）与业务标签；分类失败回退 `personal` + `其他`，不阻断沉淀；
- **服务端标签**：自动卡片额外带 `项目:{projectName}`、`日期:{YYYY-MM-DD}`、`会话:{sessionId}` 标签与 `projectName`/`sessionId`/`date` 元数据（请求未携带相应字段时省略）；
- 自动沉淀受管理端系统设置「AI 自动沉淀」开关控制，可全局关闭；
- 对话召回注入（「对话召回注入」开关）在对话时检索**共享记忆 + 当前用户个人记忆**注入上下文，与本文接口独立；
- 客户端主动提交不受上述开关影响，始终可用（除非服务端整体未配置记忆服务 → 见 §11）。

## 10. 上报对话历史 `POST /api/memories/sediment`

**适用场景**：客户端是 pi coding agent 等封装、**无法修改 LLM 请求体**携带 `sessionId`/`projectName` 元数据时，在对话结束后把完整历史显式上报给服务端，触发与 LLM 请求完全相同的自动沉淀管线（AI 分类 + 服务端标签，见 §9）。

### 10.1 请求

```json
{
  "sessionId": "chat-2026-08-12-0001",
  "projectName": "aishell-cloud",
  "messages": [
    { "role": "user", "content": "测试环境 Redis 密码在哪" },
    { "role": "assistant", "content": "统一放在配置中心 vault" }
  ],
  "flush": true
}
```

| 字段 | 约束 |
|---|---|
| `messages` | 必填，非空数组；仅 `user`/`assistant` 消息参与沉淀，`system`/`tool` 等其余 role **静默忽略**（客户端可直接上传含系统提示词的完整历史）；每条 content ≤ 10000 字、最多 200 条 |
| `sessionId` | 选填；与 LLM 请求**共用同一缓冲**——同一会话两条路径上报的消息会合并累计（8 条/2000 字触发），建议与对话会话一一对应 |
| `projectName` | 选填，写入卡片标签与元数据 |
| `memoryScope` | 选填，`shared`/`personal` 提示（服务端仅作参考，最终以 AI 分类为准） |
| `flush` | 选填，默认 `true`：上报后**立即入队沉淀**（对话结束场景）；`false`：仅写入缓冲，按阈值（8 条/2000 字）或闲置 5 分钟触发（持续/分片上报场景） |

### 10.2 响应

`200 {"ok": true, "queued": true}`（`queued` 反映 `flush` 生效结果）；沉淀本身由调度器异步完成，不阻塞响应。

### 10.3 错误

| HTTP | 场景 |
|---|---|
| 400 | `messages` 为空 / 超限 / 无可沉淀的 user、assistant 消息 / 请求体非 JSON |
| 401 | 未认证或 access_token 失效 |
| 503 | 记忆服务未配置（`MEM0_API_KEY` 为空） |

```bash
curl -X POST $BASE/api/memories/sediment \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sessionId":"chat-1","projectName":"aishell-cloud","messages":[{"role":"user","content":"Redis 密码去哪找"},{"role":"assistant","content":"配置中心 vault"}]}'
```

## 11. 错误码汇总

| HTTP | 场景 |
|---|---|
| 400 | 请求体非 JSON / 字段校验失败（content、category、tags、query、scope、messages） |
| 401 | 未认证或 access_token 失效（用 refresh 轮换后重试） |
| 403 | 账号被禁用 / 编辑删除他人卡片（§4.3） |
| 404 | 卡片不存在 / 个人卡片不存在（§8） |
| 502 | 记忆服务暂时不可用（mem0 异常，可稍后重试） |
| 503 | 记忆服务未配置（服务端 `MEM0_API_KEY` 为空，功能整体关闭） |

## 12. 快速验证（curl）

```bash
BASE=https://cloud.example.com
TOKEN=<OAuth2 换发的 access_token>

# 主动提交（共享）
curl -X POST $BASE/api/memories \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"生产发布前必须冻结主干分支","category":"编码规范","tags":["发布"]}'

# 主动提交（个人）
curl -X POST $BASE/api/memories \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"我的个人工作笔记","category":"个人记忆","tags":[],"scope":"personal"}'

# 列表（共享 + 我的个人）
curl "$BASE/api/memories" -H "Authorization: Bearer $TOKEN"

# 上报对话历史触发自动沉淀（客户端无法改 LLM 请求体时）
curl -X POST $BASE/api/memories/sediment \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sessionId":"chat-1","projectName":"aishell-cloud","messages":[{"role":"user","content":"Redis 密码去哪找"},{"role":"assistant","content":"配置中心 vault"}]}'

# 检索
curl -X POST $BASE/api/memories/search \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"发布流程","topK":5}'

# 个人卡片提升为共享（替换为真实 id）
curl -X POST $BASE/api/memories/<id>/promote -H "Authorization: Bearer $TOKEN"

# 历史（替换为真实 id）
curl "$BASE/api/memories/<id>/history" -H "Authorization: Bearer $TOKEN"
```
