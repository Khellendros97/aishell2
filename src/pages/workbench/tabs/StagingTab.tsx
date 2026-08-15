/** 远程暂存标签页(React 迁移占位,由子代理替换为完整实现;导出名与 props 契约不得变更)。 */
import type { TabProps } from '../../../stores/workbench';

export function StagingTab(_props: TabProps): JSX.Element {
  return <div className="wb-tab-stub" style={{ padding: 24, color: 'var(--text-2)' }}>远程暂存模块 React 迁移中…</div>;
}
