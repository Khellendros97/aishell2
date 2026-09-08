/**
 * 面板拖宽通用钩子：指针拖拽 + 键盘方向键 + active 视觉态（对照旧版 bindPanelResize 语义，
 * 自 Workbench.tsx 的 usePanelResize 抽出，工作台侧栏/AI 面板与欢迎页 AI 面板共用）。
 * 宽度钳制（最小/最大/出屏）与落地（CSS 变量 / aria-valuenow）由调用方 applyWidth 负责；
 * 回调经 applyRef 每次渲染同步，事件监听只挂载一次，调用方传内联闭包即可。
 * 配套样式见 panel-resize.css（handle 需带 .wb-resize-handle 类）。
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import './panel-resize.css';

export function usePanelResize(
  handleRef: RefObject<HTMLElement>,
  panelRef: RefObject<HTMLElement>,
  /** 面板在分隔条哪一侧：left = 向右拖变宽；right = 向左拖变宽 */
  side: 'left' | 'right',
  applyWidth: (width: number) => void,
): void {
  const applyRef = useRef(applyWidth);
  useEffect(() => { applyRef.current = applyWidth; });

  useEffect(() => {
    const handle = handleRef.current;
    const panel = panelRef.current;
    if (!handle || !panel) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const delta = event.clientX - startX;
      applyRef.current(startWidth + (side === 'left' ? delta : -delta));
    };
    const onPointerUp = (): void => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('active');
      document.body.classList.remove('wb-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = panel.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.classList.add('wb-resizing');
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      applyRef.current(panel.getBoundingClientRect().width + direction * (side === 'left' ? 16 : -16));
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('keydown', onKeyDown);
    // 挂载时按当前渲染宽度归一化一次（钳制 CSS 默认值并同步 aria-valuenow）
    applyRef.current(panel.getBoundingClientRect().width);
    return () => {
      onPointerUp();
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('keydown', onKeyDown);
    };
  }, [handleRef, panelRef, side]);
}
