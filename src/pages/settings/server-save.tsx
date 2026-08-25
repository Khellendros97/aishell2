/**
 * 服务器保存流程：统一处理凭据被多个服务器引用时的选择。
 * 对照 .proto/welcome.js / .proto/workbench-sidebar.js 的服务器保存入口；
 * 后端接口点：upsert_server(server, password, credentialMode)，返回权威 Server。
 * 该模块使用命令式 modal，保证欢迎页、工作台等命令式引擎入口共享三选一交互。
 */
import { upsertServer } from '../../api';
import type { Server } from '../../types';
import { icon } from '../../icons';

/**
 * 保存服务器。凭据冲突时必须明确选择：取消、保存到新凭据、更新现有凭据。
 * 成功返回后端权威服务器，取消或关闭返回 null。
 */
export async function saveServerWithCredentialChoice(
  server: Server,
  password: string | null,
): Promise<Server | null> {
  const first = await upsertServer(server, password, 'ask');
  if (first.status === 'saved') {
    window.dispatchEvent(new CustomEvent('aishell:data-changed'));
    return first.server;
  }
  return chooseCredentialConflict(first.credentialName, first.referenceCount, server, password);
}

function chooseCredentialConflict(
  credentialName: string,
  referenceCount: number,
  server: Server,
  password: string | null,
): Promise<Server | null> {
  const { promise, resolve } = Promise.withResolvers<Server | null>();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal credential-choice-modal" style="width:480px">
      <div class="modal-head">
        <h3>凭据已被多个服务器使用</h3>
        <button class="icon-btn credential-choice-close" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body credential-choice-body">
        <p>凭据「${escapeHtml(credentialName)}」已被 ${referenceCount} 台服务器引用。请选择如何保存「${escapeHtml(server.name)}」的登录信息。</p>
        <div class="hint">更新凭据会影响其他引用服务器；保存到新凭据只影响当前服务器。</div>
        <div class="credential-choice-error"></div>
      </div>
      <div class="modal-foot credential-choice-actions">
        <button class="btn credential-choice-cancel">取消</button>
        <button class="btn primary credential-choice-fork">保存到新凭据（推荐）</button>
        <button class="btn credential-choice-update">更新凭据</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  let done = false;
  const finish = (value: Server | null): void => {
    if (done) return;
    done = true;
    mask.classList.remove('open');
    window.setTimeout(() => mask.remove(), 160);
    resolve(value);
  };
  const errorEl = mask.querySelector('.credential-choice-error') as HTMLElement;
  const buttons = Array.from(mask.querySelectorAll('button')) as HTMLButtonElement[];
  const setBusy = (busy: boolean): void => {
    buttons.forEach((button) => { button.disabled = busy; });
  };
  const choose = async (mode: 'fork' | 'update'): Promise<void> => {
    setBusy(true);
    errorEl.textContent = '';
    try {
      const result = await upsertServer(server, password, mode);
      if (result.status === 'saved') {
        window.dispatchEvent(new CustomEvent('aishell:data-changed'));
        finish(result.server);
      } else {
        errorEl.textContent = '凭据状态已变化，请重新保存服务器';
        setBusy(false);
      }
    } catch (err) {
      errorEl.textContent = String(err);
      setBusy(false);
    }
  };

  mask.querySelector('.credential-choice-close')?.addEventListener('click', () => finish(null));
  mask.querySelector('.credential-choice-cancel')?.addEventListener('click', () => finish(null));
  mask.querySelector('.credential-choice-fork')?.addEventListener('click', () => void choose('fork'));
  mask.querySelector('.credential-choice-update')?.addEventListener('click', () => void choose('update'));
  mask.addEventListener('mousedown', (event) => { if (event.target === mask) finish(null); });
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && mask.isConnected) {
      document.removeEventListener('keydown', onKeydown);
      finish(null);
    }
  };
  document.addEventListener('keydown', onKeydown);
  promise.finally(() => document.removeEventListener('keydown', onKeydown)).catch(() => { /* promise 不拒绝 */ });
  return promise;
}

/** 冲突文案来自后端，插入 DOM 前转义，避免凭据名称破坏 modal 结构。 */
function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char);
}
