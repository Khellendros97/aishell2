/**
 * 浏览器标签页(React 薄壳,全新功能,无 .proto 对照)。命令式引擎在 ./browser-engine.ts,
 * 后端接口点:browser_* 命令 + browser:event 事件(Rust browser.rs),详见引擎头部注释。
 * keep-alive 契约(见 registry.ts):本组件常驻挂载、active 只切显隐——
 * active 变化时仅调 setTabActive 切换子 webview 显隐与 rect 同步;
 * 标签关闭(卸载)才隐藏 webview(webview 本体在 Rust 侧全局保留,再开同 id 标签恢复)。
 * 全局限定单实例:打开入口用固定 tab id 'browser',openTab 同 id 去重激活。
 */
import { useEffect, useRef } from 'react';
import type { TabProps } from '../../../stores/workbench';
import { mountBrowser, setTabActive } from './browser-engine';
import './browser.css';

function BrowserTab({ tab, active }: TabProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    return mountBrowser(el, active);
  }, [tab.id]); // 固定单实例标签:引擎状态模块级,不随 active 重建
  useEffect(() => {
    setTabActive(active);
  }, [active]);
  return <div ref={rootRef} className="browser-tab-root" />;
}

export default BrowserTab;
