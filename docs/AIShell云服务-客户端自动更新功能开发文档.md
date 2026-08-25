# AIShell 云服务版客户端自动更新功能开发文档

> **状态**：本文档即实施规范。云服务发布 API、受控制品存储及管理员 ReleasePanel 已完成（服务端）；客户端 updater（`src-tauri/src/update.rs` 状态机 + 设置页「关于与更新」）、签名 CI 与云服务 draft 上传流水线（`.github/workflows/build-desktop.yml` + `scripts/publish-update.sh`）已实现。  
> **待办**：配置 CI Secrets（TAURI_SIGNING_PRIVATE_KEY 等，见 §6.1/§8.3）、云服务启用 HTTPS、按 §9.3 完成 beta 渠道真实升级端到端验收后，方可宣称 stable 自动更新生效。  
> **目标**：让已安装客户端无需 GitHub 凭据即可发现、下载并验证云服务发布的更新，由用户确认后安全重启安装。

配套文档：

- `docs/AIShell云服务-客户端产品发布指南.md`
- `docs/AIShell云服务-客户端需求文档.md`（其中 CR-6 为早期需求依据）
- 云服务仓库 `docs/updates.md`（服务端上传、发布与查询协议）

---

## 1. 背景与边界

客户端源码发布仓库为私有仓库：

```text
https://github.com/Khellendros97/aishell-cloud-enhance.git
```

私有 GitHub Release 不能作为未登录客户端的下载来源，也不能在客户端内置 GitHub Token。因此采用：

```text
私有客户端仓库 GitHub Actions
  → 构建各平台 updater 制品并用 Tauri 私钥签名
  → 使用独立 CI 发布令牌上传 AIShell 云服务
  → 云服务保存制品、元数据和频道指针
  → 客户端公开查询云服务并用内置公钥验签
```

### 1.1 目标

- 无需用户登录即可检查安全更新。
- 仅接受由受信任 CI 签名的更新制品。
- 支持 Windows x64、macOS Apple Silicon、macOS Intel。
- 后台检查和下载不打断终端、SSH、SFTP 或 AI 会话。
- 下载完成后由用户明确选择“重启并更新”。
- 支持 stable/beta 频道，以及服务端撤回和回滚。

### 1.2 非目标

首期不实现：

- 静默强制更新或自动关闭用户会话。
- 客户端自动降级。
- 运行中的应用自行覆盖 exe 或删除应用目录。
- 客户端访问私有 GitHub Release 或携带 GitHub Token。
- 在管理后台手工上传二进制、编辑签名或保管签名私钥。
- Windows Authenticode、Apple Developer ID / Notarization（独立后续工作）。

---

## 2. 当前实现现状

### 2.1 已完成：云服务发布端

云服务已经提供：

| 能力 | 端点 / 说明 |
| --- | --- |
| 公开更新检查 | `GET /api/updates/latest` |
| 公开制品下载 | `GET` / `HEAD /api/updates/artifacts/:id`，支持 Range、ETag、不可变缓存 |
| CI 创建 draft | `POST /api/internal/updates/releases` |
| CI 上传制品 | `PUT /api/internal/updates/releases/:version/artifacts/:target` |
| CI 完成检查 | `POST /api/internal/updates/releases/:version/complete` |
| 管理员发布控制 | `/api/admin/updates/releases`、publish、yank、rollback |
| 本地受控存储 | 临时文件、大小限制、SHA-256 校验、不可覆盖归档 |

服务端仅接受来源仓库：

```text
khellendros97/aishell-cloud-enhance
```

CI 发布令牌在服务端只保存 SHA-256 摘要；更新查询和下载公开、无 Cookie/Bearer。

### 2.2 未完成：客户端 updater

当前客户端仍缺少：

- `tauri-plugin-updater` 依赖与 Tauri plugin 初始化。
- updater endpoint、公钥与安装包 updater 配置。
- `update_check`、`update_download`、`update_install` Rust 命令。
- 更新状态事件、并发控制、下载进度与 debug 诊断。
- 设置页“关于与更新”区域。
- CI 私钥签名、`.sig` 和 updater artifact 上传。
- 从旧版本到新版本的真实安装验证。

当前 `.github/workflows/build-desktop.yml` 只构建并上传 DMG/App/MSI/NSIS 安装包；没有 updater 签名或 `.sig`。`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与 capability 配置也未声明 updater。

---

## 3. 发布前置：单一版本源

自动更新版本比较必须使用同一 SemVer。发布开发开始前，统一：

```text
package.json.version
src-tauri/tauri.conf.json.version
src-tauri/Cargo.toml.version
Git tag vX.Y.Z
```

推荐以 `src-tauri/tauri.conf.json` 的产品版本为对外真值，并增加脚本/CI 校验：

```text
vX.Y.Z == tauri.conf.json.version == package.json.version == Cargo.toml.version
```

未完成统一前，禁止启用 `latest` 检查和自动安装，否则客户端上报的 `current` 与服务端 release 版本可能错误比较。

---

## 4. 客户端架构设计

### 4.1 改动范围

| 文件 | 改动 |
| --- | --- |
| `src-tauri/Cargo.toml` | 增加 Tauri updater 与重启/进程支持依赖 |
| `src-tauri/tauri.conf.json` | 配置 updater endpoint、验签公钥、生成 updater bundle |
| `src-tauri/capabilities/default.json` | 授予最小 updater / process 权限 |
| `src-tauri/src/lib.rs` | 初始化 updater plugin、注册命令、启动延迟检查任务 |
| `src-tauri/src/update.rs`（新增） | 更新状态机、检查、下载、安装、事件与持久化 |
| `src/api.ts` | 封装 invoke 命令与更新事件类型 |
| `src/pages/settings/Settings.tsx` 及样式 | 新增“关于与更新”区域 |
| `src/components/Topbar.tsx` | 复用统一版本与更新状态，不重复请求 |
| `src/debug.ts` | 记录脱敏检查/下载/安装错误 |
| `.github/workflows/build-desktop.yml` | 签名、生成 updater 制品、上传云服务 draft |

不要复用 `scripts/fetch-pi.mjs` 的“删除旧目录后复制”模式更新应用自身；Windows 运行中不能安全覆盖当前 exe。应用替换必须由 Tauri updater / 安装器在退出后处理。

### 4.2 状态机

Rust 后端持有唯一更新任务，前端只读取状态：

```text
idle
  → checking
  → not_available
  → available
  → downloading
  → ready
  → installing
  → error
```

建议状态结构：

```ts
interface UpdateStatus {
  state: "idle" | "checking" | "not_available" | "available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  availableVersion?: string;
  notes?: string;
  publishedAt?: string;
  progress?: { downloaded: number; total?: number };
  lastCheckedAt?: string;
  error?: string;
}
```

约束：

- 同一进程中只能有一个 check 或 download 任务。
- 手动检查应复用进行中的任务，而不是并发发起请求。
- 已下载但未安装的版本必须持久化必要状态；安装前重新确认服务端未 yank。
- 不持久化 access token、发布 token、签名私钥或 GitHub token。

### 4.3 Tauri 命令与事件

新增 invoke 命令：

| 命令 | 用途 |
| --- | --- |
| `update_status` | 返回当前更新状态 |
| `update_check` | 手动检查更新；手动失败返回中文错误 |
| `update_download` | 下载并由 Tauri updater 验签，进入 ready |
| `update_install` | 用户确认后退出、安装并重启 |

新增事件：

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `update:status-changed` | `UpdateStatus` | 状态切换 |
| `update:download-progress` | 下载字节数/百分比 | 设置页进度 |
| `update:ready` | 新版本信息 | 提示用户重启 |

后台检查失败只写脱敏 debug；手动点击“检查更新”必须给出可执行的中文结果。

---

## 5. 更新检查策略

### 5.1 调度

- 应用主窗口就绪后延迟约 10 秒首次检查。
- 应用存活期间每 24 小时检查一次。
- 设置页提供“检查更新”按钮。
- 仅当构建期注入 `AISHELL_SERVER_URL` 时启用；个人构建不检查。
- 更新检查不依赖 OAuth 登录，用户登录失效也不能阻断安全修复。

服务端地址是构建期常量，不提供任意 updater URL 配置入口。客户端必须去除 server URL 的尾部 `/` 后拼接路径。

### 5.2 请求

```http
GET {AISHELL_SERVER_URL}/api/updates/latest?target=windows-x86_64&current=0.4.1&channel=stable
Accept: application/json
```

首期 channel 固定 `stable`；beta 在开发验证完成后再提供用户可见的选择入口。

未来灰度需要的 `install_id` 应是首次安装时生成的随机 UUID，不能使用硬件指纹、用户名或 IP：

```text
hash(product + channel + version + install_id) % 100 < rollout_percent
```

### 5.3 服务端响应

无更新、频道关闭、目标不支持或未命中灰度：

```http
204 No Content
```

有更新：

```json
{
  "version": "0.4.2",
  "notes": "## 更新内容\n- 修复连接问题",
  "pub_date": "2026-08-17T10:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://cloud.example.com/api/updates/artifacts/42",
      "signature": "<Tauri .sig 内容>"
    }
  }
}
```

客户端实现前必须用实际所选版本的 `tauri-plugin-updater` 做兼容性验证，锁定：

- updater endpoint 是否直接接受上述 `platforms` 动态响应格式。
- Tauri 实际使用的平台 target 名称。
- updater bundle 的扩展名、压缩格式和签名内容。
- `signature` 字段是否要求 minisign 格式及其编码。

不能仅因字段看起来相似就假设兼容。

### 5.4 HTTP 缓存

服务端已经返回：

| 资源 | 策略 |
| --- | --- |
| `latest` manifest | `Cache-Control: public, max-age=60, stale-while-revalidate=300`，ETag |
| 固定 artifact | `Cache-Control: public, max-age=31536000, immutable`，ETag，Range |

客户端应支持 `If-None-Match` / `304 Not Modified`（如选用的 updater plugin 不自动处理，则在客户端请求层补齐）。不得把 `latest` 长期缓存为 immutable。

---

## 6. 签名、下载与安装

### 6.1 密钥管理

生成 updater 签名密钥后：

- 私钥只保存于 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`。
- 私钥口令保存于 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 客户端 `tauri.conf.json` 固化对应验签公钥。
- 云服务只保存 `.sig` 文本和制品 SHA-256，不保存私钥。
- 日志、错误消息、artifact 和 release note 均不得输出私钥或明文 CI token。

私钥轮换必须采用双公钥过渡策略：先发布一个同时信任旧/新公钥的客户端版本，再更换签名私钥；不能直接替换公钥导致存量客户端无法接收更新。

### 6.2 下载校验

客户端信任链：

```text
HTTPS
  + Tauri updater 内置公钥验签
  + 服务端发布阶段 SHA-256 与文件大小校验
```

客户端应：

- 仅下载 updater 返回的 HTTPS URL。
- 检查更新版本高于当前版本，不支持自动降级。
- 接收下载进度、允许网络中断后重新检查/重新下载。
- 签名缺失、签名错误、目标不匹配、版本非法时拒绝安装。
- 下载失败不影响当前应用继续运行。

### 6.3 无签名迁移期

早期需求允许 `signature` 缺失时提示手动下载安装。正式 stable 自动更新启用后，服务端发布流程已要求所有三个 target 均具备签名，因此此分支只用于兼容历史服务端或开发环境：

- 不调用自动下载/安装。
- 显示“发现新版本，需手动下载”。
- 使用 Tauri opener 在系统浏览器打开受控下载页或 artifact URL。
- 不将无签名版本标记为“安全可更新”。

### 6.4 安装交互

1. 后台发现更新时显示非阻塞通知。
2. 可后台下载签名包。
3. 下载成功提示“新版本已就绪，重启生效”。
4. 用户点击“重启并更新”后，检查未保存编辑和活动任务。
5. 用户确认后调用 updater install/relaunch。

不要在用户有活动终端、SSH、SFTP 或 AI 任务时强制退出。首期可以提示风险并要求确认，但不尝试序列化或恢复终端/SSH 子进程。

---

## 7. 设置页与用户体验

在设置页新增“关于与更新”区域：

- 当前应用版本。
- 更新频道（首期 stable）。
- 最近检查时间、检查结果与错误摘要。
- “检查更新”按钮。
- 有更新时的版本号、发布时间、包大小、更新说明。
- 下载进度。
- “下载更新”与“重启并更新”按钮。
- 无签名迁移期的“打开下载页”按钮。

更新说明若使用 Markdown，必须采用受控渲染：禁用原始 HTML、脚本、事件属性、`javascript:` 等危险链接；或首期直接以纯文本显示。

Topbar 当前已通过 Tauri app API 获取版本号。应提取共用版本/更新状态，避免 Topbar、设置页各自进行检查。

---

## 8. CI 与云服务发布对接

### 8.1 GitHub Actions 分层

| 触发 | 行为 |
| --- | --- |
| push `cloud` 分支 | 类型检查、Rust test、clippy、可复现构建；不发布 stable |
| `workflow_dispatch` | 生成内部验收 artifact，默认不发布 stable |
| push `v*` tag | 校验 tag 与版本、构建/签名三平台 updater 制品、上传云服务 draft |

CI 质量门：

```bash
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

### 8.2 制品类型

| 平台 | 人工安装 | 自动更新 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe`、MSI `.msi` | Tauri 支持的 NSIS updater 包 + `.sig` |
| macOS arm64/x64 | `.dmg`、`.app` | `.app.tar.gz` + `.sig` |

MSI 可继续用于企业管理员手工部署，但不作为首期自动更新制品。

### 8.3 云服务上传协议

CI 使用：

```http
Authorization: Bearer <AISHELL_UPDATE_PUBLISH_TOKEN>
```

创建 draft：

```http
POST /api/internal/updates/releases
Content-Type: application/json

{
  "version": "0.4.2",
  "channel": "stable",
  "notes": "## 更新内容\n- 修复连接问题",
  "sourceRepository": "khellendros97/aishell-cloud-enhance",
  "sourceCommit": "<完整 Git SHA>"
}
```

逐平台上传 raw updater bytes：

```http
PUT /api/internal/updates/releases/0.4.2/artifacts/windows-x86_64
Authorization: Bearer <AISHELL_UPDATE_PUBLISH_TOKEN>
X-Update-Channel: stable
X-Update-Filename: <安全文件名>
X-Update-Signature: <.sig 内容>
X-Update-SHA256: <小写 SHA-256>
Content-Type: application/octet-stream
```

完成 draft：

```http
POST /api/internal/updates/releases/0.4.2/complete
Authorization: Bearer <AISHELL_UPDATE_PUBLISH_TOKEN>
X-Update-Channel: stable
```

云服务将拒绝：

- 非受信任来源仓库。
- 非 SemVer 版本或非法 commit SHA。
- 未配置/错误的发布 token。
- 重复覆盖 artifact。
- 缺少任意目标平台、签名、SHA-256 或大小的发布。

首期流程是 **CI 上传 draft → 管理员在云服务 ReleasePanel 核对 → 管理员发布频道**。后续可在 GitHub Environment 受保护审批通过后自动调用 publish。

---

## 9. 测试与验收

### 9.1 Rust 单元测试

至少覆盖：

- SemVer（含 prerelease）和目标平台映射。
- 200、204、304、非法 JSON、超时与网络中断。
- 签名缺失、签名错误、制品 target 不匹配。
- 并发检查/下载去重。
- 24 小时调度与手动检查错误反馈。
- yanked 后清除待安装状态。
- 活动终端/AI 会话下的重启确认。

### 9.2 服务端与 CI 测试

- 私有客户端仓库 CI 只能用正确 publish token 上传。
- 上传三个签名 target 后才允许 publish。
- `latest` 公开访问、无更新 `204`、当前版本不降级。
- artifact 支持 HEAD、Range、ETag。
- publish、yank、rollback 后频道指针和 ETag 正确变化。
- CI 生成 updater bundle 与 `.sig`，并上传 SHA-256/大小一致的制品。

### 9.3 人工端到端验收

使用 beta release：

1. 安装旧版本 Windows x64 / macOS arm64 / macOS x64 客户端。
2. 发布一个高版本 beta draft 并在 ReleasePanel 发布。
3. 启动客户端，确认延迟检查发现新版本。
4. 下载并验证签名，应用保持可用。
5. 有活动任务时确认不会强制中断。
6. 用户确认后退出、安装、重启。
7. 重启后应用版本正确，项目、配置、keyring、云登录态按预期保留。
8. yank 后，已检查但尚未安装的客户端不应继续安装。
9. 断网、服务端 500、下载中断和签名错误均不影响旧版本启动。

---

## 10. 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 客户端从不检查更新 | 是否注入 `AISHELL_SERVER_URL`；启动延迟/24h 调度；个人构建应禁用 |
| 服务端返回 204 | 当前已是最新、频道关闭、未发布、target 不匹配、灰度未命中 |
| CI 上传 401/503 | publish token 是否正确；服务端是否配置 token hash |
| CI 上传 400 | 文件名、版本、channel、target、SHA-256、signature 或来源 commit 不符合约束 |
| draft 无法发布 | 三个平台制品、签名、大小、SHA-256 是否完整 |
| 客户端拒绝安装 | updater 公钥/私钥不匹配、`.sig` 内容错误、target 或版本不匹配 |
| Windows 更新后仍有 SmartScreen | Tauri updater 签名不是 Authenticode；另行接入 Windows 代码签名 |
| macOS 无法打开 | updater 签名不是 Apple Developer ID/Notarization；另行完成 Apple 分发签名与公证 |

---

## 11. 安全清单

- [ ] 客户端不包含 GitHub Token、云服务 publish token 或 Tauri 私钥。
- [ ] 私钥仅位于受保护 CI Secret；云服务仅保存 `.sig` 与 SHA-256。
- [ ] 自动更新只接受 HTTPS 与内置公钥验证通过的制品。
- [ ] stable 禁止无签名 artifact。
- [ ] 更新检查和 artifact 下载不携带用户 access token。
- [ ] 更新 URL 不允许由终端用户任意配置。
- [ ] 后台检查失败不弹干扰性错误，但写入脱敏 debug。
- [ ] 已发布 artifact 与版本号不可覆盖。
- [ ] 更新日志、CI log、崩溃报告中不泄露 token、secret 或私钥。
