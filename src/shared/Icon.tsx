/**
 * React 图标组件:包装 src/icons.ts 的内联 SVG PATHS(React 迁移新增)。
 * 属性与 icons.ts 的 icon() 一致(stroke/fill 可选覆盖 currentColor/none);
 * DOM 产物与命令式版本完全相同(svg.ic,尺寸 1em 随容器字号)。
 */
import { PATHS, type IconName } from '../icons';

export function Icon({ name, stroke, fill }: { name: IconName; stroke?: string; fill?: string }): JSX.Element {
  return (
    <svg
      className="ic"
      viewBox="0 0 24 24"
      fill={fill ?? 'none'}
      stroke={stroke ?? 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // PATHS 是本仓库内的静态 SVG 片段常量,无注入面
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
