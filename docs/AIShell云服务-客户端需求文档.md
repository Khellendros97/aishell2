# AIShell 云服务 —— 客户端需求文档

> 配套文档：《AIShell云服务-服务端需求文档.md》（下称「服务端文档」，引用其需求编号 SR-xx）。
> 本文档约束 AIShell 桌面端（Tauri 2 + Rust + 原生 TS）为接入云服务所需的全部改动。

## 1. 背景与目标

当前客户端的 LLM / 搜索能力完全依赖用户本地配置（设置页填 baseUrl + API Key，Key 存 keyring）。接入云服务后：

- 员工在客户端内 OAuth 登录，即可直接使用公司统一管理的模型与搜索转发，无需自己配置 Key；
- 客户端可检索服务端 RAG 知识库；
- 客户端可检查并自动更新到新版本；
- 本地「个人模式」（自配 Key）保留，与「托管模式」（服务器转发）可切换。

## 2. 现状锚点（改动落点）

| 现状 | 位置 | 云服务改动 |
| --- | --- | --- |
| `Settings.llm = { modelId, baseUrl, effort }`，`search.enabled` | src/types.ts | 新增 `cloud` 配置段与模式字段（CR-2） |
| API Key 走 keyring（`llm:apikey`、`brave:apikey`），`SecretStore` trait | src-tauri/src/store.rs | 新增令牌账户 `cloud:access_token` / `cloud:refresh_token`（CR-1.5） |
| 每次 spawn 重写 `models.json`（provider `deepseek`，`baseUrl` 取自设置），env 注入 `DEEPSEEK_API_KEY` / `BRAVE_API_KEY` | src-tauri/src/ai.rs `write_models_json` / `spawn` | 托管模式下 baseUrl/apiKey 改指向服务器（CR-3） |
| 搜索扩展 URL 常量 `BRAVE_SEARCH_URL` | src-tauri/src/pi_ext/aishell-search.ts | 支持 env 覆盖为服务器转发地址（CR-4） |
| 智能审批直连 LLM（reqwest，复用设置 + keyring） | src-tauri/src/smart_approval.rs | 托管模式下改走服务器转发 + Bearer token（CR-3.3） |
| 设置页：LLM/搜索/工作区表单 | src/pages/settings.ts | 托管模式下 LLM/搜索区只读 + 指向账号页（CR-2.2） |
| 三页 hash 路由（welcome/settings/workbench） | src/router.ts、src/main.ts | 新增第四页 `#/account`（账号），复用 main.ts 子页容器机制（CR-1.1） |
| 构建脚本与发布工作流 | src-tauri/build.rs、.github/workflows/build-desktop.yml | 构建期注入 `AISHELL_SERVER_URL`（CR-1.8） |
| 顶栏组件：项目/设置导航 + 主题 + 窗口控制 | src/components/topbar.ts | 新增「账号」导航按钮（CR-1.1a） |
| 工作台 activity-bar：三面板图标 + 底部 AI 开关 | src/pages/workbench/workbench.ts | 底部新增用户头像入口（CR-1.1b） |
| 欢迎页 | src/pages/welcome.ts | 未登录时显示登录快捷通道（CR-1.9） |
| 无更新插件；版本 0.2.0；CI 发 GitHub Release（未签名） | tauri.conf.json、.github/workflows/build-desktop.yml | 引入 tauri-plugin-updater + CI 签名（CR-6） |

## 3. 功能需求

### CR-1 用户登录 / 登出

- CR-1.1 新增独立账号页 `#/account`（第四页，hash 路由；welcome/settings 子页容器与工作台保活机制不变，账号页按子页同样式挂载）。页面内容：
  - 未登录：服务器地址（只读展示，构建期注入，CR-1.8）+「登录」按钮（触发 CR-1.2 流程）；
  - 已登录：头像、姓名、部门、服务器地址、托管/个人模式切换（CR-2）、「退出登录」。
- CR-1.1a 入口一（顶栏）：topbar.ts 导航区新增「账号」按钮，与「项目」「设置」并列，全部页面可见；`TopbarPage` 类型扩展 `'account'`，账号页内该按钮高亮。
- CR-1.1b 入口二（工作台左侧功能栏）：activity-bar 底部簇新增用户头像按钮（置于 AI 面板开关上方）；未登录显示通用 user 图标，已登录显示用户头像（加载失败回退姓名首字）；点击 `navigate('#/account')`。
- CR-1.2 登录流程（对应服务端 SR-2.2 桌面端形态；账号页登录按钮与欢迎页快捷通道 CR-1.9 共用）：
  1. Rust 端拉起本地 PKCE 授权会话，用系统浏览器打开 `{server}/api/auth/dingtalk/authorize?client=desktop&…`（webview 内不内嵌登录页）；
  2. 服务端回调 `aishell://auth/callback?code=…`（自定义协议，需注册深链，见 CR-1.3）；
  3. Rust 端拿 code + verifier 调 `/api/auth/token` 换取 token 对；
  4. 成功后调 `/api/auth/me` 拉取用户信息与能力清单，缓存进 aishell.json 的 `cloud` 段（token 本身只进 keyring，见 CR-1.5）。
- CR-1.3 深链注册：Windows 安装包注册 `aishell://` 协议（NSIS/WiX 安装脚本 + `tauri-plugin-deep-link`）；开发模式降级为轮询或手动粘贴 code（仅开发便利，不进入正式交付路径）。
- CR-1.4 登录过程可取消；超时（2 分钟未回调）自动作废并提示中文错误。
- CR-1.5 令牌存储（硬约束，同现有密钥规范）：`cloud:access_token`、`cloud:refresh_token` 只存 keyring；aishell.json 只存非敏感资料（姓名、头像 URL、能力清单、登录状态），服务器地址不入库（CR-1.8 编译期常量）。token 永不返回前端——前端只拿到用户资料与「已登录」布尔。
- CR-1.6 access_token 过期后由 Rust 端自动用 refresh_token 调 `/api/auth/refresh` 轮换一次；刷新失败（吊销/离职禁用）则置为未登录态，AI 请求按 CR-3.4 报错引导。
- CR-1.7 退出登录：调 `/api/auth/logout` 吊销 refresh token，删除 keyring 两个账户，清空 aishell.json `cloud` 段；不影响本地个人模式配置。
- CR-1.8 服务器地址构建时注入，客户端不提供修改入口：
  - Rust 端：build.rs 把环境变量 `AISHELL_SERVER_URL` 透传为 `cargo:rustc-env`，代码以 `option_env!("AISHELL_SERVER_URL")` 读取为编译期常量（换地址 = 换构建，天然避免「填错地址登出」类问题）；
  - CI：build-desktop.yml 构建正式包时从 GitHub Variables 注入公司正式地址；本地 dev 用 shell 环境变量临时注入即可；
  - 前端不直接读构建变量：地址经 `cloud_status` 从 Rust 端取得（单一事实源），账号页只读展示。
- CR-1.9 欢迎页快捷通道：未登录且构建注入了 serverUrl 时，欢迎页项目列表区上方显示登录引导条（文案「登录公司账号，免配置使用 AI」+「登录」按钮，视觉随欢迎页现有规范）；点击直接触发 CR-1.2 流程，不强制先跳账号页。已登录则不渲染；`cloud:changed` 事件后即时显隐。

### CR-2 托管模式 / 个人模式

- CR-2.1 `Settings` 新增字段（serde camelCase，types.ts 与 store.rs 同步）：
  ```ts
  cloud: {
    mode: 'hosted' | 'personal';   // 默认 personal；登录成功后自动切 hosted
    user: { name, avatar, dept } | null;   // 展示用缓存，token 不在此
    capabilities: { models: string[]; search: boolean; knowledge: boolean; latestVersion: string } | null;
  }
  ```
  serverUrl 不入库：编译期常量（CR-1.8），前端经 `cloud_status` 获取用于展示。
- CR-2.2 托管模式下：设置页 LLM 的 baseUrl / API Key 输入框整体替换为只读说明「由公司服务器统一管理」并附「前往账号页」链接（`#/account`）；模型下拉数据源换为 `capabilities.models`（仍写入 `llm.modelId`）；`effort` 保留本地可选；搜索开关与 brave key 输入框隐藏（CR-4.3）。
- CR-2.3 个人模式保持现状行为完全不变（未登录默认即个人模式）。
- CR-2.4 用户在账号页手动切换两种模式；托管模式但登录失效时：账号页显示「登录已过期，请重新登录」，顶栏账号按钮与 activity-bar 头像加角标提示；AI 功能按 CR-3.4 报错，不静默回退个人模式（避免误用个人 Key 产生歧义消费）。
- CR-2.5 `is_config_complete` 判定扩展：托管模式 + 已登录即视为完整（不再要求本地 Key），欢迎页 missing-config 引导相应调整。

### CR-3 LLM 转发接入（ai.rs / smart_approval.rs）

- CR-3.1 ai.rs `write_models_json`：托管模式下 provider 段写 `{ baseUrl: "<serverUrl>/api/proxy/llm/v1", apiKey: "$AISHELL_CLOUD_TOKEN" }`（provider 名与 `api: openai-completions` 不变）；spawn 时 env 注入当前 access_token（先按 CR-1.6 确保未过期）。个人模式行为不变。
- CR-3.2 失败语义：转发返回 401/403（被禁用/离职）时，把服务端中文错误原文上浮到 AI 面板错误事件，并触发一次登录态失效处理（CR-2.4）；429（限额）原样展示中文错误。
- CR-3.3 smart_approval.rs：托管模式下判定请求改发 `{serverUrl}/api/proxy/llm/v1/chat/completions`，`Authorization: Bearer <access_token>`，模型取 `llm.modelId`；判定失败仍按既有约定回退人工审批。
- CR-3.4 未登录/登录失效时发起 AI 对话：错误串「登录已过期，请前往设置重新登录后使用公司服务」（与现有「请先在设置中配置 DeepSeek API Key」同级风格）。

### CR-4 搜索转发接入（aishell-search.ts）

- CR-4.1 扩展请求地址支持 env 覆盖：`AISHELL_SEARCH_URL` 存在时用之，否则回退 Brave 官方常量。ai.rs 在托管模式且 `capabilities.search` 时注入 `AISHELL_SEARCH_URL=<serverUrl>/api/proxy/search` 与 token env；个人模式行为不变（仍用 `BRAVE_API_KEY`）。
- CR-4.2 扩展错误映射补充 401/403/429 → 中文可执行错误（沿用现有 `formatHttpError` 风格）。
- CR-4.3 托管模式下的搜索开关以服务端能力为准，设置页本地 brave key 输入框隐藏（见 CR-2.2）。

### CR-5 知识库

- CR-5.1 新增 pi 扩展 `aishell-kb.ts`（与 guard/search 同机制：ai.rs 每次 spawn 落盘并以 `--extension` 挂载）：注册 `kb_search` 工具，参数 { query, topK }，调 `{serverUrl}/api/kb/search`，Bearer token 经 env 注入；仅在托管模式且 `capabilities.knowledge` 时挂载并加入 tools 清单。
- CR-5.2 工具输出截断上限与 search 扩展同规（防上下文溢出）；401/403 时向模型返回中文引导（转告用户重新登录）。
- CR-5.3 系统提示词追加一段知识库工具使用引导（何时检索、如何引用来源），与 ai.rs / ai.ts 两侧提示词同步。
- CR-5.4 一期不做知识库浏览面板：员工只通过 AI 对话间接受益；「文档上传/管理」全部在服务端后台完成。

### CR-6 自动更新检查

- CR-6.1 引入 `tauri-plugin-updater`：启动后（延迟 ~10s）与每 24h 轮询 `{serverUrl}/api/updates/latest?target=<t>&current=<v>`；构建未注入 serverUrl 的客户端不检查（无云功能）。
- CR-6.2 有新版且响应带 signature：下载并静默安装，提示「新版本已就绪，重启生效」。
- CR-6.3 有新版但无 signature（CI 签名接入前的过渡）：只提示「发现新版本 x.y.z」，点击调插件 opener 打开介绍页下载地址，手动安装。
- CR-6.4 设置页「关于」区显示当前版本号 + 「检查更新」按钮 + 最近一次检查结果；更新说明（Markdown）渲染要点。
- CR-6.5 配套 CI 改动（build-desktop.yml）：接入 tauri updater 签名密钥（`TAURI_SIGNING_PRIVATE_KEY` 进 GitHub Secrets），构建产出 `.sig` 一并上传 Release；发版流程不变（tag v*）。**此项为 CR-6.2 的前置**，未签名期间客户端走 CR-6.3 路径，功能不阻塞。
- CR-6.6 检查失败（网络/服务不可达）静默记 debug 日志，不打扰用户；手动点「检查更新」时给出中文结果反馈。

### CR-7 介绍页入口

- CR-7.1 设置页「关于」区放「访问 AIShell 官网」链接（`openUrl` 走系统浏览器，同现有 hint 链接处理）；构建未注入 serverUrl 时指向公共官网地址。
- CR-7.2 客户端内不复刻介绍页内容。

## 4. 前后端契约变更（src/api.ts + Rust 命令）

新增 invoke 命令（命名/参数风格对齐 api.ts 现有约定，错误串中文）：

| 命令 | 说明 |
| --- | --- |
| `cloud_begin_login` | 生成 PKCE 会话 + 注册深链监听，返回授权 URL（前端 `openUrl` 打开） |
| `cloud_cancel_login` | 作废进行中的登录会话 |
| `cloud_logout` | 调服务端 logout + 清 keyring + 清 cloud 段 |
| `cloud_status` | 返回 `{ loggedIn, user, capabilities, serverUrl, mode }`（serverUrl 来自编译期常量；不含 token） |
| `cloud_set_mode` | 切换 hosted / personal |
| `update_check` | 手动检查更新，返回检查结果结构 |
| `update_install` | 有签名更新时执行下载安装 |

事件：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `cloud:changed` | `cloud_status` 同构 | 登录/登出/登录失效/模式切换后广播；账号页、顶栏账号按钮、activity-bar 头像、欢迎页快捷通道、AI 面板据此刷新 |

复用约定：token 不进任何命令返回值；`save_settings` 等现有命令签名不变（cloud 段走独立命令原子更新，模式同 `set_theme`）。

## 5. 密钥与存储约定

- keyring 新增账户：`cloud:access_token`、`cloud:refresh_token`（service 仍为 `AIShell`）；单测一律 `MemorySecrets` + `test_store()`，禁止触碰真实凭据管理器（现有硬约束不变）。
- aishell.json `cloud` 段只存非敏感资料，原子写沿用 `with_state`。
- 深链 code、PKCE verifier 仅存活于 Rust 内存，用完即弃。

## 6. 兼容与降级

- 构建未注入 serverUrl（如开源公共构建、个人自构建）：一切云功能隐藏，应用行为与现状完全一致。
- 服务器不可达：AI/搜索/知识库报中文网络错误；更新检查静默；本地个人模式不受影响。
- 旧版 aishell.json 无 `cloud` 段：serde 默认值兜底（同现有「旧配置无此字段」处理风格）。

## 7. 非目标（一期不做）

- 知识库浏览/上传的客户端 UI（都在服务端后台）；
- 用量报表的客户端展示；
- 服务器配置（SSH 连接等）云端同步；
- 多账号切换；
- 移动端。

## 8. 验收要点

1. 未登录默认个人模式，现有全部功能回归无损（`tsc` / `cargo test` / `clippy` 三门全绿）；未注入 serverUrl 的构建云功能整体隐藏，注入构建的客户端从 UI 到配置均无修改地址入口；
2. 点登录（账号页或欢迎页快捷通道）→ 系统浏览器完成钉钉授权 → 深链回跳后账号页显示用户资料，keyring 出现两个 cloud 账户，aishell.json 无 token 明文；
3. 顶栏「账号」按钮与工作台 activity-bar 头像两处入口均可进入账号页；欢迎页快捷通道仅未登录可见，登录成功后消失；
4. 托管模式下发起 AI 对话：pi 实际请求打到服务器转发地址（models.json baseUrl + token env），智能审批同源；
5. 后台禁用该用户后，下一次 AI 请求收到中文权限错误，账号页显示登录过期、头像加角标；
6. web_search 工具在托管模式走服务器转发地址，个人模式走 Brave 官方地址；
7. 知识库工具可被 AI 触发并返回服务端分块（用测试文档验证）；
8. 服务端发布新版本后，客户端「检查更新」给出提示；带 signature 时可完成静默安装；
9. 登出后 keyring cloud 账户清除，AI 请求回到个人模式报错引导。

## 9. 待决策项

1. 深链方案：`tauri-plugin-deep-link` + 安装包协议注册（推荐）vs 本地回环端口监听（免注册表但需处理端口冲突）。→ 推荐前者
2. ~~服务器地址默认值来源~~ → **已决策：构建期注入 `AISHELL_SERVER_URL`**（CR-1.8），客户端不提供修改入口；
3. 托管模式是否允许员工自选模型（`capabilities.models` 下拉）还是服务端强制单模型。→ 推荐允许下拉，服务端仍可停用任一模型
4. 自动更新在「未登录但已配置 serverUrl」时是否检查。→ 推荐检查（SR-5.2 免登录）
