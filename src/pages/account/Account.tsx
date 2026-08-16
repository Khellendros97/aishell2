/**
 * 账号页（#/account）—— React 版，对照旧实现 src/pages/account.ts 逐条移植。
 * 云服务三页导航：账号信息（ProfileView）/ 用量报表（UsageView）/ 记忆宫殿（MemoriesView）；
 * 顶栏由 App.tsx 提供，本组件不渲染 Topbar，根节点类名与旧版一致（settings-page account-page）。
 * 数据源：cloud_status（Rust 端单一事实源，token 永不返回前端，本页无任何 token 展示）；
 * 用量与记忆数据经 Rust 端代理命令（cloud_usage / memories_*）获取，token 全程留在后端。
 * 登录流程：cloud_begin_login 返回授权 URL → 系统浏览器打开云平台授权页（openUrl）→
 * 本地回环回调（127.0.0.1:38901）收 code → 后端换令牌/拉资料 → cloud:changed 驱动刷新；
 * 等待 120s 超时自动取消（与后端 LOGIN_TIMEOUT 一致）。监听经 useEffect return 反订阅，定时器同清理。
 * 服务端协议以 docs/AIShell云服务-OAuth2接入文档.md、开放API文档.md、记忆卡片API文档.md 为准。
 * 与旧实现的差异：视图内容按需挂载（旧版所有 section 常驻仅切 class），
 * 过滤/作用域状态（usageDays/usageKind/usageModel/memScope）提升到本组件跨子页切换保留，语义等价。
 */
import { useEffect, useRef, useState } from 'react';
import type { CloudStatus, MemoryScope } from '../../types';
import {
  cloudBeginLogin,
  cloudCancelLogin,
  cloudLogout,
  cloudStatus,
  onCloudChanged,
} from '../../api';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toast } from '../../ui';
import { Icon } from '../../shared/Icon';
import { ProfileView } from './ProfileView';
import { UsageView } from './UsageView';
import { MemoriesView } from './MemoriesView';
import '../account.css';

/** 登录等待超时（与后端 LOGIN_TIMEOUT 120s 一致）：超时自动恢复按钮 */
const LOGIN_WAIT_MS = 120_000;

type ViewName = 'profile' | 'usage' | 'memories';

export function Account(_props: { params: URLSearchParams }): JSX.Element {
  /** 云状态（cloud_status 初始拉取 + cloud:changed 驱动刷新；token 不在其中） */
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [view, setView] = useState<ViewName>('profile');
  /** 登录等待中：发起后未回调/未超时（同旧实现 waiting 标志） */
  const [waiting, setWaiting] = useState(false);
  /** 用量过滤状态（跨子页切换保留，同旧实现闭包变量） */
  const [usageDays, setUsageDays] = useState(14);
  const [usageKind, setUsageKind] = useState('');
  const [usageModel, setUsageModel] = useState('');
  /** 记忆列表/检索作用域（同旧实现 memScope） */
  const [memScope, setMemScope] = useState<MemoryScope>('all');

  /** 登录等待定时器（卸载/登录成功/取消时清理） */
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWait = (): void => {
    if (waitTimer.current) { clearTimeout(waitTimer.current); waitTimer.current = null; }
    setWaiting(false);
  };

  /** 发起登录（同旧实现 startLogin）：开浏览器失败不阻塞，后端回调仍在监听，超时自动取消 */
  const startLogin = async (): Promise<void> => {
    setWaiting(true);
    let url: string;
    try {
      url = await cloudBeginLogin();
    } catch (e) {
      setWaiting(false);
      toast(`登录发起失败: ${String(e)}`, 'error');
      return;
    }
    try {
      await openUrl(url);
    } catch {
      // 打开浏览器失败不阻塞等待：用户可手动复制地址；后端回调仍在监听
    }
    if (waitTimer.current) clearTimeout(waitTimer.current);
    waitTimer.current = setTimeout(() => {
      waitTimer.current = null;
      setWaiting(false);
      void cloudStatus().then((s) => setStatus(s)).catch(() => {});
      toast('登录超时，已自动取消，请重试', 'info');
    }, LOGIN_WAIT_MS);
  };

  /** 取消登录（同旧实现 cancelLogin：无进行中会话时静默） */
  const cancelLogin = async (): Promise<void> => {
    clearWait();
    try { await cloudCancelLogin(); } catch { /* 无进行中会话时静默 */ }
  };

  /** 退出登录（同旧实现 doLogout：cloud:changed 驱动刷新；失败场景下主动拉一次兜底） */
  const doLogout = async (): Promise<void> => {
    clearWait();
    try {
      await cloudLogout();
      toast('已退出登录', 'info');
    } catch (e) {
      toast(`退出登录失败: ${String(e)}`, 'error');
    }
    void cloudStatus().then((s) => setStatus(s)).catch(() => {});
  };

  /* 初始化：拉取一次云状态（旧版 renderAccount 结尾同款，失败静默） */
  useEffect(() => {
    let cancelled = false;
    void cloudStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /* cloud:changed 订阅：登录成功停止等待计时；登出/登录失效回到账号信息页。
     onCloudChanged 返回 Promise<UnlistenFn>，卸载时按需反订阅（同旧版 offChanged.then(un => un())） */
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onCloudChanged((s) => {
      if (cancelled) return;
      if (s.loggedIn) clearWait(); // 登录成功：停止等待计时
      setStatus(s);
      // 登出/登录失效：用量与记忆数据失效，回到账号信息页
      if (!s.loggedIn) setView((v) => (v === 'profile' ? v : 'profile'));
    }).then((un) => { if (cancelled) un(); else unlisten = un; })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (waitTimer.current) { clearTimeout(waitTimer.current); waitTimer.current = null; }
    };
    // eslint 语义同旧版一次性订阅：clearWait/setStatus/setView 均稳定
  }, []);

  const navItem = (name: ViewName, icon: 'user' | 'chart' | 'database', title: string, label: string): JSX.Element => (
    <div className={`account-nav-item${view === name ? ' active' : ''}`} data-tab={name} title={title}
         onClick={() => setView(name)}>
      <Icon name={icon} /><span>{label}</span>
    </div>
  );

  return (
    <div className="settings-page account-page">
      <div id="account-layout">
        <aside className="account-nav">
          {navItem('profile', 'user', '账号信息', '账号信息')}
          {navItem('usage', 'chart', '用量报表', '用量报表')}
          {navItem('memories', 'database', '记忆宫殿', '记忆宫殿')}
        </aside>
        <main className="account-content">
          <section className={`account-view${view === 'profile' ? ' active' : ''}`} data-view="profile">
            <div className="account-view-head"><Icon name="user" /> 账号信息</div>
            <div id="account-body" className="account-body">
              {view === 'profile' ? (
                <ProfileView status={status} waiting={waiting}
                             onLogin={() => void startLogin()}
                             onCancelLogin={() => void cancelLogin()}
                             onLogout={() => void doLogout()} />
              ) : null}
            </div>
          </section>
          <section className={`account-view${view === 'usage' ? ' active' : ''}`} data-view="usage">
            <div className="account-view-head"><Icon name="chart" /> 用量报表</div>
            <div id="usage-body" className="account-body">
              {view === 'usage' ? (
                <UsageView status={status} days={usageDays} kind={usageKind} model={usageModel}
                           onFilter={(d, k, m) => { setUsageDays(d); setUsageKind(k); setUsageModel(m); }}
                           onGoLogin={() => setView('profile')} />
              ) : null}
            </div>
          </section>
          <section className={`account-view${view === 'memories' ? ' active' : ''}`} data-view="memories">
            <div className="account-view-head"><Icon name="database" /> 记忆宫殿</div>
            <div id="memories-body" className="account-body">
              {view === 'memories' ? (
                <MemoriesView status={status} scope={memScope} onScopeChange={setMemScope}
                              onGoLogin={() => setView('profile')} />
              ) : null}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
