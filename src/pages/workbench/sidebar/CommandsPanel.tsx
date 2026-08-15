/** 命令收藏侧栏面板(React 迁移占位,由子代理替换;commandsPanel 导出名与契约不得变更)。 */
import type { SidebarPanelDef } from './panel-types';

function CommandsPanelBody(): JSX.Element {
  return <div className="wbs-stub" style={{ padding: 16, color: 'var(--text-2)' }}>命令收藏 React 迁移中…</div>;
}

export const commandsPanel: SidebarPanelDef = {
  title: '命令收藏',
  Panel: CommandsPanelBody,
};
