/**
 * 工作台共享文件剪贴板 —— 本地资源管理器（explorer）与 SFTP 面板共用的复制/剪切暂存。
 * - source: 'local' = 本地项目文件；'remote' = 远端 SFTP 文件（携带 serverId）
 * - items: 可多个（SFTP 平铺视图框选后复制/剪切），单条目时长度恒为 1
 * - mode: 'copy' 可多次粘贴；'cut' 粘贴成功后清空（跨文件系统剪切 = 拷贝 + 删除源）
 * - 各面板在复制/剪切/粘贴后自行触发自身的重渲染（行半透明态等）
 */
export interface FsClipItem {
  path: string;
  name: string;
  isDir: boolean;
}

export interface FsClip {
  source: 'local' | 'remote';
  /** source === 'remote' 时的会话 id */
  serverId?: string;
  items: FsClipItem[];
  mode: 'copy' | 'cut';
}

let clip: FsClip | null = null;

export function getClip(): FsClip | null {
  return clip;
}

export function setClip(next: FsClip | null): void {
  clip = next;
}

export function clearClip(): void {
  clip = null;
}
