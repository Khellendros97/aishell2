/**
 * 激励计划宣传片 —— 品牌令牌 + 渠道数据表。
 * 蓝紫渐变取自主仓 src/styles/design.css `.btn.brand-gradient`（#6366f1 → #8b5cf6 → #d946ef），
 * 与 Skill Hub / 「发布工单日志」按钮同一套配色。
 * 分值与维度键取自 docs/AIShell云服务-激励计划API文档.md §3.1/§3.2 默认值——
 * 规则调整只需改这张表，画面与文案自动跟随。
 */
import type { IconName } from '../theme';

export const BRAND = {
  g1: '#6366f1',
  g2: '#8b5cf6',
  g3: '#d946ef',
  /** 主渐变（与 CSS 同参） */
  grad: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 55%, #d946ef 100%)',
  /** 横向渐变（大字标题用） */
  gradX: 'linear-gradient(92deg, #7c83ff 0%, #a855f7 48%, #e879f9 100%)',
  /** 低透明渐变（卡片/胶囊底） */
  gradDim: 'linear-gradient(135deg, rgba(99,102,241,0.20) 0%, rgba(139,92,246,0.20) 55%, rgba(217,70,239,0.20) 100%)',
  /** 辉光 */
  glow: 'rgba(139,92,246,0.55)',
  glowSoft: 'rgba(139,92,246,0.24)',
} as const;

/** 宣传片暗底：比教学视频更冷、对比更高，给渐变留出亮度空间 */
export const INK = {
  bg0: '#07070f',
  bg1: '#0c0e1a',
  bg2: '#141828',
  line: 'rgba(255,255,255,0.10)',
  line2: 'rgba(255,255,255,0.16)',
  card: 'rgba(22,26,42,0.72)',
  cardSolid: '#161a2a',
  text0: '#f5f7fc',
  text1: '#a9b0c7',
  text2: '#6c7389',
  green: '#4ec98a',
  yellow: '#e5c07b',
} as const;

/** 120 BPM —— 15 帧/拍；所有镜头与动效切点落在拍上，便于替换正式配乐后卡点。 */
export const BEAT = 15;

export interface Channel {
  /** 编号（画面左上章节标） */
  no: string;
  /** 渠道名 */
  title: string;
  /** 一句话说明 */
  sub: string;
  icon: IconName;
  /** 明细/排行接口的 snake_case 维度键（§3.1） */
  dimension: string;
  /** 规则接口中文名（与 IncentiveView DIMENSION_LABELS 同源） */
  dimensionLabel: string;
  /** 默认分值 */
  points: number;
  /** 计分单位 */
  unit: string;
}

/** 五大得分渠道（§3.1/§3.2） */
export const CHANNELS: Channel[] = [
  {
    no: '01', title: '命令与传输', sub: '终端执行命令 · SFTP 操作',
    icon: 'terminal', dimension: 'manual_ops', dimensionLabel: '人工命令/SFTP', points: 5, unit: '次',
  },
  {
    no: '02', title: 'AI 助手', sub: '让 AI 帮你写脚本、查日志、跑命令',
    icon: 'bot', dimension: 'ai_tool', dimensionLabel: 'AI 工具调用', points: 1, unit: '次',
  },
  {
    no: '03', title: '工单日志', sub: '把一次问题处理沉淀成工单报告',
    icon: 'ticket', dimension: 'ticket_report', dimensionLabel: '工单报告', points: 20, unit: '条',
  },
  {
    no: '04', title: '上传 Skill', sub: '上传到 Skill Hub，被同事引用还能再得分',
    icon: 'package', dimension: 'skill_upload', dimensionLabel: 'skill 上传', points: 20, unit: '个',
  },
  {
    no: '05', title: '问题反馈', sub: '提交缺陷或建议，改进产品的同时得分',
    icon: 'message', dimension: 'feedback', dimensionLabel: '问题反馈', points: 10, unit: '次',
  },
];

/** 第 4 渠道的附加维度：Skill 被引用（§3.1 skill_reference，1 分/次） */
export const SKILL_REF = { dimension: 'skill_reference', label: 'skill 被引用', points: 1, unit: '次' } as const;
