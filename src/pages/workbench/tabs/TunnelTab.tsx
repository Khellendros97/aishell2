/**
 * SSH 隧道管理标签页('tunnel'，无 .proto 对照；服务器卡片「更多 → SSH 隧道」打开)。
 * 本地端口转发(ssh -L 等价)：本机 bindAddr:localPort → 远端服务器视角 targetHost:targetPort，
 * 复用该服务器的 SSH 连接(与终端/SFTP 共用连接池)。配置存 aishell.json(enabled = 重启自动重建，
 * 见 tunnel.rs recover)；关闭本标签页不停止隧道(服务语义)。
 * 与后端的接口点:tunnel_list / tunnel_save / tunnel_start / tunnel_stop / tunnel_delete，
 * 变更通知事件 tunnels:changed(启动/停止/保存/删除/重启恢复时由后端广播)。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  onTunnelsChanged, tunnelDelete, tunnelList, tunnelSave, tunnelStart, tunnelStop,
} from '../../../api';
import type { TunnelConfig, TunnelState } from '../../../types';
import { confirmDialog, toast, uid } from '../../../ui';
import type { TabProps } from '../../../stores/workbench';
import { Icon } from '../../../shared/Icon';
import '../tunnel.css';

interface EditorFields {
  name: string;
  bindAddr: string;
  localPort: string;
  targetHost: string;
  targetPort: string;
}

const EMPTY_EDITOR: EditorFields = {
  name: '', bindAddr: '127.0.0.1', localPort: '', targetHost: '', targetPort: '',
};

function parsePort(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export function TunnelTab({ tab }: TabProps): JSX.Element {
  const { serverId, serverName } = tab.data as { serverId: string; serverName?: string };
  const [tunnels, setTunnels] = useState<TunnelState[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TunnelState | null>(null);
  const [fields, setFields] = useState<EditorFields>(EMPTY_EDITOR);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTunnels(await tunnelList(serverId));
    } catch (err) {
      toast(String(err), 'error');
    }
  }, [serverId]);

  /* 挂载即加载 + 订阅变更事件（keep-alive：切标签只 display:none，不卸载） */
  useEffect(() => {
    void load();
    let unlisten: (() => void) | null = null;
    void onTunnelsChanged(() => void load()).then((u) => { unlisten = u; });
    return () => unlisten?.();
  }, [load]);

  const openNew = (): void => {
    setEditing(null);
    setFields(EMPTY_EDITOR);
    setError(null);
    setEditorOpen(true);
  };
  const openEdit = (tunnel: TunnelState): void => {
    setEditing(tunnel);
    setFields({
      name: tunnel.name,
      bindAddr: tunnel.bindAddr,
      localPort: String(tunnel.localPort),
      targetHost: tunnel.targetHost === '127.0.0.1' ? '' : tunnel.targetHost,
      targetPort: String(tunnel.targetPort),
    });
    setError(null);
    setEditorOpen(true);
  };
  const closeEditor = (): void => {
    if (busy) return;
    setEditorOpen(false);
    setEditing(null);
    setError(null);
  };

  const doSave = async (): Promise<void> => {
    const name = fields.name.trim();
    const bindAddr = fields.bindAddr.trim() || '127.0.0.1';
    if (!name) { setError('请填写隧道名称'); return; }
    const localPort = parsePort(fields.localPort);
    if (!localPort) { setError('本地端口需为 1-65535 的整数'); return; }
    const targetPort = parsePort(fields.targetPort);
    if (!targetPort) { setError('目标端口需为 1-65535 的整数'); return; }
    const cfg: TunnelConfig = {
      id: editing?.id ?? uid('tun'),
      serverId,
      name,
      bindAddr,
      localPort,
      targetHost: fields.targetHost.trim(), // 空 = 后端归一为服务器自身
      targetPort,
      enabled: true, // 保存即启用（用户点「保存」的意图是让隧道跑起来）
    };
    setBusy(true);
    setError(null);
    try {
      await tunnelSave(cfg);
      toast(editing ? '隧道已更新' : '隧道已创建', 'success');
      setEditorOpen(false);
      setEditing(null);
      await load();
    } catch (err) {
      // 配置已落盘但启动失败（端口占用/认证失败等）：保留编辑器展示原因
      setError(String(err));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const doToggle = async (tunnel: TunnelState): Promise<void> => {
    try {
      if (tunnel.running) {
        await tunnelStop(tunnel.id);
      } else {
        await tunnelStart(tunnel.id);
      }
      await load();
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  const doDelete = async (tunnel: TunnelState): Promise<void> => {
    if (!await confirmDialog({
      title: '删除隧道',
      message: `确定删除隧道「${tunnel.name}」（${tunnel.bindAddr}:${tunnel.localPort}）吗？将同时停止该隧道，此操作不可撤销。`,
      danger: true,
      okText: '删除',
    })) return;
    try {
      await tunnelDelete(tunnel.id);
      toast('隧道已删除', 'success');
      await load();
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  return (
    <div className="tunnel-tab">
      <div className="tunnel-head">
        <div>
          <div className="tunnel-title"><Icon name="tunnel" />SSH 隧道<span className="hint"> · {serverName ?? serverId}</span></div>
          <div className="hint">本地端口 → 远端目标端口（经服务器 SSH 连接转发）；关闭本标签页不停止隧道。</div>
        </div>
        <button className="btn primary" onClick={openNew}><Icon name="plus" />新建隧道</button>
      </div>

      {tunnels.length ? (
        <div className="tunnel-list">
          {tunnels.map((t) => (
            <article className="card tunnel-card" key={t.id}>
              <div className="tunnel-card-body">
                <div className="tunnel-card-name">
                  <strong title={t.name}>{t.name}</strong>
                  <span className={`tunnel-status ${t.running ? 'running' : ''}`}>
                    <span className="dot" />{t.running ? '运行中' : '已停止'}
                  </span>
                </div>
                <div className="tunnel-card-route mono">{t.bindAddr}:{t.localPort} → {t.targetHost}:{t.targetPort}</div>
                {t.error ? <div className="tunnel-card-error">{t.error}</div> : null}
              </div>
              <div className="tunnel-card-actions">
                <button className="btn small" onClick={() => void doToggle(t)}>{t.running ? '停止' : '启动'}</button>
                <button className="btn small" onClick={() => openEdit(t)}>编辑</button>
                <button className="btn small danger" onClick={() => void doDelete(t)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="icon"><Icon name="tunnel" /></div>
          <div>暂无隧道</div>
          <div className="hint">新建隧道后，本地应用可直接访问远端内网服务（如数据库、Web 管理页）。</div>
        </div>
      )}

      {editorOpen ? (
        <div className="modal-mask open" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
          <div className="modal tunnel-modal">
            <div className="modal-head"><h3>{editing ? '编辑隧道' : '新建隧道'}</h3><button className="icon-btn" title="关闭" onClick={closeEditor}><Icon name="x" /></button></div>
            <div className="modal-body">
              <div className="field"><label>名称<span className="req">*</span></label><input className="input" autoFocus value={fields.name} placeholder="例如：内网数据库" onChange={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, name: v })); }} /></div>
              <div className="field"><label>本地绑定地址</label><input className="input mono" value={fields.bindAddr} placeholder="127.0.0.1" onChange={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, bindAddr: v })); }} /><div className="hint">默认 127.0.0.1 仅本机可访问；改 0.0.0.0 会暴露给局域网，请谨慎。</div></div>
              <div className="field-row">
                <div className="field"><label>本地端口<span className="req">*</span></label><input className="input mono" value={fields.localPort} placeholder="3307" onChange={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, localPort: v })); }} /></div>
                <div className="field"><label>目标主机</label><input className="input mono" value={fields.targetHost} placeholder="localhost（服务器自身）" onChange={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, targetHost: v })); }} /><div className="hint">以远端服务器视角填写（内网 IP 或 localhost）</div></div>
                <div className="field"><label>目标端口<span className="req">*</span></label><input className="input mono" value={fields.targetPort} placeholder="3306" onChange={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, targetPort: v })); }} /></div>
              </div>
              {error ? <div className="form-error">{error}</div> : null}
            </div>
            <div className="modal-foot"><button className="btn" onClick={closeEditor} disabled={busy}>取消</button><button className="btn primary" onClick={() => void doSave()} disabled={busy}>{busy ? '保存中…' : '保存并启动'}</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
