/**
 * AI 助手面板 React 薄壳（对照 legacy/pages/workbench/ai.ts 的 mountAiPanel 语义）：
 * 引擎为命令式模块 ai-engine.ts（逐行移植 legacy 逻辑），本组件只负责挂载/清理。
 * 挂载契约：mountAiPanel(el) 内部写 wbHandles.ai、注册 wbEvents/store 监听与键盘策略，
 * 返回清理函数（退订监听、wbHandles.ai 置 null、aiKillProject 清理 pi 进程）——useEffect
 * 的 cleanup 直接透传，组件卸载即全面回收。
 * 容器样式：legacy 由外壳 #ai-panel（display:flex column，见 workbench.css）直接提供布局，
 * 引擎子元素 #ai-chat 依赖 flex:1 撑开；React 版容器改为本组件根 div，需 height:100% 继承
 * #ai-panel 高度，并自身保持 flex column，让引擎内部布局逐字生效。
 * 与后端的接口点：见 ai-engine.ts 文件头。
 */
import { useEffect, useRef } from 'react';
import { mountAiPanel } from './ai-engine';

export function AiPanel(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return mountAiPanel(el); // 挂载 + 返回清理
  }, []);
  return <div ref={ref} style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }} />;
}
