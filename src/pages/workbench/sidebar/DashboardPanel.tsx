/**
 * 仪表盘侧栏面板(React 版,新建) —— 对照 .proto/ 无原型(新功能)。
 * 每个项目一个 <项目根>/.aishell/dashboard/dashboard.py:Rust 渲染管线执行脚本(复用 pysdk),
 * 组件 spec 经 dashboard_render 命令返回,本面板渲染 备忘录/markdown 文本/只读表格/图片/echarts 图表。
 * - 数据流:dashboardRender → 本地 state;wbEvents 'project-changed' 与 onDashboardChanged(AI reload/memo 保存广播)触发重载;
 * - 渐进帧合并:采集期间每帧只含「已声明的组件」,按 id 合并到已显示内容上(卸载后置:本帧未声明的组件保留,
 *   内容未变复用旧对象,图表不重建);删除/改序由最终结果整体替换生效,避免刷新时组件先消失再逐个回来;
 * - 自动刷新:spec.meta.refreshSeconds 声明间隔 + 头部 play/pause 开关(默认开);脚本失败保留上次 spec、顶部行内报错;
 * - 备忘录组件:顶部可编辑表格(table.json,记账号/密码等;单元格失焦保存、行列操作即时保存) + 下方备忘文本(memo.md);
 *   服务器内容回流时未脏才跟随,防打字被覆盖;SDK 声明的 table 组件才是只读的;
 * - 「定制仪表盘」:promptDialog 收集需求 → wbHandles.ai.startConversation 发任务(AI 经 dashboard 技能 +
 *   dashboard_reload/dashboard_view 工具迭代);
 * - 图表基底配色:echarts 无主题时是亮色皮肤,在暗色卡片上网格线过亮、坐标轴数字过暗,故由面板按设计变量
 *   补一层基底(网格线/坐标轴数字/数值标注),脚本 option 里显式写过的样式优先;主题切换重取色重设 option;
 * - 文本组件 markdown:排版在 dashboard.css(.dash-md,照 NoteTab 的 .note-md);外链点击委托 openUrl 走系统浏览器,
 *   不在应用窗口内导航(否则整个工作台被顶掉);
 * 接口点:src/api.ts 仪表盘段(dashboardRender/dashboardSaveMemo/onDashboardChanged)、stores/workbench.ts wbHandles.ai。
 */
import { useEffect, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { openUrl } from '@tauri-apps/plugin-opener';
import { dashboardRender, dashboardSaveMemo, dashboardSaveTable, onDashboardChanged, onDashboardProgress } from '../../../api';
import { useWorkbench, wbEvents, wbHandles } from '../../../stores/workbench';
import { onThemeChange } from '../../../theme';
import { copyText, promptDialog, toast } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import type { SidebarPanelDef } from './panel-types';
import type { DashboardComponent, DashboardSpec } from '../../../types';
import './dashboard.css';

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer]);

/** markdown 渲染(html:false 与笔记/AI 消息同标准) */
const md = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
// 外链不在应用窗口内导航(会把整个工作台顶掉):标 target/rel,点击由容器委托 openUrl 走系统浏览器
const defaultLinkOpen = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

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

/* ---------- 渐进帧合并:刷新时把「已显示内容」与「本帧已声明的组件」按 id 合成 ---------- */

/** 组件内容深比较(JSON 文本;组件数有限,只用于决定能否复用旧对象) */
function sameComponent(a: DashboardComponent, b: DashboardComponent): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * 合并一帧渐进数据(卸载后置):脚本每声明一个组件推一帧,帧内只有「已声明的组件」,
 * 整帧替换会让上一轮组件先卸载、等脚本重新声明(可能还要等慢采集)才逐个回来。
 * 合并规则:本帧已声明的按 id 就地替换、内容未变的复用旧对象(echarts 因此不重建);
 * 本帧未声明的旧组件按原位置保留——真正的删除/改序由最终结果整体替换生效。
 */
function mergeProgress(prev: DashboardSpec | null, next: DashboardSpec): DashboardSpec {
  const prevComps = prev?.components ?? [];
  const nextComps = next.components ?? [];
  if (prevComps.length === 0) return next;
  // 空帧(脚本尚未声明组件)不动已显示内容:这是组件「先卸载」的主要来源
  if (nextComps.length === 0) return { ...next, components: prevComps };
  const nextIds = new Set(nextComps.map((c) => c.id));
  const carried = prevComps.filter((c) => !nextIds.has(c.id));
  const prevById = new Map(prevComps.map((c) => [c.id, c]));
  const prevPos = new Map(prevComps.map((c, i) => [c.id, i]));
  const out: DashboardComponent[] = [];
  let cursor = 0;
  for (const c of nextComps) {
    const at = prevPos.get(c.id);
    // 补上本帧声明的组件「在旧列表中的位置之前」那些未被声明的旧组件,保持原有排列
    while (at !== undefined && cursor < carried.length && (prevPos.get(carried[cursor].id) ?? 0) < at) {
      out.push(carried[cursor]);
      cursor += 1;
    }
    const old = prevById.get(c.id);
    out.push(old && sameComponent(old, c) ? old : c);
  }
  while (cursor < carried.length) out.push(carried[cursor++]);
  return { ...next, components: out };
}

/* ---------- 图表基底配色:echarts 无主题时是亮色皮肤,面板按设计变量补一层暗色基底 ---------- */

interface ChartSkin {
  /** 网格线(深灰) */
  grid: string;
  /** 坐标轴数字(浅灰) */
  label: string;
  /** 坐标轴名(弱化) */
  name: string;
  /** 系列数值标注(白) */
  value: string;
}

/** 取设计变量当前实际值(echarts 画在 canvas 上,拿不到 CSS 变量;取不到用暗色兜底) */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 当前主题下的图表配色:网格线深灰(border)、坐标轴数字浅灰(text-1)、坐标轴名弱化(text-2)、数值标注白(text-0) */
function chartSkin(): ChartSkin {
  return {
    grid: cssVar('--border', '#363c48'),
    label: cssVar('--text-1', '#a8adbb'),
    name: cssVar('--text-2', '#6b7180'),
    value: cssVar('--text-0', '#e8eaf0'),
  };
}

/**
 * 用基底补空缺(基底只填空缺,脚本 option 里显式写过的键一律优先):
 * 对象递归合并;基底是对象模板、脚本给数组时(如 series),模板套用到每个成员上。
 */
function withDefaults(base: unknown, over: unknown): unknown {
  if (Array.isArray(over)) {
    return over.map((o) => withDefaults(Array.isArray(base) ? base[0] : base, o));
  }
  if (over && typeof over === 'object' && base && typeof base === 'object' && !Array.isArray(base)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = k in out ? withDefaults(out[k], v) : v;
    }
    return out;
  }
  return over === undefined ? base : over;
}

/** 把暗色基底套到脚本 option 上:只补脚本未声明的部分,脚本显式写过的键一律优先 */
function applyChartSkin(option: Record<string, unknown>, skin: ChartSkin): Record<string, unknown> {
  const axis = {
    axisLabel: { color: skin.label },
    nameTextStyle: { color: skin.name },
    // 只给颜色不给 show:类目轴默认不画分隔线,补色不会凭空多出竖线
    splitLine: { lineStyle: { color: skin.grid } },
  };
  const base: Record<string, unknown> = {
    xAxis: axis,
    yAxis: axis,
    series: { label: { color: skin.value } },
    legend: { textStyle: { color: skin.label } },
    title: { textStyle: { color: skin.value } },
  };
  const out: Record<string, unknown> = { ...option };
  for (const [k, v] of Object.entries(option)) {
    if (k in base) out[k] = withDefaults(base[k], v);
  }
  return out;
}

/* ---------- echarts 图表组件 ---------- */
function ChartView({ option }: { option: Record<string, unknown> }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  // 主题切换(深/亮)需重取色重设一次;option 引用可能未变(渐进帧复用),故靠版本号触发
  const [skinVersion, setSkinVersion] = useState(0);
  useEffect(() => onThemeChange(() => setSkinVersion((v) => v + 1)), []);
  // 初始化只在挂载时做一次:数据更新走原地 setOption,避免每次刷新 dispose+init 造成图表闪白
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.setOption(applyChartSkin(option, chartSkin()), { notMerge: true });
    } catch {
      /* AI 生成的 option 非法时保持空白,不拖垮面板 */
    }
  }, [option, skinVersion]);
  return <div className="dash-chart" ref={ref} />;
}

/* ---------- 单个组件卡片 ---------- */
/** 文本组件外链:交给系统浏览器,不在应用窗口内导航(照 NoteTab 预览) */
function onMarkdownClick(e: React.MouseEvent<HTMLDivElement>): void {
  const target = e.target;
  const link = target instanceof Element ? target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  const url = new URL(link.href);
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return;
  e.preventDefault();
  void openUrl(url.href).catch((err) => toast(`无法打开链接: ${String(err)}`, 'error'));
}

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
      body = (
        <div className="dash-md" onClick={onMarkdownClick}
          dangerouslySetInnerHTML={{ __html: md.render(comp.markdown ?? '') }} />
      );
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
    // 渐进渲染：脚本采集期间每声明一个组件推一帧（已含备忘录头部合并），边采集边出内容；
    // 帧按 id 合并进已显示内容（见 mergeProgress），本帧还没轮到的组件不会被卸载
    void onDashboardProgress((pid, next) => {
      if (!cancelled && pid === projectId) setSpec((prev) => mergeProgress(prev, next));
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
        onClick={() => void customize()}><Icon name="wandSparkles" /></button>
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
