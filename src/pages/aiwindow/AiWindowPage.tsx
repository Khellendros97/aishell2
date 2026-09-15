/**
 * AI 助手分离窗口页面（无 .proto 对照，新增交互；后端接口点见 src-tauri/src/ai_window.rs）。
 * 由后端 WebviewWindowBuilder 创建 label = "ai-detach" 的独立 OS 窗口加载同一份 index.html，
 * initialization_script 注入 hash：#/ai-window?project=<id>&session=<sid>&host=<workbench|welcome>。
 * 布局 = 自绘迷你标题栏（decorations:false：拖拽区 + 最小化/最大化/关闭，样式对齐主窗口 Topbar）
 * + 全高 AiPanel（workbenchIntegration=false，无终端/浏览器联动）。
 * 宿主窗口的「添加到对话」经 ai_forward_ref 命令 + ai:forward-ref:<projectId> 事件转发进来，
 * 由 ai-engine 的转发分发插入引用 chip。
 * 关闭（按钮/X）=「关闭即聚合」：close 触发 closeRequested → 引擎 releaseAllProjectContexts
 * （flush 落盘 + 退订）→ 放行销毁 → 后端 Destroyed 广播 ai:window-changed {detached:false}，
 * 宿主窗口据此重挂侧栏 AI 面板。
 * 会话连续性：pi 进程与 aishell.json 会话快照 app 级共享，本窗口重新挂载拉全量历史即可续流。
 */
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { getTaskProject, getState } from '../../api';
import type { Project } from '../../types';
import { Icon } from '../../shared/Icon';
import { AiPanel } from '../workbench/ai/AiPanel';
import './aiwindow.css';

/** 本窗口的分离模式（模块级常量：避免每次渲染新对象触发 AiPanel 重挂） */
const DETACHED = { role: 'detached' } as const;

/* 惰性获取窗口句柄（同 Topbar）：无 Tauri 注入环境（纯浏览器）降级为无操作 */
let appWin: TauriWindow | null = null;
function getWindow(): TauriWindow | null {
  if (appWin) return appWin;
  try { appWin = getCurrentWindow(); } catch { return null; }
  return appWin;
}

export function AiWindowPage({ params }: { params: URLSearchParams }): JSX.Element {
  const projectId = params.get('project');
  const sessionId = params.get('session');
  const host = params.get('host') === 'welcome' ? 'welcome' : 'workbench';
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);

  /* 项目装载：普通项目在 projects 列表里；欢迎页任务上下文是隐藏项目，走 get_task_project */
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!projectId) {
        if (alive) setError('缺少项目参数');
        return;
      }
      try {
        const state = await getState();
        const found = state.projects.find((p) => p.id === projectId) ?? null;
        if (found) {
          if (alive) setProject(found);
          return;
        }
        if (host === 'welcome') {
          const task = await getTaskProject();
          if (task?.id === projectId) {
            if (alive) setProject(task);
            return;
          }
        }
        if (alive) setError('项目不存在或已被删除');
      } catch (err) {
        if (alive) setError(`加载项目失败: ${String(err)}`);
      }
    })();
    return () => { alive = false; };
  }, [host, projectId]);

  /* Win+方向键等系统途径的最大化也要同步图标（无窗口句柄环境跳过，同 Topbar） */
  useEffect(() => {
    const w = getWindow();
    if (!w) return;
    const unlistenP = w.onResized(() => { void w.isMaximized().then(setMaximized); });
    void w.isMaximized().then(setMaximized);
    return () => { void unlistenP.then((un) => un()); };
  }, []);

  return (
    <div className="aiwin-page">
      <div className="aiwin-titlebar" data-tauri-drag-region="">
        <div className="aiwin-title" data-tauri-drag-region="" title={project ? `AI 助手 · ${project.name}` : 'AI 助手'}>
          <Icon name="bot" />
          <span>{project ? `AI 助手 · ${project.name}` : 'AI 助手'}</span>
        </div>
        <div className="tb-win-controls">
          <button className="tb-win-btn tb-win-min" title="最小化" onClick={() => getWindow()?.minimize()}><Icon name="minus" /></button>
          <button className="tb-win-btn tb-win-max" title="最大化 / 还原" onClick={() => { const w = getWindow(); if (w) void w.toggleMaximize(); }}><Icon name={maximized ? 'restore' : 'square'} /></button>
          {/* 关闭即聚合：关窗流程见文件头说明（引擎释放上下文后放行，宿主自动还原面板） */}
          <button className="tb-win-btn tb-win-close" title="关闭（聚合回主窗口）" onClick={() => { const w = getWindow(); if (w) void w.close(); }}><Icon name="x" /></button>
        </div>
      </div>
      <div className="aiwin-body">
        {project ? (
          <AiPanel
            project={project}
            workbenchIntegration={false}
            fixedWorkareaPath={project.path ?? undefined}
            lockedMode={host === 'welcome' ? 'agent' : undefined}
            detach={DETACHED}
            initialSessionId={sessionId ?? undefined}
          />
        ) : (
          <div className="aiwin-empty">
            <Icon name={error ? 'alert' : 'loader'} />
            <strong>{error ?? '正在加载项目…'}</strong>
          </div>
        )}
      </div>
    </div>
  );
}
