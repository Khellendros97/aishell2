/**
 * 文件暂存区面板（'remote-staging' 标签）—— 会话级远程文件暂存的可视化（自动备份）。
 * 数据源 staging_list / staging_accept / staging_restore；diff 由 'staging-diff' 标签消费。
 * 接受/还原成功后经 workbench bus 广播 'staging-changed'（已打开的 diff 标签同步刷新）；
 * 切换会话不删除暂存，应用重启仍保留（存储在后端 config_dir/remote-staging）。
 */
import { getState, stagingAccept, stagingList, stagingRestore } from '../../api';
import type { StagedFile } from '../../types';
import { confirmDialog, toast } from '../../ui';
import { icon } from '../../icons';
import { bus, openTab, registerRenderer, type Tab } from './core';
import './staging.css';

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtSize(size: number | null): string {
  if (size == null) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const STATE_LABEL: Record<string, string> = { existing: '存在', absent: '不存在' };

registerRenderer('remote-staging', (container, tab) => {
  const data = tab.data as { projectId: string; sessionId: string };
  let servers: Array<{ id: string; name: string }> = [];
  let entries: StagedFile[] = [];
  let loading = false;
  const selected = new Set<string>();
  let bulkRunning = false;

  const serverName = (id: string): string => servers.find((s) => s.id === id)?.name ?? id;

  container.innerHTML = `
    <div class="staging-panel">
      <div class="staging-head">
        <span class="staging-title">${icon('history')} 文件暂存区 <span class="staging-count" data-staging-count>0</span></span>
        <button class="btn small" data-staging-refresh title="刷新列表">${icon('refresh')} 刷新</button>
      </div>
      <div class="staging-hint">自动备份开启后，AI 会话第一次修改远程文件前自动保存原始快照，同一会话后续修改不覆盖。接受 = 确认本次修改并清除暂存条目（不改远程内容）；还原 = 把远程文件恢复到首次修改前的内容。</div>
      <div class="staging-toolbar" data-staging-toolbar hidden>
        <span class="staging-selected" data-staging-selected>已选择 0 项</span>
        <span class="staging-toolbar-spacer"></span>
        <button class="btn small primary" data-staging-bulk-accept disabled>批量接受</button>
        <button class="btn small" data-staging-bulk-restore disabled>${icon('restore')} 批量还原</button>
      </div>
      <div class="staging-body"><div class="staging-empty">加载中…</div></div>
    </div>
  `;

  const bodyEl = container.querySelector('.staging-body') as HTMLElement;
  const countEl = container.querySelector('[data-staging-count]') as HTMLElement;
  const toolbarEl = container.querySelector('[data-staging-toolbar]') as HTMLElement;
  const selectedEl = container.querySelector('[data-staging-selected]') as HTMLElement;
  const bulkAcceptBtn = container.querySelector('[data-staging-bulk-accept]') as HTMLButtonElement;
  const bulkRestoreBtn = container.querySelector('[data-staging-bulk-restore]') as HTMLButtonElement;

  function updateSelectionUi(): void {
    const count = selected.size;
    countEl.textContent = String(entries.length);
    toolbarEl.hidden = entries.length === 0;
    selectedEl.textContent = count ? `已选择 ${count} 项` : '选择文件后可批量操作';
    bulkAcceptBtn.disabled = count === 0 || bulkRunning;
    bulkRestoreBtn.disabled = count === 0 || bulkRunning;
    const all = bodyEl.querySelector<HTMLInputElement>('[data-staging-select-all]');
    if (all) {
      all.checked = entries.length > 0 && count === entries.length;
      all.indeterminate = count > 0 && count < entries.length;
    }
  }

  function render(): void {
    for (const id of selected) {
      if (!entries.some((entry) => entry.entryId === id)) selected.delete(id);
    }
    if (!entries.length) {
      bodyEl.innerHTML = `<div class="staging-empty">当前会话暂无暂存条目。AI 修改远程文件（run_command 写入 / sftp_upload 覆盖）前会自动保存原始快照。</div>`;
      updateSelectionUi();
      return;
    }
    const rows = entries.map((entry) => {
      const orig = STATE_LABEL[entry.originalState] ?? entry.originalState;
      const cur = STATE_LABEL[entry.currentState] ?? entry.currentState;
      const curCls = entry.currentState === 'absent' ? ' st-absent' : '';
      const name = entry.remotePath.split('/').filter(Boolean).pop() || entry.remotePath;
      return `
        <tr data-entry-id="${escapeHtml(entry.entryId)}" class="${selected.has(entry.entryId) ? 'selected' : ''}">
          <td class="st-select"><input type="checkbox" data-staging-select aria-label="选择 ${escapeHtml(entry.remotePath)}" ${selected.has(entry.entryId) ? 'checked' : ''}></td>
          <td class="st-server">${escapeHtml(serverName(entry.serverId))}</td>
          <td class="st-path" title="${escapeHtml(entry.remotePath)}">${escapeHtml(name)}<span class="st-path-full">${escapeHtml(entry.remotePath)}</span></td>
          <td class="st-time">${fmtTime(entry.stagedAt)}</td>
          <td class="st-orig">${orig}${entry.size != null ? ` · ${fmtSize(entry.size)}` : ''}</td>
          <td class="st-cur${curCls}">${cur}</td>
          <td class="st-actions">
            <button class="btn small" data-staging-diff title="查看首次快照与当前内容差异">${icon('diff')} 比较差异</button>
            <button class="btn small primary" data-staging-accept title="确认本次修改，清除暂存条目（不改远程内容）">接受</button>
            <button class="btn small" data-staging-restore title="把远程文件还原到首次修改前的内容">还原</button>
          </td>
        </tr>`;
    }).join('');
    bodyEl.innerHTML = `
      <table class="staging-table">
        <thead><tr><th class="st-select"><input type="checkbox" data-staging-select-all aria-label="全选暂存文件"></th><th>服务器</th><th>远程路径</th><th>首次快照</th><th>原始状态</th><th>当前状态</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    updateSelectionUi();
  }

  function findRow(target: HTMLElement): HTMLElement | null {
    return target.closest('tr[data-entry-id]');
  }

  async function refresh(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const state = await getState();
      servers = state.servers;
      entries = await stagingList(data.projectId, data.sessionId);
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="staging-empty error">暂存列表加载失败：${escapeHtml(String(err))}</div>`;
    } finally {
      loading = false;
    }
  }

  async function doAccept(entry: StagedFile): Promise<void> {
    const ok = await confirmDialog({
      title: '接受暂存',
      message: `确认本次修改并清除暂存条目？\n${serverName(entry.serverId)}：${entry.remotePath}\n（不改远程内容，只删除本地暂存记录）`,
      okText: '接受',
    });
    if (!ok) return;
    try {
      await stagingAccept(data.projectId, data.sessionId, entry.entryId);
      toast('已接受暂存（清除本地条目）', 'success');
      bus.emit('staging-changed');
      void refresh();
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  async function doRestore(entry: StagedFile, force: boolean): Promise<void> {
    try {
      const out = await stagingRestore(data.projectId, data.sessionId, entry.entryId, force);
      if (out.restored) {
        toast('已还原到首次修改前的内容', 'success');
        bus.emit('staging-changed');
        void refresh();
        return;
      }
      if (out.conflict) {
        const forceOk = await confirmDialog({
          title: '还原冲突',
          message: `远程文件已被外部修改（size=${out.conflict.currentSize ?? '-'}，mtime=${out.conflict.currentMtime ?? '-'}），还原会覆盖这些修改。仍要强制还原？`,
          danger: true,
          okText: '仍要还原',
        });
        if (forceOk) await doRestore(entry, true);
        return;
      }
      toast('还原失败：暂存状态异常', 'error');
    } catch (err) {
      toast(String(err), 'error');
    }
  }
  async function doBulkAccept(): Promise<void> {
    const targets = entries.filter((entry) => selected.has(entry.entryId));
    if (!targets.length || bulkRunning) return;
    const ok = await confirmDialog({
      title: '批量接受暂存',
      message: `确认接受选中的 ${targets.length} 个文件修改？\n这只会清除本地暂存记录，不会修改远程文件。`,
      okText: `接受 ${targets.length} 项`,
    });
    if (!ok) return;
    bulkRunning = true;
    updateSelectionUi();
    let accepted = 0;
    for (const entry of targets) {
      try {
        await stagingAccept(data.projectId, data.sessionId, entry.entryId);
        accepted++;
      } catch { /* 继续处理其余条目，结束后统一报告 */ }
    }
    bulkRunning = false;
    const failed = targets.length - accepted;
    if (failed) toast(`已接受 ${accepted} 项，${failed} 项失败`, 'error');
    else toast(`已接受 ${accepted} 项暂存修改`, 'success');
    selected.clear();
    bus.emit('staging-changed');
    void refresh();
  }

  async function doBulkRestore(): Promise<void> {
    const targets = entries.filter((entry) => selected.has(entry.entryId));
    if (!targets.length || bulkRunning) return;
    const ok = await confirmDialog({
      title: '批量还原暂存',
      message: `把选中的 ${targets.length} 个远程文件还原到首次修改前？\n当前修改将丢失；检测到外部修改的文件会跳过，不会强制覆盖。`,
      danger: true,
      okText: `还原 ${targets.length} 项`,
    });
    if (!ok) return;
    bulkRunning = true;
    updateSelectionUi();
    let restored = 0;
    let conflicts = 0;
    let failed = 0;
    for (const entry of targets) {
      try {
        const result = await stagingRestore(data.projectId, data.sessionId, entry.entryId, false);
        if (result.restored) restored++;
        else if (result.conflict) conflicts++;
        else failed++;
      } catch {
        failed++;
      }
    }
    bulkRunning = false;
    if (conflicts || failed) toast(`已还原 ${restored} 项；${conflicts} 项冲突、${failed} 项失败`, 'error');
    else toast(`已还原 ${restored} 个远程文件`, 'success');
    selected.clear();
    bus.emit('staging-changed');
    void refresh();
  }

  bodyEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const row = findRow(btn as HTMLElement);
    const entry = row ? entries.find((x) => x.entryId === row.dataset.entryId) : undefined;
    if (!entry) return;
    if (btn.hasAttribute('data-staging-diff')) {
      openTab({
        id: `staging-diff:${data.projectId}:${data.sessionId}:${entry.entryId}`,
        type: 'staging-diff',
        title: entry.remotePath.split('/').filter(Boolean).pop() || entry.remotePath,
        data: { projectId: data.projectId, sessionId: data.sessionId, entryId: entry.entryId },
      });
    } else if (btn.hasAttribute('data-staging-accept')) {
      void doAccept(entry);
    } else if (btn.hasAttribute('data-staging-restore')) {
      void confirmDialog({
        title: '确认还原',
        message: `把远程文件还原到首次修改前的内容？\n${serverName(entry.serverId)}：${entry.remotePath}\n还原后当前修改将丢失（外部修改冲突会另行提示）`,
        danger: true,
        okText: '还原',
      }).then((ok) => { if (ok) void doRestore(entry, false); });
    }
  });
  bodyEl.addEventListener('change', (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('input[type="checkbox"]');
    if (!input) return;
    if (input.hasAttribute('data-staging-select-all')) {
      selected.clear();
      if (input.checked) entries.forEach((entry) => selected.add(entry.entryId));
      render();
      return;
    }
    if (!input.hasAttribute('data-staging-select')) return;
    const row = findRow(input);
    if (!row?.dataset.entryId) return;
    if (input.checked) selected.add(row.dataset.entryId);
    else selected.delete(row.dataset.entryId);
    row.classList.toggle('selected', input.checked);
    updateSelectionUi();
  });

  container.querySelector('[data-staging-refresh]')!.addEventListener('click', () => void refresh());
  bulkAcceptBtn.addEventListener('click', () => void doBulkAccept());
  bulkRestoreBtn.addEventListener('click', () => void doBulkRestore());
  // 双击行打开 diff
  bodyEl.addEventListener('dblclick', (e) => {
    const row = findRow(e.target as HTMLElement);
    const entry = row ? entries.find((x) => x.entryId === row.dataset.entryId) : undefined;
    if (!entry) return;
    openTab({
      id: `staging-diff:${data.projectId}:${data.sessionId}:${entry.entryId}`,
      type: 'staging-diff',
      title: entry.remotePath.split('/').filter(Boolean).pop() || entry.remotePath,
      data: { projectId: data.projectId, sessionId: data.sessionId, entryId: entry.entryId },
    });
  });

  // AI 工具完成 / 其他面板操作后广播刷新；标签关闭时反注册监听
  const offStaging = bus.on('staging-changed', () => { if (container.isConnected) void refresh(); });
  const origOnClose = tab.onClose;
  tab.onClose = (t: Tab): void => {
    offStaging();
    origOnClose?.(t);
  };

  void refresh();
});
