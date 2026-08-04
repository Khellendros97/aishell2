/**
 * 终端标签页渲染器：真实 PTY（本地 Git Bash / SSH）的 xterm 封装。
 * import 即注册 registerRenderer('terminal', …)（模块级副作用，契约同 .proto/workbench-core.js）。
 *
 * 交互语义移植自 .proto/workbench-terminal.js，差异（计划 A4 决策）：
 * - 真实终端无法把按钮渲染进滚动区 DOM，故用「顶部信息栏 + 右侧 280px 历史区块抽屉」
 *   等价承载「每个区块都有 添加到chat / 📌 快捷指令 按钮」，信息栏固定作用于最后一个区块；
 * - 区块命令名在回车瞬间从 xterm 屏幕缓冲读取（bash 已把真实命令画在屏幕上，
 *   ↑ 回调/编辑后的内容都准确）；输出经回显/提示符清洗后展示（计划 A4 的近似仅余提示符启发式）。
 *
 * 生命周期：renderer 返回 api { paste, execute, takeSnapshot }；
 * tab.onClose 由本渲染器接管（term_close + 退订 + dispose）。
 */
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { UnlistenFn } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';

import { onTermData, onTermExit, termClose, termCreate, termInput, termResize } from '../../api';
import type { TermKind } from '../../api';
import { icon } from '../../icons';
import { activateTab, bus, getActiveTab, registerRenderer, Workbench } from './core';
import { addQuickCommandModal } from './quickcommand';
import type { Tab } from './core';
import { toast, uid } from '../../ui';
import { currentTheme, onThemeChange } from '../../theme';

/* ---------- 终端配色：暗 / 亮两套（background 与 workbench.css --term-bg 一致） ---------- */
const TERM_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#0d1117', foreground: '#e6edf3', cursor: '#4f8ef7',
    selectionBackground: 'rgba(79, 142, 247, 0.35)',
    black: '#0d1117', red: '#e5626a', green: '#4ec98a', yellow: '#e5c07b',
    blue: '#4f8ef7', magenta: '#b687e8', cyan: '#56b6c2', white: '#c9d1d9',
    brightBlack: '#8b93a5', brightRed: '#ff7b72', brightGreen: '#7ee2a8',
    brightYellow: '#f2cc60', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd', brightWhite: '#ffffff',
  },
  /* 亮色:ANSI white/brightWhite 语义反转(亮主题里「白字」要深,否则白底不可见) */
  light: {
    background: '#ffffff', foreground: '#1f2329', cursor: '#3b76e1',
    selectionBackground: 'rgba(59, 118, 225, 0.3)',
    black: '#1f2329', red: '#d6454d', green: '#1e9e62', yellow: '#a5711b',
    blue: '#3b76e1', magenta: '#8b4fc9', cyan: '#0e8a9e', white: '#6b7280',
    brightBlack: '#8b92a0', brightRed: '#e5626a', brightGreen: '#28b573',
    brightYellow: '#c98d26', brightBlue: '#5b8ee8', brightMagenta: '#a56dd6',
    brightCyan: '#15a3b8', brightWhite: '#1f2329',
  },
};

/** 活跃终端实例:主题切换时批量换肤(destroy 时移除) */
const liveTerms = new Set<TermSession>();
onThemeChange((t) => { liveTerms.forEach((s) => { s.term.options.theme = TERM_THEMES[t]; }); });
import type { TermSnapshot } from '../../types';

/** 历史区块：一条已结算命令及其输出（纯文本，剥除 ANSI）。 */
interface TermBlock {
  command: string;
  output: string[];
  /** 未完结行：PTY 输出按 chunk 到达，行可能在 chunk 边界被截断，跨 chunk 拼接。 */
  pending: string;
  /** 新区块回显消费状态：等待输入回显结束（见 appendOutput 两阶段消费）。 */
  echoPending: boolean;
  /** 待匹配的命令回显（去空白归一化）；空串 = 已进入「跳到首个 \n」阶段。 */
  echoRemain: string;
}

/** 单块 output 行数上限（计划：每块上限 2000 行）。 */
const MAX_BLOCK_LINES = 2000;

/** 剥除 ANSI 转义（CSI / OSC / 单字符转义），用于区块 output 的纯文本捕获。 */
function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][0-9A-Za-z]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\u001b./g, '');
}

class TermSession {
  /** 主题切换时模块级 liveTerms 需要重写 options.theme,不封装 */
  readonly term: Terminal;
  private readonly fit: FitAddon;
  private readonly tab: Tab;
  private readonly host: HTMLElement;
  private readonly infoCmd: HTMLElement;
  private readonly addChatBtn: HTMLButtonElement;
  private readonly pinBtn: HTMLButtonElement;
  private readonly drawer: HTMLElement;
  private readonly drawerBody: HTMLElement;
  private readonly drawerToggle: HTMLButtonElement;

  private unlisteners: UnlistenFn[] = [];
  private blocks: TermBlock[] = [];
  /** api.paste/execute 期间抑制回车结算（块名由 api 直接给定，见 pushBlock）。 */
  private suppressSettle = 0;
  /** 可打印输入轻量追踪（与屏幕读取调和，见 reconcile）。 */
  private typedBuf = '';
  /** CSI/SS3 转义序列吞吃状态机（仅跳过，无副作用）。 */
  private escState: 'none' | 'esc' | 'csi' | 'ss3' = 'none';
  /** alternate screen（vi/tail 等全屏程序）时暂停区块捕获（计划 A4）。 */
  private altMode = false;
  /** 进入 alternate screen 前最后一条命令，退出快照用。 */
  private altLastCommand = '';
  private lastCommand = '';
  private ready = false;
  private failed = false;
  private exited = false;
  private resizer: ResizeObserver | null = null;

  constructor(container: HTMLElement, tab: Tab) {
    this.tab = tab;

    const root = document.createElement('div');
    root.className = 'term-root';
    root.innerHTML = `
      <div class="term-info">
        <span>最后命令:</span>
        <span class="term-info-cmd"></span>
        <span class="term-info-spacer"></span>
        <button class="btn small term-toggle-drawer" title="历史区块">${icon('history')} 历史区块</button>
        <button class="btn small term-pin">${icon('pin')} 快捷指令</button>
        <button class="btn small term-addchat">${icon('chatPlus')} 添加到chat</button>
      </div>
      <div class="term-main">
        <div class="term-xterm"></div>
        <div class="term-drawer">
          <div class="term-drawer-head"><span>历史区块</span><button class="btn small ghost term-drawer-close">收起</button></div>
          <div class="term-drawer-body"></div>
        </div>
      </div>`;
    container.appendChild(root);

    this.host = root.querySelector('.term-xterm')!;
    this.infoCmd = root.querySelector('.term-info-cmd')!;
    this.drawer = root.querySelector('.term-drawer')!;
    this.drawerBody = root.querySelector('.term-drawer-body')!;
    this.drawerToggle = root.querySelector('.term-toggle-drawer')!;
    this.addChatBtn = root.querySelector('.term-addchat')!;
    this.pinBtn = root.querySelector('.term-pin')!;
    this.drawerToggle.onclick = () => this.drawer.classList.toggle('term-drawer-hidden');
    (root.querySelector('.term-drawer-close') as HTMLButtonElement).onclick = () => {
      this.drawer.classList.add('term-drawer-hidden');
    };
    this.addChatBtn.onclick = () => this.sendToAI(this.takeSnapshot());
    this.pinBtn.onclick = () => {
      if (this.lastCommand) addQuickCommandModal(this.lastCommand);
    };

    this.term = new Terminal({
      fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERM_THEMES[currentTheme()],
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(this.host);
    this.term.onData((data) => this.onUserInput(data));

    // 激活本标签时聚焦终端（与原型 input.focus 语义一致）。
    // bus 无 off API：用 tab.el.isConnected 守卫，关闭/换页后的残留监听自动失效。
    bus.on('tab-activated', (t) => {
      if (!this.tab.el.isConnected) return;
      if (t && t.id === this.tab.id && !this.failed && !this.exited) this.term.focus();
    });

    void this.init();
  }

  /* ---------- 初始化：先订阅事件、再创建后端（避免输出竞态丢失） ---------- */
  private async init(): Promise<void> {
    const data = this.tab.data as { kind?: string; serverId?: string; cwd?: string | null };
    const kind: TermKind = data.kind === 'ssh' ? 'ssh' : 'local';
    try {
      this.unlisteners.push(await onTermData(this.tab.id, (d) => this.onBackendData(d)));
      this.unlisteners.push(await onTermExit(this.tab.id, (code) => this.onExit(code)));
      await termCreate(this.tab.id, kind, data.serverId ?? null, data.cwd ?? null);
      this.ready = true;
      this.fitTerm();
      this.resizer = new ResizeObserver(() => this.fitTerm());
      this.resizer.observe(this.host);
      this.term.focus();
    } catch (err) {
      this.failed = true;
      const msg = String(err);
      toast(msg, 'error');
      this.term.write(`\r\n\x1b[31m[启动失败] ${msg}\x1b[0m\r\n`);
      this.updateInfo();
    }
  }

  /* ---------- 输入：转发后端 + 区块追踪 ---------- */
  private onUserInput(data: string): void {
    if (!this.ready || this.failed) return;
    void termInput(this.tab.id, data).catch(() => { /* 终端已关闭等后端错误忽略 */ });
    if (this.altMode || this.suppressSettle > 0) return;
    // 粘贴事件：正文计入 typedBuf，其中的 \r 只是插入换行，不结算
    if (data.includes('\x1b[200~')) {
      const m = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
      if (m) this.typedBuf += m[1];
      return;
    }
    // typedBuf：可打印字符轻量追踪，弥补快速输入时屏幕回显滞后（回显保序但异步）；
    // 转义序列整体吞掉（CSI = ESC [ 参数字节 终字节 0x40-0x7E），↑↓ 回调不清 buffer——
    // 回调时 typedBuf 为空，结算自动回退到屏幕读取（屏幕上是真实命令）。
    let settle = false;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (this.escState === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.escState = 'none';
        continue;
      }
      if (this.escState === 'ss3') { this.escState = 'none'; continue; }
      if (this.escState === 'esc') {
        this.escState = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none';
        continue;
      }
      if (ch === '\u001b') { this.escState = 'esc'; continue; }
      if (ch === '\r') { settle = true; continue; }
      if (ch === '\u007f' || ch === '\b') { this.typedBuf = this.typedBuf.slice(0, -1); continue; }
      if (ch === '\u0003' || ch === '\u0004' || ch === '\u001a') { this.typedBuf = ''; continue; }
      if (ch >= ' ') this.typedBuf += ch;
    }
    if (settle) this.settleFromBuffer();
  }

  /** 回车结算：屏幕读取与 typedBuf 调和后作为新块名 */
  private settleFromBuffer(): void {
    const cmd = this.reconcile(this.readCommandFromBuffer(), this.typedBuf.trim());
    this.typedBuf = '';
    if (!cmd) return; // 裸回车：bash 只重绘提示符，无输出，不成块
    this.pushBlock(cmd);
  }

  /**
   * 屏幕文本 S 与输入追踪 T 调和：
   * 前缀关系（回显滞后或完全同步）取长者；分叉（行内编辑等）取屏幕；回调场景 T 空取 S。
   */
  private reconcile(s: string, t: string): string {
    if (!t) return s;
    if (!s) return t;
    if (t.startsWith(s) || s.startsWith(t)) return t.length >= s.length ? t : s;
    return s;
  }

  private pushBlock(name: string): void {
    this.blocks.push({
      command: name,
      output: [],
      pending: '',
      echoPending: true,
      echoRemain: name.replace(/\s/g, ''),
    });
    this.lastCommand = name;
    this.updateInfo();
    this.renderDrawer();
  }

  /**
   * 从 xterm buffer 提取光标所在输入行的命令文本。
   * 向上收集 wrapped 续行与多行输入的前段，切掉提示符前缀（Git Bash 默认 PS1 以 `$ `/`# ` 结尾）；
   * 找不到提示符标记时退化为光标行全文（自定义 PS1 场景）。
   */
  private readCommandFromBuffer(): string {
    const buf = this.term.buffer.active;
    const start = buf.baseY + buf.cursorY;
    let text = '';
    let cursorLine = '';
    for (let row = start; row >= 0 && start - row < 12; row--) {
      const ln = buf.getLine(row);
      if (!ln) break;
      const seg = ln.translateToString(true);
      if (row === start) cursorLine = seg;
      const below = buf.getLine(row + 1);
      const sep = row === start ? '' : below?.isWrapped ? '' : '\n';
      text = seg + sep + text;
      const cut = Math.max(text.lastIndexOf('$ '), text.lastIndexOf('# '));
      if (cut >= 0) return text.slice(cut + 2).trim();
    }
    return cursorLine.trim();
  }

  /* ---------- 后端输出：写 xterm + 区块 output 捕获 ---------- */
  private onBackendData(data: string): void {
    this.term.write(data);
    this.appendOutput(data);
    this.syncAltMode();
  }

  private appendOutput(data: string): void {
    if (this.altMode || this.blocks.length === 0) return;
    const block = this.blocks[this.blocks.length - 1];
    let clean = stripAnsi(data).replace(/\r/g, '');
    if (!clean) return;
    // 新区块先消费输入回显：按去空白归一化逐字符匹配命令文本（容忍 redraw 插入的
    // 换行/空白与 bracketed-paste 双回显），完成后跳到其后首个 \n；此后才是真实输出。
    // 失配（stty -echo，或快速输入时回显尾巴跨界）即按输出处理——不做后缀对齐：
    // `echo X` 的输出本身就是命令后缀，对齐会把真实输出当回显吃掉，宁可留回显尾巴。
    if (block.echoPending) {
      let i = 0;
      let mismatched = false;
      while (i < clean.length && block.echoRemain) {
        const ch = clean[i];
        if (ch === block.echoRemain[0]) block.echoRemain = block.echoRemain.slice(1);
        else if (ch === '\n' || ch === ' ' || ch === '\t') { /* 容忍 redraw 空白 */ }
        else { mismatched = true; break; }
        i++;
      }
      if (mismatched) {
        block.echoPending = false;
        clean = clean.slice(i);
      } else if (block.echoRemain) {
        return; // 回显跨 chunk，下一块继续
      } else {
        const nl = clean.indexOf('\n', i);
        if (nl < 0) return; // 等 Enter 的 \r\n
        block.echoPending = false;
        clean = clean.slice(nl + 1);
      }
      if (!clean) return;
    }
    const parts = clean.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) {
        block.pending += parts[i];
      } else {
        block.output.push(block.pending);
        block.pending = parts[i];
        if (block.output.length > MAX_BLOCK_LINES) block.output.shift();
      }
    }
    this.scheduleDrawerRefresh();
  }

  /** 抽屉刷新节流：输出捕获后末块内容变化，300ms 合并重绘 */
  private drawerTimer: number | null = null;
  private scheduleDrawerRefresh(): void {
    if (this.drawerTimer !== null) return;
    this.drawerTimer = window.setTimeout(() => {
      this.drawerTimer = null;
      this.renderDrawer();
    }, 300);
  }

  private syncAltMode(): void {
    const alt = this.term.buffer.active.type === 'alternate';
    if (alt && !this.altMode) {
      this.altMode = true;
      this.altLastCommand = this.lastCommand;
    } else if (!alt && this.altMode) {
      this.altMode = false;
    }
  }

  /* ---------- 退出 ---------- */
  private onExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.resizer?.disconnect();
    this.tab.el.classList.add('wb-tab-exited');
    const hint = code === null ? '[进程已退出]' : `[进程已退出 code=${code}]`;
    this.term.write(`\r\n\x1b[90m${hint}\x1b[0m\r\n`);
    this.updateInfo();
  }

  /* ---------- 尺寸 ---------- */
  private fitTerm(): void {
    if (!this.ready || this.failed || this.exited) return;
    try {
      this.fit.fit();
      const dims = this.fit.proposeDimensions();
      if (dims) void termResize(this.tab.id, dims.cols, dims.rows).catch(() => {});
    } catch {
      /* 面板隐藏（display:none）期间测量失败，忽略，ResizeObserver 会在可见时再触发 */
    }
  }

  /* ---------- 信息栏 / 抽屉 ---------- */
  private updateInfo(): void {
    this.infoCmd.textContent = this.lastCommand || '—';
    this.infoCmd.style.color = this.lastCommand ? 'var(--text-0)' : 'var(--text-2)';
    this.addChatBtn.disabled = !this.lastCommand;
    this.pinBtn.disabled = !this.lastCommand;
  }

  private renderDrawer(): void {
    this.drawerToggle.innerHTML = `${icon('history')} 历史区块 (${this.blocks.length})`;
    this.drawerBody.innerHTML = '';
    for (let bi = 0; bi < this.blocks.length; bi++) {
      const block = this.blocks[bi];
      const nextCmd = this.blocks[bi + 1]?.command;
      const item = document.createElement('div');
      item.className = 'term-block-item';
      const cmd = document.createElement('div');
      cmd.className = 'term-block-item-cmd';
      cmd.textContent = block.command;
      const out = document.createElement('div');
      out.className = 'term-block-item-out';
      out.textContent = this.cleanBlockLines(block, nextCmd).slice(0, 8).join('\n');
      const actions = document.createElement('div');
      actions.className = 'term-block-item-actions';
      const pin = document.createElement('button');
      pin.className = 'btn small';
      pin.innerHTML = `${icon('pin')} 快捷指令`;
      pin.title = '将该命令添加为快捷指令';
      pin.onclick = () => addQuickCommandModal(block.command);
      const chat = document.createElement('button');
      chat.className = 'btn small';
      chat.innerHTML = `${icon('chatPlus')} 添加到chat`;
      chat.onclick = () => this.sendToAI(this.snapshotOf(block));
      actions.append(pin, chat);
      item.append(cmd, out, actions);
      this.drawerBody.appendChild(item);
    }
  }

  /* ---------- 快照与 AI 对接 ---------- */
  /** 区块输出清洗：去行首命令回显、去行尾 shell 提示符与下一块命令的粘贴回显（drawer 展示与快照共用）。 */
  private cleanBlockLines(block: TermBlock, nextCmd?: string): string[] {
    const lines = block.output.length ? [...block.output] : [];
    if (block.pending) lines.push(block.pending);
    const cmd = block.command.trim();
    // 去行首的命令回显（bracketed-paste 会让 bash 回显输入，可能拼接重复）与空行
    while (lines.length) {
      const t = lines[0].trim();
      if (!t || (cmd && t.split(cmd).join('').trim() === '')) { lines.shift(); continue; }
      break;
    }
    // 去行尾的 shell 提示符（Git Bash 默认 PS1 = user@host MINGW64 / 路径 / $ 三件套）
    let poppedMingw = false;
    while (lines.length) {
      const last = lines[lines.length - 1].trim();
      if (!last) { lines.pop(); continue; }
      if (/^[$#]\s*$/.test(last) || /@\S+\s+(MINGW64|MINGW32|MSYS|UCRT64|CLANG64)/.test(last)) {
        poppedMingw = last.includes('MINGW') || last.includes('MSYS') || last.includes('UCRT') || last.includes('CLANG');
        lines.pop();
        continue;
      }
      // 提示符行（`$ ...` / `# ...` / `[user@host ~]$ ...`）：下一命令的输入回显与提示符同行残留，一律弹
      if (/^[$#]\s/.test(last) || /^\[[^\]]*\]\s*[$#]\s/.test(last)) { lines.pop(); continue; }
      // 裸提示符行（SSH 风格 `[root@work ~]# `）
      if (/^\[[^\]]*\]\s*[$#]\s*$/.test(last)) { lines.pop(); continue; }
      // 下一块命令的粘贴回显尾巴：仅当上方还残留提示符行时才弹（避免误吃真实输出——
      // 如 `echo typed-2` 的输出恰是下一块同名命令的后缀）
      if (nextCmd) {
        const normNext = nextCmd.replace(/\s/g, '');
        const normLast = last.replace(/\s/g, '');
        const below = lines.length >= 2 ? lines[lines.length - 2].trim() : '';
        const belowIsPrompt = /^[$#](\s|$)/.test(below) || /@\S+\s+(MINGW64|MINGW32|MSYS|UCRT64|CLANG64)/.test(below);
        if (normLast.length >= 3 && normNext.endsWith(normLast) && belowIsPrompt) { lines.pop(); continue; }
      }
      // PS1 中间的路径行：仅当刚弹掉 MINGW 提示行时才允许弹
      if (poppedMingw && /^(\/[\w./~\\-]*|[A-Za-z]:[\\/][\w./~\\-]*)$/.test(last)) { lines.pop(); poppedMingw = false; continue; }
      break;
    }
    return lines;
  }

  private snapshotOf(block: TermBlock): TermSnapshot {
    const idx = this.blocks.indexOf(block);
    const nextCmd = idx >= 0 ? this.blocks[idx + 1]?.command : undefined;
    return { id: uid('snap'), command: block.command, content: this.cleanBlockLines(block, nextCmd).join('\n'), ts: Date.now() };
  }

  takeSnapshot(): TermSnapshot {
    if (this.term.buffer.active.type === 'alternate') {
      // alternate screen：命令 = 进入前最后命令，内容 = 可视区各行
      const buf = this.term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const ln = buf.getLine(i);
        if (ln) lines.push(ln.translateToString(true));
      }
      return { id: uid('snap'), command: this.altLastCommand, content: lines.join('\n'), ts: Date.now() };
    }
    const block = this.blocks[this.blocks.length - 1];
    return block ? this.snapshotOf(block) : { id: uid('snap'), command: '', content: '', ts: Date.now() };
  }

  private sendToAI(snap: TermSnapshot): void {
    if (Workbench.ai && typeof Workbench.ai.addSnapshot === 'function') {
      Workbench.ai.addSnapshot(snap);
      toast('已添加到 AI 对话', 'success');
    } else {
      toast('AI 面板未就绪');
    }
  }

  /* ---------- 外部 api（供快捷指令 / AI 建议组件） ---------- */
  paste(cmd: string): void {
    if (this.failed || this.exited) return;
    this.suppressSettle++;
    this.term.paste(String(cmd)); // 逐字符写入输入行，不执行；块名等用户回车时从屏幕读
    this.suppressSettle--;
    this.typedBuf += String(cmd);
  }

  execute(cmd: string): void {
    const active = getActiveTab();
    if (!active || active.id !== this.tab.id) activateTab(this.tab.id);
    if (this.failed || this.exited) return;
    this.suppressSettle++;
    this.term.paste(String(cmd));
    this.suppressSettle--;
    // term.paste('\r') 会被 xterm 包上 bracketed-paste 标记，bash 只插入换行不执行；
    // 回车必须绕过 xterm 直发后端。块名直接用已知命令（屏幕回显是异步的，此刻读不可靠）。
    void termInput(this.tab.id, '\r').catch(() => { /* 忽略 */ });
    this.typedBuf = '';
    if (!this.altMode) this.pushBlock(String(cmd));
  }

  /* ---------- 关闭清理（tab.onClose 由 renderer 接管） ---------- */
  destroy(): void {
    liveTerms.delete(this);
    this.resizer?.disconnect();
    this.unlisteners.forEach((u) => { try { u(); } catch { /* 忽略退订异常 */ } });
    this.unlisteners = [];
    if (!this.exited) void termClose(this.tab.id).catch(() => {});
    try { this.term.dispose(); } catch { /* 忽略 dispose 异常 */ }
  }
}

/**
 * 渲染器：id 由打开方在前端生成（如 'term-local' / `term:<serverId>` / `term-<rand>`），
 * 先订阅事件再 term_create 的时序在 TermSession.init 内保证。
 */
function renderTerminal(container: HTMLElement, tab: Tab): { paste(cmd: string): void; execute(cmd: string): void; takeSnapshot(): TermSnapshot } {
  const session = new TermSession(container, tab);
  liveTerms.add(session);
  tab.onClose = () => session.destroy();
  return {
    paste: (cmd) => session.paste(cmd),
    execute: (cmd) => session.execute(cmd),
    takeSnapshot: () => session.takeSnapshot(),
  };
}

registerRenderer('terminal', renderTerminal);
