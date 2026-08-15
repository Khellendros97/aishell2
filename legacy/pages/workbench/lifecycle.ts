/**
 * 工作台保活状态：路由层(main.ts)与工作台页(workbench.ts)之间的最小契约。
 * 工作台装载成功后记录项目 id;路由层据此判断可复用实例(返回工作台时保留全部标签页),
 * 顶栏据此渲染「返回工作台」箭头。模块无依赖,避免 main ↔ workbench 循环引用。
 */
export const wbLifecycle = {
  /** 当前保活的工作台项目 id;null = 无保活实例(未装载或装载失败) */
  projectId: null as string | null,
};
