/**
 * pcap 抓包查看器标签页('pcap',全新功能,无 .proto 对照;React 薄壳)。
 * 命令式引擎在 ./pcap-engine.ts(头部注释有布局/数据链路契约);
 * 与后端的接口点:pcap_read(本地 path / 远端 serverId+path,统一返回 base64,≤128MB)。
 * keep-alive 契约(见 registry.ts):本组件常驻挂载、active 只切显隐——
 * 引擎 useEffect 挂载一次(依赖 tab.id,不用 tab 对象),标签关闭(卸载)才清理。
 * 外部入口:侧栏 explorer 双击/右键 → openLocalPcap;SFTP 双击/右键 → openRemotePcap
 *   (照 EditorTab openLocalFile/openRemoteFile 模式,同 id 去重激活)。
 */
import { useEffect, useRef } from 'react';
import type { Tab, TabProps } from '../../../stores/workbench';
import { useWorkbench } from '../../../stores/workbench';
import { mountPcap } from './pcap-engine';
import './pcap.css';

/** 抓包文件扩展名（打开入口判定用；后端另有魔数嗅探兜底） */
export const PCAP_EXTS = new Set(['pcap', 'pcapng', 'cap']);

export function isPcapName(name: string): boolean {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  return PCAP_EXTS.has(ext);
}

export function PcapTab({ tab }: TabProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const data = tab.data as {
      path?: string;
      sftp?: { serverId: string; remotePath: string };
      name?: string;
    };
    const name = data.name ?? tab.title;
    if (data.sftp) {
      return mountPcap(el, { path: data.sftp.remotePath, serverId: data.sftp.serverId, name });
    }
    return mountPcap(el, { path: String(data.path ?? ''), name });
    // tab 对象在标签存活期内 id/data 稳定,仅挂载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  return <div ref={rootRef} className="pcap-tab-root" />;
}

/* ---------- 外部入口(侧栏等模块直接 import;照 EditorTab openLocalFile/openRemoteFile 模式) ---------- */

/** 本地抓包文件在查看器中打开:tab id = pcap:<path>,同路径去重激活 */
export function openLocalPcap(path: string, name?: string): Tab | null {
  const display = name ?? path.split(/[\\/]/).pop() ?? path;
  return useWorkbench.getState().openTab({
    id: `pcap:${path}`,
    type: 'pcap',
    title: display,
    data: { path, name: display },
  });
}

/** 远端抓包文件在查看器中打开:tab id = pcap:sftp:<serverId>:<remotePath> */
export function openRemotePcap(
  serverId: string, remotePath: string, name?: string,
): Tab | null {
  const display = name ?? remotePath.split('/').filter(Boolean).pop() ?? remotePath;
  return useWorkbench.getState().openTab({
    id: `pcap:sftp:${serverId}:${remotePath}`,
    type: 'pcap',
    title: display,
    data: { sftp: { serverId, remotePath }, name: display },
  });
}
