/** 文件资源管理器侧栏面板(React 迁移占位,由子代理替换;explorerPanel 导出名与契约不得变更)。 */
import type { SidebarPanelDef } from './panel-types';

function ExplorerPanelBody(): JSX.Element {
  return <div className="wbs-stub" style={{ padding: 16, color: 'var(--text-2)' }}>资源管理器 React 迁移中…</div>;
}

export const explorerPanel: SidebarPanelDef = {
  title: '文件资源管理器',
  Panel: ExplorerPanelBody,
};
