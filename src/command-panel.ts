/**
 * 命令面板：Ctrl+T 全局唤起，界面顶部命令输入框（仿 VS Code Command Palette）。
 * 命令表按空白分词匹配，可扩展；危险命令执行前弹确认框。
 * 命令执行导致数据变化时广播 `aishell:data-changed`（CustomEvent），
 * 各页面监听后重新拉取状态渲染（settings / welcome / 侧栏 servers）。
 */
import { clearAllServers, traceSetEnabled } from './api';
import { confirmDialog, toast } from './ui';
import { icon } from './icons';
import { toggleDebugPanel } from './debug';

interface PanelCommand {
  usage: string;                              // 命令用法（提示区展示）
  desc: string;                               // 命令说明
  match: (tokens: string[]) => boolean;       // 按分词精确匹配
  run: () => Promise<void> | void;
}

const COMMANDS: PanelCommand[] = [
  {
    usage: 'debug',
    desc: '打开/关闭 Debug 日志面板（终端事件流实时输出，支持暂停/清空/复制/导出）',
    match: (t) => t.length === 1 && t[0] === 'debug',
    run: () => toggleDebugPanel(),
  },
  {
    usage: 'trace on',
    desc: '开启 AI 会话 trace（逐会话记录用户输入/pi 事件流/工具调用/门禁/标题生成，保留 7 天；AI 对话区右键「追溯」查看）',
    match: (t) => t.length === 2 && t[0] === 'trace' && t[1] === 'on',
    run: () => setTrace(true),
  },
  {
    usage: 'trace off',
    desc: '关闭 AI 会话 trace（历史日志保留，到期自动清理）',
    match: (t) => t.length === 2 && t[0] === 'trace' && t[1] === 'off',
    run: () => setTrace(false),
  },
  {
    usage: 'server config clear',
    desc: '清除所有服务器配置（凭据库保留，所有项目解绑）',
    match: (t) =>
      t.length === 3 && t[0] === 'server' && t[1] === 'config' && t[2] === 'clear',
    run: async () => {
      const ok = await confirmDialog({
        title: '清除所有服务器配置',
        message: '将删除全部服务器并解除所有项目绑定；凭据库中的登录信息会保留，可用于后续重新绑定。此操作不可恢复，确定继续吗？',
        danger: true,
        okText: '清除',
      });
      if (!ok) return;
      try {
        await clearAllServers();
        toast('已清除所有服务器配置', 'success');
        window.dispatchEvent(new CustomEvent('aishell:data-changed'));
      } catch (err) {
        toast(`清除失败: ${String(err)}`, 'error');
      }
    },
  },
];

let panelEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let errorEl: HTMLElement | null = null;

/** trace on/off 共用：开关落库（AppState.traceEnabled）后广播 data-changed 刷新 AI 右键菜单 */
async function setTrace(enabled: boolean): Promise<void> {
  try {
    await traceSetEnabled(enabled);
    toast(enabled ? '已开启 AI 会话 trace' : '已关闭 AI 会话 trace', 'success');
    window.dispatchEvent(new CustomEvent('aishell:data-changed'));
  } catch (err) {
    toast(`trace 开关失败: ${String(err)}`, 'error');
  }
}

/** 应用入口调用一次：挂载面板 DOM 与 Ctrl+T / Esc / 外部点击交互 */
export function initCommandPanel(): void {
  if (panelEl) return;
  panelEl = document.createElement('div');
  panelEl.id = 'cmd-panel';
  panelEl.className = 'cmd-panel hidden';
  panelEl.innerHTML = `
    <div class="cmd-row">
      <span class="cmd-prompt">${icon('terminal')}</span>
      <input id="cmd-input" class="input" placeholder="输入命令，回车执行" spellcheck="false" autocomplete="off">
      <span class="cmd-esc">Esc 关闭</span>
    </div>
    <div class="cmd-hints">
      ${COMMANDS.map((c) => `<div class="cmd-hint"><code>${c.usage}</code><span>${c.desc}</span></div>`).join('')}
    </div>
    <div class="cmd-error hidden" id="cmd-error"></div>
  `;
  document.body.appendChild(panelEl);
  inputEl = panelEl.querySelector('#cmd-input') as HTMLInputElement;
  errorEl = panelEl.querySelector('#cmd-error') as HTMLElement;

  const isOpen = () => !panelEl!.classList.contains('hidden');
  const open = () => {
    panelEl!.classList.remove('hidden');
    inputEl!.value = '';
    errorEl!.classList.add('hidden');
    inputEl!.focus();
  };
  const close = () => panelEl!.classList.add('hidden');

  // Ctrl+T / Ctrl+P 全局唤起/收起：capture 阶段先行，避免被终端等输入处理吞掉
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 't' || e.key.toLowerCase() === 'p')) {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen()) close();
      else open();
    }
  }, true);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // 防止冒泡触发模态框的 Esc 关闭
      close();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tokens = inputEl!.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    const cmd = COMMANDS.find((c) => c.match(tokens));
    if (!cmd) {
      errorEl!.textContent = `未知命令：${inputEl!.value.trim()}`;
      errorEl!.classList.remove('hidden');
      return;
    }
    close();
    void cmd.run();
  });

  // 点击面板外部关闭
  document.addEventListener('mousedown', (e) => {
    if (isOpen() && !panelEl!.contains(e.target as Node)) close();
  });
}
