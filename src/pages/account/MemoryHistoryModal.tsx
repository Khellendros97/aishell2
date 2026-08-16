/**
 * 记忆卡片变更历史弹窗（React 版）。
 * 对照旧实现 src/pages/account.ts 的 openHistoryModal：打开即拉取历史，时间线渲染
 * （新增/修订事件徽标 + 操作人 + 时间戳 + 内容 + 纠正说明），失败内联展示错误。
 * 与后端的接口点（见 src/api.ts）：memoryHistory（单卡变更历史，event = ADD / UPDATE）。
 * 弹窗骨架复用 MaskModal（.modal-mask .open 淡入淡出语义同旧实现）。
 */
import { useEffect, useState } from 'react';
import type { MemoryCard, MemoryEvent } from '../../types';
import { memoryHistory } from '../../api';
import { Icon } from '../../shared/Icon';
import { MaskModal } from './MaskModal';

interface MemoryHistoryModalProps {
  card: MemoryCard;
  onClose: () => void;
}

type HistState =
  | { phase: 'loading' }
  | { phase: 'error'; msg: string }
  | { phase: 'ready'; events: MemoryEvent[] };

export function MemoryHistoryModal({ card, onClose }: MemoryHistoryModalProps): JSX.Element {
  const [state, setState] = useState<HistState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void memoryHistory(card.id)
      .then((events) => { if (!cancelled) setState({ phase: 'ready', events }); })
      .catch((e) => { if (!cancelled) setState({ phase: 'error', msg: String(e) }); });
    return () => { cancelled = true; };
  }, [card.id]);

  let body: JSX.Element;
  if (state.phase === 'loading') {
    body = <div className="loading-row"><Icon name="loader" /> 加载历史…</div>;
  } else if (state.phase === 'error') {
    body = <div className="cloud-empty err-text">加载历史失败：{state.msg}</div>;
  } else if (state.events.length === 0) {
    body = <div className="cloud-empty">暂无变更记录</div>;
  } else {
    body = (
      <div className="mem-history">
        {state.events.map((ev, i) => (
          <div className="mem-history-item" key={i}>
            <div className="mem-history-head">
              <span className={`mem-history-event ${ev.event === 'ADD' ? 'add' : 'update'}`}>
                {ev.event === 'ADD' ? '新增' : '修订'}
              </span>
              <span className="mem-history-actor">{ev.actor || '—'}</span>
              <span className="mem-time">{ev.ts}</span>
            </div>
            <div className="mem-history-value">{ev.value}</div>
            {ev.note ? <div className="mem-history-note">说明：{ev.note}</div> : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <MaskModal
      width={560}
      onClose={onClose}
      head={<h3>变更历史</h3>}
      body={<div id="mem-history-body">{body}</div>}
      foot={<button className="btn small" onClick={onClose}>关闭</button>}
    />
  );
}
