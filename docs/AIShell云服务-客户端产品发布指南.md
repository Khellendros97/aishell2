# AIShell 云服务版客户端产品发布指南

> **适用对象**：AIShell 云服务版桌面客户端的开发、测试、发布与运维人员。  
> **适用仓库**：客户端源码仓库 `aishell2-srun-aishell-cloud`。  
> **当前状态**：人工分发流程可执行；客户端已接入 updater（设置页「关于与更新」）与签名发布流水线（build-desktop.yml：tag → 签名构建 → GitHub Release + 云服务更新 draft 上传，管理员在 ReleasePanel 核对后发布频道）。在完成 CI Secrets 配置、云服务 HTTPS 与 beta 渠道端到端升级验收（自动更新开发文档 §9.3）之前，发布说明不得宣称自动更新已生效。

相关文档：

- `README.md`：本地开发、构建、云服务配置与测试命令。
- `AGENTS.md`：架构约束、三道质量门与测试硬约束。
- `docs/AIShell云服务-OAuth2接入文档.md`：云服务 OAuth2 接入协议。
- `docs/AIShell云服务-客户端自动更新功能开发文档.md`：自动更新开发与发布制品要求。

---

## 1. 发布目标与交付范围

AIShell 是基于 **Tauri 2 + Rust + Vite/React/TypeScript** 的桌面客户端。当前发布目标为：

| 平台 | CI 构建目标 | 人工安装产物 | 自动更新制品（后续） |
| --- | --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | NSIS `.exe`、MSI `.msi` | Tauri 支持的 NSIS updater 包及 `.sig` |
| macOS Apple Silicon | `aarch64-apple-darwin` | `.dmg`、`.app` | `.app.tar.gz` 及 `.sig` |
| macOS Intel | `x86_64-apple-darwin` | `.dmg`、`.app` | `.app.tar.gz` 及 `.sig` |

当前构建流水线已经产出安装包；但未接入 Tauri updater 签名、公钥、云服务制品上传、客户端检查更新 UI 或自动安装。因此当前版本仅可按“**人工下载安装**”交付。

### 1.1 当前已交付的云服务能力

发布说明可以描述以下当前能力：

- 云服务 OAuth2 登录、令牌刷新、托管模式与个人模式切换。
- 托管 LLM 代理、搜索代理、智能审批。
- 共享/个人记忆卡片、对话沉淀上报、用量查询。
- SkillHub 浏览、版本查看与下载中转。
- 本地 Git Bash、SSH PTY、SFTP、文件编辑器、终端与 pi sidecar AI 工作台。

以下能力在当前客户端中**不得宣称已交付**：

- 云服务知识库 `kb_search` / 客户端知识库 AI 扩展。
- 自动检查、后台下载、签名校验、重启安装和回滚。
- Windows Authenticode 签名、Apple Developer ID 签名及公证。

---

## 2. 发布前必须通过的门禁

### 2.1 版本号必须统一

发布与自动更新都依赖语义化版本。当前仓库中可能存在以下版本来源：

| 文件 | 作用 |
| --- | --- |
| `package.json` | Node 包与前端版本 |
| `src-tauri/tauri.conf.json` | Tauri 产品与安装包版本；应作为客户端对外版本基准 |
| `src-tauri/Cargo.toml` | Rust crate 版本 |
| Git tag `vX.Y.Z` | CI 发布触发器与版本归档标识 |

发布前必须确保四者一致：

```text
package.json.version == src-tauri/tauri.conf.json.version == src-tauri/Cargo.toml.version == Git tag 去掉 v 后的版本
```

例如，发布 `v0.4.2` 时，三处应用版本都必须为 `0.4.2`。

> 当前历史版本可能存在 `package.json` / `tauri.conf.json` 与 Cargo 版本不一致的情况。未统一前禁止创建发布 tag；否则安装包显示版本、客户端 `getVersion()`、服务端 `current` 参数和 updater 版本比较可能相互不一致。

### 2.2 工作树与敏感信息检查

发布前确认：

```bash
git status --short
git diff --check
```

不得提交或上传以下内容：

- `dev.env`、`release.env`。
- `AISHELL_CLIENT_SECRET`、OAuth token、refresh token、API Key。
- Tauri 更新签名私钥及密码。
- `src-tauri/resources/pi/`、`src-tauri/resources/git/` 的临时下载内容。
- `dist/`、`src-tauri/target/` 的临时产物，除非仓库既有发布策略明确要求提交嵌入式前端资源。

### 2.3 三道质量门

在客户端仓库根目录执行：

```bash
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

必须全部通过。涉及云登录、存储和凭据的测试必须使用 `MemorySecrets` / `test_store()`，不得访问真实 Windows 凭据管理器。

### 2.4 云服务配置预检

云服务版构建必须提供（当前正式环境）：

```dotenv
AISHELL_SERVER_URL=https://aishell.srun.com:18002
AISHELL_CLIENT_ID=<OAuth client_id>
AISHELL_CLIENT_SECRET=<OAuth client_secret>
```

预检命令：

```bash
node scripts/build-release.mjs --check
```

说明：

- `AISHELL_SERVER_URL` 作为构建期常量注入；未注入时云服务功能整体隐藏。
- URL 不应以 `/` 结尾；客户端拼接 API 路径前会按约定去除尾部斜杠。
- `AISHELL_CLIENT_SECRET` 是 OAuth 尚未完成 PKCE 改造期间的过渡配置，严禁打印到日志、发布说明或 issue。
- `build.rs` 的 debug / release 配置读取优先级与 README 的文字描述可能不同；以实际构建脚本和 CI 环境变量为准。

### 2.5 OAuth 回调白名单

当前客户端使用本地回环回调，而不是深链：

```text
http://127.0.0.1:38901/auth/callback
```

云服务 OAuth 应用必须精确登记此回调地址。发布前应验证：

- 浏览器可被系统正常打开。
- 38901 端口未被其他程序占用。
- 授权页回调后客户端可完成 state 校验与授权码交换。
- access token 与刷新后的 token 均不会写入 `aishell.json` 或前端日志。

---

## 3. 构建环境

### 3.1 本地环境

- Windows 10/11 或 macOS。
- Node.js：本地按 README 的要求准备；CI 当前使用 Node 20，应以 CI 实际版本为准完成兼容性验证。
- Rust stable 与对应平台 target。
- Windows 构建需要 Visual Studio C++ Build Tools / MSVC 环境。
- macOS 构建需要 Xcode Command Line Tools。
- 网络可访问 pi sidecar 和 Git for Windows 下载源。

安装依赖：

```bash
npm install
```

准备构建资源：

```bash
npm run fetch-pi
npm run fetch-git
```

`tauri.conf.json` 的 `beforeBuildCommand` 也会自动执行资源准备；显式执行仍有价值，因为下载或解压失败时更容易定位。

### 3.2 pi sidecar 与 Git 资源

| 资源 | 生成脚本 | 用途 | 发布检查 |
| --- | --- | --- | --- |
| pi sidecar | `scripts/fetch-pi.mjs` | AI RPC / agent 执行 | 各目标平台存在正确二进制与 `VERSION` |
| Git for Windows 安装器 | `scripts/fetch-git.mjs` | Windows 首次缺少 Git Bash 时引导安装 | 下载 SHA-256 校验成功 |

安装版运行时会从 Tauri resource 目录查找这些资源。资源下载失败、平台架构不匹配或包内缺失会造成 AI 或终端相关功能不可用。

---

## 4. 本地构建与验收

### 4.1 开发验证

```bash
npm run tauri dev
```

建议最小冒烟验证：

1. 正常进入欢迎页、工作台和设置页。
2. 本地终端可启动；Windows 缺 Git Bash 时安装引导符合预期。
3. 新建项目、打开编辑器、终端与 SSH/SFTP 基础路径可用。
4. 个人模式下 API Key 保存在系统凭据管理器，配置文件没有明文密钥。
5. 云服务模式能完成 OAuth 登录、刷新页面后恢复登录态、登出后清理 token。
6. 托管 LLM、搜索、记忆和 SkillHub 在相应服务端能力启用时可用。

### 4.2 正式构建

```bash
node scripts/build-release.mjs
```

或使用 Tauri 原生命令：

```bash
npm run tauri build
```

常见产物位置：

```text
src-tauri/target/release/bundle/nsis/*.exe
src-tauri/target/release/bundle/msi/*.msi
src-tauri/target/<target>/release/bundle/dmg/*.dmg
src-tauri/target/<target>/release/bundle/macos/*.app
```

发布前应记录：

- Git commit SHA。
- 版本号和 tag。
- 各平台构建 runner / target。
- 安装包 SHA-256、文件大小。
- pi sidecar 版本。
- 云服务地址与 OAuth client ID（不记录 secret）。

---

## 5. GitHub Actions 发布流程

工作流：`.github/workflows/build-desktop.yml`。

### 5.1 触发方式

| 触发方式 | 当前行为 | 适用场景 |
| --- | --- | --- |
| push `cloud` 分支 | 质量门（版本一致/tsc/test/clippy）+ 三平台可复现构建 | 合入即验证可构建，不发布 |
| `workflow_dispatch` | 质量门 + 构建并保留 Actions Artifacts；勾选 `sign-updater` 且已配置签名 Secret 时附带签名 updater 制品 | 测试包、验收包、内部验证 |
| 推送 `v*` tag | 质量门（额外校验与 tag 版本一致）→ 签名构建 → 创建 GitHub Release 上传安装包 → 上传云服务更新 draft（scripts/publish-update.sh） | 正式发布（人工分发 + 自动更新制品） |

当前 workflow 构建：

- macOS Apple Silicon。
- macOS Intel。
- Windows x64。

### 5.2 建议的发布步骤

1. 从经过测试的提交创建发布分支或确认目标分支。
2. 统一版本号并执行三道质量门。
3. 执行 `node scripts/build-release.mjs --check`。
4. 使用 `workflow_dispatch` 生成测试 artifacts，完成 Windows 与 macOS 冒烟验收。
5. 创建带注释 tag，例如：

   ```bash
   git tag -a v0.4.2 -m "AIShell 0.4.2"
   ```

6. 显式推送到计划用于发布的远程仓库：

   ```bash
   git push <release-remote> v0.4.2
   ```

7. 观察三个构建任务和汇总发布任务全部成功。
8. 下载各平台安装包，进行最终安装与登录验证。
9. 在 release 说明中写明新功能、修复、已知限制、回滚版本和校验值。

> 客户端将同时维护 GitHub 私有源码仓库与 Coding remote 时，日常开发 remote、GitHub release remote 和 tag 推送必须使用显式 remote 名称。不要配置 `git push --mirror`、不要强推 tag、不要依赖不透明的多 push URL。

### 5.3 当前签名与平台提示

当前 CI 注释已明确：

- Windows 未进行 Authenticode 签名时，SmartScreen 可能拦截。
- macOS 未进行 Developer ID 签名和公证时，Gatekeeper 可能提示“已损坏”。

这不是 Tauri updater 签名的替代关系：

| 机制 | 解决的问题 |
| --- | --- |
| Tauri updater 签名 | 自动更新包来源与完整性校验 |
| Windows Authenticode | Windows 安装包身份与 SmartScreen 信任 |
| Apple Developer ID + Notarization | macOS 分发信任与 Gatekeeper 放行 |

在平台代码签名尚未接入时，发布说明必须如实提供人工安装限制，不得宣称“已签名”。

---

## 6. 自动更新时代的制品发布流程

客户端 updater 已接入（设置页「关于与更新」，后端 `src-tauri/src/update.rs`）；本节流程随首个带签名的 tag 发布生效，具体开发改造见自动更新功能开发文档。

### 6.1 职责边界

```text
私有客户端源码仓库 / GitHub Actions
  └─ 构建、Tauri updater 签名、生成 SHA-256、上传制品

AIShell 云服务
  └─ 保存制品与 release 元数据，提供公开 manifest/download

客户端
  └─ 查询公开 manifest，使用内置公钥验签，用户确认后重启安装
```

客户端运行时不访问私有 GitHub Release，也不携带 GitHub Token。

### 6.2 云服务发布前置条件

服务端需完成并启用：

```dotenv
UPDATE_STORAGE_DIR=/var/lib/aishell-cloud/updates
UPDATE_PUBLISH_TOKEN_HASH=<CI 发布令牌 SHA-256>
UPDATE_SOURCE_REPOSITORY=khellendros97/aishell-cloud-enhance
UPDATE_MAX_ARTIFACT_BYTES=1073741824
```

CI 需要的 Secrets：

```text
# AISHELL_UPDATE_SERVER_URL=https://aishell.srun.com:18002
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
AISHELL_UPDATE_SERVER_URL
AISHELL_UPDATE_PUBLISH_TOKEN
```

发布令牌明文只保存在私有 CI Secret；云服务仅保存其 SHA-256 摘要。

### 6.3 自动更新发布状态流

```text
CI 创建 draft
  → 上传 Windows/macOS 三个目标平台的签名制品
  → complete 校验三个 target、签名、SHA-256、大小
  → 管理员在“客户端更新”面板核对
  → publish 指向 stable/beta 频道
  → 客户端获取公开 manifest
```

管理员面板仅用于查看、发布、撤回与回滚，不能手工修改已发布制品、签名或来源 commit。

---

## 7. 回滚与事故处理

### 7.1 人工安装包发布回滚

1. 将有问题的 GitHub Release 标记为 pre-release、撤回说明或删除下载链接（以团队策略为准）。
2. 发布一个更高版本的修复包；不复用已公开版本号。
3. 说明已安装用户的处置路径。
4. 保留问题包 SHA-256、日志、commit 和测试结果供审计。

### 7.2 云服务自动更新回滚

自动更新启用后：

- 对问题版本执行 `yank`，客户端不再获得该版本。
- 将 stable/beta 指针回滚到已发布的历史版本。
- 已升级客户端不会自动降级；应发布更高版本修复严重问题。
- 已下载但尚未安装的客户端在安装前应重新确认 release 未被撤回。

---

## 8. 发布检查清单

### 8.1 代码与构建

- [ ] 三处版本号与 Git tag 一致。
- [ ] 工作树干净，无敏感文件和意外产物。
- [ ] TypeScript、Rust test、clippy 全部通过。
- [ ] 三个平台构建全部成功。
- [ ] pi sidecar 与 Git 资源在对应安装包内可用。
- [ ] 产物名称、大小、SHA-256 已记录。

### 8.2 云服务

- [ ] `AISHELL_SERVER_URL`、client ID 与 secret 来自受控发布环境。
- [ ] OAuth 回调 `http://127.0.0.1:38901/auth/callback` 已登记。
- [ ] 登录、刷新、登出和托管模式切换已验证。
- [ ] 不在任何日志、截图、release notes 中暴露 token、secret 或私钥。

### 8.3 分发与回滚

- [ ] Windows 与 macOS 人工安装均完成冒烟验证。
- [ ] 平台签名/公证状态在 release note 中如实说明。
- [ ] 回滚版本、负责人和沟通路径已确定。
- [ ] 若启用自动更新，云服务 draft、三个制品、签名、频道指针与 manifest 已全部核对。
