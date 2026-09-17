/**
 * 顶栏复刻(两个场景共用):对照 src/components/Topbar.tsx。
 * 无边框自绘标题栏:品牌 + 导航(项目/设置/账号) + 主题 + 窗口控制。
 * 右侧簇布局决定 scene.ts 的 ACCOUNT_BTN 锚点,改这里要同步核对锚点。
 */
import React from 'react';
import { C, FONT_UI } from '../theme';
import { Icon, Logo } from '../ui';

export const TopBar: React.FC<{
  active: '项目' | '设置' | '账号';
  project?: string;
  accountHover?: boolean;
  /** 版本号文案(缺省 v0.7.4;新视频可传当前真实版本) */
  version?: string;
  /** 顶部导航锚点 id(锚点实测:高亮/指针用;不传则不打 data-anchor) */
  anchors?: { project?: string; settings?: string; account?: string };
}> = ({ active, project, accountHover, version = 'v0.7.4', anchors }) => (
  <div
    style={{
      height: 40,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '0 8px 0 16px',
      background: C.bg1,
      borderBottom: `1px solid ${C.border}`,
      fontFamily: FONT_UI,
    }}
  >
    <Logo size={22} />
    <span style={{ fontWeight: 600, fontSize: 14, color: C.text0 }}>AIShell</span>
    <span style={{ fontSize: 11, color: C.text2, marginTop: 2 }}>{version}</span>
    {project && (
      <>
        <span style={{ color: C.borderStrong }}>/</span>
        <span style={{ fontSize: 12.5, color: C.text1 }}>{project}</span>
      </>
    )}
    <div style={{ flex: 1 }} />
    {(['项目', '设置', '账号'] as const).map((label, i) => {
      const isActive = label === active;
      const hovered = label === '账号' && accountHover;
      const anchorId = anchors && (['project', 'settings', 'account'] as const)[i];
      return (
        <div
          key={label}
          data-anchor={anchorId ? anchors![anchorId] : undefined}
          style={{
            padding: '5px 12px',
            borderRadius: 6,
            fontSize: 13,
            color: isActive ? C.accent : hovered ? C.text0 : C.text1,
            background: isActive ? C.accentDim : hovered ? C.bgHover : 'transparent',
            fontWeight: isActive ? 600 : 400,
          }}
        >
          {label}
        </div>
      );
    })}
    <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
      <Icon name="sun" size={15} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 6 }}>
      {(['minus', 'square', 'x'] as const).map((n) => (
        <div key={n} style={{ width: 34, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
          <Icon name={n} size={n === 'square' ? 11 : 13} strokeWidth={1.6} />
        </div>
      ))}
    </div>
  </div>
);
