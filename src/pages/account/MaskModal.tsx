/**
 * 账号页通用弹窗外壳（React 版）。
 * 对照旧实现 src/pages/account.ts 中 openMemoryModal / openHistoryModal 的弹窗骨架：
 * .modal-mask 默认透明且 pointer-events:none，挂载后下一帧加 .open 触发淡入；
 * 关闭先退 .open 再延迟 160ms 卸载（淡出），点击遮罩空白处关闭。
 * 与后端的接口点无关（纯 UI），子内容由调用方以 children 传入。
 */
import { useEffect, useState, type ReactNode } from 'react';

interface MaskModalProps {
  /** 弹窗宽度（px）；不传用全局 .modal 默认宽度 */
  width?: number;
  onClose: () => void;
  head: ReactNode;
  body: ReactNode;
  foot: ReactNode;
}

export function MaskModal({ width, onClose, head, body, foot }: MaskModalProps): JSX.Element {
  /** 淡入：挂载时默认不带 .open（透明、不响应指针），下一帧加上触发过渡（同旧实现 rAF 逻辑） */
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  /** 淡出后卸载：退 .open，160ms（对应 CSS 过渡时长）后再通知父级移除 */
  const close = (): void => {
    setOpen(false);
    setTimeout(onClose, 160);
  };

  return (
    <div
      className={`modal-mask${open ? ' open' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-head">{head}</div>
        <div className="modal-body">{body}</div>
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}
