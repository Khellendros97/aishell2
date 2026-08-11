/**
 * 账号页（#/account）—— 云服务 OAuth2 登录/资料/模式切换（CR-1.1）。
 * 数据源：cloud_status（Rust 端单一事实源，token 永不返回前端）；
 * 登录流程：cloud_begin_login 返回授权 URL → 系统浏览器打开云平台授权页 →
 * 本地回环回调（127.0.0.1:38901）收 code → 后端换令牌/拉资料 → cloud:changed 驱动刷新。
 * 服务端协议以 docs/AIShell云服务-OAuth2接入文档.md 为准。
 */
import type { CloudStatus } from '../types';
import {
  cloudBeginLogin,
  cloudCancelLogin,
  cloudLogout,
  cloudSetMode,
  cloudStatus,
  onCloudChanged,
} from '../api';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toast } from '../ui';
import { icon } from '../icons';
import type { PageRender } from '../main';
import './account.css';

/** 登录等待超时（与后端 LOGIN_TIMEOUT 120s 一致）：超时自动恢复按钮 */
const LOGIN_WAIT_MS = 120_000;

export const renderAccount: PageRender = (root) => {
  root.classList.add('settings-page', 'account-page');

  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting = false;
  let lastStatus: CloudStatus | null = null;

  root.insertAdjacentHTML('beforeend', `
    <div id="settings-layout">
      <main id="settings-content">
        <section id="panel-account" class="settings-panel">
          <div class="panel-head"><div class="panel-title">${icon('user')} 账号</div></div>
          <div id="account-body"></div>
        </section>
      </main>
    </div>
  `);
  const body = root.querySelector('#account-body')!;

  const clearWait = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    waiting = false;
  };

  const startLogin = async () => {
    waiting = true;
    render(lastStatus);
    let url: string;
    try {
      url = await cloudBeginLogin();
    } catch (e) {
      waiting = false;
      render(lastStatus);
      toast(`登录发起失败: ${String(e)}`, 'error');
      return;
    }
    try {
      await openUrl(url);
    } catch {
      // 打开浏览器失败不阻塞等待：用户可手动复制地址；后端回调仍在监听
    }
    timer = setTimeout(() => {
      waiting = false;
      void cloudStatus()
        .then((s) => { lastStatus = s; render(s); })
        .catch(() => render(lastStatus));
      toast('登录超时，已自动取消，请重试', 'info');
    }, LOGIN_WAIT_MS);
  };

  const cancelLogin = async () => {
    clearWait();
    try { await cloudCancelLogin(); } catch { /* 无进行中会话时静默 */ }
    render(lastStatus);
  };

  const doLogout = async () => {
    clearWait();
    try {
      await cloudLogout();
      toast('已退出登录', 'info');
    } catch (e) {
      toast(`退出登录失败: ${String(e)}`, 'error');
    }
    // cloud:changed 驱动刷新；失败场景下主动拉一次兜底
    void cloudStatus().then((s) => { lastStatus = s; render(s); }).catch(() => {});
  };

  const render = (status: CloudStatus | null) => {
    if (!status) return;
    lastStatus = status;

    if (!status.serverUrl) {
      body.innerHTML = `
        <div class="cloud-empty">
          <div>当前构建未配置云服务（缺少服务器地址或应用凭据），云功能不可用。</div>
          <div class="hint">本应用由管理员构建时注入云平台地址；个人构建与开源构建不携带云功能。</div>
        </div>`;
      return;
    }

    if (!status.loggedIn) {
      body.innerHTML = `
        <div class="cloud-empty">
          <div>登录公司账号后，可直接使用公司统一管理的模型与搜索服务，无需自行配置密钥。</div>
          <div class="field">
            <label>服务器地址</label>
            <input class="input mono" value="${escapeHtml(status.serverUrl)}" readonly>
          </div>
          ${waiting ? `
            <div class="login-waiting">
              <div class="spinner"></div>
              <div>
                <div>已在浏览器打开授权页，请完成登录…</div>
                <div class="hint">2 分钟内未完成将自动取消；授权成功后本页自动刷新</div>
              </div>
            </div>
            <button id="btn-cancel-login" class="btn small">取消登录</button>
          ` : `
            <button id="btn-login" class="btn primary">登录</button>
          `}
        </div>`;
      if (waiting) {
        body.querySelector('#btn-cancel-login')!.addEventListener('click', () => void cancelLogin());
      } else {
        body.querySelector('#btn-login')!.addEventListener('click', () => void startLogin());
      }
      return;
    }

    // 已登录
    const user = status.user;
    const name = user?.name || '未知用户';
    const dept = user?.dept || null;
    const avatar = user?.avatar || null;
    body.innerHTML = `
      <div class="profile-card">
        <div class="profile-avatar">
          <img alt="" data-avatar-img ${avatar ? `src="${escapeHtml(avatar)}"` : 'hidden'}>
          <span data-avatar-fallback ${avatar ? 'hidden' : ''}>${escapeHtml(name.slice(0, 1))}</span>
        </div>
        <div class="profile-meta">
          <div class="profile-name">${escapeHtml(name)}</div>
          ${dept ? `<div class="profile-dept">${escapeHtml(dept)}</div>` : ''}
        </div>
      </div>
      <div class="field">
        <label>服务器地址</label>
        <input class="input mono" value="${escapeHtml(status.serverUrl)}" readonly>
      </div>
      <div class="field">
        <label>使用模式</label>
        <div class="mode-switch">
          <label class="mode-option ${status.mode === 'hosted' ? 'active' : ''}">
            <input type="radio" name="cloud-mode" value="hosted" ${status.mode === 'hosted' ? 'checked' : ''}> 托管模式（公司服务器统一管理模型与搜索）
          </label>
          <label class="mode-option ${status.mode === 'personal' ? 'active' : ''}">
            <input type="radio" name="cloud-mode" value="personal" ${status.mode === 'personal' ? 'checked' : ''}> 个人模式（本地自配密钥）
          </label>
        </div>
        <div class="hint">托管模式下 LLM / 搜索配置由公司服务器提供；个人模式行为与本地配置一致</div>
      </div>
      <div class="form-actions">
        <button id="btn-logout" class="btn danger-solid small">${icon('logout')} 退出登录</button>
      </div>`;
    // 头像加载失败回退姓名首字（CSP 禁内联脚本，用事件绑定）
    const img = body.querySelector('[data-avatar-img]') as HTMLImageElement | null;
    const fb = body.querySelector('[data-avatar-fallback]') as HTMLElement | null;
    if (img && fb) {
      img.addEventListener('error', () => { img.hidden = true; fb.hidden = false; });
    }
    body.querySelector('#btn-logout')!.addEventListener('click', () => void doLogout());
    body.querySelectorAll<HTMLInputElement>('input[name="cloud-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        const mode = radio.value as 'hosted' | 'personal';
        cloudSetMode(mode).catch((e) => toast(`切换模式失败: ${String(e)}`, 'error'));
      });
    });
  };

  void cloudStatus().then((s) => render(s)).catch(() => {});
  const offChanged = onCloudChanged((s) => {
    if (s.loggedIn) clearWait(); // 登录成功：停止等待计时
    lastStatus = s;
    render(s);
  }).catch(() => () => {});

  return () => {
    clearWait();
    void offChanged.then((un) => un()).catch(() => {});
  };
};

/** 极简 HTML 转义（用户资料/服务器地址回显，防注入） */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}
