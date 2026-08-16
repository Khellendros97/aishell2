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
4. **Git Bash 路径**写死逻辑里要排除 `C:\Windows\System32\bash.exe`(那是 WSL);正确路径 `C:\Program Files\Git\bin\bash.exe`。
5. **pi sidecar**:`src-tauri/resources/pi/` 不入库,由 `scripts/fetch-pi.sh` 拉取。ai.rs 按 `(projectId, sessionId)` 懒启动 `pi --mode rpc`,stdout 是 LF 分隔 JSONL(**不要用按行 readline 之外的假设,U+2028/29 不是行分隔**)。
6. 前端状态事实源在 Rust 端 `aishell.json`;前端不写 localStorage(那是原型的做法,已废弃)。
7. **图标一律走 `src/icons.ts`,禁止 emoji**:React JSX 里用 `src/shared/Icon.tsx` 的 `<Icon name="..." />`,命令式/模板串场景用 `icon()` 字符串版;新图标往 `PATHS` 里加,不要内联 SVG 到业务文件。
8. **DOM 行闭包引用的树节点对象不可无差别替换**(explorer 教训:轮询刷新曾整体重建 children 数组,行点击把状态写进孤儿节点导致展开失效);命令式引擎里变更时按 key reconcile 复用未变节点,React 树里列表必须 keyed 正确(节点路径作 key)。
9. **工作台 keep-alive 不变量**:所有标签 pane 常驻挂载、`active` 只切显隐(App.tsx 离开路由也只 display:none)——终端/SSH/AI 会话靠这个跨导航存活;后端资源回收(term_close 等)只能发生在组件卸载(useEffect return)。给标签组件写 effect 时依赖用 `tab.id`,不要用 `tab` 对象(store setTabTitle 会换对象引用,作依赖会导致改名即重建会话)。

## 架构要点

- **前端契约**:`src/types.ts`(与 Rust serde camelCase 逐字段对齐)、`src/api.ts`(全部 invoke 封装,改 Rust 命令签名必须同步这里)。
- **工作台状态**:`src/stores/workbench.ts`(zustand)— `useWorkbench`(tabs/activeId/panel/aiVisible/project 与 openTab/closeTab/setPanel 等动作)、`wbEvents`(仅 `project-changed`、`staging-changed` 两条通知)、`tabApis`(标签组件挂载时注册命令式句柄,如 TerminalApi)、`wbHandles.ai`(AI 面板句柄)、`getActiveTerminalApi()`、`DND_MIME` 拖拽载荷约定 `{source, path, name, isDir, serverId?}`。
- **标签/面板注册表**:新标签类型往 `src/pages/workbench/tabs/registry.ts`(`TAB_TYPES`)接线;新侧栏面板往 `src/pages/workbench/sidebar/panels.ts`(`PANELS`,模块导出 `SidebarPanelDef { title, HeadActions?, Panel }`)接线,别另起注册机制。
- **SSH 连接复用**:终端和 SFTP 共用 `ssh.rs` 的 `SshManager`(每 serverId 一条连接),断开在 `SshManager::disconnect`。
- **命令区块追踪**:终端没有 OSC 133,区块边界靠前端输入行缓冲近似(见 tabs/useTerminal.ts `cleanBlockLines` 提示符清洗,含 `[user@host ~]$` SSH 风格)。
- **AI 输出协议**:pi 的系统提示词约定 ```command 围栏 = 可粘贴终端的命令卡、```text 围栏 = 可插入输入框的文本卡;改提示词或渲染器要两边(ai.rs / ai/ai-engine.ts)同步。

## 代码风格

- 注释、commit message、UI 文案:中文。
- 错误信息给用户看的部分(返回前端的 Err String)用中文且可执行(如「请先在设置中配置工作区目录」)。
- 前端每文件头部注释块写明:对照 `.proto/` 哪个文件(React 迁移文件另注明对照的旧实现来源)、与后端的接口点。
- 原子写配置:先写 `.tmp` 再 rename(store.rs `with_state` 已封装,别绕开)。
