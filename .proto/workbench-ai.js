/* ============================================================
   AI 助手面板（渲染进 #ai-panel）
   会话管理 / 聊天渲染 / 极简 markdown / 建议卡片 / 终端快照
   依赖 workbench-core.js 的 Workbench 契约与 shared 设计系统。
   ============================================================ */
(function () {
  const panel = document.getElementById('ai-panel');
  const { toast } = AIShell;
  const Workbench = window.Workbench;

  /* ---------- 面板样式（补充设计系统未覆盖的细节） ---------- */
  const style = document.createElement('style');
  style.textContent = `
    /* 顶部会话栏 */
    #ai-session-bar {
      height: 40px; flex: none; display: flex; align-items: center; gap: 6px;
      padding: 0 8px; border-bottom: 1px solid var(--border);
    }
    #ai-session-bar .select { flex: 1; height: 26px; font-size: 12px; padding: 0 28px 0 8px; }

    /* 聊天历史 */
    #ai-chat {
      flex: 1; overflow-y: auto; padding: 12px 10px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .ai-msg { display: flex; }
    .ai-msg.user { justify-content: flex-end; }
    .ai-bubble {
      max-width: 88%; padding: 8px 11px; border-radius: 10px;
      font-size: 12.5px; line-height: 1.6; word-break: break-word; min-width: 0;
    }
    .ai-msg.user .ai-bubble { background: var(--accent-dim); border-bottom-right-radius: 3px; }
    .ai-msg.ai .ai-bubble { background: var(--bg-2); border-bottom-left-radius: 3px; }
    .ai-text { white-space: pre-wrap; }
    .ai-para { margin: 0 0 6px; }
    .ai-para:last-child { margin-bottom: 0; }

    /* 行内代码 / 代码块 */
    .ai-code-inline {
      background: rgba(0, 0, 0, 0.35); border: 1px solid var(--border); border-radius: 3px;
      padding: 0 4px; font-family: var(--font-mono); font-size: 11.5px; color: var(--yellow);
    }
    .ai-code-block {
      background: #0d0f14; border: 1px solid var(--border); border-radius: 6px;
      padding: 10px 12px; margin: 6px 0; overflow-x: auto; position: relative;
    }
    .ai-code-block code { font-family: var(--font-mono); font-size: 12px; color: var(--text-0); white-space: pre; }
    .ai-code-lang { position: absolute; top: 5px; right: 8px; font-size: 10px; color: var(--text-2); }

    /* 建议卡片 */
    .ai-suggest {
      display: flex; align-items: center; gap: 8px; margin: 6px 0;
      background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 10px; cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }
    .ai-suggest:hover { border-color: var(--border-strong); background: var(--bg-3); }
    .ai-suggest.cmd { border-left: 3px solid var(--green); }
    .ai-suggest.text { border-left: 3px solid var(--accent); }
    .ai-suggest-icon { font-size: 14px; flex: none; }
    .ai-suggest-main {
      flex: 1; min-width: 0; font-size: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ai-suggest.cmd .ai-suggest-main { font-family: var(--font-mono); color: var(--green); }
    .ai-suggest .btn { flex: none; }

    /* 底部输入区 */
    #ai-input-area {
      flex: none; border-top: 1px solid var(--border);
      padding: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    #ai-chip-row { display: flex; flex-wrap: wrap; gap: 4px; }
    #ai-input-row { display: flex; gap: 6px; align-items: flex-end; }
    #ai-input {
      flex: 1; resize: none; height: 34px; max-height: 120px; overflow-y: auto;
      background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
      color: var(--text-0); padding: 7px 10px; outline: none;
      font-family: var(--font-ui); font-size: 12.5px; line-height: 1.5;
    }
    #ai-input:focus { border-color: var(--accent); }
    #ai-input::placeholder { color: var(--text-2); }
    #ai-send { flex: none; height: 34px; padding: 0 14px; }

    /* 快照 chip */
    .ai-snap-chip { cursor: pointer; user-select: none; }
    .ai-snap-chip .ai-chip-x { margin-left: 5px; opacity: 0.7; cursor: pointer; }
    .ai-snap-chip .ai-chip-x:hover { opacity: 1; }
    .ai-msg-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }

    /* 正在输入…动画 */
    .ai-typing { display: inline-flex; align-items: center; gap: 4px; }
    .ai-typing .ai-typing-label { font-size: 11px; color: var(--text-2); margin-right: 2px; }
    .ai-typing span {
      width: 5px; height: 5px; border-radius: 50%; background: var(--text-2);
      animation: ai-blink 1.2s infinite;
    }
    .ai-typing span:nth-child(3) { animation-delay: 0.2s; }
    .ai-typing span:nth-child(4) { animation-delay: 0.4s; }
    @keyframes ai-blink {
      0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-2px); }
    }

    /* 快照详情弹窗 */
    .ai-snap-command {
      background: rgba(0, 0, 0, 0.35); border: 1px solid var(--border); border-radius: 6px;
      padding: 7px 10px; margin-bottom: 10px; font-size: 12px; color: var(--green);
    }
    .ai-snap-pre {
      background: #0d0f14; border: 1px solid var(--border); border-radius: 6px;
      padding: 12px; overflow: auto; max-height: 60vh;
      font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--text-0);
      white-space: pre-wrap; word-break: break-all;
    }
  `;
  document.head.appendChild(style);

  /* ---------- DOM 骨架 ---------- */
  panel.innerHTML = `
    <div id="ai-session-bar">
      <select id="ai-session-select" class="select" title="切换会话"></select>
      <button id="ai-new-session" class="icon-btn" title="新建会话">＋</button>
    </div>
    <div id="ai-chat"></div>
    <div id="ai-input-area">
      <div id="ai-chip-row"></div>
      <div id="ai-input-row">
        <textarea id="ai-input" placeholder="向 AI 提问，Enter 发送，Shift+Enter 换行"></textarea>
        <button id="ai-send" class="btn primary" title="发送 (Enter)">发送</button>
      </div>
    </div>`;

  const el = (id) => document.getElementById('ai-' + id);
  const chat = el('chat');
  const sessionSelect = el('session-select');
  const newSessionBtn = el('new-session');
  const input = el('input');
  const sendBtn = el('send');
  const chipRow = el('chip-row');

  /* ---------- 会话管理（模块内存储，不持久化） ---------- */
  const sessions = new Map(); // id -> { id, title, messages: [] }
  let activeSessionId = null;
  let sessionCount = 0;

  function newSession(title) {
    const s = { id: AIShell.uid('chat'), title, messages: [] };
    sessions.set(s.id, s);
    return s;
  }
  activeSessionId = newSession('默认会话').id;

  function createSession() {
    sessionCount += 1;
    activeSessionId = newSession('会话 ' + sessionCount).id;
    renderSessionBar();
    renderHistory();
  }

  function renderSessionBar() {
    sessionSelect.innerHTML = '';
    sessions.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      opt.selected = s.id === activeSessionId;
      sessionSelect.appendChild(opt);
    });
  }
  sessionSelect.onchange = () => { activeSessionId = sessionSelect.value; renderHistory(); };
  newSessionBtn.onclick = createSession;

  /* ---------- 聊天渲染 ---------- */
  function scrollBottom() { chat.scrollTop = chat.scrollHeight; }

  function renderHistory() {
    chat.innerHTML = '';
    const s = sessions.get(activeSessionId);
    if (s) s.messages.forEach((m) => chat.appendChild(renderMessage(m)));
    // 若当前会话仍在"正在输入…"阶段，占位气泡跟随历史一并渲染
    if (pending && pending.sessionId === activeSessionId) appendTypingEl();
    scrollBottom();
  }

  function renderMessage(m) {
    const wrap = document.createElement('div');
    if (m.role === 'user') {
      wrap.className = 'ai-msg user';
      const chips = (m.snaps || []).map((snap) =>
        `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(snap.id)}" title="点击查看快照全文">@terminal_${escapeHtml(snap.id)}</span>`
      ).join('');
      wrap.innerHTML =
        `<div class="ai-bubble">${chips ? `<div class="ai-msg-chips">${chips}</div>` : ''}` +
        `<div class="ai-text">${escapeHtml(m.text)}</div></div>`;
    } else {
      wrap.className = 'ai-msg ai';
      wrap.innerHTML = `<div class="ai-bubble">${m.html}</div>`;
    }
    return wrap;
  }

  /* ---------- 极简 markdown：先转义 HTML，再解析 ---------- */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    let out = escapeHtml(s);
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`([^`]+)`/g, '<code class="ai-code-inline">$1</code>');
    return out;
  }

  /* fenced 块：```command → 命令卡；```text → 文本卡；其余 → 代码块 */
  function renderAI(text) {
    const parts = [];
    const re = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)(?:```|$)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ kind: 'para', body: text.slice(last, m.index) });
      const lang = (m[1] || '').trim();
      const body = m[2].replace(/\r?\n$/, '');
      parts.push({ kind: lang === 'command' ? 'command' : lang === 'text' ? 'text' : 'code', lang, body });
      last = re.lastIndex;
    }
    if (last < text.length) parts.push({ kind: 'para', body: text.slice(last) });
    return parts.map(renderPart).join('');
  }

  function renderPart(p) {
    switch (p.kind) {
      case 'command':
        return `<div class="ai-suggest cmd" data-action="paste" data-cmd="${escapeHtml(p.body)}" title="点击卡片粘贴到终端">
          <span class="ai-suggest-icon">⌨️</span>
          <code class="ai-suggest-main">${escapeHtml(p.body)}</code>
          <button class="btn small" type="button">粘贴到终端</button>
        </div>`;
      case 'text':
        return `<div class="ai-suggest text" data-action="insert" data-text="${escapeHtml(p.body)}" title="点击卡片插入输入框">
          <span class="ai-suggest-icon">💬</span>
          <span class="ai-suggest-main">${escapeHtml(p.body)}</span>
          <button class="btn small" type="button">插入输入框</button>
        </div>`;
      case 'code':
        return `<pre class="ai-code-block">${p.lang ? `<span class="ai-code-lang">${escapeHtml(p.lang)}</span>` : ''}<code>${escapeHtml(p.body)}</code></pre>`;
      default:
        return p.body
          .split(/\n{2,}/)
          .map((para) => para.trim())
          .filter(Boolean)
          .map((para) => `<p class="ai-para">${inline(para).replace(/\n/g, '<br>')}</p>`)
          .join('');
    }
  }

  /* ---------- 建议卡片点击（事件委托） ---------- */
  chat.addEventListener('click', (e) => {
    const card = e.target.closest('[data-action]');
    if (card) {
      if (card.dataset.action === 'paste') {
        const api = Workbench.getActiveTerminalApi();
        if (api) {
          api.paste(card.dataset.cmd);
          toast('已粘贴到终端', 'success');
        } else {
          toast('没有可用的终端标签页', 'error');
        }
      } else if (card.dataset.action === 'insert') {
        insertIntoInput(card.dataset.text);
      }
      return;
    }
    const chip = e.target.closest('[data-snap-id]');
    if (chip) openSnapModal(snapshots.get(chip.dataset.snapId));
  });

  function insertIntoInput(text) {
    if (input.value && !input.value.endsWith('\n')) input.value += '\n';
    input.value += text;
    autoGrow();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /* ---------- 终端快照 ---------- */
  const snapshots = new Map(); // id -> {id, command, content, ts}

  function addChip(snap) {
    const c = document.createElement('span');
    c.className = 'tag blue ai-snap-chip';
    c.dataset.id = snap.id;
    c.title = '点击查看快照全文，✕ 移除';
    c.innerHTML = `@terminal_${escapeHtml(snap.id)}<span class="ai-chip-x" title="移除">✕</span>`;
    chipRow.appendChild(c);
  }
  chipRow.addEventListener('click', (e) => {
    const chip = e.target.closest('.ai-snap-chip');
    if (!chip) return;
    if (e.target.closest('.ai-chip-x')) { chip.remove(); return; }
    openSnapModal(snapshots.get(chip.dataset.id));
  });
  const clearChips = () => { chipRow.innerHTML = ''; };

  function openSnapModal(snap) {
    if (!snap) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:560px">
        <div class="modal-head"><h3>终端快照 · @terminal_${escapeHtml(snap.id)}</h3><button class="icon-btn ai-modal-x" title="关闭">✕</button></div>
        <div class="modal-body">
          <div class="ai-snap-command mono">$ ${escapeHtml(snap.command)}</div>
          <pre class="ai-snap-pre">${escapeHtml(snap.content || '')}</pre>
        </div>
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('open'));
    const close = () => { mask.classList.remove('open'); setTimeout(() => mask.remove(), 160); };
    mask.querySelector('.ai-modal-x').onclick = close;
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  }

  /* 供终端模块调用：Workbench.ai.addSnapshot(snap) */
  Workbench.ai = {
    addSnapshot(snap) {
      if (!snap || !snap.id) return;
      snapshots.set(snap.id, snap);
      addChip(snap);
    },
  };

  /* ---------- 输入区 ---------- */
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
  }
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.onclick = send;

  /* ---------- 发送与模拟 AI 回复 ---------- */
  let pending = null; // { sessionId, text, snaps, timers[], typingEl }

  function send() {
    const text = input.value.trim();
    const chipIds = Array.from(chipRow.children).map((c) => c.dataset.id);
    const snaps = chipIds.map((id) => snapshots.get(id)).filter(Boolean);
    if (!text && !snaps.length) return;

    const sid = activeSessionId;
    sessions.get(sid).messages.push({ role: 'user', text, snaps });

    input.value = '';
    autoGrow();
    clearChips();
    cancelPending();
    renderHistory();

    // 模拟：300ms 后出现"正在输入…"，再 800ms 后替换为正式回复
    pending = { sessionId: sid, text, snaps, timers: [], typingEl: null };
    pending.timers.push(setTimeout(() => { if (pending && pending.sessionId === sid) appendTypingEl(); }, 300));
    pending.timers.push(setTimeout(() => finishReply(sid), 1100));
  }

  function appendTypingEl() {
    if (!pending) return;
    if (!pending.typingEl || !pending.typingEl.isConnected) {
      pending.typingEl = document.createElement('div');
      pending.typingEl.className = 'ai-msg ai';
      pending.typingEl.innerHTML =
        '<div class="ai-bubble"><span class="ai-typing"><span class="ai-typing-label">正在输入</span><span></span><span></span><span></span></span></div>';
    }
    chat.appendChild(pending.typingEl);
    scrollBottom();
  }

  function cancelPending() {
    if (!pending) return;
    pending.timers.forEach(clearTimeout);
    if (pending.typingEl && pending.typingEl.isConnected) pending.typingEl.remove();
    pending = null;
  }

  function finishReply(sid) {
    if (!pending || pending.sessionId !== sid) return;
    const p = pending;
    pending = null;
    p.timers.forEach(clearTimeout);
    if (p.typingEl && p.typingEl.isConnected) p.typingEl.remove();

    const s = sessions.get(sid);
    if (!s) return;
    s.messages.push({ role: 'ai', html: renderAI(generateReply(p.text, p.snaps)) });
    if (activeSessionId === sid) renderHistory();
  }

  /* ---------- 模拟回复生成（关键词匹配，均含建议组件） ---------- */
  function generateReply(rawInput, snaps) {
    const text = (rawInput || '').trim();
    const snap = snaps && snaps.length ? snaps[0] : null;

    // 携带快照 → 日志解读分支，开头引用快照命令
    if (snap) {
      return [
        `从终端快照来看，你执行的 \`${snap.command}\` 输出显示：`,
        '',
        '输出包含若干错误级别条目与常规请求日志，报错集中在最近几次请求中。建议先查看应用日志最新的 50 行，确认错误上下文：',
        '',
        '```command',
        'tail -n 50 app.log',
        '```',
      ].join('\n');
    }
    if (/git/i.test(text)) {
      return [
        '看起来你在处理 Git 相关操作。先查看仓库当前状态，再浏览最近几条提交记录：',
        '',
        '```command',
        'git status',
        '```',
        '',
        '```command',
        'git log --oneline -5',
        '```',
      ].join('\n');
    }
    if (/日志|log/i.test(text)) {
      return [
        '从终端日志来看，重点可以关注最近 50 行的输出，通常能直接定位到报错来源：',
        '',
        '```command',
        'tail -n 50 app.log',
        '```',
      ].join('\n');
    }
    if (/脚本|封装/i.test(text)) {
      return [
        '可以把这段逻辑封装成一个 Bash 脚本，便于重复执行与维护：',
        '',
        '```bash',
        '#!/usr/bin/env bash',
        '# 示例：封装常用操作',
        'set -euo pipefail',
        'echo "开始执行…"',
        'echo "完成"',
        '```',
        '',
        '```text',
        '这是脚本说明，可直接保存为 .sh 使用',
        '```',
      ].join('\n');
    }
    return [
      '收到！这是一个模拟的 AI 回复，用于演示建议卡片组件。可以试试在终端里执行下面的命令：',
      '',
      '```command',
      'echo hello',
      '```',
    ].join('\n');
  }

  /* ---------- 初始化 ---------- */
  renderSessionBar();
  renderHistory();
})();
