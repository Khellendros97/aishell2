/**
 * AI 申请数据库连接的审批对话框（request_db_connection 工具，见 aishell-guard.ts / ai.rs
 * AISHELL_DB_REQUEST 通道 / ai.ts 审批卡片）。
 * 对照 legacy/pages/workbench/ai-db-approval.ts 移植（React 迁移）；命令式模态（自包含
 * DOM，不经 React 受控状态），导出签名与 legacy 一致（openAiDbApprovalModal /
 * DbRequestDetail，由 ai-engine.ts 消费）。
 * 交互契约（v2）：AI 预填的连接信息（类型/名称/主机/端口/用户/默认库）均可编辑——AI 可能
 * 填错，用户改好后再填密码批准；目标服务器只读（审批对象本身，serverId 由调用方固定）。
 * 类型切换联动：端口仍为旧类型默认（或空）时更新为新默认；命令勾选区按新类型重建；
 * Redis 无用户名/默认库（禁用显示「—」）。校验在点「通过」时按当前字段值进行，出错
 * toast 并聚焦对应字段。关闭（X / 点遮罩 / Esc）不产生任何回执——审批卡片保持
 * 「等待批准」，可随时再次点击【审批】重新打开（用户可能去查密码，不得自动拒绝）。
 * 与后端的接口点：无（回调由调用方 ai-engine.ts 接后端 save_db_connection / ai_respond_db_request）。
 * 样式复用 servers.css 的 .db-cmds 与全局 .server-form-grid/.modal（servers.css 随侧栏
 * 面板全局加载，仓库已有跨文件复用先例：skills.css / mcp.css）。
 */
import { icon } from '../../../icons';
import { toast } from '../../../ui';
import type { DbConnection, DbKind } from '../../../types';
import { DB_COMMAND_GROUPS, DB_DEFAULT_PORTS, DB_KIND_LABEL } from '../db';

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

const DB_KINDS = Object.keys(DB_KIND_LABEL) as DbKind[];

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

  const kindOptions = DB_KINDS.map((k) =>
    `<option value="${k}"${k === detail.kind ? ' selected' : ''}>${DB_KIND_LABEL[k]}</option>`).join('');

  root.innerHTML = `
    <div class="modal-head">
      <h3>数据库连接审批</h3>
      <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="db-approval-tip">${icon('database')}AI 助手想要申请连接数据库 <b>${esc(dbName)}</b> 的权限</div>
      <div class="server-form-grid">
        <div class="field"><label>类型</label>
          <select class="select" data-f="kind">${kindOptions}</select></div>
        <div class="field"><label>连接名称</label>
          <input class="input" data-f="name" value="${esc(detail.name)}"></div>
        <div class="field"><label>主机</label>
          <input class="input mono" data-f="host" value="${esc(detail.host)}"></div>
        <div class="field"><label>端口</label>
          <input class="input mono" data-f="port" inputmode="numeric" value="${esc(detail.port ?? DB_DEFAULT_PORTS[detail.kind])}"></div>
        <div class="field"><label>用户名</label>
          <input class="input mono" data-f="user" ${isRedis ? 'disabled value="—"' : `value="${esc(detail.user ?? '')}"`}></div>
        <div class="field"><label>默认库</label>
          <input class="input mono" data-f="database" ${isRedis || !detail.database ? `disabled value="—"` : `value="${esc(detail.database)}"`}></div>
        <div class="field db-cmds-field"><label>目标服务器</label>
          <input class="input" disabled value="${esc(opts.serverName)}（${esc(detail.serverId)}）"></div>
        <div class="field db-cmds-field"><label>密码${isRedis ? '' : '<span class="req">*</span>'}</label>
          <input class="input mono" data-f="password" type="password" placeholder="${isRedis ? '无密码实例可留空' : '请输入数据库密码'}（保存在系统凭据库，AI 不可见）" autocomplete="off"></div>
        <div class="field db-cmds-field"><label>查询权限</label>
          <div class="db-cmds" data-cmds></div>
          <div class="hint">只读命令 AI 可直接执行；勾选写命令后，AI 执行前需人工审批。</div>
        </div>
      </div>
      <div class="hint" style="margin-top:8px">连接信息由 AI 预填，填错可直接修改；改好后输入密码点「通过」。</div>
      ${opts.serverLocked ? '<div class="db-approval-warn">' + icon('alert') + '该服务器已锁定（AI 操作锁），批准后 AI 暂时无法执行查询。</div>' : ''}
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="reject">拒绝</button>
      <button class="btn primary" data-act="approve">通过</button>
    </div>`;

  root.querySelector('[data-act=close]')?.addEventListener('click', close);

  const fieldEl = (name: string): HTMLInputElement | HTMLSelectElement =>
    root.querySelector(`[data-f=${name}]`) as HTMLInputElement | HTMLSelectElement;

  /* 命令勾选区：按类型渲染默认只读集（与服务器设置表单同源）；类型切换时重建 */
  const cmdsBox = root.querySelector('[data-cmds]') as HTMLElement;
  const renderCmds = (kind: DbKind): void => {
    cmdsBox.innerHTML = DB_COMMAND_GROUPS[kind].map((g) => `
      <div class="db-cmds-group">
        <div class="db-cmds-title">${g.title}</div>
        <div class="db-cmds-grid${g.write ? ' write' : ''}">${g.commands.map((cmd) => `
          <label class="db-cmd"><input type="checkbox" value="${cmd}"${!g.write ? ' checked' : ''}>${cmd}</label>`).join('')}
        </div>
      </div>`).join('');
  };
  renderCmds(detail.kind);

  /* 类型切换联动（语义同服务器设置表单）：端口仍为旧默认（或空）则更新为新默认；
     Redis 无用户名/默认库（禁用显示「—」），切回时恢复原值；命令勾选区按新类型重建。
     当前类型记录在本地 curKind，不突变调用方传入的 detail 对象 */
  let curKind: DbKind = detail.kind;
  const kindEl = fieldEl('kind') as HTMLSelectElement;
  kindEl.addEventListener('change', () => {
    const prevKind = curKind;
    const nextKind = kindEl.value as DbKind;
    if (nextKind === prevKind) return;
    const portEl = fieldEl('port');
    const curPort = Number(portEl.value);
    if (!portEl.value.trim() || curPort === DB_DEFAULT_PORTS[prevKind]) {
      portEl.value = String(DB_DEFAULT_PORTS[nextKind]);
    }
    const isNextRedis = nextKind === 'redis';
    const userEl = fieldEl('user');
    const dbEl = fieldEl('database');
    for (const [el, original] of [[userEl, detail.user ?? ''], [dbEl, detail.database ?? '']] as const) {
      if (isNextRedis) {
        el.disabled = true;
        el.value = '—';
      } else {
        el.disabled = false;
        el.value = el.value === '—' ? original : el.value;
      }
    }
    curKind = nextKind;
    renderCmds(nextKind);
  });

  root.querySelector('[data-act=reject]')?.addEventListener('click', () => {
    opts.onReject();
    close();
  });

  /* 批准前校验（按当前字段值）：AI 预填可能缺失/错误，用户可就地修改后通过。
     focus 为 data-f 字段名；'commands' 表示聚焦命令勾选区（无 data-f 字段）。 */
  const validate = (): { connection: DbConnection; password: string } | { error: string; focus: string } => {
    const kind = (fieldEl('kind') as HTMLSelectElement).value as DbKind;
    const isRedisKind = kind === 'redis';
    const name = (fieldEl('name') as HTMLInputElement).value.trim();
    const host = (fieldEl('host') as HTMLInputElement).value.trim();
    const port = Number(fieldEl('port').value.trim());
    const user = (fieldEl('user') as HTMLInputElement).value.trim();
    const database = (fieldEl('database') as HTMLInputElement).value.trim();
    const password = (fieldEl('password') as HTMLInputElement).value;
    if (!name) return { error: '请填写连接名称', focus: 'name' };
    if (!host) return { error: '请填写主机', focus: 'host' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: '端口须为 1-65535 的整数', focus: 'port' };
    if (!isRedisKind && !user) return { error: '请填写用户名', focus: 'user' };
    if (!password && !isRedisKind) return { error: '请填写数据库密码', focus: 'password' };
    const commands = [...cmdsBox.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((el) => el.value);
    if (!commands.length) return { error: '请至少勾选一条查询权限', focus: 'commands' };
    return {
      connection: {
        id: uid('dbc'),
        name,
        kind,
        host,
        port,
        user: isRedisKind ? '' : user,
        database: isRedisKind ? '' : database,
        allowedCommands: commands,
        enabled: true,
      },
      password,
    };
  };
  const focusField = (name: string): void => {
    if (name === 'commands') cmdsBox.querySelector<HTMLInputElement>('input[type=checkbox]')?.focus();
    else fieldEl(name).focus();
  };

  /* 防重复提交：保存+回执期间禁用「通过」，失败后恢复 */
  let submitting = false;
  root.querySelector('[data-act=approve]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled || submitting) return;
    const result = validate();
    if ('error' in result) {
      focusField(result.focus);
      toast(result.error, 'error');
      return;
    }
    submitting = true;
    btn.disabled = true;
    const ok = await opts.onApprove(result.connection, result.password);
    submitting = false;
    btn.disabled = false;
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
