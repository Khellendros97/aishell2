/**
 * OS 文件拖入导入共享模块:webkitGetAsEntry 拿句柄 + fs_import(base64 回传)落本地目录。
 * 对照来源:pages/workbench/sidebar/explorer/explorer.ts 的「OS 文件拖入导入」段
 *   (React 迁移时逐条翻译自 legacy explorer),现抽为共享,供 explorer 面板与
 *   SftpTab(SFTP 面板接收 OS 拖入上传)复用,行为保持一致。
 * 架构约束:窗口 dragDropEnabled=false(wry OLE DropTarget 会截杀页面内拖拽),
 *   OS 拖入拿不到绝对路径,只能读内容 base64 回传,故有单文件大小上限。
 * 接口点:src/api.ts 的 fs_import(重名自动 name (1).ext);src/ui.ts 的 toast。
 */
import { fsImport } from '../api';
import { toast } from '../ui';

/** 单文件上限 100MB(base64 传输,超大文件走系统拷贝更稳) */
const OS_IMPORT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * 把 OS 拖入(dt.items)的文件/目录导入到本地目录 destDir(必须已存在)。
 * 重名自动 name (1).ext(fs_import 行为);>100MB 文件跳过并提示。
 * 返回各顶层条目的最终落地名(被跳过/未识别的不在内)。
 */
export async function importOsFiles(dt: DataTransfer, destDir: string): Promise<string[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (!entries.length) {
    toast('未识别到可导入的文件', 'error');
    return [];
  }
  const landed: string[] = [];
  for (const entry of entries) {
    const finalName = await importEntry(entry, destDir);
    if (finalName) landed.push(finalName);
  }
  return landed;
}

/** 递归导入一个 entry(目录沿 webkitGetAsEntry 遍历),返回该顶层的落地名;跳过返回 null。 */
async function importEntry(entry: FileSystemEntry, destDir: string): Promise<string | null> {
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const finalName = await fsImport(destDir, entry.name, true, null);
    const children = await readAllEntries(dirEntry.createReader());
    const subDir = `${destDir}/${finalName}`;
    for (const child of children) await importEntry(child, subDir);
    return finalName;
  }
  const file = await entryFile(entry as FileSystemFileEntry);
  if (file.size > OS_IMPORT_MAX_BYTES) {
    toast(`「${file.name}」超过 100MB,已跳过`, 'error');
    return null;
  }
  const b64 = await fileToBase64(file);
  return await fsImport(destDir, file.name, false, b64);
}

/** readEntries 每批最多 100 条,循环取空为止。 */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  const batch = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  return (async () => {
    for (;;) {
      const chunk = await batch();
      if (!chunk.length) return all;
      all.push(...chunk);
    }
  })();
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
