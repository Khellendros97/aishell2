// pcap 解析层自测（合成 pcap/pcapng 字节，验证 parser/decode/filter/stream 端到端）
import { parseCapture, base64ToBytes } from '../src/pcap/parser.ts';
import { decodePacket } from '../src/pcap/decode.ts';
import { compileFilter } from '../src/pcap/filter.ts';
import { buildStream } from '../src/pcap/stream.ts';

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else { failures++; console.error(`FAIL  ${msg}`); }
}

/* ---- 构造包字节 ---- */
// Ethernet + IPv4 + TCP: 10.0.0.1:51234 → 10.0.0.2:443 SYN seq=1000
function tcpSynPacket() {
  const b = [];
  b.push(0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff); // dst mac
  b.push(0x11, 0x22, 0x33, 0x44, 0x55, 0x66); // src mac
  b.push(0x08, 0x00); // IPv4
  // IPv4 header (20B)
  b.push(0x45, 0x00, 0x00, 40, 0x00, 0x01, 0x40, 0x00, 64, 6, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2);
  // TCP header (20B): sport 51234 dport 443 seq 1000 ack 0 off 5 flags SYN(0x02) win 65535
  b.push(0xc8, 0x22, 0x01, 0xbb, 0, 0, 0x03, 0xe8, 0, 0, 0, 0, 0x50, 0x02, 0xff, 0xff, 0, 0, 0, 0);
  return Uint8Array.from(b);
}
// Ethernet + IPv4 + TCP: 10.0.0.2:443 → 10.0.0.1:51234 PSH,ACK + payload "GET / HTTP/1.1\r\n\r\n"
function tcpDataPacket() {
  const payload = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  const b = [];
  b.push(0x11, 0x22, 0x33, 0x44, 0x55, 0x66);
  b.push(0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff);
  b.push(0x08, 0x00);
  const total = 20 + 20 + payload.length;
  b.push(0x45, 0x00, total >> 8, total & 0xff, 0x00, 0x02, 0x40, 0x00, 64, 6, 0, 0, 10, 0, 0, 2, 10, 0, 0, 1);
  b.push(0x01, 0xbb, 0xc8, 0x22, 0, 0, 0x10, 0x00, 0, 0, 0x03, 0xe9, 0x50, 0x18, 0xff, 0xff, 0, 0, 0, 0);
  return Uint8Array.from([...b, ...payload]);
}
// Ethernet + IPv4 + UDP + DNS query: 10.0.0.1:53333 → 8.8.8.8:53 "www.example.com A"
function dnsPacket() {
  const qname = [];
  for (const part of ['www', 'example', 'com']) {
    qname.push(part.length, ...[...part].map((c) => c.charCodeAt(0)));
  }
  qname.push(0);
  const dns = [
    0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...qname, 0x00, 0x01, 0x00, 0x01,
  ];
  const udpLen = 8 + dns.length;
  const total = 20 + udpLen;
  const b = [];
  b.push(0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x08, 0x00);
  b.push(0x45, 0x00, total >> 8, total & 0xff, 0, 3, 0, 0, 64, 17, 0, 0, 10, 0, 0, 1, 8, 8, 8, 8);
  b.push(0xd0, 0x15, 0x00, 0x35, udpLen >> 8, udpLen & 0xff, 0, 0);
  return Uint8Array.from([...b, ...dns]);
}

/* ---- pcap 封装（小端 µs，linktype 1） ---- */
function wrapPcap(pkts) {
  const out = [];
  out.push(0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 1, 0, 0, 0);
  let ts = 1758000000;
  for (const p of pkts) {
    out.push(ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >> 24) & 0xff);
    out.push(0x40, 0x42, 0x0f, 0x00); // 1ms
    out.push(p.length & 0xff, (p.length >> 8) & 0xff, 0, 0);
    out.push(p.length & 0xff, (p.length >> 8) & 0xff, 0, 0);
    out.push(...p);
    ts += 1;
  }
  return Uint8Array.from(out);
}

/* ---- pcapng 封装（SHB + IDB + EPB×N，小端） ---- */
function block(type, body) {
  const len = 12 + body.length;
  const pad = (4 - (body.length % 4)) % 4;
  const total = len + pad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, type, true);
  dv.setUint32(4, total, true);
  out.set(body, 8);
  dv.setUint32(total - 4, total, true);
  return out;
}
function wrapPcapNg(pkts) {
  const shbBody = new Uint8Array(16);
  new DataView(shbBody.buffer).setUint32(0, 0x1a2b3c4d, true);
  shbBody[4] = 1; // version major
  const idbBody = new Uint8Array(8);
  new DataView(idbBody.buffer).setUint16(0, 1, true); // linktype 1
  const parts = [block(0x0a0d0d0a, shbBody), block(1, idbBody)];
  let ts = 1758000000;
  for (const p of pkts) {
    const body = new Uint8Array(20 + p.length);
    const dv = new DataView(body.buffer);
    // EPB：interface id(0) ts high(4) ts low(8) cap len(12) orig len(16) data(20)
    // pcapng 默认时间分辨率 µs（IDB 无 if_tsresol 选项）
    const tsUs = ts * 1e6;
    dv.setUint32(4, Math.floor(tsUs / 2 ** 32), true);
    dv.setUint32(8, tsUs % 2 ** 32, true);
    dv.setUint32(12, p.length, true);
    dv.setUint32(16, p.length, true);
    body.set(p, 20);
    parts.push(block(6, body));
    ts += 1;
  }
  const total = parts.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const x of parts) { out.set(x, off); off += x.length; }
  return out;
}

/* ---- 测试 ---- */
const pkts = [tcpSynPacket(), tcpDataPacket(), dnsPacket()];

console.log('pcap:');
const f1 = parseCapture(wrapPcap(pkts));
ok(f1.format === 'pcap', 'format=pcap');
ok(f1.packets.length === 3, '3 个包');
const d0 = decodePacket(f1.packets[0]);
ok(d0.proto === 'TCP', `SYN 包 proto=TCP（实际 ${d0.proto}）`);
ok(d0.srcIp === '10.0.0.1' && d0.dstIp === '10.0.0.2', 'IP 地址解析');
ok(d0.srcPort === 51234 && d0.dstPort === 443, '端口解析');
ok(d0.tcpFlags === 0x02 && d0.info.includes('[SYN]'), `SYN flag（实际 ${d0.info}）`);
ok(d0.streamKey === 'TCP 10.0.0.1:51234 10.0.0.2:443', `streamKey 归一化（实际 ${d0.streamKey}）`);
const d1 = decodePacket(f1.packets[1]);
ok(d1.proto === 'HTTP', `HTTP 嗅探（实际 ${d1.proto}）`);
ok(d1.streamDir === 1, 'HTTP 包方向 dir=1');
const d2 = decodePacket(f1.packets[2]);
ok(d2.proto === 'DNS' && d2.hasDns, 'DNS 解析');
ok(d2.info.includes('www.example.com') && d2.info.includes('A '), `DNS info（实际 ${d2.info}）`);

console.log('filter:');
const fTcp = compileFilter('tcp && port 443');
ok(fTcp(d0) && fTcp(d1) && !fTcp(d2), 'tcp && port 443');
ok(compileFilter('dns')(d2), 'dns');
ok(compileFilter('host 10.0.0.2')(d0) && !compileFilter('host 10.0.0.2')(d2), 'host');
ok(compileFilter('src host 8.8.8.8')(d2) === false && compileFilter('dst host 8.8.8.8')(d2), 'src/dst host');
ok(compileFilter('!(udp || arp)')(d0), '!() 组合');
ok(compileFilter('http')(d1), 'http');
ok(compileFilter('ip.src == 10.0.0.1 && tcp.dstport == 443')(d0), '字段比较组合');
let threw = false;
try { compileFilter('tcp &&'); } catch { threw = true; }
ok(threw, '语法错误抛错');

console.log('stream:');
const decoded = f1.packets.map((p) => decodePacket(p));
const s = buildStream(f1.packets, decoded, d0.streamKey);
ok(s && s.proto === 'TCP' && s.chunks.length === 1, 'TCP 流一块（仅 HTTP 方向有 payload）');
ok(s && new TextDecoder().decode(s.chunks[0].data).startsWith('GET /'), '流 payload 重组正确');
ok(s && s.endpoints[0] === '10.0.0.1:51234', '端点顺序');

console.log('pcapng:');
const f2 = parseCapture(wrapPcapNg(pkts));
ok(f2.format === 'pcapng', 'format=pcapng');
ok(f2.packets.length === 3, 'pcapng 3 个包');
const n0 = decodePacket(f2.packets[0]);
ok(n0.proto === 'TCP' && n0.dstPort === 443, 'pcapng 包解码');
ok(f2.packets[0].tsSec === 1758000000, 'pcapng 时间戳');

console.log('base64:');
const b = base64ToBytes(Buffer.from([1, 2, 3, 250, 251]).toString('base64'));
ok(b.length === 5 && b[3] === 250, 'base64ToBytes');

console.log(failures ? `\n${failures} 个失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
