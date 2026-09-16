/**
 * 激励计划宣传片 —— 五个渠道的真实 UI 场景。
 * 每个场景都用主仓的真实类名与真实 DOM 结构（real-ui.css + rui.tsx 的骨架组件），
 * 内容取自 src/pages/workbench/...（终端 / SFTP / AI 面板 / 笔记 / Skill）与 src/pages/account/...。
 * 动效仍由幕内局部帧 t 驱动（确定性）。
 */
import React from 'react';
import { Easing, interpolate, spring } from 'remotion';
import '../incentive-promo/real-ui.css';
import { AI, CTR, FEEDBACK, L, NATIVE, NOTE, SCALE, SFTP, SKILL, TABS, TERM, TICKET, WIN, WIN_C } from './layout';
import { AiPanel, AiSessionBar, Ic, PanelName, Sidebar, Statusbar, TabBar, Topbar, Workbench, TabDef } from './rui';

/* ---------------- 通用 ---------------- */

const rv = (t: number, start: number, dur = 8): number =>
  interpolate(t, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

const typed = (t: number, start: number, text: string, per = 1.7): string =>
  text.slice(0, Math.max(0, Math.min(text.length, Math.floor((t - start) / per))));

/** 悬浮窗口：内部按真实 1440×900 绘制，整体等比缩放到 WIN 外框（保持真实比例与布局） */
export const Frame: React.FC<{ t: number; inAt: number; outAt: number; children: React.ReactNode }> = ({
  t,
  inAt,
  outAt,
  children,
}) => {
  if (t < inAt - 2) return null;
  const p = spring({ frame: Math.max(0, t - inAt), fps: 30, config: { damping: 19, mass: 0.9, stiffness: 90 } });
  const out = interpolate(t, [outAt, outAt + 16], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: Math.min(1, p * 1.6) * out, transform: `translateY(${(1 - p) * 20}px)` }}>
      <NativeFrame>{children}</NativeFrame>
    </div>
  );
};

/** 真实窗口外壳（无动画）：1440×900 的 .rui 容器缩放到 WIN 外框；D 幕积分页等复用。 */
export const NativeFrame: React.FC<{ children: React.ReactNode; opacity?: number }> = ({ children, opacity = 1 }) => (
  <div
    style={{
      position: 'absolute',
      left: WIN.x,
      top: WIN.y,
      width: WIN.w,
      height: WIN.h,
      borderRadius: 10,
      border: '1px solid var(--border-strong)',
      boxShadow: '0 40px 120px rgba(0,0,0,0.62), 0 0 0 1px rgba(255,255,255,0.03)',
      overflow: 'hidden',
      opacity,
    }}
  >
    <div className="rui" style={{ width: NATIVE.w, height: NATIVE.h, transform: `scale(${SCALE})`, transformOrigin: '0 0' }}>
      {children}
    </div>
  </div>
);

/* ---------------- 侧栏：服务器列表（真实 .card 样式） ---------------- */

const SERVERS = [
  { name: 'order-1', host: '10.10.1.55', tags: ['生产', 'order'], on: true },
  { name: 'order-2', host: '10.10.1.56', tags: ['生产', 'order'], on: false },
  { name: 'dev-box', host: '10.10.2.31', tags: ['开发'], on: false },
];

const ServersPanel: React.FC = () => (
  <div className="wbs-content">
    <div className="wbs-skills-search">
      <input className="input" placeholder="搜索服务器（名称/host）…" readOnly />
    </div>
    <div className="wbs-skills-list">
      <div className="wbs-skills-group-title">
        <span className="wbs-skills-group-ic">
          <Ic name="folderOpen" />
        </span>
        <span className="wbs-skills-group-name">服务器</span>
        <span className="tag">3</span>
      </div>
      <div className="wbs-skills-group-list">
        {SERVERS.map((s) => (
          <div key={s.name} className="card" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{s.name}</span>
              <span className={`tag${s.on ? ' blue' : ''}`}>{s.on ? '已连接' : '未连接'}</span>
            </div>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{s.host}</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {s.tags.map((tg) => (
                <span key={tg} className="tag" style={{ fontSize: 10.5 }}>{tg}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ---------------- 侧栏：笔记树 ---------------- */

const NOTE_TREE = ['订单服务 / 发布问题复盘.md', '订单服务 / 压测记录.md', '平台 / 发布流程规范.md', '随手记 / 待办.md'];

const NotesPanel: React.FC = () => (
  <div className="wbs-content">
    <div className="wbs-skills-search">
      <input className="input" placeholder="搜索笔记（标题/内容）…" readOnly />
    </div>
    <div className="wbs-skills-list">
      <div className="wbs-skills-group-title">
        <span className="wbs-skills-group-ic">
          <Ic name="folderOpen" />
        </span>
        <span className="wbs-skills-group-name">全部笔记</span>
        <span className="tag">4</span>
      </div>
      <div className="wbs-skills-group-list">
        {NOTE_TREE.map((n, i) => (
          <div
            key={n}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
              background: i === 0 ? 'var(--bg-active)' : 'transparent', fontSize: 12.5,
              color: i === 0 ? 'var(--text-0)' : 'var(--text-1)',
            }}
          >
            <Ic name="note" />
            <span className="ellipsis">{n}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ---------------- 中央：终端（真实 .term-* 结构） ---------------- */

const TermPane: React.FC<{ t: number }> = ({ t }) => {
  const cmdShown = typed(t, 96, TERM.cmd, 1.6);
  const busy = t >= 96 && cmdShown.length < TERM.cmd.length;
  const done = !busy && t >= 96;
  return (
    <div className="term-root">
      <div className="term-info">
        <span>最后命令:</span>
        <span className="term-info-cmd" style={{ color: t >= 96 ? 'var(--text-0)' : 'var(--text-2)' }}>
          {t >= 96 ? TERM.infoCmd : '—'}
        </span>
        <span className="term-info-spacer" />
        <button className="btn small" title="历史命令">
          <Ic name="history" /> 历史命令 (2)
        </button>
        <button className="btn small" title="将该命令添加为命令收藏">
          <Ic name="star" /> 命令收藏
        </button>
        <button className="btn small">
          <Ic name="chatPlus" /> 添加到chat
        </button>
        <button className="btn small" title="录制终端输出到日志文件">
          <Ic name="circle" /> 录制
        </button>
      </div>
      <div className="term-main">
        <div className="term-xterm" data-anchor="term-body">
          <div>
            <span style={{ color: '#7ee2a8' }}>{TERM.prompt}</span>
            {t >= 96 ? (
              <>
                <span style={{ color: '#e6edf3' }}>{cmdShown}</span>
                {busy ? <span style={{ opacity: 0.6 }}>▍</span> : null}
              </>
            ) : null}
          </div>
          {done
            ? TERM.lines.map((l, i) => (
                <div key={i} style={{ color: l.c, opacity: rv(t, 122 + i * 8) }}>{l.t}</div>
              ))
            : null}
        </div>
        <div className="term-drawer">
          <div className="term-drawer-head">
            <span>历史命令</span>
            <span className="term-drawer-actions">
              <button className="icon-btn" title="清空历史命令" disabled>
                <Ic name="trash" />
              </button>
              <button className="btn small ghost">收起</button>
            </span>
          </div>
          <div className="term-drawer-body">
            <div className="term-block-item">
              <div className="term-block-item-cmd">{TERM.infoCmd}</div>
              <div className="term-block-item-out">{'✓ 构建完成  用时 42.6s\n✓ 迁移数据库  3 个变更已应用'}</div>
              <div className="term-block-item-actions">
                <button className="btn small"><Ic name="star" /> 命令收藏</button>
                <button className="btn small"><Ic name="chatPlus" /> 添加到chat</button>
              </div>
            </div>
            <div className="term-block-item">
              <div className="term-block-item-cmd">{TERM.lastHistory}</div>
              <div className="term-block-item-out">Already up to date.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ---------------- 中央：SFTP（真实 .sf-* 结构） ---------------- */

const SftpPane: React.FC<{ t: number }> = () => (
  <div className="sf-root">
    <div className="sf-toolbar">
      <button className="icon-btn" title="后退"><Ic name="arrowLeft" /></button>
      <button className="icon-btn" title="前进"><Ic name="arrowRight" /></button>
      <button className="icon-btn" title="上一级"><Ic name="arrowUp" /></button>
      <button className="icon-btn" title="回到主目录 ~"><Ic name="home" /></button>
      <button className="icon-btn" title="根目录 /"><Ic name="slash" /></button>
      <div className="sf-path-wrap">
        <input className="input sf-path" readOnly value={SFTP.path} />
        <button className="icon-btn sf-star" title="收藏当前路径"><Ic name="star" /></button>
      </div>
      <button className="btn sf-go">跳转</button>
      <button className="icon-btn sf-view" title="平铺视图"><Ic name="grid" /></button>
      <button className="icon-btn sf-view active" title="列表视图"><Ic name="list" /></button>
      <button className="icon-btn" title="收藏夹"><Ic name="star" /></button>
      <button className="icon-btn" title="搜索当前目录"><Ic name="search" /></button>
    </div>
    <div className="sf-main">
      <div className="sf-body">
        <table className="sf-table">
          <thead>
            <tr>
              <th>名称<span className="sf-sort-ind"><Ic name="arrowUp" /></span></th>
              <th style={{ textAlign: 'right' }}>大小</th>
              <th>修改时间</th>
            </tr>
          </thead>
          <tbody>
            {SFTP.rows.map((row) => (
              <tr key={row.n} className={row.sel ? 'sel' : ''}>
                <td>
                  <span className="sf-t-name">
                    <span style={{ color: row.dir ? '#93c5fd' : '#e2e8f0', display: 'inline-flex' }}>
                      <Ic name={row.dir ? 'folder' : 'archive'} />
                    </span>
                    <span className="nm">{row.n}</span>
                  </span>
                </td>
                <td className="sf-t-size">{row.size}</td>
                <td className="sf-t-time">{row.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);

/* ---------------- 中央：笔记编辑器（CodeMirror oneDark） ---------------- */

const MdNote: React.FC<{ t: number }> = ({ t }) => (
  <div className="note-root">
    <div className="note-toolbar">
      <div className="note-mode-switch">
        <button className="btn small primary"><Ic name="pencil" /> 编辑</button>
        <button className="btn small"><Ic name="eye" /> 预览</button>
      </div>
      <button className="btn small" title="将笔记整理后发布为钉钉日志"><Ic name="upload" /> 发布日志</button>
      <button className="btn small brand-gradient" data-anchor="note-publish-btn" title="将笔记内容整理为工单处理报告提交到云平台（审核通过后计入激励积分）">
        <Ic name="ticket" /> 发布工单日志
      </button>
      <span className="note-path ellipsis" title={NOTE.path}>{NOTE.path}</span>
    </div>
    <div className="note-editor">
      {NOTE.lines.map((ln, i) => (
        <div key={i} style={{ opacity: rv(t, 48 + i * 3, 6) }}>
          <span className="ln">{i + 1}</span>
          <span className={ln.startsWith('#') ? 'h1' : ''}>{ln || ' '}</span>
        </div>
      ))}
    </div>
  </div>
);

/* ---------------- 侧栏：Skill 面板（真实 markup） ---------------- */

const SkillsPanel: React.FC<{ t: number }> = ({ t }) => {
  const registered = t >= 128;
  return (
    <>
      <Sidebar
        title="Skill"
        actions={
          <span className="wbs-skills-head-actions">
            <button className="btn small brand-gradient wbs-skillhub-btn" title="在主工作区打开 Skill Hub">
              <Ic name="package" /> Skill Hub
            </button>
            <button className="btn small primary">+ 添加</button>
          </span>
        }
      >
        <div className="wbs-content">
          <div className="wbs-skills-search">
            <input className="input" placeholder="搜索 Skill（名称/描述/scope）…" readOnly />
          </div>
          <div className="wbs-skills-list">
            <div className="wbs-skills-group-title">
              <span className="wbs-skills-group-ic"><Ic name="folderOpen" /></span>
              <span className="wbs-skills-group-name">全局</span>
              <span className="tag">1</span>
            </div>
            <div className="wbs-skills-group-list">
              <div className="card wbs-skills-card">
                <div className="wbs-skills-head">
                  <div className="wbs-skills-name ellipsis" title={SKILL.name}>{SKILL.name}</div>
                  <span className="tag wbs-skills-origin blue">全局</span>
                </div>
                <div className="wbs-skills-desc" title={SKILL.desc}>{SKILL.desc}</div>
                <div className="wbs-skills-tags">
                  {SKILL.scopes.map((s) => (
                    <span key={s} className="tag wbs-skills-scope-tag">{s}</span>
                  ))}
                </div>
                <div className="wbs-skills-actions">
                  <span className="db-switch on" title="启用/禁用（只改 SKILL.md 顶层 enabled）">
                    <span className="db-switch-track" />
                  </span>
                  <button className="icon-btn" title="上传到 Skill Hub" data-anchor="skill-upload" style={{ color: 'var(--accent)' }}>
                    <Ic name="upload" />
                  </button>
                  <button className="icon-btn" title="登记激励积分（上传到 Skill Hub 后手动补登记；服务端按作者核实）" style={{ color: registered ? 'var(--green)' : undefined }}>
                    <Ic name="trophy" />
                  </button>
                  <button className="icon-btn" title="添加到 AI 对话"><Ic name="chatPlus" /></button>
                  <button className="icon-btn" title="编辑"><Ic name="gear" /></button>
                  <button className="icon-btn danger" title="删除"><Ic name="trash" /></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Sidebar>
      {/* 登记成功提示（真实定位：窗口底部居中浮层） */}
      {registered ? (
        <div
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 44, display: 'flex', justifyContent: 'center',
            opacity: rv(t, 128, 8), transform: `translateY(${(1 - rv(t, 128, 8)) * 10}px)`, pointerEvents: 'none',
          }}
        >
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--bg-2)', boxShadow: 'var(--shadow-m)', fontSize: 12.5 }}>
            <span style={{ color: 'var(--green)', display: 'inline-flex' }}><Ic name="check" /></span>
            {SKILL.toast}
          </div>
        </div>
      ) : null}
    </>
  );
};

/* ---------------- AI 面板（真实 markup） ---------------- */

const AiPane: React.FC<{ t: number }> = ({ t }) => {
  const input = typed(t, 62, AI.ask, 2.0);
  const sent = t >= 110;
  return (
    <AiPanel>
      <AiSessionBar title={AI.session} />
      <div id="ai-chat">
        {sent ? (
          <div className="ai-msg user" style={{ opacity: rv(t, 110) }}>
            <div className="ai-bubble">{AI.ask}</div>
          </div>
        ) : null}
        {t >= 116 ? (
          <div className="ai-msg ai" style={{ opacity: rv(t, 116) }}>
            <div className="ai-bubble">
              <div className="ai-tool-line"><Ic name="wrench" /> {AI.actionName} ×1</div>
              <div className="ai-action-card succeeded">
                <div className="ai-action-head">
                  <span className="ai-action-name"><Ic name="wrench" /> {AI.actionName}</span>
                  <span className="ai-action-status" style={{ color: 'var(--green)' }}>{AI.actionStatus}</span>
                </div>
                <div className="ai-action-intent">意图：{AI.intent}</div>
                <code className="ai-action-cmd">{AI.cmd}</code>
                <div className="ai-action-result">{AI.result}</div>
              </div>
              <p style={{ opacity: rv(t, 128, 8) }}>{AI.reply}</p>
            </div>
          </div>
        ) : null}
      </div>
      <div id="ai-input-area">
        <div id="ai-effort-bar">
          <span className="ai-mode-label"><Ic name="bot" /> AI 模式</span>
          <select className="select" defaultValue={AI.mode}>
            <option>仅建议</option>
            <option>工作</option>
            <option>全自动</option>
          </select>
          <span className="ai-effort-label"><Ic name="zap" /> 思考强度</span>
          <select className="select" defaultValue={AI.effort}>
            <option>低</option>
            <option>高</option>
            <option>最高</option>
          </select>
        </div>
        <div id="ai-input-row">
          <div id="ai-input-box" data-anchor="ai-input">
            <div id="ai-input" className={sent ? 'ph' : ''}>
              {sent ? '向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器/浏览器；可粘贴或拖入图片' : input}
            </div>
            <span className="ai-input-corner">
              <span className="ai-input-hint">Enter 发送</span>
            </span>
          </div>
        </div>
      </div>
    </AiPanel>
  );
};

/* ---------------- 工单日志弹窗（真实 markup） ---------------- */

const TicketModal: React.FC<{ t: number }> = ({ t }) => {
  const on = t >= 92;
  /* 提交成功态须晚于点击(150)+涟漪(14 帧):锚点消费方存活期间按钮必须挂载,
     否则冷启动渲染分片(任一帧可能是一个进程的首帧)测不到 ticket-publish */
  const submitted = t >= 170;
  if (!on) return null;
  return (
    <div className="modal-mask open">
      <div className="modal publish-ticket-modal" style={{ height: 620 }}>
        <div className="modal-head">
          <h3>发布工单日志</h3>
          <button className="icon-btn" title="关闭"><Ic name="x" /></button>
        </div>
        <div className="modal-body">
          {submitted ? (
            <div className="pr-guide pr-success">工单日志已提交（编号 #{TICKET.okNo}），等待管理员审核通过后计入「工单报告」积分。</div>
          ) : (
            <>
              <div className="pr-note hint">笔记：{TICKET.noteName}</div>
              <div className="field">
                <label>标题<span className="req">*</span></label>
                <input className="input" readOnly value={TICKET.title} />
              </div>
              <div className="field">
                <label>工单号 / 链接</label>
                <input className="input" readOnly value={TICKET.ref} />
              </div>
              <div className="field">
                <label>正文<span className="req">*</span></label>
                <textarea className="input pt-content" rows={8} readOnly value={TICKET.content} />
                <div className="hint pt-counter">{TICKET.counter}</div>
              </div>
              <div className="field">
                <label>附件</label>
                <div className="pt-attachments">
                  <div className="pt-attach-empty">未选择附件（可选，支持图片/PDF/Office/文本日志/压缩包）</div>
                </div>
                <div>
                  <button className="btn small"><Ic name="filePlus" /> 添加附件</button>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          {submitted ? (
            <button className="btn primary">关闭</button>
          ) : (
            <>
              <button className="btn">取消</button>
              <button className="btn brand-gradient pt-publish" data-anchor="ticket-publish"><Ic name="ticket" /> 发布工单日志</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ---------------- 账号页（反馈 / 激励计划共用外壳） ---------------- */

export const ACCOUNT_NAV = [
  { key: 'profile', icon: 'user' as const, label: '账号信息' },
  { key: 'usage', icon: 'chart' as const, label: '用量报表' },
  { key: 'memories', icon: 'database' as const, label: '记忆宫殿' },
  { key: 'feedback', icon: 'message' as const, label: '用户反馈' },
  { key: 'sync', icon: 'cloudSync' as const, label: '云同步' },
  { key: 'incentive', icon: 'trophy' as const, label: '激励计划' },
];

export const AccountShell: React.FC<{ active: string; children: React.ReactNode }> = ({ active, children }) => (
  <>
    <Topbar active="账号" />
    <div className="account-page">
      <div id="account-layout">
        <div className="account-nav">
          {ACCOUNT_NAV.map((n) => (
            <div key={n.key} className={`account-nav-item${n.key === active ? ' active' : ''}`} title={n.label}>
              <Ic name={n.icon} />
              <span>{n.label}</span>
            </div>
          ))}
        </div>
        <div className="account-content">{children}</div>
      </div>
    </div>
  </>
);

/* ---------------- 反馈提交弹窗 ---------------- */

const FeedbackModal: React.FC<{ t: number }> = ({ t }) => {
  const on = t >= 70;
  /* 提交成功态须晚于点击(124)+涟漪(14 帧):锚点消费方存活期间按钮必须挂载(同上) */
  const submitted = t >= 148;
  if (!on) return null;
  return (
    <div className="modal-mask open">
      <div className="modal" style={{ width: 560, height: 500 }}>
        <div className="modal-head">
          <h3>提交反馈</h3>
          <button className="icon-btn" title="关闭"><Ic name="x" /></button>
        </div>
        <div className="modal-body">
          {submitted ? (
            <div className="pr-guide pr-success">反馈已提交（编号 #{FEEDBACK.okNo}），状态由管理员在后台处理更新。</div>
          ) : (
            <>
              <div className="field">
                <label>分类<span className="req">*</span></label>
                <select className="select" defaultValue={FEEDBACK.category}>
                  <option>缺陷</option>
                  <option>建议</option>
                  <option>问题</option>
                  <option>其他</option>
                </select>
              </div>
              <div className="field">
                <label>标题<span className="req">*</span></label>
                <input className="input" readOnly value={FEEDBACK.title} />
              </div>
              <div className="field">
                <label>正文<span className="req">*</span></label>
                <textarea className="input" rows={5} readOnly value={FEEDBACK.content} />
              </div>
              <div className="field">
                <label>附件（可选）</label>
                <div className="fb-attach-row">
                  <button className="btn small"><Ic name="plus" /> 选择文件</button>
                  <span className="hint">最多 10 个，单个 ≤ 20 MB，合计 ≤ 100 MB；支持图片/PDF/Office/文本日志/压缩包</span>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          {submitted ? <button className="btn primary">关闭</button> : <><button className="btn">取消</button><button className="btn primary" data-anchor="feedback-submit">提交</button></>}
        </div>
      </div>
    </div>
  );
};

/* ---------------- 反馈列表（真实 .mem-card.fb-card） ---------------- */

const FeedbackView: React.FC<{ t: number }> = ({ t }) => (
  <>
    <div className="account-view-head"><Ic name="message" /> 用户反馈</div>
    <div className="account-body">
      <div className="account-toolbar">
        <div className="mem-scope-tabs fb-status-tabs">
          {['全部', '待处理', '处理中', '已解决', '已关闭'].map((s, i) => (
            <button key={s} className={`mem-scope-tab${i === 0 ? ' active' : ''}`}>{s}</button>
          ))}
        </div>
        <select className="select" style={{ width: 'auto' }} defaultValue="全部分类">
          <option>全部分类</option>
          <option>缺陷</option>
          <option>建议</option>
          <option>问题</option>
          <option>其他</option>
        </select>
        <button className="icon-btn" title="刷新"><Ic name="refresh" /></button>
        <span className="fb-toolbar-gap" />
        <button className="btn primary small"><Ic name="plus" /> 提交反馈</button>
      </div>
      <div className="mem-list">
        {FEEDBACK.rows.map((f, i) => (
          <div key={f.id} className="mem-card fb-card" style={{ opacity: rv(t, 70 + i * 7, 8) }}>
            <div className="mem-card-head">
              <span className="mem-cat">{f.cat}</span>
              <span className={`fb-status fb-status-${f.status === '待处理' ? 'pending' : f.status === '处理中' ? 'processing' : f.status === '已解决' ? 'resolved' : 'closed'}`}>{f.status}</span>
              <span className="mem-time">{f.time}</span>
            </div>
            <div className="fb-card-title">#{f.id} {f.title}</div>
            <div className="mem-card-foot">
              {f.attach > 0 ? <span className="fb-card-attach"><Ic name="file" /> {f.attach} 个附件</span> : <span />}
              <span style={{ marginLeft: 'auto', display: 'inline-flex' }}><Ic name="chevronRight" /></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </>
);

/* ---------------- 五个渠道场景 ---------------- */

const wbTabs = [TABS.term, { ...TABS.sftp, anchor: 'tab-sftp' }];

/** 01 命令与传输：终端敲命令 → 切到 SFTP 看传输进度 */
export const SceneCmd: React.FC<{ t: number }> = ({ t }) => {
  const sftp = t >= 148;
  return (
    <Workbench
      panel="servers"
      sidebar={<Sidebar title="服务器列表" actions={<button className="icon-btn" title="添加服务器"><Ic name="plus" /></button>}><ServersPanel /></Sidebar>}
      tabs={wbTabs}
      activeTab={sftp ? TABS.sftp.id : TABS.term.id}
      center={sftp ? <SftpPane t={t} /> : <TermPane t={t} />}
      ai={<AiPane t={-999} />}
      statusbar={<Statusbar project="订单服务" activeTab={sftp ? TABS.sftp.title : TABS.term.title} progress={sftp ? SFTP.progress : null} />}
    />
  );
};

/** 02 AI 助手：提问 → 工具调用 → 回答 */
export const SceneAi: React.FC<{ t: number }> = ({ t }) => (
  <Workbench
    panel="servers"
    sidebar={<Sidebar title="服务器列表" actions={<button className="icon-btn" title="添加服务器"><Ic name="plus" /></button>}><ServersPanel /></Sidebar>}
    tabs={[TABS.term]}
    activeTab={TABS.term.id}
    center={<TermPane t={-999} />}
    ai={<AiPane t={t} />}
    statusbar={<Statusbar project="订单服务" activeTab={TABS.term.title} />}
  />
);

/** 03 工单日志：笔记 + 发布工单日志弹窗 */
export const SceneTicket: React.FC<{ t: number }> = ({ t }) => (
  <>
    <Workbench
      panel="notes"
      sidebar={<Sidebar title="笔记" actions={<button className="icon-btn" title="新建笔记"><Ic name="filePlus" /></button>}><NotesPanel /></Sidebar>}
      tabs={[TABS.note]}
      activeTab={TABS.note.id}
      center={<MdNote t={t} />}
      ai={<AiPane t={-999} />}
      statusbar={<Statusbar project="订单服务" activeTab={TABS.note.title} />}
    />
    <TicketModal t={t} />
  </>
);

/** 04 上传 Skill：Skill 面板 + 上传按钮 + 登记提示 */
export const SceneSkill: React.FC<{ t: number }> = ({ t }) => (
  <Workbench
    panel="skills"
    sidebar={<SkillsPanel t={t} />}
    tabs={[TABS.term]}
    activeTab={TABS.term.id}
    center={<TermPane t={-999} />}
    ai={<AiPane t={-999} />}
    statusbar={<Statusbar project="订单服务" activeTab={TABS.term.title} />}
  />
);

/** 05 问题反馈：账号页「用户反馈」+ 提交弹窗 */
export const SceneFeedback: React.FC<{ t: number }> = ({ t }) => (
  <>
    <AccountShell active="feedback">
      <FeedbackView t={t} />
    </AccountShell>
    <FeedbackModal t={t} />
  </>
);

/** 渠道 index → 场景（0..4 对应 CHANNELS） */
export const SCENES: Array<React.FC<{ t: number }>> = [SceneCmd, SceneAi, SceneTicket, SceneSkill, SceneFeedback];

/** 各渠道的侧栏/面板状态（供装配器透传，无需重复声明） */
export const CH_PANEL: PanelName[] = ['servers', 'servers', 'notes', 'skills', null];

export { CTR, L, WIN, WIN_C };
