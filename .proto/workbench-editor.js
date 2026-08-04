/* ============================================================
   workbench-editor.js — 注册 'editor' 标签类型：模拟文件编辑器
   - 高亮 pre + 透明 textarea 叠层 + 左侧行号列，滚动同步
   - 防抖 800ms 自动保存 / Ctrl+S 立即保存；tab 标题脏标记 ●
   依赖 workbench-core.js 提供的 Workbench API，不污染全局。
   ============================================================ */
(function () {
  'use strict';
  const WB = window.Workbench;
  if (!WB || typeof WB.registerRenderer !== 'function') return;
  const { registerRenderer, setTabTitle, bus } = WB;
  const toast = (msg, type) => { if (window.AIShell) AIShell.toast(msg, type); };

  /* ---------- 模块样式（只增不改 shared） ---------- */
  if (!document.getElementById('ed-style')) {
    const st = document.createElement('style');
    st.id = 'ed-style';
    st.textContent = [
      '.ed-root{flex:1 1 auto;min-height:0;display:flex;background:var(--bg-0);}',
      '.ed-gutter{flex:none;background:#191b20;border-right:1px solid var(--border);overflow:hidden;position:relative;}',
      '.ed-gutter-pre{margin:0;padding:12px 10px 12px 12px;font:13px/1.6 var(--font-mono);color:var(--text-2);text-align:right;user-select:none;}',
      '.ed-surface{flex:1 1 auto;min-width:0;position:relative;overflow:hidden;}',
      '.ed-pre{position:absolute;inset:0;margin:0;padding:12px 16px;overflow:auto;pointer-events:none;scrollbar-width:none;white-space:pre;tab-size:4;}',
      '.ed-pre::-webkit-scrollbar{display:none;}',
      '.ed-pre code{font:13px/1.6 var(--font-mono);}',
      '.ed-input{position:absolute;inset:0;margin:0;border:0;outline:none;resize:none;background:transparent;color:transparent;caret-color:#fff;font:13px/1.6 var(--font-mono);padding:12px 16px;white-space:pre;overflow:auto;tab-size:4;}',
      '.c-comment{color:var(--text-2);font-style:italic;}',
      '.c-string{color:var(--green);}',
      '.c-keyword{color:var(--purple);}',
      '.c-number{color:var(--yellow);}',
      '.c-accent{color:var(--syntax-accent);}',
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ================= 模拟文件内容源 =================
     键为相对项目根的路径（正斜杠）；resolveKey 负责把
     sidebar 传入的完整盘符路径（D:/projects/AIShell2/...）归一键。 */
  const fileContents = {
    'README.md': `# AIShell

Windows 桌面 Shell 工具 —— 一个集本地终端、远程服务器管理与 AI 助手于一体的效率工具。

## 功能

- 本地终端：Git Bash / WSL / PowerShell 多配置
- 远程管理：SSH 连接、SFTP 文件浏览与上传
- 编辑器：语法高亮 + 自动保存
- AI 助手：命令建议与执行快照

## 开发

原型目录 .proto/ 为纯静态页面，浏览器直接打开即可，无需构建。

> 提示：原型数据保存在 localStorage，设置页可一键重置。`,

    'package.json': `{
  "name": "aishell",
  "version": "0.1.0",
  "description": "AIShell - Windows 桌面 Shell 工具（交互原型）",
  "private": true,
  "type": "module",
  "main": "src/main.js",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "python -m unittest discover tests"
  },
  "dependencies": {
    "xterm": "^5.3.0"
  },
  "devDependencies": {
    "vite": "^5.4.0"
  }
}`,

    'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}`,

    '.gitignore': `node_modules/
dist/
*.log
.DS_Store
.env
.venv/
__pycache__/`,

    'src/main.js': `/**
 * AIShell 桌面应用入口（原型模拟）
 */
import { openWorkspace, FS } from './utils/fs_util.js';

const APP_NAME = 'AIShell';
const VERSION = '0.1.0';
const CONFIG = {
  apiBase: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  effort: 'medium',
  timeoutMs: 30_000,
};

async function main() {
  console.log('starting ' + APP_NAME + ' v' + VERSION);
  console.log('workspace:', FS.sep, openWorkspace(CONFIG.apiBase));
  for (const key in CONFIG) {
    if (CONFIG[key] === null) continue;
  }
  return 0;
}

main().catch((err) => console.error(err.message));`,

    'src/core.py': `"""
AIShell 核心模块（原型模拟）
"""
import os
import sys
from pathlib import Path

VERSION = (0, 1, 0)
DEFAULT_PORT = 22


def ping(host, port=DEFAULT_PORT, timeout=5.0):
    """检测远程服务器连通性"""
    if not host:
        raise ValueError("host 不能为空")
    ok = os.system("ping -n 1 " + host) == 0
    return ok


class Server:
    def __init__(self, name, host, port=DEFAULT_PORT):
        self.name = name
        self.host = host
        self.port = port

    def describe(self):
        return f"{self.name}@{self.host}:{self.port}"`,

    'src/app.css': `/* 应用主样式（原型节选） */
:root {
  --radius-m: 8px;
  --shadow-l: 0 8px 32px rgba(0, 0, 0, 0.55);
}

.app-shell {
  display: flex;
  height: 100vh;
  background: #1b1d23;
}

.card {
  padding: 14px 16px;
  border: 1px solid #363c48;
  border-radius: 8px;
  transition: border-color 0.12s;
}

@media (max-width: 768px) {
  .app-shell { flex-direction: column; }
}`,

    'src/index.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AIShell 应用</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <!-- 应用挂载点 -->
  <div id="root"></div>
  <script type="module" src="main.js"></script>
</body>
</html>`,

    'src/utils/fs_util.js': `/**
 * 文件系统工具（原型模拟）
 */
export function readFile(path) {
  // 原型：返回模拟内容
  return '// 模拟内容: ' + path;
}

export function listDir(path) {
  const entries = [];
  for (let i = 0; i < 5; i++) {
    entries.push({ name: 'file-' + i + '.txt', size: i * 1024 });
  }
  return entries;
}

export const FS = { readFile, listDir, sep: '/' };`,

    'src/utils/net.py': `"""网络工具：SSH / SFTP 连接管理（原型模拟）"""
import socket
import threading

SSH_PORT = 22


def resolve_host(host, port=SSH_PORT):
    """解析主机地址"""
    return (host, port)


def is_reachable(host, port=SSH_PORT, timeout=3.0):
    with socket.create_connection((host, port), timeout=timeout) as sock:
        return sock is not None


def upload(local_path, remote_path, server):
    # 原型：模拟上传，返回虚拟大小
    return {"path": remote_path, "bytes": 1024 * 1024}`,

    'docs/README.md': `# 文档索引

本目录收录 AIShell 的设计与接口文档。

## 文档列表

- [架构设计](架构设计.md)
- [API 文档](api.md)

## 约定

- 文档使用 Markdown 编写
- 接口变更需同步更新 API 文档`,

    'docs/架构设计.md': `# AIShell 架构设计

## 分层

- 渲染层：纯 HTML/CSS/JS，无构建步骤
- 核心层：标签页管理器 + 事件总线
- 模块层：sidebar / editor / sftp / terminal / ai

## 数据流

- 所有状态走 AIShell.load / AIShell.save
- 模块之间通过 Workbench.bus 通信
- 拖拽上传走 DND_MIME（application/x-aishell）

## 约束

- 禁止修改 shared/ 目录
- 图标使用 emoji，不引入外部依赖`,

    'docs/api.md': `# API 文档

AIShell 对外暴露以下全局接口。

## AIShell

| 方法 | 说明 |
| ---- | ---- |
| load() | 读取本地数据库 |
| save(db) | 写回本地数据库 |
| uid(prefix) | 生成唯一 ID |
| toast(msg, type) | 右下角提示 |

## Workbench

- registerRenderer(type, fn)：注册标签渲染器
- openTab(opts)：打开标签
- bus.on(ev, cb)：订阅事件
- DND_MIME：拖拽数据类型`,

    'tests/test_core.py': `"""核心模块单元测试（原型模拟）"""
import unittest

from src.core import Server, ping


class ServerTest(unittest.TestCase):
    def test_describe(self):
        srv = Server("生产-Web-01", "47.102.118.66", 22)
        self.assertEqual(srv.describe(), "生产-Web-01@47.102.118.66:22")

    def test_ping_empty_host(self):
        with self.assertRaises(ValueError):
            ping("")


if __name__ == "__main__":
    unittest.main()`,

    'scripts/deploy.sh': `#!/usr/bin/env bash
# AIShell 演示部署脚本（原型模拟）
set -euo pipefail

APP_DIR="/home/deploy/apps/web"
REMOTE_HOST="47.102.118.66"
REMOTE_USER="deploy"

echo "开始部署到 $REMOTE_HOST ..."
cd "$APP_DIR"
npm install --production
npm run build
scp -r dist "$REMOTE_USER@$REMOTE_HOST:/tmp/aishell/"
echo "部署完成 ✔"`,
  };

  /* ---------- 路径归一化：完整盘符路径 -> 相对项目根路径 ---------- */
  function normalizePath(raw) {
    let p = String(raw || '').replace(/\\/g, '/');
    p = p.replace(/^[A-Za-z]:/, '');
    p = p.replace(/^\/+/, '');
    return p;
  }
  function resolveKey(raw) {
    const rel = normalizePath(raw);
    if (rel in fileContents) return rel;
    const proj = WB.state && WB.state.project;
    if (proj && proj.path) {
      const pn = normalizePath(proj.path);
      if (rel.startsWith(pn + '/')) {
        const r2 = rel.slice(pn.length + 1);
        if (r2) return r2;
      }
    }
    return rel;
  }
  function getContent(path) {
    if (path in fileContents) return fileContents[path];
    const ext = extLang(path);
    const body = (ext === 'js' || ext === 'ts' || ext === 'sh' || ext === 'py')
      ? '// 模拟内容: ' + path + '\n\n// 该文件未收录于原型文件映射，此占位内容可编辑，并会自动保存。\n\nfunction main() {\n  const msg = "AIShell 原型占位文件";\n  console.log(msg, 42);\n}\n\nmain();\n'
      : '// 模拟内容: ' + path + '\n\n该文件未收录于原型文件映射，此占位内容可编辑，并会自动保存。\n';
    fileContents[path] = body;
    return body;
  }

  /* ================= 轻量语法高亮 ================= */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function extLang(path) {
    const m = /\.([a-z0-9]+)$/i.exec(path);
    const ext = m ? m[1].toLowerCase() : '';
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx') return 'js';
    if (ext === 'ts' || ext === 'tsx') return 'js';
    if (ext === 'json') return 'json';
    if (ext === 'md' || ext === 'markdown') return 'md';
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'sh';
    if (ext === 'py') return 'py';
    if (ext === 'css') return 'css';
    if (ext === 'html' || ext === 'htm') return 'html';
    return '';
  }

  const LANGS = {
    js: [
      { cls: 'c-comment', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\// },
      { cls: 'c-string', re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/ },
      { cls: 'c-keyword', re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|default|delete|void|null|undefined|true|false|static|get|set|require|module|exports)\b/ },
      { cls: 'c-number', re: /\b(?:0x[0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/ },
    ],
    json: [
      { cls: 'c-accent', re: /"(?:[^"\\]|\\.)*"(?=\s*:)/ },
      { cls: 'c-string', re: /"(?:[^"\\]|\\.)*"/ },
      { cls: 'c-number', re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
      { cls: 'c-keyword', re: /\b(?:true|false|null)\b/ },
    ],
    py: [
      { cls: 'c-comment', re: /#[^\n]*/ },
      { cls: 'c-string', re: /'''[\s\S]*?'''|"""[^"]*"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/ },
      { cls: 'c-accent', re: /@[\w.]+/ },
      { cls: 'c-keyword', re: /\b(?:def|class|import|from|return|if|elif|else|for|while|break|continue|pass|try|except|finally|raise|lambda|with|as|in|is|not|and|or|True|False|None|async|await|yield|global|nonlocal|assert|del|print|self|unittest)\b/ },
      { cls: 'c-number', re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[jJ]?\b/ },
    ],
    md: [
      { cls: 'c-accent', re: /^#{1,6}[^\n]*/m },
      { cls: 'c-comment', re: /^>[^\n]*/m },
      { cls: 'c-keyword', re: /\*\*[^*\n]+\*\*|__[^_\n]+__/ },
      { cls: 'c-accent', re: /\[[^\]\n]*\]\([^)\n]*\)/ },
      { cls: 'c-string', re: /`[^`\n]*`/ },
      { cls: 'c-comment', re: /^\s*[-*+]\s+/m },
    ],
    sh: [
      { cls: 'c-comment', re: /#[^\n]*/ },
      { cls: 'c-string', re: /'[^'\n]*'|"[^"\n]*"/ },
      { cls: 'c-accent', re: /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/ },
      { cls: 'c-keyword', re: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|echo|cd|ls|pwd|mkdir|rm|cp|mv|touch|chmod|chown|sudo|export|source|local|exit|return|read|printf|cat|grep|sed|awk|find|tail|head|ps|kill|tar|curl|wget|git|npm|yarn|docker|systemctl|service|set|unset)\b/ },
      { cls: 'c-number', re: /\b\d+\b/ },
    ],
    css: [
      { cls: 'c-comment', re: /\/\*[\s\S]*?\*\// },
      { cls: 'c-string', re: /"[^"\n]*"|'[^'\n]*'/ },
      { cls: 'c-keyword', re: /@[a-z-]+/ },
      { cls: 'c-accent', re: /[a-z-][\w-]*(?=\s*:)/ },
      { cls: 'c-number', re: /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|vh|vw|fr)?\b/ },
    ],
    html: [
      { cls: 'c-comment', re: /<!--[\s\S]*?-->/ },
      { cls: 'c-accent', re: /<\/?[a-zA-Z][\w-]*/ },
      { cls: 'c-keyword', re: /[\w-]+(?==)/ },
      { cls: 'c-string', re: /"[^"\n]*"|'[^'\n]*'/ },
      { cls: 'c-number', re: /&[a-zA-Z#0-9]+;/ },
    ],
  };
  const reCache = {};
  function combinedRe(lang) {
    if (!reCache[lang]) {
      // 每条规则包一层捕获组：命中第 i 条规则时 m[i+1] 即为该规则匹配
      reCache[lang] = new RegExp(LANGS[lang].map((r) => '(' + r.re.source + ')').join('|'), 'gm');
    }
    return reCache[lang];
  }
  function highlight(path, text) {
    const lang = extLang(path);
    const rules = LANGS[lang];
    if (!rules) return escapeHtml(text);
    const re = combinedRe(lang);
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (m.index > last) out += escapeHtml(text.slice(last, m.index));
      let cls = null;
      for (let i = 0; i < rules.length; i++) {
        if (m[i + 1] !== undefined) { cls = rules[i].cls; break; }
      }
      out += (cls ? '<span class="' + cls + '">' : '') + escapeHtml(m[0]) + (cls ? '</span>' : '');
      last = m.index + m[0].length;
    }
    if (last < text.length) out += escapeHtml(text.slice(last));
    return out;
  }

  /* ================= 编辑器渲染 ================= */
  const editorTabs = new Map(); // tabId -> { dirty, save }

  registerRenderer('editor', (container, tab) => {
    const path = resolveKey(tab.data && tab.data.path);
    const baseTitle = tab.title || path.split('/').pop() || '未命名';

    const root = document.createElement('div');
    root.className = 'ed-root';

    const gutter = document.createElement('div');
    gutter.className = 'ed-gutter';
    const gutterPre = document.createElement('pre');
    gutterPre.className = 'ed-gutter-pre';
    gutter.appendChild(gutterPre);

    const surface = document.createElement('div');
    surface.className = 'ed-surface';
    const pre = document.createElement('pre');
    pre.className = 'ed-pre';
    const code = document.createElement('code');
    pre.appendChild(code);
    const input = document.createElement('textarea');
    input.className = 'ed-input';
    input.spellcheck = false;
    input.wrap = 'off';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.autocorrect = 'off';
    surface.appendChild(pre);
    surface.appendChild(input);

    root.appendChild(gutter);
    root.appendChild(surface);
    container.appendChild(root);

    let dirty = false;
    let timer = null;

    function setDirty(d) {
      if (dirty === d) return;
      dirty = d;
      setTabTitle(tab.id, (d ? '● ' : '') + baseTitle);
    }

    /* 保存逻辑：防抖自动保存与 Ctrl+S 复用 */
    function save(silent) {
      if (timer) { clearTimeout(timer); timer = null; }
      fileContents[path] = input.value;
      setDirty(false);
      if (!silent) toast('已自动保存', 'success');
    }

    function syncScroll() {
      pre.scrollTop = input.scrollTop;
      pre.scrollLeft = input.scrollLeft;
      gutterPre.style.transform = 'translateY(' + (-input.scrollTop) + 'px)';
    }

    function renderLines() {
      const n = input.value.split('\n').length;
      const digits = String(n).length;
      const lines = [];
      for (let i = 1; i <= n; i++) lines.push(i);
      gutterPre.textContent = lines.join('\n');
      gutter.style.width = (digits * 8 + 30) + 'px';
    }

    function render() {
      code.innerHTML = highlight(path, input.value);
      renderLines();
      syncScroll();
    }

    input.value = getContent(path);
    render();

    input.addEventListener('input', () => {
      setDirty(true);
      render();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => save(false), 800);
    });

    input.addEventListener('scroll', syncScroll);

    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        save(false);
      }
    }, true);

    editorTabs.set(tab.id, { dirty: () => dirty, save: () => save(true) });

    return {
      getPath: () => path,
      getValue: () => input.value,
      save: () => save(false),
    };
  });

  /* 关闭标签时：若有未保存改动，静默落盘 */
  bus.on('tab-closed', (tab) => {
    const entry = editorTabs.get(tab.id);
    if (entry) { editorTabs.delete(tab.id); if (entry.dirty()) entry.save(); }
  });
})();
