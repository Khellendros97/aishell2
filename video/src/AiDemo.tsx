/**
 * 场景二:工作台 AI 助手演示(知识库查询 + 联网搜索)。
 * 时间线 570–1240;570–600 从黑场淡入,结尾由 Video.tsx 统一淡出。
 *
 * 段落:
 *   570–655  全景淡入并停留           655–700 推镜到右侧 AI 面板
 *   690–770  点击输入框 → 键入问题 1 → 回车
 *   780–870  AI 输入中 → kb_search 工具行 → 流式回答(知识库)
 *   905–985  点击输入框 → 键入问题 2 → 回车
 *   995–1100 AI 输入中 → web_search 工具行 → 流式回答(联网搜索)
 *   1130–1185 拉镜回全景收尾
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Stop, track1 } from './anim';
import { Click, Cursor } from './components/Cursor';
import { ChatMsg, Workbench } from './components/Workbench';
import { AI_INPUT, AI_PANEL, WIN_H, WIN_W } from './scene';

/* ---------- 布局派生(先于轨道声明,模块求值有序) ---------- */
/** 面板水平中心:推镜焦点与指针起始共用 */
const PANEL_CX = AI_PANEL.x + AI_PANEL.w / 2;
/** 指针驻留位:对话区右下角空白处,不遮挡气泡与输入框 */
const PARK = { x: AI_PANEL.x + AI_PANEL.w - 55, y: 985 };

/* ---------- 摄像机轨道 ---------- */
const CAM_S: readonly Stop[] = [
  { f: 570, v: 0.75 },
  { f: 655, v: 0.75 },
  { f: 700, v: 1.55 },
  { f: 1140, v: 1.55 },
  { f: 1195, v: 0.75 },
];
const CAM_X: readonly Stop[] = [
  { f: 570, v: 960 },
  { f: 655, v: 960 },
  { f: 700, v: PANEL_CX },
  { f: 1140, v: PANEL_CX },
  { f: 1195, v: 960 },
];
const CAM_Y: readonly Stop[] = [
  { f: 570, v: 600 },
  { f: 655, v: 600 },
  { f: 700, v: 830 },
  { f: 1140, v: 830 },
  { f: 1195, v: 600 },
];

/* ---------- 指针轨道(设计稿坐标) ---------- */
/* 到位后静置约 10 帧再点击(对齐场景一的悬停手感) */
const CUR_X: readonly Stop[] = [
  { f: 575, v: PANEL_CX },
  { f: 690, v: PANEL_CX },
  { f: 720, v: AI_INPUT.x },
  { f: 778, v: AI_INPUT.x },
  { f: 793, v: PARK.x },
  { f: 915, v: PARK.x },
  { f: 945, v: AI_INPUT.x },
  { f: 1000, v: AI_INPUT.x },
  { f: 1015, v: PARK.x },
];
const CUR_Y: readonly Stop[] = [
  { f: 575, v: 900 },
  { f: 690, v: 900 },
  { f: 720, v: AI_INPUT.y },
  { f: 778, v: AI_INPUT.y },
  { f: 793, v: PARK.y },
  { f: 915, v: PARK.y },
  { f: 945, v: AI_INPUT.y },
  { f: 1000, v: AI_INPUT.y },
  { f: 1015, v: PARK.y },
];

const CLICKS: readonly Click[] = [
  { f: 730, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
  { f: 955, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
];

/* ---------- 问答内容与节拍 ---------- */
const Q1 = '你服务于哪家企业？';
const A1 = '根据知识库搜索结果，我服务于深澜软件有限公司。';
const Q2 = 'openEuler 最新稳定版的版本号？';
const A2 = '根据公开信息，openEuler 最新的稳定版是 openEuler 24.03 LTS SP4。';
const TOOL1 = 'kb_search 你服务于哪家企业';
const TOOL2 = 'web_search openEuler 最新稳定版 版本号';

/** 键入窗口 */
const Q1_TYPE = { from: 734, to: 767 };
const Q2_TYPE = { from: 959, to: 992 };
/** 回车帧(输入清空、用户气泡出现) */
const ENTER1 = 778;
const ENTER2 = 1000;
/** AI 应答窗口:输入中 → 工具行 → 流式文本 */
const A1_PHASE = { typing: 788, tool: 826, textFrom: 832, textTo: 880 };
const A2_PHASE = { typing: 1010, tool: 1043, textFrom: 1050, textTo: 1114 };

/** 由帧号推导消息列表与输入框状态(纯函数) */
function chatAt(frame: number): { msgs: ChatMsg[]; inputText: string; inputCaret: boolean; inputFocus: boolean } {
  const msgs: ChatMsg[] = [];
  let inputText = '';
  const typingChars = (from: number, to: number, full: string): string =>
    full.slice(0, Math.floor(interpolate(frame, [from, to], [0, full.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })));

  /* 问答一:知识库 */
  if (frame < ENTER1) {
    inputText = typingChars(Q1_TYPE.from, Q1_TYPE.to, Q1);
  } else {
    msgs.push({ role: 'user', text: Q1 });
    if (frame >= A1_PHASE.typing) {
      const len = Math.floor(
        interpolate(frame, [A1_PHASE.textFrom, A1_PHASE.textTo], [0, A1.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
      );
      msgs.push({
        role: 'ai',
        text: A1.slice(0, len),
        tool: frame >= A1_PHASE.tool ? TOOL1 : undefined,
        /* len 为 0 时保持三点指示,首字符出现即无缝交接,避免气泡塌缩抖动 */
        typing: len === 0,
      });
    }
  }

  /* 问答二:联网搜索(问题一完成后才开始键入) */
  if (frame >= Q2_TYPE.from) {
    if (frame < ENTER2) {
      inputText = typingChars(Q2_TYPE.from, Q2_TYPE.to, Q2);
    } else {
      msgs.push({ role: 'user', text: Q2 });
      if (frame >= A2_PHASE.typing) {
        const len = Math.floor(
          interpolate(frame, [A2_PHASE.textFrom, A2_PHASE.textTo], [0, A2.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        );
        msgs.push({
          role: 'ai',
          text: A2.slice(0, len),
          tool: frame >= A2_PHASE.tool ? TOOL2 : undefined,
          typing: len === 0,
        });
      }
    }
  }

  const inputFocus = (frame >= 730 && frame <= ENTER1) || (frame >= 955 && frame <= ENTER2);
  const inputCaret = inputFocus && inputText.length > 0;
  return { msgs, inputText, inputCaret, inputFocus };
}

export const AiDemo: React.FC = () => {
  const frame = useCurrentFrame();

  const cam = { s: track1(CAM_S, frame), cx: track1(CAM_X, frame), cy: track1(CAM_Y, frame) };
  const cur = { x: track1(CUR_X, frame), y: track1(CUR_Y, frame) };

  const fade = interpolate(frame, [570, 600], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const cursorOpacity = interpolate(frame, [575, 585], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pressing = CLICKS.some((c) => frame >= c.f && frame < c.f + 6);

  return (
    <AbsoluteFill style={{ background: 'radial-gradient(1200px 800px at 50% 38%, #232733 0%, #101218 72%)', opacity: fade }}>
      <AbsoluteFill
        style={{
          width: WIN_W,
          height: WIN_H,
          flex: 'none',
          transform: `translate(${960 - cam.cx * cam.s}px, ${540 - cam.cy * cam.s}px) scale(${cam.s})`,
          transformOrigin: '0 0',
        }}
      >
        <Workbench state={chatAt(frame)} frame={frame} />
        <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressing ? 0.84 : 1} clicks={CLICKS} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
