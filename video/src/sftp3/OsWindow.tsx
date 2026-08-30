/**
 * 视频三:悬浮的系统文件资源管理器窗口(Windows 11 深色风格)。
 * 用于演示「系统 → AIShell 文件管理器 → SFTP」的拖拽链路,以及系统直拖 SFTP 被拒收。
 * position/opacity 由导演脚本控制,组件只负责窗口本体渲染。
 */
import React from 'react';
import { C, FONT_UI, FONT_MONO, ICONS } from '../theme';
import { EntryIcon } from './Wb3';
import { OS_WIN } from './layout';

export const OsWindow: React.FC<{ opacity: number; offsetY: number; dragRow: number | null }> = ({ opacity, offsetY, dragRow }) => {
  const files = [
    { name: 'app-config.yml', meta: '2026/8/30 10:58', type: 'YAML 配置' },
    { name: 'rollback.sh', meta: '2026/8/29 17:32', type: 'Shell 脚本' },
    { name: 'metrics-0830.csv', meta: '2026/8/30 09:14', type: 'CSV 文件' },
    { name: 'meeting-notes.txt', meta: '2026/8/28 16:40', type: '文本文档' },
  ];
  const btn = (icon: string): React.CSSProperties => ({
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    color: '#c8ccd4',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: OS_WIN.x,
        top: OS_WIN.y,
        width: OS_WIN.w,
        height: OS_WIN.h,
        opacity,
        transform: `translateY(${offsetY}px)`,
        background: '#1e1f24',
        border: '1px solid #3a3d45',
        borderRadius: 10,
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        fontFamily: FONT_UI,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 标题栏 */}
      <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 6px 0 14px', gap: 8 }}>
        <svg viewBox="0 0 24 24" width={15} height={15} style={{ flex: 'none' }}>
          <g dangerouslySetInnerHTML={{ __html: ICONS.folder }} fill="#93c5fd" stroke="#2563eb" strokeWidth={1.8} strokeLinejoin="round" />
        </svg>
        <span style={{ fontSize: 12.5, color: '#e8eaf0' }}>下载</span>
        <div style={{ flex: 1 }} />
        {(['minus', 'square', 'x'] as const).map((n) => (
          <div key={n} style={{ width: 34, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a8adbb' }}>
            <svg viewBox="0 0 24 24" width={n === 'square' ? 11 : 13} height={n === 'square' ? 11 : 13} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <g dangerouslySetInnerHTML={{ __html: ICONS[n] }} />
            </svg>
          </div>
        ))}
      </div>
      {/* 工具行:导航 + 地址栏 */}
      <div style={{ height: 44, flex: 'none', display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px' }}>
        {(['arrowLeft', 'arrowRight', 'arrowUp'] as const).map((n) => (
          <div key={n} style={btn(n)}>
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <g dangerouslySetInnerHTML={{ __html: ICONS[n] }} />
            </svg>
          </div>
        ))}
        <div style={{ flex: 1, height: 30, marginLeft: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', background: '#26272d', border: '1px solid #3a3d45', borderRadius: 15, fontSize: 12, color: '#a8adbb' }}>
          <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="#6b7180" strokeWidth={1.8}>
            <g dangerouslySetInnerHTML={{ __html: ICONS.folder }} />
          </svg>
          此电脑 › 下载
        </div>
        <div style={{ width: 120, height: 30, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', background: '#26272d', border: '1px solid #3a3d45', borderRadius: 15, fontSize: 12, color: '#6b7180' }}>
          <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.8}>
            <g dangerouslySetInnerHTML={{ __html: ICONS.search }} />
          </svg>
          搜索
        </div>
      </div>
      {/* 表头 */}
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 14px', borderBottom: '1px solid #31343c', fontSize: 11.5, color: '#8b93a5' }}>
        <span style={{ flex: 1 }}>名称</span>
        <span style={{ width: 130 }}>修改日期</span>
        <span style={{ width: 100 }}>类型</span>
      </div>
      {/* 文件行 */}
      {files.map((f, i) => {
        const dragging = dragRow === i;
        return (
          <div
            key={f.name}
            style={{
              height: 32,
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              padding: '0 14px',
              fontSize: 12.5,
              color: dragging ? '#9ac1f5' : '#d5d8df',
              background: dragging ? 'rgba(79,142,247,0.16)' : i % 2 === 1 ? 'rgba(255,255,255,0.025)' : 'transparent',
              opacity: dragging ? 0.45 : 1,
            }}
          >
            <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <EntryIcon kind="file" size={16} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
            </span>
            <span style={{ width: 130, color: '#8b93a5', fontSize: 11.5 }}>{f.meta}</span>
            <span style={{ width: 100, color: '#8b93a5', fontSize: 11.5 }}>{f.type}</span>
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
      <div style={{ height: 26, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 14px', borderTop: '1px solid #31343c', fontSize: 11, color: '#6b7180', fontFamily: FONT_MONO }}>
        4 个项目
      </div>
    </div>
  );
};
