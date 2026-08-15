/**
 * 应用根组件:三页 hash 路由容器 + 工作台保活(React 版,对照旧版 main.ts 的 render())。
 * 保活语义(与旧版逐条对齐,勿改):
 * - 子页(welcome/settings)随路由挂载/卸载,顶栏由本组件渲染;
 * - 工作台实例离开路由只隐藏不销毁(display:none 保持挂载,终端/SSH/AI 会话全部保留),
 *   同项目回归原样复用(含裸 '#/workbench',目标项目即保活项目);
 * - 换项目才销毁重建(key 变更触发整树卸载 → Workbench 卸载清理关闭全部标签);
 * - 装载失败(无项目/后端异常,Workbench 已自行导航离开)或装载期间离开路由 → 销毁实例。
 */
import { useEffect, useState } from 'react';
import { useHashRoute } from './shared/useHashRoute';
import { Topbar } from './components/Topbar';
import { Welcome } from './pages/welcome/Welcome';
import { Settings } from './pages/settings/Settings';
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
            onReady={(projectId) => setWb((cur) => (cur && cur.targetParam === wb.targetParam ? { ...cur, projectId } : cur))}
            onFail={() => setWb((cur) => (cur && cur.targetParam === wb.targetParam ? null : cur))}
          />
        </div>
      ) : null}
      {!isWb ? (
        <div className="page-root">
          {route.name === '/settings' ? (
            <>
              <Topbar activePage="settings" workbenchProjectId={wb?.projectId ?? null} />
              <Settings params={route.params} />
            </>
          ) : (
            <>
              <Topbar activePage="welcome" workbenchProjectId={wb?.projectId ?? null} />
              <Welcome params={route.params} />
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
