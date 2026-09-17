/**
 * pcap / pcapng 二进制解析（全新实现，无 .proto 对照；纯前端解析，后端 pcap_read 只给 base64 字节）。
 * 产出统一的包记录序列：字节为整块文件 buffer 的子视图（不复制，128MB 级别下省内存）。
 * 支持：pcap（µs/ns × 大小端四种魔数）、pcapng（SHB 字节序 / IDB 多接口 linktype 与
 * if_tsresol 时间分辨率选项 / EPB / SPB）；pcapng 中遇到新 SHB 会重置接口表（多段拼接文件）。
 */
export interface PcapPacket {
  /** 0 起始序号（列表「编号」列显示 index+1） */
  index: number;
  /** 时间戳：秒 + 小数部分（统一归一为纳秒） */
  tsSec: number;
  tsNs: number;
  capLen: number;
  origLen: number;
  /** pcap 全局 linktype 或 pcapng 该包所属接口的 linktype */
  linkType: number;
  /** 包字节视图（指向文件 buffer 的子区间，不复制） */
  bytes: Uint8Array;
}

export interface PcapFile {
  format: 'pcap' | 'pcapng';
  packets: PcapPacket[];
}

/** base64 → Uint8Array（分块 atob，避免大文件一次性参数过多） */
export function base64ToBytes(b64: string): Uint8Array {
  const CHUNK = 0x8000;
  // 先解码成二进制串再转字节：atob 产物长度 = 字节数
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bin.length);
    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j);
  }
  return out;
}

/** 解析整个文件；非 pcap/pcapng 魔数或结构损坏时抛中文错误 */
export function parseCapture(buf: Uint8Array): PcapFile {
  if (buf.length < 4) throw new Error('文件太小，不是抓包文件');
  const b0 = buf[0];
  // pcapng SHB 块类型 0x0A0D0D0A（字节序无关）
  if (b0 === 0x0a && buf[1] === 0x0d && buf[2] === 0x0d && buf[3] === 0x0a) {
    return parsePcapNg(buf);
  }
  return parsePcap(buf);
}

/* ---------------- pcap ---------------- */

function parsePcap(buf: Uint8Array): PcapFile {
  if (buf.length < 24) throw new Error('pcap 全局头不完整（文件损坏）');
  const m = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
  let little: boolean;
  let nano: boolean;
  switch (m >>> 0) {
    case 0xd4c3b2a1: little = true; nano = false; break;
    case 0xa1b2c3d4: little = false; nano = false; break;
    case 0x4d3cb2a1: little = true; nano = true; break;
    case 0xa1b23c4d: little = false; nano = true; break;
    default: throw new Error('不是支持的抓包文件（仅 pcap/pcapng）');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const linkType = dv.getUint16(20, little);
  const packets: PcapPacket[] = [];
  let off = 24;
  while (off + 16 <= buf.length) {
    const tsSec = dv.getUint32(off, little);
    const frac = dv.getUint32(off + 4, little);
    const capLen = dv.getUint32(off + 8, little);
    const origLen = dv.getUint32(off + 12, little);
    off += 16;
    if (off + capLen > buf.length) break; // 尾部截断（抓包进程被杀常见），容忍
    packets.push({
      index: packets.length,
      tsSec,
      tsNs: nano ? frac : frac * 1000,
      capLen,
      origLen,
      linkType,
      bytes: buf.subarray(off, off + capLen),
    });
    off += capLen;
  }
  return { format: 'pcap', packets };
}

/* ---------------- pcapng ---------------- */

interface NgInterface {
  linkType: number;
  /** 时间戳单位对应的纳秒数（默认 µs → 1000） */
  nsPerUnit: number;
}

function parsePcapNg(buf: Uint8Array): PcapFile {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const packets: PcapPacket[] = [];
  let interfaces: NgInterface[] = [];
  let little = true;
  let off = 0;
  while (off + 12 <= buf.length) {
    // 块类型与块长度先按当前字节序读；SHB 需先定字节序
    let blockType = dv.getUint32(off, little);
    if (blockType === 0x0a0d0d0a) {
      // SHB：字节序魔数在块体前 4 字节（off+8）
      if (off + 28 > buf.length) break;
      const bom = dv.getUint32(off + 8, true);
      little = bom === 0x1a2b3c4d;
      if (!little && dv.getUint32(off + 8, false) !== 0x1a2b3c4d) break; // 两种序都对不上，损坏
      interfaces = []; // 新段重置接口表
    }
    const blockLen = dv.getUint32(off + 4, little);
    if (blockLen < 12 || off + blockLen > buf.length) break; // 尾部截断，容忍
    const body = off + 8;
    blockType = dv.getUint32(off, little);
    switch (blockType) {
      case 0x00000001: { // IDB
        if (blockLen >= 20) {
          const linkType = dv.getUint16(body, little);
          let nsPerUnit = 1000; // 默认 µs
          // 选项区：code(2)+len(2)+value(对齐 32bit)，找 if_tsresol(9)
          let opt = body + 8;
          const optEnd = off + blockLen - 4;
          while (opt + 4 <= optEnd) {
            const code = dv.getUint16(opt, little);
            const len = dv.getUint16(opt + 2, little);
            if (code === 0) break;
            if (code === 9 && len >= 1 && opt + 4 < optEnd) {
              const v = dv.getUint8(opt + 4);
              // 规范：MSB=0 → 分辨率 10^-v 秒；MSB=1 → 2^-(v&0x7f) 秒（换算为每单位纳秒数）
              nsPerUnit = v & 0x80 ? 1e9 / 2 ** (v & 0x7f) : 10 ** (9 - v);
            }
            opt += 4 + ((len + 3) & ~3);
          }
          interfaces.push({ linkType, nsPerUnit });
        }
        break;
      }
      case 0x00000006: { // EPB
        if (blockLen >= 32) {
          const ifId = dv.getUint32(body, little);
          const tsHigh = dv.getUint32(body + 4, little);
          const tsLow = dv.getUint32(body + 8, little);
          const capLen = dv.getUint32(body + 12, little);
          const origLen = dv.getUint32(body + 16, little);
          const dataOff = body + 20;
          if (dataOff + capLen <= off + blockLen - 4) {
            const ts = tsHigh * 2 ** 32 + tsLow;
            const iface = interfaces[ifId];
            const nsPerUnit = iface?.nsPerUnit ?? 1000;
            const totalNs = ts * nsPerUnit;
            packets.push({
              index: packets.length,
              tsSec: Math.floor(totalNs / 1e9),
              tsNs: Math.floor(totalNs % 1e9),
              capLen,
              origLen,
              linkType: iface?.linkType ?? 1,
              bytes: buf.subarray(dataOff, dataOff + capLen),
            });
          }
        }
        break;
      }
      case 0x00000003: { // SPB（无时间戳与接口信息，按接口 0 / 时间 0 处理）
        if (blockLen >= 16) {
          const origLen = dv.getUint32(body, little);
          const capLen = Math.min(origLen, blockLen - 16);
          packets.push({
            index: packets.length,
            tsSec: 0,
            tsNs: 0,
            capLen,
            origLen,
            linkType: interfaces[0]?.linkType ?? 1,
            bytes: buf.subarray(body + 4, body + 4 + capLen),
          });
        }
        break;
      }
      default: break; // 其余块（NRB/DSB/旧 PB 等）跳过
    }
    off += blockLen;
  }
  return { format: 'pcapng', packets };
}
