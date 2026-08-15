/** AI 助手面板(React 迁移占位,由子代理替换为完整实现;导出名不得变更)。
 *  挂载时须写 wbHandles.ai、卸载时清空(标签栏右键「添加到对话」等外部入口依赖)。 */
export function AiPanel(): JSX.Element {
  return <div className="ai-stub" style={{ padding: 16, color: 'var(--text-2)' }}>AI 面板 React 迁移中…</div>;
}
