/**
 * AI 申请数据库连接的审批对话框（request_db_connection 工具，见 aishell-guard.ts / ai.rs
 * AISHELL_DB_REQUEST 通道 / ai.ts 审批卡片）。
 * 交互契约（需求规格）：AI 填写的连接信息（类型/主机/端口/用户/默认库等）只读不可编辑，
 * 用户只需填密码并勾选查询权限；关闭（X / 点遮罩 / Esc）不产生任何回执——审批卡片保持
 * 「等待批准」，可随时再次点击【审批】重新打开（用户可能去查密码，不得自动拒绝）。
 * 样式复用 servers.css 的 .db-cmds 与全局 .server-form-grid/.modal（servers.css 随侧栏
 * 面板全局加载，仓库已有跨文件复用先例：skills.css / mcp.css）。
 */
import { icon } from '../../icons';
import { toast } from '../../ui';
import type { DbConnection, DbKind } from '../../types';
import { DB_COMMAND_GROUPS, DB_DEFAULT_PORTS, DB_KIND_LABEL } from './db';

/** AI 提交的数据库连接申请信息（与 ai.rs 透传的 approval.connection 对齐） */
export interface DbRequestDetail {
  serverId: string;
  name: string;
  kind: DbKind;
  host: string;
  port?: number;
  user?: string;
  database?: string;
}

/** 已打开的审批对话框（防重复打开：同一时刻只允许一个实例，关闭后置 null） */
let activeModal: { close: () => void } | null = null;

/** 打开审批对话框。
 *  - onApprove 返回 Promise：true = 已保存并回执成功（关闭弹窗）；false = 失败（弹窗保留可重试）；
 *  - onReject 同步回调后关闭；
 *  - 关闭（X/遮罩/Esc）不触发任何回调。 */
export function openAiDbApprovalModal(opts: {
  serverName: string;
  serverLocked: boolean;
  detail: DbRequestDetail;
  onApprove: (connection: DbConnection, password: string) => Promise<boolean>;
  onReject: () => void;
}): void {
  if (activeModal) return;
  const { detail } = opts;
  const dbName = detail.database || detail.name;
  const port = detail.port ?? DB_DEFAULT_PORTS[detail.kind];
  const isRedis = detail.kind === 'redis';

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const root = document.createElement('div');
  root.className = 'modal';
  root.style.width = '540px';
  mask.appendChild(root);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  /** 静默关闭：不回复 pi、不触发回调（审批卡片保持待批，可重新打开） */
  const close = (): void => {
    if (activeModal !== modal) return;
    activeModal = null;
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
    window.removeEventListener('keydown', onKeydown);
  };
  const modal: { close: () => void } = { close };
  activeModal = modal;
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('keydown', onKeydown);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

  /* AI 信息完整性预检：不完整时「通过」禁用（连接信息只读，只能拒绝后让 AI 补充） */
  const problems: string[] = [];
  if (!detail.name.trim()) problems.push('名称');
  if (!detail.host.trim()) problems.push('主机');
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('端口');
  if (!isRedis && !(detail.user ?? '').trim()) problems.push('用户名');
  const incomplete = problems.length > 0;

  root.innerHTML = `
    <div class="modal-head">
      <h3>数据库连接审批</h3>
      <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="db-approval-tip">${icon('database')}AI 助手想要申请连接数据库 <b>${esc(dbName)}</b> 的权限</div>
      <div class="server-form-grid">
        <div class="field"><label>类型</label>
          <input class="input" disabled value="${DB_KIND_LABEL[detail.kind]}"></div>
        <div class="field"><label>连接名称</label>
          <input class="input" disabled value="${esc(detail.name)}"></div>
        <div class="field"><label>主机</label>
          <input class="input mono" disabled value="${esc(detail.host)}"></div>
        <div class="field"><label>端口</label>
          <input class="input mono" disabled value="${port}"></div>
        <div class="field"><label>用户名</label>
          <input class="input mono" disabled value="${isRedis ? '—' : esc(detail.user ?? '')}"></div>
        <div class="field"><label>默认库</label>
          <input class="input mono" disabled value="${isRedis || !detail.database ? '—' : esc(detail.database)}"></div>
        <div class="field db-cmds-field"><label>目标服务器</label>
          <input class="input" disabled value="${esc(opts.serverName)}（${esc(detail.serverId)}）"></div>
        <div class="field db-cmds-field"><label>密码<span class="req">*</span></label>
          <input class="input mono" data-f="password" type="password" placeholder="请输入数据库密码（保存在系统凭据库，AI 不可见）" autocomplete="off"></div>
        <div class="field db-cmds-field"><label>查询权限</label>
          <div class="db-cmds" data-cmds></div>
          <div class="hint">只读命令 AI 可直接执行；勾选写命令后，AI 执行前需人工审批。</div>
        </div>
      </div>
      ${opts.serverLocked ? '<div class="db-approval-warn">' + icon('alert') + '该服务器已锁定（AI 操作锁），批准后 AI 暂时无法执行查询。</div>' : ''}
      ${incomplete ? '<div class="db-approval-warn">' + icon('alert') + 'AI 填写的连接信息不完整（缺：' + esc(problems.join('、')) + '）。连接信息只读不可修改，请点「拒绝」并告知 AI 补充。</div>' : ''}
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="reject">拒绝</button>
      <button class="btn primary" data-act="approve"${incomplete ? ' disabled' : ''}>通过</button>
    </div>`;

  root.querySelector('[data-act=close]')?.addEventListener('click', close);

  /* 命令勾选区：初始勾选该类型默认只读集（与服务器设置表单同源） */
  const cmdsBox = root.querySelector('[data-cmds]') as HTMLElement;
  cmdsBox.innerHTML = DB_COMMAND_GROUPS[detail.kind].map((g) => `
    <div class="db-cmds-group">
      <div class="db-cmds-title">${g.title}</div>
      <div class="db-cmds-grid${g.write ? ' write' : ''}">${g.commands.map((cmd) => `
        <label class="db-cmd"><input type="checkbox" value="${cmd}"${!g.write ? ' checked' : ''}>${cmd}</label>`).join('')}
      </div>
    </div>`).join('');

  root.querySelector('[data-act=reject]')?.addEventListener('click', () => {
    opts.onReject();
    close();
  });

  /* 防重复提交：保存+回执期间禁用「通过」，失败后恢复 */
  let submitting = false;
  root.querySelector('[data-act=approve]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled || submitting) return;
    submitting = true;
    btn.disabled = true;
    const password = (root.querySelector('[data-f=password]') as HTMLInputElement).value;
    if (!password) {
      submitting = false;
      btn.disabled = incomplete;
      (root.querySelector('[data-f=password]') as HTMLInputElement).focus();
      toast('请填写数据库密码', 'error');
      return;
    }
    const commands = [...cmdsBox.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((el) => el.value);
    if (!commands.length) {
      submitting = false;
      btn.disabled = incomplete;
      toast('请至少勾选一条查询权限', 'error');
      return;
    }
    const connection: DbConnection = {
      id: uid('dbc'),
      name: detail.name.trim(),
      kind: detail.kind,
      host: detail.host.trim(),
      port,
      user: isRedis ? '' : (detail.user ?? '').trim(),
      database: isRedis ? '' : (detail.database ?? '').trim(),
      allowedCommands: commands,
      enabled: true,
    };
    const ok = await opts.onApprove(connection, password);
    submitting = false;
    btn.disabled = incomplete;
    if (ok) close();
  });
}

const esc = (s: string | number): string =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
