/**
 * 侧栏面板模块契约(React 迁移新增):explorer/servers/commands/skills 四个侧栏面板
 * 各自聚合为一个 SidebarPanelDef,由 Workbench 外壳按当前面板渲染。
 * 对照旧版 workbench.ts 的 HEADS/MOUNTS 注册表(renderActions + mount(container) 清理函数)
 * —— HeadActions/Panel 的卸载清理改由组件 useEffect return 承担。
 */
import type { ComponentType } from 'react';

export interface SidebarPanelDef {
  /** 侧栏头标题(旧 HEADS[panel].title) */
  title: string;
  /** 侧栏头操作按钮区(旧 renderActions;无则为空) */
  HeadActions?: ComponentType;
  /** 面板主体(挂载进 .wbs-panel-root) */
  Panel: ComponentType;
}
