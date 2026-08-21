/**
 * AI 会话 trace 标签页('trace',本次新增,无 .proto 对照;右键 AI 对话区「追溯」打开)。
 * 展示当前会话的 trace 日志(后端 trace.rs 按会话分文件落盘,<config>/ai-trace/<日期>/):
 *   - 工具栏:搜索(前端实时过滤已加载条目)、刷新、导出(.log,后端裁剪:成功的工具调用
 *     只留名称/状态/耗时,助手输出截断 1024 字素)、清空(仅当前会话,确认后执行);
 *   - 激活期间每 3s 轮询增量刷新(trace 面板非常驻,不订阅实时事件),贴底时自动滚动跟随、
 *     向上翻阅历史时不打扰;
 *   - pi_event 由后端解包为可读摘要(思维链/工具参数增量只显示本段字素数);
 *   - trace 开关关闭时顶部提示(仍可见历史日志),开关在命令面板 `trace on/off`。
 * 与后端的接口点:trace_read / trace_export / trace_clear / trace_status。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { traceClear, traceExport, traceRead, traceStatus } from '../../../api';
import type { TraceEntry } from '../../../types';
import { confirmDialog, toast } from '../../../ui';
import type { TabProps } from '../../../stores/workbench';
import { Icon } from '../../../shared/Icon';
import '../trace.css';

const POLL_MS = 3000;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function TraceTab({ tab, active }: TabProps): JSX.Element {
  const { projectId, sessionId, sessionTitle } = tab.data as {
    projectId: string;
    sessionId: string;
    sessionTitle?: string;
  };
  const key = `${projectId}:${sessionId}`;
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [search, setSearch] = useState('');
  const [traceOn, setTraceOn] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 贴底跟随：用户在底部时新日志自动滚动跟上；向上翻阅历史时不打扰
  const nearBottomRef = useRef(true);
  // 载入序号守卫：轮询与手动刷新并发时旧响应不覆盖新结果
  const seqRef = useRef(0);

  const onBodyScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  };

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const [list, on] = await Promise.all([traceRead(key), traceStatus()]);
      if (seq !== seqRef.current) return;
      setEntries(list);
      setTraceOn(on);
      // 等 React 渲染出新行后再滚动（setState 异步，rAF 到下一帧）
      if (nearBottomRef.current) {
        requestAnimationFrame(() => {
          const el = bodyRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    } catch {
      /* 读失败静默：trace 目录可能尚未创建 */
    }
  }, [key]);

  /* 挂载即加载；激活期间轮询(keep-alive：切标签只是 display:none，不卸载) */
  useEffect(() => {
    void load();
    if (!active) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, active]);

  const doExport = async (): Promise<void> => {
    if (!entries.length) { toast('暂无 trace 日志', 'info'); return; }
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const path = await save({
      defaultPath: `aishell-trace-${sessionTitle || sessionId}-${ts}.log`,
      filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
    });
    if (!path) return;
    try {
      const count = await traceExport(path, key);
      toast(`已导出 ${count} 行: ${path}`, 'success');
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  const doClear = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: '清空 trace 日志',
      message: `将删除当前会话（${sessionTitle || sessionId}）的全部 trace 日志，其他会话不受影响。此操作不可恢复，确定继续吗？`,
      danger: true,
      okText: '清空',
    });
    if (!ok) return;
    try {
      await traceClear(key);
      setEntries([]);
      toast('已清空当前会话 trace 日志', 'success');
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  const needle = search.trim().toLowerCase();
  const shown = needle
    ? entries.filter((e) => e.text.toLowerCase().includes(needle) || e.cat.includes(needle))
    : entries;

  return (
    <div className="trace-tab">
      <div className="trace-toolbar">
        <span className="trace-title">追溯 · {sessionTitle || sessionId}</span>
        {!traceOn && <span className="trace-off-hint">trace 已关闭（命令面板输入 trace on 开启），以下为历史日志</span>}
        <span className="trace-spacer" />
        <span className="trace-search">
          <Icon name="search" />
          <input
            className="input"
            placeholder="搜索日志…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            spellCheck={false}
          />
        </span>
        <button className="btn small ghost" onClick={() => void load()} title="刷新">
          <Icon name="refresh" /> 刷新
        </button>
        <button className="btn small ghost" onClick={() => void doExport()} title="导出（成功的工具调用只留名称/状态/耗时，助手输出截断 1024 字素）">
          <Icon name="download" /> 导出
        </button>
        <button className="btn small ghost" onClick={() => void doClear()} title="清空当前会话 trace 日志">
          <Icon name="trash" /> 清空
        </button>
      </div>
      <div className="trace-body" ref={bodyRef} onScroll={onBodyScroll}>
        {shown.length === 0 ? (
          <div className="trace-empty">
            {entries.length === 0 ? '暂无 trace 日志' : `无匹配「${search}」的日志`}
          </div>
        ) : (
          shown.map((e, i) => (
            <div key={`${e.ts}-${i}`} className={`trace-line trace-cat-${e.cat}`}>
              <span className="trace-ts">{fmtTime(e.ts)}</span>
              <span className="trace-cat">{e.cat}</span>
              <span className="trace-text">{e.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="trace-status">
        {needle ? `匹配 ${shown.length} / ${entries.length} 条` : `共 ${entries.length} 条`}
      </div>
    </div>
  );
}
