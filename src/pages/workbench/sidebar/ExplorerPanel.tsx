/**
 * 文件资源管理器侧栏面板(React 迁移聚合入口,整文件替换占位)。
 * 对照 legacy/pages/workbench/sidebar/explorer.ts(1105 行):
 * - explorerHead(renderActions)→ ExplorerHeadActions(HeadActions 组件:新建文件/新建目录/刷新);
 * - mountExplorerPanel(panelRoot)→ 本组件 useEffect 挂载独立容器、return 清理(mountExplorer);
 * - 全部树/渲染/拖拽/菜单/快捷键逻辑在 ./explorer/{tree,explorer}.ts(命令式模块,
 *   与 SftpTab 同款迁移形态,保证 DOM 类名 / 交互 / 文案与 legacy 逐条一致);
 * - 模块级树状态(根节点/展开集合/选中路径)跨面板切换保留,与 legacy 卸载即弃容器一致;
 * - 样式复用 explorer.css(此处 import)。
 * 对外导出契约(不得变更):explorerPanel: SidebarPanelDef(panels.ts 接线);
 * revealLocalPath(path) 在资源管理器中定位文件(SftpTab 下载完成后 import 调用,
 * 实现 = setPanel('explorer') + 面板内展开定位,详见 explorer/explorer.ts)。
 */
import { useEffect, useRef } from 'react';
import { Icon } from '../../../shared/Icon';
import type { SidebarPanelDef } from './panel-types';
import { mountExplorer, revealLocalPath, startInlineInput, refreshAll } from './explorer/explorer';
import './explorer.css';

export { revealLocalPath };

/** 面板主体:挂载独立容器(mountExplorer 的 container),卸载清理由 useEffect return 承担 */
function ExplorerPanelBody(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    return mountExplorer(el);
  }, []);
  /* 容器复刻 .wbs-panel-root 的滚动/flex 语义(legacy 的 container 即 panelRoot,
     render 依赖 container.scrollTop 做滚动位置保持) */
  return (
    <div
      ref={rootRef}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
    />
  );
}

/** 侧栏头操作区(legacy explorerHead.renderActions:新建文件 / 新建目录 / 刷新) */
function ExplorerHeadActions(): JSX.Element {
  return (
    <>
      <button className="icon-btn" title="新建文件" onClick={() => startInlineInput(false, null, null)}>
        <Icon name="filePlus" />
      </button>
      <button className="icon-btn" title="新建目录" onClick={() => startInlineInput(true, null, null)}>
        <Icon name="folderPlus" />
      </button>
      <button className="icon-btn" title="刷新" onClick={() => void refreshAll()}>
        <Icon name="refresh" />
      </button>
    </>
  );
}

export const explorerPanel: SidebarPanelDef = {
  title: '文件资源管理器',
  HeadActions: ExplorerHeadActions,
  Panel: ExplorerPanelBody,
};
