/**
 * 共享动画工具:分段关键帧插值(供各场景的运镜/指针轨道复用)。
 */
import { Easing, interpolate } from 'remotion';

export const EASE = Easing.bezier(0.45, 0.05, 0.2, 1);

export interface Stop {
  f: number;
  v: number;
}

/** 分段关键帧插值(段间缓动,端点钳制;stops 帧号须严格递增) */
export function track1(stops: readonly Stop[], frame: number): number {
  if (frame <= stops[0].f) return stops[0].v;
  const last = stops[stops.length - 1];
  if (frame >= last.f) return last.v;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (frame >= a.f && frame <= b.f) {
      return interpolate(frame, [a.f, b.f], [a.v, b.v], { easing: EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    }
  }
  return last.v;
}
