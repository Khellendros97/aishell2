/**
 * 侧栏面板注册表(React 迁移新增):面板 key → 模块定义聚合点。
 * 对照旧版 workbench.ts 的 HEADS/MOUNTS;新增面板往这里接线。
 */
import type { PanelKey } from '../../../stores/workbench';
import type { SidebarPanelDef } from './panel-types';
import { explorerPanel } from './ExplorerPanel';
import { serversPanel } from './ServersPanel';
import { commandsPanel } from './CommandsPanel';
import { skillsPanel } from './SkillsPanel';

export const PANELS: Record<PanelKey, SidebarPanelDef> = {
  explorer: explorerPanel,
  servers: serversPanel,
  commands: commandsPanel,
  skills: skillsPanel,
};
