/**
 * 顶栏组件(React 版):对照 src/components/topbar.ts,DOM 结构与类名不变。
 * 无边框窗口(decorations:false)下兼作自绘标题栏:整条 bar 标记 data-tauri-drag-region 拖拽;
 * Windows 会原生处理拖拽区双击最大化;右侧内嵌最小化 / 最大化-还原 / 关闭按钮。
 * 「返回工作台」箭头:仅 welcome/settings 且工作台有保活项目时出现(props.workbenchProjectId)。
 */
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { setTheme, cloudStatus, onCloudChanged } from '../api';
import type { CloudStatus } from '../types';
import { onUpdateStatus } from '../updates';
import { navigate } from '../router';
import { applyTheme, currentTheme, onThemeChange } from '../theme';
import { toast } from '../ui';
import { Icon } from '../shared/Icon';

export type TopbarPage = 'welcome' | 'settings' | 'account' | null;

const appLogoUrl = new URL('../assets/logo.svg', import.meta.url).href;

/* 惰性获取窗口句柄:模块级 getCurrentWindow() 在无 Tauri 注入的环境(纯浏览器/jsdom)
   会直接抛错炸掉整个入口模块 —— 旧版 topbar.ts 即有此问题,迁移时顺手修复。
   顶栏窗口控制在无句柄环境下降级为无操作,导航/主题等功能不受影响。 */
let appWin: TauriWindow | null = null;
function getWindow(): TauriWindow | null {
  if (appWin) return appWin;
  try { appWin = getCurrentWindow(); } catch { return null; }
  return appWin;
}

/** 容错执行窗口操作(无句柄环境静默跳过) */
function withWindow(fn: (w: TauriWindow) => void | Promise<unknown>): void {
  const w = getWindow();
  if (w) void fn(w);
}

export function Topbar({ activePage, workbenchProjectId }: {
  activePage: TopbarPage;
  /** App.tsx 维护的保活工作台项目 id;null = 无保活实例(不渲染返回箭头) */
  workbenchProjectId?: string | null;
}): JSX.Element {
  const [version, setVersion] = useState('');
  const [maximized, setMaximized] = useState(false);
  const [theme, setThemeState] = useState(currentTheme());
  /* 账号角标(CR-2.4):托管模式 + 未登录(登录失效)时提示「重新登录」 */
  const [accountBadge, setAccountBadge] = useState(false);
  /* 更新角标:发现新版本/下载中/已就绪时挂在「设置」按钮上(状态源 updates.ts 总线,不重复请求) */
  const [updateBadge, setUpdateBadge] = useState(false);

  useEffect(() => {
    const sync = (s: CloudStatus): void => {
      setAccountBadge(!!s.serverUrl && s.mode === 'hosted' && !s.loggedIn);
    };
    // 初始态拉一次(失败静默,未接入/未登录无角标);登录/登出/失效/模式切换后跟随
    let un: (() => void) | null = null;
    void cloudStatus().then(sync).catch(() => {});
    void onCloudChanged(sync).then((u) => { un = u; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  useEffect(() => {
    // 版本号(tauri.conf.json version,异步填充;失败静默留空)
    getVersion().then(setVersion).catch(() => { /* 版本号获取失败不影响顶栏 */ });
  }, []);

  useEffect(() => {
    // 更新状态角标:available/downloading/ready 亮起,进入设置页处理(详情在「关于与更新」)
    return onUpdateStatus((s) => {
      setUpdateBadge(s.enabled && ['available', 'downloading', 'ready'].includes(s.state));
    });
  }, []);

  useEffect(() => {
    // Win+方向键等系统途径触发的最大化也要同步图标(无窗口句柄环境跳过)
    const w = getWindow();
    if (!w) return;
    const unlistenP = w.onResized(() => { void w.isMaximized().then(setMaximized); });
    void w.isMaximized().then(setMaximized);
    return () => { void unlistenP.then((un) => un()); };
  }, []);

  useEffect(() => onThemeChange(() => setThemeState(currentTheme())), []);

  /* 主题快捷切换:立即生效(含终端/编辑器联动),后台持久化;失败回滚 */
  const toggleTheme = (): void => {
    const prev = currentTheme();
    const next = prev === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setThemeState(next);
    setTheme(next).catch((err) => {
      applyTheme(prev);
      setThemeState(prev);
      toast(`主题保存失败: ${String(err)}`, 'error');
    });
  };

  return (
    <div className="page-topbar" data-tauri-drag-region="">
      {activePage && workbenchProjectId ? (
        <button
          className="icon-btn tb-back"
          title="返回工作台"
          onClick={() => navigate(`#/workbench?project=${workbenchProjectId}`)}
        ><Icon name="arrowLeft" /></button>
      ) : null}
      <div className="brand"><img className="logo" src={appLogoUrl} alt="AIShell" /><span>AIShell</span><span className="tb-version">{version ? `v${version}` : ''}</span></div>
      <div className="spacer"></div>
      <button className={`btn small${activePage === 'welcome' ? '' : ' ghost'}`} onClick={() => navigate('#/welcome')}>项目</button>
      <button className={`btn small${activePage === 'settings' ? '' : ' ghost'}`} onClick={() => navigate('#/settings')}>设置<span className="tb-badge" hidden={!updateBadge} title="有可用的应用更新"></span></button>
      <button
        className={`btn small tb-account${activePage === 'account' ? '' : ' ghost'}`}
        onClick={() => navigate('#/account')}
      >
        账号<span className="tb-badge" hidden={!accountBadge} title="登录已过期,请重新登录"></span>
      </button>
      <button className="icon-btn tb-theme" title="切换亮色 / 深色主题" onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
      <div className="tb-win-controls">
        <button className="tb-win-btn tb-win-min" title="最小化" onClick={() => withWindow((w) => w.minimize())}><Icon name="minus" /></button>
        <button className="tb-win-btn tb-win-max" title="最大化 / 还原" onClick={() => withWindow((w) => w.toggleMaximize())}><Icon name={maximized ? 'restore' : 'square'} /></button>
        <button className="tb-win-btn tb-win-close" title="关闭" onClick={() => withWindow((w) => w.close())}><Icon name="x" /></button>
      </div>
    </div>
  );
}
