/**
 * 简化显示过滤器（全新实现，Wireshark 显示过滤器的子集，无 .proto 对照）。
 * 支持：
 *   协议名  tcp / udp / icmp / icmpv6 / arp / dns / http / tls / ssh / ip / ipv6
 *   字段比较 ip.addr|ip.src|ip.dst ==|!= <地址>；tcp.port|udp.port|tcp.srcport|tcp.dstport|
 *            udp.srcport|udp.dstport|srcport|dstport ==|!= <端口>
 *   简写    host <地址>、src host <地址>、dst host <地址>、
 *           port <n>、src port <n>、dst port <n>
 *   组合    && / and、|| / or、! / not、括号
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

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lparen', text: '(', pos: i }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen', text: ')', pos: i }); i++; continue; }
    if (c === '!' && src[i + 1] === '=') { tokens.push({ kind: 'op', text: '!=', pos: i }); i += 2; continue; }
    if (c === '=' && src[i + 1] === '=') { tokens.push({ kind: 'op', text: '==', pos: i }); i += 2; continue; }
    if (c === '&' && src[i + 1] === '&') { tokens.push({ kind: 'op', text: '&&', pos: i }); i += 2; continue; }
    if (c === '|' && src[i + 1] === '|') { tokens.push({ kind: 'op', text: '||', pos: i }); i += 2; continue; }
    if (c === '!') { tokens.push({ kind: 'op', text: '!', pos: i }); i++; continue; }
    if (c === '=') throw new Error(`第 ${i + 1} 个字符：比较请用 ==`);
    // word：字母数字 . : _ - / 组成（覆盖 IP、域名、字段名）
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

  /** 解析结束后确认无多余 token（compileFilter 用） */
  expectEnd(): void {
    const rest = this.next();
    if (rest) throw new Error(`第 ${rest.pos + 1} 个字符附近：多余的「${rest.text}」`);
  }

  private parsePredicate(): Ast {
    const tok = this.next();
    if (!tok || tok.kind !== 'word') throw this.err(tok, '这里应是一个过滤条件（协议名 / host / port / 字段比较）');
    const word = tok.text.toLowerCase();

    // 协议名
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

    // 字段比较：field ==|!= value
    const FIELDS = new Set([
      'ip.addr', 'ip.src', 'ip.dst',
      'tcp.port', 'udp.port', 'tcp.srcport', 'tcp.dstport',
      'udp.srcport', 'udp.dstport', 'srcport', 'dstport',
    ]);
    if (FIELDS.has(word)) {
      const op = this.next();
      if (op?.kind !== 'op' || (op.text !== '==' && op.text !== '!=')) {
        throw this.err(op, `字段「${word}」后需要 == 或 !=`);
      }
      const valueTok = this.expectWord('比较运算符后需要一个值');
      const eq = op.text === '==';
      if (word.startsWith('ip.')) {
        const v = valueTok.text;
        const base: PacketPredicate =
          word === 'ip.addr' ? (p) => p.srcIp === v || p.dstIp === v
            : word === 'ip.src' ? (p) => p.srcIp === v
              : (p) => p.dstIp === v;
        return { t: 'pred', fn: eq ? base : (p) => !base(p) };
      }
      const v = Number(valueTok.text);
      if (!Number.isInteger(v) || v < 0 || v > 65535) {
        throw this.err(valueTok, `端口「${valueTok.text}」不是 0-65535 的整数`);
      }
      const base: PacketPredicate =
        word === 'tcp.port' ? (p) => p.transport === 'TCP' && (p.srcPort === v || p.dstPort === v)
          : word === 'udp.port' ? (p) => p.transport === 'UDP' && (p.srcPort === v || p.dstPort === v)
            : word === 'tcp.srcport' ? (p) => p.transport === 'TCP' && p.srcPort === v
              : word === 'tcp.dstport' ? (p) => p.transport === 'TCP' && p.dstPort === v
                : word === 'udp.srcport' ? (p) => p.transport === 'UDP' && p.srcPort === v
                  : word === 'udp.dstport' ? (p) => p.transport === 'UDP' && p.dstPort === v
                    : word === 'srcport' ? (p) => p.srcPort === v
                      : (p) => p.dstPort === v;
      return { t: 'pred', fn: eq ? base : (p) => !base(p) };
    }

    throw this.err(tok, `无法识别的条件「${tok.text}」（支持协议名 / host / port / ip.addr 等字段比较）`);
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
