/**
 * AIShell 设置窗口复刻(设计稿坐标系 1920×1200)。
 * 逐字段对照 src/pages/settings/Settings.tsx「功能特性」页与 src/components/Topbar.tsx 顶栏;
 * 布局几何数值来自 ../scene.ts,与运镜/指针锚点共用,保证指针落点精确。
 */
import React from 'react';
import { C, FONT_MONO, FONT_UI } from '../theme';
import { Icon } from '../ui';
import { TopBar } from './TopBar';
import { BANNER_H, BROWSE_BTN, PANEL, SAVE_BTN, TOPBAR_H, WIN_H, WIN_W } from '../scene';
import { FolderDialog } from './FolderDialog';

export type HoverTarget = 'browse' | 'save' | 'account' | 'row' | 'confirm' | null;

export interface WinState {
  /** workspace 输入框当前值(空串显示 placeholder) */
  workspace: string;
  /** 输入中显示光标 */
  showCaret: boolean;
  /** 警告条:0 显示 → 1 收起 */
  bannerT: number;
  /** 「设置已保存」toast:0 隐藏 → 1 显示 */
  toastT: number;
  /** 文件夹对话框:0 关闭 → 1 打开 */
  dialogT: number;
  /** 对话框内 workspace 行是否选中 */
  dialogSelected: boolean;
  hover: HoverTarget;
  press: 'browse' | 'save' | 'confirm' | null;
}

const NAV_ITEMS = [
  { icon: 'zap', label: '功能特性', active: true },
  { icon: 'key', label: '凭据库', active: false },
  { icon: 'monitor', label: '外观', active: false },
  { icon: 'key', label: '快捷键', active: false },
  { icon: 'plug', label: 'API 接口', active: false },
  { icon: 'info', label: '关于与更新', active: false },
] as const;

const Checkbox: React.FC<{ checked: boolean }> = ({ checked }) => (
  <div
    style={{
      width: 16,
      height: 16,
      borderRadius: 4,
      flex: 'none',
      background: checked ? C.accent : C.bg2,
      border: `1px solid ${checked ? C.accent : C.borderStrong}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    {checked && (
      <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="#fff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )}
  </div>
);

/** fieldset 分组(对照 .llm-group) */
const Group: React.FC<{ legend: string; height: number; children: React.ReactNode }> = ({ legend, height, children }) => (
  <fieldset
    style={{
      height,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: '12px 14px',
      margin: '0 0 12px',
      overflow: 'hidden',
    }}
  >
    <legend style={{ padding: '0 6px', fontSize: 12.5, fontWeight: 600, color: C.text1 }}>{legend}</legend>
    {children}
  </fieldset>
);

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 13, fontWeight: 500, color: C.text0, height: 18, marginBottom: 6 }}>{children}</div>
);

const Hint: React.FC<{ children: React.ReactNode; mt?: number }> = ({ children, mt = 6 }) => (
  <div style={{ marginTop: mt, fontSize: 12, lineHeight: 1.55, color: C.text2 }}>{children}</div>
);

export const AppWindow: React.FC<{ state: WinState }> = ({ state }) => {
  const { workspace, showCaret, bannerT, toastT, dialogT, dialogSelected, hover, press } = state;

  return (
    <div
      style={{
        position: 'absolute',
        width: WIN_W,
        height: WIN_H,
        background: C.bg0,
        color: C.text0,
        fontFamily: FONT_UI,
        fontSize: 13,
        borderRadius: 14,
        border: `1px solid ${C.borderStrong}`,
        overflow: 'hidden',
        boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
      }}
    >
      {/* ===== 顶栏(对照 Topbar.tsx) ===== */}
      <TopBar active="设置" accountHover={hover === 'account'} />

      {/* ===== 缺少配置警告条(对照 #warn-banner) ===== */}
      <div
        style={{
          height: BANNER_H * (1 - bannerT),
          opacity: 1 - bannerT,
          overflow: 'hidden',
          background: 'linear-gradient(90deg, rgba(229,192,123,0.15), rgba(229,192,123,0.08))',
          borderBottom: bannerT >= 1 ? 'none' : '1px solid rgba(229,192,123,0.3)',
        }}
      >
        <div style={{ height: BANNER_H, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', color: '#e8d9ae', fontSize: 13 }}>
          <Icon name="alert" size={15} color={C.yellow} />
          缺少必要配置，请先完成系统设置
        </div>
      </div>

      {/* ===== 设置主体(警告条收起时整体上移) ===== */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: TOPBAR_H + BANNER_H * (1 - bannerT), bottom: 0, display: 'flex' }}>
        {/* 左侧导航(对照 SETTINGS_NAV) */}
        <div style={{ width: 200, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, padding: '10px 8px' }}>
          {NAV_ITEMS.map((item) => (
            <div
              key={item.label}
              style={{
                height: 32,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 10px',
                borderRadius: 6,
                marginBottom: 2,
                fontSize: 13,
                color: item.active ? C.accent : C.text1,
                background: item.active ? C.accentDim : 'transparent',
                fontWeight: item.active ? 600 : 400,
              }}
            >
              <Icon name={item.icon} size={15} />
              {item.label}
            </div>
          ))}
        </div>

        {/* 内容区(对照 #panel-features) */}
        <div style={{ flex: 1, minWidth: 0, background: C.bg0, padding: '24px 28px', position: 'relative' }}>
          <div style={{ width: PANEL.w }}>
            <div style={{ height: 24, fontSize: 17, fontWeight: 600, marginBottom: 18 }}>功能特性</div>

            {/* Workspace 目录 */}
            <div style={{ marginBottom: 20 }}>
              <FieldLabel>
                Workspace 目录<span style={{ color: C.red }}> *</span>
              </FieldLabel>
              <div style={{ height: 34, display: 'flex', gap: 8, alignItems: 'center' }}>
                <div
                  style={{
                    flex: 1,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 10px',
                    background: C.bg2,
                    border: `1px solid ${C.border}`,
                    borderRadius: 4,
                    fontFamily: FONT_MONO,
                    fontSize: 12.5,
                    color: C.text0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {workspace ? (
                    <>
                      {workspace}
                      {showCaret && <span style={{ width: 1.5, height: 15, background: C.accent, marginLeft: 1 }} />}
                    </>
                  ) : (
                    <span style={{ color: C.text2, userSelect: 'none' }}>D:\AIShellWorkspace</span>
                  )}
                </div>
                <div
                  style={{
                    width: BROWSE_BTN.w,
                    height: 32,
                    flex: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: hover === 'browse' ? C.bg3 : C.bg2,
                    border: `1px solid ${hover === 'browse' ? C.borderStrong : C.border}`,
                    borderRadius: 4,
                    fontSize: 12.5,
                    transform: press === 'browse' ? 'translateY(0.5px)' : 'none',
                  }}
                >
                  浏览…
                </div>
              </div>
              <Hint>项目默认创建目录</Hint>
            </div>

            <Group legend="AI 工作区域" height={122}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 18, marginBottom: 6 }}>
                <FieldLabel>自动切换 AI 工作区域</FieldLabel>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Checkbox checked />
                <span style={{ fontSize: 12.5, color: C.text1 }}>启用</span>
              </div>
              <Hint>开启后 AI 输入框显示固定工作区域标签（默认本地）：打开或切换到 SSH/本地终端时自动跟随；发送消息时把当前工作区域作为上下文提供给 AI 助手</Hint>
            </Group>

            <Group legend="AI 审批" height={156}>
              <FieldLabel>审批模式</FieldLabel>
              <div
                style={{
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 10px',
                  background: C.bg2,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  fontSize: 13,
                }}
              >
                智能审批
                <Icon name="chevronDown" size={14} color={C.text2} />
              </div>
              <Hint>智能审批：AI 操作先由大模型判定，非危险操作（常规读写、查询、构建等）自动放行并展示「已智能放行」；删除、服务启停、格式化等危险操作仍需人工确认</Hint>
            </Group>

            <Group legend="远程文件备份" height={144}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 18, marginBottom: 6 }}>
                <FieldLabel>自动备份远程文件</FieldLabel>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Checkbox checked />
                <span style={{ fontSize: 12.5, color: C.text1 }}>启用</span>
              </div>
              <Hint>开启后，AI 会话第一次修改某个远程文件前自动保存原始快照（会话级暂存区），可在 AI 对话区右键「打开文件暂存区」查看 diff、接受或还原</Hint>
            </Group>

            <Group legend="MCP 服务（外部 agent 工具接入）" height={236}>
              <FieldLabel>监听端口</FieldLabel>
              <div
                style={{
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 10px',
                  background: C.bg2,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  fontFamily: FONT_MONO,
                  fontSize: 12.5,
                }}
              >
                8945
              </div>
              <Hint>仅监听本机回环 127.0.0.1，不对外网开放。每台服务器可在「服务器卡片 → 更多 → MCP」中单独启用并配置功能开关；启用后外部工具经 http://127.0.0.1:端口/mcp 接入</Hint>
              <div style={{ marginTop: 12 }}>
                <FieldLabel>服务状态</FieldLabel>
                <div style={{ fontSize: 12, color: C.text2 }}>未运行（当前没有启用 MCP 的服务器；在服务器卡片「更多 → MCP」中启用后自动启动）</div>
              </div>
            </Group>

            {/* 保存按钮(对照 .form-actions #btn-save-system) */}
            <div style={{ marginTop: 12, height: 34, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
              <div
                style={{
                  width: SAVE_BTN.w,
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: hover === 'save' ? C.accentHover : C.accent,
                  borderRadius: 4,
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 500,
                  transform: press === 'save' ? 'translateY(0.5px)' : 'none',
                }}
              >
                保存
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 「设置已保存」toast ===== */}
      {toastT > 0 && (
        <div
          style={{
            position: 'absolute',
            right: 24,
            bottom: 24,
            padding: '11px 18px',
            background: C.bg2,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 8,
            fontSize: 12.5,
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            opacity: toastT,
            transform: `translateY(${(1 - toastT) * 12}px)`,
          }}
        >
          设置已保存
        </div>
      )}

      {/* ===== 文件夹选择对话框 ===== */}
      {dialogT > 0 && (
        <FolderDialog
          t={dialogT}
          selected={dialogSelected}
          hoverRow={hover === 'row'}
          hoverConfirm={hover === 'confirm'}
          pressConfirm={press === 'confirm'}
        />
      )}
    </div>
  );
};
