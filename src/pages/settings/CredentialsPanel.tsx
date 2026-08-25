/**
 * 凭据库设置面板：管理可复用的 SSH 认证条目，不展示也不读取已保存密码。
 * 对照 .proto/settings.html / .proto/settings.js 的设置导航与服务器认证表单规格；
 * 后端接口点：get_state、upsert_credential、delete_credential。
 */
import { useEffect, useMemo, useState } from 'react';
import type { AppState, AuthType, Credential } from '../../types';
import { deleteCredential, getState, openDialog, upsertCredential } from '../../api';
import { confirmDialog, toast, uid } from '../../ui';
import { Icon } from '../../shared/Icon';

interface Props {
  initialState: AppState | null;
  onChanged: (state: AppState) => void;
}

interface CredentialFields {
  name: string;
  authType: AuthType;
  username: string;
  keyPath: string;
  password: string;
}

const EMPTY_FIELDS: CredentialFields = {
  name: '', authType: 'password', username: '', keyPath: '', password: '',
};

export function CredentialsPanel({ initialState, onChanged }: Props): JSX.Element {
  const [state, setState] = useState<AppState | null>(initialState);
  const [editing, setEditing] = useState<Credential | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [fields, setFields] = useState<CredentialFields>(EMPTY_FIELDS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setState(initialState); }, [initialState]);

  const credentials = state?.credentials ?? [];
  const servers = state?.servers ?? [];
  const refs = useMemo(() => {
    const byCredential = new Map<string, typeof servers>();
    servers.forEach((server) => {
      if (!server.credentialId) return;
      const list = byCredential.get(server.credentialId) ?? [];
      list.push(server);
      byCredential.set(server.credentialId, list);
    });
    return byCredential;
  }, [servers]);

  const refresh = async (): Promise<void> => {
    try {
      const next = await getState();
      setState(next);
      onChanged(next);
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  const openNew = (): void => {
    setEditing(null);
    setFields(EMPTY_FIELDS);
    setError(null);
    setModalOpen(true);
  };
  const openEdit = (credential: Credential): void => {
    setEditing(credential);
    setFields({
      name: credential.name,
      authType: credential.authType,
      username: credential.username,
      keyPath: credential.keyPath,
      password: '',
    });
    setError(null);
    setModalOpen(true);
  };
  const close = (): void => {
    if (busy) return;
    setModalOpen(false);
    setEditing(null);
    setError(null);
  };
  const browseKey = async (): Promise<void> => {
    const path = await openDialog({ directory: false });
    if (typeof path === 'string' && path) {
      setFields((current) => ({ ...current, keyPath: path }));
    }
  };
  const save = async (): Promise<void> => {
    const name = fields.name.trim();
    if (!name) { setError('凭据名称不能为空'); return; }
    if (fields.authType === 'key' && !fields.keyPath.trim()) { setError('请填写密钥文件路径'); return; }
    if (!fields.username.trim()) { setError('请填写账号'); return; }
    const credential: Credential = {
      id: editing?.id ?? uid('cred'),
      name,
      authType: fields.authType,
      username: fields.username.trim(),
      keyPath: fields.authType === 'key' ? fields.keyPath.trim() : '',
    };
    setBusy(true);
    setError(null);
    try {
      await upsertCredential(credential, fields.authType === 'password' ? (fields.password || null) : null);
      toast(editing ? '凭据已更新' : '凭据已创建', 'success');
      setModalOpen(false);
      setEditing(null);
      await refresh();
      window.dispatchEvent(new CustomEvent('aishell:data-changed'));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (credential: Credential): Promise<void> => {
    const referenced = refs.get(credential.id) ?? [];
    if (referenced.length) {
      toast(`凭据「${credential.name}」仍被 ${referenced.length} 台服务器引用：${referenced.map((server) => server.name).join('、')}`, 'error');
      return;
    }
    if (!await confirmDialog({
      title: '删除凭据', message: `确定删除「${credential.name}」吗？此操作不可撤销。`, danger: true, okText: '删除',
    })) return;
    try {
      await deleteCredential(credential.id);
      toast(`已删除凭据「${credential.name}」`, 'success');
      await refresh();
      window.dispatchEvent(new CustomEvent('aishell:data-changed'));
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  return (
    <section id="panel-credentials" className="settings-panel credentials-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title"><Icon name="key" />凭据库</div>
          <div className="hint">集中管理 SSH 登录信息；密码只保存在系统凭据库，不会回显或写入配置文件。</div>
        </div>
        <button className="btn primary" onClick={openNew}><Icon name="plus" />新建凭据</button>
      </div>
      {credentials.length ? (
        <div className="credential-list">
          {credentials.map((credential) => {
            const referenced = refs.get(credential.id) ?? [];
            return (
              <article className="card credential-card" key={credential.id}>
                <div className="credential-card-head">
                  <div className="credential-name"><Icon name="key" /><strong title={credential.name}>{credential.name}</strong></div>
                  <div className="credential-actions">
                    <button className="icon-btn" title="编辑凭据" onClick={() => openEdit(credential)}><Icon name="pencil" /></button>
                    <button className="icon-btn danger" title="删除凭据" onClick={() => void remove(credential)}><Icon name="trash" /></button>
                  </div>
                </div>
                <div className="credential-meta">
                  <span className="tag">{credential.authType === 'key' ? '密钥' : '账号密码'}</span>
                  <span><Icon name="user" /> {credential.username || '未设账号'}</span>
                  {credential.authType === 'key' ? <span className="mono credential-path">{credential.keyPath || '未设路径'}</span> : <span>密码不回显</span>}
                </div>
                <div className="credential-refs">
                  <Icon name="server" /> 引用服务器 {referenced.length} 台
                  {referenced.length ? <span>：{referenced.map((server) => server.name).join('、')}</span> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state credential-empty"><div className="icon"><Icon name="key" /></div><div>暂无凭据</div><div className="hint">新建凭据后，可在服务器表单中复用。</div></div>
      )}

      {modalOpen ? (
        <div className="modal-mask open" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <div className="modal credential-modal">
            <div className="modal-head"><h3>{editing ? '编辑凭据' : '新建凭据'}</h3><button className="icon-btn" title="关闭" onClick={close}><Icon name="x" /></button></div>
            <div className="modal-body">
              <div className="field"><label>凭据名称<span className="req">*</span></label><input className="input" autoFocus value={fields.name} placeholder="例如：生产环境部署账号" onChange={(event) => { const value = event.currentTarget.value; setFields((current) => ({ ...current, name: value })); }} /></div>
              <div className="field"><label>认证方式</label><select className="select" value={fields.authType} onChange={(event) => { const authType = event.currentTarget.value as AuthType; setFields((current) => ({ ...current, authType, password: '' })); }}><option value="password">账号密码</option><option value="key">密钥</option></select></div>
              <div className="field"><label>账号<span className="req">*</span></label><input className="input" value={fields.username} placeholder="例如：deploy" onChange={(event) => { const value = event.currentTarget.value; setFields((current) => ({ ...current, username: value })); }} /></div>
              {fields.authType === 'password' ? <div className="field"><label>密码</label><input className="input" type="password" placeholder={editing ? '留空表示保持原密码' : '输入后保存到系统凭据库'} value={fields.password} onChange={(event) => { const value = event.currentTarget.value; setFields((current) => ({ ...current, password: value })); }} /></div> : <div className="field"><label>密钥文件路径<span className="req">*</span></label><div className="path-row"><input className="input mono" value={fields.keyPath} placeholder="C:\\Users\\demo\\.ssh\\id_ed25519" onChange={(event) => { const value = event.currentTarget.value; setFields((current) => ({ ...current, keyPath: value })); }} /><button type="button" className="btn" onClick={() => void browseKey()}>浏览…</button></div></div>}
              {error ? <div className="form-error">{error}</div> : null}
            </div>
            <div className="modal-foot"><button className="btn" onClick={close} disabled={busy}>取消</button><button className="btn primary" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
