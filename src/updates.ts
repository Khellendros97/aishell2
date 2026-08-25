/**
 * 应用更新状态总线（客户端自动更新）：后端 update.rs 状态机在前端的唯一镜像。
 * main.tsx 启动时 initUpdates() 拉一次 update_status 并订阅三条事件（status-changed /
 * download-progress / ready）；Topbar 徽标与设置页「关于与更新」共用本总线，
 * 不各自发起检查（开发文档 §7：提取共用版本/更新状态，避免重复请求）。
 * 接口点：api.ts update* 封装；脱敏 debug 打点走 debug.ts dbg()。
 */
import {
  onUpdateDownloadProgress,
  onUpdateReady,
  onUpdateStatusChanged,
  updateDownload,
  updateStatus,
} from './api';
import type { UpdateStatus } from './types';
import { dbg } from './debug';
import { navigate, parseHash } from './router';
import { toast } from './ui';

let current: UpdateStatus | null = null;
const listeners = new Set<(s: UpdateStatus) => void>();
let started = false;
let autoDownloadInFlight = false;
let autoDownloadedVersion: string | null = null;

function onAboutUpdatePage(): boolean {
  const route = parseHash();
  return route.name === '/settings' && route.params.get('page') === 'about';
}

function openAboutUpdate(): void {
  navigate('#/settings?page=about');
}

function startAutoDownload(s: UpdateStatus): void {
  const version = s.availableVersion;
  if (!version || s.signatureMissing || autoDownloadInFlight || autoDownloadedVersion === version) return;
  autoDownloadInFlight = true;
  autoDownloadedVersion = version;
  void updateDownload()
    .catch((err) => {
      dbg(`update: 自动下载 v${version} 失败 (${String(err)})`);
      toast('更新下载失败，点击重试', 'error', 8000, { onClick: openAboutUpdate });
    })
    .finally(() => { autoDownloadInFlight = false; });
}

function apply(s: UpdateStatus): void {
  const prev = current?.state;
  current = s;
  dbg(`update: 状态 ${s.state}${s.availableVersion ? ` v${s.availableVersion}` : ''}${s.error ? ` (${s.error})` : ''}`);
  for (const fn of listeners) fn(s);

  if (s.state === 'available' && s.availableVersion) {
    if (s.signatureMissing) {
      if (prev !== 'available' && !onAboutUpdatePage()) {
        toast(`发现新版本 v${s.availableVersion}，点击手动下载`, 'info', 8000, { onClick: openAboutUpdate });
      }
    } else {
      startAutoDownload(s);
    }
    return;
  }

  // 下载验签完成后再通知用户；设置页其他分类仍提示，仅当前更新页内不重复弹。
  if (s.state === 'ready' && prev !== 'ready' && !onAboutUpdatePage()) {
    toast('新版本已准备好，点击安装', 'info', 8000, { onClick: openAboutUpdate });
  }
}

/** main.tsx 启动时调用一次：订阅后端更新事件（失败静默——更新功能绝不影响主路径） */
export function initUpdates(): void {
  if (started) return;
  started = true;
  void updateStatus().then(apply).catch(() => { /* 后端未就绪时留空态 */ });
  void onUpdateStatusChanged((s) => apply(s)).catch(() => {});
  void onUpdateDownloadProgress((p) => {
    if (current && current.state === 'downloading') apply({ ...current, progress: p });
  }).catch(() => {});
  void onUpdateReady(() => { /* ready 提示由 status-changed 的 available→ready 转换发出 */ }).catch(() => {});
}

/** 当前快照（null = 尚未收到任何状态） */
export function getUpdateStatus(): UpdateStatus | null {
  return current;
}

/** 订阅状态变化；已有快照时立即回调一次。返回退订函数。 */
export function onUpdateStatus(cb: (s: UpdateStatus) => void): () => void {
  listeners.add(cb);
  if (current) cb(current);
  return () => { listeners.delete(cb); };
}
