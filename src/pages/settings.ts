/**
 * 系统设置页 —— 移植自 .proto/settings.js + settings.html 的系统设置部分。
 * 差异：数据源为 Tauri 后端（get_state / save_settings / set_theme）；
 * 密码与 apiKey 表单留空提交 null（后端保持原值），显示位不打回明文；
 * 浏览按钮走 @tauri-apps/plugin-dialog。
 * 历史说明：原「服务器配置」面板（服务器卡片/搜索/分组/拖拽/模态/从 Xshell 导入）已随
 * 项目-服务器单维度重构移除；xshell 导入已移至欢迎页按目录自动建项目，服务器在项目语义下管理。
 */
import type { AppState, LlmConfig, Settings, Theme } from '../types';
import { cloudStatus, getState, onCloudChanged, openDialog, saveSettings, setTheme } from '../api';
import { toast } from '../ui';
import { icon } from '../icons';
import { openUrl } from '@tauri-apps/plugin-opener';
import { applyTheme, currentTheme, onThemeChange } from '../theme';
import type { PageRender } from '../main';
import './settings.css';

/** 极简 HTML 转义（模型名回显防注入） */
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

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
            <div class="hint" id="cloud-hosted-llm-note" hidden>托管模式下模型与密钥由公司服务器统一管理（<a href="#/account">前往账号页</a>）</div>
            <div class="field" id="llm-model-field">
              <label>模型 ID</label>
              <input id="f-model-id" class="input" placeholder="deepseek-v4-flash">
            </div>
            <div class="field" id="llm-base-field">
              <label>Base URL</label>
              <input id="f-base-url" class="input mono" placeholder="https://api.deepseek.com/v1">
            </div>
            <div class="field" id="llm-key-field">
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
            <div class="hint" id="cloud-hosted-search-note" hidden>搜索由公司服务器代理，本地无需配置 Brave Key</div>
            <div class="field">
              <label>启用 AI 联网搜索</label>
              <input id="f-search-enabled" type="checkbox">
              <div class="hint">启用后 AI 助手可通过 Brave Search 获取最新信息（问时效性问题时自动使用）</div>
            </div>
            <div class="field" id="search-key-field">
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
  let fModelId = root.querySelector('#f-model-id') as HTMLInputElement | HTMLSelectElement;
  const fBaseUrl = root.querySelector('#f-base-url') as HTMLInputElement;
  const fApiKey = root.querySelector('#f-api-key') as HTMLInputElement;
  const fEffort = root.querySelector('#f-effort') as HTMLSelectElement;
  const fSearchEnabled = root.querySelector('#f-search-enabled') as HTMLInputElement;
  const fBraveKey = root.querySelector('#f-brave-key') as HTMLInputElement;
  const fAiWorkdir = root.querySelector('#f-ai-workdir') as HTMLInputElement;
  const fApprovalMode = root.querySelector('#f-approval-mode') as HTMLSelectElement;
  /* 托管模式形态（CR-2.2）：模型下拉 / 只读说明的切换开关 */
  let cloudMode: 'hosted' | 'personal' = 'personal';
  let cloudModels: string[] = [];

  /* ---------- 状态 ---------- */
  let db: AppState = {
    settings: { workspaceDir: null, llm: { modelId: '', baseUrl: '', effort: 'low' }, search: { enabled: false }, theme: 'dark', autoSwitchAiWorkdir: true, projectView: 'card', approvalMode: 'smart', cloud: { mode: 'personal', user: null, capabilities: null } },
    servers: [], projects: [], sessions: {}, projectFolders: [], commandFolders: [], uiExpanded: {}, sftpHistory: {}, sftpFavorites: {}, dbConnections: {},
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
    applyCloudMode();
    fModelId.value = s.llm.modelId || '';
    fBaseUrl.value = s.llm.baseUrl || '';
    fApiKey.value = ''; // 已保存的 key 永不回传，留空 = 不修改
    fEffort.value = s.llm.effort || 'low';
    fSearchEnabled.checked = s.search?.enabled ?? false;
    fBraveKey.value = ''; // 同上：Brave key 永不回传
    fAiWorkdir.checked = s.autoSwitchAiWorkdir ?? true;
    fApprovalMode.value = s.approvalMode ?? 'smart';
  }

  /* 托管模式（CR-2.2）：LLM 的 baseUrl/API Key 与 Brave Key 输入隐藏、展示只读说明；
     模型 ID 输入框换成服务端能力下拉（仍写回 llm.modelId）；搜索开关以服务端能力为准。 */
  function applyCloudMode() {
    const hosted = cloudMode === 'hosted';
    const llmNote = root.querySelector('#cloud-hosted-llm-note') as HTMLElement;
    const searchNote = root.querySelector('#cloud-hosted-search-note') as HTMLElement;
    const llmBase = root.querySelector('#llm-base-field') as HTMLElement;
    const llmKey = root.querySelector('#llm-key-field') as HTMLElement;
    const searchKey = root.querySelector('#search-key-field') as HTMLElement;
    const modelField = root.querySelector('#llm-model-field') as HTMLElement;
    llmNote.hidden = !hosted;
    searchNote.hidden = !hosted;
    llmBase.hidden = hosted;
    llmKey.hidden = hosted;
    searchKey.hidden = hosted;
    fSearchEnabled.disabled = hosted;
    if (hosted && cloudModels.length > 0) {
      // 模型下拉：以服务端能力为准，选择值仍写入 llm.modelId
      const opts = cloudModels.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      modelField.innerHTML = `<label>模型 ID</label><select id="f-model-id" class="select">${opts}</select>`;
      const sel = modelField.querySelector('#f-model-id') as HTMLSelectElement;
      if (db.settings.llm.modelId && cloudModels.includes(db.settings.llm.modelId)) sel.value = db.settings.llm.modelId;
      fModelId = sel;
    } else if (!hosted) {
      // 回个人模式：还原输入框（值由 loadSystemSettings 后续填充）
      modelField.innerHTML = '<label>模型 ID</label><input id="f-model-id" class="input" placeholder="deepseek-v4-flash">';
      fModelId = modelField.querySelector('#f-model-id') as HTMLInputElement;
    }
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
    const hosted = cloudMode === 'hosted';
    const llm: LlmConfig = {
      modelId: fModelId.value.trim(),
      /* 托管模式：baseUrl 由服务器接管（后续阶段 ai.rs 重写），此处保持原值不覆盖 */
      baseUrl: hosted ? (db.settings.llm.baseUrl || '') : fBaseUrl.value.trim(),
      effort: fEffort.value as LlmConfig['effort'],
    };
    /* 托管模式：密钥输入区隐藏，不修改 keyring（传 null） */
    const apiKey = hosted ? null : (fApiKey.value.trim() || null);
    const braveKey = hosted ? null : (fBraveKey.value.trim() || null);
    /* theme 带内存当前值:避免本页打开期间顶栏切换的主题被表单旧值覆盖;
       projectView 由欢迎页视图切换维护,本页保存时原样保留 */
    const settings: Settings = {
      workspaceDir, llm, search: { enabled: hosted ? (db.settings.search?.enabled ?? false) : fSearchEnabled.checked }, theme: currentTheme(),
      autoSwitchAiWorkdir: fAiWorkdir.checked, projectView: db.settings.projectView ?? 'card',
      approvalMode: fApprovalMode.value as Settings['approvalMode'],
      cloud: db.settings.cloud ?? { mode: 'personal', user: null, capabilities: null },
    };
    try {
      await saveSettings(settings, apiKey, braveKey);
      db.settings = settings;
      toast('设置已保存', 'success');
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

  /* 托管/个人模式（CR-2.2）：账号页切换后本页表单形态即时刷新 */
  const applyCloudStatus = (s: { mode: 'hosted' | 'personal'; capabilities: { models: string[] } | null }) => {
    cloudMode = s.mode;
    cloudModels = s.capabilities?.models ?? [];
    loadSystemSettings();
  };
  void cloudStatus().then(applyCloudStatus).catch(() => {});
  const offCloudSettings = onCloudChanged(applyCloudStatus).catch(() => () => {});

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
    void offCloudSettings.then((un) => un()).catch(() => {});
  };
};
