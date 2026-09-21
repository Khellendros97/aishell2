/**
 * 协议解码层（全新实现）：把 parser.ts 的包字节解码为分层协议树 + 列表列（源/目的/协议/Info）。
 * 链路层：Ethernet(1)/raw IP(101)/Linux SLL(113)/SLL2(276)/NULL(0)；
 * 网络层：IPv4/IPv6（含扩展头链跳过）/ARP；传输层：TCP/UDP/ICMP/ICMPv6；
 * 应用识别：DNS 解析、HTTP/TLS/SSH 按内容嗅探，其余常见端口按端口表提示。
 * 每个字段带 offset/len（相对包字节起始），供 hex 视图联动高亮。
 */
import type { PcapPacket } from './parser';

export interface ProtoField {
  name: string;
  value: string;
  /** 相对包字节起始 */
  offset: number;
  len: number;
  /** 过滤器字段名（Wireshark 风格，如 ip.src / dns.qry.name / radius.user_name）；空 = 不可作过滤条件 */
  filterKey?: string;
  /** 过滤表达式用的原始值（与显示值可能不同，如 TCP Flags 显示 "[SYN]"、过滤值 "0x02"）；空 = 用 value */
  filterValue?: string;
}

export interface ProtoLayer {
  name: string;
  offset: number;
  len: number;
  fields: ProtoField[];
}

export interface DecodedPacket {
  layers: ProtoLayer[];
  src: string;
  dst: string;
  /** 列表协议列（最高层识别协议，如 DNS/HTTP/TLS/RADIUS） */
  proto: string;
  /** 列表 Info 列摘要 */
  info: string;
  /** 帧编号（1 起始，过滤器 frame.number 用） */
  frameNumber: number;
  /** 线上原始长度（过滤器 frame.len 用） */
  frameLen: number;
  /** 链路层 MAC（仅 Ethernet 链路有值，过滤器 eth.src/dst/addr 用） */
  srcMac?: string;
  dstMac?: string;
  transport?: 'TCP' | 'UDP' | 'ICMP' | 'ICMPv6';
  ipVersion?: 4 | 6;
  srcIp?: string;
  dstIp?: string;
  srcPort?: number;
  dstPort?: number;
  tcpFlags?: number;
  tcpSeq?: number;
  tcpAck?: number;
  /** 应用 payload 在包字节中的区间（TCP/UDP 数据部分） */
  payloadOffset: number;
  payloadLen: number;
  /** 流五元组归一化 key（仅 TCP/UDP，两端点按字典序排列） */
  streamKey?: string;
  /** 0 = 本包 src 端点是 key 中排序在前的一端 */
  streamDir?: 0 | 1;
  hasDns?: boolean;
  appProto?: string;
  /** 过滤器字段汇总：filterKey → 本包全部取值（同名多值，如多个 RADIUS AVP）；由 decodePacket 从层树收集 */
  filterFields: Record<string, string[]>;
}

/** decode.ts 产出的全部过滤器字段名（filter.ts 通用字段分支据此校验未知字段报错） */
export const KNOWN_FILTER_FIELDS: ReadonlySet<string> = new Set([
  'eth.src', 'eth.dst', 'eth.type',
  'ip.src', 'ip.dst', 'ip.ttl', 'ip.proto', 'ip.id', 'ip.len',
  'ipv6.src', 'ipv6.dst', 'ipv6.hlim', 'ipv6.nxt',
  'tcp.srcport', 'tcp.dstport', 'tcp.seq', 'tcp.ack', 'tcp.flags', 'tcp.window',
  'udp.srcport', 'udp.dstport', 'udp.length',
  'icmp.type', 'icmp.code', 'icmpv6.type', 'icmpv6.code',
  'arp.opcode', 'arp.src.hw_mac', 'arp.src.proto_ipv4', 'arp.dst.hw_mac', 'arp.dst.proto_ipv4',
  'dns.id', 'dns.qry.name', 'dns.qry.type',
  'radius.code', 'radius.id', 'radius.length', 'radius.authenticator', 'radius.avp',
  'radius.user_name', 'radius.nas_ip_address', 'radius.nas_port', 'radius.framed_ip_address',
  'radius.reply_message', 'radius.called_station_id', 'radius.calling_station_id',
  'radius.acct_status_type', 'radius.acct_session_id', 'radius.nas_port_type', 'radius.nas_port_id',
]);

/* ---------------- 基础格式化 ---------------- */

function mac(b: Uint8Array, off: number): string {
  const p: string[] = [];
  for (let i = 0; i < 6; i++) p.push(b[off + i].toString(16).padStart(2, '0'));
  return p.join(':');
}

function ipv4(b: Uint8Array, off: number): string {
  return `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`;
}

function ipv6(b: Uint8Array, off: number): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((b[off + i * 2] << 8) | b[off + i * 2 + 1]);
  // 压缩最长的连续 0 段（长度 ≥2）
  let bestStart = -1, bestLen = 0, cur = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (cur < 0) cur = i;
      if (i - cur + 1 > bestLen) { bestStart = cur; bestLen = i - cur + 1; }
    } else cur = -1;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen >= 2 && bestStart >= 0) {
    const left = hex.slice(0, bestStart).join(':');
    const right = hex.slice(bestStart + bestLen).join(':');
    return `${left}::${right}`;
  }
  return hex.join(':');
}

/* ---------------- 端口 → 应用协议提示表 ---------------- */

const PORT_PROTO: Record<number, string> = {
  20: 'FTP', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  67: 'DHCP', 68: 'DHCP', 69: 'TFTP', 80: 'HTTP', 110: 'POP3', 123: 'NTP',
  143: 'IMAP', 161: 'SNMP', 389: 'LDAP', 443: 'TLS', 445: 'SMB',
  587: 'SMTP', 993: 'IMAPS', 995: 'POP3S', 1812: 'RADIUS', 1813: 'RADIUS',
  2375: 'Docker', 3306: 'MySQL',
  3389: 'RDP', 5432: 'PostgreSQL', 6379: 'Redis', 8080: 'HTTP', 8443: 'TLS',
  27017: 'MongoDB',
};

function portProto(sport: number | undefined, dport: number | undefined): string | undefined {
  if (sport !== undefined && PORT_PROTO[sport]) return PORT_PROTO[sport];
  if (dport !== undefined && PORT_PROTO[dport]) return PORT_PROTO[dport];
  return undefined;
}

/* ---------------- 应用层嗅探 ---------------- */

const HTTP_METHODS = ['GET ', 'POST ', 'PUT ', 'DELETE ', 'HEAD ', 'OPTIONS ', 'PATCH ', 'TRACE ', 'CONNECT '];

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && off + i < b.length; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

/** 返回 { proto, info } 或 null（未识别） */
function sniffApp(b: Uint8Array, off: number, len: number): { proto: string; info: string } | null {
  if (len <= 0) return null;
  const head = ascii(b, off, Math.min(len, 8));
  for (const m of HTTP_METHODS) {
    if (head.startsWith(m)) {
      const line = ascii(b, off, Math.min(len, 128)).split('\r\n')[0];
      return { proto: 'HTTP', info: line };
    }
  }
  if (head.startsWith('HTTP/')) {
    const line = ascii(b, off, Math.min(len, 128)).split('\r\n')[0];
    return { proto: 'HTTP', info: line };
  }
  if (head.startsWith('SSH-')) {
    return { proto: 'SSH', info: ascii(b, off, Math.min(len, 64)).split('\r\n')[0] };
  }
  // TLS record：content type 20-23 + 版本 0x0301-0x0304
  if (len >= 5 && b[off] >= 20 && b[off] <= 23 && b[off + 1] === 3 && b[off + 2] <= 4) {
    const types: Record<number, string> = { 20: 'Change Cipher Spec', 21: 'Alert', 22: 'Handshake', 23: 'Application Data' };
    let info = types[b[off]] ?? 'Record';
    if (b[off] === 22 && len >= 6) {
      const hs = b[off + 5];
      if (hs === 1) info = 'Client Hello';
      else if (hs === 2) info = 'Server Hello';
      else info = `Handshake (${hs})`;
    }
    return { proto: 'TLS', info };
  }
  return null;
}

/* ---------------- DNS ---------------- */

/** 解析 DNS 名（含压缩指针），返回 [名字, 消耗字节数(不含指针跳转)] */
function dnsName(b: Uint8Array, off: number, depth = 0): [string, number] {
  const parts: string[] = [];
  let pos = off;
  let consumed = 0;
  let jumped = false;
  while (depth < 20 && pos < b.length) {
    const len = b[pos];
    if (len === 0) { if (!jumped) consumed += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | b[pos + 1];
      if (!jumped) consumed += 2;
      const [suffix] = dnsName(b, ptr, depth + 1);
      if (suffix) parts.push(suffix);
      return [parts.join('.'), consumed];
    }
    parts.push(ascii(b, pos + 1, len));
    pos += 1 + len;
    if (!jumped) consumed += 1 + len;
  }
  return [parts.join('.'), consumed];
}

const DNS_QTYPE: Record<number, string> = {
  1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT',
  28: 'AAAA', 33: 'SRV', 65: 'HTTPS', 255: 'ANY', 257: 'CAA',
};

function decodeDns(
  b: Uint8Array, off: number, len: number, layerOff: number,
): { layer: ProtoLayer; info: string } | null {
  if (len < 12 || off + 12 > b.length) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const id = dv.getUint16(off);
  const flags = dv.getUint16(off + 2);
  const qr = (flags >> 15) & 1;
  const rcode = flags & 0xf;
  const qd = dv.getUint16(off + 4);
  const an = dv.getUint16(off + 6);
  const fields: ProtoField[] = [
    {
      name: 'Transaction ID', value: `0x${id.toString(16).padStart(4, '0')}`, offset: layerOff, len: 2,
      filterKey: 'dns.id',
    },
    { name: 'Flags', value: qr ? '响应' : '查询', offset: layerOff + 2, len: 2 },
    { name: 'Questions', value: String(qd), offset: layerOff + 4, len: 2 },
    { name: 'Answer RRs', value: String(an), offset: layerOff + 6, len: 2 },
  ];
  let qname = '';
  let qtype = '';
  if (qd > 0 && off + 12 < b.length) {
    const [name, used] = dnsName(b, off + 12);
    qname = name;
    if (off + 12 + used + 4 <= b.length) {
      const qt = dv.getUint16(off + 12 + used);
      qtype = DNS_QTYPE[qt] ?? `TYPE${qt}`;
      fields.push(
        { name: 'Query Name', value: name, offset: layerOff + 12, len: used, filterKey: 'dns.qry.name' },
        { name: 'Query Type', value: qtype, offset: layerOff + 12 + used, len: 2, filterKey: 'dns.qry.type' },
      );
    }
  }
  const info = qr
    ? `Standard query response 0x${id.toString(16).padStart(4, '0')}${rcode ? ` (${rcode})` : ''} ${qtype} ${qname}`.trim()
    : `Standard query 0x${id.toString(16).padStart(4, '0')} ${qtype} ${qname}`.trim();
  return { layer: { name: 'Domain Name System', offset: layerOff, len, fields }, info };
}

/* ---------------- RADIUS ---------------- */

const RADIUS_PORTS = new Set([1645, 1646, 1812, 1813]);

const RADIUS_CODES: Record<number, string> = {
  1: 'Access-Request', 2: 'Access-Accept', 3: 'Access-Reject',
  4: 'Accounting-Request', 5: 'Accounting-Response', 11: 'Access-Challenge',
  12: 'Status-Server', 13: 'Status-Client',
  40: 'Disconnect-Request', 41: 'Disconnect-ACK', 42: 'Disconnect-NAK',
  43: 'CoA-Request', 44: 'CoA-ACK', 45: 'CoA-NAK',
};

/** 常见 AVP：类型 → 名称与值解析方式 */
const RADIUS_AVP: Record<number, { name: string; kind: 'text' | 'ipv4' | 'int' | 'hex' }> = {
  1: { name: 'User-Name', kind: 'text' },
  2: { name: 'User-Password', kind: 'hex' },
  4: { name: 'NAS-IP-Address', kind: 'ipv4' },
  5: { name: 'NAS-Port', kind: 'int' },
  8: { name: 'Framed-IP-Address', kind: 'ipv4' },
  18: { name: 'Reply-Message', kind: 'text' },
  26: { name: 'Vendor-Specific', kind: 'hex' },
  30: { name: 'Called-Station-Id', kind: 'text' },
  31: { name: 'Calling-Station-Id', kind: 'text' },
  40: { name: 'Acct-Status-Type', kind: 'int' },
  44: { name: 'Acct-Session-Id', kind: 'text' },
  61: { name: 'NAS-Port-Type', kind: 'int' },
  79: { name: 'EAP-Message', kind: 'hex' },
  80: { name: 'Message-Authenticator', kind: 'hex' },
  87: { name: 'NAS-Port-Id', kind: 'text' },
};

const RADIUS_ACCT_STATUS: Record<number, string> = {
  1: 'Start', 2: 'Stop', 3: 'Interim-Update', 7: 'Accounting-On', 8: 'Accounting-Off',
};

function hexBytes(b: Uint8Array, off: number, len: number): string {
  const p: string[] = [];
  for (let i = 0; i < len && off + i < b.length; i++) p.push(b[off + i].toString(16).padStart(2, '0'));
  return p.join('');
}

/** 冒号分隔十六进制（Wireshark 字节串过滤值的惯例形态，如 radius.avp == 01:0a:79:…） */
function colonHex(b: Uint8Array, off: number, len: number): string {
  const p: string[] = [];
  for (let i = 0; i < len && off + i < b.length; i++) p.push(b[off + i].toString(16).padStart(2, '0'));
  return p.join(':');
}

/** RADIUS 解码：端口命中（1645/1646/1812/1813）后按结构校验——code 已知且 Length 字段自洽才算数 */
function decodeRadius(
  b: Uint8Array, off: number, len: number, layerOff: number,
): { layer: ProtoLayer; info: string } | null {
  if (len < 20 || off + 20 > b.length) return null;
  const code = b[off];
  const codeName = RADIUS_CODES[code];
  if (!codeName) return null;
  const declared = (b[off + 2] << 8) | b[off + 3];
  if (declared < 20 || declared > len || off + declared > b.length) return null;
  const id = b[off + 1];
  const fields: ProtoField[] = [
    {
      name: 'Code', value: `${codeName} (${code})`, offset: layerOff, len: 1,
      filterKey: 'radius.code', filterValue: String(code),
    },
    {
      name: 'Identifier', value: `0x${id.toString(16).padStart(2, '0')}`, offset: layerOff + 1, len: 1,
      filterKey: 'radius.id', filterValue: String(id),
    },
    { name: 'Length', value: String(declared), offset: layerOff + 2, len: 2, filterKey: 'radius.length' },
    {
      name: 'Authenticator', value: hexBytes(b, off + 4, 16), offset: layerOff + 4, len: 16,
      filterKey: 'radius.authenticator', filterValue: colonHex(b, off + 4, 16),
    },
  ];
  let userName = '';
  let acctStatus = '';
  let pos = off + 20;
  const end = off + declared;
  while (pos + 2 <= end) {
    const atype = b[pos];
    const alen = b[pos + 1];
    if (alen < 2 || pos + alen > end) break; // AVP 损坏即停，已解析部分仍展示
    const vlen = alen - 2;
    const meta = RADIUS_AVP[atype];
    let value: string;
    let filterValue: string | undefined;
    switch (meta?.kind) {
      case 'text': value = ascii(b, pos + 2, vlen); break;
      case 'ipv4': value = vlen === 4 ? ipv4(b, pos + 2) : hexBytes(b, pos + 2, vlen); break;
      case 'int': {
        let v = 0;
        for (let i = 0; i < vlen && i < 4; i++) v = v * 256 + b[pos + 2 + i];
        value = atype === 40 ? `${RADIUS_ACCT_STATUS[v] ?? v} (${v})` : String(v);
        filterValue = String(v);
        break;
      }
      default: value = hexBytes(b, pos + 2, vlen); break;
    }
    // 属性级过滤键（radius.user_name 等）；未收录的属性类型以整体字节进 radius.avp（照 Wireshark 惯例）
    const avpKey = meta ? `radius.${meta.name.toLowerCase().replace(/-/g, '_')}` : undefined;
    fields.push({
      name: `AVP: ${meta?.name ?? `Type ${atype}`}`,
      value,
      offset: layerOff + (pos - off),
      len: alen,
      filterKey: avpKey ?? 'radius.avp',
      filterValue: avpKey ? (filterValue ?? value) : colonHex(b, pos, alen),
    });
    if (atype === 1) userName = value;
    if (atype === 40) acctStatus = value;
    pos += alen;
  }
  const extra = userName ? ` ${userName}` : acctStatus ? ` ${acctStatus}` : '';
  return {
    layer: { name: 'RADIUS Protocol', offset: layerOff, len: declared, fields },
    info: `${codeName}(${code}) id=0x${id.toString(16).padStart(2, '0')}${extra}`,
  };
}

/* ---------------- 传输层 ---------------- */

const TCP_FLAG_BITS: Array<[number, string]> = [
  [0x01, 'FIN'], [0x02, 'SYN'], [0x04, 'RST'], [0x08, 'PSH'],
  [0x10, 'ACK'], [0x20, 'URG'], [0x40, 'ECE'], [0x80, 'CWR'],
];

function tcpFlagsStr(flags: number): string {
  const on = TCP_FLAG_BITS.filter(([bit]) => flags & bit).map(([, n]) => n);
  return on.length ? `[${on.join(',')}]` : '[]';
}

const ICMP_TYPES: Record<number, string> = {
  0: 'Echo (ping) reply', 3: 'Destination unreachable', 4: 'Source quench',
  5: 'Redirect', 8: 'Echo (ping) request', 11: 'Time-to-live exceeded',
  12: 'Parameter problem', 13: 'Timestamp request', 14: 'Timestamp reply',
};

const ICMPV6_TYPES: Record<number, string> = {
  1: 'Destination unreachable', 2: 'Packet too big', 3: 'Time exceeded',
  128: 'Echo request', 129: 'Echo reply', 133: 'Router Solicitation',
  134: 'Router Advertisement', 135: 'Neighbor Solicitation', 136: 'Neighbor Advertisement',
};

/* ---------------- 主解码 ---------------- */

/** 解码入口：内层产出层树与列表列后，这里从层树字段收集 filterFields（filter.ts 通用字段分支用） */
export function decodePacket(pkt: PcapPacket): DecodedPacket {
  const out = decodePacketInner(pkt);
  const map: Record<string, string[]> = {};
  for (const layer of out.layers) {
    for (const f of layer.fields) {
      if (!f.filterKey) continue;
      (map[f.filterKey] ??= []).push(f.filterValue ?? f.value);
    }
  }
  out.filterFields = map;
  return out;
}

function decodePacketInner(pkt: PcapPacket): DecodedPacket {
  const b = pkt.bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const layers: ProtoLayer[] = [];
  const out: DecodedPacket = {
    layers, src: '', dst: '', proto: 'DATA', info: '',
    frameNumber: pkt.index + 1, frameLen: pkt.origLen,
    payloadOffset: 0, payloadLen: 0,
    filterFields: {},
  };

  let ethType = 0;
  let off = 0;

  /* ---- 链路层 ---- */
  switch (pkt.linkType) {
    case 1: { // Ethernet
      if (b.length < 14) break;
      const dstMac = mac(b, 0);
      const srcMac = mac(b, 6);
      ethType = dv.getUint16(12);
      let hdrLen = 14;
      if (ethType === 0x8100 || ethType === 0x88a8) { // VLAN / QinQ
        if (b.length < 18) break;
        ethType = dv.getUint16(16);
        hdrLen = 18;
      }
      layers.push({
        name: `Ethernet II${hdrLen === 18 ? ' (802.1Q VLAN)' : ''}`,
        offset: 0, len: hdrLen,
        fields: [
          { name: 'Destination', value: dstMac, offset: 0, len: 6, filterKey: 'eth.dst' },
          { name: 'Source', value: srcMac, offset: 6, len: 6, filterKey: 'eth.src' },
          { name: 'Type', value: `0x${ethType.toString(16).padStart(4, '0')}`, offset: hdrLen - 2, len: 2, filterKey: 'eth.type' },
        ],
      });
      out.src = srcMac;
      out.dst = dstMac;
      out.srcMac = srcMac;
      out.dstMac = dstMac;
      off = hdrLen;
      break;
    }
    case 113: { // Linux cooked (SLL)
      if (b.length < 16) break;
      ethType = dv.getUint16(14);
      layers.push({
        name: 'Linux cooked capture', offset: 0, len: 16,
        fields: [
          { name: 'Packet type', value: String(dv.getUint16(0)), offset: 0, len: 2 },
          { name: 'Link-layer address type', value: String(dv.getUint16(2)), offset: 2, len: 2 },
          { name: 'Protocol', value: `0x${ethType.toString(16).padStart(4, '0')}`, offset: 14, len: 2 },
        ],
      });
      off = 16;
      break;
    }
    case 276: { // Linux cooked v2 (SLL2)
      if (b.length < 20) break;
      ethType = dv.getUint16(0);
      layers.push({
        name: 'Linux cooked capture v2', offset: 0, len: 20,
        fields: [
          { name: 'Protocol', value: `0x${ethType.toString(16).padStart(4, '0')}`, offset: 0, len: 2 },
          { name: 'Interface index', value: String(dv.getUint32(4)), offset: 4, len: 4 },
          { name: 'Packet type', value: String(b[9]), offset: 9, len: 1 },
        ],
      });
      off = 20;
      break;
    }
    case 0: { // BSD loopback NULL：4 字节地址族（本机字节序，两种序都试）
      if (b.length < 4) break;
      let fam = dv.getUint32(0, true);
      if (fam !== 2 && fam !== 24 && fam !== 28 && fam !== 30) fam = dv.getUint32(0, false);
      ethType = fam === 2 ? 0x0800 : 0x86dd;
      layers.push({
        name: 'Null/Loopback', offset: 0, len: 4,
        fields: [{ name: 'Family', value: fam === 2 ? 'AF_INET' : 'AF_INET6', offset: 0, len: 4 }],
      });
      off = 4;
      break;
    }
    case 101: { // raw IP：直接以 IP 头开始
      if (b.length < 1) break;
      ethType = (b[0] >> 4) === 6 ? 0x86dd : 0x0800;
      off = 0;
      break;
    }
    default: {
      // 未知链路类型：整包作为原始数据层
      layers.push({
        name: `Raw data (linktype ${pkt.linkType})`, offset: 0, len: b.length,
        fields: [{ name: 'Data', value: `${b.length} bytes`, offset: 0, len: b.length }],
      });
      out.proto = 'DATA';
      out.info = `linktype ${pkt.linkType}, ${b.length} bytes`;
      out.payloadOffset = 0;
      out.payloadLen = b.length;
      return out;
    }
  }

  /* ---- 网络层 ---- */
  if (ethType === 0x0806) { // ARP
    if (b.length >= off + 28) {
      const oper = dv.getUint16(off + 6);
      const sha = mac(b, off + 8);
      const spa = ipv4(b, off + 14);
      const tha = mac(b, off + 18);
      const tpa = ipv4(b, off + 24);
      layers.push({
        name: 'Address Resolution Protocol', offset: off, len: 28,
        fields: [
          { name: 'Hardware type', value: String(dv.getUint16(off)), offset: off, len: 2 },
          { name: 'Protocol type', value: `0x${dv.getUint16(off + 2).toString(16).padStart(4, '0')}`, offset: off + 2, len: 2 },
          {
            name: 'Opcode',
            value: oper === 1 ? 'request (1)' : oper === 2 ? 'reply (2)' : String(oper),
            offset: off + 6, len: 2, filterKey: 'arp.opcode', filterValue: String(oper),
          },
          { name: 'Sender MAC', value: sha, offset: off + 8, len: 6, filterKey: 'arp.src.hw_mac' },
          { name: 'Sender IP', value: spa, offset: off + 14, len: 4, filterKey: 'arp.src.proto_ipv4' },
          { name: 'Target MAC', value: tha, offset: off + 18, len: 6, filterKey: 'arp.dst.hw_mac' },
          { name: 'Target IP', value: tpa, offset: off + 24, len: 4, filterKey: 'arp.dst.proto_ipv4' },
        ],
      });
      out.proto = 'ARP';
      out.src = spa;
      out.dst = tpa;
      out.srcIp = spa;
      out.dstIp = tpa;
      out.info = oper === 1
        ? (spa === tpa ? `Gratuitous ARP for ${spa}` : `Who has ${tpa}? Tell ${spa}`)
        : oper === 2 ? `${spa} is at ${sha}` : `ARP opcode ${oper}`;
      out.payloadOffset = off + 28;
      out.payloadLen = Math.max(0, b.length - off - 28);
    }
    return out;
  }

  let ipProto = -1;
  let ipEnd = off;
  if (ethType === 0x0800) { // IPv4
    if (b.length < off + 20) return out;
    const ihl = (b[off] & 0x0f) * 4;
    if (ihl < 20 || b.length < off + ihl) return out;
    const totalLen = dv.getUint16(off + 2);
    ipProto = b[off + 9];
    const srcIp = ipv4(b, off + 12);
    const dstIp = ipv4(b, off + 16);
    layers.push({
      name: 'Internet Protocol Version 4', offset: off, len: ihl,
      fields: [
        { name: 'Version / Header Length', value: `4 / ${ihl} bytes`, offset: off, len: 1 },
        { name: 'Total Length', value: String(totalLen), offset: off + 2, len: 2, filterKey: 'ip.len' },
        { name: 'Identification', value: `0x${dv.getUint16(off + 4).toString(16).padStart(4, '0')}`, offset: off + 4, len: 2, filterKey: 'ip.id' },
        { name: 'Flags / Fragment Offset', value: `0x${dv.getUint16(off + 6).toString(16).padStart(4, '0')}`, offset: off + 6, len: 2 },
        { name: 'Time to Live', value: String(b[off + 8]), offset: off + 8, len: 1, filterKey: 'ip.ttl' },
        { name: 'Protocol', value: String(ipProto), offset: off + 9, len: 1, filterKey: 'ip.proto' },
        { name: 'Source Address', value: srcIp, offset: off + 12, len: 4, filterKey: 'ip.src' },
        { name: 'Destination Address', value: dstIp, offset: off + 16, len: 4, filterKey: 'ip.dst' },
      ],
    });
    out.ipVersion = 4;
    out.src = srcIp;
    out.dst = dstIp;
    out.srcIp = srcIp;
    out.dstIp = dstIp;
    ipEnd = off + ihl;
  } else if (ethType === 0x86dd) { // IPv6
    if (b.length < off + 40) return out;
    const payloadLen = dv.getUint16(off + 4);
    const srcIp = ipv6(b, off + 8);
    const dstIp = ipv6(b, off + 24);
    layers.push({
      name: 'Internet Protocol Version 6', offset: off, len: 40,
      fields: [
        { name: 'Payload Length', value: String(payloadLen), offset: off + 4, len: 2 },
        { name: 'Next Header', value: String(b[off + 6]), offset: off + 6, len: 1, filterKey: 'ipv6.nxt' },
        { name: 'Hop Limit', value: String(b[off + 7]), offset: off + 7, len: 1, filterKey: 'ipv6.hlim' },
        { name: 'Source Address', value: srcIp, offset: off + 8, len: 16, filterKey: 'ipv6.src' },
        { name: 'Destination Address', value: dstIp, offset: off + 24, len: 16, filterKey: 'ipv6.dst' },
      ],
    });
    out.ipVersion = 6;
    out.src = srcIp;
    out.dst = dstIp;
    out.srcIp = srcIp;
    out.dstIp = dstIp;
    ipProto = b[off + 6];
    ipEnd = off + 40;
    // 扩展头链：hop-by-hop(0)/routing(43)/dest-opts(60) 长度 (n+1)*8；fragment(44) 8；AH(51) (n+2)*4
    let guard = 0;
    while (guard++ < 8) {
      if (ipProto === 0 || ipProto === 43 || ipProto === 60) {
        if (b.length < ipEnd + 2) return out;
        const next = b[ipEnd];
        const extLen = (b[ipEnd + 1] + 1) * 8;
        layers.push({ name: 'IPv6 Extension Header', offset: ipEnd, len: extLen, fields: [{ name: 'Next Header', value: String(next), offset: ipEnd, len: 1 }] });
        ipProto = next;
        ipEnd += extLen;
      } else if (ipProto === 44) {
        if (b.length < ipEnd + 8) return out;
        const next = b[ipEnd];
        layers.push({ name: 'IPv6 Fragment Header', offset: ipEnd, len: 8, fields: [{ name: 'Next Header', value: String(next), offset: ipEnd, len: 1 }] });
        ipProto = next;
        ipEnd += 8;
      } else if (ipProto === 51) {
        if (b.length < ipEnd + 2) return out;
        const next = b[ipEnd];
        const extLen = (b[ipEnd + 1] + 2) * 4;
        layers.push({ name: 'IPv6 AH Header', offset: ipEnd, len: extLen, fields: [{ name: 'Next Header', value: String(next), offset: ipEnd, len: 1 }] });
        ipProto = next;
        ipEnd += extLen;
      } else break;
    }
  } else {
    // 未识别 ethertype：剩余作为数据
    out.proto = `0x${ethType.toString(16).padStart(4, '0')}`;
    out.info = `EtherType 0x${ethType.toString(16).padStart(4, '0')}, ${b.length - off} bytes`;
    out.payloadOffset = off;
    out.payloadLen = Math.max(0, b.length - off);
    return out;
  }

  /* ---- 传输层 ---- */
  if (ipProto === 6 && b.length >= ipEnd + 20) { // TCP
    const sport = dv.getUint16(ipEnd);
    const dport = dv.getUint16(ipEnd + 2);
    const seq = dv.getUint32(ipEnd + 4);
    const ack = dv.getUint32(ipEnd + 8);
    const dataOff = (b[ipEnd + 12] >> 4) * 4;
    const flags = b[ipEnd + 13];
    const win = dv.getUint16(ipEnd + 14);
    const hdrLen = Math.max(20, dataOff);
    const payloadOff = ipEnd + hdrLen;
    const payloadLen = Math.max(0, b.length - payloadOff);
    layers.push({
      name: 'Transmission Control Protocol', offset: ipEnd, len: Math.min(hdrLen, b.length - ipEnd),
      fields: [
        { name: 'Source Port', value: String(sport), offset: ipEnd, len: 2, filterKey: 'tcp.srcport' },
        { name: 'Destination Port', value: String(dport), offset: ipEnd + 2, len: 2, filterKey: 'tcp.dstport' },
        { name: 'Sequence Number', value: String(seq), offset: ipEnd + 4, len: 4, filterKey: 'tcp.seq' },
        { name: 'Acknowledgment Number', value: String(ack), offset: ipEnd + 8, len: 4, filterKey: 'tcp.ack' },
        { name: 'Header Length', value: `${hdrLen} bytes`, offset: ipEnd + 12, len: 1 },
        {
          name: 'Flags', value: tcpFlagsStr(flags), offset: ipEnd + 13, len: 1,
          filterKey: 'tcp.flags', filterValue: `0x${flags.toString(16).padStart(2, '0')}`,
        },
        { name: 'Window', value: String(win), offset: ipEnd + 14, len: 2, filterKey: 'tcp.window' },
        { name: 'Checksum', value: `0x${dv.getUint16(ipEnd + 16).toString(16).padStart(4, '0')}`, offset: ipEnd + 16, len: 2 },
      ],
    });
    out.transport = 'TCP';
    out.srcPort = sport;
    out.dstPort = dport;
    out.tcpFlags = flags;
    out.tcpSeq = seq;
    out.tcpAck = ack;
    out.payloadOffset = payloadOff;
    out.payloadLen = payloadLen;
    out.src = out.srcIp ?? '';
    out.dst = out.dstIp ?? '';

    // 应用层：DNS(53) 内容解析优先，其次内容嗅探，最后端口表
    let appInfo = '';
    if ((sport === 53 || dport === 53) && payloadLen >= 12) {
      const dns = decodeDns(b, payloadOff, payloadLen, payloadOff);
      if (dns) {
        layers.push(dns.layer);
        out.appProto = 'DNS';
        out.hasDns = true;
        appInfo = dns.info;
      }
    }
    if (!out.appProto && payloadLen > 0) {
      const sniff = sniffApp(b, payloadOff, payloadLen);
      if (sniff) {
        out.appProto = sniff.proto;
        appInfo = sniff.info;
        layers.push({ name: sniff.proto === 'HTTP' ? 'Hypertext Transfer Protocol' : sniff.proto === 'TLS' ? 'Transport Layer Security' : 'SSH Protocol', offset: payloadOff, len: payloadLen, fields: [{ name: 'Data', value: `${payloadLen} bytes`, offset: payloadOff, len: payloadLen }] });
      }
    }
    if (!out.appProto) out.appProto = payloadLen > 0 ? portProto(sport, dport) : undefined;
    out.proto = out.appProto ?? 'TCP';
    out.info = appInfo || `${sport} → ${dport} ${tcpFlagsStr(flags)} Seq=${seq} Ack=${ack} Len=${payloadLen}`;
    // 流 key：两端点按字典序排列
    const a = `${out.srcIp}:${sport}`;
    const c = `${out.dstIp}:${dport}`;
    out.streamKey = a <= c ? `TCP ${a} ${c}` : `TCP ${c} ${a}`;
    out.streamDir = a <= c ? 0 : 1;
    return out;
  }

  if (ipProto === 17 && b.length >= ipEnd + 8) { // UDP
    const sport = dv.getUint16(ipEnd);
    const dport = dv.getUint16(ipEnd + 2);
    const udpLen = dv.getUint16(ipEnd + 4);
    const payloadOff = ipEnd + 8;
    const payloadLen = Math.max(0, Math.min(udpLen - 8, b.length - payloadOff));
    layers.push({
      name: 'User Datagram Protocol', offset: ipEnd, len: 8,
      fields: [
        { name: 'Source Port', value: String(sport), offset: ipEnd, len: 2, filterKey: 'udp.srcport' },
        { name: 'Destination Port', value: String(dport), offset: ipEnd + 2, len: 2, filterKey: 'udp.dstport' },
        { name: 'Length', value: String(udpLen), offset: ipEnd + 4, len: 2, filterKey: 'udp.length' },
        { name: 'Checksum', value: `0x${dv.getUint16(ipEnd + 6).toString(16).padStart(4, '0')}`, offset: ipEnd + 6, len: 2 },
      ],
    });
    out.transport = 'UDP';
    out.srcPort = sport;
    out.dstPort = dport;
    out.payloadOffset = payloadOff;
    out.payloadLen = payloadLen;
    let appInfo = '';
    // RADIUS：端口命中 1645/1646/1812/1813 时先试 RADIUS（结构校验不通过则落空继续其它识别）
    if ((RADIUS_PORTS.has(sport) || RADIUS_PORTS.has(dport)) && payloadLen >= 20) {
      const radius = decodeRadius(b, payloadOff, payloadLen, payloadOff);
      if (radius) {
        layers.push(radius.layer);
        out.appProto = 'RADIUS';
        appInfo = radius.info;
      }
    }
    if (!out.appProto && (sport === 53 || dport === 53) && payloadLen >= 12) {
      const dns = decodeDns(b, payloadOff, payloadLen, payloadOff);
      if (dns) {
        layers.push(dns.layer);
        out.appProto = 'DNS';
        out.hasDns = true;
        appInfo = dns.info;
      }
    }
    if (!out.appProto && payloadLen > 0) {
      const sniff = sniffApp(b, payloadOff, payloadLen);
      if (sniff) { out.appProto = sniff.proto; appInfo = sniff.info; }
    }
    if (!out.appProto) out.appProto = portProto(sport, dport);
    out.proto = out.appProto ?? 'UDP';
    out.info = appInfo || `${sport} → ${dport} Len=${payloadLen}`;
    const a = `${out.srcIp}:${sport}`;
    const c = `${out.dstIp}:${dport}`;
    out.streamKey = a <= c ? `UDP ${a} ${c}` : `UDP ${c} ${a}`;
    out.streamDir = a <= c ? 0 : 1;
    return out;
  }

  if (ipProto === 1 && b.length >= ipEnd + 4) { // ICMP
    const type = b[ipEnd];
    const code = b[ipEnd + 1];
    layers.push({
      name: 'Internet Control Message Protocol', offset: ipEnd, len: Math.min(b.length - ipEnd, 8),
      fields: [
        {
          name: 'Type', value: `${type} (${ICMP_TYPES[type] ?? 'unknown'})`, offset: ipEnd, len: 1,
          filterKey: 'icmp.type', filterValue: String(type),
        },
        { name: 'Code', value: String(code), offset: ipEnd + 1, len: 1, filterKey: 'icmp.code' },
        { name: 'Checksum', value: `0x${dv.getUint16(ipEnd + 2).toString(16).padStart(4, '0')}`, offset: ipEnd + 2, len: 2 },
      ],
    });
    out.transport = 'ICMP';
    out.proto = 'ICMP';
    out.info = ICMP_TYPES[type] ?? `ICMP type ${type}`;
    out.payloadOffset = ipEnd + 4;
    out.payloadLen = Math.max(0, b.length - ipEnd - 4);
    return out;
  }

  if (ipProto === 58 && b.length >= ipEnd + 4) { // ICMPv6
    const type = b[ipEnd];
    layers.push({
      name: 'Internet Control Message Protocol v6', offset: ipEnd, len: Math.min(b.length - ipEnd, 8),
      fields: [
        {
          name: 'Type', value: `${type} (${ICMPV6_TYPES[type] ?? 'unknown'})`, offset: ipEnd, len: 1,
          filterKey: 'icmpv6.type', filterValue: String(type),
        },
        { name: 'Code', value: String(b[ipEnd + 1]), offset: ipEnd + 1, len: 1, filterKey: 'icmpv6.code' },
      ],
    });
    out.transport = 'ICMPv6';
    out.proto = 'ICMPv6';
    out.info = ICMPV6_TYPES[type] ?? `ICMPv6 type ${type}`;
    out.payloadOffset = ipEnd + 4;
    out.payloadLen = Math.max(0, b.length - ipEnd - 4);
    return out;
  }

  // 其它 IP 协议（GRE/ESP/IGMP…）
  out.proto = out.ipVersion === 6 ? `IPv6-${ipProto}` : `IP-${ipProto}`;
  out.info = `IP protocol ${ipProto}, ${b.length - ipEnd} bytes`;
  out.payloadOffset = ipEnd;
  out.payloadLen = Math.max(0, b.length - ipEnd);
  return out;
}
