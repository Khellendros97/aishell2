/**
 * 运行时锚点测量:高亮环/指针/涟漪的坐标不再手写常量,而是渲染时从真实 DOM 实测。
 *
 * 用法:合成最外层包 <AnchorRoot>(必须是未做相机变换的 1920×1080 画布根),
 * 被指向的元素打 data-anchor="id" 属性(纯属性、不加包装 div,不影响 CSS 结构选择器);
 * 消费方用 useAnchorMaybe / useAnchorTrack 取画布坐标。
 *
 * 关键机制:
 * - 每帧在 useLayoutEffect 里扫描 [data-anchor] 并 getBoundingClientRect,归一化到画布坐标
 *   (减根 rect 原点、除以根实际缩放比)——相机缩放、Studio 预览缩放、设备像素比全部天然抵消,
 *   实测值即「该元素在最终画面上的位置」,相机推近期间高亮/指针逐帧贴住元素。
 * - 锚点卸载后保留 last-known 值(弹窗按钮点击后 DOM 被替换,涟漪/高亮收尾帧仍需坐标)。
 * - 首帧挂 delayRender,等 document.fonts.ready + 首轮测量完成才放行(字体度量也是漂移源)。
 *   后续帧测量在 layout effect 内同步完成,React 在绘制前同步重渲染,截图必为测量后的帧。
 * - 失败响亮:本帧测量完成后仍不存在的锚点被引用 → 抛错,绝不静默偏位。
 * - 硬约束(Remotion 逐帧无状态,任一帧都可能是一个渲染进程的首帧):锚点元素必须在
 *   消费方整个可见窗口(含淡出尾帧与涟漪)内保持挂载,且比窗口至少提前 1 帧挂载;
 *   last-known 缓存只是同进程内的优化,不能替代挂载。
 * - last-known 存的是含相机的画布坐标:锚点卸载后若相机继续运动,缓存值会过时——
 *   编排上避免「锚点卸载后仍有消费方 + 相机在动」的组合。
 */
import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { continueRender, delayRender, interpolate, useCurrentFrame } from 'remotion';
import { EASE } from '../anim';

export interface AnchorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AnchorCtxValue {
  /** 读锚点(画布坐标;含 last-known 缓存,从未挂载返回 undefined) */
  get: (id: string) => AnchorRect | undefined;
  /** 已完成测量的帧号:小于当前帧说明本帧还是首轮渲染(消费方应等测量后重渲染,不得报错) */
  measuredFrame: number;
}

const AnchorCtx = createContext<AnchorCtxValue | null>(null);

/** 位置变化超过该阈值才算变更(避免亚像素抖动引发无谓重渲染) */
const EPS = 0.5;

export const AnchorRoot: React.FC<{ designWidth?: number; children: React.ReactNode }> = ({
  designWidth = 1920,
  children,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  /** last-known 缓存:跨帧持久,元素卸载后仍可读 */
  const cache = useRef(new Map<string, AnchorRect>());
  /** 已完成测量的帧号(消费方据此区分「本帧未测」与「真的不存在」) */
  const measuredFrame = useRef(-1);
  const frame = useCurrentFrame();
  const [version, setVersion] = useState(0);
  /** 首帧渲染闸(放行后置 null,只拦一次) */
  const gate = useRef<ReturnType<typeof delayRender> | null>(null);
  if (gate.current === null) {
    gate.current = delayRender('锚点测量:等待字体就绪与首轮测量');
  }

  // 无依赖数组:每次渲染(=每帧)重测。子组件 layout effect 先跑,此处 DOM 已就绪。
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const k = rootRect.width / designWidth;
    let changed = false;
    const seen = new Set<string>();
    root.querySelectorAll('[data-anchor]').forEach((el) => {
      const id = el.getAttribute('data-anchor');
      if (!id) return;
      if (seen.has(id)) {
        console.warn(`[anchors] 同帧重复锚点 id:"${id}",后者被忽略`);
        return;
      }
      seen.add(id);
      const r = el.getBoundingClientRect();
      const next: AnchorRect = {
        x: (r.left - rootRect.left) / k,
        y: (r.top - rootRect.top) / k,
        w: r.width / k,
        h: r.height / k,
      };
      const prev = cache.current.get(id);
      if (
        !prev ||
        Math.abs(prev.x - next.x) > EPS ||
        Math.abs(prev.y - next.y) > EPS ||
        Math.abs(prev.w - next.w) > EPS ||
        Math.abs(prev.h - next.h) > EPS
      ) {
        cache.current.set(id, next);
        changed = true;
      }
    });
    const stale = measuredFrame.current !== frame;
    measuredFrame.current = frame;
    // 首轮渲染时锚点尚未测量,消费方拿到的是空/旧值——必须再渲染一帧让消费方拿到实测值
    // (layout effect 的 setState 在绘制前同步刷新,截图拿到的必是测量后的帧)
    if (changed || stale) setVersion((v) => v + 1);
    // 字体就绪 + 首轮测量完成后放行渲染闸
    document.fonts.ready.then(() => {
      if (gate.current !== null) {
        continueRender(gate.current);
        gate.current = null;
      }
    });
  });

  const value = useMemo<AnchorCtxValue>(
    () => ({ get: (id) => cache.current.get(id), measuredFrame: measuredFrame.current }),
    // version 驱动消费方重渲染;get 闭包始终读最新 cache
    [version],
  );

  return (
    <AnchorCtx.Provider value={value}>
      <div ref={rootRef} style={{ position: 'absolute', inset: 0 }}>
        {children}
      </div>
    </AnchorCtx.Provider>
  );
};

/** 读锚点矩形;无 AnchorRoot 或锚点从未挂载时返回 undefined(调用方自行决定兜底/报错) */
export const useAnchorMaybe = (id: string): AnchorRect | undefined => {
  const ctx = useContext(AnchorCtx);
  return ctx?.get(id);
};

/**
 * 指针轨道关键帧:at 命中锚点中心(可加 dx/dy 偏移,如「停在按钮右下方」);
 * 锚点从未挂载时回退 x/y 兜底值;纯固定点(入退场)只写 x/y。
 */
export interface AnchorStop {
  f: number;
  at?: string;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
}

/** 锚点轨道逐帧插值(与 track1 同款分段缓动);返回画布坐标 */
export const useAnchorTrack = (stops: readonly AnchorStop[], frame: number): { x: number; y: number } => {
  const ctx = useContext(AnchorCtx);
  const pts = stops.map((s) => {
    if (s.at && ctx) {
      const r = ctx.get(s.at);
      if (r) return { f: s.f, x: r.x + r.w / 2 + (s.dx ?? 0), y: r.y + r.h / 2 + (s.dy ?? 0) };
    }
    if (s.x === undefined || s.y === undefined) {
      throw new Error(`[anchors] 指针轨道第 ${s.f} 帧的锚点 "${s.at}" 从未挂载,且未提供 x/y 兜底坐标`);
    }
    return { f: s.f, x: s.x + (s.dx ?? 0), y: s.y + (s.dy ?? 0) };
  });
  if (frame <= pts[0].f) return pts[0];
  const last = pts[pts.length - 1];
  if (frame >= last.f) return last;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (frame >= a.f && frame <= b.f) {
      const t = interpolate(frame, [a.f, b.f], [0, 1], {
        easing: EASE,
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return last;
};

/**
 * 高亮环等无兜底消费方专用:本帧首轮渲染(测量未跑)返回 undefined,消费方应渲染为空,
 * 等测量触发的重渲染拿到实测值;active(可见窗口内)且本帧已测量仍不存在 → 抛错
 * (渲染直接失败,绝不静默偏位)。窗口外不校验——未来场景的锚点尚未挂载属正常。
 * 前提:锚点元素须比消费方可见窗口至少提前 1 帧挂载(首轮渲染那一帧完成测量)。
 */
export const useAnchorStrict = (id: string, active: boolean): AnchorRect | undefined => {
  const ctx = useContext(AnchorCtx);
  const frame = useCurrentFrame();
  if (!ctx) throw new Error('[anchors] target 模式必须包在 <AnchorRoot> 内');
  const r = ctx.get(id);
  if (!r && active && ctx.measuredFrame === frame) {
    throw new Error(`[anchors] 第 ${frame} 帧引用了从未挂载的锚点 "${id}"`);
  }
  return r;
};
