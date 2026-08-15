/** 欢迎页(React 迁移占位,由子代理替换为完整实现;导出名与 props 契约不得变更)。
 *  对照 .proto/index.html / welcome 相关原型;顶栏由 App.tsx 提供,本组件不渲染 Topbar。 */

export function Welcome(_props: { params: URLSearchParams }): JSX.Element {
  return <div style={{ padding: 24, color: 'var(--text-2)' }}>欢迎页 React 迁移中…</div>;
}
