/** 全局 UI 工具：toast / 通用确认弹窗 / uid / 剪贴板 / 右键菜单。逐行移植自 .proto/shared/mock.js，DOM 类名不变。 */
import { icon as iconSvg, type IconName } from './icons';

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toast(msg: string, type?: 'error' | 'success' | 'info'): void {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  }
  const el = document.createElement('div');
  el.className = `toast${type ? ` ${type}` : ''}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, 2200);
}

export interface ConfirmOptions {
  title?: string;
  message?: string;
  danger?: boolean;
  okText?: string;
}

export function confirmDialog({
  title = '确认操作', message = '', danger = false, okText = '确定',
}: ConfirmOptions = {}): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:400px">
        <div class="modal-head"><h3></h3></div>
        <div class="modal-body" style="color:var(--text-1);line-height:1.6"></div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-act="ok"></button>
        </div>
      </div>`;
    mask.querySelector('h3')!.textContent = title;
    mask.querySelector('.modal-body')!.textContent = message;
    mask.querySelector('[data-act=ok]')!.textContent = okText;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('open'));
    const close = (val: boolean) => {
      mask.classList.remove('open');
      setTimeout(() => mask.remove(), 160);
      resolve(val);
    };
    (mask.querySelector('[data-act=cancel]') as HTMLButtonElement).onclick = () => close(false);
    (mask.querySelector('[data-act=ok]') as HTMLButtonElement).onclick = () => close(true);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(false); });
  return promise;
}

/** 输入对话框（如压缩包命名）：确定返回 trim 后的值（空/含路径分隔符时拒绝并提示），取消返回 null。 */
export function promptDialog({
  title = '输入', label = '', defaultValue = '', placeholder = '', okText = '确定',
}: {
  title?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  okText?: string;
} = {}): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:400px">
      <div class="modal-head"><h3></h3></div>
      <div class="modal-body" style="color:var(--text-1);line-height:1.6">
        ${label ? `<div class="prompt-label"></div>` : ''}
        <input class="input prompt-input" type="text" style="width:100%;margin-top:8px" spellcheck="false">
        <div class="prompt-error" style="color:var(--red);font-size:12px;margin-top:6px;min-height:16px"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn primary" data-act="ok"></button>
      </div>
    </div>`;
  mask.querySelector('h3')!.textContent = title;
  const labelEl = mask.querySelector('.prompt-label');
  if (labelEl) labelEl.textContent = label;
  const input = mask.querySelector('.prompt-input') as HTMLInputElement;
  input.value = defaultValue;
  input.placeholder = placeholder;
  mask.querySelector('[data-act=ok]')!.textContent = okText;
  document.body.appendChild(mask);
  requestAnimationFrame(() => {
    mask.classList.add('open');
    input.focus();
    input.select();
  });
  let done = false;
  const close = (val: string | null): void => {
    if (done) return;
    done = true;
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
    resolve(val);
  };
  const submit = (): void => {
    const value = input.value.trim();
    if (!value) {
      mask.querySelector('.prompt-error')!.textContent = '名称不能为空';
      return;
    }
    if (/[\\/]/.test(value)) {
      mask.querySelector('.prompt-error')!.textContent = '名称不能包含路径分隔符';
      return;
    }
    close(value);
  };
  (mask.querySelector('[data-act=cancel]') as HTMLButtonElement).onclick = () => close(null);
  (mask.querySelector('[data-act=ok]') as HTMLButtonElement).onclick = submit;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') close(null);
  });
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
  return promise;
}

/** 复制文本到系统剪贴板（navigator.clipboard 失败时降级 execCommand） */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/* ---------- 右键菜单（模块级单例；点击外部 / Esc / 窗口失焦关闭；样式 .ctx-menu 见 design.css） ---------- */
export interface CtxItem {
  label: string;
  iconName: IconName;
  danger?: boolean;
  disabled?: boolean;
  disabledTip?: string;
  action?: () => void;
}
export type CtxMenuItems = (CtxItem | 'sep')[];

let menuEl: HTMLElement | null = null;

function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
  document.removeEventListener('mousedown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
  window.removeEventListener('blur', closeMenu);
}
function onMenuOutside(e: MouseEvent): void {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
}
function onMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMenu();
}

export function showContextMenu(x: number, y: number, items: CtxMenuItems): void {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      el.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = `ctx-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`;
    btn.innerHTML = `${iconSvg(item.iconName)}<span>${item.label}</span>`;
    if (item.disabled || !item.action) {
      btn.disabled = true;
      if (item.disabledTip) btn.title = item.disabledTip;
    } else {
      const { action } = item;
      btn.onclick = () => { closeMenu(); action(); };
    }
    el.appendChild(btn);
  }
  document.body.appendChild(el);
  /* 防出屏：先渲染取尺寸再定位 */
  const rect = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menuEl = el;
  document.addEventListener('mousedown', onMenuOutside, true);
  document.addEventListener('keydown', onMenuKey, true);
  window.addEventListener('blur', closeMenu);
}
