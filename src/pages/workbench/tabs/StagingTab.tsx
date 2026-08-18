/**
 * 文件暂存区面板('remote-staging' 标签,React 版,整文件替换占位)。
 * 对照 legacy/pages/workbench/staging.ts(310 行)逐条迁移 DOM 类名 / 交互 / 文案:
 * - 会话级远程文件暂存的可视化(自动备份):AI 会话第一次修改远程文件前自动保存原始快照,
 *   接受 = 确认本次修改并清除暂存条目(不改远程内容);还原 = 恢复首次修改前内容;
 *   清理 = 远端现状与首次快照一致的条目一次性接受清除(有变更的保留,后端 staging_clear);
 * - 数据源 staging_list / staging_accept / staging_restore(接口点见 src/api.ts staging 段);
 *   服务器名从 getState().servers 查(找不到回退 id);
 * - keep-alive:组件常驻挂载,active 仅切显隐(由外壳 .tab-pane.active 承担,本组件不消费);
 *   数据订阅(initial 刷新 + wbEvents 'staging-changed')在挂载时建立、卸载时经
 *   useEffect return 清理;接受/还原成功后 wbEvents.emit('staging-changed')(已打开的
 *   'staging-diff' 标签据此同步刷新);diff 标签打开走 useWorkbench().openTab;
 * - 切换会话不删除暂存,应用重启仍保留(存储在后端 config_dir/remote-staging)。
 * 相对 legacy 的修复:载入加序号守卫,快速连续刷新(手动点击 + staging-changed 广播并发)时
 * 旧响应不覆盖新结果(与 DiffTab 迁移时同一修复);loading 防重入标志与 legacy 一致。
 * 导出签名契约:export function StagingTab({ tab, active }: TabProps),TabProps import 自
 * '../../../stores/workbench'(registry.ts 接线,不得变更)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getState, stagingAccept, stagingClear, stagingList, stagingRestore } from '../../../api';
import type { StagedFile } from '../../../types';
import { confirmDialog, toast } from '../../../ui';
import { useWorkbench, wbEvents, type TabProps } from '../../../stores/workbench';
import { Icon } from '../../../shared/Icon';
import { hideProgress } from '../statusbar-progress';
import '../staging.css';

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

export function StagingTab({ tab, active }: TabProps): JSX.Element {
  const data = tab.data as { projectId: string; sessionId: string };
  const [servers, setServers] = useState<Array<{ id: string; name: string }>>([]);
  /** null = 首次加载中(legacy 初始「加载中…」占位) */
  const [entries, setEntries] = useState<StagedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  /** 刷新防重入(legacy loading 标志) */
  const loadingRef = useRef(false);
  /** 刷新序号:只接受最新一次结果(修复并发刷新乱序) */
  const seqRef = useRef(0);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const serverName = (id: string): string => servers.find((s) => s.id === id)?.name ?? id;

  const refresh = useCallback(async (): Promise<void> => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const seq = ++seqRef.current;
    try {
      const state = await getState();
      const list = await stagingList(data.projectId, data.sessionId);
      if (seq !== seqRef.current) return; // 已有更新的刷新在途:丢弃过期结果
      setServers(state.servers);
      setEntries(list);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(String(err));
    } finally {
      loadingRef.current = false;
    }
  }, [data.projectId, data.sessionId]);

  /* 挂载:首次加载 + 订阅 'staging-changed'(AI 工具完成 / 其他面板操作后广播刷新);
     卸载:反注册订阅(keep-alive 期间常驻,关闭标签才清理) */
  useEffect(() => {
    void refresh();
    return wbEvents.on('staging-changed', () => void refresh());
  }, [refresh]);

  /* 条目列表变化后清理已不存在的选中项(legacy render 内的同款修剪) */
  useEffect(() => {
    if (!entries) return;
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => entries.some((e) => e.entryId === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  /* 全选 checkbox 的 checked / indeterminate 派生(legacy updateSelectionUi) */
  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    const n = entries?.length ?? 0;
    const count = selected.size;
    el.checked = n > 0 && count === n;
    el.indeterminate = count > 0 && count < n;
  }, [selected, entries]);

  /* ---------- 操作 ---------- */
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
      wbEvents.emit('staging-changed');
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
        wbEvents.emit('staging-changed');
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

  /** 单条还原入口:先确认,冲突另行提示(legacy 行内按钮链路) */
  function confirmRestore(entry: StagedFile): void {
    void confirmDialog({
      title: '确认还原',
      message: `把远程文件还原到首次修改前的内容？\n${serverName(entry.serverId)}：${entry.remotePath}\n还原后当前修改将丢失（外部修改冲突会另行提示）`,
      danger: true,
      okText: '还原',
    }).then((ok) => { if (ok) void doRestore(entry, false); });
  }

  async function doBulkAccept(): Promise<void> {
    const targets = (entries ?? []).filter((entry) => selected.has(entry.entryId));
    if (!targets.length || bulkRunning) return;
    const ok = await confirmDialog({
      title: '批量接受暂存',
      message: `确认接受选中的 ${targets.length} 个文件修改？\n这只会清除本地暂存记录，不会修改远程文件。`,
      okText: `接受 ${targets.length} 项`,
    });
    if (!ok) return;
    setBulkRunning(true);
    let accepted = 0;
    for (const entry of targets) {
      try {
        await stagingAccept(data.projectId, data.sessionId, entry.entryId);
        accepted++;
      } catch { /* 继续处理其余条目，结束后统一报告 */ }
    }
    setBulkRunning(false);
    const failed = targets.length - accepted;
    if (failed) toast(`已接受 ${accepted} 项，${failed} 项失败`, 'error');
    else toast(`已接受 ${accepted} 项暂存修改`, 'success');
    setSelected(new Set());
    wbEvents.emit('staging-changed');
    void refresh();
  }

  async function doBulkRestore(): Promise<void> {
    const targets = (entries ?? []).filter((entry) => selected.has(entry.entryId));
    if (!targets.length || bulkRunning) return;
    const ok = await confirmDialog({
      title: '批量还原暂存',
      message: `把选中的 ${targets.length} 个远程文件还原到首次修改前？\n当前修改将丢失；检测到外部修改的文件会跳过，不会强制覆盖。`,
      danger: true,
      okText: `还原 ${targets.length} 项`,
    });
    if (!ok) return;
    setBulkRunning(true);
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
    setBulkRunning(false);
    if (conflicts || failed) toast(`已还原 ${restored} 项；${conflicts} 项冲突、${failed} 项失败`, 'error');
    else toast(`已还原 ${restored} 个远程文件`, 'success');
    setSelected(new Set());
    wbEvents.emit('staging-changed');
    void refresh();
  }

  /** 清理无变更条目：远端现状与首次快照完全一致的条目一次性接受清除（备份已冗余，
   *  不修改远程内容），有变更/检查失败的保留。不需要先勾选。 */
  async function doClear(): Promise<void> {
    if (bulkRunning) return;
    const ok = await confirmDialog({
      title: '清理无变更暂存',
      message: '把「远端现状与首次快照完全一致」的条目全部接受并清除（备份已冗余，不修改远程文件）？\n仍有变更的条目会保留。',
      okText: '清理',
    });
    if (!ok) return;
    setBulkRunning(true);
    // 逐条检查远端现状可能较慢：底边栏显示进度（纯事件驱动——后端 clear_unchanged
    // 逐条目发 staging:progress、结束 done 自动收起；不额外占位避免与事件槽并存）
    const progKey = `staging:${data.projectId}:${data.sessionId}`;
    try {
      const out = await stagingClear(data.projectId, data.sessionId);
      if (!out.removed.length) {
        toast(out.kept.length ? `没有可清理的条目（${out.kept.length} 项仍有变更，已保留）` : '暂存区为空', 'info');
      } else if (out.errors.length) {
        toast(`已清理 ${out.removed.length} 项；${out.kept.length} 项保留（${out.errors.length} 项检查失败）`, 'error');
      } else {
        toast(`已清理 ${out.removed.length} 个无变更条目，保留 ${out.kept.length} 项有变更条目`, 'success');
      }
      setSelected(new Set());
      wbEvents.emit('staging-changed');
      void refresh();
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setBulkRunning(false);
      hideProgress(progKey);
    }
  }

  /** 打开 diff 标签(单击「比较差异」/ 双击行;同 id 去重激活) */
  function openDiff(entry: StagedFile): void {
    useWorkbench.getState().openTab({
      id: `staging-diff:${data.projectId}:${data.sessionId}:${entry.entryId}`,
      type: 'staging-diff',
      title: entry.remotePath.split('/').filter(Boolean).pop() || entry.remotePath,
      data: { projectId: data.projectId, sessionId: data.sessionId, entryId: entry.entryId },
    });
  }

  /* ---------- 渲染 ---------- */
  const count = entries?.length ?? 0;
  const selCount = selected.size;
  void active; // keep-alive 语义:显隐由外壳 .tab-pane.active 承担,本组件不消费

  return (
    <div className="staging-panel">
      <div className="staging-head">
        <span className="staging-title">
          <Icon name="history" /> 文件暂存区 <span className="staging-count">{count}</span>
        </span>
        <button className="btn small" title="刷新列表" onClick={() => void refresh()}>
          <Icon name="refresh" /> 刷新
        </button>
      </div>
      <div className="staging-hint">自动备份开启后，AI 会话第一次修改远程文件前自动保存原始快照，同一会话后续修改不覆盖。接受 = 确认本次修改并清除暂存条目（不改远程内容）；还原 = 把远程文件恢复到首次修改前的内容；清理 = 把「无变更」的条目一次性接受清除。</div>
      <div className="staging-toolbar" hidden={count === 0}>
        <span className="staging-selected">{selCount ? `已选择 ${selCount} 项` : '选择文件后可批量操作'}</span>
        <span className="staging-toolbar-spacer"></span>
        <button className="btn small" disabled={bulkRunning} title="把远端现状与首次快照一致的条目全部接受并清除（有变更的保留）" onClick={() => void doClear()}>
          <Icon name="trash" /> 清理无变更
        </button>
        <button className="btn small primary" disabled={selCount === 0 || bulkRunning} onClick={() => void doBulkAccept()}>批量接受</button>
        <button className="btn small" disabled={selCount === 0 || bulkRunning} onClick={() => void doBulkRestore()}>
          <Icon name="restore" /> 批量还原
        </button>
      </div>
      <div className="staging-body">
        {error ? (
          <div className="staging-empty error">暂存列表加载失败：{error}</div>
        ) : entries === null ? (
          <div className="staging-empty">加载中…</div>
        ) : count === 0 ? (
          <div className="staging-empty">当前会话暂无暂存条目。AI 修改远程文件（run_command 写入 / sftp_upload 覆盖）前会自动保存原始快照。</div>
        ) : (
          <table className="staging-table">
            <thead>
              <tr>
                <th className="st-select">
                  <input ref={selectAllRef} type="checkbox" aria-label="全选暂存文件"
                    onChange={(e) => setSelected(e.currentTarget.checked
                      ? new Set((entries ?? []).map((x) => x.entryId))
                      : new Set())} />
                </th>
                <th>服务器</th>
                <th>远程路径</th>
                <th>首次快照</th>
                <th>原始状态</th>
                <th>当前状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const orig = STATE_LABEL[entry.originalState] ?? entry.originalState;
                const cur = STATE_LABEL[entry.currentState] ?? entry.currentState;
                const curCls = entry.currentState === 'absent' ? ' st-absent' : '';
                const name = entry.remotePath.split('/').filter(Boolean).pop() || entry.remotePath;
                const sel = selected.has(entry.entryId);
                return (
                  <tr key={entry.entryId} data-entry-id={entry.entryId} className={sel ? 'selected' : ''}
                    onDoubleClick={() => openDiff(entry)}>
                    <td className="st-select">
                      <input type="checkbox" aria-label={`选择 ${entry.remotePath}`} checked={sel}
                        onChange={(e) => {
                          const id = entry.entryId;
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.currentTarget.checked) next.add(id);
                            else next.delete(id);
                            return next;
                          });
                        }} />
                    </td>
                    <td className="st-server">{serverName(entry.serverId)}</td>
                    <td className="st-path" title={entry.remotePath}>
                      {name}<span className="st-path-full">{entry.remotePath}</span>
                    </td>
                    <td className="st-time">{fmtTime(entry.stagedAt)}</td>
                    <td className="st-orig">{orig}{entry.size != null ? ` · ${fmtSize(entry.size)}` : ''}</td>
                    <td className={`st-cur${curCls}`}>{cur}</td>
                    <td className="st-actions">
                      <button className="btn small" title="查看首次快照与当前内容差异" onClick={() => openDiff(entry)}>
                        <Icon name="diff" /> 比较差异
                      </button>
                      <button className="btn small primary" title="确认本次修改，清除暂存条目（不改远程内容）"
                        onClick={() => void doAccept(entry)}>接受</button>
                      <button className="btn small" title="把远程文件还原到首次修改前的内容"
                        onClick={() => confirmRestore(entry)}>还原</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
