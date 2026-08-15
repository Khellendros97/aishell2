/** 服务器列表侧栏面板(React 迁移占位,由子代理替换;serversPanel 导出名与契约不得变更)。 */
import type { SidebarPanelDef } from './panel-types';

function ServersPanelBody(): JSX.Element {
  return <div className="wbs-stub" style={{ padding: 16, color: 'var(--text-2)' }}>服务器列表 React 迁移中…</div>;
}

export const serversPanel: SidebarPanelDef = {
  title: '服务器列表',
  Panel: ServersPanelBody,
};
