/** SFTP 文件传输标签页(React 迁移占位,由子代理替换为完整实现;导出名与 props 契约不得变更)。 */
import type { TabProps } from '../../../stores/workbench';

export function SftpTab(_props: TabProps): JSX.Element {
  return <div className="wb-tab-stub" style={{ padding: 24, color: 'var(--text-2)' }}>SFTP 文件传输模块 React 迁移中…</div>;
}
