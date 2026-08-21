/**
 * 系统设置页 —— React 版，逐行对照 legacy/pages/settings.ts（.proto/settings.js + settings.html 的系统设置部分）。
 * 数据源为 Tauri 后端：get_state / save_settings / set_theme / set_mcp_port / mcp_status（见 src/api.ts）；
 * 密码与 apiKey 表单留空提交 null（后端保持原值），显示位不打回明文；
 * 浏览按钮走 @tauri-apps/plugin-dialog（openDialog）；hint 外链经 @tauri-apps/plugin-opener 外部浏览器打开。
 * DOM id/class 与旧版一致，settings.css 直接复用；顶栏由 App.tsx 提供，本组件不渲染 Topbar。
 * 2026-08 起按用户要求新增左侧分类导航（外观/功能特性/API 接口，SETTINGS_NAV 三页），
 * 字段状态共享一份 SysFields，三页的保存按钮等价（整表单提交），此布局无 proto 对照。
 * 历史说明：原「服务器配置」面板（服务器卡片/搜索/分组/拖拽/模态/从 Xshell 导入）已随
 * 项目-服务器单维度重构移除；xshell 导入已移至欢迎页按目录自动建项目，服务器在项目语义下管理。
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import type { AppState, CloudMode, CloudStatus, LlmConfig, Settings as AppSettings, Theme, UpdateStatus } from '../../types';
import { cloudStatus, getMcpStatus, getState, onCloudChanged, openDialog, saveSettings, setMcpPort, setTheme, updateCheck, updateDownload, updateInstall } from '../../api';
import { navigate } from '../../router';
import { toast, confirmDialog } from '../../ui';
import { Icon } from '../../shared/Icon';
import type { IconName } from '../../icons';
import { openUrl } from '@tauri-apps/plugin-opener';
import { applyTheme, currentTheme, onThemeChange } from '../../theme';
import { onUpdateStatus } from '../../updates';
import { useWorkbench } from '../../stores/workbench';
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
  kbAutoInject: boolean;
  kbInjectCount: string;
}

/** 表单初始值 = getState 前的空态（同旧版元素默认值：勾选框未勾、端口空显 placeholder），装载后由后端覆盖 */
const EMPTY_FIELDS: SysFields = {
  theme: 'dark', workspace: '', modelId: '', baseUrl: '', apiKey: '',
  effort: 'low', searchEnabled: false, braveKey: '', aiWorkdir: false,
  approvalMode: 'smart', autoBackup: false, mcpPort: '',
  kbAutoInject: false, kbInjectCount: '5',
};

/** MCP 服务状态行（与旧版 refreshMcpStatus 三种形态对应，见 settings.css .mcp-status-line） */
interface McpStatusLine {
  text: string;
  cls: string;
}

/** 左侧导航分类：功能特性 / 外观 / API 接口 / 关于与更新（MCP 是 AIShell 作为服务端供外部工具接入，归功能特性） */
type SettingsPage = 'features' | 'appearance' | 'api' | 'about';

const SETTINGS_NAV: { id: SettingsPage; label: string; icon: IconName }[] = [
  { id: 'features', label: '功能特性', icon: 'zap' },
  { id: 'appearance', label: '外观', icon: 'monitor' },
  { id: 'api', label: 'API 接口', icon: 'plug' },
  { id: 'about', label: '关于与更新', icon: 'info' },
];

export function Settings({ params }: { params: URLSearchParams }): JSX.Element {
  /* 后端状态快照（get_state / aishell:data-changed 刷新）；表单字段独立于它：
     刷新只更新快照不覆盖用户正在编辑的输入（同旧版 onDataChanged 语义） */
  const dbRef = useRef<AppState | null>(null);
  const workspaceRef = useRef<HTMLInputElement>(null);
  const mcpPortRef = useRef<HTMLInputElement>(null);

  const [fields, setFields] = useState<SysFields>(EMPTY_FIELDS);
  const [page, setPage] = useState<SettingsPage>('features');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [braveKeyVisible, setBraveKeyVisible] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatusLine>({ text: '加载中…', cls: 'mcp-status-line' });
  /* 托管模式形态（CR-2.2）：模型下拉/只读说明的切换；登录/登出/模式切换后即时刷新 */
  const [cloudMode, setCloudMode] = useState<CloudMode>('personal');
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const hosted = cloudMode === 'hosted';
  /* 关于与更新：状态来自全局更新总线（Topbar 徽标同源，不重复检查） */
  const [upd, setUpd] = useState<UpdateStatus | null>(null);

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
      kbAutoInject: s.settings.knowledge?.autoInject ?? true,
      kbInjectCount: String(s.settings.knowledge?.injectCount ?? 5),
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
        .then((s) => { dbRef.current = s; })
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

  /* 更新状态总线订阅（已有快照立即回调；卸载退订） */
  useEffect(() => onUpdateStatus(setUpd), []);

  /* 托管/个人模式（CR-2.2）：账号页切换后本页表单形态即时刷新；
     同时刷新 dbRef（保存时 settings.cloud 原样带回，需最新值） */
  useEffect(() => {
    const applyCloudStatus = (s: CloudStatus): void => {
      setCloudMode(s.mode);
      setCloudModels(s.capabilities?.models ?? []);
      void getState().then((st) => { dbRef.current = st; }).catch(() => {});
    };
    let un: (() => void) | null = null;
    void cloudStatus().then(applyCloudStatus).catch(() => {});
    void onCloudChanged(applyCloudStatus).then((u) => { un = u; }).catch(() => {});
    return () => { un?.(); };
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
    /* 自动注入条数：1–20（与前端数字输入上下界、后端序列化一致） */
    const kbInjectCount = Number(fields.kbInjectCount);
    if (!Number.isInteger(kbInjectCount) || kbInjectCount < 1 || kbInjectCount > 20) {
      toast('自动注入条数必须在 1–20 之间', 'error');
      return;
    }
    const hosted = cloudMode === 'hosted';
    const llm: LlmConfig = {
      modelId: fields.modelId.trim(),
      /* 托管模式：baseUrl 由服务器接管，此处保持原值不覆盖 */
      baseUrl: hosted ? (dbRef.current?.settings.llm.baseUrl || '') : fields.baseUrl.trim(),
      effort: fields.effort,
    };
    /* 托管模式：密钥输入区隐藏，不修改 keyring（传 null） */
    const apiKey = hosted ? null : (fields.apiKey.trim() || null);
    const braveKey = hosted ? null : (fields.braveKey.trim() || null);
    /* theme 带内存当前值:避免本页打开期间顶栏切换的主题被表单旧值覆盖;
       projectView 由欢迎页视图切换维护,本页保存时原样保留;
       cloud 段原样带回（账号页/云状态管理，本表单不覆盖） */
    const settings: AppSettings = {
      workspaceDir, llm,
      search: { enabled: hosted ? (dbRef.current?.settings.search?.enabled ?? false) : fields.searchEnabled },
      theme: currentTheme(),
      autoSwitchAiWorkdir: fields.aiWorkdir, projectView: dbRef.current?.settings.projectView ?? 'card',
      approvalMode: fields.approvalMode,
      cloud: dbRef.current?.settings.cloud ?? { mode: 'personal', user: null, capabilities: null },
      autoBackupRemoteFiles: fields.autoBackup,
      knowledge: { autoInject: fields.kbAutoInject, injectCount: kbInjectCount },
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

  /* ---------- 关于与更新 ---------- */

  const fmtTime = (ms?: number | null): string => (ms ? new Date(ms).toLocaleString() : '');
  const fmtDate = (s?: string | null): string => {
    if (!s) return '';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
  };
  const fmtBytes = (n?: number | null): string =>
    typeof n === 'number' && n > 0 ? `${(n / 1048576).toFixed(1)} MB` : '';

  /** 检查结果行文案/配色（后端状态机的展示映射；错误信息后端已脱敏为中文） */
  const updResult = (): { text: string; cls: string } => {
    if (!upd) return { text: '加载中…', cls: 'mcp-status-line' };
    const checked = upd.lastCheckedAt ? `（${fmtTime(upd.lastCheckedAt)} 检查）` : '';
    switch (upd.state) {
      case 'idle': return { text: '尚未检查更新', cls: 'mcp-status-line' };
      case 'checking': return { text: '正在检查更新…', cls: 'mcp-status-line' };
      case 'error': return { text: `检查失败：${upd.error ?? '未知错误'}`, cls: 'mcp-status-line err' };
      case 'not_available': return { text: `已是最新版本${checked}`, cls: 'mcp-status-line ok' };
      case 'downloading': return { text: `正在下载 v${upd.availableVersion ?? ''}…`, cls: 'mcp-status-line' };
      case 'ready': return { text: `新版本 v${upd.availableVersion ?? ''} 已就绪，重启后生效`, cls: 'mcp-status-line ok' };
      case 'installing': return { text: '正在安装更新，应用即将退出…', cls: 'mcp-status-line' };
      case 'available': return upd.signatureMissing
        ? { text: `发现新版本 v${upd.availableVersion ?? ''}（该版本未提供更新签名，需手动下载安装）`, cls: 'mcp-status-line err' }
        : { text: `发现新版本 v${upd.availableVersion ?? ''}`, cls: 'mcp-status-line ok' };
    }
  };

  const doCheckUpdate = async (): Promise<void> => {
    try { await updateCheck(); } catch (err) { toast(String(err), 'error'); }
  };

  const doDownloadUpdate = async (): Promise<void> => {
    try { await updateDownload(); } catch (err) { toast(String(err), 'error'); }
  };

  /** 重启并更新：先确认活动任务风险（终端/SSH/SFTP 会话会被断开），再交后端安装重启 */
  const doInstallUpdate = async (): Promise<void> => {
    const tabs = useWorkbench.getState().tabs;
    const active = tabs.filter((t) => t.type === 'terminal' || t.type === 'sftp').length;
    const ok = await confirmDialog({
      title: '重启并更新',
      message: active > 0
        ? `更新将退出并重启应用，当前有 ${active} 个终端/SSH/SFTP 会话将被断开，未保存的编辑内容可能丢失。确定继续吗？`
        : '更新将退出并重启应用，未保存的编辑内容可能丢失。确定继续吗？',
      okText: '重启并更新',
    });
    if (!ok) return;
    // Windows 上安装器拉起后应用即退出，本调用不会返回；失败（如版本被撤回）reject 中文错误
    void updateInstall().catch((err) => toast(String(err), 'error'));
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
              {hosted ? (
                <div className="hint" id="cloud-hosted-llm-note">托管模式下模型与密钥由公司服务器统一管理（<a href="#/account" onClick={(e) => { e.preventDefault(); navigate('#/account'); }}>前往账号页</a>）</div>
              ) : null}
              <div className="field" id="llm-model-field">
                <label>模型 ID</label>
                {hosted && cloudModels.length > 0 ? (
                  /* 模型下拉：以服务端能力为准，选择值仍写入 llm.modelId */
                  <select
                    id="f-model-id"
                    className="select"
                    value={fields.modelId}
                    onChange={(e) => setFields((f) => ({ ...f, modelId: e.currentTarget.value }))}
                  >
                    {cloudModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    id="f-model-id"
                    className="input"
                    placeholder="deepseek-v4-flash"
                    value={fields.modelId}
                    onInput={(e) => setFields((f) => ({ ...f, modelId: e.currentTarget.value }))}
                  />
                )}
              </div>
              {!hosted ? (
                <>
                  <div className="field" id="llm-base-field">
                    <label>Base URL</label>
                    <input
                      id="f-base-url"
                      className="input mono"
                      placeholder="https://api.deepseek.com/v1"
                      value={fields.baseUrl}
                      onInput={(e) => setFields((f) => ({ ...f, baseUrl: e.currentTarget.value }))}
                    />
                  </div>
                  <div className="field" id="llm-key-field">
                    <label>API Key</label>
                    <div className="input-row">
                      <input
                        id="f-api-key"
                        className="input mono"
                        type={apiKeyVisible ? 'text' : 'password'}
                        placeholder="已保存则不显示，留空表示不修改"
                        value={fields.apiKey}
                        onInput={(e) => setFields((f) => ({ ...f, apiKey: e.currentTarget.value }))}
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
                </>
              ) : null}
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
                  disabled={hosted}
                  onChange={(e) => setFields((f) => ({ ...f, searchEnabled: e.currentTarget.checked }))}
                />
                <div className="hint">启用后 AI 助手可通过 Brave Search 获取最新信息（问时效性问题时自动使用）</div>
              </div>
              {hosted ? (
                <div className="hint" id="cloud-hosted-search-note">搜索由公司服务器代理，本地无需配置 Brave Key</div>
              ) : (
                <div className="field" id="search-key-field">
                  <label>Brave Search API Key</label>
                  <div className="input-row">
                    <input
                      id="f-brave-key"
                      className="input mono"
                      type={braveKeyVisible ? 'text' : 'password'}
                      placeholder="已保存则不显示，留空表示不修改"
                      value={fields.braveKey}
                      onInput={(e) => setFields((f) => ({ ...f, braveKey: e.currentTarget.value }))}
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
              )}
            </fieldset>
            <fieldset className="llm-group">
              <legend>知识库</legend>
              <div className="field">
                <label>开启知识库自动注入</label>
                <input
                  id="f-kb-auto-inject"
                  type="checkbox"
                  checked={fields.kbAutoInject}
                  onChange={(e) => { const checked = e.currentTarget.checked; setFields((f) => ({ ...f, kbAutoInject: checked })); }}
                />
                <div className="hint">开启自动注入会降低 AI 响应速度</div>
              </div>
              <div className="field">
                <label>自动注入条数</label>
                <input
                  id="f-kb-inject-count"
                  className="input mono"
                  type="number"
                  min={1}
                  max={20}
                  placeholder="5"
                  value={fields.kbInjectCount}
                  onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, kbInjectCount: v })); }}
                />
              </div>
              {hosted ? (
                <div className="hint">开启后发消息前自动检索企业知识库，把相关度最高的对应条数命中注入到 AI 上下文中；AI 助手亦可随时主动调用知识库检索工具</div>
              ) : (
                <div className="hint" id="cloud-hosted-kb-note">知识库由公司服务器提供，需登录云服务后使用</div>
              )}
            </fieldset>
            <div className="form-actions">
              <button className="btn primary" onClick={() => void save()}>保存</button>
            </div>
          </section>
          )}
          {page === 'about' && (
          <section id="panel-about" className="settings-panel">
            <div className="panel-head"><div className="panel-title">关于与更新</div></div>
            <div className="field">
              <label>当前版本</label>
              <div className="mcp-status-line" id="upd-current">
                AIShell v{upd?.currentVersion ?? '…'}（stable 频道）
              </div>
            </div>
            {!upd ? (
              <div className="field">
                <div className="mcp-status-line">正在获取更新状态…</div>
              </div>
            ) : !upd.enabled ? (
              <div className="field">
                <div className="mcp-status-line">当前构建未接入云服务更新（个人构建不检查更新）</div>
              </div>
            ) : (
              <>
                <div className="field">
                  <label>检查结果</label>
                  <div id="upd-result-line" className={updResult().cls}>{updResult().text}</div>
                </div>
                <div className="field">
                  <label>&nbsp;</label>
                  <button
                    id="btn-update-check"
                    className="btn small"
                    disabled={['checking', 'downloading', 'installing'].includes(upd?.state ?? 'idle')}
                    onClick={() => void doCheckUpdate()}
                  >检查更新</button>
                </div>
                {upd?.availableVersion ? (
                  <div className="upd-card">
                    <div className="upd-version">
                      v{upd.availableVersion}
                      {upd.publishedAt ? <span className="upd-date">{fmtDate(upd.publishedAt)} 发布</span> : null}
                      {upd.state === 'ready' && upd.progress ? <span className="upd-date">{fmtBytes(upd.progress.total ?? null)}</span> : null}
                    </div>
                    {upd.notes ? <pre className="upd-notes">{upd.notes}</pre> : null}
                    {upd.state === 'downloading' && upd.progress ? (
                      <div className="upd-progress">
                        <div className="bar">
                          <i style={{ width: upd.progress.total ? `${Math.min(100, (upd.progress.downloaded / upd.progress.total) * 100)}%` : '0%' }}></i>
                        </div>
                        <div className="text">
                          {fmtBytes(upd.progress.downloaded)}
                          {upd.progress.total ? ` / ${fmtBytes(upd.progress.total)}` : ''}
                        </div>
                      </div>
                    ) : null}
                    <div className="upd-actions">
                      {upd.state === 'available' && !upd.signatureMissing ? (
                        <button id="btn-update-download" className="btn small primary" onClick={() => void doDownloadUpdate()}>下载更新</button>
                      ) : null}
                      {upd.state === 'ready' ? (
                        <button id="btn-update-install" className="btn small primary" onClick={() => void doInstallUpdate()}>重启并更新</button>
                      ) : null}
                      {upd.signatureMissing && upd.downloadUrl ? (
                        <>
                          <button
                            id="btn-update-open-download"
                            className="btn small"
                            onClick={() => void openUrl(upd.downloadUrl!).catch((err) => toast(`无法打开下载页: ${String(err)}`, 'error'))}
                          >打开下载页</button>
                          <span className="hint">该版本未提供更新签名，不会标记为「安全可更新」，请在下载后手动安装</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
          )}
        </main>
      </div>
    </div>
  );
}
