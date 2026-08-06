/**
 * 命令面板：Ctrl+T 全局唤起，界面顶部命令输入框（仿 VS Code Command Palette）。
 * 命令表按空白分词匹配，可扩展；危险命令执行前弹确认框。
 * 命令执行导致数据变化时广播 `aishell:data-changed`（CustomEvent），
 * 各页面监听后重新拉取状态渲染（settings / welcome / 侧栏 servers）。
 */
import { clearAllServers } from './api';
import { confirmDialog, toast } from './ui';
import { icon } from './icons';

interface PanelCommand {
  usage: string;                              // 命令用法（提示区展示）
  desc: string;                               // 命令说明
  match: (tokens: string[]) => boolean;       // 按分词精确匹配
  run: () => Promise<void> | void;
}

const COMMANDS: PanelCommand[] = [
  {
    usage: 'server config clear',
    desc: '清除所有服务器配置（服务器、分类目录、已保存的密码/密钥，所有项目解绑）',
    match: (t) =>
      t.length === 3 && t[0] === 'server' && t[1] === 'config' && t[2] === 'clear',
    run: async () => {
      const ok = await confirmDialog({
        title: '清除所有服务器配置',
        message: '将删除全部服务器、分类目录及已保存的密码/密钥，所有项目与服务器的绑定关系一并解除。此操作不可恢复，确定继续吗？',
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

  // Ctrl+T 全局唤起/收起：capture 阶段先行，避免被终端等输入处理吞掉
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
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
