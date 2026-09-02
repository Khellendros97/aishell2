/**
 * 内置浏览器设置面板（代理等浏览器独立配置；无 .proto 对照，2026-09 新增）。
 * 与主设置表单完全解耦:代理是 AppState 顶层字段(browserProxy),不进 Settings 整表单,
 * 本页用独立「保存」按钮调 browser_set_proxy——保存即生效:后端关闭所有现有浏览器子视图
 * 并广播 browser:proxy-changed,标签页按 URL 自动重建(代理只能在子 webview 创建时注入)。
 * 来源:从运行中的 SSH 动态隧道(SOCKS5)选一个,或手动输入地址:端口。
 * 隧道候选:api.ts tunnelList() 过滤 running && kind==='dynamic';隧道不在运行时回落直连,
 * 本页显示「当前生效」状态行。
 * 后端接口点:browser_set_proxy / tunnel_list;配置读取走 getState().browserProxy。
 */
import { useEffect, useMemo, useState } from 'react';
import type { AppState, BrowserProxyConfig, TunnelState } from '../../types';
import { browserSetProxy, tunnelList } from '../../api';
import { toast } from '../../ui';
import { Icon } from '../../shared/Icon';

interface Props {
  initialState: AppState | null;
  /** 保存成功后回写 AppState(供设置页其他面板共享 dbRef/appState) */
  onChanged: (state: AppState) => void;
}

/** 隧道下拉候选标签:名称 (bindAddr:localPort) */
function tunnelLabel(t: TunnelState): string {
  return `${t.name}（${t.bindAddr}:${t.localPort}）`;
}

export function BrowserPanel({ initialState, onChanged }: Props): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [source, setSource] = useState<'tunnel' | 'manual'>('tunnel');
  const [tunnelId, setTunnelId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('');
  const [tunnels, setTunnels] = useState<TunnelState[]>([]);
  const [saving, setSaving] = useState(false);

  /* 运行中的动态隧道 = 合法候选;静态隧道(-L)不能当代理 */
  const candidates = useMemo(
    () => tunnels.filter((t) => t.running && t.kind === 'dynamic'),
    [tunnels],
  );

  /* 装载配置 + 拉隧道列表 */
  useEffect(() => {
    const proxy = initialState?.browserProxy;
    if (proxy) {
      setEnabled(proxy.enabled);
      setSource(proxy.source);
      setTunnelId(proxy.tunnelId ?? '');
      setHost(proxy.host || '127.0.0.1');
      setPort(proxy.port ? String(proxy.port) : '');
    }
  }, [initialState]);
  useEffect(() => {
    void tunnelList().then(setTunnels).catch((err) => toast(String(err), 'error'));
  }, []);

  /** 当前生效状态行(代理是否真实在跑):隧道源但隧道不在运行 → 回落直连 */
  const effectiveNote = useMemo(() => {
    if (!enabled) return { text: '未启用:内置浏览器走直连', cls: 'mcp-status-line' };
    if (source === 'manual') {
      if (!host.trim() || !port.trim()) return { text: '未生效:手动模式请填完整主机与端口', cls: 'mcp-status-line err' };
      return { text: `当前生效:socks5://${host.trim()}:${port.trim()}(手动)`, cls: 'mcp-status-line ok' };
    }
    const t = candidates.find((x) => x.id === tunnelId);
    if (!t) {
      return {
        text: candidates.length
          ? '未生效:所选隧道未在运行,当前回落直连'
          : '未生效:暂无运行中的动态隧道,当前回落直连',
        cls: 'mcp-status-line err',
      };
    }
    return { text: `当前生效:socks5://${t.bindAddr}:${t.localPort}(隧道「${t.name}」)`, cls: 'mcp-status-line ok' };
  }, [enabled, source, host, port, tunnelId, candidates]);

  const save = async (): Promise<void> => {
    const cfg: BrowserProxyConfig = {
      enabled,
      source,
      tunnelId: source === 'tunnel' ? (tunnelId || null) : null,
      host: source === 'manual' ? host.trim() : '',
      port: source === 'manual' ? (Number(port.trim()) || 0) : 0,
    };
    setSaving(true);
    try {
      await browserSetProxy(cfg);
      toast('浏览器代理设置已保存,打开的浏览器标签页正在重建', 'success');
      // 配置在 AppState 顶层,前端共享引用按最新值回写(结构不变,仅字段替换)
      if (initialState) onChanged({ ...initialState, browserProxy: cfg });
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="panel-browser" className="settings-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title"><Icon name="globe" />内置浏览器</div>
          <div className="hint">SOCKS5 代理只作用于内置浏览器(不影响主界面与其他功能);保存后已打开的浏览器标签页会自动重建。</div>
        </div>
      </div>

      <div className="field">
        <label>启用 SOCKS5 代理</label>
        <input type="checkbox" checked={enabled} onChange={(e) => { const v = e.currentTarget.checked; setEnabled(v); }} />
      </div>

      {enabled ? (
        <>
          <div className="field">
            <label>代理来源</label>
            <div className="field-row">
              <label className="db-cmd">
                <input type="radio" name="browser-proxy-source" checked={source === 'tunnel'} onChange={() => setSource('tunnel')} />
                从运行中的 SSH 隧道选择
              </label>
              <label className="db-cmd">
                <input type="radio" name="browser-proxy-source" checked={source === 'manual'} onChange={() => setSource('manual')} />
                手动输入
              </label>
            </div>
          </div>

          {source === 'tunnel' ? (
            <div className="field">
              <label>SSH 隧道(SOCKS5 动态代理)</label>
              <select className="select" value={tunnelId} onChange={(e) => { const v = e.currentTarget.value; setTunnelId(v); }}>
                <option value="">{candidates.length ? '请选择隧道…' : '暂无运行中的动态隧道'}</option>
                {candidates.map((t) => (
                  <option key={t.id} value={t.id}>{tunnelLabel(t)}</option>
                ))}
              </select>
              <div className="hint">只列「运行中」的动态隧道;在服务器卡片「更多 → SSH 隧道」里创建并启动后回到本页刷新。</div>
            </div>
          ) : (
            <div className="field-row">
              <div className="field" style={{ flex: 2 }}>
                <label>代理主机</label>
                <input className="input mono" value={host} placeholder="127.0.0.1" onChange={(e) => { const v = e.currentTarget.value; setHost(v); }} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>端口</label>
                <input className="input mono" value={port} placeholder="1080" onChange={(e) => { const v = e.currentTarget.value; setPort(v); }} />
              </div>
            </div>
          )}
        </>
      ) : null}

      <div className={effectiveNote.cls}>{effectiveNote.text}</div>

      <div className="form-actions">
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </section>
  );
}
