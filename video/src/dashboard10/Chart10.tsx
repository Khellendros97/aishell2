/**
 * 流量监控折线图(echarts 视觉仿制,SVG 手绘保证逐帧渲染确定性,禁真实 echarts):
 * 双折线(入/出)+ 网格 + 图例 + draw-on 生长动画 + 峰值 tooltip。
 * 峰值数据点打 data-anchor="chart-peak" 供指针 hover 与 tooltip 定位(测量归一化为画布坐标)。
 * 内部一律用卡片局部坐标(窗口坐标 - 卡片原点),根节点定位到卡片内 (8, 26)。
 */
import React from 'react';
import { interpolate } from 'remotion';
import { C, FONT_MONO } from '../theme';
import { CHART, CHART_GEO, CHART_IN, CHART_LINE, CHART_LINE2, CHART_OUT, PEAK_HOUR, chartX, chartY } from './layout';

/** 卡片内图表原点(窗口坐标):面板 x48 + padding 8,卡片顶 CHART.y + 标题 26(标题改为绝对定位,wrapper 即此原点) */
const ORG = { x: 48 + 8, y: CHART.y + CHART.titleH };
const lx = (i: number): number => chartX(i) - ORG.x;
const ly = (v: number): number => chartY(v) - ORG.y;

export const Chart10: React.FC<{ draw: number; tooltip: boolean }> = ({ draw, tooltip }) => {
  const { w, h, padL, padR, padT, padB, yMax } = CHART_GEO;
  const plotH = h - padT - padB;
  const inPath = CHART_IN.map((v, i) => `${i === 0 ? 'M' : 'L'}${lx(i).toFixed(1)} ${ly(v).toFixed(1)}`).join(' ');
  const outPath = CHART_OUT.map((v, i) => `${i === 0 ? 'M' : 'L'}${lx(i).toFixed(1)} ${ly(v).toFixed(1)}`).join(' ');
  const len = Math.ceil((w - padL - padR) * 1.4);
  const dash = interpolate(draw, [0, 1], [len, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const px = lx(PEAK_HOUR);
  const py = ly(CHART_IN[PEAK_HOUR]);
  return (
    <div style={{ position: 'absolute', left: CHART_GEO.x - ORG.x, top: CHART_GEO.y - ORG.y, width: w, height: h }}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {/* 网格(虚线;刻度文字一律走下方 HTML 层——SVG text 在缩放层里每帧重栅格化结果不稳,会剧烈抖动) */}
        {[0, 250, 500].map((v) => {
          const gy = padT + (1 - v / yMax) * plotH;
          return (
            <line key={v} x1={padL} y1={gy} x2={w - padR} y2={gy} stroke={C.border} strokeWidth={1} strokeDasharray={v === 0 ? undefined : '3 4'} />
          );
        })}
        {/* 折线(draw-on:stroke-dashoffset 插值)+ 入站面积淡填充 */}
        <path d={outPath} fill="none" stroke={CHART_LINE2} strokeWidth={1.8} strokeDasharray={len} strokeDashoffset={dash} strokeLinejoin="round" />
        <path d={`${inPath} L${lx(23)} ${padT + plotH} L${lx(0)} ${padT + plotH} Z`} fill={`${CHART_LINE}22`} opacity={draw} />
        <path d={inPath} fill="none" stroke={CHART_LINE} strokeWidth={2.2} strokeDasharray={len} strokeDashoffset={dash} strokeLinejoin="round" />
        {/* 峰值点(锚点)+ 竖参考线 */}
        <line x1={px} y1={py} x2={px} y2={padT + plotH} stroke={`${CHART_LINE}66`} strokeWidth={1} strokeDasharray="3 3" opacity={draw} />
        <circle
          data-anchor="chart-peak"
          cx={px}
          cy={py}
          r={tooltip ? 4.5 : 3}
          fill={CHART_LINE}
          stroke="#fff"
          strokeWidth={1.5}
        />
      </svg>
      {/* 轴刻度(HTML 层,HTML 文本在本渲染管线下逐帧稳定;位置对照原 SVG text:基线 y=gy+3.5 / y=h-6) */}
      {[0, 250, 500].map((v) => {
        const gy = padT + (1 - v / yMax) * plotH;
        return (
          <div
            key={v}
            style={{
              position: 'absolute', left: 0, width: padL - 6, top: gy - 5, textAlign: 'right',
              fontSize: 9, lineHeight: '10px', color: C.text2, fontFamily: FONT_MONO,
            }}
          >
            {v}
          </div>
        );
      })}
      {[0, 6, 12, 18, 23].map((i) => (
        <div
          key={i}
          style={{
            position: 'absolute', left: lx(i) - 15, width: 30, top: h - 16, textAlign: 'center',
            fontSize: 9, lineHeight: '10px', color: C.text2, fontFamily: FONT_MONO,
          }}
        >
          {String(i).padStart(2, '0')}
        </div>
      ))}
      {/* 图例 */}
      <div style={{ position: 'absolute', right: 2, top: -2, display: 'flex', gap: 10, fontSize: 10, color: C.text1 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: CHART_LINE }} />
          入站
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: CHART_LINE2 }} />
          出站
        </span>
      </div>
      {/* 峰值 tooltip(点下方,避免压卡片标题) */}
      {tooltip && (
        <div
          style={{
            position: 'absolute', left: px - 158, top: py + 14, padding: '5px 9px', borderRadius: 5,
            background: 'rgba(20,23,30,0.96)', border: `1px solid ${C.borderStrong}`,
            fontSize: 10.5, lineHeight: '15px', color: C.text0, whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
          }}
        >
          <span style={{ fontFamily: FONT_MONO, color: C.text2 }}>20:00</span>
          <span style={{ fontFamily: FONT_MONO, color: CHART_LINE }}> 入 480</span>
          <span style={{ fontFamily: FONT_MONO, color: CHART_LINE2 }}> / 出 310 Mbps</span>
        </div>
      )}
    </div>
  );
};
