/**
 * 设计令牌:色值逐字段取自主仓 src/styles/design.css 暗色主题,图标 path 取自 src/icons.ts。
 * 改主仓配色/图标时这里要同步。
 */

export const C = {
  bg0: '#1b1d23',
  bg1: '#21252d',
  bg2: '#262b34',
  bg3: '#2e3440',
  bgHover: 'rgba(255,255,255,0.06)',
  border: '#363c48',
  borderStrong: '#454c5a',
  text0: '#e8eaf0',
  text1: '#a8adbb',
  text2: '#6b7180',
  accent: '#4f8ef7',
  accentHover: '#6ba1f8',
  accentDim: 'rgba(79,142,247,0.16)',
  link: '#8db9ff',
  yellow: '#e5c07b',
  green: '#4ec98a',
  red: '#e5626a',
};

export const FONT_UI = '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
export const FONT_MONO = '"Cascadia Code", "JetBrains Mono", Consolas, monospace';

/** 图标 path(与 src/icons.ts 同名条目一致,lucide 风格 24 viewBox) */
export const ICONS = {
  zap: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  key: '<circle cx="7.5" cy="16.5" r="4.5"/><path d="M10.7 13.3 21 3"/><path d="M16 8l3 3"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  plug: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M6 7h12v4a6 6 0 0 1-12 0V7z"/><path d="M12 17v4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert:
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.93 19.07l1.41-1.41"/><path d="M17.66 6.34l1.41-1.41"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  terminal: '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',
  server:
    '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01"/><path d="M6 17.5h.01"/>',
  note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a2 2 0 0 1 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="13" r="0.5"/><circle cx="15" cy="13" r="0.5"/><path d="M9 17h6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  minus: '<path d="M5 12h14"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
} as const;

export type IconName = keyof typeof ICONS;
