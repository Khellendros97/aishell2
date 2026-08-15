/** 差异对比标签页(React 迁移占位,由子代理替换为完整实现;导出名与 props 契约不得变更)。 */
import type { TabProps } from '../../../stores/workbench';

export function DiffTab(_props: TabProps): JSX.Element {
  return <div className="wb-tab-stub" style={{ padding: 24, color: 'var(--text-2)' }}>差异对比模块 React 迁移中…</div>;
}
