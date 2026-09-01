/**
 * 服务器表单（新建 / 编辑共用）—— React 版，逐行对照 legacy/pages/server-form.ts。
 * 欢迎页「快捷新建服务器」（compact 双列内联区）与工作台侧栏「新建 / 编辑服务器」（单列模态框）
 * 复用同一份字段、校验与构造逻辑，契约与旧版 createServerForm 完全一致：
 *   <ServerForm ref={formRef} compact />；formRef: useRef<ServerFormHandle>(null)。
 * 对照 .proto/welcome.js（mini 新建表单）与 .proto/workbench-sidebar.js（服务器列表新建模态框）；
 * 后端接口 upsert_server（见 src/api.ts），字段与 src/types.ts Server 逐字段对齐
 * （serde camelCase：authType / keyPath / credentialId / locked）。
 * 安全约定：密码 / 密钥永不回传前端 —— 编辑时密码留空 = 提交 null（keyring 保持原值），也绝不写入 aishell.json。
 */
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { Credential, Server } from '../../types';
import { openDialog, sshDefaultKeypairDir, sshDetectKeypair, sshGenerateKeypair } from '../../api';
import { toast, uid } from '../../ui';

export interface ServerFormOptions {
  /** 双列紧凑布局（欢迎页内联区）；缺省单列（侧栏模态框） */
  compact?: boolean;
  /** 可选凭据库；未传时仍可手工填写，兼容所有旧入口 */
  credentials?: Credential[];
  /** 现有全部 tag（标签输入的自动补全候选）；未传则无候选 */
  allTags?: string[];
}

export interface ServerFormHandle {
  /** 预填（server 非空 = 编辑；密码字段永不回显）或清空（null = 新建） */
  fill(server: Server | null): void;
  /** 校验：通过返回 null，否则返回中文错误文案并把问题字段标红（输入即清除） */
  validate(): string | null;
  /** 由表单当前值构造 Server：id / locked 取自 editing（新建生成新 id、locked=false） */
  buildServer(editing: Server | null): Server;
  /** 密码字段：认证方式为密码且已输入时返回原文，否则 null（新建不保存 / 编辑保持原值） */
  passwordValue(): string | null;
  /** 聚焦名称输入框（打开表单时调用） */
  focusFirst(): void;
}

/** 表单字段（与旧版 f-* 元素一一对应；port 以字符串保存，校验时才转数字；tags 为标签列表） */
interface FormFields {
  name: string;
  host: string;
  port: string;
  auth: Server['authType'];
  username: string;
  password: string;
  keyPath: string;
  credentialId: string | null;
  tags: string[];
}

/** 校验标红字段：只有名称 / IP / 端口会被标红（旧版对账号、密钥路径也只清除不标红） */
interface InvalidFields {
  name: boolean;
  host: boolean;
  port: boolean;
}

/** 新建态初始值（同旧版 fill(null)：密码 / 密钥路径恒为空，不留上次输入） */
const EMPTY_FIELDS: FormFields = {
  name: '', host: '', port: '22', auth: 'password', username: '', password: '', keyPath: '', credentialId: null, tags: [],
};

const EMPTY_INVALID: InvalidFields = { name: false, host: false, port: false };

export const ServerForm = forwardRef<ServerFormHandle, ServerFormOptions>(
  function ServerForm({ compact, credentials = [], allTags = [] }, ref): JSX.Element {
    const [fields, setFields] = useState<FormFields>(EMPTY_FIELDS);
    const [invalid, setInvalid] = useState<InvalidFields>(EMPTY_INVALID);
    const [tagInput, setTagInput] = useState('');
    const nameRef = useRef<HTMLInputElement>(null);

    /** 密钥对目录探测状态（仅 publickey 认证显示；检测规则在后端 ssh_keys.rs，前端只展示） */
    const [kp, setKp] = useState<{ status: 'idle' | 'busy' | 'found' | 'missing'; name?: string }>({ status: 'idle' });
    const kpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** 目录输入防抖探测：输入即触发（500ms 防抖），探测结果驱动「已识别 / 未发现可生成」提示 */
    const runDetect = (dir: string): void => {
      if (kpTimer.current) { clearTimeout(kpTimer.current); kpTimer.current = null; }
      const d = dir.trim();
      if (d.length < 3) { setKp({ status: 'idle' }); return; }
      kpTimer.current = setTimeout(() => {
        setKp({ status: 'busy' });
        void sshDetectKeypair(d).then((info) => {
          setKp(info ? { status: 'found', name: info.name } : { status: 'missing' });
        }).catch(() => setKp({ status: 'idle' }));
      }, 500);
    };

    /** 「未发现密钥对」按钮：后端生成 ed25519 密钥对（防覆盖，已存在时拒绝）并刷新探测 */
    const onGenerateKeypair = async (): Promise<void> => {
      const dir = fields.keyPath.trim();
      if (!dir) return;
      setKp({ status: 'busy' });
      try {
        const info = await sshGenerateKeypair(dir);
        setKp({ status: 'found', name: info.name });
        toast(`密钥对已生成：${info.name}（无密码短语）`, 'success');
      } catch (err) {
        setKp({ status: 'missing' });
        toast(String(err), 'error');
      }
    };

    /** 提交一个标签：去 # 前缀、trim、去重；回车 / 逗号 / 点候选 / 失焦时调用 */
    const commitTag = (raw: string): void => {
      const t = raw.trim().replace(/^#+/, '');
      if (t && !fields.tags.includes(t)) {
        setFields((f) => (f.tags.includes(t) ? f : { ...f, tags: [...f.tags, t] }));
      }
      setTagInput('');
    };
    const removeTag = (t: string): void => {
      setFields((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }));
    };
    // 自动补全候选：未选中且匹配当前输入
    const tagQuery = tagInput.trim().replace(/^#+/, '').toLowerCase();
    const tagSuggestions = allTags
      .filter((t) => !fields.tags.includes(t) && (!tagQuery || t.toLowerCase().includes(tagQuery)))
      .slice(0, 8);

    /** 校验标红：输入即清除（同欢迎页 mini 表单行为；与旧版 markInvalid 对应） */
    const clearInvalid = (key: keyof InvalidFields): void => {
      setInvalid((cur) => (cur[key] ? { ...cur, [key]: false } : cur));
    };

    /** 选择已有凭据后只回填非敏感字段；密码字段始终清空，留空提交 null。 */
    const onCredentialChange = (id: string): void => {
      // 「新建凭据」只是解除已有引用，凭据由后端保存分支决定，服务器自身保持 credentialId=null。
      const credentialId = id && id !== '__new__' ? id : null;
      const credential = credentialId ? credentials.find((item) => item.id === credentialId) : null;
      setFields((f) => credential ? {
        ...f,
        credentialId,
        auth: credential.authType,
        username: credential.username,
        keyPath: credential.keyPath,
        password: '',
      } : { ...f, credentialId: null, password: '' });
      if (credential?.authType === 'publickey') runDetect(credential.keyPath);
    };

    /* 浏览…：文件选择器选密钥（私钥无固定扩展名，不加过滤器） */
    const onBrowseKey = async (): Promise<void> => {
      const path = await openDialog({ directory: false });
      if (typeof path === 'string' && path) {
        setFields((f) => ({ ...f, keyPath: path }));
      }
    };

    /* 手柄方法全部即时读取 fields 最新值（useImperativeHandle 依赖 fields 重建，
       父组件任意时刻调 validate / buildServer / passwordValue 拿到的都是当前输入） */
    useImperativeHandle(ref, () => ({
      fill(server: Server | null): void {
        const fillKeyPath = server?.keyPath ?? '';
        setFields({
          name: server?.name ?? '',
          host: server?.host ?? '',
          port: server ? String(server.port) : '22',
          auth: server?.authType ?? 'password',
          username: server?.username ?? '',
          password: '', // 密码 / 密钥永不回显：编辑时留空 = 保持 keyring 原值
          keyPath: fillKeyPath,
          credentialId: server?.credentialId ?? null,
          tags: server?.tags ?? [],
        });
        setTagInput('');
        setInvalid(EMPTY_INVALID);
        if (server?.authType === 'publickey') runDetect(fillKeyPath);
      },
      validate(): string | null {
        const name = fields.name.trim();
        const host = fields.host.trim();
        const portRaw = fields.port.trim();
        const port = Number(portRaw);
        const portOk = !!portRaw && Number.isInteger(port) && port >= 1 && port <= 65535;
        const bad = !name || !host || !portOk;
        setInvalid({ name: !name, host: !host, port: !portOk });
        if (bad) return '请填写必填项（名称、IP、端口），端口需为 1-65535 的整数';
        return null;
      },
      buildServer(editing: Server | null): Server {
        const authType = fields.auth;
        return {
          id: editing?.id ?? uid('srv'),
          name: fields.name.trim(),
          host: fields.host.trim(),
          port: Number(fields.port) || 22,
          authType,
          username: fields.username.trim(),
          // publickey 的 keyPath 是密钥对目录，同样原样入库
          keyPath: authType === 'password' ? '' : fields.keyPath.trim(),
          credentialId: fields.credentialId,
          locked: editing?.locked ?? false,
          // 堡垒机字段不在表单里：编辑时原样保留（目标主机经 SSH跳转设置绑定）
          isBastion: editing?.isBastion ?? false,
          bastionId: editing?.bastionId ?? null,
          tags: fields.tags,
        };
      },
      passwordValue(): string | null {
        return fields.auth === 'password' ? (fields.password || null) : null;
      },
      focusFirst(): void {
        nameRef.current?.focus();
      },
    }), [fields]);

    return (
      <div className={compact ? 'server-form-grid' : undefined}>
        <div className="field">
          <label>服务器名称<span className="req">*</span></label>
          <input
            ref={nameRef}
            className={`input${invalid.name ? ' invalid' : ''}`}
            placeholder="例如：生产-Web-01"
            value={fields.name}
            onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, name: v })); clearInvalid('name'); }}
          />
        </div>
        <div className="field">
          <label>IP 地址<span className="req">*</span></label>
          <input
            className={`input mono${invalid.host ? ' invalid' : ''}`}
            placeholder="例如：47.102.118.66"
            value={fields.host}
            onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, host: v })); clearInvalid('host'); }}
          />
        </div>
        <div className="field">
          <label>SSH 端口<span className="req">*</span></label>
          <input
            className={`input mono${invalid.port ? ' invalid' : ''}`}
            type="number"
            min={1}
            max={65535}
            value={fields.port}
            onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, port: v })); clearInvalid('port'); }}
          />
        </div>
        {credentials.length > 0 ? (
          <div className="field credential-field">
            <label>使用凭据</label>
            <select
              className="select"
              value={fields.credentialId ?? ''}
              onChange={(e) => onCredentialChange(e.currentTarget.value)}
            >
              <option value="">手工填写（不关联凭据）</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>{credential.name}</option>
              ))}
              <option value="__new__">新建凭据（保存服务器时创建）</option>
            </select>
            <div className="hint">选择已有凭据会填充认证信息；密码不会回显。</div>
          </div>
        ) : null}
        <div className="field">
          <label>认证方式</label>
          <select
            className="select"
            value={fields.auth}
            onChange={(e) => {
              // 局部变量先取出再进 updater（React 事件对象不跨异步读取）
              const v = e.currentTarget.value as Server['authType'];
              const currentKeyPath = fields.keyPath.trim();
              setFields((f) => ({ ...f, auth: v }));
              if (v === 'publickey') {
                if (currentKeyPath) {
                  runDetect(currentKeyPath);
                } else {
                  // 首次切到公钥认证且无路径：自动填用户主目录 `.ssh`（后端给默认值）
                  setKp({ status: 'busy' });
                  void sshDefaultKeypairDir().then((dir) => {
                    setFields((f) => (f.keyPath.trim() ? f : { ...f, keyPath: dir }));
                    runDetect(dir);
                  }).catch(() => setKp({ status: 'idle' }));
                }
              } else {
                if (kpTimer.current) { clearTimeout(kpTimer.current); kpTimer.current = null; }
                setKp({ status: 'idle' });
              }
            }}
          >
            <option value="password">账号密码</option>
            <option value="key">密钥</option>
            <option value="publickey">SSH 公钥（密钥对）</option>
          </select>
        </div>
        <div className="field">
          <label>账号</label>
          <input
            className="input"
            placeholder="例如：deploy"
            value={fields.username}
            onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, username: v })); }}
          />
        </div>
        {/* 认证方式切换：仅显示对应密码 / 密钥（对）路径字段（同侧栏原模态框 data-auth 约定） */}
        {fields.auth === 'password' ? (
          <div className="field" data-auth="password">
            <label>密码</label>
            <input
              className="input"
              type="password"
              placeholder="留空则不修改（已保存密码保持原值）"
              value={fields.password}
              onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, password: v })); }}
            />
          </div>
        ) : fields.auth === 'key' ? (
          <div className="field" data-auth="key">
            <label>密钥文件路径</label>
            <div className="path-row">
              <input
                className="input mono"
                placeholder="C:\\Users\\demo\\.ssh\\id_ed25519"
                value={fields.keyPath}
                onInput={(e) => { const v = e.currentTarget.value; setFields((f) => ({ ...f, keyPath: v })); }}
              />
              <button type="button" className="btn" title="选择密钥文件" onClick={() => void onBrowseKey()}>浏览…</button>
            </div>
          </div>
        ) : (
          <div className="field" data-auth="publickey">
            <label>密钥对目录</label>
            <div className="path-row">
              <input
                className="input mono"
                placeholder="C:\\Users\\demo\\.ssh"
                value={fields.keyPath}
                onInput={(e) => {
                  const v = e.currentTarget.value;
                  setFields((f) => ({ ...f, keyPath: v }));
                  runDetect(v);
                }}
              />
              <button
                type="button"
                className="btn"
                title="选择密钥对目录"
                onClick={() => void openDialog({ directory: true }).then((path) => {
                  if (typeof path === 'string' && path) {
                    setFields((f) => ({ ...f, keyPath: path }));
                    runDetect(path);
                  }
                })}
              >浏览…</button>
            </div>
            {/* 目录探测结果：已识别密钥对 / 未发现时提供一键生成（生成规则见 ssh_keys.rs） */}
            {kp.status === 'found' ? (
              <div className="hint ok">已识别密钥对：{kp.name}</div>
            ) : kp.status === 'missing' ? (
              <button type="button" className="btn small ghost keypair-gen" onClick={() => void onGenerateKeypair()}>
                未发现密钥对，点击立即生成
              </button>
            ) : kp.status === 'busy' ? (
              <div className="hint">探测目录中…</div>
            ) : (
              <div className="hint">目录内按 id_ed25519 / id_rsa / id_ecdsa 顺序识别（私钥 + 同名 .pub 需并存）</div>
            )}
          </div>
        )}
        {/* 标签：chip 编辑器，回车/逗号提交，候选来自现有全部 tag（搜索框 #tag 筛选用） */}
        <div className="field" style={compact ? { gridColumn: '1 / -1' } : undefined}>
          <label>标签</label>
          <div className="tag-editor">
            {fields.tags.map((t) => (
              <span key={t} className="tag blue">
                {t}
                <button
                  type="button"
                  className="tag-remove"
                  title={`移除标签 ${t}`}
                  onClick={() => removeTag(t)}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="tag-input"
              placeholder="回车添加标签"
              value={tagInput}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v.includes(',') || v.includes('，')) {
                  commitTag(v.replace(/[,，]/g, ''));
                } else {
                  setTagInput(v);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitTag(tagInput); }
                else if (e.key === 'Backspace' && !tagInput && fields.tags.length > 0) {
                  removeTag(fields.tags[fields.tags.length - 1]);
                }
              }}
              onBlur={() => commitTag(tagInput)}
            />
          </div>
          {tagSuggestions.length > 0 && (
            <div className="tag-suggestions">
              {tagSuggestions.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="tag clickable"
                  // mousedown 先于 blur：preventDefault 保持输入框焦点，避免先触发 onBlur 提交
                  onMouseDown={(e) => { e.preventDefault(); commitTag(t); }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          <div className="hint">标签用于搜索框 #标签 筛选，如 #生产 #已下架。</div>
        </div>
      </div>
    );
  },
);
