# AIShell

Windows 桌面端智能终端工作台:本地 Git Bash 终端、SSH 伪终端、SFTP 文件管理、文件资源管理器 + 编辑器、快捷指令,以及内嵌 AI 助手(命令建议 / 终端日志解读 / 脚本封装)。

Tauri 2 + Rust 后端,原生 TypeScript 前端(无框架,Vite)——低内存占用,无 Electron。

## 功能

- **本地终端**:Git Bash(ConPTY / portable-pty),xterm.js 渲染,命令区块追踪(命令 / 输出分块、PIN 快捷指令、终端快照)
- **SSH 终端**:russh 实现,密码 / 私钥两种认证,多服务器多会话
- **SFTP 管理器**:russh-sftp,平铺 / 列表双视图、面包屑导航、与本地文件树双向拖拽传输、重名自动 `name (1).ext`
- **文件资源管理器**:本地项目目录树,支持把 Windows 文件 / 文件夹直接拖入导入
- **文件编辑器**:CodeMirror 6,800ms 防抖自动保存 + Ctrl+S,脏标记
- **快捷指令**:项目级常用命令卡片,一键在活跃终端执行,可从命令区块 📌 直接收藏
- **AI 助手**:内嵌 [pi coding agent](https://github.com/earendil-works/pi) 子进程(RPC 模式),DeepSeek 模型;支持 @终端快照 上下文、```command 建议卡一键粘贴终端、```text 卡插入输入框

## 快速开始

前置:Node ≥ 22、Rust 工具链、[Git for Windows](https://gitforwindows.org/)(提供 Git Bash)。

```bash
npm install
scripts/fetch-pi.sh        # 拉取 pi sidecar 单文件二进制到 src-tauri/resources/pi/
npm run tauri dev          # 开发模式
npm run tauri build        # 打包安装包
```

首次启动进入配置页:设置工作区目录、DeepSeek API Key,然后到欢迎页创建项目。

## 数据与密钥

- 配置 / 项目 / 会话:`<config_dir>/aishell.json`(原子写入)
- 服务器密码、DeepSeek API Key:Windows 凭据管理器(service `AIShell`),**永不落盘、永不回传前端**
- AI 会话由前端持久化;pi 进程以 `--no-session` 运行,AI 上下文随进程退出即失(已知限制)

## 仓库结构

```
src/               前端(Vite + 原生 TS)
  pages/           welcome / settings / workbench 三页
  pages/workbench/ 工作台:core(标签/渲染器总线)、terminal、editor、sftp、ai、sidebar/*
src-tauri/         Rust 后端
  src/store.rs     AppState 持久化 + keyring 密钥
  src/term.rs      本地/SSH PTY 管理(portable-pty)
  src/ssh.rs       russh 连接管理(供终端与 SFTP 复用)
  src/sftp.rs      SFTP 列表/上传/下载 + 本地唯一名
  src/fsops.rs     本地文件树 CRUD + OS 文件导入
  src/ai.rs        pi 子进程 RPC 驱动与流式事件桥
.proto/            已验证的静态交互原型(行为规格,勿动)
scripts/fetch-pi.sh  拉取 pi sidecar(GitHub Releases 最新版)
```

## 测试与检查

```bash
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```
