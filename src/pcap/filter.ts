/**
 * 显示过滤器（Wireshark 显示过滤器语法的子集实现，无 .proto 对照）。
 * 支持：
 *   协议名  tcp / udp / icmp / icmpv6 / arp / dns / http / tls / ssh / radius / ip / ipv6
 *   列字段  _ws.col.protocol == "RADIUS"（大小写不敏感）、_ws.col.info contains "GET"
 *   帧字段  frame.number == 100、frame.len > 500
 *   地址    ip.addr|ip.src|ip.dst、eth.addr|eth.src|eth.dst（==/!=）
 *   端口    tcp.port|udp.port|tcp.srcport|tcp.dstport|udp.srcport|udp.dstport|srcport|dstport
 *           （==/!=/>/</>=/<=，或 eq/ne/gt/lt/ge/le）
 *   简写    host <地址>、src host <地址>、dst host <地址>、port <n>、src port <n>、dst port <n>
 *   组合    && / and、|| / or、! / not、括号
 *   字符串值可带双引号（_ws.col.* 的值建议带引号，与 Wireshark 一致）。
 * compileFilter 返回断言函数；语法错误抛带位置信息的中文错误（输入框行内展示，不清空列表）。
 */
import type { DecodedPacket } from './decode';

export type PacketPredicate = (p: DecodedPacket) => boolean;

/* ---------------- 词法 ---------------- */

interface Token {
  kind: 'word' | 'op' | 'lparen' | 'rparen';
  text: string;
  pos: number;
}

const OPS2 = ['==', '!=', '>=', '<=', '&&', '||'];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lparen', text: '(', pos: i }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen', text: ')', pos: i }); i++; continue; }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new Error(`第 ${i + 1} 个字符：字符串缺少结束引号`);
      tokens.push({ kind: 'word', text: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { tokens.push({ kind: 'op', text: two, pos: i }); i += 2; continue; }
    if (c === '>' || c === '<' || c === '!') { tokens.push({ kind: 'op', text: c, pos: i }); i++; continue; }
    if (c === '=') throw new Error(`第 ${i + 1} 个字符：比较请用 ==（或 eq）`);
    // word：字母数字 _ . : / - 组成（覆盖 IP/MAC/字段名/域名）
    let j = i;
    while (j < src.length && /[\w.:/-]/.test(src[j])) j++;
    if (j === i) throw new Error(`第 ${i + 1} 个字符「${c}」无法识别`);
    tokens.push({ kind: 'word', text: src.slice(i, j), pos: i });
    i = j;
  }
  return tokens;
}

/* ---------------- 语法（递归下降） ---------------- */

type Ast =
  | { t: 'and' | 'or'; l: Ast; r: Ast }
  | { t: 'not'; e: Ast }
  | { t: 'pred'; fn: PacketPredicate };

type CmpOp = '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains';

/** 词法/词法操作符别名统一为内部比较符（Wireshark 的 eq/ne/gt/lt/ge/le） */
const WORD_OPS: Record<string, CmpOp> = {
  eq: '==', ne: '!=', gt: '>', lt: '<', ge: '>=', le: '<=', contains: 'contains',
};

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private err(tok: Token | undefined, msg: string): Error {
    return new Error(tok ? `第 ${tok.pos + 1} 个字符附近：${msg}` : `表达式末尾：${msg}`);
  }

  parseExpr(): Ast {
    return this.parseOr();
  }

  /** 解析结束后确认无多余 token（compileFilter 用） */
  expectEnd(): void {
    const rest = this.next();
    if (rest) throw new Error(`第 ${rest.pos + 1} 个字符附近：多余的「${rest.text}」`);
  }

  private parseOr(): Ast {
    let l = this.parseAnd();
    for (;;) {
      const tok = this.peek();
      if (tok?.kind === 'op' && tok.text === '||') { this.next(); l = { t: 'or', l, r: this.parseAnd() }; continue; }
      if (tok?.kind === 'word' && tok.text.toLowerCase() === 'or') { this.next(); l = { t: 'or', l, r: this.parseAnd() }; continue; }
      return l;
    }
  }

  private parseAnd(): Ast {
    let l = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok?.kind === 'op' && tok.text === '&&') { this.next(); l = { t: 'and', l, r: this.parseUnary() }; continue; }
      if (tok?.kind === 'word' && tok.text.toLowerCase() === 'and') { this.next(); l = { t: 'and', l, r: this.parseUnary() }; continue; }
      // 隐式 and：相邻条件（Wireshark 不支持，这里也不支持——保持严格，漏写 && 直接报错）
      return l;
    }
  }

  private parseUnary(): Ast {
    const tok = this.peek();
    if (tok?.kind === 'op' && tok.text === '!') { this.next(); return { t: 'not', e: this.parseUnary() }; }
    if (tok?.kind === 'word' && tok.text.toLowerCase() === 'not') { this.next(); return { t: 'not', e: this.parseUnary() }; }
    if (tok?.kind === 'lparen') {
      this.next();
      const e = this.parseExpr();
      const close = this.next();
      if (close?.kind !== 'rparen') throw this.err(close, '缺少右括号 )');
      return e;
    }
    return this.parsePredicate();
  }

  /** 读取一个 word token，没有则报错 */
  private expectWord(msg: string): Token {
    const tok = this.next();
    if (tok?.kind !== 'word') throw this.err(tok, msg);
    return tok;
  }

  /** 读取比较操作符：==/!=/>/</>=/<=/contains 或 eq/ne/gt/lt/ge/le */
  private expectOp(field: string): CmpOp {
    const tok = this.next();
    if (tok?.kind === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(tok.text)) {
      return tok.text as CmpOp;
    }
    if (tok?.kind === 'word' && WORD_OPS[tok.text.toLowerCase()]) {
      return WORD_OPS[tok.text.toLowerCase()];
    }
    throw this.err(tok, `字段「${field}」后需要比较符（== != > < >= <= 或 eq/ne/contains 等）`);
  }

  /** 数值比较：值必须是整数 */
  private cmpNumber(field: string, extract: (p: DecodedPacket) => number | undefined): Ast {
    const op = this.expectOp(field);
    if (op === 'contains') throw this.err(undefined, `字段「${field}」不支持 contains`);
    const valueTok = this.expectWord('比较符后需要一个数值');
    const v = Number(valueTok.text);
    if (!Number.isFinite(v)) throw this.err(valueTok, `「${valueTok.text}」不是数值`);
    const fn: PacketPredicate = (p) => {
      const x = extract(p);
      if (x === undefined) return false;
      switch (op) {
        case '==': return x === v;
        case '!=': return x !== v;
        case '>': return x > v;
        case '<': return x < v;
        case '>=': return x >= v;
        case '<=': return x <= v;
        default: return false;
      }
    };
    return { t: 'pred', fn };
  }

  /** 字符串比较：==/!=（大小写不敏感）与 contains */
  private cmpString(field: string, extract: (p: DecodedPacket) => string | undefined): Ast {
    const op = this.expectOp(field);
    const valueTok = this.expectWord('比较符后需要一个字符串值（建议带双引号）');
    const v = valueTok.text.toLowerCase();
    const fn: PacketPredicate = (p) => {
      const x = extract(p)?.toLowerCase();
      if (x === undefined) return false;
      if (op === 'contains') return x.includes(v);
      if (op === '==') return x === v;
      if (op === '!=') return x !== v;
      return false; // 大小于对字符串无意义
    };
    return { t: 'pred', fn };
  }

  private parsePredicate(): Ast {
    const tok = this.next();
    if (!tok || tok.kind !== 'word') throw this.err(tok, '这里应是一个过滤条件（协议名 / host / port / 字段比较）');
    const word = tok.text.toLowerCase();

    // 协议名（存在性断言）
    switch (word) {
      case 'tcp': return { t: 'pred', fn: (p) => p.transport === 'TCP' };
      case 'udp': return { t: 'pred', fn: (p) => p.transport === 'UDP' };
      case 'icmp': return { t: 'pred', fn: (p) => p.transport === 'ICMP' };
      case 'icmpv6': return { t: 'pred', fn: (p) => p.transport === 'ICMPv6' };
      case 'arp': return { t: 'pred', fn: (p) => p.proto === 'ARP' };
      case 'dns': return { t: 'pred', fn: (p) => p.hasDns === true };
      case 'http': return { t: 'pred', fn: (p) => p.appProto === 'HTTP' };
      case 'tls': return { t: 'pred', fn: (p) => p.appProto === 'TLS' };
      case 'ssh': return { t: 'pred', fn: (p) => p.appProto === 'SSH' };
      case 'radius': return { t: 'pred', fn: (p) => p.appProto === 'RADIUS' };
      case 'ip': return { t: 'pred', fn: (p) => p.ipVersion === 4 };
      case 'ipv6': return { t: 'pred', fn: (p) => p.ipVersion === 6 };
      default: break;
    }

    // host / src host / dst host / port / src port / dst port 简写
    if (word === 'host') {
      const v = this.expectWord('host 后需要 IP 地址').text;
      return { t: 'pred', fn: (p) => p.srcIp === v || p.dstIp === v };
    }
    if (word === 'port') {
      const v = this.expectPort('port 后需要端口号');
      return { t: 'pred', fn: (p) => p.srcPort === v || p.dstPort === v };
    }
    if (word === 'src' || word === 'dst') {
      const kw = this.expectWord(`src/dst 后需要 host 或 port`).text.toLowerCase();
      if (kw === 'host') {
        const v = this.expectWord('host 后需要 IP 地址').text;
        return word === 'src'
          ? { t: 'pred', fn: (p) => p.srcIp === v }
          : { t: 'pred', fn: (p) => p.dstIp === v };
      }
      if (kw === 'port') {
        const v = this.expectPort('port 后需要端口号');
        return word === 'src'
          ? { t: 'pred', fn: (p) => p.srcPort === v }
          : { t: 'pred', fn: (p) => p.dstPort === v };
      }
      throw this.err(tok, `src/dst 后只支持 host 或 port，收到「${kw}」`);
    }

    // 字段比较
    switch (word) {
      // 列表列（Wireshark _ws.col.*）
      case '_ws.col.protocol': return this.cmpString(word, (p) => p.proto);
      case '_ws.col.info': return this.cmpString(word, (p) => p.info);
      // 帧
      case 'frame.number': return this.cmpNumber(word, (p) => p.frameNumber);
      case 'frame.len': return this.cmpNumber(word, (p) => p.frameLen);
      // 链路层
      case 'eth.addr': return this.ethAddr();
      case 'eth.src': return this.cmpString(word, (p) => p.srcMac);
      case 'eth.dst': return this.cmpString(word, (p) => p.dstMac);
      // 网络层
      case 'ip.addr': return this.ipAddr();
      case 'ip.src': return this.cmpString(word, (p) => p.srcIp);
      case 'ip.dst': return this.cmpString(word, (p) => p.dstIp);
      // 传输层端口
      case 'tcp.port': return this.portField(word, (p) => p.transport === 'TCP' ? [p.srcPort, p.dstPort] : []);
      case 'udp.port': return this.portField(word, (p) => p.transport === 'UDP' ? [p.srcPort, p.dstPort] : []);
      case 'tcp.srcport': return this.portField(word, (p) => p.transport === 'TCP' ? [p.srcPort] : []);
      case 'tcp.dstport': return this.portField(word, (p) => p.transport === 'TCP' ? [p.dstPort] : []);
      case 'udp.srcport': return this.portField(word, (p) => p.transport === 'UDP' ? [p.srcPort] : []);
      case 'udp.dstport': return this.portField(word, (p) => p.transport === 'UDP' ? [p.dstPort] : []);
      case 'srcport': return this.portField(word, (p) => [p.srcPort]);
      case 'dstport': return this.portField(word, (p) => [p.dstPort]);
      default: break;
    }

    throw this.err(tok, `无法识别的条件「${tok.text}」（支持协议名 / host / port / _ws.col.* / frame.* / ip.* / eth.* 等）`);
  }

  /** eth.addr：源或目的 MAC 任一侧命中（只支持 ==/!=） */
  private ethAddr(): Ast {
    const op = this.expectOp('eth.addr');
    if (op === 'contains') throw this.err(undefined, '字段「eth.addr」不支持 contains');
    const v = this.expectWord('比较符后需要 MAC 地址').text.toLowerCase();
    const base: PacketPredicate = (p) =>
      p.srcMac?.toLowerCase() === v || p.dstMac?.toLowerCase() === v;
    return { t: 'pred', fn: op === '!=' ? (p) => !base(p) : base };
  }

  /** ip.addr：源或目的 IP 任一侧命中（只支持 ==/!=） */
  private ipAddr(): Ast {
    const op = this.expectOp('ip.addr');
    if (op === 'contains') throw this.err(undefined, '字段「ip.addr」不支持 contains');
    const v = this.expectWord('比较符后需要 IP 地址').text;
    const base: PacketPredicate = (p) => p.srcIp === v || p.dstIp === v;
    return { t: 'pred', fn: op === '!=' ? (p) => !base(p) : base };
  }

  /** 端口字段：extract 返回本包参与比较的一组端口（协议不符为空数组） */
  private portField(field: string, extract: (p: DecodedPacket) => (number | undefined)[]): Ast {
    const op = this.expectOp(field);
    if (op === 'contains') throw this.err(undefined, `字段「${field}」不支持 contains`);
    const valueTok = this.expectWord('比较符后需要端口号');
    const v = Number(valueTok.text);
    if (!Number.isInteger(v) || v < 0 || v > 65535) {
      throw this.err(valueTok, `端口「${valueTok.text}」不是 0-65535 的整数`);
    }
    const fn: PacketPredicate = (p) => {
      const ports = extract(p).filter((x): x is number => x !== undefined);
      if (!ports.length) return false;
      switch (op) {
        case '==': return ports.includes(v);
        case '!=': return !ports.includes(v);
        case '>': return ports.some((x) => x > v);
        case '<': return ports.some((x) => x < v);
        case '>=': return ports.some((x) => x >= v);
        case '<=': return ports.some((x) => x <= v);
        default: return false;
      }
    };
    return { t: 'pred', fn };
  }

  private expectPort(msg: string): number {
    const tok = this.expectWord(msg);
    const v = Number(tok.text);
    if (!Number.isInteger(v) || v < 0 || v > 65535) throw this.err(tok, `端口「${tok.text}」不是 0-65535 的整数`);
    return v;
  }
}

function evalAst(ast: Ast, p: DecodedPacket): boolean {
  switch (ast.t) {
    case 'and': return evalAst(ast.l, p) && evalAst(ast.r, p);
    case 'or': return evalAst(ast.l, p) || evalAst(ast.r, p);
    case 'not': return !evalAst(ast.e, p);
    case 'pred': return ast.fn(p);
  }
}

/**
 * 编译过滤表达式为断言函数；空串 → null（不过滤）。
 * 语法错误抛中文 Error（message 已带位置提示）。
 */
export function compileFilter(src: string): PacketPredicate | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  const parser = new Parser(tokenize(trimmed));
  const ast = parser.parseExpr();
  parser.expectEnd();
  return (p) => evalAst(ast, p);
}
