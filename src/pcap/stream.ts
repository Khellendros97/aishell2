/**
 * TCP/UDP 流重组（全新实现）：按五元组归一化 key（decode.ts 生成）聚合一整条流，
 * 按方向（0/1）拆分 payload 块，供流视图按方向着色展示。
 * TCP 按 seq 重组：乱序段排序、重传/重叠部分去重（仅保留首次到达的字节）；
 * UDP 无序号，按抓包时间顺序拼接。
 */
import type { PcapPacket } from './parser';
import type { DecodedPacket } from './decode';

export interface StreamChunk {
  /** 0 = key 中排序在前的一端发出；1 = 另一端 */
  dir: 0 | 1;
  data: Uint8Array;
}

export interface FollowStream {
  key: string;
  proto: 'TCP' | 'UDP';
  /** 端点描述：[dir0, dir1]，如 "10.0.0.1:51234" */
  endpoints: [string, string];
  chunks: StreamChunk[];
  /** 参与本流的包数 */
  packetCount: number;
  totalBytes: number;
}

interface Segment {
  seq: number;
  data: Uint8Array;
}

/** 单方向 TCP 重组：按 seq 排序后拼接，重叠/重传字节丢弃 */
function reassembleTcp(segs: Segment[]): Uint8Array {
  if (segs.length === 0) return new Uint8Array(0);
  const sorted = [...segs].sort((a, b) => a.seq - b.seq);
  const chunks: Uint8Array[] = [];
  let cursor = sorted[0].seq;
  let total = 0;
  for (const seg of sorted) {
    const end = seg.seq + seg.data.length;
    if (end <= cursor) continue; // 完全重传
    const start = Math.max(seg.seq, cursor);
    const piece = seg.data.subarray(start - seg.seq);
    chunks.push(piece);
    total += piece.length;
    cursor = end;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * 从全部包中重组指定流（streamKey 来自 DecodedPacket）。
 * packets 与 decoded 等长、按下标一一对应。
 */
export function buildStream(
  packets: PcapPacket[],
  decoded: (DecodedPacket | null)[],
  streamKey: string,
): FollowStream | null {
  const parts = streamKey.split(' ');
  if (parts.length !== 3) return null;
  const proto = parts[0] as 'TCP' | 'UDP';
  const endpoints: [string, string] = [parts[1], parts[2]];

  if (proto === 'TCP') {
    const dirs: [Segment[], Segment[]] = [[], []];
    let count = 0;
    for (let i = 0; i < packets.length; i++) {
      const d = decoded[i];
      if (!d || d.streamKey !== streamKey || d.payloadLen <= 0) continue;
      count++;
      dirs[d.streamDir ?? 0].push({
        seq: d.tcpSeq ?? 0,
        data: packets[i].bytes.subarray(d.payloadOffset, d.payloadOffset + d.payloadLen),
      });
    }
    if (count === 0) return { key: streamKey, proto, endpoints, chunks: [], packetCount: 0, totalBytes: 0 };
    const chunks: StreamChunk[] = [];
    let total = 0;
    for (const dir of [0, 1] as const) {
      const data = reassembleTcp(dirs[dir]);
      if (data.length > 0) {
        chunks.push({ dir, data });
        total += data.length;
      }
    }
    return { key: streamKey, proto, endpoints, chunks, packetCount: count, totalBytes: total };
  }

  // UDP：按抓包顺序逐包成块
  const chunks: StreamChunk[] = [];
  let total = 0;
  for (let i = 0; i < packets.length; i++) {
    const d = decoded[i];
    if (!d || d.streamKey !== streamKey || d.payloadLen <= 0) continue;
    const data = packets[i].bytes.subarray(d.payloadOffset, d.payloadOffset + d.payloadLen);
    chunks.push({ dir: d.streamDir ?? 0, data });
    total += data.length;
  }
  return { key: streamKey, proto, endpoints, chunks, packetCount: chunks.length, totalBytes: total };
}
