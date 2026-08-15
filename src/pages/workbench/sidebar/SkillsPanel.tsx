/** Skill 侧栏面板(React 迁移占位,由子代理替换;skillsPanel 导出名与契约不得变更)。 */
import type { SidebarPanelDef } from './panel-types';

function SkillsPanelBody(): JSX.Element {
  return <div className="wbs-stub" style={{ padding: 16, color: 'var(--text-2)' }}>Skill 面板 React 迁移中…</div>;
}

export const skillsPanel: SidebarPanelDef = {
  title: 'Skill',
  Panel: SkillsPanelBody,
};
