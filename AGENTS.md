# AGENTS.md — AIShell 仓库指南

面向编码 agent 的协作约定。改代码前必读。

## 项目概述

AIShell = Tauri 2 桌面应用(Windows):前端 Vite + 原生 TS(**无框架**,不用 React/Vue),后端 Rust。
三页 hash 路由:`#/welcome`(项目)、`#/settings`(配置)、`#/workbench?project=<id>`(工作台)。
`.proto/` 是已人工验证的静态原型,**即交互规格**:布局/文案/交互以它为准,行为变更先对照 `.proto/*.js`。

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
7. **图标一律用 `src/icons.ts` 的 `icon()`(内联 SVG,stroke=currentColor,尺寸 1em 随容器字号),禁止 emoji**;新图标往 `PATHS` 里加,不要内联 SVG 字符串到业务文件。
8. **DOM 行闭包引用的树节点对象不可无差别替换**(explorer.ts 教训:轮询刷新曾整体重建 children 数组,行点击把状态写进孤儿节点导致展开失效);变更时按 key reconcile 复用未变节点。

## 架构要点

- **前端契约**:`src/types.ts`(与 Rust serde camelCase 逐字段对齐)、`src/api.ts`(全部 invoke 封装,改 Rust 命令签名必须同步这里)。
- **工作台总线**:`src/pages/workbench/core.ts` — `registerRenderer(type, fn)` / `openTab` / bus 事件 `tab-activated`、`tab-closed`、`project-changed` / `DND_MIME` 拖拽载荷约定 `{source, path, name, isDir, serverId?}`。新面板/新标签类型走这套契约,别另起总线。
- **SSH 连接复用**:终端和 SFTP 共用 `ssh.rs` 的 `SshManager`(每 serverId 一条连接),断开在 `SshManager::disconnect`。
- **命令区块追踪**:终端没有 OSC 133,区块边界靠前端输入行缓冲近似(见 terminal.ts `cleanBlockLines` 提示符清洗,含 `[user@host ~]$` SSH 风格)。
- **AI 输出协议**:pi 的系统提示词约定 ```command 围栏 = 可粘贴终端的命令卡、```text 围栏 = 可插入输入框的文本卡;改提示词或渲染器要两边(ai.rs / ai.ts)同步。

## 代码风格

- 注释、commit message、UI 文案:中文。
- 错误信息给用户看的部分(返回前端的 Err String)用中文且可执行(如「请先在设置中配置工作区目录」)。
- 前端每文件头部注释块写明:对照 `.proto/` 哪个文件、与后端的接口点。
- 原子写配置:先写 `.tmp` 再 rename(store.rs `with_state` 已封装,别绕开)。
