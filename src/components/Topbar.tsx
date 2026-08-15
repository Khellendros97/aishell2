/**
 * 顶栏组件(React 版):对照 src/components/topbar.ts,DOM 结构与类名不变。
 * 无边框窗口(decorations:false)下兼作自绘标题栏:整条 bar 标记 data-tauri-drag-region 拖拽;
 * Windows 会原生处理拖拽区双击最大化;右侧内嵌最小化 / 最大化-还原 / 关闭按钮。
 * 「返回工作台」箭头:仅 welcome/settings 且工作台有保活项目时出现(props.workbenchProjectId)。
 */
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { setTheme } from '../api';
import { navigate } from '../router';
import { applyTheme, currentTheme, onThemeChange } from '../theme';
import { toast } from '../ui';
import { Icon } from '../shared/Icon';

export type TopbarPage = 'welcome' | 'settings' | null;

const appWin = getCurrentWindow();
const appLogoUrl = new URL('../assets/logo.svg', import.meta.url).href;

export function Topbar({ activePage, workbenchProjectId }: {
  activePage: TopbarPage;
  /** App.tsx 维护的保活工作台项目 id;null = 无保活实例(不渲染返回箭头) */
  workbenchProjectId?: string | null;
}): JSX.Element {
  const [version, setVersion] = useState('');
  const [maximized, setMaximized] = useState(false);
  const [theme, setThemeState] = useState(currentTheme());

  useEffect(() => {
    // 版本号(tauri.conf.json version,异步填充;失败静默留空)
    getVersion().then(setVersion).catch(() => { /* 版本号获取失败不影响顶栏 */ });
  }, []);

  useEffect(() => {
    // Win+方向键等系统途径触发的最大化也要同步图标
    const unlistenP = appWin.onResized(() => { void appWin.isMaximized().then(setMaximized); });
    void appWin.isMaximized().then(setMaximized);
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
      <button className={`btn small${activePage === 'settings' ? '' : ' ghost'}`} onClick={() => navigate('#/settings')}>设置</button>
      <button className="icon-btn tb-theme" title="切换亮色 / 深色主题" onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
      <div className="tb-win-controls">
        <button className="tb-win-btn tb-win-min" title="最小化" onClick={() => { void appWin.minimize(); }}><Icon name="minus" /></button>
        <button className="tb-win-btn tb-win-max" title="最大化 / 还原" onClick={() => { void appWin.toggleMaximize(); }}><Icon name={maximized ? 'restore' : 'square'} /></button>
        <button className="tb-win-btn tb-win-close" title="关闭" onClick={() => { void appWin.close(); }}><Icon name="x" /></button>
      </div>
    </div>
  );
}
