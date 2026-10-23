/**
 * 应用根组件:三页 hash 路由容器 + 工作台保活(React 版,对照旧版 main.ts 的 render())。
 * 保活语义(与旧版逐条对齐,勿改):
 * - 子页(welcome/settings)随路由挂载/卸载,顶栏由本组件渲染;
 * - 工作台实例离开路由只隐藏不销毁(display:none 保持挂载,终端/SSH/AI 会话全部保留),
 *   同项目回归原样复用(含裸 '#/workbench',目标项目即保活项目);
 * - 换项目才销毁重建(key 变更触发整树卸载 → Workbench 卸载清理关闭全部标签);
 * - 装载失败(无项目/后端异常,Workbench 已自行导航离开)或装载期间离开路由 → 销毁实例。
 * 与后端接口点:监听 api.ts 的 config:changed，将 Python SDK 导入结果分发给欢迎页和工作台面板。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getState, onConfigChanged, onSsoError, onSsoOpen, ssoTakePending } from './api';
import { navigate } from './router';
import { useHashRoute } from './shared/useHashRoute';
import { useWorkbench, wbEvents } from './stores/workbench';
import { confirmDialog, toast, uid } from './ui';
import type { SsoOpen } from './types';
import { Topbar } from './components/Topbar';
import { Welcome } from './pages/welcome/Welcome';
import { Settings } from './pages/settings/Settings';
import { Account } from './pages/account/Account';
import { AiWindowPage } from './pages/aiwindow/AiWindowPage';
import Workbench from './pages/workbench/Workbench';

interface WbInstance {
  /** 实例序号:换项目销毁重建时 +1(React key) */
  key: number;
  /** 本实例创建时的路由目标项目参数(装载中的同目标复用判定用) */
  targetParam: string | null;
  /** 装载成功的项目 id;null = 装载中或已失败 */
  projectId: string | null;
}

export default function App(): JSX.Element {
  const route = useHashRoute();
  const isWb = route.name === '/workbench';
  const target = isWb ? route.params.get('project') : null;
  const [wb, setWb] = useState<WbInstance | null>(null);
  /** 最新 wb 快照：SSO 事件监听只注册一次，回调不能读渲染闭包里的旧值 */
  const wbRef = useRef<WbInstance | null>(null);
  wbRef.current = wb;
  /** 工作台装载期间收到的 SSO 会话：onReady 后补开标签 */
  const pendingSsoRef = useRef<{ payload: SsoOpen; projectId: string } | null>(null);

  /** 临时会话标签关闭确认：关掉后图标变灰，AI 无法再通过该通道操作服务器 */
  const confirmSsoClose = useCallback((): Promise<boolean> => confirmDialog({
    title: '关闭临时会话标签页？',
    message: '关闭临时会话标签页，会导致AI助手无法连接该服务器',
    okText: '仍然关闭',
    danger: true,
  }), []);

  /** 在已装载的工作台里打开一次性 SSO 标签（密码在 Rust 内存，前端只带 serverId）。
      ssh 载荷开终端；xftp 载荷（protocol=sftp）开文件管理器，每次新开唯一 id。 */
  const openSsoTab = useCallback((payload: SsoOpen) => {
    if (payload.protocol === 'sftp') {
      useWorkbench.getState().openTab({
        id: `sftp:${payload.serverId}:${uid('tab')}`,
        type: 'sftp',
        title: `SFTP ${payload.title}`,
        data: { serverId: payload.serverId },
        confirmClose: confirmSsoClose,
      });
      return;
    }
    useWorkbench.getState().openTab({
      id: `term-sso-${payload.serverId}`,
      type: 'terminal',
      title: payload.title,
      data: { kind: 'ssh', serverId: payload.serverId, sso: true },
      confirmClose: confirmSsoClose,
    });
  }, [confirmSsoClose]);

  /** SSO 会话入口：工作台已就绪直接开；否则选项目、导航，等 onReady 补开 */
  const handleSso = useCallback(async (payload: SsoOpen) => {
    const cur = wbRef.current;
    if (cur?.projectId) {
      openSsoTab(payload);
      navigate(`#/workbench?project=${encodeURIComponent(cur.projectId)}`);
      return;
    }
    // 未就绪：优先正在装载的目标项目，其次当前项目，最后第一个项目
    let projectId = cur?.targetParam ?? useWorkbench.getState().project?.id ?? null;
    if (!projectId) {
      const state = await getState().catch(() => null);
      projectId = state?.projects[0]?.id ?? null;
    }
    if (!projectId) {
      toast('收到堡垒机 SSO 会话，但没有可用项目，请先在欢迎页创建项目', 'error');
      return;
    }
    pendingSsoRef.current = { payload, projectId };
    navigate(`#/workbench?project=${encodeURIComponent(projectId)}`);
  }, [openSsoTab]);

  /* 堡垒机 SSO 入口：已有实例经 single-instance 转发（sso:open），首启经 pending 取走。 */
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const keep = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };
    void onSsoOpen((payload) => { void handleSso(payload); }).then(keep);
    void onSsoError((message) => { if (!disposed) toast(message, 'error'); }).then(keep);
    void ssoTakePending()
      .then((pending) => {
        if (disposed) return;
        if (pending.error) toast(pending.error, 'error');
        if (pending.open) void handleSso(pending.open);
      })
      .catch(() => { /* 后端未就绪（纯浏览器调试） */ });
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [handleSso]);

  /* 根组件常驻监听，避免欢迎页卸载或工作台隐藏时丢失 SDK 导入通知。 */
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onConfigChanged((event) => {
      if (event.kind === 'project') {
        window.dispatchEvent(new CustomEvent('aishell:data-changed'));
        wbEvents.emit('project-changed');
      } else if (event.kind === 'commands' || event.kind === 'skill') {
        wbEvents.emit('project-changed');
      } else {
        wbEvents.emit('notes-changed');
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /* 工作台实例生命周期:进入工作台路由时创建/复用/重建,装载期离开路由销毁失败残留 */
  useEffect(() => {
    if (!isWb) {
      // 离开路由:projectId 仍为 null 说明装载未完成(失败或并发落后)→ 销毁;已装载的保持保活
      setWb((cur) => (cur && cur.projectId === null ? null : cur));
      return;
    }
    setWb((cur) => {
      if (!cur) return { key: 1, targetParam: target, projectId: null };
      // 同项目回归(或装载中同目标)→ 复用;换目标 → 销毁重建
      const same = cur.projectId
        ? (!target || target === cur.projectId)
        : (!target || target === cur.targetParam);
      if (same) return cur;
      return { key: cur.key + 1, targetParam: target, projectId: null };
    });
  }, [isWb, target]);

  return (
    <>
      {wb ? (
        <div className="page-root" style={{ display: isWb ? undefined : 'none' }}>
          <Workbench
            key={wb.key}
            active={isWb}
            targetParam={wb.targetParam}
            onReady={(projectId) => {
              setWb((cur) => (cur && cur.targetParam === wb.targetParam ? { ...cur, projectId } : cur));
              const pending = pendingSsoRef.current;
              if (pending && pending.projectId === projectId) {
                pendingSsoRef.current = null;
                openSsoTab(pending.payload);
              }
            }}
            onFail={() => setWb((cur) => (cur && cur.targetParam === wb.targetParam ? null : cur))}
          />
        </div>
      ) : null}
      {!isWb ? (
        route.name === '/ai-window' ? (
          /* AI 分离窗口（label = ai-detach，独立 OS 窗口）：只渲染迷你标题栏 + AI 面板，
             不渲染主 Topbar/页面导航；参数由 ai_window.rs 的 initialization_script 注入 */
          <AiWindowPage params={route.params} />
        ) : (
          <div className="page-root">
            {route.name === '/settings' ? (
              <>
                <Topbar activePage="settings" workbenchProjectId={wb?.projectId ?? null} />
                <Settings params={route.params} />
              </>
            ) : route.name === '/account' ? (
              <>
                <Topbar activePage="account" workbenchProjectId={wb?.projectId ?? null} />
                <Account params={route.params} />
              </>
            ) : (
              <>
                <Topbar activePage="welcome" workbenchProjectId={wb?.projectId ?? null} />
                <Welcome params={route.params} />
              </>
            )}
          </div>
        )
      ) : null}
    </>
  );
}
