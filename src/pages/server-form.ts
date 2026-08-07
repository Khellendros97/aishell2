/**
 * 服务器表单（新建 / 编辑共用）—— 欢迎页「快捷新建服务器」与工作台侧栏「新建 / 编辑服务器」复用同一份字段、校验与构造逻辑。
 * 对照 .proto/welcome.js（mini 新建表单）与 .proto/workbench-sidebar.js（服务器列表新建模态框）；后端接口 upsert_server（见 src/api.ts）。
 * 字段与 src/types.ts Server 逐字段对齐（serde camelCase：authType / keyPath / folder / locked）。
 * 安全约定：密码 / 密钥永不回传前端 —— 编辑时密码留空 = 提交 null（keyring 保持原值），也绝不写入 aishell.json。
 */
import type { Server } from '../types';
import { attachCombo, uid } from '../ui';

export interface ServerFormOptions {
  /** 所属目录组合框候选（由调用方从其数据源提供，如 serverFolders ∪ 各服务器 folder 派生值）；缺省 = 无候选仅手输 */
  folderOptions?: () => string[];
  /** 双列紧凑布局（欢迎页内联区）；缺省单列（侧栏模态框） */
  compact?: boolean;
}

export interface ServerFormHandle {
  /** 预填（server 非空 = 编辑；密码字段永不回显）或清空（null = 新建） */
  fill(server: Server | null): void;
  /** 校验：通过返回 null，否则返回中文错误文案并把问题字段标红（输入即清除） */
  validate(): string | null;
  /** 由表单当前值构造 Server：id / locked 取自 editing（新建生成新 id、locked=false），folder 规范化 '/' 路径 */
  buildServer(editing: Server | null): Server;
  /** 密码字段：认证方式为密码且已输入时返回原文，否则 null（新建不保存 / 编辑保持原值） */
  passwordValue(): string | null;
  /** 聚焦名称输入框（打开表单时调用） */
  focusFirst(): void;
}

/** 渲染服务器表单到 container 并返回控制器。欢迎页与工作台为互斥路由，页面内同一时刻至多一个实例。 */
export function createServerForm(container: HTMLElement, opts: ServerFormOptions = {}): ServerFormHandle {
  const p = uid('sf'); // 实例唯一 id 前缀，避免与页面内其他 id 冲突
  container.innerHTML = `
    <div class="${opts.compact ? 'server-form-grid' : ''}">
      <div class="field">
        <label>服务器名称<span class="req">*</span></label>
        <input id="${p}-name" class="input" placeholder="例如：生产-Web-01">
      </div>
      <div class="field">
        <label>IP 地址<span class="req">*</span></label>
        <input id="${p}-host" class="input mono" placeholder="例如：47.102.118.66">
      </div>
      <div class="field">
        <label>SSH 端口<span class="req">*</span></label>
        <input id="${p}-port" class="input mono" type="number" min="1" max="65535" value="22">
      </div>
      <div class="field">
        <label>认证方式</label>
        <select id="${p}-auth" class="select">
          <option value="password">账号密码</option>
          <option value="key">密钥</option>
        </select>
      </div>
      <div class="field">
        <label>账号</label>
        <input id="${p}-username" class="input" placeholder="例如：deploy">
      </div>
      <div class="field" data-auth="password">
        <label>密码</label>
        <input id="${p}-password" class="input" type="password" placeholder="留空则不修改（已保存密码保持原值）">
      </div>
      <div class="field" data-auth="key">
        <label>密钥文件路径</label>
        <input id="${p}-keypath" class="input mono" placeholder="C:\\Users\\demo\\.ssh\\id_ed25519">
      </div>
      <div class="field">
        <label>所属目录</label>
        <input id="${p}-folder" class="input" placeholder="可输入新分类或从下拉选择，例如：生产环境/Web">
        <div class="hint">以 / 分隔的目录路径，用于侧栏分组展示；可下拉选择已有分类，也可直接输入新分类；留空表示未分类</div>
      </div>
    </div>`;

  const q = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#${p}-${id}`)!;
  const fName = q<HTMLInputElement>('name');
  const fHost = q<HTMLInputElement>('host');
  const fPort = q<HTMLInputElement>('port');
  const fAuth = q<HTMLSelectElement>('auth');
  const fUsername = q<HTMLInputElement>('username');
  const fPassword = q<HTMLInputElement>('password');
  const fKeyPath = q<HTMLInputElement>('keypath');
  const fFolder = q<HTMLInputElement>('folder');

  /** 认证方式切换：仅显示对应密码 / 密钥路径字段（同侧栏原模态框 data-auth 约定） */
  function syncAuthFields(): void {
    const mode = fAuth.value;
    container.querySelectorAll('.field[data-auth]').forEach((field) => {
      field.classList.toggle('hidden', field.getAttribute('data-auth') !== mode);
    });
  }
  fAuth.addEventListener('change', syncAuthFields);

  /* 校验标红：输入即清除（同欢迎页 mini 表单行为） */
  const markInvalid = (el: HTMLInputElement, bad: boolean): void => {
    el.classList.toggle('invalid', bad);
  };
  [fName, fHost, fPort, fUsername, fKeyPath, fFolder].forEach((el) => {
    el.addEventListener('input', () => markInvalid(el, false));
  });

  if (opts.folderOptions) attachCombo(fFolder, opts.folderOptions);

  return {
    fill(server: Server | null): void {
      fName.value = server?.name ?? '';
      fHost.value = server?.host ?? '';
      fPort.value = server ? String(server.port) : '22';
      fAuth.value = server?.authType ?? 'password';
      fUsername.value = server?.username ?? '';
      fPassword.value = ''; // 密码 / 密钥永不回显：编辑时留空 = 保持 keyring 原值
      fKeyPath.value = server?.keyPath ?? '';
      fFolder.value = server?.folder ?? '';
      syncAuthFields();
      [fName, fHost, fPort, fUsername, fKeyPath, fFolder].forEach((el) => markInvalid(el, false));
    },
    validate(): string | null {
      const name = fName.value.trim();
      const host = fHost.value.trim();
      const portRaw = fPort.value.trim();
      const port = Number(portRaw);
      const portOk = !!portRaw && Number.isInteger(port) && port >= 1 && port <= 65535;
      const bad = !name || !host || !portOk;
      markInvalid(fName, !name);
      markInvalid(fHost, !host);
      markInvalid(fPort, !portOk);
      if (bad) return '请填写必填项（名称、IP、端口），端口需为 1-65535 的整数';
      return null;
    },
    buildServer(editing: Server | null): Server {
      const authType = fAuth.value as Server['authType'];
      return {
        id: editing?.id ?? uid('srv'),
        name: fName.value.trim(),
        host: fHost.value.trim(),
        port: Number(fPort.value) || 22,
        authType,
        username: fUsername.value.trim(),
        keyPath: authType === 'key' ? fKeyPath.value.trim() : '',
        // 所属目录：规范化 '/' 分隔路径（去首尾/重复分隔符），留空 = 未分类
        folder: fFolder.value.trim().split('/').filter(Boolean).join('/'),
        locked: editing?.locked ?? false,
      };
    },
    passwordValue(): string | null {
      return fAuth.value === 'password' ? (fPassword.value || null) : null;
    },
    focusFirst(): void {
      fName.focus();
    },
  };
}
