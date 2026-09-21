/**
 * 文件打开方式（设置-功能特性「文件打开方式」，Settings.fileOpenMode）的统一执行器与「让我选择」弹窗。
 * 调用方：explorer.ts（本地文件双击/菜单）、SftpTab.tsx（远端文件双击/菜单）。
 * 四个模式的执行链：
 *  - editor-first（默认）：内置处理器（编辑器/抓包查看器）→ 系统默认应用 → 文件资源管理器
 *  - system-first：系统默认应用 → 文件资源管理器
 *  - explorer：文件资源管理器定位
 *  - ask：弹窗选择（builtinSupported=false 时不列内置选项）
 * 系统默认应用失败（无关联程序）自动回退资源管理器并提示；
 * 「让我选择」弹窗的取消（遮罩/Esc/取消按钮）不执行任何动作。
 * 模式经 getState 惰性读取并缓存，aishell:data-changed 广播（设置保存）时失效重读。
 * 与后端的接口点：fs_open_default / sftp_open（action: open|reveal）。
 */
import { getState } from '../api';
import { toast } from '../ui';
import { icon, type IconName } from '../icons';

export type FileOpenMode = 'editor-first' | 'system-first' | 'explorer' | 'ask';

/** 「让我选择」弹窗的选择结果；null = 取消 */
export type OpenChoice = 'builtin' | 'system' | 'explorer' | null;

let cachedMode: FileOpenMode | null = null;

/** 当前文件打开方式（惰性读取 + 缓存；getState 失败按默认 editor-first） */
export async function getFileOpenMode(): Promise<FileOpenMode> {
  if (cachedMode) return cachedMode;
  try {
    const s = await getState();
    cachedMode = s.settings.fileOpenMode ?? 'editor-first';
  } catch {
    cachedMode = 'editor-first';
  }
  return cachedMode;
}

/* 设置保存/数据变更后缓存失效（设置页 save() 会广播该事件） */
window.addEventListener('aishell:data-changed', () => { cachedMode = null; });

/**
 * 「让我选择」弹窗：返回用户选择的打开方式，取消返回 null。
 * builtinSupported=false（内置编辑器不支持的文件）时不显示内置选项。
 */
export function chooseOpenAction(
  fileName: string,
  opts: { builtinSupported: boolean; builtinLabel?: string },
): Promise<OpenChoice> {
  const { promise, resolve } = Promise.withResolvers<OpenChoice>();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const options: Array<{ choice: NonNullable<OpenChoice>; iconName: IconName; label: string }> = [];
  if (opts.builtinSupported) {
    options.push({ choice: 'builtin', iconName: 'file', label: opts.builtinLabel ?? '内置编辑器' });
  }
  options.push(
    { choice: 'system', iconName: 'appWindow', label: '系统默认应用' },
    { choice: 'explorer', iconName: 'folderOpen', label: '文件资源管理器' },
  );
  mask.innerHTML = `
    <div class="modal" style="width:360px">
      <div class="modal-head"><h3>打开方式</h3></div>
      <div class="modal-body open-mode-body">
        <div class="open-mode-file"></div>
        <div class="open-mode-options"></div>
      </div>
      <div class="modal-foot"><button class="btn" data-act="cancel">取消</button></div>
    </div>`;
  mask.querySelector('.open-mode-file')!.textContent = fileName;
  const box = mask.querySelector('.open-mode-options')!;
  const close = (val: OpenChoice): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
    resolve(val);
  };
  for (const o of options) {
    const btn = document.createElement('button');
    btn.className = 'btn open-mode-option';
    btn.innerHTML = `${icon(o.iconName)}<span></span>`;
    btn.querySelector('span')!.textContent = o.label;
    btn.onclick = () => close(o.choice);
    box.appendChild(btn);
  }
  (mask.querySelector('[data-act=cancel]') as HTMLButtonElement).onclick = () => close(null);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { close(null); document.removeEventListener('keydown', onKey, true); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  return promise;
}

/** 各打开动作集合（本地/远端各自实现，远端一般是「下载到临时目录后打开/定位」） */
export interface OpenActions {
  /** 内置处理器是否支持该文件（编辑器文本约束 / pcap 查看器等） */
  builtinSupported: boolean | Promise<boolean>;
  /** 内置选项的显示名（「内置编辑器」/「抓包查看器」） */
  builtinLabel: string;
  openBuiltin: () => void;
  /** 系统默认应用打开；reject = 无关联程序/失败（自动回退 openExplorer 并提示） */
  openSystem: () => Promise<unknown>;
  /** 文件资源管理器定位 */
  openExplorer: () => Promise<unknown>;
}

/** 按当前「文件打开方式」设置执行打开动作（含各模式回退链与 ask 弹窗） */
export async function runWithOpenMode(fileName: string, actions: OpenActions): Promise<void> {
  const mode = await getFileOpenMode();
  const systemWithFallback = async (): Promise<void> => {
    try {
      await actions.openSystem();
    } catch (err) {
      toast(`${String(err)}，已在文件资源管理器中定位`, 'info');
      await actions.openExplorer();
    }
  };
  switch (mode) {
    case 'editor-first': {
      if (await actions.builtinSupported) { actions.openBuiltin(); return; }
      await systemWithFallback();
      return;
    }
    case 'system-first': {
      await systemWithFallback();
      return;
    }
    case 'explorer': {
      await actions.openExplorer();
      return;
    }
    case 'ask': {
      const choice = await chooseOpenAction(fileName, {
        builtinSupported: await actions.builtinSupported,
        builtinLabel: actions.builtinLabel,
      });
      if (choice === 'builtin') actions.openBuiltin();
      else if (choice === 'system') await systemWithFallback();
      else if (choice === 'explorer') await actions.openExplorer();
      return;
    }
  }
}
