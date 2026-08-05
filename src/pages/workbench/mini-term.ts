/**
 * SFTP 面板迷你终端悬浮窗 —— 空白区右键「打开终端」入口的轻量 SSH 终端。
 * 复用 term_create('ssh', serverId, cwd) 后端链路：登录后自动 cd 到当前 SFTP 目录。
 * 支持：
 * - 拖拽标题栏移动悬浮窗（pointer 事件 + setPointerCapture）
 * - autoRun：打开后自动执行命令（压缩/解压等），输出含随机完成标记后回调 onDone
 *   —— 发送前 stty -echo 抑制命令回显，标记带 `:$?` 退出码（`:0` 成功），不受回显干扰
 * - onClose：destroy 时回调（供调用方把持有引用置空，解决「关闭后无法再打开」）
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { UnlistenFn } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';

import { onTermData, onTermExit, termClose, termCreate, termInput, termResize } from '../../api';
import { icon } from '../../icons';
import { copyText, showContextMenu, toast, uid } from '../../ui';

/** 配色与 terminal.ts 暗色主题一致（迷你终端固定暗色，悬浮层不跟随亮色主题） */
const MINI_THEME = {
  background: '#0d1117', foreground: '#e6edf3', cursor: '#4f8ef7',
  selectionBackground: 'rgba(79, 142, 247, 0.35)',
  black: '#0d1117', red: '#e5626a', green: '#4ec98a', yellow: '#e5c07b',
  blue: '#4f8ef7', magenta: '#b687e8', cyan: '#56b6c2', white: '#c9d1d9',
  brightBlack: '#8b93a5', brightRed: '#ff7b72', brightGreen: '#7ee2a8',
  brightYellow: '#f2cc60', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd', brightWhite: '#ffffff',
};

export interface MiniTermAutoRun {
  /** 要在终端内执行的 shell 命令（不含完成标记） */
  command: string;
  /** 命令执行结束（含失败）回调，参数为退出码是否为 0 */
  onDone: (success: boolean) => void;
}

export interface MiniTermOptions {
  /** destroy 时回调一次（调用方据此清空持有引用） */
  onClose?: () => void;
  /** 打开就绪后自动执行命令并在完成时回调 */
  autoRun?: MiniTermAutoRun;
}

export interface MiniTerm {
  destroy(): void;
}

/** 生成唯一完成标记（防与终端既有输出误匹配） */
function doneLabel(): string {
  return `__AISHELL_DONE_${Math.random().toString(36).slice(2, 10)}__`;
}

/** 在 host（.sf-root）内创建悬浮迷你终端；serverId 为 SSH 会话，cwd 为登录后自动 cd 的目标目录。 */
export function openMiniTerm(host: HTMLElement, serverId: string, cwd: string, opts: MiniTermOptions = {}): MiniTerm {
  const id = uid('mini-term');

  const root = document.createElement('div');
  root.className = 'mini-term';
  const head = document.createElement('div');
  head.className = 'mini-term-head';
  const title = document.createElement('span');
  title.className = 'mini-term-title';
  title.textContent = '迷你终端';
  const cwdEl = document.createElement('span');
  cwdEl.className = 'mini-term-cwd';
  cwdEl.textContent = cwd;
  cwdEl.title = cwd;
  const close = document.createElement('button');
  close.className = 'icon-btn mini-term-close';
  close.title = '关闭终端';
  close.innerHTML = icon('x');
  head.appendChild(title);
  head.appendChild(cwdEl);
  head.appendChild(close);
  const body = document.createElement('div');
  body.className = 'mini-term-body';
  root.appendChild(head);
  root.appendChild(body);
  host.appendChild(root);

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: 2000,
    theme: MINI_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(body);

  const unlisteners: UnlistenFn[] = [];
  let destroyed = false;

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    unlisteners.forEach((u) => { try { u(); } catch { /* 忽略退订异常 */ } });
    void termClose(id).catch(() => {});
    try { term.dispose(); } catch { /* 忽略 dispose 异常 */ }
    root.remove();
    opts.onClose?.();
  };
  close.addEventListener('click', destroy);

  term.onData((data) => { void termInput(id, data); });

  /* 自定义右键菜单（原生菜单已全局禁用）：复制 / 粘贴 */
  body.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: '复制', iconName: 'copy', disabled: !term.hasSelection(), action: () => copySelection() },
      { label: '粘贴', iconName: 'clipboard', action: () => void pasteClipboard() },
    ]);
  });
  /* Ctrl+Shift+C 复制选区 / Ctrl+Shift+V 粘贴 */
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      copySelection();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      void pasteClipboard();
      return false;
    }
    return true;
  });
  const copySelection = (): void => {
    const sel = term.getSelection();
    if (sel) void copyText(sel);
  };
  const pasteClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch { /* 剪贴板读取失败（权限等）静默 */ }
  };
  const fitTerm = (): void => {
    if (destroyed) return;
    try {
      fit.fit();
      void termResize(id, term.cols, term.rows);
    } catch { /* 隐藏时 fit 可能抛错，忽略 */ }
  };
  const resizer = new ResizeObserver(fitTerm);
  resizer.observe(body);

  /* ---------- 标题栏拖拽移动（pointer capture，拖动中关闭按钮不可点） ---------- */
  let dragStartX = 0;
  let dragStartY = 0;
  let dragging = false;
  const onDragDown = (e: PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.mini-term-close')) return;
    const hostRect = host.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    // CSS 仅 right/bottom 定位时 offsetLeft/offsetTop 为 0（left 解析值 auto）——
    // 用布局坐标换算相对 host 的位置，并显式化 left/top 保证后续拖动一致
    const baseX = rootRect.left - hostRect.left;
    const baseY = rootRect.top - hostRect.top;
    if (!root.style.left) root.style.left = `${baseX}px`;
    if (!root.style.top) root.style.top = `${baseY}px`;
    dragging = true;
    // 抓取偏移用 viewport 绝对坐标差（move 公式为 e.clientX - hostLeft - dragStartX）
    dragStartX = e.clientX - rootRect.left;
    dragStartY = e.clientY - rootRect.top;
    (window as unknown as Record<string, unknown>).__lastDrag = {
      downX: e.clientX, rootLeft: rootRect.left, hostLeft: hostRect.left, dragStartX,
    };
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onDragMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const hostRect = host.getBoundingClientRect();
    const maxX = hostRect.width - root.offsetWidth;
    const maxY = hostRect.height - root.offsetHeight;
    root.style.left = Math.max(0, Math.min(maxX, e.clientX - hostRect.left - dragStartX)) + 'px';
    root.style.top = Math.max(0, Math.min(maxY, e.clientY - hostRect.top - dragStartY)) + 'px';
  };
  const onDragUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try { head.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
  };
  head.addEventListener('pointerdown', onDragDown);
  head.addEventListener('pointermove', onDragMove);
  head.addEventListener('pointerup', onDragUp);

  /* ---------- 初始化：先订阅事件、再创建后端（避免输出竞态丢失） ---------- */
  let autoBuf = '';
  let auto: MiniTermAutoRun | null = opts.autoRun ?? null;
  // 完成标记必须在订阅前生成：termCreate 期间 MOTD 已在输出（如时间 04:25:40 含 :25），
  // 空标记会使正则退化为 /:(\d+)/ 误匹配 MOTD → onDone(false) 提前触发且命令不再发送
  let autoLabel = auto ? doneLabel() : '';

  void (async () => {
    try {
      unlisteners.push(await onTermData(id, (d) => {
        if (destroyed) return;
        term.write(d);
        if (!auto || !autoLabel) return;
        autoBuf += d;
        if (autoBuf.length > 8192) autoBuf = autoBuf.slice(-2048);
        const m = autoBuf.match(new RegExp(`${autoLabel}:(\\d+)`));
        if (m) {
          const run = auto;
          auto = null;
          autoBuf = '';
          run.onDone(m[1] === '0');
        }
      }));
      unlisteners.push(await onTermExit(id, () => { /* 远端退出：保留显示，由关闭按钮清理 */ }));
      await termCreate(id, 'ssh', serverId, cwd);
      fitTerm();
      term.focus();
      if (auto) {
        // 抑制命令回显（否则回显中的标记会误触发完成判定），命令尾带退出码标记
        const payload = `stty -echo\r${auto.command}; echo ${autoLabel}:$?\rstty echo\r`;
        void termInput(id, payload);
      }
    } catch (err) {
      toast(String(err), 'error');
      term.write(`\r\n\x1b[31m[启动失败] ${String(err)}\x1b[0m\r\n`);
    }
  })();

  return { destroy };
}
