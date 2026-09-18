/**
 * pcap 抓包查看器引擎（全新实现，无 .proto 对照；命令式引擎，React 薄壳在 ./PcapTab.tsx）。
 * 布局：顶栏（显示过滤器 + 计数 + 统计开关）→ 统计条（echarts，可折叠）→
 *       包列表（窗口化渲染，固定行高 24px，只渲染可视行）→ 分隔条 →
 *       详情区（左协议树 / 右 hex，点字段联动高亮字节）；
 *       流追踪时详情区整体切换为流视图（按方向着色，文本/hex 切换）。
 * 数据链路：api.pcapRead（base64）→ parser.parseCapture → decode 懒解码缓存
 *   （列表行/选中/过滤器/统计/流追踪按需解码，全量解码只发生在过滤器应用、统计打开、流追踪时）。
 * 与后端的接口点：pcap_read（本地 path / 远端 serverId+path）。
 * keep-alive 契约：mountPcap 在标签 useEffect 挂载一次，返回清理函数（图表 dispose、 observer 断开）。
 */
import * as echarts from 'echarts/core';
import { LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

import { pcapRead } from '../../../api';
import { icon } from '../../../icons';
import { showContextMenu, toast } from '../../../ui';
import { wbHandles } from '../../../stores/workbench';
import type { PcapRef } from '../../../types';
import { base64ToBytes, parseCapture, type PcapFile, type PcapPacket } from '../../../pcap/parser';
import { decodePacket, type DecodedPacket, type ProtoLayer } from '../../../pcap/decode';
import { compileFilter, type PacketPredicate } from '../../../pcap/filter';
import { buildStream, type FollowStream } from '../../../pcap/stream';

echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface PcapMountParams {
  /** 本地文件路径（serverId 为空时） */
  path: string;
  /** 远端服务器 id（非空时 path 为远端路径） */
  serverId?: string;
  /** 显示名（状态栏/错误提示用） */
  name: string;
}

const ROW_H = 24;
const OVERSCAN = 6;

/* ---------------- 协议 → 行配色类 ---------------- */

function protoClass(proto: string): string {
  switch (proto) {
    case 'TCP': return 'pcap-p-tcp';
    case 'UDP': return 'pcap-p-udp';
    case 'DNS': return 'pcap-p-dns';
    case 'HTTP': return 'pcap-p-http';
    case 'TLS': return 'pcap-p-tls';
    case 'RADIUS': return 'pcap-p-radius';
    case 'ICMP': case 'ICMPv6': return 'pcap-p-icmp';
    case 'ARP': return 'pcap-p-arp';
    default: return '';
  }
}

/* ---------------- 格式化 ---------------- */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN');
}

/* ---------------- echarts 暗色基底（照 DashboardPanel 先例：canvas 拿不到 CSS 变量，手动取） ---------------- */

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/* ---------------- 引擎 ---------------- */

export function mountPcap(root: HTMLElement, params: PcapMountParams): () => void {
  root.classList.add('pcap-root');
  root.innerHTML = `
    <div class="pcap-toolbar">
      <span class="pcap-filter-ic">${icon('filter')}</span>
      <input class="input pcap-filter-input" spellcheck="false"
        placeholder="显示过滤器：tcp && port 443、host 10.0.0.1、dns、ip.src == 1.2.3.4 …（回车应用）" />
      <button class="btn small pcap-apply">应用</button>
      <button class="btn small ghost pcap-clear">清除</button>
      <span class="pcap-filter-err hidden"></span>
      <span class="pcap-spacer"></span>
      <span class="pcap-count"></span>
      <button class="btn small ghost pcap-chat-btn" title="把当前过滤结果（前 200 条摘要）作为引用加入 AI 对话">${icon('chatPlus')} 添加到对话</button>
      <button class="btn small ghost pcap-stats-btn" title="协议分布与流量曲线">${icon('chartLine')} 统计</button>
    </div>
    <div class="pcap-stats hidden">
      <div class="pcap-chart pcap-chart-proto"></div>
      <div class="pcap-chart pcap-chart-time"></div>
    </div>
    <div class="pcap-list-head"></div>
    <div class="pcap-list-body"><div class="pcap-list-spacer"></div></div>
    <div class="pcap-hsplit" title="拖动调整列表/详情比例"></div>
    <div class="pcap-detail">
      <div class="pcap-detail-panes">
        <div class="pcap-tree"></div>
        <div class="pcap-hex"></div>
      </div>
      <div class="pcap-stream hidden">
        <div class="pcap-stream-head">
          <span class="pcap-stream-title"></span>
          <span class="pcap-stream-meta"></span>
          <span class="pcap-spacer"></span>
          <button class="btn small ghost pcap-stream-mode">十六进制</button>
          <button class="btn small ghost pcap-stream-close">${icon('x')} 关闭</button>
        </div>
        <div class="pcap-stream-body"></div>
      </div>
    </div>
    <div class="pcap-statusbar"></div>
    <div class="pcap-loading"><span class="pcap-spinner">${icon('loader')}</span>正在读取抓包文件…</div>
  `;

  const $ = <T extends HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`pcap 引擎结构缺失: ${sel}`);
    return el;
  };
  const filterInput = $<HTMLInputElement>('.pcap-filter-input');
  const filterErr = $('.pcap-filter-err');
  const countEl = $('.pcap-count');
  const statsBox = $('.pcap-stats');
  const listHead = $('.pcap-list-head');
  const listBody = $('.pcap-list-body');
  const spacer = $('.pcap-list-spacer');
  const treeEl = $('.pcap-tree');
  const hexEl = $('.pcap-hex');
  const detailPanes = $('.pcap-detail-panes');
  const streamBox = $('.pcap-stream');
  const statusEl = $('.pcap-statusbar');
  const loadingEl = $('.pcap-loading');

  /* ---- 数据状态 ---- */
  let capture: PcapFile | null = null;
  let decoded: (DecodedPacket | null)[] = [];
  let filtered: number[] = [];
  let predicate: PacketPredicate | null = null;
  /** 选中的包序号（packets 下标，-1 = 无；排序/过滤变化不受影响） */
  let selected = -1;
  let rowPool: HTMLDivElement[] = [];
  let stream: FollowStream | null = null;
  let streamHex = false;
  let protoChart: echarts.ECharts | null = null;
  let timeChart: echarts.ECharts | null = null;
  let statsBuilt = false;
  /** 时间列是否带日期（抓包跨天时） */
  let timeWithDate = false;
  let disposed = false;

  /* ---- 表头排序状态 ---- */
  type SortCol = 'no' | 'time' | 'src' | 'dst' | 'proto' | 'len' | 'info';
  let sortState: { col: SortCol; dir: 'asc' | 'desc' } | null = null;

  const HEAD_COLS: Array<{ key: SortCol; label: string }> = [
    { key: 'no', label: 'No.' },
    { key: 'time', label: '时间' },
    { key: 'src', label: '源' },
    { key: 'dst', label: '目的' },
    { key: 'proto', label: '协议' },
    { key: 'len', label: '长度' },
    { key: 'info', label: 'Info' },
  ];

  const packets = (): PcapPacket[] => capture?.packets ?? [];

  function ensureDecoded(i: number): DecodedPacket {
    let d = decoded[i];
    if (!d) {
      d = decodePacket(packets()[i]);
      decoded[i] = d;
    }
    return d;
  }

  function ensureDecodedAll(): void {
    for (let i = 0; i < packets().length; i++) ensureDecoded(i);
  }

  /* ---- 时间列 ---- */
  function fmtTime(p: PcapPacket): string {
    const d = new Date(p.tsSec * 1000);
    const z = (n: number, w = 2) => String(n).padStart(w, '0');
    const ms = String(Math.floor(p.tsNs / 1e6)).padStart(3, '0');
    const t = `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}.${ms}`;
    return timeWithDate ? `${z(d.getMonth() + 1)}-${z(d.getDate())} ${t}` : t;
  }

  /* ---------------- 表头排序 ---------------- */

  /** 排序比较器：src/dst/proto/info 需要解码（调用前 ensureDecodedAll） */
  function comparePackets(a: number, b: number): number {
    const st = sortState;
    if (!st) return a - b;
    const pa = packets()[a];
    const pb = packets()[b];
    let c = 0;
    switch (st.col) {
      case 'no': c = a - b; break;
      case 'time': c = pa.tsSec - pb.tsSec || pa.tsNs - pb.tsNs; break;
      case 'len': c = pa.origLen - pb.origLen; break;
      case 'src': c = ensureDecoded(a).src.localeCompare(ensureDecoded(b).src); break;
      case 'dst': c = ensureDecoded(a).dst.localeCompare(ensureDecoded(b).dst); break;
      case 'proto': c = ensureDecoded(a).proto.localeCompare(ensureDecoded(b).proto); break;
      case 'info': c = ensureDecoded(a).info.localeCompare(ensureDecoded(b).info); break;
    }
    return (st.dir === 'asc' ? c : -c) || (a - b); // 末位按序号稳定次序
  }

  function applySort(): void {
    if (!sortState) return;
    if (sortState.col !== 'no' && sortState.col !== 'time' && sortState.col !== 'len') {
      ensureDecodedAll();
    }
    filtered.sort(comparePackets);
    renderWindow();
  }

  function renderHeadArrows(): void {
    const st = sortState;
    for (const cell of listHead.querySelectorAll<HTMLElement>('.pcap-th')) {
      const key = cell.dataset.col;
      const arrow = cell.querySelector('.pcap-sort-arrow');
      if (arrow) arrow.textContent = st && st.col === key ? (st.dir === 'asc' ? '▲' : '▼') : '';
      cell.classList.toggle('sorted', st?.col === key);
    }
  }

  // 表头单元格：点击排序（同列再点切换升/降序）
  HEAD_COLS.forEach(({ key, label }) => {
    const cell = document.createElement('span');
    cell.className = 'pcap-th';
    cell.dataset.col = key;
    cell.title = '点击排序（再点切换升/降序）';
    const text = document.createElement('i');
    text.textContent = label;
    const arrow = document.createElement('b');
    arrow.className = 'pcap-sort-arrow';
    cell.append(text, arrow);
    cell.addEventListener('click', () => {
      if (!capture || filtered.length === 0) return;
      if (sortState?.col === key) {
        sortState = { col: key, dir: sortState.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        sortState = { col: key, dir: 'asc' };
      }
      renderHeadArrows();
      applySort();
    });
    listHead.appendChild(cell);
  });

  /* ---------------- 单元格「作为过滤器」 ---------------- */

  /** 单元格列 → 过滤表达式（时间/Info 列返回 null，菜单禁用） */
  function cellFilterExpr(p: PcapPacket, d: DecodedPacket, col: number): { expr: string; display: string } | null {
    switch (col) {
      case 0: return { expr: `frame.number == ${p.index + 1}`, display: `编号 ${p.index + 1}` };
      case 2:
        if (d.srcIp) return { expr: `ip.src == "${d.srcIp}"`, display: d.srcIp };
        if (d.srcMac) return { expr: `eth.src == "${d.srcMac}"`, display: d.srcMac };
        return null;
      case 3:
        if (d.dstIp) return { expr: `ip.dst == "${d.dstIp}"`, display: d.dstIp };
        if (d.dstMac) return { expr: `eth.dst == "${d.dstMac}"`, display: d.dstMac };
        return null;
      case 4: return { expr: `_ws.col.protocol == "${d.proto}"`, display: d.proto };
      case 5: return { expr: `frame.len == ${p.origLen}`, display: `长度 ${p.origLen}` };
      default: return null;
    }
  }

  /** 组合当前过滤器与单元格表达式（照 Wireshark Apply as Filter 的 6 种组合） */
  function combineFilter(mode: 'set' | 'and' | 'or', expr: string, negate: boolean): string {
    const e = negate ? `!(${expr})` : expr;
    const cur = filterInput.value.trim();
    if (mode === 'set' || !cur) return e;
    return `${cur} ${mode === 'and' ? '&&' : '||'} (${e})`;
  }

  function applyFilterText(text: string): void {
    filterInput.value = text;
    applyFilter();
  }

  /** 「作为过滤器」二级菜单（ui.showContextMenu 无子菜单能力，本地实现一层悬浮菜单） */
  let subMenuEl: HTMLElement | null = null;
  function closeSubMenu(): void {
    subMenuEl?.remove();
    subMenuEl = null;
    document.removeEventListener('mousedown', onSubMenuOutside, true);
  }
  function onSubMenuOutside(e: MouseEvent): void {
    if (subMenuEl && !subMenuEl.contains(e.target as Node)) closeSubMenu();
  }
  function showFilterSubMenu(x: number, y: number, expr: string, display: string): void {
    closeSubMenu();
    const el = document.createElement('div');
    el.className = 'ctx-menu';
    const items: Array<[string, string]> = [
      [`筛选 ${display}`, combineFilter('set', expr, false)],
      [`排除 ${display}`, combineFilter('set', expr, true)],
      [`…且筛选 ${display}`, combineFilter('and', expr, false)],
      [`…且排除 ${display}`, combineFilter('and', expr, true)],
      [`…或筛选 ${display}`, combineFilter('or', expr, false)],
      [`…或排除 ${display}`, combineFilter('or', expr, true)],
    ];
    for (const [label, next] of items) {
      const btn = document.createElement('button');
      btn.className = 'ctx-menu-item';
      btn.innerHTML = `<span>${label}</span>`;
      btn.title = next;
      btn.onclick = () => { closeSubMenu(); applyFilterText(next); };
      el.appendChild(btn);
    }
    document.body.appendChild(el);
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    subMenuEl = el;
    document.addEventListener('mousedown', onSubMenuOutside, true);
  }

  /* ---------------- 虚拟列表 ---------------- */

  function makeRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'pcap-row';
    for (let i = 0; i < 7; i++) row.appendChild(document.createElement('span'));
    row.addEventListener('click', () => {
      const idx = Number(row.dataset.fidx ?? -1);
      if (idx >= 0) selectRow(idx);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = Number(row.dataset.fidx ?? -1);
      if (idx < 0) return;
      selectRow(idx);
      const p = packets()[filtered[idx]];
      const d = ensureDecoded(filtered[idx]);
      // 命中的单元格列（作为过滤器的取值来源；点在行空白处则视为行级菜单）
      const cell = (e.target as HTMLElement).closest('span');
      const col = cell && row.contains(cell) ? Array.prototype.indexOf.call(row.children, cell) : -1;
      const cf = col >= 0 ? cellFilterExpr(p, d, col) : null;
      showContextMenu(e.clientX, e.clientY, [
        {
          label: '作为过滤器',
          iconName: 'filter',
          disabled: !cf,
          disabledTip: '该列不支持作为过滤条件',
          action: () => { if (cf) showFilterSubMenu(e.clientX, e.clientY, cf.expr, cf.display); },
        },
        'sep',
        {
          label: d?.transport === 'UDP' ? '追踪 UDP 流' : '追踪 TCP 流',
          iconName: 'arrowLeftRight',
          disabled: !d?.streamKey,
          disabledTip: '仅 TCP/UDP 包可追踪流',
          action: () => { if (d?.streamKey) followStream(d.streamKey); },
        },
        {
          label: '复制行摘要',
          iconName: 'copy',
          action: () => {
            void navigator.clipboard.writeText(
              `${p.index + 1} ${fmtTime(p)} ${d.src} → ${d.dst} ${d.proto} ${p.origLen} ${d.info}`,
            );
          },
        },
      ]);
    });
    return row;
  }

  function renderWindow(): void {
    if (!capture) return;
    const scrollTop = listBody.scrollTop;
    const height = listBody.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const end = Math.min(filtered.length - 1, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
    const need = Math.max(0, end - start + 1);
    while (rowPool.length < need) {
      const row = makeRow();
      rowPool.push(row);
      spacer.appendChild(row);
    }
    for (let i = 0; i < rowPool.length; i++) {
      const row = rowPool[i];
      if (i >= need) { row.style.display = 'none'; continue; }
      const fidx = start + i;
      const pidx = filtered[fidx];
      const p = packets()[pidx];
      const d = ensureDecoded(pidx);
      row.style.display = '';
      row.style.transform = `translateY(${fidx * ROW_H}px)`;
      row.dataset.fidx = String(fidx);
      row.className = `pcap-row ${protoClass(d.proto)}${pidx === selected ? ' sel' : ''}`;
      const cells = row.children;
      cells[0].textContent = String(pidx + 1);
      cells[1].textContent = fmtTime(p);
      cells[2].textContent = d.src;
      cells[3].textContent = d.dst;
      cells[4].textContent = d.proto;
      cells[5].textContent = String(p.origLen);
      cells[6].textContent = d.info;
    }
  }

  function relayoutList(): void {
    spacer.style.height = `${filtered.length * ROW_H}px`;
    listBody.scrollTop = 0;
    renderWindow();
  }

  function updateCount(): void {
    countEl.textContent = predicate
      ? `显示 ${fmtNum(filtered.length)} / 共 ${fmtNum(packets().length)} 包`
      : `共 ${fmtNum(filtered.length)} 包`;
  }

  function selectRow(fidx: number): void {
    const pidx = filtered[fidx];
    if (pidx === undefined || pidx === selected) return;
    selected = pidx;
    for (const row of rowPool) {
      const i = Number(row.dataset.fidx ?? -1);
      row.classList.toggle('sel', i >= 0 && filtered[i] === selected);
    }
    if (stream) closeStream();
    renderDetail();
  }

  /* ---------------- 详情：协议树 + hex ---------------- */

  let hlRange: { off: number; len: number } | null = null;

  function clearHighlight(): void {
    hlRange = null;
    for (const el of hexEl.querySelectorAll('.hl')) el.classList.remove('hl');
  }

  function applyHighlight(): void {
    if (!hlRange || hlRange.len <= 0) return;
    const from = hlRange.off;
    const to = hlRange.off + hlRange.len - 1;
    for (const el of hexEl.querySelectorAll<HTMLElement>('.hb')) {
      const off = Number(el.dataset.off);
      el.classList.toggle('hl', off >= from && off <= to);
    }
  }

  function renderTree(d: DecodedPacket): void {
    treeEl.innerHTML = '';
    d.layers.forEach((layer: ProtoLayer) => {
      const box = document.createElement('div');
      box.className = 'pcap-layer';
      const head = document.createElement('div');
      head.className = 'pcap-layer-head';
      head.innerHTML = `${icon('chevronDown')}<span></span>`;
      head.querySelector('span')!.textContent = layer.name;
      const fields = document.createElement('div');
      fields.className = 'pcap-layer-fields';
      for (const f of layer.fields) {
        const row = document.createElement('div');
        row.className = 'pcap-field';
        const name = document.createElement('span');
        name.className = 'pcap-field-name';
        name.textContent = f.name;
        const value = document.createElement('span');
        value.className = 'pcap-field-value';
        value.textContent = f.value;
        value.title = f.value;
        row.append(name, value);
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          clearHighlight();
          hlRange = { off: f.offset, len: f.len };
          applyHighlight();
        });
        fields.appendChild(row);
      }
      head.addEventListener('click', () => {
        if (!fields.classList.contains('collapsed')) {
          clearHighlight();
          hlRange = { off: layer.offset, len: layer.len };
          applyHighlight();
        } else {
          clearHighlight();
        }
        fields.classList.toggle('collapsed');
        head.classList.toggle('collapsed');
      });
      box.append(head, fields);
      treeEl.appendChild(box);
    });
  }

  function renderHex(bytes: Uint8Array): void {
    hexEl.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'pcap-hex-pre';
    const frag = document.createDocumentFragment();
    for (let line = 0; line < bytes.length; line += 16) {
      const offEl = document.createElement('span');
      offEl.className = 'pcap-hex-off';
      offEl.textContent = line.toString(16).padStart(4, '0') + '  ';
      frag.appendChild(offEl);
      const n = Math.min(16, bytes.length - line);
      for (let i = 0; i < 16; i++) {
        const cell = document.createElement('span');
        if (i < n) {
          cell.className = 'hb';
          cell.dataset.off = String(line + i);
          cell.textContent = bytes[line + i].toString(16).padStart(2, '0');
        } else {
          cell.textContent = '  ';
        }
        frag.appendChild(cell);
        frag.appendChild(document.createTextNode(i === 7 ? '  ' : ' '));
      }
      frag.appendChild(document.createTextNode(' '));
      for (let i = 0; i < n; i++) {
        const c = bytes[line + i];
        const ch = document.createElement('span');
        ch.className = 'hb pcap-hex-ascii';
        ch.dataset.off = String(line + i);
        ch.textContent = c >= 32 && c <= 126 ? String.fromCharCode(c) : '·';
        frag.appendChild(ch);
      }
      frag.appendChild(document.createTextNode('\n'));
    }
    pre.appendChild(frag);
    hexEl.appendChild(pre);
  }

  function renderDetail(): void {
    if (selected < 0 || selected >= packets().length) {
      treeEl.innerHTML = '<div class="pcap-hint">在列表中选择数据包查看协议详情</div>';
      hexEl.innerHTML = '';
      return;
    }
    const p = packets()[selected];
    const d = ensureDecoded(selected);
    clearHighlight();
    renderTree(d);
    renderHex(p.bytes);
  }

  /* ---------------- 流追踪 ---------------- */

  const streamTitle = $('.pcap-stream-title');
  const streamMeta = $('.pcap-stream-meta');
  const streamBody = $('.pcap-stream-body');
  const streamModeBtn = $<HTMLButtonElement>('.pcap-stream-mode');

  function followStream(key: string): void {
    ensureDecodedAll();
    const s = buildStream(packets(), decoded, key);
    if (!s) return;
    stream = s;
    streamHex = false;
    streamModeBtn.textContent = '十六进制';
    detailPanes.classList.add('hidden');
    streamBox.classList.remove('hidden');
    renderStream();
  }

  function closeStream(): void {
    stream = null;
    streamBox.classList.add('hidden');
    detailPanes.classList.remove('hidden');
  }

  function renderStream(): void {
    if (!stream) return;
    const [ep0, ep1] = stream.endpoints;
    streamTitle.textContent = `${stream.proto} 流`;
    streamMeta.textContent = `${ep0} ⇄ ${ep1} · ${fmtNum(stream.packetCount)} 包 · ${fmtBytes(stream.totalBytes)}`;
    streamBody.innerHTML = '';
    if (stream.chunks.length === 0) {
      streamBody.innerHTML = '<div class="pcap-hint">该流没有 payload 数据</div>';
      return;
    }
    const decoder = new TextDecoder('utf-8');
    stream.chunks.forEach((chunk) => {
      const block = document.createElement('div');
      block.className = `pcap-chunk dir${chunk.dir}`;
      const head = document.createElement('div');
      head.className = 'pcap-chunk-head';
      head.textContent = `${chunk.dir === 0 ? ep0 : ep1} → ${chunk.dir === 0 ? ep1 : ep0}（${fmtBytes(chunk.data.length)}）`;
      const pre = document.createElement('pre');
      pre.className = 'pcap-chunk-data';
      if (streamHex) {
        const lines: string[] = [];
        for (let line = 0; line < chunk.data.length; line += 16) {
          const n = Math.min(16, chunk.data.length - line);
          const hex: string[] = [];
          let ascii = '';
          for (let i = 0; i < n; i++) {
            hex.push(chunk.data[line + i].toString(16).padStart(2, '0'));
            const c = chunk.data[line + i];
            ascii += c >= 32 && c <= 126 ? String.fromCharCode(c) : '·';
          }
          lines.push(`${line.toString(16).padStart(4, '0')}  ${hex.join(' ').padEnd(47)}  ${ascii}`);
        }
        pre.textContent = lines.join('\n');
      } else {
        pre.textContent = decoder.decode(chunk.data);
      }
      block.append(head, pre);
      streamBody.appendChild(block);
    });
  }

  streamModeBtn.addEventListener('click', () => {
    streamHex = !streamHex;
    streamModeBtn.textContent = streamHex ? '文本' : '十六进制';
    renderStream();
  });
  $('.pcap-stream-close').addEventListener('click', closeStream);

  /* ---------------- 过滤器 ---------------- */

  function applyFilter(): void {
    const src = filterInput.value;
    let pred: PacketPredicate | null;
    try {
      pred = compileFilter(src);
    } catch (err) {
      filterErr.textContent = String(err instanceof Error ? err.message : err);
      filterErr.classList.remove('hidden');
      filterInput.classList.add('error');
      return;
    }
    filterErr.classList.add('hidden');
    filterInput.classList.remove('error');
    predicate = pred;
    if (pred) {
      ensureDecodedAll();
      const next: number[] = [];
      for (let i = 0; i < packets().length; i++) {
        if (pred(decoded[i]!)) next.push(i);
      }
      filtered = next;
    } else {
      filtered = packets().map((_, i) => i);
    }
    selected = -1;
    closeStream();
    // 过滤器变化后保持当前排序（排序键需要解码的列先全量解码）
    if (sortState) {
      if (sortState.col !== 'no' && sortState.col !== 'time' && sortState.col !== 'len') ensureDecodedAll();
      filtered.sort(comparePackets);
    }
    relayoutList();
    updateCount();
    renderDetail();
  }

  $<HTMLButtonElement>('.pcap-apply').addEventListener('click', applyFilter);
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyFilter();
  });
  $<HTMLButtonElement>('.pcap-clear').addEventListener('click', () => {
    if (!filterInput.value && !predicate) return;
    filterInput.value = '';
    applyFilter();
  });

  /* ---------------- 统计 ---------------- */

  function buildStats(): void {
    if (!capture || statsBuilt) return;
    statsBuilt = true;
    ensureDecodedAll();
    // 协议分布
    const protoCount = new Map<string, number>();
    for (let i = 0; i < packets().length; i++) {
      const proto = decoded[i]!.proto;
      protoCount.set(proto, (protoCount.get(proto) ?? 0) + 1);
    }
    const pieData = [...protoCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, value]) => ({ name, value }));
    // 时间曲线：60 桶
    const ps = packets();
    const t0 = ps[0]?.tsSec ?? 0;
    const t1 = ps[ps.length - 1]?.tsSec ?? t0;
    const span = Math.max(1, t1 - t0);
    const BUCKETS = 60;
    const pktBuckets = new Array<number>(BUCKETS).fill(0);
    const byteBuckets = new Array<number>(BUCKETS).fill(0);
    for (const p of ps) {
      const bi = Math.min(BUCKETS - 1, Math.floor(((p.tsSec - t0) / span) * BUCKETS));
      pktBuckets[bi]++;
      byteBuckets[bi] += p.origLen;
    }
    const labels = pktBuckets.map((_, i) => `${Math.round((span / BUCKETS) * i)}s`);

    const skin = {
      label: cssVar('--text-1', '#a8adbb'),
      grid: cssVar('--border', '#363c48'),
      value: cssVar('--text-0', '#e8eaf0'),
    };
    const protoEl = root.querySelector<HTMLElement>('.pcap-chart-proto');
    const timeEl = root.querySelector<HTMLElement>('.pcap-chart-time');
    if (protoEl) {
      protoChart = echarts.init(protoEl);
      protoChart.setOption({
        tooltip: { trigger: 'item' },
        legend: { orient: 'vertical', right: 4, top: 'middle', textStyle: { color: skin.label }, type: 'scroll' },
        series: [{
          type: 'pie', radius: ['38%', '68%'], center: ['38%', '50%'],
          label: { color: skin.value, formatter: '{b} {d}%' },
          data: pieData,
        }],
      });
    }
    if (timeEl) {
      timeChart = echarts.init(timeEl);
      timeChart.setOption({
        tooltip: { trigger: 'axis' },
        legend: { textStyle: { color: skin.label } },
        grid: { left: 56, right: 56, top: 32, bottom: 24 },
        xAxis: { type: 'category', data: labels, axisLabel: { color: skin.label } },
        yAxis: [
          { type: 'value', name: '包数', axisLabel: { color: skin.label }, splitLine: { lineStyle: { color: skin.grid } } },
          { type: 'value', name: 'KB', axisLabel: { color: skin.label }, splitLine: { show: false } },
        ],
        series: [
          { name: '包数', type: 'line', showSymbol: false, data: pktBuckets },
          { name: '字节', type: 'line', showSymbol: false, yAxisIndex: 1, data: byteBuckets.map((b) => Math.round(b / 1024)) },
        ],
      });
    }
  }

  $<HTMLButtonElement>('.pcap-stats-btn').addEventListener('click', () => {
    const show = statsBox.classList.contains('hidden');
    statsBox.classList.toggle('hidden', !show);
    if (show) {
      buildStats();
      requestAnimationFrame(() => { protoChart?.resize(); timeChart?.resize(); });
    }
  });

  /* ---------------- 添加到对话（PcapRef：过滤后包摘要快照，AI 侧展开见 ai-engine buildPrompt） ---------------- */

  /** 摘要行数上限：够 AI 看清构成，又不至于撑爆 prompt */
  const REF_MAX_LINES = 200;

  function buildPcapRef(): PcapRef | null {
    if (!capture) return null;
    ensureDecodedAll();
    const lines: string[] = [];
    for (let i = 0; i < Math.min(filtered.length, REF_MAX_LINES); i++) {
      const pidx = filtered[i];
      const p = packets()[pidx];
      const d = decoded[pidx]!;
      lines.push(`${pidx + 1}  ${fmtTime(p)}  ${d.src} → ${d.dst}  ${d.proto}  ${p.origLen}  ${d.info}`);
    }
    return {
      name: params.name,
      path: params.path,
      serverId: params.serverId ?? null,
      filter: filterInput.value.trim(),
      filtered: filtered.length,
      total: packets().length,
      lines,
      truncated: Math.max(0, filtered.length - lines.length),
    };
  }

  $<HTMLButtonElement>('.pcap-chat-btn').addEventListener('click', () => {
    const ref = buildPcapRef();
    if (!ref) { toast('抓包尚未加载完成', 'info'); return; }
    if (ref.filtered === 0) { toast('当前过滤结果为空，无可引用的报文', 'info'); return; }
    if (wbHandles.ai?.addPcapRef) {
      wbHandles.ai.addPcapRef(ref);
    } else {
      toast('AI 面板尚未就绪');
    }
  });

  /* ---------------- 分隔条拖拽 ---------------- */

  const hsplit = $('.pcap-hsplit');
  hsplit.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hsplit.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = listBody.getBoundingClientRect().height + listHead.getBoundingClientRect().height;
    const onMove = (ev: PointerEvent): void => {
      const total = root.getBoundingClientRect().height;
      const next = Math.min(Math.max(startH + (ev.clientY - startY), 96), total - 160);
      listHead.style.flex = 'none';
      listBody.style.flex = 'none';
      listBody.style.height = `${next - listHead.getBoundingClientRect().height}px`;
      renderWindow();
    };
    const onUp = (): void => {
      hsplit.removeEventListener('pointermove', onMove);
      hsplit.removeEventListener('pointerup', onUp);
    };
    hsplit.addEventListener('pointermove', onMove);
    hsplit.addEventListener('pointerup', onUp);
  });

  /* ---------------- 事件与观察器 ---------------- */

  let scrollRaf = 0;
  const onScroll = (): void => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      renderWindow();
    });
  };
  listBody.addEventListener('scroll', onScroll, { passive: true });

  const ro = new ResizeObserver(() => {
    renderWindow();
    if (!statsBox.classList.contains('hidden')) {
      protoChart?.resize();
      timeChart?.resize();
    }
  });
  ro.observe(listBody);

  /* ---------------- 加载 ---------------- */

  void (async () => {
    try {
      const res = await pcapRead(params.path, params.serverId);
      if (disposed) return;
      const bytes = base64ToBytes(res.data);
      const file = parseCapture(bytes);
      if (disposed) return;
      capture = file;
      decoded = new Array<DecodedPacket | null>(file.packets.length).fill(null);
      filtered = file.packets.map((_, i) => i);
      const ps = file.packets;
      timeWithDate = ps.length > 1 && ps[ps.length - 1].tsSec - ps[0].tsSec >= 24 * 3600;
      loadingEl.classList.add('hidden');
      relayoutList();
      updateCount();
      renderDetail();
      if (ps.length > 0) {
        const start = new Date(ps[0].tsSec * 1000);
        const dur = ps[ps.length - 1].tsSec - ps[0].tsSec;
        statusEl.textContent =
          `${params.name} · ${file.format} · ${fmtNum(ps.length)} 包 · ${fmtBytes(res.size)}` +
          ` · ${start.toLocaleString('zh-CN')} 起，时长 ${dur >= 60 ? `${Math.floor(dur / 60)}m${dur % 60}s` : `${dur}s`}`;
      } else {
        statusEl.textContent = `${params.name} · ${file.format} · 空文件（0 包）`;
      }
    } catch (err) {
      if (disposed) return;
      loadingEl.classList.add('hidden');
      statusEl.textContent = '';
      treeEl.innerHTML = `<div class="pcap-hint pcap-error-text"></div>`;
      treeEl.querySelector('.pcap-error-text')!.textContent = `打开失败：${String(err)}`;
      toast(String(err), 'error');
    }
  })();

  /* ---------------- 清理（标签关闭卸载时） ---------------- */

  return () => {
    disposed = true;
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    closeSubMenu();
    ro.disconnect();
    protoChart?.dispose();
    timeChart?.dispose();
    root.innerHTML = '';
    root.classList.remove('pcap-root');
  };
}
