/**
 * 仪表盘侧栏面板(React 版,新建) —— 对照 .proto/ 无原型(新功能)。
 * 每个项目一个 <项目根>/.aishell/dashboard/dashboard.py:Rust 渲染管线执行脚本(复用 pysdk),
 * 组件 spec 经 dashboard_render 命令返回,本面板渲染 备忘录/markdown 文本/只读表格/图片/echarts 图表。
 * - 数据流:dashboardRender → 本地 state;wbEvents 'project-changed' 与 onDashboardChanged(AI reload/memo 保存广播)触发重载;
 * - 自动刷新:spec.meta.refreshSeconds 声明间隔 + 头部 play/pause 开关(默认开);脚本失败保留上次 spec、顶部行内报错;
 * - 备忘录组件:顶部可编辑表格(table.json,记账号/密码等;单元格失焦保存、行列操作即时保存) + 下方备忘文本(memo.md);
 *   服务器内容回流时未脏才跟随,防打字被覆盖;SDK 声明的 table 组件才是只读的;
 * - 「定制仪表盘」:promptDialog 收集需求 → wbHandles.ai.startConversation 发任务(AI 经 dashboard 技能 +
 *   dashboard_reload/dashboard_view 工具迭代)。
 * 接口点:src/api.ts 仪表盘段(dashboardRender/dashboardSaveMemo/onDashboardChanged)、stores/workbench.ts wbHandles.ai。
 */
import { useEffect, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { dashboardRender, dashboardSaveMemo, dashboardSaveTable, onDashboardChanged, onDashboardProgress } from '../../../api';
import { useWorkbench, wbEvents, wbHandles } from '../../../stores/workbench';
import { copyText, promptDialog, toast } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import type { SidebarPanelDef } from './panel-types';
import type { DashboardComponent, DashboardSpec } from '../../../types';
import './dashboard.css';

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer]);

/** markdown 渲染(html:false 与笔记/AI 消息同标准) */
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

/** 模块级面板操作句柄:HeadActions(独立组件)触发面板主体的刷新/自动刷新切换 */
let panelApi: { refresh: () => void; toggleAuto: () => boolean; autoOn: () => boolean; hasInterval: () => boolean } | null = null;

/** base64 → UTF-8 字符串(svg 源码解码用) */
function decodeBase64(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/* ---------- 备忘录顶部可编辑表格:记录账号/密码等关键信息;单元格失焦保存,行列操作即时保存 ---------- */
function EditTable({ projectId, columns, rows }: {
  projectId: string;
  columns: { key: string; title: string }[];
  rows: Record<string, string>[];
}): JSX.Element {
  const [draft, setDraft] = useState({ columns, rows });
  const [base, setBase] = useState({ columns, rows });
  // 服务器回流(AI 改了 table.json / 他处保存):本地未脏才跟随,防正在编辑的内容被覆盖
  useEffect(() => {
    if (JSON.stringify(draft) !== JSON.stringify(base)) return;
    if (columns === base.columns && rows === base.rows) return;
    setBase({ columns, rows });
    setDraft({ columns, rows });
  }, [columns, rows, draft, base]);

  const persist = async (next: { columns: { key: string; title: string }[]; rows: Record<string, string>[] }): Promise<void> => {
    try {
      await dashboardSaveTable(projectId, next.columns, next.rows);
      setBase(next);
    } catch (err) {
      toast(`表格保存失败: ${String(err)}`, 'error');
    }
  };
  const setCell = (ri: number, key: string, value: string): void => {
    setDraft((d) => ({ ...d, rows: d.rows.map((r, i) => (i === ri ? { ...r, [key]: value } : r)) }));
  };
  const commit = (): void => {
    if (JSON.stringify(draft) === JSON.stringify(base)) return;
    void persist(draft);
  };
  const addRow = (): void => {
    const next = { ...draft, rows: [...draft.rows, {}] };
    setDraft(next);
    void persist(next);
  };
  const delRow = (ri: number): void => {
    const next = { ...draft, rows: draft.rows.filter((_, i) => i !== ri) };
    setDraft(next);
    void persist(next);
  };
  return (
    <div className="dash-edit-table-wrap">
      <table className="dash-table dash-edit-table">
        {/* 默认两列(项目|内容)按 4:6 定宽;更多列时均分剩余宽度 */}
        {draft.columns.length === 2 && (
          <colgroup><col className="dash-col-first" /><col /><col className="dash-col-ops" /></colgroup>
        )}
        <thead>
          <tr>
            {draft.columns.map((c) => <th key={c.key}>{c.title}</th>)}
            <th className="dash-edit-ops">
              <button className="icon-btn" title="新增行" onClick={addRow}><Icon name="plus" /></button>
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.rows.map((r, ri) => (
            <tr key={ri}>
              {draft.columns.map((c, ci) => (
                <td key={c.key} className={ci > 0 ? 'dash-cell has-copy' : 'dash-cell'}>
                  <input
                    className="dash-cell-input"
                    value={r[c.key] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setCell(ri, c.key, e.currentTarget.value)}
                    onBlur={commit}
                  />
                  {ci > 0 && (
                    <button
                      className="icon-btn dash-cell-copy"
                      title="复制到剪贴板"
                      onClick={() => { void copyText(r[c.key] ?? '').then(() => toast('已复制')); }}
                    ><Icon name="copy" /></button>
                  )}
                </td>
              ))}
              <td className="dash-edit-ops">
                <button className="icon-btn" title="删除本行" onClick={() => delRow(ri)}><Icon name="trash" /></button>
              </td>
            </tr>
          ))}
          {draft.rows.length === 0 && (
            <tr><td colSpan={draft.columns.length + 1} className="dash-table-empty">暂无记录</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 备忘文本:失焦保存;服务器回流未脏才跟随 ---------- */
function MemoText({ projectId, content }: { projectId: string; content: string }): JSX.Element {
  const [draft, setDraft] = useState(content);
  const [base, setBase] = useState(content);
  useEffect(() => {
    if (content !== base) {
      setBase(content);
      setDraft((d) => (d === base ? content : d));
    }
  }, [content, base]);
  const save = async (): Promise<void> => {
    if (draft === base) return;
    try {
      await dashboardSaveMemo(projectId, draft);
      setBase(draft);
    } catch (err) {
      toast(`备忘录保存失败: ${String(err)}`, 'error');
    }
  };
  return (
    <textarea
      className="dash-memo"
      value={draft}
      placeholder="记录关键信息…"
      spellCheck={false}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => void save()}
    />
  );
}

/* ---------- echarts 图表组件 ---------- */
function ChartView({ option }: { option: Record<string, unknown> }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    try {
      chart.setOption(option);
    } catch {
      /* AI 生成的 option 非法时保持空白,不拖垮面板 */
    }
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div className="dash-chart" ref={ref} />;
}

/* ---------- 单个组件卡片 ---------- */
function ComponentCard({ projectId, comp }: { projectId: string; comp: DashboardComponent }): JSX.Element {
  let body: JSX.Element;
  switch (comp.type) {
    case 'memo':
      body = (
        <>
          <EditTable projectId={projectId} columns={comp.columns ?? []} rows={(comp.rows ?? []) as Record<string, string>[]} />
          <MemoText projectId={projectId} content={comp.content ?? ''} />
        </>
      );
      break;
    case 'text':
      body = <div className="dash-md" dangerouslySetInnerHTML={{ __html: md.render(comp.markdown ?? '') }} />;
      break;
    case 'table': {
      const cols = comp.columns ?? [];
      const rows = comp.rows ?? [];
      body = (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead><tr>{cols.map((c) => <th key={c.key}>{c.title}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{cols.map((c) => <td key={c.key}>{r[c.key] == null ? '—' : String(r[c.key])}</td>)}</tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={Math.max(cols.length, 1)} className="dash-table-empty">暂无数据</td></tr>}
            </tbody>
          </table>
        </div>
      );
      break;
    }
    case 'image': {
      const mime = comp.mime ?? 'image/png';
      body = mime === 'image/svg+xml' ? (
        <div className="dash-image dash-svg" dangerouslySetInnerHTML={{ __html: decodeBase64(comp.data ?? '') }} />
      ) : (
        <img className="dash-image" src={`data:${mime};base64,${comp.data ?? ''}`} alt={comp.title} />
      );
      break;
    }
    case 'chart':
      body = <ChartView option={comp.option ?? {}} />;
      break;
    default:
      body = <div className="dash-unknown">未知组件类型: {comp.type}</div>;
  }
  return (
    <div className="dash-card">
      {comp.title && <div className="dash-card-title">{comp.title}</div>}
      {body}
    </div>
  );
}

/* ---------- 面板主体 ---------- */
function DashboardPanelBody(): JSX.Element {
  const project = useWorkbench((s) => s.project);
  const [spec, setSpec] = useState<DashboardSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoOn, setAutoOn] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const projectId = project?.id ?? null;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let offProgress: (() => void) | undefined;
    // 渐进渲染：脚本采集期间每声明一个组件推一帧（已含备忘录头部合并），边采集边出内容
    void onDashboardProgress((pid, next) => {
      if (!cancelled && pid === projectId) setSpec(next);
    }).then((un) => { offProgress = un; }).catch(() => { /* 无 Tauri 环境静默 */ });
    setLoading(true);
    dashboardRender(projectId)
      .then((r) => {
        if (cancelled) return;
        if (r.spec) setSpec(r.spec);
        setError(r.error);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; offProgress?.(); };
  }, [projectId, reloadKey]);

  // 项目数据变更 / AI reload / memo 保存广播 → 重载
  useEffect(() => wbEvents.on('project-changed', () => setReloadKey((k) => k + 1)), []);
  useEffect(() => {
    let off: (() => void) | undefined;
    void onDashboardChanged((pid) => { if (pid === projectId) setReloadKey((k) => k + 1); })
      .then((un) => { off = un; })
      .catch(() => { /* 无 Tauri 环境静默 */ });
    return () => off?.();
  }, [projectId]);

  // 自动刷新:脚本声明间隔 + 开关打开
  const secs = spec?.meta?.refreshSeconds ?? 0;
  useEffect(() => {
    if (!autoOn || !secs || secs <= 0 || !projectId) return;
    const t = setInterval(() => setReloadKey((k) => k + 1), secs * 1000);
    return () => clearInterval(t);
  }, [autoOn, secs, projectId]);

  // HeadActions 句柄(挂载注册/卸载置空,照 NotesPanel 先例)
  useEffect(() => {
    panelApi = {
      refresh: () => setReloadKey((k) => k + 1),
      toggleAuto: () => { setAutoOn((v) => !v); return !autoOn; },
      autoOn: () => autoOn,
      hasInterval: () => secs > 0,
    };
    return () => { panelApi = null; };
  }, [autoOn, secs]);

  if (!projectId) {
    return <div className="wbs-content"><div className="wbs-explorer-loading" style={{ paddingLeft: 6 }}>加载中…</div></div>;
  }
  return (
    <div className="wbs-content dash-panel">
      {error && <div className="dash-error" title={error}>仪表盘脚本执行失败: {error}</div>}
      {loading && spec && <div className="dash-busy">正在采集最新数据…</div>}
      {!spec && !error && loading && <div className="wbs-explorer-loading" style={{ paddingLeft: 6 }}>渲染中…</div>}
      {spec?.components.map((c) => <ComponentCard key={c.id} projectId={projectId} comp={c} />)}
    </div>
  );
}

/* ---------- 侧栏头操作区:定制仪表盘 / 自动刷新开关 / 刷新 ---------- */
function DashboardHeadActions(): JSX.Element {
  const panel = useWorkbench((s) => s.panel);
  const [, force] = useState(0);
  const active = panel === 'dashboard';

  const customize = async (): Promise<void> => {
    const requirement = await promptDialog({
      title: '定制仪表盘',
      label: '描述你想在仪表盘中看到的内容,AI 将修改 dashboard.py 并自动调试验证:',
      placeholder: '例如:增加所有服务器的负载监控表格,每 30 秒自动刷新',
      okText: '发送给 AI',
      allowPath: true,
      multiline: true,
    });
    if (!requirement) return;
    const prompt = `请定制本项目的仪表盘(侧栏「仪表盘」面板)。用户需求:${requirement}\n\n先阅读 dashboard 技能(SKILL.md)了解 dashboard.py 脚本契约、aishell.dashboard 组件 API 与 dashboard_reload/dashboard_view 工具用法,然后按「修改 .aishell/dashboard/dashboard.py → dashboard_reload → dashboard_view 核对」循环迭代完成定制。`;
    useWorkbench.getState().setAiVisible(true);
    try {
      await wbHandles.ai?.startConversation?.(prompt);
    } catch (err) {
      toast(`发送定制任务失败: ${String(err)}`, 'error');
    }
  };

  return (
    <>
      <button className="icon-btn" title="定制仪表盘(描述需求,AI 自动定制)" disabled={!active}
        onClick={() => void customize()}><Icon name="sparkles" /></button>
      <button className="icon-btn" title={panelApi?.autoOn() ? '暂停自动刷新' : '恢复自动刷新'}
        disabled={!active || !panelApi?.hasInterval()}
        onClick={() => { panelApi?.toggleAuto(); force((n) => n + 1); }}>
        <Icon name={panelApi?.autoOn() ? 'pause' : 'play'} />
      </button>
      <button className="icon-btn" title="刷新" disabled={!active}
        onClick={() => { panelApi?.refresh(); force((n) => n + 1); }}><Icon name="refresh" /></button>
    </>
  );
}

export const dashboardPanel: SidebarPanelDef = {
  title: '仪表盘',
  HeadActions: DashboardHeadActions,
  Panel: DashboardPanelBody,
};
