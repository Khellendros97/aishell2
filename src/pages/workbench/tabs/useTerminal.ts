/**
 * 终端会话引擎(React 迁移):TermSession 逐行翻译自 legacy/pages/workbench/terminal.ts,
 * 并连带移植:
 * - showAuthFixDialog(SSH 认证失败重设凭据对话框,legacy terminal.ts 同名单函数);
 * - addQuickCommandModal(「收藏为命令收藏」共享模态,legacy pages/workbench/quickcommand.ts,
 *   供信息栏 / 历史命令抽屉两处复用)。
 * 与后端的接口点(src/api.ts):term_create / term_input / term_resize / term_close、
 * term_record_start / term_record_stop,事件 term:data:<id> / term:exit:<id>;
 * 认证失败识别前缀 SSH_AUTH_FAILED_PREFIX(与 ssh.rs AUTH_FAILED_PREFIX 对齐)。
 *
 * React 差异(语义对齐 legacy):
 * - 无 tab.el / tab.pane 命令式 DOM:标签栏「已退出」置灰经 setTabBarExited 按
 *   #tab-bar / #tab-content 子节点顺序定位(两容器同序渲染同一 tabs 数组);
 * - 旧 Workbench 全局句柄 / bus 改为 stores/workbench.ts 的 useWorkbench / wbHandles /
 *   wbEvents / tabApis;keep-alive 的「标签激活」由 TerminalTab 的 useEffect([active])
 *   调 TermSession.onActivated() 承担(对照旧版 bus 'tab-activated' 的处理);
 * - 会话创建/销毁挂在组件生命周期:挂载 = 订阅事件 → term_create,卸载 = 退订 →
 *   term_close → dispose(不再用 tab.onClose 接管);
 * - 标签重命名(setTabTitle)会替换 tab 对象引用,TermSession 持有的是旧对象:
 *   读取标题统一走 tabTitle()(按 id 查 store),避免改名后右键引用/录制文件名用旧名。
 */
import { useEffect, useRef, type RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import type { IBuffer, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { UnlistenFn } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';

import {
  SSH_AUTH_FAILED_PREFIX, SSH_NEED_DEPLOY_KEY_PREFIX, getState, onTermData, onTermExit, openDialog,
  sshDeployPublicKey, termClose, termCreate, termInput, termRecordStart, termRecordStop, termResize,
  upsertProject,
} from '../../../api';
import type { TermKind } from '../../../api';
import type { QuickCommand, Server, ServerRef, TermSnapshot } from '../../../types';
import { saveServerWithCredentialChoice } from '../../settings/server-save';
import { icon } from '../../../icons';
import { attachCombo, copyText, showContextMenu, toast, uid } from '../../../ui';
import { dbg } from '../../../debug';
import { currentTheme, onThemeChange } from '../../../theme';
import {
  getActiveTab, tabApis, useWorkbench, wbEvents, wbHandles,
  type Tab, type TerminalApi,
} from '../../../stores/workbench';

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

/** 活跃终端实例：主题切换时批量换肤（destroy 时移除） */
const liveTerms = new Set<TermSession>();
/* 调试取证:CDP/控制台经 window.__terms 内省 xterm 内部状态(写队列/buffer/modes),
   用于 vi 卡死(xterm 渲染管线 stall)的活体诊断 */
declare global {
  interface Window { __terms?: Set<TermSession> }
}
window.__terms = liveTerms;
onThemeChange((t) => { liveTerms.forEach((s) => { s.term.options.theme = TERM_THEMES[t]; }); });

/** 历史命令：一条已结算命令及其输出（纯文本，剥除 ANSI）。 */
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
    .replace(/\\u001b[@-Z\\-_]/g, '')
    .replace(/\\u001b./g, '');
}

/**
 * 复制文本清洗:剥除选区里可能混入的 ANSI 转义(带 ESC 锚点)与 \t\n\r 之外的
 * C0 控制符。不做无锚点 CSI 剥离——buffer 经 xterm 解析器渲染,转义不会以纯文本
 * 残留;而用户手敲的 "\033[32m" 这类字面文本(printf 教程等)含 [32m 形态,
 * 无锚点规则会误伤真实内容(实测踩过)。
 */
function cleanCopiedText(s: string): string {
  return stripAnsi(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * zsh 默认提示符行（macOS：`user@host 路径 % [命令回显]`）判定。
 * `%` 必须锚定行首的 user@host 前缀——裸 `% ` 在真实输出里太常见（"100% done"、
 * printf 格式串），无锚会误吃输出。自定义主题（oh-my-zsh 等无 % 提示符）不在覆盖范围。
 */
function isZshPromptLine(s: string): boolean {
  return /^\S+@\S+(\s+[^\n]*)?\s%(\s|$)/.test(s);
}

/** zsh 提示符匹配（行首 user@host 前缀 + 非贪婪到首个 `% `），供 extractCommandFromBuffer 取切点。 */
const ZSH_PROMPT_RE = /(?:^|\n)\S+@\S+[^\n]*?% /g;

/**
 * 从 xterm buffer 提取光标所在输入行的命令文本（纯函数，供 TermSession 与测试复用）。
 * 向上收集 wrapped 续行与多行输入的前段，切掉提示符前缀（Git Bash 默认 PS1 以 `$ `/`# ` 结尾；
 * macOS zsh 默认 PS1 以 `% ` 结尾，锚定 user@host 前缀防误切命令里的百分号）；
 * 找不到提示符标记时退化为光标行全文（自定义 PS1 场景）。
 * 窗口为 200 行（旧 12 行）：长命令折行超窗时沿续行段继续向上找输入首行；
 * 提示符切割只在非续行（输入首行）上进行 —— 续行里的 `$ `（如 echo "$ "）是命令体内容，不误切。
 */
export function extractCommandFromBuffer(buf: IBuffer): string {
  const start = buf.baseY + buf.cursorY;
  let text = '';
  let cursorLine = '';
  for (let row = start; row >= 0 && start - row < 200; row--) {
    const ln = buf.getLine(row);
    if (!ln) break;
    const seg = ln.translateToString(true);
    if (row === start) cursorLine = seg;
    const below = buf.getLine(row + 1);
    const sep = row === start ? '' : below?.isWrapped ? '' : '\n';
    text = seg + sep + text;
    if (!ln.isWrapped) {
      // zsh：取行首锚定的最后一处提示符匹配，切点指向 `% ` 起始
      let zCut = -1;
      ZSH_PROMPT_RE.lastIndex = 0;
      let zm: RegExpExecArray | null;
      while ((zm = ZSH_PROMPT_RE.exec(seg))) zCut = zm.index + zm[0].length - 2;
      const cut = Math.max(seg.lastIndexOf('$ '), seg.lastIndexOf('# '), zCut);
      // text.slice(seg.length) 保留行间分隔符（续行 '' / 真换行 '\n'），只切掉提示符前缀
      if (cut >= 0) return (seg.slice(cut + 2) + text.slice(seg.length)).trim();
    }
    /* 超出旧 12 行窗口后只沿续行段继续向上（长命令折行）；遇到非续行仍无标记 →
       按旧语义退化，防止把上一条命令的回显/输出吃进来 */
    if (start - row >= 11 && !ln.isWrapped) break;
  }
  return cursorLine.trim();
}

/** TermSession 构造所需的 DOM 元素(由 TerminalTab 的 JSX ref 解析后传入)。 */
export interface TermElements {
  host: HTMLElement;
  infoCmd: HTMLElement;
  drawer: HTMLElement;
  drawerBody: HTMLElement;
  drawerToggle: HTMLButtonElement;
  drawerClose: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  addChatBtn: HTMLButtonElement;
  pinBtn: HTMLButtonElement;
  recBtn: HTMLButtonElement;
}

/** TerminalTab 传给 useTerminal 的 ref 集合(与 TermElements 一一对应)。 */
export interface TermElementRefs {
  host: RefObject<HTMLDivElement>;
  infoCmd: RefObject<HTMLSpanElement>;
  drawer: RefObject<HTMLDivElement>;
  drawerBody: RefObject<HTMLDivElement>;
  drawerToggle: RefObject<HTMLButtonElement>;
  drawerClose: RefObject<HTMLButtonElement>;
  clearBtn: RefObject<HTMLButtonElement>;
  addChatBtn: RefObject<HTMLButtonElement>;
  pinBtn: RefObject<HTMLButtonElement>;
  recBtn: RefObject<HTMLButtonElement>;
}

/**
 * 标签栏「已退出」置灰(对照旧版 tab.el.classList.add('wb-tab-exited')):
 * React 版 #tab-bar 与 #tab-content 均按同一 tabs 数组顺序渲染,取 pane 在
 * #tab-content 中的下标,给 #tab-bar 同下标子元素加/去类;找不到时静默(迁移期兜底)。
 */
function setTabBarExited(tabId: string, exited: boolean): void {
  const bar = document.getElementById('tab-bar');
  const pane = document.querySelector<HTMLElement>(`.tab-pane[data-tab-id="${tabId}"]`);
  if (!bar || !pane || !pane.parentElement) return;
  const idx = Array.prototype.indexOf.call(pane.parentElement.children, pane);
  const tabEl = idx >= 0 ? bar.children[idx] : undefined;
  tabEl?.classList.toggle('wb-tab-exited', exited);
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
  private readonly recBtn: HTMLButtonElement;
  private readonly drawer: HTMLElement;
  private readonly drawerBody: HTMLElement;
  private readonly drawerToggle: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;

  /** 录制状态标记（路径由 term_record_stop 返回,不额外持有）。 */
  private recording = false;

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
  /** 后端会话建立前到达的输入（含 xterm 对查询序列的自动应答）缓存,就绪后按序补发。 */
  private pendingInput: string[] = [];
  private pendingInputLen = 0;
  /** 重连流程吞掉旧通道的 term:exit（setTimeout 兜底,防旧任务不醒来导致永久吞事件）。 */
  private ignoreExit = false;
  /** 抽屉刷新节流：输出捕获后末块内容变化，300ms 合并重绘 */
  private drawerTimer: number | null = null;

  /** 日志用短 id（term:srv-xxx:t-yyyy → t-yyyy） */
  private get sid(): string {
    return this.tab.id.split(':').pop() ?? this.tab.id;
  }

  /**
   * 当前标签标题:store 重命名(setTabTitle)会替换 tab 对象,this.tab 是旧引用;
   * 统一按 id 查最新 title(右键引用名 / 录制文件名用)。
   */
  private get tabTitle(): string {
    return useWorkbench.getState().tabs.find((t) => t.id === this.tab.id)?.title ?? this.tab.title;
  }

  constructor(tab: Tab, els: TermElements) {
    this.tab = tab;
    this.host = els.host;
    this.infoCmd = els.infoCmd;
    this.drawer = els.drawer;
    this.drawerBody = els.drawerBody;
    this.drawerToggle = els.drawerToggle;
    this.clearBtn = els.clearBtn;
    this.addChatBtn = els.addChatBtn;
    this.pinBtn = els.pinBtn;
    this.recBtn = els.recBtn;

    this.clearBtn.disabled = true; // 初始无区块
    this.drawerToggle.onclick = () => this.drawer.classList.toggle('term-drawer-hidden');
    els.drawerClose.onclick = () => {
      this.drawer.classList.add('term-drawer-hidden');
    };
    this.clearBtn.onclick = () => this.clearHistoryBlocks();
    this.addChatBtn.onclick = () => this.sendToAI(this.takeSnapshot());
    this.recBtn.onclick = () => void this.toggleRecording();
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
    /* xterm 6.0.0 内建 DECRQM 处理器(requestMode 内 const enum 经 Vite 转译引用未声明变量)
       被调用必抛 ReferenceError,同步打断写队列排空链 → 终端渲染永久停摆
       (vim/less 等全屏程序启动必发 CSI ? Ps $ p 查询,触发即「卡死」)。
       后注册的同 ident 处理器优先执行,返回 true 阻断冒泡到内建坏处理器。 */
    this.term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, (params) => this.answerDecrqm(params, true));
    this.term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => this.answerDecrqm(params, false));
    this.term.open(this.host);
    this.term.onData((data) => this.onUserInput(data));

    /* 自定义右键菜单（原生菜单已全局禁用）：添加到对话 / 复制 / 粘贴 / 重连。
       添加到对话 = 把该终端对应引用加入 AI 输入框（SSH → @remote:服务器名称，本地 → @local） */
    this.host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const data = this.tab.data as { kind?: string; serverId?: string };
      const ref: ServerRef = data.kind === 'ssh' && data.serverId
        ? { serverId: data.serverId, name: this.tabTitle }
        : { serverId: null, name: '本地终端' };
      showContextMenu(e.clientX, e.clientY, [
        { label: '添加到对话', iconName: 'chatPlus', action: () => wbHandles.ai?.addServerRef?.(ref) },
        { label: '复制', iconName: 'copy', disabled: !this.term.hasSelection(), action: () => this.copySelection() },
        { label: '粘贴', iconName: 'clipboard', action: () => void this.pasteClipboard() },
        this.recording
          ? { label: '停止录制', iconName: 'circle', action: () => { void this.stopRecording(false); this.term.focus(); } }
          : { label: '开始录制', iconName: 'circle', action: () => { void this.startRecording(); this.term.focus(); } },
        { label: '重连终端(当前会话将中断)', iconName: 'refresh', action: () => void this.reconnect() },
      ]);
    });
    /* 中键快捷复制/粘贴；终端应用启用鼠标追踪时交还给应用（vim/tmux 等）。 */
    this.host.addEventListener('mousedown', (e) => {
      if (e.button !== 1 || this.term.modes.mouseTrackingMode !== 'none') return;
      e.preventDefault();
      if (this.term.hasSelection()) this.copySelection();
      else void this.pasteClipboard();
    });
    /* Ctrl+Shift+C 复制选区 / Ctrl+Shift+V 粘贴；
       preventDefault 必须调：否则浏览器默认行为（Chromium 的粘贴为纯文本）会再粘贴一遍 */
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        e.preventDefault();
        this.copySelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        e.preventDefault();
        void this.pasteClipboard();
        return false;
      }
      return true;
    });

    void this.init();
  }

  /* ---------- 初始化：先订阅事件、再创建后端（避免输出竞态丢失） ---------- */
  private async init(): Promise<void> {
    const data = this.tab.data as { kind?: string; serverId?: string; cwd?: string | null };
    const kind: TermKind = data.kind === 'ssh' ? 'ssh' : 'local';
    dbg(`${this.sid} init kind=${kind}`);
    try {
      this.unlisteners.push(await onTermData(this.tab.id, (d) => this.onBackendData(d)));
      this.unlisteners.push(await onTermExit(this.tab.id, (code) => this.onExit(code)));
      await termCreate(this.tab.id, kind, data.serverId ?? null, data.cwd ?? null);
      this.ready = true;
      dbg(`${this.sid} ready`);
      // 补发建立期间缓存的输入（如终端就绪前用户已敲下的命令、xterm 的自动应答）
      const pending = this.pendingInput.splice(0);
      this.pendingInputLen = 0;
      for (const s of pending) void termInput(this.tab.id, s).catch(() => { /* 忽略 */ });
      this.fitTerm();
      this.resizer = new ResizeObserver(() => this.fitTerm());
      this.resizer.observe(this.host);
      this.term.focus();
    } catch (err) {
      this.failed = true;
      const msg = String(err);
      dbg(`${this.sid} failed ${msg}`);
      toast(msg, 'error');
      this.term.write(`\r\n\x1b[31m[启动失败] ${msg}\x1b[0m\r\n`);
      this.handleConnectError(msg);
      this.updateInfo();
    }
  }

  /* ---------- DECRQM 应答（覆盖 xterm 6.0.0 坏内建，见构造器注释） ---------- */
  /** DECRPM 同步应答：状态值 0 未识别 / 1 set / 2 reset / 3 永久 set / 4 永久 reset。 */
  private answerDecrqm(params: (number | number[])[] | { params: (number | number[])[] }, ansi: boolean): boolean {
    // 公共类型标注为数组,运行时实际传 IParams 对象（内嵌 .params 数组）:两种形态兼容取值
    const list = Array.isArray(params) ? params : params.params;
    // DECRQM 首参恒为标量模式号（数组形仅多值参数场景）
    const mode = typeof list[0] === 'number' ? list[0] : 0;
    const m = this.term.modes;
    const b = (v: boolean) => (v ? 1 : 2);
    // xterm 无公开类型的字段（光标隐藏态 / 鼠标编码）：一次性受控转型取内部服务
    const internals = this.term as unknown as {
      _core: { _coreService: { isCursorHidden: boolean }; _coreMouseService: { activeEncoding: string } };
    };
    let v: number;
    if (ansi) {
      if (mode === 2) v = 4;
      else if (mode === 4) v = b(m.insertMode);
      else if (mode === 12) v = 3;
      else if (mode === 20) v = b(this.term.options.convertEol ?? false);
      else v = 0;
    } else if (mode === 1) v = b(m.applicationCursorKeysMode);
    else if (mode === 6) v = b(m.originMode);
    else if (mode === 7) v = b(m.wraparoundMode);
    else if (mode === 8) v = 3;
    else if (mode === 9) v = b(m.mouseTrackingMode === 'x10');
    else if (mode === 12) v = b(this.term.options.cursorBlink ?? false);
    else if (mode === 25) v = b(!internals._core._coreService.isCursorHidden);
    else if (mode === 45) v = b(m.reverseWraparoundMode);
    else if (mode === 66) v = b(m.applicationKeypadMode);
    else if (mode === 67) v = 4;
    else if (mode === 1000) v = b(m.mouseTrackingMode === 'vt200');
    else if (mode === 1002) v = b(m.mouseTrackingMode === 'drag');
    else if (mode === 1003) v = b(m.mouseTrackingMode === 'any');
    else if (mode === 1004) v = b(m.sendFocusMode);
    else if (mode === 1005 || mode === 1015) v = 4;
    else if (mode === 1006) v = b(internals._core._coreMouseService.activeEncoding === 'SGR');
    else if (mode === 1016) v = b(internals._core._coreMouseService.activeEncoding === 'SGR_PIXELS');
    else if (mode === 1048) v = 1; // 与 xterm 内建语义一致：1048 恒报 SET
    else if (mode === 47 || mode === 1047 || mode === 1049) v = b(this.term.buffer.active.type === 'alternate');
    else if (mode === 2004) v = b(m.bracketedPasteMode);
    else v = 0;
    // 走公开 input(wasUserInput=false):触发 onData → 终端输入管线 → 后端,与内建应答同路
    this.term.input(`\x1b[${ansi ? '' : '?'}${mode};${v}$y`, false);
    return true;
  }

  /* ---------- 输入：转发后端 + 区块追踪 ---------- */
  /** 复制当前选区到系统剪贴板(清洗 ANSI 转义/控制符;无选区时静默)；
      复制后焦点交还终端（右键菜单的 DOM 按钮点击会夺走焦点，不还回则回车等按键不再进 xterm） */
  private copySelection(): void {
    const sel = this.term.getSelection();
    if (sel) void copyText(cleanCopiedText(sel));
    this.term.focus();
  }

  /** 读系统剪贴板并粘贴进终端（走 xterm paste 路径，保留 bracketed paste 语义与区块追踪）；
      粘贴后焦点交还终端（理由同 copySelection） */
  private async pasteClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.term.paste(text);
    } catch { /* 剪贴板读取失败（权限等）静默 */ }
    this.term.focus();
  }

  private onUserInput(data: string): void {
    if (this.failed || this.exited) return;
    if (!this.ready) {
      // 通道尚未就绪(SSH 建连需 1-2s):缓存而非丢弃,上限 8KB 防无界增长
      if (this.pendingInputLen + data.length <= 8192) {
        this.pendingInput.push(data);
        this.pendingInputLen += data.length;
        dbg(`${this.sid} fe-send-buffered len=${data.length}`);
      }
      return;
    }
    dbg(`${this.sid} fe-send len=${data.length}`);
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

  /** 从 xterm buffer 提取光标所在输入行的命令文本（实现见模块级纯函数 extractCommandFromBuffer） */
  private readCommandFromBuffer(): string {
    return extractCommandFromBuffer(this.term.buffer.active);
  }

  /* ---------- 后端输出：写 xterm + 区块 output 捕获 ---------- */
  private onBackendData(data: string): void {
    dbg(`${this.sid} fe-recv len=${data.length} alt=${this.altMode ? 1 : 0}`);
    // 渲染管线 stall 取证:write 抛异常时落日志(正常路径零开销)
    try {
      this.term.write(data);
    } catch (e) {
      dbg(`${this.sid} fe-write-err ${String(e).slice(0, 200)}`);
    }
    try {
      this.appendOutput(data);
      this.syncAltMode();
    } catch (e) {
      dbg(`${this.sid} fe-block-err ${String(e).slice(0, 200)}`);
    }
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
      }
    }
    // 批末整段裁剪：满速输出（tar -v 等）一批可达数万行，每行 shift 是
    // O(MAX_BLOCK_LINES) 数组搬移，O(n²) 会把 JS 线程钉死；批末一次 splice
    // 语义等价（批内瞬时略超上限，展示/快照均取头尾，无行为差异）
    if (block.output.length > MAX_BLOCK_LINES) {
      block.output.splice(0, block.output.length - MAX_BLOCK_LINES);
    }
    this.scheduleDrawerRefresh();
  }

  /** 抽屉刷新节流：输出捕获后末块内容变化，300ms 合并重绘 */
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
    // 重连流程：旧通道的 term:exit 是预期内事件,吞掉一次（超时兜底在 reconnect 内）
    if (this.ignoreExit) {
      this.ignoreExit = false;
      dbg(`${this.sid} fe-exit-swallowed code=${code}`);
      return;
    }
    if (this.exited) return;
    this.exited = true;
    dbg(`${this.sid} fe-exit code=${code}`);
    this.resizer?.disconnect();
    setTabBarExited(this.tab.id, true);
    const hint = code === null ? '[进程已退出]' : `[进程已退出 code=${code}]`;
    this.term.write(`\r\n\x1b[90m${hint}\x1b[0m\r\n`);
    this.updateInfo();
  }

  /* ---------- 重连:旧通道关闭(吞掉其 term:exit),同 id 重建后端会话 ---------- */
  private async reconnect(): Promise<void> {
    // 失败态也允许重连（原实现 `if (this.failed) return` 导致密码错误等建连失败后
    // 右键重连失效）：establish 会重置失败态并重建会话，再次失败仍走 handleConnectError 兜底
    dbg(`${this.sid} fe-reconnect${this.failed ? '(failed 态重试)' : ''}`);
    this.ignoreExit = true;
    setTimeout(() => { this.ignoreExit = false; }, 8000);
    try { await termClose(this.tab.id); } catch { /* 已关闭忽略 */ }
    await this.establish();
  }

  /** 认证失败重设凭据成功后重试（init 失败态专用：后端无旧会话可关，直接重建）。 */
  private async connectAfterAuthFix(): Promise<void> {
    dbg(`${this.sid} fe-auth-retry`);
    await this.establish();
  }

  /** 与后端重建会话：重置状态 → term_create；失败统一走 handleConnectError 分流。 */
  private async establish(): Promise<void> {
    this.ready = false;
    this.exited = false;
    this.failed = false;
    setTabBarExited(this.tab.id, false);
    this.pendingInput = [];
    this.pendingInputLen = 0;
    this.term.reset();
    // 新会话清空区块追踪（旧区块属于已中断的旧会话）
    this.blocks = [];
    this.altMode = false;
    this.altLastCommand = '';
    this.lastCommand = '';
    const data = this.tab.data as { kind?: string; serverId?: string; cwd?: string | null };
    const kind: TermKind = data.kind === 'ssh' ? 'ssh' : 'local';
    try {
      await termCreate(this.tab.id, kind, data.serverId ?? null, data.cwd ?? null);
      this.ready = true;
      this.resizer?.disconnect();
      this.resizer = new ResizeObserver(() => this.fitTerm());
      this.resizer.observe(this.host);
      this.fitTerm();
      this.term.focus();
      toast('终端已重连', 'success');
    } catch (err) {
      this.failed = true;
      const msg = String(err);
      toast(msg, 'error');
      this.term.write(`\r\n\x1b[31m[重连失败] ${msg}\x1b[0m\r\n`);
      this.handleConnectError(msg);
    }
    this.updateInfo();
    this.renderDrawer();
  }

  /**
   * 建连错误分流（待优化 4）：后端以 SSH_AUTH_FAILED_PREFIX 前缀标记认证失败
   * （密码/密钥错误等，见 ssh.rs auth_failed_msg）→ 弹「重设登录凭据」对话框，
   * 用户修正后自动重试连接；
   * SSH_NEED_DEPLOY_KEY_PREFIX 标记公钥(密钥对)认证被拒（服务器尚未存公钥，
   * 见 ssh.rs need_deploy_msg）→ 弹「输入密码自动部署公钥」对话框。
   * AI 触发场景不会走到这里：后端错误文本直接返回，不弹任何框。
   */
  private handleConnectError(msg: string): void {
    const data = this.tab.data as { serverId?: string };
    if (msg.startsWith(SSH_NEED_DEPLOY_KEY_PREFIX)) {
      if (!data.serverId) return;
      dbg(`${this.sid} fe-need-deploy-key, opening deploy dialog`);
      void showDeployKeyDialog(data.serverId, msg, () => void this.connectAfterAuthFix());
      return;
    }
    if (!msg.startsWith(SSH_AUTH_FAILED_PREFIX)) return;
    // tab.data 由打开方构造（见 openTab 调用处），serverId 为 SSH 终端固定字段
    if (!data.serverId) return;
    dbg(`${this.sid} fe-auth-failed, opening fix dialog`);
    void showAuthFixDialog(data.serverId, msg, () => void this.connectAfterAuthFix());
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
  /** 清空历史命令：清空前端区块/快照数据并清屏显示（语义同原型 clear 命令 ——
      只清区块记录不动 scrollback：xterm.clear() 把可视内容移入 scrollback，不抹除历史输出） */
  private clearHistoryBlocks(): void {
    this.blocks = [];
    this.term.clear();
    this.renderDrawer();
    toast('已清空历史命令', 'success');
  }

  private updateInfo(): void {
    this.infoCmd.textContent = this.lastCommand || '—';
    this.infoCmd.style.color = this.lastCommand ? 'var(--text-0)' : 'var(--text-2)';
    this.addChatBtn.disabled = !this.lastCommand;
    this.pinBtn.disabled = !this.lastCommand;
  }

  private renderDrawer(): void {
    this.drawerToggle.innerHTML = `${icon('history')} 历史命令 (${this.blocks.length})`;
    this.clearBtn.disabled = this.blocks.length === 0;
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
      pin.innerHTML = `${icon('star')} 命令收藏`;
      pin.title = '将该命令添加为命令收藏';
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
    // 去行尾的 shell 提示符（Git Bash 默认 PS1 = user@host MINGW64 / 路径 / $ 三件套；
    // macOS zsh 默认 PS1 = user@host 路径 % 单行）
    let poppedMingw = false;
    while (lines.length) {
      const last = lines[lines.length - 1].trim();
      if (!last) { lines.pop(); continue; }
      if (/^[$#]\s*$/.test(last) || /@\S+\s+(MINGW64|MINGW32|MSYS|UCRT64|CLANG64)/.test(last) || isZshPromptLine(last)) {
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
        const belowIsPrompt = /^[$#](\s|$)/.test(below) || /@\S+\s+(MINGW64|MINGW32|MSYS|UCRT64|CLANG64)/.test(below) || isZshPromptLine(below);
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
    if (wbHandles.ai && typeof wbHandles.ai.addSnapshot === 'function') {
      wbHandles.ai.addSnapshot(snap);
      toast('已添加到 AI 对话', 'success');
    } else {
      toast('AI 面板未就绪');
    }
  }

  /* ---------- 外部 api（供命令收藏 / AI 建议组件使用） ---------- */
  paste(cmd: string): void {
    if (this.failed || this.exited) return;
    this.suppressSettle++;
    this.term.paste(String(cmd)); // 逐字符写入输入行，不执行；块名等用户回车时从屏幕读
    this.suppressSettle--;
    this.typedBuf += String(cmd);
  }

  execute(cmd: string): void {
    const s = useWorkbench.getState();
    const active = getActiveTab(s);
    if (!active || active.id !== this.tab.id) s.activateTab(this.tab.id);
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

  /** 聚焦 xterm（外部入口粘贴命令后调用，保证「直接回车即可执行」） */
  focus(): void {
    if (this.failed || this.exited) return;
    this.term.focus();
  }

  /** 发送 Ctrl+C（^C 中断）：与 xterm 键盘路径等价（onData 直发 termInput('\x03')），
   *  供 AI 面板等外部焦点场景转发中断信号；同步清 typedBuf（同真实 Ctrl+C 语义）。 */
  ctrlC(): void {
    if (this.failed || this.exited) return;
    this.typedBuf = '';
    void termInput(this.tab.id, '\x03').catch(() => { /* 终端已关闭等后端错误忽略 */ });
  }

  /** keep-alive 标签激活（active false→true，由 TerminalTab 的 useEffect([active]) 调起）：
   *  对照旧版 bus 'tab-activated' 的处理：fit（面板由 display:none 变为可见后尺寸可能
   *  未及 ResizeObserver 触发）+ 聚焦终端。 */
  onActivated(): void {
    if (this.failed || this.exited) return;
    this.fitTerm();
    this.term.focus();
  }

  /* ---------- 录制（tee 到 项目/.aishell/record/服务器-日期时间.log） ---------- */
  /** 顶部按钮点击：按当前状态切换开始/停止。 */
  private async toggleRecording(): Promise<void> {
    if (this.recording) await this.stopRecording(false);
    else await this.startRecording();
  }

  /** 文件名时间戳：yyyymmdd-HHMMSS。 */
  private fmtTs(d: Date): string {
    const p = (v: number) => String(v).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** 日志头尾时间戳：yyyy-MM-dd HH:mm:ss。 */
  private fmtStamp(d: Date): string {
    const p = (v: number) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** 开始录制：文件名 服务器-yyyymmdd-HHMMSS.log（SSH 用 tab.title 服务器名，本地固定「本地终端」）。 */
  private async startRecording(): Promise<void> {
    const projectPath = useWorkbench.getState().project?.path;
    if (!projectPath) {
      toast('项目未绑定本地目录，无法保存录制文件', 'error');
      return;
    }
    const data = this.tab.data as { kind?: string };
    const name = (data.kind === 'ssh' ? this.tabTitle : '本地终端').replace(/[\\/:*?"<>|]/g, '_');
    const path = `${projectPath.replace(/[\\/]+$/, '')}/.aishell/record/${name}-${this.fmtTs(new Date())}.log`;
    const header = `===== 录制开始 ${this.fmtStamp(new Date())} =====`;
    try {
      await termRecordStart(this.tab.id, path, header);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    this.recording = true;
    this.recBtn.classList.add('recording');
    this.recBtn.innerHTML = `${icon('circle')} 停止录制`;
    toast('已开始录制', 'success');
  }

  /** 停止录制：日志尾写结束时间，提示保存位置。auto=true 为关标签自动停止（同样提示）。 */
  private async stopRecording(auto: boolean): Promise<void> {
    const footer = `===== 录制结束 ${this.fmtStamp(new Date())} =====`;
    let p: string | null = null;
    try {
      p = await termRecordStop(this.tab.id, footer);
    } catch (err) {
      console.warn('停止录制失败', err);
      toast(String(err), 'error');
      return;
    }
    dbg(`${this.sid} record-stop auto=${auto}`);
    this.recording = false;
    this.recBtn.classList.remove('recording');
    this.recBtn.innerHTML = `${icon('circle')} 录制`;
    if (p) toast(`录制已停止，日志保存至: ${p}`, 'success', 6000);
  }

  /* ---------- 关闭清理（React 卸载时由 useTerminal 的 effect cleanup 调起） ---------- */
  destroy(): void {
    liveTerms.delete(this);
    this.resizer?.disconnect();
    if (this.recording) void this.stopRecording(true);
    this.unlisteners.forEach((u) => { try { u(); } catch { /* 忽略退订异常 */ } });
    this.unlisteners = [];
    if (!this.exited) void termClose(this.tab.id).catch(() => {});
    try { this.term.dispose(); } catch { /* 忽略 dispose 异常 */ }
  }
}

/* ---------- 公钥(密钥对)部署密码对话框 ---------- */

/**
 * 公钥(密钥对)认证被拒时弹出（由 TermSession.handleConnectError 触发）：
 * 服务器尚未保存该公钥，用户输入一次密码 → ssh_deploy_public_key 自动部署到
 * authorized_keys（ssh-copy-id 等价，幂等）；部署成功后回调 onDeployed 自动重连。
 * 密码一次性使用，不进系统凭据库（展示时剥掉后端机器识别前缀）。
 */
async function showDeployKeyDialog(serverId: string, errorMsg: string, onDeployed: () => void): Promise<void> {
  const state = await getState().catch(() => null);
  const server = state?.servers.find((s) => s.id === serverId);
  if (!server) return; // 服务器已被删除：无从部署，不弹框

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const displayErr = errorMsg.startsWith(SSH_NEED_DEPLOY_KEY_PREFIX)
    ? errorMsg.slice(SSH_NEED_DEPLOY_KEY_PREFIX.length)
    : errorMsg;
  mask.innerHTML = `
    <div class="modal authfix-modal">
      <div class="modal-head">
        <h3>自动部署公钥 · 需要一次密码</h3>
        <button class="icon-btn authfix-close" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>提示</label>
          <div class="authfix-err">
            <pre></pre>
          </div>
        </div>
        <div class="authfix-divider"></div>
        <div class="field">
          <label>账户</label>
          <div class="hint deploy-account"></div>
        </div>
        <div class="field">
          <label>密码<span class="req">*</span></label>
          <input class="input authfix-password" type="password" placeholder="一次性输入，仅用于本次部署，不会保存">
        </div>
        <div class="authfix-error"></div>
      </div>
      <div class="modal-foot">
        <button class="btn authfix-cancel">取消</button>
        <button class="btn primary authfix-deploy">部署并连接</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  const errEl = mask.querySelector('.authfix-error') as HTMLElement;
  const passwordEl = mask.querySelector('.authfix-password') as HTMLInputElement;
  const deployBtn = mask.querySelector('.authfix-deploy') as HTMLButtonElement;
  const pre = mask.querySelector('.authfix-err pre')!;
  const accountEl = mask.querySelector('.deploy-account')!;

  pre.textContent = displayErr;
  // 账户信息用 textContent 注入，避免服务器名含 HTML 文本时被解释
  accountEl.textContent = `${server.name}（${server.host}:${server.port}） · ${server.username} 的登录密码仅用于本次部署，不会保存`;

  const close = (): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
  };
  mask.querySelector('.authfix-close')!.addEventListener('click', close);
  mask.querySelector('.authfix-cancel')!.addEventListener('click', close);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mask.isConnected) close();
  }, { once: true });

  passwordEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') void deploy(); });
  deployBtn.addEventListener('click', () => void deploy());
  passwordEl.focus();

  async function deploy(): Promise<void> {
    const password = passwordEl.value;
    if (!password) { errEl.textContent = '请输入密码'; return; }
    errEl.textContent = '';
    deployBtn.disabled = true;
    try {
      await sshDeployPublicKey(serverId, password);
      passwordEl.value = '';
      toast('公钥已部署，正在重新连接…', 'success');
      close();
      onDeployed();
    } catch (err) {
      // 密码错误等：剥掉认证失败前缀展示（与 authfix 对话框一致）
      const e = String(err);
      errEl.textContent = e.startsWith(SSH_AUTH_FAILED_PREFIX) ? e.slice(SSH_AUTH_FAILED_PREFIX.length) : e;
      deployBtn.disabled = false;
    }
  }
}

/* ---------- SSH 认证失败重设凭据对话框（待优化 4） ---------- */

/**
 * 密码/密钥认证失败时弹出（由 TermSession.handleConnectError 触发）：
 * 顶部完整展示后端报错——等宽、可滚动、可复制，不被下方表单遮挡；
 * 表单可修改用户名 / 认证方式（密码|密钥）/ 密码 / 密钥路径。
 * 保存后：密码走 keyring（upsert_server 的 password 参数，留空=保持原值），
 * 其余字段经 upsert_server 落库；成功后回调 onSaved 自动重连。
 */
async function showAuthFixDialog(serverId: string, errorMsg: string, onSaved: () => void): Promise<void> {
  const state = await getState().catch(() => null);
  const server = state?.servers.find((s) => s.id === serverId);
  if (!server) return; // 服务器已被删除：无从重设，不弹框
  const srv: Server = server; // 具名 const：闭包内保持收窄后的类型

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  // 展示时剥掉后端机器识别前缀（[SSH认证失败]，见 ssh.rs AUTH_FAILED_PREFIX）
  const displayErr = errorMsg.startsWith(SSH_AUTH_FAILED_PREFIX)
    ? errorMsg.slice(SSH_AUTH_FAILED_PREFIX.length)
    : errorMsg;
  mask.innerHTML = `
    <div class="modal authfix-modal">
      <div class="modal-head">
        <h3>SSH 连接失败 · 重新设置登录凭据</h3>
        <button class="icon-btn authfix-close" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>报错信息</label>
          <div class="authfix-err">
            <pre></pre>
            <button class="btn small ghost authfix-copy">${icon('copy')} 复制</button>
          </div>
        </div>
        <div class="authfix-divider"></div>
        <div class="field">
          <label>账号<span class="req">*</span></label>
          <input class="input authfix-username" type="text" spellcheck="false">
        </div>
        <div class="field">
          <label>认证方式<span class="req">*</span></label>
          <select class="select authfix-auth">
            <option value="password">账号密码</option>
            <option value="key">密钥文件</option>
            <option value="publickey">SSH 公钥（密钥对）</option>
          </select>
        </div>
        <div class="field authfix-f-password">
          <label>密码</label>
          <input class="input authfix-password" type="password" placeholder="留空表示保持原密码不变">
          <div class="hint">密码只保存到系统钥匙串（account server:${serverId}），不会写入任何配置文件</div>
        </div>
        <div class="field authfix-f-key">
          <label class="authfix-keylabel">密钥文件路径</label>
          <div class="input-row">
            <input class="input mono authfix-keypath" spellcheck="false" placeholder="C:\\Users\\demo\\.ssh\\id_ed25519">
            <button class="btn authfix-browse">浏览…</button>
          </div>
        </div>
        <div class="authfix-error"></div>
      </div>
      <div class="modal-foot">
        <button class="btn authfix-cancel">取消</button>
        <button class="btn primary authfix-save">保存并重连</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  const errEl = mask.querySelector('.authfix-error') as HTMLElement;
  const usernameEl = mask.querySelector('.authfix-username') as HTMLInputElement;
  const authEl = mask.querySelector('.authfix-auth') as HTMLSelectElement;
  const passwordEl = mask.querySelector('.authfix-password') as HTMLInputElement;
  const keypathEl = mask.querySelector('.authfix-keypath') as HTMLInputElement;
  const saveBtn = mask.querySelector('.authfix-save') as HTMLButtonElement;
  const pre = mask.querySelector('.authfix-err pre')!;

  pre.textContent = displayErr;
  usernameEl.value = server.username;
  authEl.value = server.authType;
  keypathEl.value = server.keyPath;
  const syncAuth = (): void => {
    const kind = authEl.value;
    mask.querySelector('.authfix-f-password')!.classList.toggle('hidden', kind !== 'password');
    mask.querySelector('.authfix-f-key')!.classList.toggle('hidden', kind === 'password');
    // publickey 的路径字段是「密钥对目录」，文案随认证方式切换
    const keyLabel = mask.querySelector('.authfix-keylabel')!;
    keyLabel.textContent = kind === 'publickey' ? '密钥对目录' : '密钥文件路径';
    keypathEl.placeholder = kind === 'publickey'
      ? 'C:\\Users\\demo\\.ssh'
      : 'C:\\Users\\demo\\.ssh\\id_ed25519';
  };
  authEl.addEventListener('change', syncAuth);
  syncAuth();

  const close = (): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
  };
  mask.querySelector('.authfix-close')!.addEventListener('click', close);
  mask.querySelector('.authfix-cancel')!.addEventListener('click', close);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mask.isConnected) close();
  }, { once: true });

  mask.querySelector('.authfix-copy')!.addEventListener('click', () => {
    void copyText(displayErr).then(() => toast('报错信息已复制', 'success'));
  });
  mask.querySelector('.authfix-browse')!.addEventListener('click', async () => {
    const path = await openDialog();
    if (path) keypathEl.value = path;
  });

  saveBtn.addEventListener('click', () => void save());
  usernameEl.focus();

  async function save(): Promise<void> {
    const username = usernameEl.value.trim();
    const authType = authEl.value === 'password' ? 'password' : authEl.value === 'publickey' ? 'publickey' : 'key';
    const password = passwordEl.value;
    const keyPath = keypathEl.value.trim();
    if (!username) { errEl.textContent = '请填写账号'; return; }
    if (authType !== 'password' && !keyPath) {
      errEl.textContent = authType === 'publickey' ? '请填写密钥对目录' : '请填写密钥文件路径';
      return;
    }
    errEl.textContent = '';
    const next: Server = { ...srv, username, authType, keyPath: authType === 'password' ? '' : keyPath };
    // 密码留空 = 保持原值（后端 password=null 不触碰 keyring）
    const passwordOrNull = authType === 'password' ? (password || null) : null;
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    let saved: Server | null;
    try {
      saved = await saveServerWithCredentialChoice(next, passwordOrNull);
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存并重连';
      errEl.textContent = String(err);
      toast(String(err), 'error');
      return;
    }
    if (!saved) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存并重连';
      return;
    }
    close();
    onSaved();
  }
}

/* ---------- 收藏为命令收藏模态（对照 legacy/pages/workbench/quickcommand.ts） ---------- */

/**
 * 流程:命令去重 → 弹模态(标题必填,预填命令截断) → 追加到 store 项目 quickCommands
 * → upsertProject 持久化 → wbEvents.emit('project-changed') 联动命令收藏面板刷新。
 * 模态含「所属目录」(组合框,可手输新分类,后端 upsert 自动注册)与「全局可用」复选框。
 * React 差异:legacy 直接改 Workbench.state.project 引用,这里按 zustand 不可变更新
 * (新数组 + setState),持久化载荷一致。
 */
export function addQuickCommandModal(cmdText: string): void {
  const project = useWorkbench.getState().project;
  if (!project) { toast('当前没有打开的项目', 'error'); return; }
  const qcs = project.quickCommands ?? [];
  if (qcs.some((q) => q.command === cmdText)) {
    toast('该命令已在命令收藏中', 'error');
    return;
  }
  /* 分类下拉候选：commandFolders ∪ 本项目命令 folder 派生值（异步拉取，失败时仅用本项目候选） */
  let cmdFolders: string[] = [];
  void getState()
    .then((s) => { cmdFolders = s.commandFolders ?? []; })
    .catch(() => { /* 后端未就绪时下拉仅含本项目命令派生目录 */ });
  const folderOptions = (): string[] => {
    const opts = new Set<string>(cmdFolders);
    qcs.forEach((q) => { if (q.folder) opts.add(q.folder); });
    return Array.from(opts).sort((a, b) => a.localeCompare(b, 'zh'));
  };

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:460px">
      <div class="modal-head"><h3>添加命令收藏</h3></div>
      <div class="modal-body">
        <div class="field"><label>指令标题<span class="req">*</span></label><input class="input mono term-qc-title" maxlength="40"></div>
        <div class="field"><label>命令</label><input class="input mono term-qc-cmd"></div>
        <div class="field"><label>所属目录</label>
          <input class="input term-qc-folder" placeholder="可输入新分类或从下拉选择，例如：常用/部署">
          <div class="hint">以 / 分隔的目录路径，可下拉选择已有分类，也可直接输入新分类；留空表示未分类</div>
        </div>
        <div class="field"><label class="term-qc-global-label">
          <input type="checkbox" class="term-qc-global"> 全局可用（所有项目的命令收藏与快捷指令面板可见可用）
        </label>
        <div class="hint">勾选后可在所有项目中使用；编辑/删除仍归属本项目</div></div>
      </div>
      <div class="modal-foot">
        <button class="btn term-qc-cancel">取消</button>
        <button class="btn primary term-qc-ok">保存</button>
      </div>
    </div>`;
  const titleInput = mask.querySelector('.term-qc-title') as HTMLInputElement;
  const cmdInput = mask.querySelector('.term-qc-cmd') as HTMLInputElement;
  const folderInput = mask.querySelector('.term-qc-folder') as HTMLInputElement;
  const globalInput = mask.querySelector('.term-qc-global') as HTMLInputElement;
  titleInput.value = cmdText.length > 24 ? `${cmdText.slice(0, 24)}…` : cmdText;
  cmdInput.value = cmdText;
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  attachCombo(folderInput, folderOptions);
  titleInput.focus();
  titleInput.select();
  const close = () => { mask.classList.remove('open'); setTimeout(() => mask.remove(), 160); };
  (mask.querySelector('.term-qc-cancel') as HTMLButtonElement).onclick = close;
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  const save = () => {
    const title = titleInput.value.trim();
    const command = cmdInput.value.trim();
    if (!title) { titleInput.style.borderColor = 'var(--red)'; titleInput.focus(); return; }
    if (!command) { cmdInput.style.borderColor = 'var(--red)'; cmdInput.focus(); return; }
    /* 所属目录：规范化 '/' 分隔路径（去首尾/重复分隔符），留空 = 未分类 */
    const folder = folderInput.value.trim().split('/').filter(Boolean).join('/');
    const next: QuickCommand = { id: uid('qc'), title, command, folder, global: globalInput.checked };
    const nextProject = { ...project, quickCommands: [...qcs, next] };
    useWorkbench.setState({ project: nextProject });
    void upsertProject(nextProject).catch((e) => toast(String(e), 'error'));
    wbEvents.emit('project-changed');
    toast('已添加命令收藏', 'success');
    close();
  };
  (mask.querySelector('.term-qc-ok') as HTMLButtonElement).onclick = save;
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

/* ---------- React hook：会话生命周期挂在组件上（keep-alive） ---------- */

/**
 * 终端会话生命周期 hook（TerminalTab 内调用）：
 * - 挂载（effect 首次执行）= 会话开始：TermSession 构造（先订阅 term:data/term:exit
 *   再 term_create，避免输出竞态丢失）→ liveTerms 登记 → tabApis.set(tab.id, api)；
 * - 卸载（effect cleanup）= 会话销毁：tabApis.delete → TermSession.destroy
 *   （退订 → 录制中自动停止 → term_close → dispose）；
 * - active false→true 时调 onActivated()（对照旧版 bus 'tab-activated'：fit + 聚焦）。
 * 依赖 [tab.id]：标签重命名（setTabTitle 替换 tab 对象）不重建会话；refs 对象是
 * 稳定的（useRef 返回的引用在组件生命周期内不变），不入依赖。
 */
export function useTerminal(tab: Tab, active: boolean, els: TermElementRefs): void {
  const sessionRef = useRef<TermSession | null>(null);

  useEffect(() => {
    const host = els.host.current;
    const infoCmd = els.infoCmd.current;
    const drawer = els.drawer.current;
    const drawerBody = els.drawerBody.current;
    const drawerToggle = els.drawerToggle.current;
    const drawerClose = els.drawerClose.current;
    const clearBtn = els.clearBtn.current;
    const addChatBtn = els.addChatBtn.current;
    const pinBtn = els.pinBtn.current;
    const recBtn = els.recBtn.current;
    if (!host || !infoCmd || !drawer || !drawerBody || !drawerToggle || !drawerClose || !clearBtn || !addChatBtn || !pinBtn || !recBtn) return;
    const session = new TermSession(tab, { host, infoCmd, drawer, drawerBody, drawerToggle, drawerClose, clearBtn, addChatBtn, pinBtn, recBtn });
    sessionRef.current = session;
    liveTerms.add(session);
    const api: TerminalApi = {
      paste: (cmd) => session.paste(cmd),
      execute: (cmd) => session.execute(cmd),
      takeSnapshot: () => session.takeSnapshot(),
      focus: () => session.focus(),
      ctrlC: () => session.ctrlC(),
    };
    tabApis.set(tab.id, api);
    return () => {
      tabApis.delete(tab.id);
      sessionRef.current = null;
      session.destroy();
    };
    // tab.id 在标签生命周期内稳定;els 的 ref 对象稳定,仅挂载时解析一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  /* keep-alive:active 从 false→true 时(对照旧版 bus 'tab-activated')fit + 聚焦 */
  useEffect(() => {
    if (!active) return;
    sessionRef.current?.onActivated();
  }, [active]);
}
