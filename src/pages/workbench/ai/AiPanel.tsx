/**
 * AI 助手面板 React 薄壳（对照 legacy/pages/workbench/ai.ts 的 mountAiPanel 语义）：
 * 引擎为命令式模块 ai-engine.ts（逐行移植 legacy 逻辑），本组件只负责挂载/清理。
 * 挂载契约：工作台上下文写 wbHandles.ai 并注册 wbEvents/store 监听；欢迎页任务上下文
 * 通过 props 显式传项目并关闭这些联动。引擎返回控制器，cleanup 仅回收当前视图监听，
 * 项目上下文、事件订阅和 pi 进程继续保留，以支持切路由期间后台收流。
 * 容器样式：legacy 由外壳 #ai-panel（display:flex column，见 workbench.css）直接提供布局，
 * 引擎子元素 #ai-chat 依赖 flex:1 撑开；React 版容器改为本组件根 div，需 height:100% 继承
 * #ai-panel 高度，并自身保持 flex column，让引擎内部布局逐字生效。
 * 与后端的接口点：见 ai-engine.ts 文件头。
 */
import { useEffect, useRef } from 'react';
import type { Project } from '../../../types';
import { mountAiPanel, type AiPanelController } from './ai-engine';

export interface AiPanelProps {
  project?: Project;
  workbenchIntegration?: boolean;
  fixedWorkareaPath?: string;
  lockedMode?: 'suggest' | 'agent' | 'yolo';
  onReady?(controller: AiPanelController): void;
}

export function AiPanel({ project, workbenchIntegration, fixedWorkareaPath, lockedMode, onReady }: AiPanelProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const controller = mountAiPanel(el, { project, workbenchIntegration, fixedWorkareaPath, lockedMode });
    onReadyRef.current?.(controller);
    return controller.cleanup;
  }, [fixedWorkareaPath, lockedMode, project, workbenchIntegration]);
  return <div ref={ref} style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }} />;
}
