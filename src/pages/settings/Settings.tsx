/**
 * 系统设置页 —— React 版，逐行对照 legacy/pages/settings.ts（.proto/settings.js + settings.html 的系统设置部分）。
 * 数据源为 Tauri 后端：get_state / save_settings / set_theme / set_mcp_port / mcp_status（见 src/api.ts）；
 * 密码与 apiKey 表单留空提交 null（后端保持原值），显示位不打回明文；
 * 浏览按钮走 @tauri-apps/plugin-dialog（openDialog）；hint 外链经 @tauri-apps/plugin-opener 外部浏览器打开。
 * DOM id/class 与旧版一致，settings.css 直接复用；顶栏由 App.tsx 提供，本组件不渲染 Topbar。
 * 2026-08 起按用户要求新增左侧分类导航（功能特性/外观/快捷键/API 接口，SETTINGS_NAV 四页），
 * 字段状态共享一份 SysFields，三个可编辑页的保存按钮等价（整表单提交）；快捷键页只读，此布局无 proto 对照。
 * 历史说明：原「服务器配置」面板（服务器卡片/搜索/分组/拖拽/模态/从 Xshell 导入）已随
 * 项目-服务器单维度重构移除；xshell 导入已移至欢迎页按目录自动建项目，服务器在项目语义下管理。
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import type { AppState, LlmConfig, Settings as AppSettings, Theme } from '../../types';
import { CredentialsPanel } from './CredentialsPanel';
import { getMcpStatus, getState, openDialog, saveSettings, setMcpPort, setTheme } from '../../api';
import { toast } from '../../ui';
import { Icon } from '../../shared/Icon';
import type { IconName } from '../../icons';
import { openUrl } from '@tauri-apps/plugin-opener';
import { applyTheme, currentTheme, onThemeChange } from '../../theme';
import '../settings.css';

/** 表单字段（与旧版 f-* 元素一一对应；apiKey / braveKey 只存本次输入，加载时恒为空串） */
interface SysFields {
  theme: Theme;
  workspace: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  effort: LlmConfig['effort'];
  searchEnabled: boolean;
  braveKey: string;
  aiWorkdir: boolean;
  approvalMode: AppSettings['approvalMode'];
  autoBackup: boolean;
  mcpPort: string;
}

/** 表单初始值 = getState 前的空态（同旧版元素默认值：勾选框未勾、端口空显 placeholder），装载后由后端覆盖 */
const EMPTY_FIELDS: SysFields = {
  theme: 'dark', workspace: '', modelId: '', baseUrl: '', apiKey: '',
  effort: 'low', searchEnabled: false, braveKey: '', aiWorkdir: false,
  approvalMode: 'smart', autoBackup: false, mcpPort: '',
};

/** MCP 服务状态行（与旧版 refreshMcpStatus 三种形态对应，见 settings.css .mcp-status-line） */
interface McpStatusLine {
  text: string;
  cls: string;
}

/** 左侧导航分类：MCP 是 AIShell 作为服务端供外部工具接入，归功能特性；快捷键页只读。 */
type SettingsPage = 'features' | 'appearance' | 'shortcuts' | 'api' | 'credentials';

const SETTINGS_NAV: { id: SettingsPage; label: string; icon: IconName }[] = [
  { id: 'features', label: '功能特性', icon: 'zap' },
  { id: 'credentials', label: '凭据库', icon: 'key' },
  { id: 'appearance', label: '外观', icon: 'monitor' },
  { id: 'shortcuts', label: '快捷键', icon: 'key' },
  { id: 'api', label: 'API 接口', icon: 'plug' },
];

interface ShortcutItem {
  action: string;
  keys: string[];
  detail?: string;
}

interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

/** 仅列 AIShell 明确实现的快捷操作，不展开输入框、网页、CodeMirror 或 Shell 自身的通用默认键。 */
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '全局',
    items: [
      { action: '打开或收起命令面板', keys: ['Ctrl+T', 'Ctrl+P'] },
      { action: '打开开发者工具', keys: ['F12'] },
      { action: '关闭当前菜单、弹层或对话框', keys: ['Esc'], detail: '仅在相应界面打开时生效' },
    ],
  },
  {
    title: '终端',
    items: [
      { action: '复制终端选区', keys: ['Ctrl+Shift+C'] },
      { action: '粘贴到终端', keys: ['Ctrl+Shift+V'] },
      { action: '有选区时复制，无选区时粘贴', keys: ['鼠标中键'], detail: 'vim、tmux 等接管鼠标时以终端程序行为为准' },
    ],
  },
  {
    title: '文档编辑器与笔记',
    items: [
      { action: '保存当前文档或笔记', keys: ['Ctrl+S'] },
      { action: '将文档选区添加到 AI 对话', keys: ['Ctrl+L'], detail: '仅文档编辑器' },
      { action: '查找 / 替换', keys: ['Ctrl+F', 'Ctrl+H'], detail: '仅文档编辑器' },
      { action: '查找下一个 / 上一个 / 关闭查找栏', keys: ['Enter', 'Shift+Enter', 'Esc'], detail: '焦点位于查找栏时' },
      { action: '有选区时复制，无选区时粘贴到点击位置', keys: ['鼠标中键'], detail: '仅文档编辑器' },
    ],
  },
  {
    title: 'AI 对话',
    items: [
      { action: '发送消息 / 输入换行', keys: ['Enter', 'Shift+Enter'], detail: '焦点位于 AI 输入框时' },
      { action: '复制选中文字', keys: ['Ctrl+C'], detail: '输入框为空且当前工作标签为终端时，会向终端发送中断信号' },
      { action: '移动补全项', keys: ['↑', '↓'], detail: '@ 补全列表打开时' },
      { action: '选中补全项', keys: ['Enter', 'Tab'], detail: '@ 补全列表打开时' },
      { action: '关闭补全列表', keys: ['Esc'], detail: '@ 补全列表打开时' },
      { action: '复制选中文字，或粘贴到 AI 输入框', keys: ['鼠标中键'] },
    ],
  },
  {
    title: '本地文件管理器与 SFTP',
    items: [
      { action: '复制 / 剪切 / 粘贴', keys: ['Ctrl+C', 'Ctrl+X', 'Ctrl+V'], detail: '文件管理区域激活且未在输入时' },
      { action: '重命名 / 删除', keys: ['F2', 'Delete'], detail: '选中文件或目录后' },
      { action: '确认 / 取消行内输入', keys: ['Enter', 'Esc'], detail: '新建或重命名时' },
    ],
  },
  {
    title: '内置浏览器',
    items: [
      { action: '导航到输入地址', keys: ['Enter'], detail: '焦点位于地址栏时' },
      { action: '退出网页元素检查', keys: ['Esc'], detail: '元素检查模式开启时' },
      { action: '缩放网页', keys: ['Ctrl+鼠标滚轮'] },
    ],
  },
  {
    title: '其他操作',
    items: [
      { action: '保存命令收藏或技能', keys: ['Ctrl+Enter'], detail: '焦点位于对应的多行编辑框时' },
      { action: '微调侧栏或 AI 面板宽度', keys: ['←', '→'], detail: '先聚焦工作台分隔条，每次调整 16 像素' },
    ],
  },
];

export function Settings({ params }: { params: URLSearchParams }): JSX.Element {
  /* 后端状态快照（get_state / aishell:data-changed 刷新）；表单字段独立于它：
     刷新只更新快照不覆盖用户正在编辑的输入（同旧版 onDataChanged 语义） */
  const dbRef = useRef<AppState | null>(null);
  const workspaceRef = useRef<HTMLInputElement>(null);
  const mcpPortRef = useRef<HTMLInputElement>(null);

  const [fields, setFields] = useState<SysFields>(EMPTY_FIELDS);
  const [appState, setAppState] = useState<AppState | null>(null);
  const [page, setPage] = useState<SettingsPage>('features');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [braveKeyVisible, setBraveKeyVisible] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatusLine>({ text: '加载中…', cls: 'mcp-status-line' });

  /* reason=missing-config：顶部黄色提示条（同 .proto/settings.js） */
  const warnShown = params.get('reason') === 'missing-config';

  /** MCP 服务状态行：运行中/未运行/端口占用原因（与服务器 MCP 弹窗同源） */
  const refreshMcpStatus = async (): Promise<void> => {
    try {
      const st = await getMcpStatus();
      if (st.running) {
        setMcpStatus({ text: `运行中：127.0.0.1:${st.boundPort ?? st.port}（已启用设备 ${st.deviceCount} 台）`, cls: 'mcp-status-line ok' });
      } else if (st.error) {
        setMcpStatus({ text: `启动失败：${st.error}`, cls: 'mcp-status-line err' });
      } else {
        setMcpStatus({ text: '未运行（当前没有启用 MCP 的服务器；在服务器卡片「更多 → MCP」中启用后自动启动）', cls: 'mcp-status-line' });
      }
    } catch (err) {
      setMcpStatus({ text: `无法获取状态：${String(err)}`, cls: 'mcp-status-line err' });
    }
  };

  /** 装载后端状态到表单（同旧版 loadSystemSettings；主题取内存当前值:顶栏即时切换后 db 缓存已过期） */
  const applyState = (s: AppState): void => {
    dbRef.current = s;
    setAppState(s);
    setFields({
      theme: currentTheme(),
      workspace: s.settings.workspaceDir || '',
      modelId: s.settings.llm.modelId || '',
      baseUrl: s.settings.llm.baseUrl || '',
      apiKey: '', // 已保存的 key 永不回传，留空 = 不修改
      effort: s.settings.llm.effort || 'low',
      searchEnabled: s.settings.search?.enabled ?? false,
      braveKey: '', // 同上：Brave key 永不回传
      aiWorkdir: s.settings.autoSwitchAiWorkdir ?? true,
      approvalMode: s.settings.approvalMode ?? 'smart',
      autoBackup: s.settings.autoBackupRemoteFiles ?? true,
      mcpPort: String(s.mcp?.port ?? 8945),
    });
    void refreshMcpStatus();
  };

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    let cancelled = false;
    void getState()
      .then((s) => { if (!cancelled) applyState(s); })
      .catch((err) => { if (!cancelled) toast(String(err), 'error'); });
    return () => { cancelled = true; };
    // eslint 语义同旧版一次性初始化：applyState 仅依赖稳定 setter
  }, []);

  /* 命令面板（Ctrl+T）等全局操作清空/变更数据后广播，此处重新拉取（同旧版 onDataChanged） */
  useEffect(() => {
    const onDataChanged = (): void => {
      void getState()
        .then((s) => { dbRef.current = s; setAppState(s); })
        .catch((err) => toast(String(err), 'error'));
    };
    window.addEventListener('aishell:data-changed', onDataChanged);
    return () => window.removeEventListener('aishell:data-changed', onDataChanged);
  }, []);

  /* 顶栏切换主题时同步 select 显示（仅在本页存活期；cleanup 退订） */
  useEffect(() => {
    const offTheme = onThemeChange((t) => setFields((f) => ({ ...f, theme: t })));
    return offTheme;
  }, []);

  /* Workspace 浏览…：真实目录选择 */
  const browseWorkspace = async (): Promise<void> => {
    const path = await openDialog({ directory: true });
    if (typeof path === 'string' && path) setFields((f) => ({ ...f, workspace: path }));
  };

  /* hint 链接：外部浏览器打开（webview 内点击导航会离开页面，必须拦截） */
  const onOpenUrl = (e: MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault();
    const url = e.currentTarget.dataset.openUrl;
    if (!url) return;
    void openUrl(url).catch((err) => toast(`无法打开链接: ${String(err)}`, 'error'));
  };

  /* 主题选择即时生效（与顶栏按钮同语义），保存按钮不再负责主题 */
  const onThemeSelect = (e: ChangeEvent<HTMLSelectElement>): void => {
    const t = e.currentTarget.value as Theme;
    applyTheme(t);
    setFields((f) => ({ ...f, theme: t }));
    setTheme(t).catch((err) => toast(`主题保存失败: ${String(err)}`, 'error'));
  };

  const save = async (): Promise<void> => {
    const workspaceDir = fields.workspace.trim();
    if (!workspaceDir) {
      toast('请填写 Workspace 目录', 'error');
      setPage('features');
      workspaceRef.current?.focus();
      return;
    }
    /* MCP 端口独立保存（AppState.mcp 不在 Settings 里，避免整表单回传覆盖）；
       校验与后端一致：1024–65535 */
    const mcpPort = Number(fields.mcpPort);
    if (!Number.isInteger(mcpPort) || mcpPort < 1024 || mcpPort > 65535) {
      toast('MCP 端口必须在 1024–65535 之间', 'error');
      setPage('features');
      mcpPortRef.current?.focus();
      return;
    }
    const llm: LlmConfig = {
      modelId: fields.modelId.trim(),
      baseUrl: fields.baseUrl.trim(),
      effort: fields.effort,
    };
    const apiKey = fields.apiKey.trim();
    const braveKey = fields.braveKey.trim();
    /* theme 带内存当前值:避免本页打开期间顶栏切换的主题被表单旧值覆盖;
       projectView 由欢迎页视图切换维护,本页保存时原样保留 */
    const settings: AppSettings = {
      workspaceDir, llm, search: { enabled: fields.searchEnabled }, theme: currentTheme(),
      autoSwitchAiWorkdir: fields.aiWorkdir, projectView: dbRef.current?.settings.projectView ?? 'card',
      approvalMode: fields.approvalMode,
      autoBackupRemoteFiles: fields.autoBackup,
    };
    try {
      await saveSettings(settings, apiKey || null, braveKey || null);
      await setMcpPort(mcpPort);
      if (dbRef.current) dbRef.current.settings = settings;
      toast('设置已保存', 'success');
      void refreshMcpStatus();
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  return (
    <div className="settings-page">
      <div id="warn-banner" className={warnShown ? 'show' : undefined}>
        <Icon name="alert" /> 缺少必要配置，请先完成系统设置
      </div>
      <div id="settings-layout">
        <nav id="settings-nav">
          {SETTINGS_NAV.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item${page === item.id ? ' active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              <Icon name={item.icon} /> {item.label}
            </button>
          ))}
        </nav>
        <main id="settings-content">
          {page === 'credentials' && (
            <CredentialsPanel initialState={appState} onChanged={(next) => { dbRef.current = next; setAppState(next); }} />
          )}
          {page === 'appearance' && (
          <section id="panel-appearance" className="settings-panel">
            <div className="panel-head"><div className="panel-title">外观</div></div>
            <div className="field">
              <label>界面主题</label>
              <select id="f-theme" className="select" value={fields.theme} onChange={onThemeSelect}>
                <option value="dark">深色</option>
                <option value="light">亮色</option>
              </select>
              <div className="hint">选择后立即生效；顶栏 ☀/☾ 按钮亦可快捷切换</div>
            </div>
            <div className="form-actions">
              <button id="btn-save-system" className="btn primary" onClick={() => void save()}>保存</button>
            </div>
          </section>
          )}
          {page === 'shortcuts' && (
          <section id="panel-shortcuts" className="settings-panel">
            <div className="panel-head"><div className="panel-title">快捷键</div></div>
            <div className="shortcuts-notice">
              <Icon name="info" />
              <div>
                <strong>当前仅提供快捷键说明</strong>
                <span>暂不支持修改快捷键。下列操作会根据当前焦点和所在界面生效。</span>
              </div>
            </div>
            <div className="shortcut-groups">
              {SHORTCUT_GROUPS.map((group) => (
                <section key={group.title} className="shortcut-group">
                  <h3>{group.title}</h3>
                  <div className="shortcut-list">
                    {group.items.map((item) => (
                      <div key={`${group.title}-${item.action}`} className="shortcut-row">
                        <div className="shortcut-description">
                          <span className="shortcut-action">{item.action}</span>
                          {item.detail && <span className="shortcut-detail">{item.detail}</span>}
                        </div>
                        <div className="shortcut-keys" aria-label={item.keys.join(' 或 ')}>
                          {item.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </section>
          )}
          {page === 'features' && (
          <section id="panel-features" className="settings-panel">
            <div className="panel-head"><div className="panel-title">功能特性</div></div>
            <div className="field">
              <label>Workspace 目录<span className="req">*</span></label>
              <div className="input-row">
                <input
                  id="f-workspace"
                  ref={workspaceRef}
                  className="input mono"
                  placeholder="D:\\AIShellWorkspace"
                  value={fields.workspace}
                  onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, workspace: v })); }}
                />
                <button id="btn-browse-ws" className="btn small" onClick={() => void browseWorkspace()}>浏览…</button>
              </div>
              <div className="hint">项目默认创建目录</div>
            </div>
            <fieldset className="llm-group">
              <legend>AI 工作区域</legend>
              <div className="field">
                <label>自动切换 AI 工作区域</label>
                <input
                  id="f-ai-workdir"
                  type="checkbox"
                  checked={fields.aiWorkdir}
                  onChange={(e) => { const checked = e.currentTarget.checked; setFields((f) => ({ ...f, aiWorkdir: checked })); }}
                />
                <div className="hint">开启后 AI 输入框显示固定工作区域标签（默认本地）：打开或切换到 SSH/本地终端时自动跟随；发送消息时把当前工作区域作为上下文提供给 AI 助手</div>
              </div>
            </fieldset>
            <fieldset className="llm-group">
              <legend>AI 审批</legend>
              <div className="field">
                <label>审批模式</label>
                <select
                  id="f-approval-mode"
                  className="select"
                  value={fields.approvalMode}
                  onChange={(e) => { const v = e.currentTarget.value as AppSettings['approvalMode']; setFields((f) => ({ ...f, approvalMode: v })); }}
                >
                  <option value="smart">智能审批</option>
                  <option value="all">全部审批</option>
                </select>
                <div className="hint">智能审批：AI 操作先由大模型判定，非危险操作（常规读写、查询、构建等）自动放行并展示「已智能放行」；删除、服务启停、格式化等危险操作仍需人工确认。全部审批：每次操作都需人工确认</div>
              </div>
            </fieldset>
            <fieldset className="llm-group">
              <legend>远程文件备份</legend>
              <div className="field">
                <label>自动备份远程文件</label>
                <input
                  id="f-auto-backup"
                  type="checkbox"
                  checked={fields.autoBackup}
                  onChange={(e) => { const checked = e.currentTarget.checked; setFields((f) => ({ ...f, autoBackup: checked })); }}
                />
                <div className="hint">开启后，AI 会话第一次修改某个远程文件前自动保存原始快照（会话级暂存区）：同一会话后续修改不覆盖快照，可在 AI 对话区右键「打开文件暂存区」查看 diff、接受或还原。动态脚本/无法确定影响范围的命令无法保证完整备份，会提示后由你确认。关闭只停止新建快照，已有暂存仍可继续处理</div>
              </div>
            </fieldset>
            <fieldset className="llm-group">
              <legend>MCP 服务（外部 agent 工具接入）</legend>
              <div className="field">
                <label>监听端口</label>
                <input
                  id="f-mcp-port"
                  ref={mcpPortRef}
                  className="input mono"
                  type="number"
                  min={1024}
                  max={65535}
                  placeholder="8945"
                  value={fields.mcpPort}
                  onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, mcpPort: v })); }}
                />
                <div className="hint">仅监听本机回环 127.0.0.1，不对外网开放。每台服务器可在「服务器卡片 → 更多 → MCP」中单独启用并配置功能开关；启用后外部工具经 http://127.0.0.1:端口/mcp 接入（Bearer 令牌在服务器 MCP 设置中查看）</div>
              </div>
              <div className="field">
                <label>服务状态</label>
                <div id="mcp-status-line" className={mcpStatus.cls}>{mcpStatus.text}</div>
              </div>
            </fieldset>
            <div className="form-actions">
              <button className="btn primary" onClick={() => void save()}>保存</button>
            </div>
          </section>
          )}
          {page === 'api' && (
          <section id="panel-api" className="settings-panel">
            <div className="panel-head"><div className="panel-title">API 接口</div></div>
            <fieldset className="llm-group">
              <legend>大模型配置</legend>
              <div className="field">
                <label>模型 ID</label>
                <input
                  id="f-model-id"
                  className="input"
                  placeholder="deepseek-v4-flash-vision-exp"
                  value={fields.modelId}
                  onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, modelId: v })); }}
                />
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  id="f-base-url"
                  className="input mono"
                  placeholder="https://api.deepseek.com/v1"
                  value={fields.baseUrl}
                  onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, baseUrl: v })); }}
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <div className="input-row">
                  <input
                    id="f-api-key"
                    className="input mono"
                    type={apiKeyVisible ? 'text' : 'password'}
                    placeholder="已保存则不显示，留空表示不修改"
                    value={fields.apiKey}
                    onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, apiKey: v })); }}
                  />
                  <button
                    id="btn-toggle-key"
                    className="icon-btn"
                    title={apiKeyVisible ? '显示 / 隐藏' : '隐藏 / 显示'}
                    onClick={() => setApiKeyVisible((v) => !v)}
                  >
                    <Icon name={apiKeyVisible ? 'eye' : 'eyeOff'} />
                  </button>
                </div>
                <div className="hint">
                  获取 API Key：<a href="https://platform.deepseek.com/api_keys" data-open-url="https://platform.deepseek.com/api_keys" onClick={onOpenUrl}>platform.deepseek.com/api_keys</a>
                </div>
              </div>
              <div className="field">
                <label>思考强度</label>
                <select
                  id="f-effort"
                  className="select"
                  value={fields.effort}
                  onChange={(e) => { const v = e.currentTarget.value as LlmConfig['effort']; setFields((f) => ({ ...f, effort: v })); }}
                >
                  <option value="low">低</option>
                  <option value="high">高</option>
                  <option value="max">最高</option>
                </select>
              </div>
            </fieldset>
            <fieldset className="llm-group">
              <legend>联网搜索</legend>
              <div className="field">
                <label>启用 AI 联网搜索</label>
                <input
                  id="f-search-enabled"
                  type="checkbox"
                  checked={fields.searchEnabled}
                  onChange={(e) => { const checked = e.currentTarget.checked; setFields((f) => ({ ...f, searchEnabled: checked })); }}
                />
                <div className="hint">启用后 AI 助手可通过 Brave Search 获取最新信息（问时效性问题时自动使用）</div>
              </div>
              <div className="field">
                <label>Brave Search API Key</label>
                <div className="input-row">
                  <input
                    id="f-brave-key"
                    className="input mono"
                    type={braveKeyVisible ? 'text' : 'password'}
                    placeholder="已保存则不显示，留空表示不修改"
                    value={fields.braveKey}
                    onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, braveKey: v })); }}
                  />
                  <button
                    id="btn-toggle-brave"
                    className="icon-btn"
                    title={braveKeyVisible ? '显示 / 隐藏' : '隐藏 / 显示'}
                    onClick={() => setBraveKeyVisible((v) => !v)}
                  >
                    <Icon name={braveKeyVisible ? 'eye' : 'eyeOff'} />
                  </button>
                </div>
                <div className="hint">
                  免费额度 2000 次/月，<a href="https://api-dashboard.search.brave.com/app/keys" data-open-url="https://api-dashboard.search.brave.com/app/keys" onClick={onOpenUrl}>获取 Brave Search API Key</a>
                </div>
              </div>
            </fieldset>
            <div className="form-actions">
              <button className="btn primary" onClick={() => void save()}>保存</button>
            </div>
          </section>
          )}
        </main>
      </div>
    </div>
  );
}
