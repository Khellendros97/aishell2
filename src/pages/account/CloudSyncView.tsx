/**
 * 云同步与云备份子页（React 版，新功能）—— 对照 .zcode/plans/plan-sess_2d557508-265f-404c-8f04-e405e3796039.md §7.1。
 * 与后端接口点（src/api.ts）：cloud_sync_*、cloud_backups_* 以及 cloud-sync:changed /
 * cloud-backup:changed 事件；密码仅存在本组件及弹窗的瞬时 state，不进入 store、localStorage 或 JSON。
 * 依赖 CloudStatus 做登录/能力门控，事件监听和异步请求均在 effect return/取消标记中清理。
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  CloudBackup, CloudCapabilities, CloudStatus, InterruptedBackup, RestoreCollisionMode, SyncConflict, SyncDevice, SyncStatus,
} from '../../types';
import {
  cloudBackupAbandon, cloudBackupDelete, cloudBackupInterrupted, cloudBackupRestore, cloudBackupResume, cloudBackupsList,
  cloudSyncChangePassword, cloudSyncDeleteAll, cloudSyncDevices, cloudSyncInitialize,
  cloudSyncLock, cloudSyncNow, cloudSyncRenameDevice, cloudSyncResolveConflict,
  cloudSyncRevokeDevice, cloudSyncReregisterDevice, cloudSyncStatus, cloudSyncUnlock,
  onCloudBackupChanged, onCloudSyncChanged, openDialog,
} from '../../api';
import { confirmDialog, promptDialog, toast } from '../../ui';
import { Icon } from '../../shared/Icon';
import { MaskModal } from './MaskModal';

interface CloudSyncViewProps {
  status: CloudStatus | null;
  onGoLogin: () => void;
}

type PasswordMode = 'initialize' | 'unlock' | 'change';

const EMPTY_QUOTA = { usedBytes: 0, totalBytes: 0, backupUsedBytes: 0, backupTotalBytes: 0 };
const EMPTY_LIMITS = {
  maxBatchItems: 0, maxBatchBytes: 0, inlinePayloadBytes: 0, maxBackupBytes: 0,
  maxBackupFiles: 0, maxConcurrentBackups: 0,
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes || 0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '暂无';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function errorText(error: unknown): string {
  return String(error).replace(/^Error:\s*/, '');
}

function capabilityEnabled(capabilities: CloudCapabilities | null, name: 'dataSync' | 'fileBackup'): boolean {
  return capabilities?.[name] === true;
}

function PasswordModal({ mode, onClose, onSubmit }: {
  mode: PasswordMode;
  onClose: () => void;
  onSubmit: (password: string, oldPassword?: string) => Promise<void>;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (!password) { setError('密码不能为空'); return; }
    if (mode === 'change' && !oldPassword) { setError('请输入当前同步密码'); return; }
    setBusy(true);
    setError(null);
    try { await onSubmit(password, mode === 'change' ? oldPassword : undefined); }
    catch (errorValue) { setError(errorText(errorValue)); setBusy(false); }
  };
  const title = mode === 'initialize' ? '设置云同步密码' : mode === 'unlock' ? '解锁云同步' : '修改同步密码';
  return (
    <MaskModal
      width={440}
      onClose={() => { if (!busy) onClose(); }}
      head={<h3>{title}</h3>}
      body={
        <>
          {mode === 'change' ? (
            <div className="field"><label>当前同步密码</label><input className="input" type="password" autoComplete="current-password"
              value={oldPassword} onChange={(event) => setOldPassword(event.currentTarget.value)} /></div>
          ) : null}
          <div className="field"><label>{mode === 'change' ? '新同步密码' : '同步密码'}</label><input className="input" type="password"
            autoComplete="new-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} /></div>
          <div className="hint">密码只用于本机解锁云端加密数据，不会上传到云端或写入配置文件。</div>
          {error ? <div className="form-error">{error}</div> : null}
        </>
      }
      foot={<><button className="btn small" onClick={onClose} disabled={busy}>取消</button>
        <button className="btn primary small" onClick={() => void submit()} disabled={busy}>{busy ? '处理中…' : '确定'}</button></>}
    />
  );
}

function ConflictModal({ conflict, onClose, onResolve }: {
  conflict: SyncConflict;
  onClose: () => void;
  onResolve: (resolution: string) => Promise<void>;
}): JSX.Element {
  const [resolution, setResolution] = useState('local');
  const [busy, setBusy] = useState(false);
  const resolve = async (): Promise<void> => {
    setBusy(true);
    try { await onResolve(resolution); onClose(); }
    catch (error) { toast(`处理冲突失败：${errorText(error)}`, 'error'); setBusy(false); }
  };
  return <MaskModal width={500} onClose={() => { if (!busy) onClose(); }} head={<h3>处理同步冲突</h3>}
    body={<>
      <div className="sync-conflict-summary"><strong>{conflict.entityType || '数据'}：{conflict.entityId}</strong>
        <div>{conflict.summary || '本机与云端同时修改了同一项数据。'}</div>
        {conflict.path ? <div className="hint">路径：{conflict.path}</div> : null}</div>
      <div className="field"><label>保留哪一份</label><select className="select" value={resolution} onChange={(event) => setResolution(event.currentTarget.value)}>
        <option value="local">保留本机版本</option><option value="remote">使用云端版本</option>
      </select></div>
      <div className="hint">凭据冲突只显示设备和时间，不会展示密码或密钥。</div>
    </>}
    foot={<><button className="btn small" onClick={onClose} disabled={busy}>取消</button>
      <button className="btn primary small" onClick={() => void resolve()} disabled={busy}>{busy ? '处理中…' : '应用选择'}</button></>} />;
}

function RestoreModal({ backup, onClose, onRestore }: {
  backup: CloudBackup;
  onClose: () => void;
  onRestore: (targetPath: string, collisionMode: RestoreCollisionMode) => Promise<void>;
}): JSX.Element {
  const [targetPath, setTargetPath] = useState('');
  const [collisionMode, setCollisionMode] = useState<RestoreCollisionMode>('keepBoth');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browseTarget = async (): Promise<void> => {
    const path = await openDialog({ directory: true });
    if (typeof path === 'string' && path) { setTargetPath(path); setError(null); }
  };
  const restore = async (): Promise<void> => {
    if (!targetPath.trim()) { setError('请选择恢复目标目录'); return; }
    setBusy(true); setError(null);
    try { await onRestore(targetPath.trim(), collisionMode); onClose(); }
    catch (errorValue) { setError(errorText(errorValue)); setBusy(false); }
  };
  return <MaskModal width={500} onClose={() => { if (!busy) onClose(); }} head={<h3>恢复云端备份</h3>}
    body={<>
      <div className="hint">备份：{backup.name || '已加密备份'}，大小 {formatBytes(backup.sizeBytes)}，文件 {backup.fileCount} 个。</div>
      <div className="field"><label>恢复到本地目录</label>
        <div className="input-row">
          <input className="input" value={targetPath} placeholder="点击浏览选择目录" readOnly />
          <button className="btn small" onClick={() => void browseTarget()} disabled={busy}>浏览…</button>
        </div>
      </div>
      <div className="field"><label>遇到同名文件</label><select className="select" value={collisionMode}
        onChange={(event) => setCollisionMode(event.currentTarget.value as RestoreCollisionMode)}>
        <option value="keepBoth">保留两份（推荐）</option><option value="skip">跳过</option><option value="overwrite">覆盖</option>
      </select></div>
      {error ? <div className="form-error">{error}</div> : null}
    </>}
    foot={<><button className="btn small" onClick={onClose} disabled={busy}>取消</button>
      <button className="btn primary small" onClick={() => void restore()} disabled={busy}>{busy ? '恢复中…' : '开始恢复'}</button></>} />;
}

export function CloudSyncView({ status, onGoLogin }: CloudSyncViewProps): JSX.Element {
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [backups, setBackups] = useState<CloudBackup[]>([]);
  const [interrupted, setInterrupted] = useState<InterruptedBackup[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordMode, setPasswordMode] = useState<PasswordMode | null>(null);
  const [conflict, setConflict] = useState<SyncConflict | null>(null);
  const [restoreBackup, setRestoreBackup] = useState<CloudBackup | null>(null);

  const enabled = !!status?.serverUrl && !!status.loggedIn && capabilityEnabled(status.capabilities, 'dataSync');
  const backupEnabled = enabled && capabilityEnabled(status?.capabilities ?? null, 'fileBackup');

  const loadBackups = useCallback(async (): Promise<void> => {
    if (!backupEnabled) return;
    setBackupsLoading(true);
    try {
      const [page, local] = await Promise.all([cloudBackupsList(), cloudBackupInterrupted()]);
      setBackups(page.items ?? []);
      setInterrupted(local);
    }
    catch (errorValue) { setError(`加载备份列表失败：${errorText(errorValue)}`); }
    finally { setBackupsLoading(false); }
  }, [backupEnabled]);

  const loadDetails = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    setError(null);
    try {
      const next = await cloudSyncStatus();
      setSync(next);
      if (next.unlocked) {
        try { setDevices(await cloudSyncDevices()); } catch (errorValue) { setError(`加载设备列表失败：${errorText(errorValue)}`); }
      } else setDevices([]);
    } catch (errorValue) { setError(errorText(errorValue)); }
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;
    if (enabled) void loadDetails().then(() => { if (cancelled) return; }).catch(() => {});
    else { setSync(null); setDevices([]); setBackups([]); setInterrupted([]); }
    return () => { cancelled = true; };
  }, [enabled, loadDetails]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let offSync: (() => void) | null = null;
    let offBackup: (() => void) | null = null;
    onCloudSyncChanged((next) => { if (!cancelled) { setSync(next); if (next.unlocked) void cloudSyncDevices().then(setDevices).catch(() => {}); } })
      .then((off) => { if (cancelled) off(); else offSync = off; }).catch(() => {});
    onCloudBackupChanged(() => { if (!cancelled) void loadBackups(); })
      .then((off) => { if (cancelled) off(); else offBackup = off; }).catch(() => {});
    return () => { cancelled = true; offSync?.(); offBackup?.(); };
  }, [enabled, loadBackups]);

  useEffect(() => { if (backupEnabled && sync?.unlocked) void loadBackups(); }, [backupEnabled, sync?.unlocked, loadBackups]);

  const refresh = async (): Promise<void> => { await loadDetails(); if (backupEnabled) await loadBackups(); };
  const doSync = async (): Promise<void> => {
    try { setSync(await cloudSyncNow()); toast('同步任务已启动', 'success'); }
    catch (errorValue) { toast(`立即同步失败：${errorText(errorValue)}`, 'error'); }
  };
  const submitPassword = async (password: string, oldPassword?: string): Promise<void> => {
    let next: SyncStatus;
    if (passwordMode === 'initialize') next = await cloudSyncInitialize(password);
    else if (passwordMode === 'unlock') next = await cloudSyncUnlock(password);
    else next = await cloudSyncChangePassword(oldPassword ?? '', password);
    setSync(next); setPasswordMode(null); toast(passwordMode === 'change' ? '同步密码已修改' : passwordMode === 'unlock' ? '云同步已解锁' : '云同步已初始化', 'success');
  };
  const renameDevice = async (device: SyncDevice): Promise<void> => {
    const name = await promptDialog({ title: '重命名设备', label: '设备名称', defaultValue: device.name });
    if (!name) return;
    try { const next = await cloudSyncRenameDevice(device.id || device.deviceId || '', name); setDevices((items) => items.map((item) => item.id === device.id ? next : item)); toast('设备名称已更新', 'success'); }
    catch (errorValue) { toast(`重命名失败：${errorText(errorValue)}`, 'error'); }
  };
  const revokeDevice = async (device: SyncDevice): Promise<void> => {
    if (device.isCurrent) { toast('不能撤销当前设备，请先在其他设备注册', 'error'); return; }
    if (!await confirmDialog({ title: '撤销设备', message: `确定撤销设备「${device.name}」吗？撤销后该设备不能继续同步。`, danger: true, okText: '撤销' })) return;
    try { await cloudSyncRevokeDevice(device.id || device.deviceId || ''); setDevices((items) => items.filter((item) => item.id !== device.id)); toast('设备已撤销', 'success'); }
    catch (errorValue) { toast(`撤销设备失败：${errorText(errorValue)}`, 'error'); }
  };
  const reregister = async (): Promise<void> => {
    const name = await promptDialog({ title: '重新注册本机', label: '设备名称（可选）', defaultValue: '本机' });
    if (name === null) return;
    try { const next = await cloudSyncReregisterDevice(name); setDevices((items) => [...items.filter((item) => !item.isCurrent), next]); toast('本机已重新注册', 'success'); await refresh(); }
    catch (errorValue) { toast(`重新注册失败：${errorText(errorValue)}`, 'error'); }
  };
  const deleteAll = async (): Promise<void> => {
    if (!await confirmDialog({ title: '删除全部云端数据', message: '此操作将永久删除云端同步数据和全部云备份，不能撤销。请确认你已了解后果。', danger: true, okText: '继续' })) return;
    const text = await promptDialog({ title: '确认删除全部云端数据', label: '请输入 DELETE_ALL_CLOUD_DATA 以确认', placeholder: 'DELETE_ALL_CLOUD_DATA' });
    if (text !== 'DELETE_ALL_CLOUD_DATA') { if (text !== null) toast('确认文本不正确，未删除任何数据', 'error'); return; }
    try { await cloudSyncDeleteAll(text); setSync(null); setBackups([]); toast('全部云端数据已删除', 'success'); await loadDetails(); }
    catch (errorValue) { toast(`删除云端数据失败：${errorText(errorValue)}`, 'error'); }
  };
  const removeBackup = async (backup: CloudBackup): Promise<void> => {
    if (!await confirmDialog({ title: '删除云端备份', message: `确定删除「${backup.name || '此备份'}」吗？删除后不能恢复。`, danger: true, okText: '删除' })) return;
    try { await cloudBackupDelete(backup.id); setBackups((items) => items.filter((item) => item.id !== backup.id)); toast('备份已删除', 'success'); }
    catch (errorValue) { toast(`删除备份失败：${errorText(errorValue)}`, 'error'); }
  };
  const restore = async (backup: CloudBackup, targetPath: string, collisionMode: RestoreCollisionMode): Promise<void> => {
    await cloudBackupRestore(backup.id, targetPath, collisionMode); toast('恢复任务已启动，请在状态栏查看进度', 'success');
  };
  const resume = async (backup: CloudBackup): Promise<void> => {
    try { await cloudBackupResume(backup.id); toast('备份续传任务已启动', 'success'); }
    catch (errorValue) { toast(`继续备份失败：${errorText(errorValue)}`, 'error'); }
  };
  const resumeInterrupted = async (item: InterruptedBackup): Promise<void> => {
    try { await cloudBackupResume(item.backupId); setInterrupted((items) => items.filter((entry) => entry.taskId !== item.taskId)); toast('备份续传任务已启动，请在状态栏查看进度', 'success'); }
    catch (errorValue) { toast(`继续备份失败：${errorText(errorValue)}`, 'error'); }
  };
  const abandonInterrupted = async (item: InterruptedBackup): Promise<void> => {
    if (!await confirmDialog({ title: '放弃未完成的备份', message: `确定放弃「${item.displayName}」的未完成备份吗？将删除云端草稿和本地续传记录，已上传的分片会被清理。`, danger: true, okText: '放弃' })) return;
    try { await cloudBackupAbandon(item.taskId); setInterrupted((items) => items.filter((entry) => entry.taskId !== item.taskId)); toast('已放弃该备份任务', 'success'); }
    catch (errorValue) { toast(`放弃备份失败：${errorText(errorValue)}`, 'error'); }
  };

  if (!status) return <div className="loading-row"><Icon name="loader" /> 加载云同步状态…</div>;
  if (!status.serverUrl) return <div className="cloud-empty"><div>当前构建未配置云服务，云同步与云备份不可用。</div><div className="hint">请使用管理员配置了云平台地址的构建版本。</div></div>;
  if (!status.loggedIn) return <div className="cloud-empty"><div>请先登录云平台账号，再使用云同步和云备份。</div><button className="btn primary" onClick={onGoLogin}>前往账号信息登录</button></div>;
  if (!capabilityEnabled(status.capabilities, 'dataSync')) return <div className="cloud-empty"><div>当前账号未开通云同步能力。</div><div className="hint">如需开通，请联系云平台管理员。</div></div>;

  const quota = sync?.quota ?? EMPTY_QUOTA;
  const limits = sync?.limits ?? EMPTY_LIMITS;
  const locked = sync ? !sync.unlocked : true;
  const stateLabel = sync?.status === 'quotaExceeded' ? '配额不足' : sync?.status === 'conflict' ? '存在冲突' : locked ? '需要解锁' : sync?.syncing ? '同步中' : sync?.status === 'offline' ? '离线待同步' : '已就绪';
  return (
    <div className="cloud-sync-view">
      <div className="sync-toolbar"><span className={`sync-state sync-state-${sync?.status || 'idle'}`}><Icon name={locked ? 'lock' : sync?.syncing ? 'sync' : 'cloudSync'} /> {stateLabel}</span>
        <button className="btn small" onClick={() => void refresh()}><Icon name="refresh" /> 刷新</button>
        {locked ? <button className="btn primary small" onClick={() => setPasswordMode(sync?.initialized ? 'unlock' : 'initialize')}>{sync?.initialized ? '解锁云同步' : '设置同步密码'}</button> : <>
          <button className="btn primary small" onClick={() => void doSync()} disabled={!!sync?.syncing}><Icon name="sync" /> 立即同步</button>
          <button className="btn small" onClick={() => { void cloudSyncLock().then(setSync).catch((errorValue) => toast(`锁定失败：${errorText(errorValue)}`, 'error')); }}><Icon name="lock" /> 锁定</button>
        </>}
      </div>
      {error ? <div className="form-error sync-error">{error}</div> : null}
      <div className="sync-summary-grid">
        <div className="sync-stat"><span>最近成功同步</span><strong>{formatTime(sync?.lastSuccessAt ?? sync?.lastSyncAt)}</strong></div>
        <div className="sync-stat"><span>待上传项</span><strong>{sync?.pendingCount ?? 0}</strong></div>
        <div className="sync-stat"><span>同步空间</span><strong>{formatBytes(quota.usedBytes)} / {formatBytes(quota.totalBytes)}</strong></div>
        <div className="sync-stat"><span>备份空间</span><strong>{formatBytes(quota.backupUsedBytes)} / {formatBytes(quota.backupTotalBytes)}</strong></div>
      </div>
      <section className="sync-section"><h4><Icon name="device" /> 设备管理</h4>
        {!locked ? <><div className="sync-device-list">{devices.length === 0 ? <div className="hint">暂无设备信息</div> : devices.map((device) => <div className="sync-device" key={device.id || device.deviceId}>
          <Icon name={device.isCurrent ? 'monitor' : 'device'} /><span className="sync-device-name">{device.name}{device.isCurrent ? '（本机）' : ''}</span><span className="hint">最近活动：{formatTime(device.lastSeenAt)}</span>
          <button className="icon-btn" title="重命名" onClick={() => void renameDevice(device)}><Icon name="pencil" /></button>
          {!device.isCurrent ? <button className="icon-btn danger" title="撤销设备" onClick={() => void revokeDevice(device)}><Icon name="trash" /></button> : null}
        </div>)}</div>
        {sync?.device?.revoked ? <button className="btn small" onClick={() => void reregister()}>将本机重新注册为新设备</button> : null}</> : <div className="hint">解锁后可管理设备。</div>}
      </section>
      <section className="sync-section"><h4><Icon name="alert" /> 冲突</h4>
        {sync?.conflicts?.length ? <div className="sync-conflict-list">{sync.conflicts.map((item) => <div className="sync-conflict" key={item.id}><div><strong>{item.entityType || '数据'}：{item.entityId}</strong><div className="hint">{item.summary}</div></div><button className="btn small" onClick={() => setConflict(item)}>处理</button></div>)}</div> : <div className="hint">暂无待处理冲突。</div>}
      </section>
      <section className="sync-section"><h4><Icon name="cloudBackup" /> 云端备份 {backupEnabled ? null : <span className="hint">（当前未开通）</span>}</h4>
        {backupEnabled && interrupted.length > 0 ? <div className="sync-backup-list">{interrupted.map((item) => <div className="sync-backup" key={item.taskId}><div className="sync-backup-main"><strong>{item.displayName}（未完成）</strong><span className="hint">已上传 {item.filesDone} / {item.filesTotal} 个文件 · {formatTime(new Date(item.createdAtUnixMs).toISOString())}</span></div><div className="sync-backup-actions"><button className="btn small" onClick={() => void resumeInterrupted(item)} disabled={locked}>继续</button><button className="icon-btn danger" title="放弃该备份" onClick={() => void abandonInterrupted(item)}><Icon name="trash" /></button></div></div>)}</div> : null}
        {backupEnabled ? <>{backupsLoading ? <div className="loading-row"><Icon name="loader" /> 加载备份列表…</div> : backups.length === 0 ? <div className="hint">暂无云端备份。可在文件资源管理器右键选择“备份到云端”。</div> : <div className="sync-backup-list">{backups.map((backup) => <div className="sync-backup" key={backup.id}><div className="sync-backup-main"><strong>{backup.locked ? '已加密备份（需解锁查看名称）' : (backup.name || '未命名备份')}</strong><span className="hint">{formatTime(backup.completedAt || backup.createdAt)} · {formatBytes(backup.sizeBytes)} · {backup.fileCount} 个文件</span></div><div className="sync-backup-actions">{backup.status === 'draft' ? <button className="btn small" onClick={() => void resume(backup)}>继续</button> : <button className="btn small" onClick={() => setRestoreBackup(backup)} disabled={locked}>恢复</button>}<button className="icon-btn danger" title="删除备份" onClick={() => void removeBackup(backup)}><Icon name="trash" /></button></div></div>)}</div>}<div className="hint sync-limits">单次最多 {limits.maxBackupFiles || '不限'} 个文件，最大 {limits.maxBackupBytes ? formatBytes(limits.maxBackupBytes) : '按云端限制'}。</div></> : <div className="hint">当前账号未开通文件云备份能力。</div>}
      </section>
      {!locked ? <section className="sync-danger-zone"><button className="btn small" onClick={() => setPasswordMode('change')}>修改同步密码</button><button className="btn danger-solid small" onClick={() => void deleteAll()}>删除全部云端数据</button></section> : null}
      {passwordMode ? <PasswordModal mode={passwordMode} onClose={() => setPasswordMode(null)} onSubmit={submitPassword} /> : null}
      {conflict ? <ConflictModal conflict={conflict} onClose={() => setConflict(null)} onResolve={async (resolution) => { const next = await cloudSyncResolveConflict(conflict.id, resolution); setSync(next); toast('冲突已处理', 'success'); }} /> : null}
      {restoreBackup ? <RestoreModal backup={restoreBackup} onClose={() => setRestoreBackup(null)} onRestore={(path, mode) => restore(restoreBackup, path, mode)} /> : null}
    </div>
  );
}
