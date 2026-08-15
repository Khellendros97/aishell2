/**
 * 系统设置页 —— 移植自 .proto/settings.js + settings.html 的系统设置部分。
 * 差异：数据源为 Tauri 后端（get_state / save_settings / set_theme）；
 * 密码与 apiKey 表单留空提交 null（后端保持原值），显示位不打回明文；
 * 浏览按钮走 @tauri-apps/plugin-dialog。
 * 历史说明：原「服务器配置」面板（服务器卡片/搜索/分组/拖拽/模态/从 Xshell 导入）已随
 * 项目-服务器单维度重构移除；xshell 导入已移至欢迎页按目录自动建项目，服务器在项目语义下管理。
 */
import type { AppState, LlmConfig, Settings, Theme } from '../types';
import { getMcpStatus, getState, openDialog, saveSettings, setMcpPort, setTheme } from '../api';
import { toast } from '../ui';
import { icon } from '../icons';
import { openUrl } from '@tauri-apps/plugin-opener';
import { applyTheme, currentTheme, onThemeChange } from '../theme';
import type { PageRender } from '../main';
import './settings.css';

export const renderSettings: PageRender = (root, params) => {
  root.classList.add('settings-page');

  /* ---------- 页面骨架 ---------- */
  root.insertAdjacentHTML('beforeend', `
    <div id="warn-banner">${icon('alert')} 缺少必要配置，请先完成系统设置</div>
    <div id="settings-layout">
      <main id="settings-content">
        <section id="panel-system" class="settings-panel">
          <div class="panel-head"><div class="panel-title">系统设置</div></div>
          <div class="field">
            <label>界面主题</label>
            <select id="f-theme" class="select">
              <option value="dark">深色</option>
              <option value="light">亮色</option>
            </select>
            <div class="hint">选择后立即生效；顶栏 ☀/☾ 按钮亦可快捷切换</div>
          </div>
          <div class="field">
            <label>Workspace 目录<span class="req">*</span></label>
            <div class="input-row">
              <input id="f-workspace" class="input mono" placeholder="D:\\AIShellWorkspace">
              <button id="btn-browse-ws" class="btn small">浏览…</button>
            </div>
            <div class="hint">项目默认创建目录</div>
          </div>
          <fieldset class="llm-group">
            <legend>大模型配置</legend>
            <div class="field">
              <label>模型 ID</label>
              <input id="f-model-id" class="input" placeholder="deepseek-v4-flash">
            </div>
            <div class="field">
              <label>Base URL</label>
              <input id="f-base-url" class="input mono" placeholder="https://api.deepseek.com/v1">
            </div>
            <div class="field">
              <label>API Key</label>
              <div class="input-row">
                <input id="f-api-key" class="input mono" type="password" placeholder="已保存则不显示，留空表示不修改">
                <button id="btn-toggle-key" class="icon-btn" title="显示 / 隐藏">${icon('eye')}</button>
              </div>
              <div class="hint">获取 API Key：<a href="https://platform.deepseek.com/api_keys" data-open-url="https://platform.deepseek.com/api_keys">platform.deepseek.com/api_keys</a></div>
            </div>
            <div class="field">
              <label>思考强度</label>
              <select id="f-effort" class="select">
                <option value="low">低</option>
                <option value="high">高</option>
                <option value="max">最高</option>
              </select>
            </div>
          </fieldset>
          <fieldset class="llm-group">
            <legend>联网搜索</legend>
            <div class="field">
              <label>启用 AI 联网搜索</label>
              <input id="f-search-enabled" type="checkbox">
              <div class="hint">启用后 AI 助手可通过 Brave Search 获取最新信息（问时效性问题时自动使用）</div>
            </div>
            <div class="field">
              <label>Brave Search API Key</label>
              <div class="input-row">
                <input id="f-brave-key" class="input mono" type="password" placeholder="已保存则不显示，留空表示不修改">
                <button id="btn-toggle-brave" class="icon-btn" title="显示 / 隐藏">${icon('eye')}</button>
              </div>
              <div class="hint">免费额度 2000 次/月，<a href="https://api-dashboard.search.brave.com/app/keys" data-open-url="https://api-dashboard.search.brave.com/app/keys">获取 Brave Search API Key</a></div>
            </div>
          </fieldset>
          <fieldset class="llm-group">
            <legend>AI 工作区域</legend>
            <div class="field">
              <label>自动切换 AI 工作区域</label>
              <input id="f-ai-workdir" type="checkbox">
              <div class="hint">开启后 AI 输入框显示固定工作区域标签（默认本地）：打开或切换到 SSH/本地终端时自动跟随；发送消息时把当前工作区域作为上下文提供给 AI 助手</div>
            </div>
          </fieldset>
          <fieldset class="llm-group">
            <legend>AI 审批</legend>
            <div class="field">
              <label>审批模式</label>
              <select id="f-approval-mode" class="select">
                <option value="smart">智能审批</option>
                <option value="all">全部审批</option>
              </select>
              <div class="hint">智能审批：AI 操作先由大模型判定，非危险操作（常规读写、查询、构建等）自动放行并展示「已智能放行」；删除、服务启停、格式化等危险操作仍需人工确认。全部审批：每次操作都需人工确认</div>
            </div>
          </fieldset>
          <fieldset class="llm-group">
            <legend>远程文件备份</legend>
            <div class="field">
              <label>自动备份远程文件</label>
              <input id="f-auto-backup" type="checkbox">
              <div class="hint">开启后，AI 会话第一次修改某个远程文件前自动保存原始快照（会话级暂存区）：同一会话后续修改不覆盖快照，可在 AI 对话区右键「打开文件暂存区」查看 diff、接受或还原。动态脚本/无法确定影响范围的命令无法保证完整备份，会提示后由你确认。关闭只停止新建快照，已有暂存仍可继续处理</div>
            </div>
          </fieldset>
          <fieldset class="llm-group">
            <legend>MCP 服务（外部 agent 工具接入）</legend>
            <div class="field">
              <label>监听端口</label>
              <input id="f-mcp-port" class="input mono" type="number" min="1024" max="65535" placeholder="8945">
              <div class="hint">仅监听本机回环 127.0.0.1，不对外网开放。每台服务器可在「服务器卡片 → 更多 → MCP」中单独启用并配置功能开关；启用后外部工具经 http://127.0.0.1:端口/mcp 接入（Bearer 令牌在服务器 MCP 设置中查看）</div>
            </div>
            <div class="field">
              <label>服务状态</label>
              <div id="mcp-status-line" class="mcp-status-line">加载中…</div>
            </div>
          </fieldset>
          <div class="form-actions">
            <button id="btn-save-system" class="btn primary">保存</button>
          </div>
        </section>
      </main>
    </div>
  `);

  /* ---------- 元素引用 ---------- */
  const warnBanner = root.querySelector('#warn-banner') as HTMLElement;
  const fTheme = root.querySelector('#f-theme') as HTMLSelectElement;
  const fWorkspace = root.querySelector('#f-workspace') as HTMLInputElement;
  const fModelId = root.querySelector('#f-model-id') as HTMLInputElement;
  const fBaseUrl = root.querySelector('#f-base-url') as HTMLInputElement;
  const fApiKey = root.querySelector('#f-api-key') as HTMLInputElement;
  const fEffort = root.querySelector('#f-effort') as HTMLSelectElement;
  const fSearchEnabled = root.querySelector('#f-search-enabled') as HTMLInputElement;
  const fBraveKey = root.querySelector('#f-brave-key') as HTMLInputElement;
  const fAiWorkdir = root.querySelector('#f-ai-workdir') as HTMLInputElement;
  const fApprovalMode = root.querySelector('#f-approval-mode') as HTMLSelectElement;
  const fAutoBackup = root.querySelector('#f-auto-backup') as HTMLInputElement;
  const fMcpPort = root.querySelector('#f-mcp-port') as HTMLInputElement;
  const mcpStatusLine = root.querySelector('#mcp-status-line') as HTMLElement;

  /** MCP 服务状态行：运行中/未运行/端口占用原因（与服务器 MCP 弹窗同源） */
  async function refreshMcpStatus(): Promise<void> {
    try {
      const st = await getMcpStatus();
      if (st.running) {
        mcpStatusLine.textContent = `运行中：127.0.0.1:${st.boundPort ?? st.port}（已启用设备 ${st.deviceCount} 台）`;
        mcpStatusLine.className = 'mcp-status-line ok';
      } else if (st.error) {
        mcpStatusLine.textContent = `启动失败：${st.error}`;
        mcpStatusLine.className = 'mcp-status-line err';
      } else {
        mcpStatusLine.textContent = '未运行（当前没有启用 MCP 的服务器；在服务器卡片「更多 → MCP」中启用后自动启动）';
        mcpStatusLine.className = 'mcp-status-line';
      }
    } catch (err) {
      mcpStatusLine.textContent = `无法获取状态：${String(err)}`;
      mcpStatusLine.className = 'mcp-status-line err';
    }
  }

  /* ---------- 状态 ---------- */
  let db: AppState = {
    settings: { workspaceDir: null, llm: { modelId: '', baseUrl: '', effort: 'low' }, search: { enabled: false }, theme: 'dark', autoSwitchAiWorkdir: true, projectView: 'card', approvalMode: 'smart', autoBackupRemoteFiles: true },
    servers: [], projects: [], sessions: {}, projectFolders: [], commandFolders: [], uiExpanded: {}, sftpHistory: {}, sftpFavorites: {}, dbConnections: {}, mcp: { port: 8945 }, mcpDevices: {}, seededSkillWorkspaces: [],
  };

  // reason=missing-config：顶部黄色提示条（同 .proto/settings.js）
  if (params.get('reason') === 'missing-config') warnBanner.classList.add('show');

  /* ============================================================
     系统设置
     ============================================================ */
  function loadSystemSettings() {
    const s = db.settings;
    /* 主题取内存当前值:顶栏即时切换后 db 缓存已过期,不能用 s.theme */
    fTheme.value = currentTheme();
    fWorkspace.value = s.workspaceDir || '';
    fModelId.value = s.llm.modelId || '';
    fBaseUrl.value = s.llm.baseUrl || '';
    fApiKey.value = ''; // 已保存的 key 永不回传，留空 = 不修改
    fEffort.value = s.llm.effort || 'low';
    fSearchEnabled.checked = s.search?.enabled ?? false;
    fBraveKey.value = ''; // 同上：Brave key 永不回传
    fAiWorkdir.checked = s.autoSwitchAiWorkdir ?? true;
    fApprovalMode.value = s.approvalMode ?? 'smart';
    fAutoBackup.checked = s.autoBackupRemoteFiles ?? true;
    fMcpPort.value = String(db.mcp?.port ?? 8945);
    void refreshMcpStatus();
  }

  // Workspace 浏览…：真实目录选择
  (root.querySelector('#btn-browse-ws') as HTMLElement).addEventListener('click', async () => {
    const path = await openDialog({ directory: true });
    if (path) fWorkspace.value = path;
  });

  // API Key 显隐切换
  const btnToggleKey = root.querySelector('#btn-toggle-key') as HTMLElement;
  btnToggleKey.addEventListener('click', () => {
    const visible = fApiKey.type === 'text';
    fApiKey.type = visible ? 'password' : 'text';
    btnToggleKey.innerHTML = visible ? icon('eye') : icon('eyeOff');
    btnToggleKey.title = visible ? '显示 / 隐藏' : '隐藏 / 显示';
  });

  // Brave API Key 显隐切换
  const btnToggleBrave = root.querySelector('#btn-toggle-brave') as HTMLElement;
  btnToggleBrave.addEventListener('click', () => {
    const visible = fBraveKey.type === 'text';
    fBraveKey.type = visible ? 'password' : 'text';
    btnToggleBrave.innerHTML = visible ? icon('eye') : icon('eyeOff');
    btnToggleBrave.title = visible ? '显示 / 隐藏' : '隐藏 / 显示';
  });

  // hint 链接：外部浏览器打开（webview 内点击导航会离开页面，必须拦截）
  root.querySelectorAll<HTMLElement>('a[data-open-url]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const url = el.dataset.openUrl;
      if (!url) return;
      void openUrl(url).catch((err) => toast(`无法打开链接: ${String(err)}`, 'error'));
    });
  });

  /* 主题选择即时生效(与顶栏按钮同语义),保存按钮不再负责主题 */
  fTheme.addEventListener('change', () => {
    const t = fTheme.value as Theme;
    applyTheme(t);
    setTheme(t).catch((err) => toast(`主题保存失败: ${String(err)}`, 'error'));
  });
  /* 顶栏切换时同步 select 显示(仅在本页存活期) */
  const offTheme = onThemeChange((t) => { fTheme.value = t; });

  (root.querySelector('#btn-save-system') as HTMLElement).addEventListener('click', () => void saveSystemSettings());

  async function saveSystemSettings() {
    const workspaceDir = fWorkspace.value.trim();
    if (!workspaceDir) {
      toast('请填写 Workspace 目录', 'error');
      fWorkspace.focus();
      return;
    }
    /* MCP 端口独立保存（AppState.mcp 不在 Settings 里，避免整表单回传覆盖）；
       校验与后端一致：1024–65535 */
    const mcpPort = Number(fMcpPort.value);
    if (!Number.isInteger(mcpPort) || mcpPort < 1024 || mcpPort > 65535) {
      toast('MCP 端口必须在 1024–65535 之间', 'error');
      fMcpPort.focus();
      return;
    }
    const llm: LlmConfig = {
      modelId: fModelId.value.trim(),
      baseUrl: fBaseUrl.value.trim(),
      effort: fEffort.value as LlmConfig['effort'],
    };
    const apiKey = fApiKey.value.trim();
    const braveKey = fBraveKey.value.trim();
    /* theme 带内存当前值:避免本页打开期间顶栏切换的主题被表单旧值覆盖;
       projectView 由欢迎页视图切换维护,本页保存时原样保留 */
    const settings: Settings = {
      workspaceDir, llm, search: { enabled: fSearchEnabled.checked }, theme: currentTheme(),
      autoSwitchAiWorkdir: fAiWorkdir.checked, projectView: db.settings.projectView ?? 'card',
      approvalMode: fApprovalMode.value as Settings['approvalMode'],
      autoBackupRemoteFiles: fAutoBackup.checked,
    };
    try {
      await saveSettings(settings, apiKey || null, braveKey || null);
      await setMcpPort(mcpPort);
      db.settings = settings;
      toast('设置已保存', 'success');
      void refreshMcpStatus();
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  /* ---------- 初始化 ---------- */
  void getState()
    .then((s) => {
      db = s;
      loadSystemSettings();
    })
    .catch((err) => toast(String(err), 'error'));

  // 命令面板（Ctrl+T）等全局操作清空/变更数据后广播，此处重新拉取
  const onDataChanged = () => {
    void getState()
      .then((s) => { db = s; })
      .catch((err) => toast(String(err), 'error'));
  };
  window.addEventListener('aishell:data-changed', onDataChanged);

  return () => {
    window.removeEventListener('aishell:data-changed', onDataChanged);
    offTheme();
  };
};
