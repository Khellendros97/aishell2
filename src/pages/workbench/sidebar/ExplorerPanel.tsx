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
 * 2026-10 新增:标题栏排序方式下拉框(名称/修改时间 × 正倒序),事实源在 explorer/tree.ts,
 * 目录始终排在文件之前,默认名称正序 = fs_list 后端顺序(无 proto/legacy 对照)。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../shared/Icon';
import type { SidebarPanelDef } from './panel-types';
import { useWorkbench } from '../../../stores/workbench';
import {
  getSortMode, mountExplorer, revealLocalPath, setSortMode, startInlineInput, refreshAll,
  type SortMode,
} from './explorer/explorer';
import './explorer.css';

export { revealLocalPath };

/** 面板主体:挂载独立容器(mountExplorer 的 container),卸载清理由 useEffect return 承担。
 *  与 AiPanel 同语义的 project 门控:explorer 强依赖 project.path,而 Workbench 异步装载
 *  项目(先渲染侧栏后 setProject)。若 project 就绪前挂载引擎,首次 render 会读到
 *  project==null 而误显示「未设置本地路径」;用 hasProject 订阅在该时刻之后才挂载,
 *  setProject 完成即自动 mount 并正确渲染(切面板重挂亦可覆写)。 */
function ExplorerPanelBody(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const hasProject = useWorkbench((s) => s.project != null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !hasProject) return;
    return mountExplorer(el);
  }, [hasProject]);
  /* 容器复刻 .wbs-panel-root 的滚动/flex 语义(legacy 的 container 即 panelRoot,
     render 依赖 container.scrollTop 做滚动位置保持) */
  return (
    <div
      ref={rootRef}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
    />
  );
}

/** 侧栏头操作区(legacy explorerHead.renderActions:新建文件 / 新建目录 / 刷新 + 排序方式下拉框) */
function ExplorerHeadActions(): JSX.Element {
  // 排序方式事实源在 explorer/tree.ts(模块级,跨面板切换保留);此处只做受控镜像
  const [sort, setSort] = useState<SortMode>(getSortMode);
  const onSortChange = (mode: SortMode): void => {
    setSort(mode);
    setSortMode(mode); // 触发树重绘(不重载目录)
  };
  return (
    <span className="wbs-explorer-head-actions">
      <select
        className="select wbs-explorer-sort"
        title="排序方式：名称 / 修改时间，↑ 正序 ↓ 倒序（目录始终排在文件之前）"
        aria-label="排序方式"
        value={sort}
        onChange={(e) => onSortChange(e.currentTarget.value as SortMode)}
      >
        <option value="name">名称 ↑</option>
        <option value="name-desc">名称 ↓</option>
        <option value="mtime">时间 ↑</option>
        <option value="mtime-desc">时间 ↓</option>
      </select>
      <button className="icon-btn" title="新建文件" onClick={() => startInlineInput(false, null, null)}>
        <Icon name="filePlus" />
      </button>
      <button className="icon-btn" title="新建目录" onClick={() => startInlineInput(true, null, null)}>
        <Icon name="folderPlus" />
      </button>
      <button className="icon-btn" title="刷新" onClick={() => void refreshAll()}>
        <Icon name="refresh" />
      </button>
    </span>
  );
}

export const explorerPanel: SidebarPanelDef = {
  title: '文件资源管理器',
  HeadActions: ExplorerHeadActions,
  Panel: ExplorerPanelBody,
};
