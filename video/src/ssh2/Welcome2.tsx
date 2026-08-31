/**
 * 视频二场景 A:欢迎页「新建项目 + 新建服务器 + 自动创建凭据」复刻。
 * 对照 .proto/welcome.html 的页面/模态框/mini 服务器表单结构与 welcome.js 的保存流程:
 * mini 保存 → 凭据(user@host)自动创建 + 服务器自动选中 + toast「服务器已创建并自动选中」;
 * 项目保存 → toast「项目已创建」+ 新卡片入网格。
 * 布局锚点见 ../ssh2/layout.ts(以本文件 CSS 为准校准)。
 */
import React from 'react';
import { C, FONT_MONO, FONT_UI } from '../theme';
import { Icon } from '../ui';
import { TopBar } from '../components/TopBar';
import { WIN_H, WIN_W } from '../scene';
import { NEW_PROJ_BTN, PROJ_CARD3, PROJ_MODAL, WELCOME } from './layout';

export interface WelcomeState {
  /** 模态框 0 关 → 1 开 */
  modalT: number;
  projName: string;
  /** mini 服务器表单展开 */
  miniOpen: boolean;
  miniName: string;
  miniHost: string;
  miniUser: string;
  /** 密码输入字符数(渲染为圆点) */
  miniSecretLen: number;
  /** mini 已保存(服务器卡片选中显示) */
  serverSaved: boolean;
  /** 项目已保存(模态框关闭,新卡片出现) */
  projectSaved: boolean;
  /** 凭据注释浮现 0→1 */
  credNoteT: number;
  toast: string | null;
  focus: 'name' | 'miniName' | 'miniHost' | 'miniUser' | 'miniSecret' | null;
  hover: 'newProj' | 'serverAdd' | 'miniSave' | 'save' | 'card3' | null;
  press: 'newProj' | 'serverAdd' | 'miniSave' | 'save' | null;
}

const EXISTING = [
  { name: '数据中台-etl', path: 'D:\\AIShellDemo\\workspace\\数据中台-etl', tags: ['仅本地'] },
  { name: '官网重构', path: 'D:\\projects\\website-redesign', tags: ['仅本地'] },
];

const NEW_CARD = { name: 'deephaven-bigdata', path: 'D:\\AIShellDemo\\workspace\\deephaven-bigdata', tags: ['deephaven-dev-01'] };

const Tag: React.FC<{ text: string; tone?: 'blue' | 'green' | 'yellow' | 'plain' }> = ({ text, tone = 'plain' }) => {
  const style =
    tone === 'blue'
      ? { background: C.accentDim, color: C.accentHover }
      : tone === 'green'
        ? { background: 'rgba(78,201,138,0.14)', color: C.green }
        : tone === 'yellow'
          ? { background: 'rgba(229,192,123,0.14)', color: C.yellow }
          : { background: C.bg3, color: C.text1 };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        borderRadius: 10,
        fontSize: 11,
        lineHeight: '18px',
        ...style,
      }}
    >
      {text}
    </span>
  );
};

const Field: React.FC<{ label: string; req?: boolean; children: React.ReactNode; mb?: number }> = ({ label, req, children, mb = 16 }) => (
  <div style={{ marginBottom: mb }}>
    <div style={{ fontSize: 13, fontWeight: 500, color: C.text0, height: 18, marginBottom: 6 }}>
      {label}
      {req && <span style={{ color: C.red }}> *</span>}
    </div>
    {children}
  </div>
);

const inputStyle = (focused: boolean): React.CSSProperties => ({
  height: 32,
  display: 'flex',
  alignItems: 'center',
  padding: '0 10px',
  background: C.bg2,
  border: `1px solid ${focused ? C.accent : C.border}`,
  borderRadius: 4,
  fontSize: 12.5,
  color: C.text0,
});

const Caret: React.FC = () => <span style={{ display: 'inline-block', width: 1.5, height: 15, background: C.accent, marginLeft: 1 }} />;

export const Welcome2: React.FC<{ state: WelcomeState; frame: number }> = ({ state, frame }) => {
  const { modalT, projName, miniOpen, miniName, miniHost, miniUser, miniSecretLen, serverSaved, projectSaved, credNoteT, toast, focus, hover, press } = state;

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
      <TopBar active="项目" />

      <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 0, display: 'flex' }}>
        {/* 主区 */}
        <div style={{ width: WELCOME.mainW, padding: '20px 24px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 32, marginBottom: 18 }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>我的项目</span>
            <Tag text={`${projectSaved ? 3 : 2} 个项目`} />
            <div style={{ flex: 1 }} />
            <div style={{ padding: '5px 12px', borderRadius: 4, fontSize: 12.5, color: C.text1 }}>重置演示数据</div>
            <div
              style={{
                width: NEW_PROJ_BTN.w,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                background: hover === 'newProj' ? C.accentHover : C.accent,
                borderRadius: 4,
                color: '#fff',
                fontSize: 13,
                fontWeight: 500,
                transform: press === 'newProj' ? 'translateY(0.5px)' : 'none',
              }}
            >
              <Icon name="plus" size={13} color="#fff" />
              新建项目
            </div>
          </div>

          {/* 项目卡片网格 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {(projectSaved ? [...EXISTING, NEW_CARD] : EXISTING).map((p, i) => (
              <div
                key={p.name}
                style={{
                  background: hover === 'card3' && i === 2 ? C.bg3 : C.bg1,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  height: PROJ_CARD3.h - 24,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <Icon name="pencil" size={13} color={C.text2} />
                  <Icon name="trash" size={13} color={C.text2} />
                </div>
                <div style={{ fontSize: 12, color: C.text2, fontFamily: FONT_MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.path} {!p.path.startsWith('D:\\projects') && <Tag text="workspace" tone="yellow" />}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {p.tags.map((t) => (
                    <Tag key={t} text={t} tone={t === '仅本地' ? 'plain' : 'blue'} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧 AI aside(静态示意) */}
        <div style={{ flex: 1, borderLeft: `1px solid ${C.border}`, background: C.bg1 }}>
          <div style={{ height: 42, display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', borderBottom: `1px solid ${C.border}`, fontSize: 13, fontWeight: 600 }}>
            <Icon name="bot" size={15} color={C.accent} />
            AI 助手
          </div>
          <div style={{ padding: 16, fontSize: 12, color: C.text2 }}>本地任务面板(无需项目)</div>
        </div>
      </div>

      {/* ===== 新建项目模态框 ===== */}
      {modalT > 0 && (
        <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * modalT})` }}>
          <div
            style={{
              position: 'absolute',
              left: PROJ_MODAL.x,
              top: PROJ_MODAL.y,
              width: PROJ_MODAL.w,
              background: C.bg1,
              border: `1px solid ${C.borderStrong}`,
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
              opacity: modalT,
              transform: `scale(${0.96 + 0.04 * modalT})`,
            }}
          >
            <div style={{ height: 52, display: 'flex', alignItems: 'center', padding: '0 20px', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>新建项目</span>
              <Icon name="x" size={14} color={C.text2} />
            </div>
            <div style={{ padding: '16px 20px 4px' }}>
              <Field label="项目名称" req>
                <div style={{ ...inputStyle(focus === 'name') }}>
                  {projName}
                  {focus === 'name' && <Caret />}
                  {!projName && <span style={{ color: C.text2 }}>例如：数据中台 ETL</span>}
                </div>
              </Field>
              <Field label="项目路径">
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ ...inputStyle(false), flex: 1 }}>
                    <span style={{ color: C.text2 }}>例如：D:\projects\my-app</span>
                  </div>
                  <div
                    style={{
                      height: 32,
                      padding: '0 14px',
                      display: 'flex',
                      alignItems: 'center',
                      background: C.bg2,
                      border: `1px solid ${C.border}`,
                      borderRadius: 4,
                      fontSize: 12.5,
                    }}
                  >
                    浏览…
                  </div>
                </div>
                <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.55, color: C.text2 }}>
                  选择目录后将在其下创建 .aishell 工作目录；留空则在全局 workspace 目录中新建项目目录。
                </div>
              </Field>
              <Field label="绑定远程服务器（可多选）" mb={0}>
                {!serverSaved && !miniOpen && <div style={{ fontSize: 12, color: C.text2, padding: '6px 2px' }}>暂无服务器，可在下方新建</div>}
                {serverSaved && (
                  <div
                    style={{
                      padding: '10px 12px',
                      background: C.bg2,
                      border: `1px solid ${C.accent}`,
                      borderRadius: 8,
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1, fontWeight: 500 }}>deephaven-dev-01</span>
                      <Tag text="密码" tone="green" />
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, color: C.text2, fontFamily: FONT_MONO }}>10.21.36.8:22</div>
                  </div>
                )}

                {/* 新建服务器 toggle / mini 表单 */}
                {!miniOpen && !serverSaved && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '10px 12px',
                      border: `1px dashed ${hover === 'serverAdd' ? C.accent : C.borderStrong}`,
                      borderRadius: 8,
                      color: hover === 'serverAdd' ? C.text0 : C.text1,
                      background: hover === 'serverAdd' ? C.bgHover : 'transparent',
                      fontSize: 12.5,
                      textAlign: 'center',
                      transform: press === 'serverAdd' ? 'translateY(0.5px)' : 'none',
                    }}
                  >
                    ＋ 新建服务器连接
                  </div>
                )}
                {miniOpen && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '14px 14px 8px',
                      border: `1px dashed ${C.borderStrong}`,
                      borderRadius: 8,
                      background: C.bg2,
                    }}
                  >
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 12 }}>
                      <Field label="名称" req mb={12}>
                        <div style={{ ...inputStyle(focus === 'miniName') }}>
                          {miniName}
                          {focus === 'miniName' && <Caret />}
                          {!miniName && <span style={{ color: C.text2 }}>例如：测试服务器</span>}
                        </div>
                      </Field>
                      <Field label="IP 地址" req mb={12}>
                        <div style={{ ...inputStyle(focus === 'miniHost'), fontFamily: FONT_MONO }}>
                          {miniHost}
                          {focus === 'miniHost' && <Caret />}
                          {!miniHost && <span style={{ color: C.text2 }}>例如：192.168.1.10</span>}
                        </div>
                      </Field>
                      <Field label="端口" req mb={12}>
                        <div style={{ ...inputStyle(false), fontFamily: FONT_MONO }}>22</div>
                      </Field>
                      <Field label="认证方式" mb={12}>
                        <div style={{ ...inputStyle(false), justifyContent: 'space-between' }}>
                          密码
                          <Icon name="chevronDown" size={12} color={C.text2} />
                        </div>
                      </Field>
                      <Field label="账号" mb={12}>
                        <div style={{ ...inputStyle(focus === 'miniUser'), fontFamily: FONT_MONO }}>
                          {miniUser}
                          {focus === 'miniUser' && <Caret />}
                          {!miniUser && <span style={{ color: C.text2 }}>例如：root</span>}
                        </div>
                      </Field>
                      <Field label="密码" mb={12}>
                        <div style={{ ...inputStyle(focus === 'miniSecret'), fontFamily: FONT_MONO }}>
                          {'•'.repeat(miniSecretLen)}
                          {focus === 'miniSecret' && <Caret />}
                          {!miniSecretLen && <span style={{ color: C.text2 }}>输入服务器密码</span>}
                        </div>
                      </Field>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingBottom: 6 }}>
                      <div
                        style={{
                          height: 30,
                          padding: '0 14px',
                          display: 'flex',
                          alignItems: 'center',
                          background: C.bg1,
                          border: `1px solid ${C.border}`,
                          borderRadius: 4,
                          fontSize: 12.5,
                        }}
                      >
                        收起
                      </div>
                      <div
                        style={{
                          height: 30,
                          padding: '0 14px',
                          display: 'flex',
                          alignItems: 'center',
                          background: hover === 'miniSave' ? C.accentHover : C.accent,
                          borderRadius: 4,
                          color: '#fff',
                          fontSize: 12.5,
                          transform: press === 'miniSave' ? 'translateY(0.5px)' : 'none',
                        }}
                      >
                        保存
                      </div>
                    </div>
                  </div>
                )}
              </Field>
            </div>
            <div style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 20px', borderTop: `1px solid ${C.border}` }}>
              <div
                style={{
                  height: 32,
                  padding: '0 14px',
                  display: 'flex',
                  alignItems: 'center',
                  background: C.bg2,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  fontSize: 13,
                }}
              >
                取消
              </div>
              <div
                style={{
                  height: 32,
                  padding: '0 14px',
                  display: 'flex',
                  alignItems: 'center',
                  background: hover === 'save' ? C.accentHover : C.accent,
                  borderRadius: 4,
                  color: '#fff',
                  fontSize: 13,
                  transform: press === 'save' ? 'translateY(0.5px)' : 'none',
                }}
              >
                保存
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 凭据自动创建注释(教学叠加层,非应用 UI) */}
      {credNoteT > 0 && (
        <div
          style={{
            position: 'absolute',
            left: PROJ_MODAL.x + PROJ_MODAL.w + 24,
            top: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 14px',
            background: 'rgba(13,15,20,0.92)',
            border: `1px solid ${C.accent}`,
            borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            fontSize: 12.5,
            color: C.accentHover,
            opacity: credNoteT,
            transform: `translateX(${(1 - credNoteT) * 12}px)`,
            whiteSpace: 'nowrap',
          }}
        >
          <Icon name="key" size={14} />
          凭据 devops@10.21.36.8 已自动创建并入库
        </div>
      )}

      {/* toast */}
      {toast && (
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
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
};
