/**
 * 顶层错误边界：任何组件渲染抛错时兜底显示错误信息 + 重新加载按钮，
 * 避免 React 18 无边界时卸载整棵树导致的无声白屏（曾因 setState updater 内
 * 读取 e.currentTarget 为 null 白屏，根因已修；此处为最后防线，保证错误可见可恢复）。
 * 样式全部内联：出错时不再假设 design.css 结构可用，仅依赖 body 上的主题变量。
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('渲染错误（ErrorBoundary 捕获）:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const box: React.CSSProperties = {
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
      background: 'var(--bg-0, #16181d)', color: 'var(--text-1, #e6e6e6)',
      fontFamily: 'inherit', textAlign: 'center',
    };
    return (
      <div style={box}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>界面渲染出错</div>
        <div style={{ fontFamily: 'Consolas, monospace', fontSize: 12, opacity: 0.75, maxWidth: 640, whiteSpace: 'pre-wrap' }}>
          {String(this.state.error)}
        </div>
        <button className="btn primary" onClick={() => location.reload()}>重新加载</button>
      </div>
    );
  }
}
