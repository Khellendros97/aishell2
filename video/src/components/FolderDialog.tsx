/**
 * 「选择文件夹」对话框复刻:应用内暗色风格(与窗口同套设计令牌)。
 * 几何局部坐标来自 ../scene.ts(DLG_ROW1 / DLG_CONFIRM),指针锚点与设计稿一致。
 */
import React from 'react';
import { C, FONT_UI } from '../theme';
import { Icon } from '../ui';
import { DIALOG, DLG_CONFIRM, DLG_ROW1 } from '../scene';

const FOLDERS = [
  { name: 'workspace', date: '2026/8/28 10:24' },
  { name: '项目备份', date: '2026/8/21 16:02' },
  { name: '学习资料', date: '2026/7/30 09:41' },
];

export const FolderDialog: React.FC<{
  t: number;
  selected: boolean;
  hoverRow: boolean;
  hoverConfirm: boolean;
  pressConfirm: boolean;
}> = ({ t, selected, hoverRow, hoverConfirm, pressConfirm }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      background: 'rgba(8,10,14,0.45)',
      opacity: t,
      fontFamily: FONT_UI,
    }}
  >
    <div
      style={{
        position: 'absolute',
        left: DIALOG.x,
        top: DIALOG.y,
        width: DIALOG.w,
        height: DIALOG.h,
        background: C.bg1,
        border: `1px solid ${C.borderStrong}`,
        borderRadius: 12,
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
        transform: `scale(${0.96 + 0.04 * t})`,
        transformOrigin: 'center center',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontSize: 13,
        color: C.text0,
      }}
    >
      {/* 标题栏 */}
      <div style={{ height: 44, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: `1px solid ${C.border}` }}>
        <Icon name="folder" size={16} color={C.accent} />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>选择文件夹</span>
        <div style={{ flex: 1 }} />
        <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2 }}>
          <Icon name="x" size={13} />
        </div>
      </div>

      {/* 地址栏 */}
      <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px' }}>
        <Icon name="chevronLeft" size={15} color={C.text2} />
        <Icon name="chevronRight" size={15} color={C.text2} />
        <div
          style={{
            flex: 1,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 10px',
            background: C.bg2,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            fontSize: 12,
            color: C.text1,
          }}
        >
          此电脑 <Icon name="chevronRight" size={11} color={C.text2} /> 数据盘 (D:) <Icon name="chevronRight" size={11} color={C.text2} />
          <span style={{ color: C.text0, fontWeight: 600 }}>AIShellDemo</span>
        </div>
      </div>

      {/* 列表头 */}
      <div
        style={{
          height: 26,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 26px',
          fontSize: 11,
          color: C.text2,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <span style={{ flex: 1 }}>名称</span>
        <span style={{ width: 150 }}>修改日期</span>
      </div>

      {/* 文件夹列表 */}
      <div style={{ flex: 1, padding: 6 }}>
        {FOLDERS.map((f, i) => {
          const isSel = i === 0 && selected;
          const isHover = i === 0 && hoverRow && !selected;
          return (
            <div
              key={f.name}
              style={{
                height: DLG_ROW1.h,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 20px 0 14px',
                borderRadius: 6,
                background: isSel ? C.accentDim : isHover ? C.bgHover : 'transparent',
                outline: isSel ? `1px solid ${C.accent}` : 'none',
              }}
            >
              <Icon name="folder" size={16} color={isSel ? C.accent : C.text1} />
              <span style={{ flex: 1, color: isSel ? C.accent : C.text0, fontWeight: isSel ? 600 : 400 }}>{f.name}</span>
              <span style={{ width: 150, fontSize: 11.5, color: C.text2 }}>{f.date}</span>
            </div>
          );
        })}
      </div>

      {/* 底部按钮 */}
      <div
        style={{
          height: 56,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          borderTop: `1px solid ${C.border}`,
          background: C.bg1,
        }}
      >
        <span style={{ fontSize: 12, color: selected ? C.accent : C.text2 }}>{selected ? '已选择：workspace' : '项目将默认创建在所选文件夹中'}</span>
        <div style={{ flex: 1 }} />
        <div
          style={{
            width: 72,
            height: DLG_CONFIRM.h,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            background: C.bg2,
            marginRight: 12,
            fontSize: 12.5,
          }}
        >
          取消
        </div>
        <div
          style={{
            width: DLG_CONFIRM.w,
            height: DLG_CONFIRM.h,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 4,
            background: hoverConfirm ? C.accentHover : C.accent,
            color: '#fff',
            fontSize: 12.5,
            fontWeight: 500,
            transform: pressConfirm ? 'translateY(0.5px)' : 'none',
          }}
        >
          选择文件夹
        </div>
      </div>
    </div>
  </div>
);
