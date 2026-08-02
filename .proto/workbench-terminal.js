/* ============================================================
   workbench-terminal.js — 模拟伪终端模块
   契约：Workbench.registerRenderer('terminal', fn(container, tab) -> api)
   api = { paste(cmd), execute(cmd), takeSnapshot() }
   每个 tab 独立状态 {cwd, history, lastCommand, mode}。
   ============================================================ */
(function () {
  'use strict';
  const Workbench = window.Workbench;

  /* ---------- 样式（只注入一次） ---------- */
  if (!document.getElementById('term-style')) {
    const st = document.createElement('style');
    st.id = 'term-style';
    st.textContent = `
      .term-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg-0); }
      .term-info { height:34px; flex:none; display:flex; align-items:center; gap:8px; padding:0 10px;
        background:var(--bg-1); border-bottom:1px solid var(--border); font-size:12px; color:var(--text-1); }
      .term-info-cmd { flex:0 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .term-info-spacer { flex:1; }
      .term-body { flex:1; min-height:0; display:flex; flex-direction:column; background:#0d1117; position:relative; }
      .term-scroll { flex:1; min-height:0; overflow-y:auto; padding:10px 10px 4px;
        font-family:var(--font-mono); font-size:12.5px; line-height:1.65; color:var(--text-0); }
      .term-line { white-space:pre-wrap; word-break:break-all; }
      .term-block { position:relative; border-left:2px solid var(--border); background:rgba(255,255,255,0.025);
        border-radius:0 6px 6px 0; padding:6px 10px 8px; margin:6px 0 10px; }
      .term-block-head { padding-right:172px; }
      .term-block-cmd { white-space:pre-wrap; word-break:break-all; color:var(--text-0); }
      .term-block-out { margin-top:3px; }
      .term-block-actions { position:absolute; top:6px; right:8px; display:flex; gap:6px;
        opacity:0; pointer-events:none; transition:opacity .15s; }
      .term-block:hover .term-block-actions { opacity:1; pointer-events:auto; }
      .term-io { flex:none; display:flex; align-items:center; gap:6px; padding:4px 10px 10px;
        background:#0d1117; font-family:var(--font-mono); font-size:12.5px; }
      .term-prompt-io { white-space:pre; color:var(--text-0); flex:none; }
      .term-input { flex:1; min-width:0; background:transparent; border:none; outline:none; color:var(--text-0);
        font-family:var(--font-mono); font-size:12.5px; caret-color:var(--accent); }
      .term-input::placeholder { color:var(--text-2); }
      .term-hint { flex:none; display:none; align-items:center; gap:10px; padding:6px 10px 10px;
        background:#0d1117; font-family:var(--font-mono); font-size:12px; color:var(--text-2); }
      .term-hint-cmd { color:var(--yellow); }
      .term-vi { position:absolute; inset:0; display:flex; flex-direction:column; background:#0d1117;
        font-family:var(--font-mono); font-size:12.5px; }
      .term-vi-head { padding:6px 10px; color:var(--text-1); background:#161b22; border-bottom:1px solid var(--border); }
      .term-vi-body { flex:1; overflow-y:auto; padding:8px 10px; line-height:1.7; white-space:pre; }
      .term-vi-line .ln { display:inline-block; width:34px; color:var(--text-2); user-select:none; }
      .term-vi-status { padding:4px 10px; color:var(--text-2); border-top:1px solid var(--border); background:#161b22; }
      .term-tail { position:absolute; inset:0; display:flex; flex-direction:column; background:#0d1117;
        font-family:var(--font-mono); font-size:12.5px; }
      .term-tail-head { padding:6px 10px; color:var(--text-1); background:#161b22; border-bottom:1px solid var(--border);
        display:flex; justify-content:space-between; }
      .term-tail-lines { flex:1; overflow-y:auto; padding:8px 10px; line-height:1.7; white-space:pre; }
    `;
    document.head.appendChild(st);
  }

  /* ---------- 终端配色 ---------- */
  const C = { blue:'#4f8ef7', green:'#4ec98a', yellow:'#e5c07b', red:'#e5626a', dim:'#8b93a5', purple:'#b687e8', cyan:'#56b6c2' };

  /* ---------- 行构建工具 ---------- */
  function richLine(segs, cls) {
    const div = document.createElement('div');
    div.className = 'term-line' + (cls ? ' ' + cls : '');
    const push = (s) => {
      if (typeof s === 'string') div.appendChild(document.createTextNode(s));
      else if (s && typeof s.t === 'string') {
        const sp = document.createElement('span');
        sp.textContent = s.t;
        if (s.c) sp.style.color = s.c;
        div.appendChild(sp);
      }
    };
    (Array.isArray(segs) ? segs : [segs]).forEach(push);
    return div;
  }
  const line = (t, cls) => richLine(String(t), cls);
  const dimLine = (t) => richLine([{ t: String(t), c: C.dim }]);
  const redLine = (t) => richLine([{ t: String(t), c: C.red }]);
  const greenLine = (t) => richLine([{ t: String(t), c: C.green }]);
  const col = (t, c) => ({ t, c });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pad = (n) => String(n).padStart(2, '0');

  /* ---------- 模拟目录表 ---------- */
  function fakeEntries(cwd) {
    const base = cwd.toLowerCase();
    if (base.endsWith('/aishell2')) return [
      { name: '.proto', isDir: true }, { name: 'src', isDir: true }, { name: 'shared', isDir: true },
      { name: 'docs', isDir: true }, { name: 'package.json' }, { name: 'README.md' },
      { name: 'vite.config.ts' }, { name: 'tsconfig.json' }, { name: '.gitignore' },
    ];
    if (base.endsWith('/src')) return [
      { name: 'app', isDir: true }, { name: 'components', isDir: true }, { name: 'main.ts' }, { name: 'style.css' },
    ];
    if (base.endsWith('/shared')) return [{ name: 'design.css' }, { name: 'mock.js' }];
    if (base.endsWith('/.proto')) return [
      { name: 'shared', isDir: true }, { name: 'index.html' }, { name: 'workbench.html' },
      { name: 'workbench-core.js' }, { name: 'workbench-terminal.js' }, { name: 'workbench-ai.js' },
    ];
    if (base.endsWith('/docs')) return [{ name: 'design.md' }, { name: 'api.md' }];
    if (base.endsWith('/app')) return [
      { name: 'src', isDir: true }, { name: 'dist', isDir: true }, { name: 'app.log' },
      { name: 'package.json' }, { name: 'deploy.sh' },
    ];
    if (base.endsWith('/logs') || base.endsWith('/log')) return [
      { name: 'app.log' }, { name: 'nginx.log' }, { name: 'error.log' }, { name: 'old', isDir: true },
    ];
    if (base === '/home/deploy' || base === '/root' || base === '/home/ubuntu') return [
      { name: 'app', isDir: true }, { name: 'logs', isDir: true }, { name: '.ssh', isDir: true },
      { name: 'deploy.sh' }, { name: 'app.log' }, { name: 'README.md' },
    ];
    if (base.endsWith('/.ssh')) return [{ name: 'id_ed25519' }, { name: 'id_ed25519.pub' }, { name: 'known_hosts' }];
    if (base === '/d/blog') return [
      { name: 'content', isDir: true }, { name: 'public', isDir: true }, { name: 'hugo.toml' }, { name: 'README.md' },
    ];
    return [{ name: 'src', isDir: true }, { name: 'docs', isDir: true }, { name: 'config.json' }, { name: 'README.md' }, { name: 'index.html' }];
  }

  /* ---------- vi 模拟内容 ---------- */
  function viContent(file) {
    const ext = (file.split('.').pop() || '').toLowerCase();
    if (ext === 'json') return ['{', '  "name": "aishell-app",', '  "version": "0.1.0",', '  "scripts": {', '    "dev": "vite",', '    "build": "vite build"', '  }', '}'];
    if (ext === 'md') return ['# AIShell Prototype', '', 'Windows 桌面 Shell 工具原型。', '', '- 终端模拟', '- 文件管理', '- AI 对话'];
    if (ext === 'log') return [
      '[2026-08-02 14:20:11] INFO  server started',
      '[2026-08-02 14:21:02] WARN  slow request: 1200ms',
      '[2026-08-02 14:22:47] ERROR upstream timeout',
    ];
    if (['js', 'ts', 'jsx', 'tsx'].includes(ext)) return [
      'import { defineConfig } from "vite";', '',
      'export default defineConfig({', '  server: { port: 5173, host: "0.0.0.0" },', '});',
    ];
    if (['sh', 'bash'].includes(ext)) return [
      '#!/usr/bin/env bash', 'set -euo pipefail', '', 'echo "deploy started"', 'npm run build',
    ];
    if (['css', 'scss'].includes(ext)) return [':root {', '  --accent: #4f8ef7;', '  --radius-m: 8px;', '}', '.btn { padding: 6px 14px; }'];
    return ['Hello, AIShell!', '', 'This is a mock vi view.', 'Press :q then Enter to exit.'];
  }

  /* ---------- tail 日志池 ---------- */
  const TAIL_POOL = [
    ['GET /api/projects 200', '12ms', null],
    ['POST /api/chat 200', '340ms', null],
    ['GET /api/servers 200', '9ms', null],
    ['worker heartbeat ok', '', null],
    ['POST /api/terminal/exec 200', '96ms', null],
    ['GET /api/snapshot 200', '21ms', null],
    ['WARN slow query: SELECT * FROM projects', '', C.yellow],
    ['ERROR upstream timeout, retrying', '', C.red],
    ['DEBUG xterm render frame 16ms', '', C.dim],
    ['GET /api/projects/3/files 200', '18ms', null],
  ];
  function nextLogLine() {
    const pick = TAIL_POOL[Math.floor(Math.random() * TAIL_POOL.length)];
    const now = new Date();
    const ts = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    return { text: '[' + ts + '] ' + pick[0] + (pick[1] ? ' ' + pick[1] : ''), color: pick[2] };
  }

  /* ============================================================
     渲染器：每个 tab 独立闭包
     ============================================================ */
  Workbench.registerRenderer('terminal', function renderTerminal(container, tab) {
    const db = Workbench.state.db;
    const server = db.servers.find((s) => s.id === tab.data.serverId) || null;
    const isSsh = tab.data.kind === 'ssh' || !!server;
    const user = isSsh ? ((server && server.username) || 'deploy') : 'user';
    const host = isSsh ? ((server && server.host) || 'remote') : 'gitbash';
    const home = isSsh ? (user === 'root' ? '/root' : '/home/' + user) : '/c/projects/demo';

    /* 每 tab 独立状态 */
    const state = { cwd: initCwd(), history: [], lastCommand: null, mode: 'normal', interactive: null, viBuffer: '' };
    let histIdx = -1;

    function initCwd() {
      if (isSsh) return home;
      const project = Workbench.state.project;
      if (project && project.path) {
        return project.path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => '/' + d.toLowerCase());
      }
      return home;
    }

    /* ---------- DOM ---------- */
    const root = document.createElement('div');
    root.className = 'term-root';

    const info = document.createElement('div');
    info.className = 'term-info';
    const infoLabel = document.createElement('span');
    infoLabel.textContent = '最后命令:';
    const infoCmd = document.createElement('span');
    infoCmd.className = 'term-info-cmd mono ellipsis';
    const spacer = document.createElement('span');
    spacer.className = 'term-info-spacer';
    const infoBtn = document.createElement('button');
    infoBtn.className = 'btn small';
    infoBtn.textContent = '添加到chat';
    infoBtn.disabled = true;
    infoBtn.onclick = addLastToAI;
    info.append(infoLabel, infoCmd, spacer, infoBtn);

    const body = document.createElement('div');
    body.className = 'term-body';
    const termScroll = document.createElement('div');
    termScroll.className = 'term-scroll';

    const io = document.createElement('div');
    io.className = 'term-io';
    const promptEl = document.createElement('span');
    promptEl.className = 'term-prompt-io';
    promptEl.innerHTML = promptHTML();
    const input = document.createElement('input');
    input.className = 'term-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    io.append(promptEl, input);

    const hint = document.createElement('div');
    hint.className = 'term-hint';
    const hintText = document.createElement('span');
    hintText.textContent = '交互模式：vi 输入 :q 退出 / tail 按 Ctrl+C 退出';
    const hintCmd = document.createElement('span');
    hintCmd.className = 'term-hint-cmd';
    hint.append(hintText, hintCmd);

    body.appendChild(termScroll);
    root.append(info, body, io, hint);
    container.appendChild(root);

    function promptHTML() {
      if (isSsh) {
        return '<span style="color:' + C.green + '">' + esc(user + '@' + host) + '</span>' +
          '<span style="color:' + C.blue + '">:' + esc(state.cwd) + '</span><span>$</span>';
      }
      return '<span style="color:' + C.green + '">user@gitbash </span>' +
        '<span style="color:' + C.yellow + '">MINGW64 </span>' +
        '<span style="color:' + C.blue + '">' + esc(state.cwd) + '</span><span> $</span>';
    }
    function renderPrompt() { promptEl.innerHTML = promptHTML(); }

    function updateInfo() {
      infoCmd.textContent = state.lastCommand || '—';
      infoCmd.style.color = state.lastCommand ? 'var(--text-0)' : 'var(--text-2)';
      infoBtn.disabled = !state.lastCommand;
    }
    function scrollBottom() { termScroll.scrollTop = termScroll.scrollHeight; }
    function lastBlock() {
      const blocks = termScroll.querySelectorAll('.term-block');
      return blocks.length ? blocks[blocks.length - 1] : null;
    }
    function clearBlocks() {
      termScroll.querySelectorAll('.term-block').forEach((b) => b.remove());
      termScroll.scrollTop = 0;
    }

    /* ---------- 横幅 ---------- */
    function printBanner() {
      if (isSsh) {
        const h = (server && server.host) || 'remote';
        const p = (server && server.port) || 22;
        termScroll.appendChild(richLine([{ t: 'Connecting to ' + user + '@' + h + ':' + p + ' ...', c: C.dim }]));
        termScroll.appendChild(richLine([{ t: 'Connected', c: C.green }, ' (模拟)']));
      } else {
        termScroll.appendChild(richLine([{ t: 'Git Bash', c: C.green }, ' (模拟) — AIShell Prototype']));
      }
      termScroll.appendChild(dimLine('输入 help 查看可用命令'));
      termScroll.appendChild(document.createElement('div'));
    }

    /* ---------- 内置命令响应 ---------- */
    function lsLines() {
      const entries = fakeEntries(state.cwd);
      const lines = entries.map((e) => richLine([{ t: e.name, c: e.isDir ? C.blue : undefined }]));
      if (!lines.length) lines.push(dimLine('（空目录）'));
      return lines;
    }
    function gitStatusLines() {
      return [
        richLine([col('On branch ', null), col('main', C.green)]),
        line("Your branch is up to date with 'origin/main'."),
        line(''),
        line('Changes not staged for commit:'),
        dimLine('  (use "git add <file>..." to update what will be committed)'),
        dimLine('  (use "git restore <file>..." to discard changes in working directory)'),
        line(''),
        richLine([col('\tmodified:   ', C.red), col('workbench-terminal.js', C.red)]),
        richLine([col('\tmodified:   ', C.red), col('workbench-ai.js', C.red)]),
        line(''),
        line('Untracked files:'),
        dimLine('  (use "git add <file>..." to include in what will be committed)'),
        line(''),
        richLine([col('\t.proto/.tmp/', C.yellow)]),
      ];
    }
    function gitLogLines() {
      return [
        richLine([col('a1b2c3d', C.yellow), ' (HEAD -> main) feat: 终端模块接入 AI 快照']),
        richLine([col('e4f5a6b', C.yellow), ' fix: 修复 sftp 上传超时']),
        richLine([col('c7d8e9f', C.yellow), ' chore: 更新设计变量与图标']),
        richLine([col('b0a1b2c', C.yellow), ' feat: 新增 SSH 连接管理']),
        richLine([col('d3e4f5a', C.yellow), ' docs: 补充原型说明']),
      ];
    }
    function npmDevLines() {
      return [
        line('> aishell-app@0.1.0 dev'),
        line('> vite'),
        line(''),
        richLine([col('  VITE ', C.cyan), 'v5.4.8  ready in 386 ms']),
        line(''),
        richLine([col('  ➜  Local:   ', C.cyan), col('http://localhost:5173/', C.blue)]),
        richLine([col('  ➜  Network: ', C.cyan), col('http://192.168.31.7:5173/', C.blue)]),
        richLine([col('  ➜  press h + enter to show help', C.cyan)]),
        line(''),
        dimLine('（模拟）进程持续运行中…'),
      ];
    }
    function duListLines() {
      return fakeEntries(state.cwd).map((e, i) => {
        const sz = e.isDir ? (Math.round((0.6 + i * 0.7) * 10) / 10) + 'M' : (Math.round((0.05 + i * 0.04) * 100) / 100) + 'M';
        return richLine([col(sz, null), '\t./' + e.name]);
      });
    }
    function sysStatusLines(cmd) {
      const svc = (cmd.match(/^systemctl status\s+(\S+)/) || [])[1] || 'airflow-webserver';
      return [
        richLine([col('● ', C.green), svc + '.service - Airflow webserver daemon']),
        line('     Loaded: loaded (/etc/systemd/system/' + svc + '.service; enabled; preset: enabled)'),
        richLine(['     Active: ', col('active (running)', C.green), ' since Thu 2026-07-30 09:12:41 CST; 3 days ago']),
        line('   Main PID: 18234 (gunicorn)'),
        line('      Tasks: 12 (limit: 4915)'),
        line('     Memory: 486.2M'),
        line('        CPU: 1h 12min 33.201s'),
        line('     CGroup: /system.slice/' + svc + '.service'),
        dimLine('             ├─18234 /usr/bin/gunicorn -k gthread --workers 4'),
        dimLine('             └─18241 /usr/bin/python /usr/local/bin/airflow scheduler'),
      ];
    }
    function sysRestartLines(cmd) {
      const svc = (cmd.match(/^systemctl restart\s+(\S+)/) || [])[1] || 'airflow-webserver';
      return [
        dimLine('（模拟）systemctl restart ' + svc + ' ...'),
        greenLine('Job for ' + svc + '.service started.'),
      ];
    }
    function helpLines() {
      return [
        richLine([col('可用命令（模拟终端）', C.yellow)]),
        line(''),
        line('  ls, dir                  列出当前目录'),
        line('  pwd                      显示当前路径'),
        line('  cd <path>                切换目录（.. 上级 / ~ 家目录）'),
        line('  git status               查看 Git 状态'),
        line('  git log --oneline -5     查看最近 5 条提交'),
        line('  npm run dev              启动前端开发服务'),
        line('  du -sh                   查看目录占用'),
        line('  systemctl status         查看服务状态'),
        line('  vi <file>                进入 vi 编辑器（模拟，:q 退出）'),
        line('  tail -f <file>           实时查看日志（模拟，Ctrl+C 退出）'),
        line('  echo <text>              输出文本'),
        line('  clear                    清空终端'),
        line('  help                     显示本帮助'),
        line(''),
        dimLine('（其余命令输出模拟结果或 command not found）'),
      ];
    }

    /* ---------- cd ---------- */
    function normalizePath(p) {
      const out = [];
      p.split('/').forEach((part) => {
        if (!part || part === '.') return;
        if (part === '..') out.pop();
        else out.push(part);
      });
      return '/' + out.join('/');
    }
    function changeDir(arg) {
      const target = (arg || '').trim();
      if (!target || target === '~') { state.cwd = home; }
      else if (target.startsWith('~')) { state.cwd = normalizePath(home + target.slice(1)); }
      else if (target.startsWith('/')) { state.cwd = normalizePath(target); }
      else { state.cwd = normalizePath(state.cwd + '/' + target); }
      renderPrompt();
    }

    /* ---------- 命令分发 ---------- */
    function execOne(cmd) {
      const first = cmd.split(/\s+/)[0];
      if (first === 'ls' || first === 'dir') return { lines: lsLines() };
      if (first === 'pwd') return { lines: [line(state.cwd)] };
      if (first === 'cd') { changeDir(cmd.slice(2)); return { lines: [] }; }
      if (cmd === 'help') return { lines: helpLines() };
      if (/^vi\s+\S+/.test(cmd)) return { interactive: { kind: 'vi', file: cmd.slice(3).trim().split(/\s+/)[0] } };
      if (first === 'vi') return { lines: [dimLine('usage: vi <file>')] };
      if (/^tail\s+-f\s+\S+/.test(cmd)) return { interactive: { kind: 'tail', file: cmd.slice(cmd.indexOf(' -f ') + 4).trim().split(/\s+/)[0] } };
      if (first === 'tail') return { lines: [dimLine('usage: tail -f <file>')] };
      if (cmd === 'git status' || cmd.startsWith('git status ')) return { lines: gitStatusLines() };
      if (cmd === 'git log --oneline -5') return { lines: gitLogLines() };
      if (cmd.startsWith('git ')) return { lines: [dimLine('（模拟）' + cmd + ' 已执行，输出省略')] };
      if (cmd.startsWith('npm run dev')) return { lines: npmDevLines() };
      if (cmd === 'du -sh') return { lines: [line('12M\t.')] };
      if (cmd.startsWith('du -sh ')) return { lines: duListLines() };
      if (cmd.startsWith('systemctl status')) return { lines: sysStatusLines(cmd) };
      if (cmd.startsWith('systemctl restart ')) return { lines: sysRestartLines(cmd) };
      if (cmd.startsWith('systemctl ')) return { lines: [dimLine('（模拟）' + cmd + ' 已执行')] };
      if (first === 'echo') return { lines: [line(cmd.slice(5).trim())] };
      return { lines: [redLine('bash: ' + first + ': command not found')] };
    }

    /* ---------- 添加快捷指令（pin） ---------- */
    function addToQuickCommands(cmdText) {
      const project = Workbench.state.project;
      if (!project) { AIShell.toast('当前没有打开的项目', 'error'); return; }
      project.quickCommands = project.quickCommands || [];
      if (project.quickCommands.some((q) => q.command === cmdText)) {
        AIShell.toast('该命令已在快捷指令中', 'error');
        return;
      }
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal" style="width:440px">
          <div class="modal-head"><h3>添加快捷指令</h3></div>
          <div class="modal-body">
            <div class="field"><label>指令标题<span class="req">*</span></label><input class="input term-qc-title" maxlength="40"></div>
            <div class="field"><label>命令</label><input class="input mono term-qc-cmd"></div>
          </div>
          <div class="modal-foot">
            <button class="btn term-qc-cancel">取消</button>
            <button class="btn primary term-qc-ok">保存</button>
          </div>
        </div>`;
      const titleInput = mask.querySelector('.term-qc-title');
      const cmdInput = mask.querySelector('.term-qc-cmd');
      titleInput.value = cmdText.length > 24 ? cmdText.slice(0, 24) + '…' : cmdText;
      cmdInput.value = cmdText;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('open'));
      titleInput.focus();
      titleInput.select();
      const close = () => { mask.classList.remove('open'); setTimeout(() => mask.remove(), 160); };
      mask.querySelector('.term-qc-cancel').onclick = close;
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
      const save = () => {
        const title = titleInput.value.trim();
        const command = cmdInput.value.trim();
        if (!title) { titleInput.style.borderColor = 'var(--red)'; titleInput.focus(); return; }
        if (!command) { cmdInput.style.borderColor = 'var(--red)'; cmdInput.focus(); return; }
        project.quickCommands.push({ id: AIShell.uid('qc'), title, command });
        AIShell.save(Workbench.state.db);
        Workbench.bus.emit('project-changed');
        AIShell.toast('已添加快捷指令', 'success');
        close();
      };
      mask.querySelector('.term-qc-ok').onclick = save;
      titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    }

    function renderBlock(cmdText, lines) {
      const block = document.createElement('div');
      block.className = 'term-block';
      const head = document.createElement('div');
      head.className = 'term-block-head';
      const cmdSpan = document.createElement('span');
      cmdSpan.className = 'term-block-cmd';
      const promptSpan = document.createElement('span');
      promptSpan.innerHTML = promptHTML();
      cmdSpan.appendChild(promptSpan);
      cmdSpan.appendChild(document.createTextNode(' ' + cmdText));
      const actions = document.createElement('div');
      actions.className = 'term-block-actions';
      const pinBtn = document.createElement('button');
      pinBtn.className = 'btn small term-pin';
      pinBtn.textContent = '📌 快捷指令';
      pinBtn.title = '将该命令添加为快捷指令';
      pinBtn.onclick = () => addToQuickCommands(cmdText);
      const btn = document.createElement('button');
      btn.className = 'btn small term-addchat';
      btn.textContent = '添加到chat';
      btn.onclick = () => addBlockToAI(block, cmdText);
      actions.append(pinBtn, btn);
      head.append(cmdSpan, actions);
      const out = document.createElement('div');
      out.className = 'term-block-out';
      (lines || []).forEach((ln) => out.appendChild(ln));
      block.append(head, out);
      termScroll.appendChild(block);
      return block;
    }

    function runCommand(raw) {
      const cmd = String(raw || '').trim();
      input.value = '';
      histIdx = -1;
      if (!cmd) return;
      state.history.push(cmd);
      state.lastCommand = cmd;
      updateInfo();
      if (cmd === 'clear') { clearBlocks(); return; }
      const parts = cmd.split(/\s*&&\s*/).map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        const res = execOne(part);
        if (!res) continue;
        if (res.interactive) {
          const kind = res.interactive.kind;
          renderBlock(part, [dimLine(kind === 'vi' ? '（进入 vi 编辑器，输入 :q 回车退出）' : '（进入 tail 实时日志，按 Ctrl+C 退出）')]);
          enterInteractive(kind, res.interactive.file, part);
          return;
        }
        renderBlock(part, res.lines);
      }
      scrollBottom();
    }

    /* ---------- 交互模式（vi / tail） ---------- */
    function enterInteractive(kind, file, command) {
      state.mode = 'interactive';
      state.viBuffer = '';
      const it = { kind, command, file, timer: null, lines: null, fileLines: null };
      state.interactive = it;
      termScroll.style.display = 'none';
      io.style.display = 'none';
      hint.style.display = 'flex';
      hintCmd.textContent = '';
      input.blur(); // 确保键盘监听不被自身隐藏的输入框挡住焦点
      if (kind === 'vi') buildViView(it);
      else buildTailView(it);
      document.addEventListener('keydown', onInteractiveKey);
    }

    function buildViView(it) {
      const view = document.createElement('div');
      view.className = 'term-vi';
      const fileLines = viContent(it.file);
      it.fileLines = fileLines;
      const head = document.createElement('div');
      head.className = 'term-vi-head';
      head.textContent = '"' + it.file + '"' + '  ' + fileLines.length + 'L, ' + fileLines.join('').length + 'B';
      const vbody = document.createElement('div');
      vbody.className = 'term-vi-body';
      fileLines.forEach((l, i) => {
        const row = document.createElement('div');
        row.className = 'term-vi-line';
        const n = document.createElement('span');
        n.className = 'ln';
        n.textContent = String(i + 1);
        const t = document.createElement('span');
        t.textContent = l || '\u00A0';
        row.append(n, t);
        vbody.appendChild(row);
      });
      const status = document.createElement('div');
      status.className = 'term-vi-status';
      status.textContent = '-- INSERT --';
      view.append(head, vbody, status);
      body.appendChild(view);
    }

    function buildTailView(it) {
      const view = document.createElement('div');
      view.className = 'term-tail';
      const head = document.createElement('div');
      head.className = 'term-tail-head';
      const l = document.createElement('span');
      l.textContent = '跟随日志: ' + it.file;
      const r = document.createElement('span');
      r.textContent = 'Ctrl+C 退出';
      r.style.color = C.dim;
      head.append(l, r);
      const lines = document.createElement('div');
      lines.className = 'term-tail-lines';
      view.append(head, lines);
      body.appendChild(view);

      it.lines = [];
      for (let i = 0; i < 4; i++) {
        const ln = nextLogLine();
        it.lines.push(ln);
        lines.appendChild(richLine([{ t: ln.text, c: ln.color }]));
      }
      it.timer = setInterval(() => {
        if (!container.isConnected || state.interactive !== it) { clearInterval(it.timer); it.timer = null; return; }
        const ln = nextLogLine();
        it.lines.push(ln);
        if (it.lines.length > 300) it.lines.shift();
        const el = richLine([{ t: ln.text, c: ln.color }]);
        lines.appendChild(el);
        while (lines.childNodes.length > 300) lines.removeChild(lines.firstChild);
        lines.scrollTop = lines.scrollHeight;
      }, 1500);
    }

    function onInteractiveKey(e) {
      const active = Workbench.getActiveTab();
      if (!active || active.id !== tab.id) return;
      const it = state.interactive;
      if (!it) return;
      const ae = document.activeElement;
      const typingElsewhere = ae && ae !== input && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
      if (it.kind === 'vi') {
        if (typingElsewhere) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (state.viBuffer === ':q') { exitInteractive(); return; }
          if (state.viBuffer) hintCmd.textContent = '';
          state.viBuffer = '';
        } else if (e.key === 'Backspace') {
          state.viBuffer = state.viBuffer.slice(0, -1);
          updateViCmd();
        } else if (e.key === 'Escape') {
          state.viBuffer = '';
          updateViCmd();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (state.viBuffer.length < 64) state.viBuffer += e.key;
          updateViCmd();
        }
      } else if (it.kind === 'tail') {
        if (typingElsewhere) return;
        if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
          e.preventDefault();
          exitInteractive();
        }
      }
    }
    function updateViCmd() {
      const typed = state.viBuffer.startsWith(':') ? state.viBuffer.slice(1) : state.viBuffer;
      hintCmd.textContent = state.viBuffer ? ':' + typed : '';
    }

    function exitInteractive() {
      const it = state.interactive;
      if (!it) return;
      if (it.timer) { clearInterval(it.timer); it.timer = null; }
      document.removeEventListener('keydown', onInteractiveKey);
      state.mode = 'normal';
      state.interactive = null;
      state.viBuffer = '';
      const view = body.querySelector('.term-vi, .term-tail');
      if (view) view.remove();
      termScroll.style.display = '';
      io.style.display = '';
      hint.style.display = 'none';
      hintCmd.textContent = '';
      const block = lastBlock();
      if (block) {
        const out = block.querySelector('.term-block-out');
        if (out) out.appendChild(dimLine(it.kind === 'vi' ? ':q  (已退出 vi 编辑器)' : '^C  (已停止 ' + it.command + ')'));
      }
      input.focus();
      scrollBottom();
    }

    /* ---------- 快照与 AI 对接 ---------- */
    function makeSnap(command, content) {
      return { id: AIShell.uid('snap'), command, content, ts: Date.now() };
    }
    function sendToAI(snap) {
      if (Workbench.ai && typeof Workbench.ai.addSnapshot === 'function') {
        Workbench.ai.addSnapshot(snap);
        AIShell.toast('已添加到 AI 对话', 'success');
      } else {
        AIShell.toast('AI 面板未就绪');
      }
    }
    function addLastToAI() { sendToAI(takeSnapshot()); }
    function addBlockToAI(block, cmd) {
      sendToAI(makeSnap(cmd, block.textContent.replace(/\n\s*\n+/g, '\n').trim()));
    }
    function takeSnapshot() {
      const it = state.interactive;
      if (it) {
        const content = it.kind === 'vi' ? (it.fileLines || []).join('\n') : (it.lines || []).join('\n');
        return makeSnap(it.command, content);
      }
      const block = lastBlock();
      return makeSnap(state.lastCommand || '', block ? block.textContent.replace(/\n\s*\n+/g, '\n').trim() : '');
    }

    /* ---------- 外部 api ---------- */
    function paste(cmd) {
      if (state.mode !== 'normal') return;
      input.value = String(cmd || '');
      input.focus();
    }
    function execute(cmd) {
      const active = Workbench.getActiveTab();
      if (!active || active.id !== tab.id) Workbench.activateTab(tab.id);
      if (state.mode !== 'normal') return;
      input.value = String(cmd || '');
      runCommand(cmd);
    }

    /* ---------- 输入行事件 ---------- */
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        runCommand(input.value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (histIdx === -1) histIdx = state.history.length;
        histIdx = Math.max(0, histIdx - 1);
        input.value = state.history[histIdx] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        histIdx = Math.min(state.history.length, histIdx + 1);
        input.value = histIdx >= state.history.length ? '' : (state.history[histIdx] || '');
      } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        input.value = '';
      }
    });
    input.addEventListener('input', () => { if (histIdx !== -1) histIdx = -1; });
    termScroll.addEventListener('click', () => { if (state.mode === 'normal') input.focus(); });

    /* ---------- 总线：激活聚焦 / 关闭清理 ---------- */
    Workbench.bus.on('tab-activated', (t) => {
      if (t && t.id === tab.id && state.mode === 'normal') input.focus();
    });
    Workbench.bus.on('tab-closed', (t) => {
      if (t.id !== tab.id) return;
      if (state.interactive && state.interactive.timer) clearInterval(state.interactive.timer);
      document.removeEventListener('keydown', onInteractiveKey);
    });

    /* ---------- 初始化 ---------- */
    printBanner();
    updateInfo();
    scrollBottom();

    return { paste, execute, takeSnapshot };
  });
})();
