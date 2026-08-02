/** 全局 UI 工具：toast / 通用确认弹窗 / uid。逐行移植自 .proto/shared/mock.js，DOM 类名不变。 */
export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toast(msg: string, type?: 'error' | 'success'): void {
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
