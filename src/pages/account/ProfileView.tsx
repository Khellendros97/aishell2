/**
 * 账号信息子页（React 版）—— 云账号三页导航的第一页。
 * 对照旧实现 src/pages/account.ts 的 renderProfile / startLogin / cancelLogin / doLogout：
 * 未接入云服务提示、未登录登录区（等待态 + 取消登录）、已登录资料卡（头像 + 模式切换 + 退出登录）。
 * 与后端的接口点（见 src/api.ts）：cloudSetMode（切换托管/个人模式，成功经 cloud:changed 广播回写）；
 * 登录流程由父组件 Account 持有（cloudBeginLogin / openUrl / cloudCancelLogin / cloudLogout / cloudStatus），
 * 本组件只按 status / waiting 状态渲染并回调。token 永不返回前端，本页无任何 token 展示。
 */
import { useEffect, useState } from 'react';
import type { CloudMode, CloudStatus, CloudUser } from '../../types';
import { cloudSetMode } from '../../api';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toast } from '../../ui';
import { Icon } from '../../shared/Icon';

interface ProfileViewProps {
  status: CloudStatus | null;
  /** 登录等待中（发起后未回调/未超时）：显示等待态与「取消登录」 */
  waiting: boolean;
  onLogin: () => void;
  onCancelLogin: () => void;
  onLogout: () => void;
}

/** 头像：加载失败回退姓名首字（同旧实现 img error 事件切换 hidden；换账号时重置失败标记） */
function Avatar({ user }: { user: CloudUser }): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [user?.id]);
  const name = user?.name || '未知用户';
  const avatar = user?.avatar ?? null;
  return (
    <div className="profile-avatar">
      <img alt="" hidden={!avatar || failed} src={avatar ?? undefined} onError={() => setFailed(true)} />
      <span hidden={!!avatar && !failed}>{name.slice(0, 1)}</span>
    </div>
  );
}

export function ProfileView({ status, waiting, onLogin, onCancelLogin, onLogout }: ProfileViewProps): JSX.Element | null {
  if (!status) return null; // 状态未加载完成：保持空白（同旧实现 renderProfile 的 early return）

  /** 「打开官网」：只显示文字链接，服务器地址不在页面任何位置展示 */
  const openSite = (): void => {
    if (!status.serverUrl) return;
    void openUrl(status.serverUrl).catch((e) => toast(`打开官网失败: ${String(e)}`, 'error'));
  };

  const siteRow = (
    <div className="cloud-site-row">
      <span className="hint">云平台</span>
      <a className="cloud-site-link" onClick={openSite}><Icon name="externalLink" /> 打开官网</a>
    </div>
  );

  // 未接入云服务：构建期未注入服务器地址/应用凭据
  if (!status.serverUrl) {
    return (
      <div className="cloud-empty">
        <div>当前构建未配置云服务（缺少服务器地址或应用凭据），云功能不可用。</div>
        <div className="hint">本应用由管理员构建时注入云平台地址；个人构建与开源构建不携带云功能。</div>
      </div>
    );
  }

  // 未登录：登录入口 + 登录等待态
  if (!status.loggedIn) {
    return (
      <div className="cloud-empty">
        <div>登录公司账号后，可直接使用公司统一管理的模型与搜索服务，无需自行配置密钥。</div>
        {siteRow}
        {waiting ? (
          <>
            <div className="login-waiting">
              <div className="spinner"></div>
              <div>
                <div>已在浏览器打开授权页，请完成登录…</div>
                <div className="hint">2 分钟内未完成将自动取消；授权成功后本页自动刷新</div>
              </div>
            </div>
            <button id="btn-cancel-login" className="btn small" onClick={onCancelLogin}>取消登录</button>
          </>
        ) : (
          <button id="btn-login" className="btn primary" onClick={onLogin}>登录</button>
        )}
      </div>
    );
  }

  // 已登录：资料卡 + 模式切换 + 退出登录
  const user = status.user;
  const name = user?.name || '未知用户';
  const dept = user?.dept ?? null;

  const setMode = (mode: CloudMode): void => {
    cloudSetMode(mode).catch((e) => toast(`切换模式失败: ${String(e)}`, 'error'));
  };

  return (
    <>
      <div className="profile-card">
        {user ? <Avatar user={user} /> : <div className="profile-avatar"><span>{name.slice(0, 1)}</span></div>}
        <div className="profile-meta">
          <div className="profile-name">{name}</div>
          {dept ? <div className="profile-dept">{dept}</div> : null}
        </div>
      </div>
      {siteRow}
      <div className="field">
        <label>使用模式</label>
        <div className="mode-switch">
          <label className={`mode-option${status.mode === 'hosted' ? ' active' : ''}`}
                 title="公司服务器统一管理模型与搜索，本地无需配置密钥">
            <input type="radio" name="cloud-mode" value="hosted" checked={status.mode === 'hosted'}
                   onChange={() => setMode('hosted')} /> 托管模式
          </label>
          <label className={`mode-option${status.mode === 'personal' ? ' active' : ''}`}
                 title="本地自配密钥，行为与未接入云服务一致">
            <input type="radio" name="cloud-mode" value="personal" checked={status.mode === 'personal'}
                   onChange={() => setMode('personal')} /> 个人模式
          </label>
        </div>
        <div className="hint">托管模式下 LLM / 搜索配置由公司服务器提供；个人模式行为与本地配置一致</div>
      </div>
      <div className="form-actions">
        <button id="btn-logout" className="btn danger-solid small" onClick={onLogout}>
          <Icon name="logout" /> 退出登录
        </button>
      </div>
    </>
  );
}
