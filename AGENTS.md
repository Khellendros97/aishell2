# AGENTS.md — AIShell 仓库指南

面向编码 agent 的协作约定。改代码前必读。

## 项目概述

AIShell = Tauri 2 桌面应用(Windows):前端 Vite + **React 18 + zustand**(0.3.x 时代为无框架原生 TS,已迁移),后端 Rust。
三页 hash 路由:`#/welcome`(项目)、`#/settings`(配置)、`#/workbench?project=<id>`(工作台)。
`.proto/` 是已人工验证的静态原型,**即交互规格**:布局/文案/交互以它为准,行为变更先对照 `.proto/*.js`。
React 迁移约定:大型命令式模块(终端/SFTP/explorer/AI 引擎)采用**「命令式引擎 + React 薄壳」**形态(useEffect 挂载引擎并透传清理函数),不要为迁移而重写成受控组件树。

## 常用命令

```bash
npm run tauri dev        # 开发(改动 Rust 会自动重启应用)
npx tsc --noEmit         # 前端类型检查(提交前必过)
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

提交前三道门全绿:tsc、cargo test、clippy -D warnings。

## 硬约束(踩过的坑)

1. **单测绝不碰真实 keyring**:store.rs 密钥走 `SecretStore` trait,生产 `KeyringSecrets` / 测试 `MemorySecrets`。测试一律用 `test_store()` 构造,禁止 `Store::new()`(会写用户真实的 Windows 凭据管理器)。
2. **密码 / API Key 永不进 JSON、永不返回前端**：只走 keyring(account:`server:<id>`、`llm:apikey`、`brave:apikey`)。表单留空提交 = 后端保持原值(前端传 `null`,不是空串)。
3. **窗口 `dragDropEnabled: false`**(tauri.conf.json):wry 的 OLE DropTarget 会截杀页面内 HTML5 拖拽。OS 文件导入走 `webkitGetAsEntry` + `fs_import` 命令,不再用 `tauri://drag-drop` 事件。
4. **Git Bash 路径**写死逻辑里要排除 `C:\Windows\System32\bash.exe`(那是 WSL);正确路径 `C:\Program Files\Git\bin\bash.exe`。系统未装时回退捆绑 PortableGit(term.rs `find_shell` 探测 `resources/git-portable`,免安装免管理员)。
5. **pi sidecar 与捆绑运行时**:`src-tauri/resources/` 下 pi/pi 侧车、git-portable(PortableGit 预解压)、python-embed(embeddable 预解压)均不入库,分别由 `scripts/fetch-pi*.mjs|sh`、`fetch-git.mjs`、`fetch-python.mjs` 拉取(后两个非 Windows 平台自动跳过,镜像回退 + SHA-256 锁定);只有 tauri.windows.conf.json 把 git-portable/python-embed 打进 Windows 包。python-embed 构建期删 `python313._pth`——留着会忽略 PYTHONPATH,py 工具的 pysdk 注入(ai_actions)就失效。ai.rs 按 `(projectId, sessionId)` 懒启动 `pi --mode rpc`,stdout 是 LF 分隔 JSONL(**不要用按行 readline 之外的假设,U+2028/29 不是行分隔**)。
6. 前端状态事实源在 Rust 端 `aishell.json`;前端不写 localStorage(那是原型的做法,已废弃)。
7. **图标一律走 `src/icons.ts`,禁止 emoji**:React JSX 里用 `src/shared/Icon.tsx` 的 `<Icon name="..." />`,命令式/模板串场景用 `icon()` 字符串版;新图标往 `PATHS` 里加,不要内联 SVG 到业务文件。
8. **DOM 行闭包引用的树节点对象不可无差别替换**(explorer 教训:轮询刷新曾整体重建 children 数组,行点击把状态写进孤儿节点导致展开失效);命令式引擎里变更时按 key reconcile 复用未变节点,React 树里列表必须 keyed 正确(节点路径作 key)。
9. **工作台 keep-alive 不变量**:所有标签 pane 常驻挂载、`active` 只切显隐(App.tsx 离开路由也只 display:none)——终端/SSH/AI 会话靠这个跨导航存活;后端资源回收(term_close 等)只能发生在组件卸载(useEffect return)。给标签组件写 effect 时依赖用 `tab.id`,不要用 `tab` 对象(store setTabTitle 会换对象引用,作依赖会导致改名即重建会话)。
10. **内置浏览器(tauri `unstable` feature 的坑)**:子 webview(`WebviewBuilder`/`Window::add_child`)需 tauri `unstable` feature,且 Windows 上**只能在 async 命令里创建 webview**(同步命令会死锁);启用后必须同时 `default-features = false` 剔除 `common-controls-v6`——否则 lib 单测二进制(无嵌入清单)加载 v5 comctl32 时报 `STATUS_ENTRYPOINT_NOT_FOUND`(缺 `TaskDialogIndirect`),应用二进制不受影响(v6 清单由 tauri-build 无条件嵌入)。浏览器模块见 `browser.rs`,新工具走 guard 扩展 `AISHELL_ACTION` 桥 + `run_internal_action` 分发。
11. **内置浏览器禁止 `file:///` 导航本地 HTML(空 host file:// 整进程崩溃)**:wry 的 ipc 处理器对每条 web message 做 `Request::builder().uri(页面源URL).unwrap()`,`http::Uri` 拒绝空 authority——本地页一旦 `chrome.webview.postMessage`(检查器选中元素/console 钩子)即 panic abort;`file://localhost` 会被 url crate/Chromium 按 WHATWG 规范归一为空 host,同样崩(UNC `file://server/` 有 host 是安全的)。本地文件一律走 `localhtml://localhost/` 自定义协议(lib.rs `register_uri_scheme_protocol` + `browser.rs::serve_local_html`,wry 自动改写成 `http://localhtml.localhost/` 加载);对外展示(地址栏/事件/元素引用)由 `display_url` 还原为 `file:///` 形态。改浏览器导航逻辑时先看 `normalize_input` 与 ensure 里的 `on_navigation` 拦截。
12. **直连 LLM 请求的 max_tokens 必须给思维链留预算**:思考型模型(deepseek reasoning 等)的思维链计入 max_tokens 预算,且多数兼容端点忽略 `reasoning_effort`——预算太小会全部耗在思考上、正文为空(finish_reason=length)。标题生成(32→1024)、智能审批(400→4096)先后踩坑;新直连调用点照 `session_title.rs` 模式:输出提取用 `extract_content`(兼容 content parts 数组),解析失败的 Err 带 finish_reason/是否含思维链/正文片段(`body_snippet`)诊断。
13. **SSH 私钥收编**:私钥统一保管在 `<workspace>/.aishell/ssh-key/<内容sha256前16位>`(见 `ssh_keys.rs`)——保存密钥型凭据/服务器时自动「收编」复制外部私钥并改写 key_path(复制非移动、幂等),启动/切换 workspace 时 `adopt_managed_ssh_keys` 迁移存量外部密钥(凭据优先→镜像引用服务器→孤儿服务器就地收编并回写凭据,仅变更时落盘);单个收编失败静默跳过、不影响保存主流程,不要把它改成移动或让保存报错。
14. **SSH 公钥(密钥对)凭据**(AuthType::PublicKey,前端 `'publickey'`):key_path 存**密钥对目录**(默认用户主目录 `.ssh`,按 id_ed25519/id_rsa/id_ecdsa 顺序探测「私钥+同名 .pub」对,规则只在后端 ssh_keys.rs)——**不收编**、不进 keyring、部署密码一次性使用;认证被拒时后端返回 `[SSH需部署公钥]` 前缀错误,前端 terminal.ts 弹「输入密码自动部署」框(ssh-copy-id 等价,幂等追加 authorized_keys),**AI 通道不做部署、直接失败提示**;探测/生成密钥对都走后端命令(ed25519 无密码短语、防覆盖),表单「未发现密钥对,点击立即生成」按钮与连接推导共用同一后端探测规则。

## 架构要点

- **前端契约**:`src/types.ts`(与 Rust serde camelCase 逐字段对齐)、`src/api.ts`(全部 invoke 封装,改 Rust 命令签名必须同步这里)。
- **工作台状态**:`src/stores/workbench.ts`(zustand)— `useWorkbench`(tabs/activeId/panel/aiVisible/project 与 openTab/closeTab/setPanel 等动作)、`wbEvents`(仅 `project-changed`、`staging-changed` 两条通知)、`tabApis`(标签组件挂载时注册命令式句柄,如 TerminalApi)、`wbHandles.ai`(AI 面板句柄)、`getActiveTerminalApi()`、`DND_MIME` 拖拽载荷约定 `{source, path, name, isDir, serverId?}`。
- **标签/面板注册表**:新标签类型往 `src/pages/workbench/tabs/registry.ts`(`TAB_TYPES`)接线;新侧栏面板往 `src/pages/workbench/sidebar/panels.ts`(`PANELS`,模块导出 `SidebarPanelDef { title, HeadActions?, Panel }`)接线,别另起注册机制。
- **SSH 连接复用**:终端和 SFTP 共用 `ssh.rs` 的 `SshManager`(每 serverId 一条连接),断开在 `SshManager::disconnect`。
- **SSH 隧道(本地转发 -L)**:配置在 `AppState.ssh_tunnels`(`tunnel.rs` TunnelConfig,serde camelCase),运行态只在内存(监听任务/停止信号);`TunnelManager` 启动时先 bind 本地端口再预连服务器(认证/网络错误尽早返回),转发复用 SshManager 连接池的 `direct-tcpip` 通道,单条转发连接失败只断该连接;`enabled=true` 的隧道重启时由 lib.rs `tunnel::recover` 自动重建(失败仅记录)。标签页只是管理界面,**关闭标签不停隧道**(与终端/会话类资源相反);变更后 emit `tunnels:changed`,WebSocket 之外的事件模式照 sftp:progress 先例。
- **命令区块追踪**:终端没有 OSC 133,区块边界靠前端输入行缓冲近似(见 tabs/useTerminal.ts `cleanBlockLines` 提示符清洗,含 `[user@host ~]$` SSH 风格)。
- **AI 输出协议**:pi 的系统提示词约定 ```command 围栏 = 可粘贴终端的命令卡、```text 围栏 = 可插入输入框的文本卡;改提示词或渲染器要两边(ai.rs / ai/ai-engine.ts)同步。
- **AI 输入区引用 tag**:contenteditable 内嵌原子 chip,content 落盘保留 token(`@term:<id>`、`@file:名` 等);新增引用类型要同步 `chipToken`(发送侧 token 生成)与 `buildMessageTokens`(历史侧 token 还原),两处不一致历史消息会回退纯文本。
- **内置浏览器多页面**:browser.rs 按 viewId 持有多个子 webview(标签栏每页一个,右侧页面栏默认折叠),browser_* 命令/事件全带 viewId;AI 四件套目标视图 = 可视页面 → 最近浏览页面 → 专用 "ai" 页面(`ai_target`)。
- **内置技能播种**:skills.rs `seed_builtin_skill_files` 带 `.builtin-sha256` 侧车——磁盘文件与侧车一致(用户没改过)时推送内置内容更新,用户改过则保留;新增内置技能还要 bump store.rs `SEED_GENERATION`(否则老工作区不补种新技能)。

## 代码风格

- 注释、commit message、UI 文案:中文。
- 错误信息给用户看的部分(返回前端的 Err String)用中文且可执行(如「请先在设置中配置工作区目录」)。
- 前端每文件头部注释块写明:对照 `.proto/` 哪个文件(React 迁移文件另注明对照的旧实现来源)、与后端的接口点。
- 原子写配置:先写 `.tmp` 再 rename(store.rs `with_state` 已封装,别绕开)。
