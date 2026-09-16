/**
 * 激励计划宣传片导演脚本（合成 IncentivePromo）。
 * 30fps，共 2250 帧（75 秒）；镜头/动效切点都在 15 帧（120BPM）的倍数上。
 *
 * 九幕：A 片头 → B 渠道总览 → C1..C5 五个渠道各 210 帧 → D 积分总览 → E 结尾。
 * 舞台：C/D 幕用视频坐标系（1920×1080），窗口按真实 1440×900 等比缩放（layout.SCALE）浮在中央；
 * 指针/高亮环/点击涟漪全部走锚点实测（components/anchors.tsx），逐帧贴住真实控件,
 * 常量只作锚点未挂载前的兜底（layout.ANCHOR_FALLBACK）。
 * 相机原则（沿用教学视频教训）：涉及点击的瞬间必须 hold 停稳——先全景 hold，再推近 hold，
 * 点完 hold，然后回全景；每渠道末帧回到全景，给下一幕留缓冲。
 */
import type { Stop } from '../anim';
import type { AnchorStop } from '../components/anchors';
import type { Click } from '../components/Cursor';
import { CHANNELS } from './brand';
import { ANCHOR_FALLBACK, CH_BEATS, CH_TIMING, WIN, WIN_C } from './layout';

export const DURATION = 2250;

export const C_START = [390, 600, 810, 1020, 1230];
export const CH_LEN = 210;
export const ACT = { A0: 0, B0: 240, C1: 390, C2: 600, C3: 810, C4: 1020, C5: 1230, D0: 1440, E0: 1890 };

/** 推近倍率（真实 UI 细节可读；只做居中缩放，不平移，避免边缘控件把窗口推出画面） */
const ZOOM = 1.2;

/* ---------------- 指针 / 点击 / 高亮 / 相机（锚点实测定位） ---------------- */

const pointerPath: AnchorStop[] = [];
const clicks: Click[] = [];
const highlights: Array<{ target: string; pad: number; from: number; to: number }> = [];
/* 相机始终取景窗口中心（居中缩放），不平移 */
const camS: Stop[] = [{ f: 0, v: 1.0 }, { f: ACT.C1, v: 1.0 }];
const camX: Stop[] = [{ f: 0, v: WIN_C.x }, { f: DURATION, v: WIN_C.x }];
const camY: Stop[] = [{ f: 0, v: WIN_C.y }, { f: DURATION, v: WIN_C.y }];

/** 上一个指针停留锚点（节拍间平滑过渡用；null = 画面外固定点） */
let prevAt: string | null = null;
const OFFSCREEN = { x: WIN.x + WIN.w + 40, y: WIN.y + WIN.h + 30 };

for (let i = 0; i < CH_BEATS.length; i += 1) {
  const S = C_START[i];
  const beats = CH_BEATS[i];
  camS.push({ f: S + 4, v: 1.0 });

  for (const b of beats) {
    const fb = ANCHOR_FALLBACK[b.at];
    const clickF = S + b.f;

    // 指针：从上一停留点滑到控件中心 → 停稳 → 点击 → 稍作停留
    // （上一停留点 = 上一锚点右下方；锚点实测生效前用 ANCHOR_FALLBACK 兜底）
    if (prevAt) {
      const pfb = ANCHOR_FALLBACK[prevAt];
      pointerPath.push({ f: clickF - 46, at: prevAt, dx: 180, dy: 130, x: pfb.x + 180, y: pfb.y + 130 });
    } else {
      pointerPath.push({ f: clickF - 46, x: OFFSCREEN.x, y: OFFSCREEN.y });
    }
    pointerPath.push({ f: clickF - 22, at: b.at, x: fb.x, y: fb.y });
    pointerPath.push({ f: clickF + 12, at: b.at, x: fb.x, y: fb.y });

    clicks.push({ f: clickF, x: fb.x, y: fb.y, anchor: b.at, target: b.kind === 'row' ? 'row' : 'confirm' });
    highlights.push({ target: b.at, pad: 3, from: clickF - 26, to: clickF + 6 });

    // 相机：clickF-34 hold → clickF 缩放到 ZOOM（zoom=false 则保持 1.0）→ clickF+8 hold → clickF+26 回 1.0
    camS.push(
      { f: clickF - 34, v: 1.0 },
      { f: clickF, v: b.zoom ? ZOOM : 1.0 },
      { f: clickF + 8, v: b.zoom ? ZOOM : 1.0 },
      { f: clickF + 26, v: 1.0 },
    );

    prevAt = b.at;
  }
  // 指针离开画面右下（下一幕重新进入）
  pointerPath.push({ f: S + CH_LEN - 26, x: OFFSCREEN.x, y: OFFSCREEN.y });
  prevAt = null;
}
camS.push({ f: ACT.D0, v: 1.0 }, { f: ACT.E0, v: 1.0 }, { f: 1980, v: 1.05 }, { f: DURATION, v: 1.0 });

export const CLICKS = clicks;
export const HIGHLIGHTS = highlights;
export const CAM_S: Stop[] = camS;
export const CAM_X: Stop[] = camX;
export const CAM_Y: Stop[] = camY;
/** 指针轨道：at 锚点逐帧实测解析（useAnchorTrack），x/y 为未挂载兜底或画面外固定点 */
export const CUR_PATH: readonly AnchorStop[] = pointerPath;

/** 指针可见区间：仅渠道演示期（首幕入场后淡入，末幕离场前淡出） */
export const CURSOR_OPACITY: Stop[] = [
  { f: C_START[0] + 40, v: 0 },
  { f: C_START[0] + 60, v: 1 },
  { f: C_START[4] + CH_LEN - 34, v: 1 },
  { f: C_START[4] + CH_LEN - 14, v: 0 },
];

/* ---------------- 字幕 ---------------- */

export interface Cap { from: number; to: number; text: string }

export const CAPTIONS: Cap[] = [
  // A 片头
  { from: 36, to: 116, text: '你每天在 AIShell 里的操作，都在悄悄攒积分' },
  { from: 148, to: 228, text: '五个渠道 · 规则公开 · 全员可见' },
  // B 渠道总览
  { from: 250, to: 320, text: '先看哪几件事能得分' },
  { from: 336, to: 386, text: '从敲命令到提反馈，全都有分' },
  // C1 命令与传输
  { from: 400, to: 466, text: '连上服务器，敲命令、传文件' },
  { from: 480, to: 586, text: '每一次操作，人工命令 / SFTP +5 分' },
  // C2 AI 助手
  { from: 610, to: 686, text: '遇到问题，直接问 AI 助手' },
  { from: 700, to: 796, text: 'AI 工具调用 +1 分，积少成多' },
  // C3 工单日志
  { from: 820, to: 894, text: '把一次问题处理，沉淀成工单日志' },
  { from: 908, to: 1006, text: '审核通过，工单报告 +20 分' },
  // C4 上传 Skill
  { from: 1030, to: 1104, text: '把常用流程做成 Skill 传上去' },
  { from: 1118, to: 1216, text: 'skill 上传 +20 分，被同事引用再 +1/次' },
  // C5 问题反馈
  { from: 1240, to: 1314, text: '发现缺陷或有好建议，提个反馈' },
  { from: 1328, to: 1426, text: '问题反馈 +10 分，产品也一起变好' },
  // D 积分总览
  { from: 1470, to: 1560, text: '所有积分实时结算，明细清清楚楚' },
  { from: 1596, to: 1700, text: '排行榜全员公开——看看谁在领跑' },
  { from: 1740, to: 1852, text: '分越高，排名越靠前' },
  // E 结尾
  { from: 1900, to: 1978, text: '做任务，得积分' },
  { from: 2016, to: 2102, text: '五大渠道，处处可得分' },
  { from: 2120, to: 2200, text: 'AIShell 激励计划 · 全员参与' },
];

/* ---------------- 幕判定 ---------------- */

export function channelAt(frame: number): { i: number; t: number } | null {
  for (let i = 0; i < C_START.length; i += 1) {
    const s = C_START[i];
    if (frame >= s && frame < s + CH_LEN) return { i, t: frame - s };
  }
  return null;
}

/** 舞台层不透明度：渠道幕与 D 幕可见 */
export function stageAlpha(frame: number): number {
  if (frame < ACT.C1 - 6) return 0;
  if (frame < ACT.C1 + 12) return (frame - (ACT.C1 - 6)) / 18;
  if (frame < ACT.E0 + 2) return 1;
  if (frame < ACT.E0 + 24) return 1 - (frame - (ACT.E0 + 2)) / 22;
  return 0;
}

/** 分值结算卡文案（渠道演示期） */
export function popFor(i: number): { label: string; points: number; unit: string; sub: string } | null {
  if (i === 3) {
    return { label: CHANNELS[3].dimensionLabel, points: CHANNELS[3].points, unit: CHANNELS[3].unit, sub: 'skill 被引用另有 +1/次' };
  }
  const ch = CHANNELS[i];
  return { label: ch.dimensionLabel, points: ch.points, unit: ch.unit, sub: ch.sub };
}

export { WIN, WIN_C };
