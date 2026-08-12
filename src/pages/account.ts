/**
 * 账号页（#/account）—— 云服务三页导航：账号信息 / 用量报表 / 记忆宫殿。
 * 数据源：cloud_status（Rust 端单一事实源，token 永不返回前端）；
 * 用量与记忆数据经 Rust 端代理命令（cloud_usage / memories_*）获取，token 全程留在后端。
 * 登录流程：cloud_begin_login 返回授权 URL → 系统浏览器打开云平台授权页 →
 * 本地回环回调（127.0.0.1:38901）收 code → 后端换令牌/拉资料 → cloud:changed 驱动刷新。
 * 服务端协议以 docs/AIShell云服务-OAuth2接入文档.md、开放API文档.md、记忆卡片API文档.md 为准。
 */
import type { CloudStatus, MemoryCard, MemoryScope, UsageReport } from '../types';
import {
  cloudBeginLogin,
  cloudCancelLogin,
  cloudLogout,
  cloudSetMode,
  cloudStatus,
  cloudUsage,
  memoriesList,
  memoryCreate,
  memoryDelete,
  memoryHistory,
  memoryPromote,
  memorySearch,
  memoryUpdate,
  onCloudChanged,
} from '../api';
import { openUrl } from '@tauri-apps/plugin-opener';
import { confirmDialog, toast } from '../ui';
import { icon } from '../icons';
import type { PageRender } from '../main';
import './account.css';

/** 登录等待超时（与后端 LOGIN_TIMEOUT 120s 一致）：超时自动恢复按钮 */
const LOGIN_WAIT_MS = 120_000;

/** 记忆卡片建议固定分类（记忆卡片 API 文档 §2.1） */
const MEMORY_CATEGORIES = ['编码规范', '排障经验', '提示词技巧', '工具配置', '业务流程', '其他', '个人记忆'];

/** 用量报表天数选项 */
const USAGE_DAYS = [7, 14, 30, 90];

export const renderAccount: PageRender = (root) => {
  root.classList.add('settings-page', 'account-page');

  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting = false;
  let lastStatus: CloudStatus | null = null;
  let currentView: 'profile' | 'usage' | 'memories' = 'profile';
  /** 异步竞态序号：切换子页/刷新后丢弃迟到的响应 */
  let usageSeq = 0;
  let memoriesSeq = 0;
  /** 用量过滤状态 */
  let usageDays = 14;
  let usageKind = '';
  let usageModel = '';
  /** 记忆搜索词（空 = 全量列表） */
  let memQuery = '';
  /** 记忆列表/检索作用域：all = 共享 + 我的个人（默认）；shared / personal 过滤 */
  let memScope: MemoryScope = 'all';
  let memDebounce: ReturnType<typeof setTimeout> | null = null;

  root.insertAdjacentHTML('beforeend', `
    <div id="account-layout">
      <aside class="account-nav">
        <div class="account-nav-item active" data-tab="profile" title="账号信息">${icon('user')}<span>账号信息</span></div>
        <div class="account-nav-item" data-tab="usage" title="用量报表">${icon('chart')}<span>用量报表</span></div>
        <div class="account-nav-item" data-tab="memories" title="记忆宫殿">${icon('database')}<span>记忆宫殿</span></div>
      </aside>
      <main class="account-content">
        <section class="account-view active" data-view="profile">
          <div class="account-view-head">${icon('user')} 账号信息</div>
          <div id="account-body" class="account-body"></div>
        </section>
        <section class="account-view" data-view="usage">
          <div class="account-view-head">${icon('chart')} 用量报表</div>
          <div id="usage-body" class="account-body"></div>
        </section>
        <section class="account-view" data-view="memories">
          <div class="account-view-head">${icon('database')} 记忆宫殿</div>
          <div id="memories-body" class="account-body"></div>
        </section>
      </main>
    </div>
  `);

  const navItems = [...root.querySelectorAll<HTMLElement>('.account-nav-item')];
  const views = [...root.querySelectorAll<HTMLElement>('.account-view')];
  const body = root.querySelector('#account-body') as HTMLElement;
  const usageBody = root.querySelector('#usage-body') as HTMLElement;
  const memoriesBody = root.querySelector('#memories-body') as HTMLElement;

  // ---------------------------------------------------------------- 登录流程

  const clearWait = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    waiting = false;
  };

  const startLogin = async () => {
    waiting = true;
    renderProfile(lastStatus);
    let url: string;
    try {
      url = await cloudBeginLogin();
    } catch (e) {
      waiting = false;
      renderProfile(lastStatus);
      toast(`登录发起失败: ${String(e)}`, 'error');
      return;
    }
    try {
      await openUrl(url);
    } catch {
      // 打开浏览器失败不阻塞等待：用户可手动复制地址；后端回调仍在监听
    }
    timer = setTimeout(() => {
      waiting = false;
      void cloudStatus()
        .then((s) => { lastStatus = s; renderProfile(s); })
        .catch(() => renderProfile(lastStatus));
      toast('登录超时，已自动取消，请重试', 'info');
    }, LOGIN_WAIT_MS);
  };

  const cancelLogin = async () => {
    clearWait();
    try { await cloudCancelLogin(); } catch { /* 无进行中会话时静默 */ }
    renderProfile(lastStatus);
  };

  const doLogout = async () => {
    clearWait();
    try {
      await cloudLogout();
      toast('已退出登录', 'info');
    } catch (e) {
      toast(`退出登录失败: ${String(e)}`, 'error');
    }
    // cloud:changed 驱动刷新；失败场景下主动拉一次兜底
    void cloudStatus().then((s) => { lastStatus = s; renderProfile(s); }).catch(() => {});
  };

  /** 「打开官网」链接：只显示文字链接，服务器地址不在页面任何位置展示 */
  const bindOpenSite = (scope: HTMLElement, serverUrl: string) => {
    scope.querySelectorAll<HTMLElement>('[data-open-site]').forEach((a) => {
      a.addEventListener('click', () => {
        void openUrl(serverUrl).catch((e) => toast(`打开官网失败: ${String(e)}`, 'error'));
      });
    });
  };

  // ---------------------------------------------------------------- 账号信息

  const renderProfile = (status: CloudStatus | null) => {
    if (!status) return;
    lastStatus = status;

    if (!status.serverUrl) {
      body.innerHTML = `
        <div class="cloud-empty">
          <div>当前构建未配置云服务（缺少服务器地址或应用凭据），云功能不可用。</div>
          <div class="hint">本应用由管理员构建时注入云平台地址；个人构建与开源构建不携带云功能。</div>
        </div>`;
      return;
    }

    if (!status.loggedIn) {
      body.innerHTML = `
        <div class="cloud-empty">
          <div>登录公司账号后，可直接使用公司统一管理的模型与搜索服务，无需自行配置密钥。</div>
          <div class="cloud-site-row">
            <span class="hint">云平台</span>
            <a class="cloud-site-link" data-open-site>${icon('externalLink')} 打开官网</a>
          </div>
          ${waiting ? `
            <div class="login-waiting">
              <div class="spinner"></div>
              <div>
                <div>已在浏览器打开授权页，请完成登录…</div>
                <div class="hint">2 分钟内未完成将自动取消；授权成功后本页自动刷新</div>
              </div>
            </div>
            <button id="btn-cancel-login" class="btn small">取消登录</button>
          ` : `
            <button id="btn-login" class="btn primary">登录</button>
          `}
        </div>`;
      bindOpenSite(body, status.serverUrl);
      if (waiting) {
        body.querySelector('#btn-cancel-login')!.addEventListener('click', () => void cancelLogin());
      } else {
        body.querySelector('#btn-login')!.addEventListener('click', () => void startLogin());
      }
      return;
    }

    // 已登录
    const user = status.user;
    const name = user?.name || '未知用户';
    const dept = user?.dept || null;
    const avatar = user?.avatar || null;
    body.innerHTML = `
      <div class="profile-card">
        <div class="profile-avatar">
          <img alt="" data-avatar-img ${avatar ? `src="${escapeHtml(avatar)}"` : 'hidden'}>
          <span data-avatar-fallback ${avatar ? 'hidden' : ''}>${escapeHtml(name.slice(0, 1))}</span>
        </div>
        <div class="profile-meta">
          <div class="profile-name">${escapeHtml(name)}</div>
          ${dept ? `<div class="profile-dept">${escapeHtml(dept)}</div>` : ''}
        </div>
      </div>
      <div class="cloud-site-row">
        <span class="hint">云平台</span>
        <a class="cloud-site-link" data-open-site>${icon('externalLink')} 打开官网</a>
      </div>
      <div class="field">
        <label>使用模式</label>
        <div class="mode-switch">
          <label class="mode-option ${status.mode === 'hosted' ? 'active' : ''}"
                 title="公司服务器统一管理模型与搜索，本地无需配置密钥">
            <input type="radio" name="cloud-mode" value="hosted" ${status.mode === 'hosted' ? 'checked' : ''}> 托管模式
          </label>
          <label class="mode-option ${status.mode === 'personal' ? 'active' : ''}"
                 title="本地自配密钥，行为与未接入云服务一致">
            <input type="radio" name="cloud-mode" value="personal" ${status.mode === 'personal' ? 'checked' : ''}> 个人模式
          </label>
        </div>
        <div class="hint">托管模式下 LLM / 搜索配置由公司服务器提供；个人模式行为与本地配置一致</div>
      </div>
      <div class="form-actions">
        <button id="btn-logout" class="btn danger-solid small">${icon('logout')} 退出登录</button>
      </div>`;
    bindOpenSite(body, status.serverUrl);
    // 头像加载失败回退姓名首字（CSP 禁内联脚本，用事件绑定）
    const img = body.querySelector('[data-avatar-img]') as HTMLImageElement | null;
    const fb = body.querySelector('[data-avatar-fallback]') as HTMLElement | null;
    if (img && fb) {
      img.addEventListener('error', () => { img.hidden = true; fb.hidden = false; });
    }
    body.querySelector('#btn-logout')!.addEventListener('click', () => void doLogout());
    body.querySelectorAll<HTMLInputElement>('input[name="cloud-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        const mode = radio.value as 'hosted' | 'personal';
        cloudSetMode(mode).catch((e) => toast(`切换模式失败: ${String(e)}`, 'error'));
      });
    });
  };

  // ---------------------------------------------------------------- 用量报表

  /** 登录/接入守卫：未接入或未登录时渲染提示并返回 false */
  const guardCloud = (target: HTMLElement): boolean => {
    const s = lastStatus;
    if (!s?.serverUrl) {
      target.innerHTML = `
        <div class="cloud-empty">
          <div>当前构建未接入云服务，该功能不可用。</div>
        </div>`;
      return false;
    }
    if (!s.loggedIn) {
      target.innerHTML = `
        <div class="cloud-empty">
          <div>登录公司账号后即可使用该功能。</div>
          <button class="btn primary small" data-go-login>去登录</button>
        </div>`;
      target.querySelector('[data-go-login]')!.addEventListener('click', () => switchView('profile'));
      return false;
    }
    return true;
  };

  const fmt = (n: number): string => (n ?? 0).toLocaleString('zh-CN');
  const fmtMs = (n: number): string => (n ?? 0).toFixed(1);

  const loadUsage = async () => {
    const content = usageBody.querySelector('#usage-content') as HTMLElement;
    if (!content) return;
    if (!guardCloud(content)) return;
    const seq = ++usageSeq;
    content.innerHTML = `<div class="loading-row">${icon('loader')} 加载用量报表…</div>`;
    try {
      const r = await cloudUsage(usageDays, usageKind, usageModel);
      if (seq !== usageSeq) return;
      renderUsage(r);
    } catch (e) {
      if (seq !== usageSeq) return;
      content.innerHTML = `
        <div class="cloud-empty">
          <div class="err-text">加载用量报表失败：${escapeHtml(String(e))}</div>
          <button class="btn small" data-usage-retry>重试</button>
        </div>`;
      content.querySelector('[data-usage-retry]')!.addEventListener('click', () => void loadUsage());
    }
  };

  const renderUsage = (r: UsageReport) => {
    const s = r.summary;
    const dailyRows = r.daily.map((d) => `
      <tr>
        <td class="mono">${escapeHtml(d.date)}</td>
        <td>${fmt(d.requests)}</td>
        <td>${fmt(d.llmRequests)}</td>
        <td>${fmt(d.searchRequests)}</td>
        <td>${fmt(d.promptTokens + d.completionTokens)}</td>
        <td>${fmt(d.errorCount)}</td>
      </tr>`).join('');
    const modelRows = r.models.map((m) => `
      <tr>
        <td class="mono">${escapeHtml(m.model)}</td>
        <td>${fmt(m.requests)}</td>
        <td>${fmt(m.promptTokens)}</td>
        <td>${fmt(m.completionTokens)}</td>
        <td>${fmt(m.totalTokens)}</td>
      </tr>`).join('');
    const stats: Array<[string, string, string]> = [
      ['请求总数', fmt(s.requests), ''],
      ['LLM 请求', fmt(s.llmRequests), ''],
      ['搜索请求', fmt(s.searchRequests), ''],
      ['Prompt Tokens', fmt(s.promptTokens), ''],
      ['Completion Tokens', fmt(s.completionTokens), ''],
      ['总 Tokens', fmt(s.totalTokens), ''],
      ['平均延迟', `${fmtMs(s.averageLatencyMs)} ms`, ''],
      ['错误数', fmt(s.errorCount), s.errorCount > 0 ? 'warn' : ''],
    ];
    usageBody.querySelector('#usage-content')!.innerHTML = `
      <div class="usage-range">统计区间：${escapeHtml(r.from)} ~ ${escapeHtml(r.to)}（${escapeHtml(r.timezone)}）</div>
      <div class="usage-summary-grid">
        ${stats.map(([label, value, cls]) => `
          <div class="usage-stat ${cls}">
            <div class="usage-stat-label">${label}</div>
            <div class="usage-stat-value">${value}</div>
          </div>`).join('')}
      </div>
      <div class="usage-section">
        <div class="usage-section-title">每日明细</div>
        <div class="usage-table-wrap">
          <table class="usage-table">
            <thead><tr><th>日期</th><th>请求</th><th>LLM</th><th>搜索</th><th>Token</th><th>错误</th></tr></thead>
            <tbody>${dailyRows || '<tr><td colspan="6" class="empty-cell">无数据</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="usage-section">
        <div class="usage-section-title">模型分布</div>
        <div class="usage-table-wrap">
          <table class="usage-table">
            <thead><tr><th>模型</th><th>请求</th><th>Prompt</th><th>Completion</th><th>总 Token</th></tr></thead>
            <tbody>${modelRows || '<tr><td colspan="5" class="empty-cell">无模型数据</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  };

  const mountUsageToolbar = () => {
    if (!guardCloud(usageBody)) return;
    const models = lastStatus?.capabilities?.models ?? [];
    const dayOpts = USAGE_DAYS.map((d) => `<option value="${d}">近 ${d} 天</option>`).join('');
    const kindOpts = ['', 'llm', 'search'].map((k) =>
      `<option value="${k}">${k === '' ? '全部类型' : k === 'llm' ? '仅 LLM' : '仅搜索'}</option>`).join('');
    const modelOpts = ['<option value="">全部模型</option>'].concat(
      models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`),
    ).join('');
    usageBody.innerHTML = `
      <div class="account-toolbar" id="usage-toolbar">
        <select id="usage-days" class="select" title="统计天数">${dayOpts}</select>
        <select id="usage-kind" class="select" title="类型过滤">${kindOpts}</select>
        <select id="usage-model" class="select" title="模型过滤（仅 LLM）">${modelOpts}</select>
        <button class="btn small" data-usage-refresh>${icon('refresh')} 刷新</button>
      </div>
      <div id="usage-content"></div>`;
    const daysSel = usageBody.querySelector('#usage-days') as HTMLSelectElement;
    const kindSel = usageBody.querySelector('#usage-kind') as HTMLSelectElement;
    const modelSel = usageBody.querySelector('#usage-model') as HTMLSelectElement;
    daysSel.value = String(usageDays);
    if (usageKind) kindSel.value = usageKind;
    if (usageModel) modelSel.value = usageModel;
    const reload = () => {
      usageDays = Number(daysSel.value);
      usageKind = kindSel.value;
      usageModel = modelSel.value;
      void loadUsage();
    };
    [daysSel, kindSel, modelSel].forEach((sel) => sel.addEventListener('change', reload));
    usageBody.querySelector('[data-usage-refresh]')!.addEventListener('click', reload);
    void loadUsage();
  };

  // ---------------------------------------------------------------- 记忆宫殿

  const loadMemories = async () => {
    const content = memoriesBody.querySelector('#memories-content') as HTMLElement;
    if (!content) return;
    if (!guardCloud(content)) return;
    const seq = ++memoriesSeq;
    content.innerHTML = `<div class="loading-row">${icon('loader')} 加载记忆卡片…</div>`;
    try {
      const cards = await memoriesList(memScope);
      if (seq !== memoriesSeq) return;
      renderMemories(cards, null);
    } catch (e) {
      if (seq !== memoriesSeq) return;
      content.innerHTML = `
        <div class="cloud-empty">
          <div class="err-text">加载记忆卡片失败：${escapeHtml(String(e))}</div>
          <button class="btn small" data-mem-retry>重试</button>
        </div>`;
      content.querySelector('[data-mem-retry]')!.addEventListener('click', () => void loadMemories());
    }
  };

  const searchMemories = async (query: string) => {
    const content = memoriesBody.querySelector('#memories-content') as HTMLElement;
    if (!content) return;
    if (!guardCloud(content)) return;
    const seq = ++memoriesSeq;
    try {
      const hits = await memorySearch(query, 20, memScope);
      if (seq !== memoriesSeq) return;
      renderMemories(hits.map((h) => ({ ...h, _score: h.score })), query);
    } catch (e) {
      if (seq !== memoriesSeq) return;
      toast(`记忆检索失败: ${String(e)}`, 'error');
      memQuery = '';
      void loadMemories();
    }
  };

  const renderMemories = (cards: Array<MemoryCard & { _score?: number }>, query: string | null) => {
    const selfId = lastStatus?.user?.id ?? null;
    const list = cards.length > 0 ? cards.map((c) => {
      const mine = selfId != null && c.creatorId === selfId;
      const personal = c.scope === 'personal';
      const cat = c.category?.trim() ? escapeHtml(c.category) : '<span class="mem-cat muted">未分类</span>';
      const tags = (c.tags ?? []).filter((t) => t.trim()).map((t) =>
        `<span class="mem-tag">${escapeHtml(t)}</span>`).join('');
      const source = c.source === 'auto'
        ? '<span class="mem-source mem-source-auto" title="对话流量 AI 自动沉淀">自动</span>'
        : '<span class="mem-source" title="用户主动提交，原文保存">手动</span>';
      const scopeBadge = personal
        ? '<span class="mem-scope mem-scope-personal" title="仅本人可见">个人</span>'
        : '<span class="mem-scope" title="团队全员可见">共享</span>';
      const score = c._score != null ? `<span class="mem-score" title="相关度（值越小越相关）">相关度 ${c._score.toFixed(3)}</span>` : '';
      return `
      <div class="mem-card" data-id="${escapeHtml(c.id)}">
        <div class="mem-card-head">
          ${cat}${source}${scopeBadge}
          <span class="mem-time" title="创建 / 最后更新">${escapeHtml(c.createdAt)}</span>
        </div>
        <div class="mem-content">${escapeHtml(c.content)}</div>
        ${tags ? `<div class="mem-tags">${tags}</div>` : ''}
        <div class="mem-card-foot">
          <span class="mem-creator">${escapeHtml(c.creatorName || '未知')}${c.dept ? ` · ${escapeHtml(c.dept)}` : ''}</span>
          ${score}
          <span class="mem-actions">
            ${mine && personal ? `
              <button class="icon-btn" data-act="promote" title="提升为共享" aria-label="提升为共享">${icon('upload')}</button>` : ''}
            <button class="icon-btn" data-act="history" title="变更历史" aria-label="变更历史">${icon('history')}</button>
            ${mine ? `
              <button class="icon-btn" data-act="edit" title="编辑" aria-label="编辑">${icon('pencil')}</button>
              <button class="icon-btn" data-act="del" title="删除" aria-label="删除">${icon('trash')}</button>` : ''}
          </span>
        </div>
      </div>`;
    }).join('') : '';
    const head = query
      ? `<div class="mem-result-hint">「${escapeHtml(query)}」的检索结果（${cards.length} 条）</div>`
      : '';
    memoriesBody.querySelector('#memories-content')!.innerHTML = `
      <div class="mem-result-hint">${head}</div>
      <div class="mem-list">${list || `<div class="cloud-empty">${query ? '没有检索到相关记忆' : '暂无记忆卡片，点击「新增记忆」提交第一条团队记忆'}</div>`}</div>`;
  };

  const mountMemoriesToolbar = () => {
    if (!guardCloud(memoriesBody)) return;
    memoriesBody.innerHTML = `
      <div class="account-toolbar" id="memories-toolbar">
        <div class="mem-search-wrap">
          ${icon('search')}
          <input id="mem-search" class="input" type="text" spellcheck="false"
                 placeholder="语义检索记忆，回车搜索，清空回到列表…">
        </div>
        <button class="btn primary small" data-mem-add>${icon('plus')} 新增记忆</button>
      </div>
      <div class="mem-scope-tabs" id="mem-scope-tabs">
        <button class="mem-scope-tab active" data-scope="all" title="共享卡片 + 我的个人卡片">全部</button>
        <button class="mem-scope-tab" data-scope="shared" title="团队全员可见的共享卡片">共享</button>
        <button class="mem-scope-tab" data-scope="personal" title="仅本人可见的个人卡片">我的个人</button>
      </div>
      <div id="memories-content"></div>`;
    const search = memoriesBody.querySelector('#mem-search') as HTMLInputElement;
    const run = () => {
      const q = search.value.trim();
      memQuery = q;
      if (memQuery) void searchMemories(memQuery);
      else void loadMemories();
    };
    search.addEventListener('input', () => {
      if (memDebounce) clearTimeout(memDebounce);
      memDebounce = setTimeout(run, 300);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (memDebounce) clearTimeout(memDebounce);
        run();
      }
    });
    // 作用域过滤：切换后保留当前搜索词（有词走检索、无词走列表）
    memoriesBody.querySelectorAll<HTMLElement>('#mem-scope-tabs .mem-scope-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        memScope = (tab.dataset.scope ?? 'all') as MemoryScope;
        memoriesBody.querySelectorAll<HTMLElement>('#mem-scope-tabs .mem-scope-tab').forEach((t) => {
          t.classList.toggle('active', t === tab);
        });
        run();
      });
    });
    memoriesBody.querySelector('[data-mem-add]')!.addEventListener('click', () => openMemoryModal(null));
    void loadMemories();
  };

  /** 新增/编辑记忆弹窗（复用 .modal-mask/.modal；内容/分类必填，服务端权威校验） */
  const openMemoryModal = (card: MemoryCard | null) => {
    const isNew = !card;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const catOpts = MEMORY_CATEGORIES.map((c) =>
      `<option value="${escapeHtml(c)}" ${card?.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
    mask.innerHTML = `
      <div class="modal" style="width:520px">
        <div class="modal-head"><h3>${isNew ? '新增记忆' : '编辑记忆'}</h3></div>
        <div class="modal-body">
          <div class="field">
            <label>内容<span class="req">*</span></label>
            <textarea id="mem-content" class="input" rows="4" spellcheck="false"
                      placeholder="例如：生产发布前必须冻结主干分支">${escapeHtml(card?.content ?? '')}</textarea>
            <div class="hint">主动提交的内容原文保存，不被 AI 改写；提交后全员立即可见</div>
          </div>
          <div class="field">
            <label>分类<span class="req">*</span></label>
            <select id="mem-category" class="select">${catOpts}</select>
          </div>
          <div class="field">
            <label>可见范围</label>
            <div class="mem-scope-radio">
              <label class="mode-option active">
                <input type="radio" name="mem-scope" value="shared" checked> 团队共享（全员可见）
              </label>
              <label class="mode-option">
                <input type="radio" name="mem-scope" value="personal"
                       title="仅本人可见；之后可在列表中提升为共享"> 仅自己可见
              </label>
            </div>
          </div>
          <div class="field">
            <label>标签（逗号分隔，可选）</label>
            <input id="mem-tags" class="input" type="text" spellcheck="false"
                   value="${escapeHtml((card?.tags ?? []).join(', '))}" placeholder="例如：发布, 分支">
          </div>
          ${!isNew ? `
            <div class="field">
              <label>纠正说明（可选，写入变更历史留痕）</label>
              <input id="mem-note" class="input" type="text" spellcheck="false" placeholder="例如：补充 hotfix 例外说明">
            </div>` : ''}
          <div id="mem-form-err" class="form-error" hidden></div>
        </div>
        <div class="modal-foot">
          <button class="btn small" data-mem-cancel>取消</button>
          <button class="btn primary small" data-mem-save>保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    mask.querySelector('[data-mem-cancel]')!.addEventListener('click', close);
    const errEl = mask.querySelector('#mem-form-err') as HTMLElement;
    const fail = (e: unknown) => {
      errEl.textContent = String(e);
      errEl.hidden = false;
    };
    mask.querySelector('[data-mem-save]')!.addEventListener('click', async () => {
      const content = (mask.querySelector('#mem-content') as HTMLTextAreaElement).value.trim();
      const category = (mask.querySelector('#mem-category') as HTMLSelectElement).value;
      const tags = (mask.querySelector('#mem-tags') as HTMLInputElement).value
        .split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      if (!content) { fail('记忆内容不能为空'); return; }
      if (!category) { fail('请选择分类'); return; }
      errEl.hidden = true;
      try {
        if (isNew) {
          const scope = (mask.querySelector('input[name="mem-scope"]:checked') as HTMLInputElement | null)?.value ?? 'shared';
          await memoryCreate(content, category, tags, scope as MemoryScope);
          toast('记忆已提交', 'success');
        } else {
          const note = (mask.querySelector('#mem-note') as HTMLInputElement | null)?.value.trim() ?? '';
          await memoryUpdate(card.id, content, category, tags, note);
          toast('记忆已更新', 'success');
        }
        close();
        if (memQuery) void searchMemories(memQuery);
        else void loadMemories();
      } catch (e) {
        fail(e);
      }
    });
  };

  /** 变更历史时间线弹窗 */
  const openHistoryModal = async (card: MemoryCard) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:560px">
        <div class="modal-head"><h3>变更历史</h3></div>
        <div class="modal-body" id="mem-history-body">
          <div class="loading-row">${icon('loader')} 加载历史…</div>
        </div>
        <div class="modal-foot"><button class="btn small" data-mem-close>关闭</button></div>
      </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) mask.remove(); });
    mask.querySelector('[data-mem-close]')!.addEventListener('click', () => mask.remove());
    const histBody = mask.querySelector('#mem-history-body') as HTMLElement;
    try {
      const events = await memoryHistory(card.id);
      histBody.innerHTML = events.length > 0 ? `
        <div class="mem-history">
          ${events.map((ev) => `
            <div class="mem-history-item">
              <div class="mem-history-head">
                <span class="mem-history-event ${ev.event === 'ADD' ? 'add' : 'update'}">
                  ${ev.event === 'ADD' ? '新增' : '修订'}</span>
                <span class="mem-history-actor">${escapeHtml(ev.actor || '—')}</span>
                <span class="mem-time">${escapeHtml(ev.ts)}</span>
              </div>
              <div class="mem-history-value">${escapeHtml(ev.value)}</div>
              ${ev.note ? `<div class="mem-history-note">说明：${escapeHtml(ev.note)}</div>` : ''}
            </div>`).join('')}
        </div>` : '<div class="cloud-empty">暂无变更记录</div>';
    } catch (e) {
      histBody.innerHTML = `<div class="cloud-empty err-text">加载历史失败：${escapeHtml(String(e))}</div>`;
    }
  };

  const onMemoriesClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const cardEl = btn.closest<HTMLElement>('.mem-card');
    if (!cardEl) return;
    const id = cardEl.dataset.id ?? '';
    const act = btn.dataset.act ?? '';
    // 从当前渲染的卡片 DOM 取整卡数据（id 足够，卡片字段服务端返回过，可信任本地副本）
    if (act === 'history') {
      const card = memoryCardFromDom(cardEl);
      if (card) void openHistoryModal(card);
      return;
    }
    if (act === 'promote') {
      void (async () => {
        const ok = await confirmDialog({
          title: '提升为共享',
          message: '确定将这条个人记忆提升为团队共享吗？\n提升后全员可见，原个人卡片将被共享卡片替换（内容不变），操作写入审计日志。',
          okText: '提升',
        });
        if (!ok) return;
        try {
          const newId = await memoryPromote(id);
          toast(`已提升为共享（新卡片 ${newId.slice(0, 8)}…）`, 'success');
          void (memQuery ? searchMemories(memQuery) : loadMemories());
        } catch (err) {
          toast(`提升失败: ${String(err)}`, 'error');
        }
      })();
      return;
    }
    if (act === 'edit') {
      const card = memoryCardFromDom(cardEl);
      if (card) openMemoryModal(card);
      return;
    }
    if (act === 'del') {
      void (async () => {
        const ok = await confirmDialog({
          title: '删除记忆卡片',
          message: `确定删除这条记忆吗？删除后全员不可见，变更历史一并清除，且不可恢复。`,
          danger: true,
          okText: '删除',
        });
        if (!ok) return;
        try {
          await memoryDelete(id);
          toast('记忆已删除', 'success');
          void (memQuery ? searchMemories(memQuery) : loadMemories());
        } catch (err) {
          toast(`删除失败: ${String(err)}`, 'error');
        }
      })();
    }
  };

  /** 从已渲染卡片 DOM 还原 MemoryCard（id + 可见字段足够编辑/历史弹窗用） */
  const memoryCardFromDom = (el: HTMLElement): MemoryCard | null => {
    const id = el.dataset.id;
    if (!id) return null;
    const content = el.querySelector('.mem-content')?.textContent ?? '';
    const catEl = el.querySelector('.mem-cat');
    const category = catEl && !catEl.classList.contains('muted') ? (catEl.textContent ?? '') : '';
    const tags = [...el.querySelectorAll('.mem-tag')].map((t) => t.textContent ?? '');
    const creator = el.querySelector('.mem-creator')?.textContent ?? '';
    const [creatorName, dept] = creator.split(' · ');
    return {
      id,
      content,
      category,
      tags,
      creatorId: null, // 编辑/历史不依赖权限标记；删除/编辑按钮已按 mine 显隐
      creatorName: creatorName ?? '',
      dept: dept ?? '',
      source: el.querySelector('.mem-source-auto') ? 'auto' : 'manual',
      scope: el.querySelector('.mem-scope-personal') ? 'personal' : 'shared',
      projectName: null,
      sessionId: null,
      date: null,
      createdAt: el.querySelector('.mem-time')?.textContent ?? '',
      updatedAt: '',
    };
  };

  // ---------------------------------------------------------------- 子页切换

  const switchView = (name: 'profile' | 'usage' | 'memories') => {
    currentView = name;
    navItems.forEach((n) => n.classList.toggle('active', n.dataset.tab === name));
    views.forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    if (name === 'usage') mountUsageToolbar();
    if (name === 'memories') mountMemoriesToolbar();
  };
  navItems.forEach((n) => n.addEventListener('click', () => switchView(n.dataset.tab as typeof currentView)));
  memoriesBody.addEventListener('click', onMemoriesClick);

  void cloudStatus().then((s) => {
    lastStatus = s;
    renderProfile(s);
  }).catch(() => {});
  const offChanged = onCloudChanged((s) => {
    if (s.loggedIn) clearWait(); // 登录成功：停止等待计时
    lastStatus = s;
    // 登出/登录失效：用量与记忆数据失效，回到账号信息页
    if (!s.loggedIn && currentView !== 'profile') {
      currentView = 'profile';
      navItems.forEach((n) => n.classList.toggle('active', n.dataset.tab === 'profile'));
      views.forEach((v) => v.classList.toggle('active', v.dataset.view === 'profile'));
    }
    renderProfile(s);
  }).catch(() => () => {});

  return () => {
    clearWait();
    if (memDebounce) clearTimeout(memDebounce);
    memoriesBody.removeEventListener('click', onMemoriesClick);
    void offChanged.then((un) => un()).catch(() => {});
  };
};

/** 极简 HTML 转义（用户资料/卡片内容回显，防注入） */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}
