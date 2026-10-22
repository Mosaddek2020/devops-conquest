// HCL (Terraform's configuration language): a lexer, a parser for bodies, blocks and
// expressions (templates, heredocs, conditionals, for-expressions, splats, function calls)
// and an evaluator with "unknown" values for things only known after apply.

export class HclError extends Error {
  constructor(msg, line = 0, file = '') { super(msg); this.line = line; this.file = file; }
}

export const UNKNOWN = Object.freeze({ __unknown: true, toString: () => '(known after apply)' });
export const isUnknown = v => v === UNKNOWN || (v && typeof v === 'object' && v.__unknown);
const deepUnknown = v => isUnknown(v) || (Array.isArray(v) ? v.some(deepUnknown) : v && typeof v === 'object' ? Object.values(v).some(deepUnknown) : false);
export { deepUnknown };

// ---------------------------------------------------------------- lexer
const PUNCT = ['==', '!=', '<=', '>=', '&&', '||', '=>', '...', '{', '}', '[', ']', '(', ')', '=', ',', '.', ':', '?', '!', '<', '>', '+', '-', '*', '/', '%'];

function lex(src, file) {
  const toks = [];
  let i = 0, line = 1;
  const push = (t, v, extra = {}) => toks.push({ t, v, line, ...extra });
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { push('nl', '\n'); line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) throw new HclError('Unterminated comment', line, file); line += (src.slice(i, end).match(/\n/g) || []).length; i = end + 2; continue; }
    if (ch === '<' && src[i + 1] === '<') {
      const m = src.slice(i).match(/^<<(-?)([A-Za-z_][\w]*)\r?\n/);
      if (m) {
        const indentStrip = m[1] === '-';
        const marker = m[2];
        let j = i + m[0].length;
        const startLine = line;
        line++;
        const lines = [];
        while (j <= src.length) {
          const nl = src.indexOf('\n', j);
          const l = src.slice(j, nl < 0 ? src.length : nl);
          if (l.trim() === marker) { j = nl < 0 ? src.length : nl; break; }
          lines.push(l);
          line++;
          if (nl < 0) throw new HclError(`Unterminated template string: heredoc ${marker}`, startLine, file);
          j = nl + 1;
        }
        let body = lines;
        if (indentStrip) { const min = Math.min(...body.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length)); body = body.map(l => l.slice(Math.min(min, l.match(/^\s*/)[0].length))); }
        push('tpl', body.join('\n') + '\n', { heredoc: true });
        i = j;
        continue;
      }
    }
    if (ch === '"') {
      let j = i + 1, s = '', depth = 0;
      while (j < src.length) {
        const c2 = src[j];
        if (depth === 0 && c2 === '"') break;
        if (c2 === '\n' && depth === 0) throw new HclError('Unterminated template string', line, file);
        if (c2 === '\\' && depth === 0) { const n = src[j + 1]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' ? '"' : n === '\\' ? '\\' : '\\' + n; j += 2; continue; }
        if ((c2 === '$' || c2 === '%') && src[j + 1] === '{' && src[j - 1] !== '$') { depth++; s += c2 + '{'; j += 2; continue; }
        if (depth > 0 && c2 === '{') depth++;
        if (depth > 0 && c2 === '}') depth--;
        s += c2; j++;
      }
      if (src[j] !== '"') throw new HclError('Unterminated template string', line, file);
      push('tpl', s);
      i = j + 1;
      continue;
    }
    const num = src.slice(i).match(/^\d+(\.\d+)?([eE][+-]?\d+)?/);
    if (num) { push('num', Number(num[0])); i += num[0].length; continue; }
    const id = src.slice(i).match(/^[A-Za-z_][\w-]*/);
    if (id) { push('id', id[0]); i += id[0].length; continue; }
    const p = PUNCT.find(x => src.startsWith(x, i));
    if (p) { push('p', p); i += p.length; continue; }
    throw new HclError(`Invalid character: The "${ch}" character is not used within HCL syntax.`, line, file);
  }
  push('eof', null);
  return toks;
}

// ---------------------------------------------------------------- parser
class Parser {
  constructor(toks, file) { this.toks = toks; this.i = 0; this.file = file; this.nlDepth = 0; }
  peek(k = 0) { let j = this.i, n = 0; while (true) { const t = this.toks[j]; if (this.nlDepth > 0 && t.t === 'nl') { j++; continue; } if (n === k) return t; n++; j++; } }
  next() { while (this.nlDepth > 0 && this.toks[this.i].t === 'nl') this.i++; return this.toks[this.i++]; }
  is(t, v) { const x = this.peek(); return x.t === t && (v === undefined || x.v === v); }
  eat(t, v) { if (this.is(t, v)) return this.next(); return null; }
  expect(t, v, what) { const x = this.next(); if (x.t !== t || (v !== undefined && x.v !== v)) throw new HclError(`${what || `Expected ${v || t}`}, got ${x.t === 'eof' ? 'end of file' : JSON.stringify(x.v)}`, x.line, this.file); return x; }
  skipNl() { while (this.toks[this.i].t === 'nl') this.i++; }

  body(end = 'eof') {
    const attrs = {}, blocks = [];
    while (true) {
      this.skipNl();
      const t = this.toks[this.i];
      if (end === '}' ? (t.t === 'p' && t.v === '}') : t.t === 'eof') break;
      if (t.t === 'eof') throw new HclError('Unclosed configuration block: There is no closing brace for this block before the end of the file.', t.line, this.file);
      if (t.t !== 'id') throw new HclError(`Argument or block definition required: An argument or block definition is required here.${t.v === '=' ? ' To set an argument, use the equals sign "=" after an argument name.' : ''}`, t.line, this.file);
      this.i++;
      const nxt = this.toks[this.i];
      if (nxt.t === 'p' && nxt.v === '=') {
        this.i++;
        if (attrs[t.v]) throw new HclError(`Attribute redefined: The argument "${t.v}" was already set at ${this.file}:${attrs[t.v].line}. Each argument may be set only once.`, t.line, this.file);
        const expr = this.expr();
        attrs[t.v] = { expr, line: t.line };
        const after = this.toks[this.i];
        if (!(after.t === 'nl' || after.t === 'eof' || (after.t === 'p' && after.v === '}'))) throw new HclError(`Missing newline after argument: An argument definition must end with a newline.`, after.line, this.file);
        continue;
      }
      const labels = [];
      while (this.toks[this.i].t === 'tpl' || this.toks[this.i].t === 'id') { const l = this.toks[this.i++]; labels.push(l.v); }
      if (!(this.toks[this.i].t === 'p' && this.toks[this.i].v === '{')) throw new HclError(`Invalid block definition: Either a quoted string block label or an opening brace ("{") is expected here.`, this.toks[this.i].line, this.file);
      this.i++;
      const b = this.body('}');
      this.i++;
      blocks.push({ type: t.v, labels, ...b, line: t.line, file: this.file });
    }
    return { attrs, blocks };
  }

  expr() { return this.cond(); }
  cond() {
    const c = this.binary(0);
    if (this.eat('p', '?')) { this.nlDepth++; const a = this.expr(); this.expect('p', ':'); const b = this.expr(); this.nlDepth--; return { t: 'cond', c, a, b }; }
    return c;
  }
  binary(level) {
    const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    if (level >= LEVELS.length) return this.unary();
    let l = this.binary(level + 1);
    while (this.peek().t === 'p' && LEVELS[level].includes(this.peek().v)) { const op = this.next().v; const r = this.binary(level + 1); l = { t: 'bin', op, l, r }; }
    return l;
  }
  unary() {
    if (this.is('p', '!')) { this.next(); return { t: 'un', op: '!', e: this.unary() }; }
    if (this.is('p', '-')) { this.next(); return { t: 'un', op: '-', e: this.unary() }; }
    return this.postfix(this.primary());
  }
  postfix(e) {
    while (true) {
      // after a splat, further accesses apply to every element
      if (e.t === 'splat' && (this.is('p', '.') || (this.toks[this.i].t === 'p' && this.toks[this.i].v === '['))) {
        if (this.is('p', '.')) { this.next(); const n = this.next(); e.then.push({ t: 'get', a: n.v }); continue; }
        this.next(); this.nlDepth++; const k = this.expr(); this.nlDepth--; this.expect('p', ']'); e.then.push({ t: 'idx', k }); continue;
      }
      if (this.is('p', '.')) {
        this.next();
        if (this.is('p', '*')) { this.next(); e = { t: 'splat', e, then: [] }; continue; }
        const n = this.next();
        if (n.t === 'num') { e = { t: 'idx', e, k: { t: 'lit', v: n.v } }; continue; }
        if (n.t !== 'id') throw new HclError('Invalid attribute name', n.line, this.file);
        e = { t: 'get', e, a: n.v };
        continue;
      }
      if (this.toks[this.i].t === 'p' && this.toks[this.i].v === '[') {
        this.next();
        if (this.is('p', '*')) { this.next(); this.expect('p', ']'); e = { t: 'splat', e, then: [] }; continue; }
        this.nlDepth++;
        const k = this.expr();
        this.nlDepth--;
        this.expect('p', ']');
        e = { t: 'idx', e, k };
        continue;
      }
      return e;
    }
  }
  primary() {
    const x = this.next();
    if (x.t === 'num') return { t: 'lit', v: x.v };
    if (x.t === 'tpl') return parseTemplate(x.v, x.line, this.file);
    if (x.t === 'id') {
      if (x.v === 'true') return { t: 'lit', v: true };
      if (x.v === 'false') return { t: 'lit', v: false };
      if (x.v === 'null') return { t: 'lit', v: null };
      if (this.toks[this.i].t === 'p' && this.toks[this.i].v === '(') {
        this.next(); this.nlDepth++;
        const args = [];
        let expand = false;
        while (!this.is('p', ')')) { args.push(this.expr()); if (this.eat('p', '...')) expand = true; if (!this.eat('p', ',')) break; }
        this.expect('p', ')'); this.nlDepth--;
        return { t: 'call', fn: x.v, args, expand, line: x.line };
      }
      return { t: 'ref', name: x.v, line: x.line };
    }
    if (x.t === 'p' && x.v === '(') { this.nlDepth++; const e = this.expr(); this.expect('p', ')'); this.nlDepth--; return e; }
    if (x.t === 'p' && x.v === '[') {
      this.nlDepth++;
      if (this.is('id', 'for')) { this.next(); const f = this.forHead(); const body = this.expr(); const cond = this.eat('id', 'if') ? this.expr() : null; this.expect('p', ']'); this.nlDepth--; return { t: 'for', kind: 'list', ...f, body, cond }; }
      const items = [];
      while (!this.is('p', ']')) { items.push(this.expr()); if (!this.eat('p', ',')) break; }
      this.expect('p', ']', 'Missing item separator: Expected a comma to mark the beginning of the next item.');
      this.nlDepth--;
      return { t: 'list', items };
    }
    if (x.t === 'p' && x.v === '{') {
      // object constructor: items separated by newlines or commas
      if (this.is('id', 'for')) { this.nlDepth++; this.next(); const f = this.forHead(); const k = this.expr(); this.expect('p', '=>'); const v = this.expr(); const group = !!this.eat('p', '...'); const cond = this.eat('id', 'if') ? this.expr() : null; this.expect('p', '}'); this.nlDepth--; return { t: 'for', kind: 'map', ...f, k, body: v, cond, group }; }
      const items = [];
      while (true) {
        this.skipNl();
        if (this.toks[this.i].t === 'p' && this.toks[this.i].v === '}') { this.i++; break; }
        const kt = this.toks[this.i];
        let key;
        if (kt.t === 'id' && this.toks[this.i + 1]?.t === 'p' && ['=', ':'].includes(this.toks[this.i + 1].v)) { this.i++; key = { t: 'lit', v: kt.v }; }
        else if (kt.t === 'p' && kt.v === '(') { key = this.primary(); }
        else key = this.primary();
        const sep = this.next();
        if (!(sep.t === 'p' && (sep.v === '=' || sep.v === ':'))) throw new HclError('Missing key/value separator: Expected an equals sign ("=") to mark the beginning of the attribute value.', sep.line, this.file);
        this.nlDepth++;
        const v = this.expr();
        this.nlDepth--;
        items.push([key, v]);
        if (this.toks[this.i].t === 'p' && this.toks[this.i].v === ',') this.i++;
      }
      return { t: 'map', items };
    }
    if (x.t === 'p' && x.v === '<' ) throw new HclError('Invalid expression', x.line, this.file);
    throw new HclError(`Invalid expression: Expected the start of an expression, but found ${x.t === 'eof' ? 'the end of the file' : x.t === 'nl' ? 'a newline' : `"${x.v}"`}.`, x.line, this.file);
  }
  forHead() {
    const a = this.expect('id').v;
    let b = null;
    if (this.eat('p', ',')) b = this.expect('id').v;
    this.expect('id', 'in');
    const coll = this.expr();
    this.expect('p', ':');
    return { k1: a, k2: b, coll };
  }
}

function parseTemplate(text, line, file) {
  const parts = [];
  let i = 0, buf = '';
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '$' && text[i + 2] === '{') { buf += '${'; i += 3; continue; }
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      if (buf) parts.push(buf); buf = '';
      const inner = text.slice(i + 2, j - 1).replace(/^~|~$/g, '');
      const p = new Parser(lex(inner, file).filter(t => t.t !== 'nl'), file);
      p.nlDepth = 1;
      const e = p.expr();
      parts.push(e);
      i = j;
      continue;
    }
    if (text[i] === '%' && text[i + 1] === '{') {
      // template directives (%{ if }, %{ for }): kept literal; rare in labs
      const j = text.indexOf('}', i);
      buf += text.slice(i, j + 1); i = j + 1; continue;
    }
    buf += text[i++];
  }
  if (buf || !parts.length) parts.push(buf);
  return parts.length === 1 && typeof parts[0] === 'string' ? { t: 'lit', v: parts[0] } : { t: 'tpl', parts };
}

export function parseHcl(src, file = 'main.tf') {
  const p = new Parser(lex(src, file), file);
  return p.body('eof');
}
export function parseExpr(src, file = '<expr>') {
  const p = new Parser(lex(src, file).filter(t => t.t !== 'nl'), file);
  p.nlDepth = 1;
  return p.expr();
}

// ---------------------------------------------------------------- references
// root + following attribute names, e.g. ["aws_instance","web","public_ip"]
export function refsOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  const chain = n => { const parts = []; while (n.t === 'get' || n.t === 'idx' || n.t === 'splat') { if (n.t === 'get') parts.unshift(n.a); else if (n.t === 'idx' && n.k.t === 'lit') parts.unshift(`[${JSON.stringify(n.k.v)}]`); else if (n.t === 'splat') parts.unshift('[*]', ...(n.then || []).filter(x => x.t === 'get').map(x => x.a)); n = n.e; } return n.t === 'ref' ? [n.name, ...parts] : null; };
  if (node.t === 'get' || node.t === 'idx' || node.t === 'splat') { const c = chain(node); if (c) { out.push(c); let n = node; while (n.t === 'get' || n.t === 'idx' || n.t === 'splat') { if (n.t === 'idx' && n.k.t !== 'lit') refsOf(n.k, out); n = n.e; } return out; } }
  if (node.t === 'ref') out.push([node.name]);
  for (const k of ['e', 'l', 'r', 'c', 'a', 'b', 'k', 'body', 'cond', 'coll']) if (node[k] && typeof node[k] === 'object' && k !== 'a' || (k === 'a' && node.t === 'cond')) refsOf(node[k], out);
  for (const x of node.args || []) refsOf(x, out);
  for (const x of node.items || []) { if (Array.isArray(x)) { refsOf(x[0], out); refsOf(x[1], out); } else refsOf(x, out); }
  for (const x of node.parts || []) if (typeof x === 'object') refsOf(x, out);
  return out;
}

// ---------------------------------------------------------------- evaluation
export class EvalError extends Error { constructor(summary, detail = '', line = 0) { super(summary); this.detail = detail; this.line = line; } }

const typeName = v => v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'object' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'string';
const toStr = v => { if (isUnknown(v)) return UNKNOWN; if (v === null) throw new EvalError('Invalid template interpolation value', 'The expression result is null. Cannot include a null value in a string template.'); if (typeof v === 'object') throw new EvalError('Invalid template interpolation value', `Cannot include the given value in a string template: string required, but have ${typeName(v)}.`); return String(v); };

function ipToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }
function intToIp(n) { return [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.'); }

export const FUNCTIONS = {
  length: v => Array.isArray(v) ? v.length : typeof v === 'string' ? [...v].length : v && typeof v === 'object' ? Object.keys(v).length : (() => { throw new EvalError('Invalid function argument', 'Invalid value for "value" parameter: argument must not be null.'); })(),
  upper: s => String(s).toUpperCase(), lower: s => String(s).toLowerCase(), title: s => String(s).replace(/\b\w/g, m => m.toUpperCase()),
  join: (sep, list) => list.map(String).join(sep), split: (sep, s) => String(s).split(sep),
  format: (f, ...a) => { let k = 0; return String(f).replace(/%(\d*)([sdvq%])/g, (m, w, t) => t === '%' ? '%' : t === 'd' ? String(Math.trunc(a[k++])).padStart(Number(w) || 0, '0') : t === 'q' ? JSON.stringify(a[k++]) : String(a[k++])); },
  concat: (...ls) => ls.flat(), merge: (...ms) => Object.assign({}, ...ms), lookup: (m, k, d) => (m && k in m) ? m[k] : (d !== undefined ? d : (() => { throw new EvalError('Invalid function argument', `Invalid value for "inputMap" parameter: the given object has no attribute "${k}".`); })()),
  keys: m => Object.keys(m).sort(), values: m => Object.keys(m).sort().map(k => m[k]), contains: (l, v) => l.includes(v), element: (l, i) => l[i % l.length], index: (l, v) => l.indexOf(v),
  toset: l => [...new Set(l)], tolist: l => [...l], tomap: m => ({ ...m }), tostring: v => String(v), tonumber: v => Number(v), tobool: v => v === true || v === 'true',
  min: (...a) => Math.min(...a.flat()), max: (...a) => Math.max(...a.flat()), abs: n => Math.abs(n), ceil: n => Math.ceil(n), floor: n => Math.floor(n),
  coalesce: (...a) => a.find(x => x !== null && x !== '' && x !== undefined) ?? null, try: (...a) => a[0],
  jsonencode: v => JSON.stringify(v), jsondecode: s => JSON.parse(s), base64encode: s => btoa(s), base64decode: s => atob(s),
  replace: (s, a, b) => /^\/.*\/$/.test(a) ? String(s).replace(new RegExp(a.slice(1, -1), 'g'), b) : String(s).split(a).join(b),
  trimspace: s => String(s).trim(), trim: (s, c) => String(s).replace(new RegExp(`^[${c}]+|[${c}]+$`, 'g'), ''), substr: (s, o, l) => String(s).substr(o, l < 0 ? undefined : l),
  startswith: (s, p) => String(s).startsWith(p), endswith: (s, p) => String(s).endsWith(p), strrev: s => [...String(s)].reverse().join(''),
  range: (a, b, s = 1) => { if (b === undefined) { b = a; a = 0; } const out = []; for (let i = a; s > 0 ? i < b : i > b; i += s) out.push(i); return out; },
  flatten: l => l.flat(Infinity), distinct: l => [...new Set(l)], sort: l => [...l].map(String).sort(), reverse: l => [...l].reverse(), compact: l => l.filter(x => x !== '' && x !== null), slice: (l, a, b) => l.slice(a, b),
  zipmap: (k, v) => Object.fromEntries(k.map((x, i) => [x, v[i]])), sum: l => l.reduce((a, b) => a + b, 0),
  cidrsubnet: (prefix, newbits, netnum) => { const [ip, bits] = prefix.split('/'); const nb = Number(bits) + Number(newbits); if (nb > 32) throw new EvalError('Error in function call', `Call to function "cidrsubnet" failed: insufficient address space to extend prefix of ${bits} by ${newbits}.`); const base = ipToInt(ip) & (bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0); return `${intToIp((base + (Number(netnum) << (32 - nb))) >>> 0)}/${nb}`; },
  cidrhost: (prefix, hostnum) => { const [ip, bits] = prefix.split('/'); const base = ipToInt(ip) & ((~0 << (32 - Number(bits))) >>> 0); return intToIp((base + Number(hostnum)) >>> 0); },
  md5: s => fakeHash(s, 32), sha1: s => fakeHash(s, 40), sha256: s => fakeHash(s, 64), uuid: () => UNKNOWN, timestamp: () => UNKNOWN,
  can: () => true, one: l => l.length === 0 ? null : l.length === 1 ? l[0] : (() => { throw new EvalError('Invalid function argument', 'must be a list, set, or tuple value with either zero or one elements.'); })(),
  alltrue: l => l.every(Boolean), anytrue: l => l.some(Boolean), regex: (p, s) => { const m = String(s).match(new RegExp(p)); if (!m) throw new EvalError('Error in function call', 'pattern did not match'); return m[1] ?? m[0]; },
};
export function fakeHash(s, n) { let h = 0x811c9dc5, out = ''; for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } for (let i = 0; i < n; i++) { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; out += (h & 15).toString(16); } return out; }

// ctx: { lookup(name) -> value, call(fn, args) -> value (file/templatefile), vars for for-exprs }
export function evaluate(node, ctx) {
  const ev = n => evaluate(n, ctx);
  switch (node.t) {
    case 'lit': return node.v;
    case 'tpl': { const parts = node.parts.map(p => typeof p === 'string' ? p : toStr(ev(p))); return parts.some(isUnknown) ? UNKNOWN : parts.join(''); }
    case 'ref': {
      if (ctx.locals && node.name in ctx.locals) return ctx.locals[node.name];
      return ctx.lookup(node.name, node);
    }
    case 'get': {
      const o = ev(node.e);
      if (isUnknown(o)) return UNKNOWN;
      if (o && o.__ref) return o.get(node.a);
      if (o && o.__proxy) return o[node.a];
      if (o === null || o === undefined) throw new EvalError('Attempt to get attribute from null value', 'This value is null, so it does not have any attributes.');
      if (Array.isArray(o)) throw new EvalError('Unsupported attribute', `Can't access attributes on a list of objects. Did you mean to access attribute "${node.a}" for a specific element of the list, or across all elements of the list?`);
      if (typeof o !== 'object') throw new EvalError('Unsupported attribute', `Can't access attributes on a primitive-typed value (${typeName(o)}).`);
      if (!(node.a in o)) throw new EvalError('Unsupported attribute', `This object does not have an attribute named "${node.a}".`);
      return o[node.a];
    }
    case 'idx': {
      const o = ev(node.e), k = ev(node.k);
      if (isUnknown(o) || isUnknown(k)) return UNKNOWN;
      if (o && o.__ref) return o.index(k);
      if (o && o.__proxy) return o[k];
      if (Array.isArray(o)) { if (typeof k !== 'number' || k < 0 || k >= o.length) throw new EvalError('Invalid index', `The given key does not identify an element in this collection value: the collection has ${o.length} elements.`); return o[k]; }
      if (o && typeof o === 'object') { if (!(k in o)) throw new EvalError('Invalid index', `The given key does not identify an element in this collection value.`); return o[k]; }
      throw new EvalError('Invalid index', 'This value does not have any indices.');
    }
    case 'splat': {
      const o = ev(node.e);
      if (isUnknown(o)) return UNKNOWN;
      const arr = Array.isArray(o) ? o : o === null || o === undefined ? [] : (o && typeof o === 'object' && !node.e.k && Object.keys(o).every(k => /^\d+$/.test(k)) ? Object.values(o) : [o]);
      return arr.map(x => { let v = x; for (const st of node.then || []) { if (isUnknown(v)) return UNKNOWN; if (st.t === 'get') { if (v === null || typeof v !== 'object') throw new EvalError('Unsupported attribute', `This object does not have an attribute named "${st.a}".`); v = v[st.a]; } else { const k = evaluate(st.k, ctx); v = v?.[k]; } } return v; });
    }
    case 'call': {
      let args = node.args.map(ev);
      if (node.expand && Array.isArray(args[args.length - 1])) args = [...args.slice(0, -1), ...args[args.length - 1]];
      if (node.fn === 'try') { for (const a of node.args) { try { return ev(a); } catch { /* next */ } } throw new EvalError('Error in function call', 'Call to function "try" failed: no expression succeeded.'); }
      if (node.fn === 'can') { try { ev(node.args[0]); return true; } catch { return false; } }
      if (ctx.call && ['file', 'templatefile', 'fileexists', 'filebase64', 'pathexpand'].includes(node.fn)) return ctx.call(node.fn, args, node);
      const f = FUNCTIONS[node.fn];
      if (!f) throw new EvalError('Call to unknown function', `There is no function named "${node.fn}".`, node.line);
      if (args.some(a => deepUnknown(a)) && !['length', 'concat', 'merge', 'tolist', 'toset'].includes(node.fn)) return UNKNOWN;
      return f(...args);
    }
    case 'un': { const v = ev(node.e); if (isUnknown(v)) return UNKNOWN; return node.op === '!' ? !v : -v; }
    case 'bin': {
      const l = ev(node.l);
      if (node.op === '&&' && l === false) return false;
      if (node.op === '||' && l === true) return true;
      const r = ev(node.r);
      if (isUnknown(l) || isUnknown(r)) return UNKNOWN;
      switch (node.op) {
        case '+': case '-': case '*': case '/': case '%': {
          if (typeof l !== 'number' && isNaN(Number(l)) || typeof r !== 'number' && isNaN(Number(r))) throw new EvalError('Invalid operand', `Unsuitable value for ${node.op === '+' ? 'left' : 'right'} operand: a number is required.`);
          const a = Number(l), b = Number(r);
          return node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : node.op === '/' ? a / b : a % b;
        }
        case '==': return JSON.stringify(l) === JSON.stringify(r);
        case '!=': return JSON.stringify(l) !== JSON.stringify(r);
        case '<': return l < r; case '>': return l > r; case '<=': return l <= r; case '>=': return l >= r;
        case '&&': return l && r; case '||': return l || r;
      }
      return null;
    }
    case 'cond': { const c = ev(node.c); if (isUnknown(c)) return UNKNOWN; return c ? ev(node.a) : ev(node.b); }
    case 'list': return node.items.map(ev);
    case 'map': { const o = {}; for (const [k, v] of node.items) { const kk = ev(k); if (isUnknown(kk)) return UNKNOWN; o[String(kk)] = ev(v); } return o; }
    case 'for': {
      const coll = ev(node.coll);
      if (isUnknown(coll)) return UNKNOWN;
      const entries = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : Object.entries(coll || {});
      const out = node.kind === 'list' ? [] : {};
      for (const [k, v] of entries) {
        const locals = { ...(ctx.locals || {}) };
        if (node.k2) { locals[node.k1] = k; locals[node.k2] = v; } else locals[node.k1] = v;
        const sub = { ...ctx, locals };
        if (node.cond && !evaluate(node.cond, sub)) continue;
        if (node.kind === 'list') out.push(evaluate(node.body, sub));
        else { const kk = evaluate(node.k, sub); if (node.group) (out[kk] = out[kk] || []).push(evaluate(node.body, sub)); else out[kk] = evaluate(node.body, sub); }
      }
      return out;
    }
  }
  throw new EvalError('Invalid expression');
}

// render a value the way terraform shows it
export function hclValue(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (isUnknown(v)) return '(known after apply)';
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v.includes('\n') ? `<<-EOT\n${v.replace(/\n$/, '').split('\n').map(l => pad + '    ' + l).join('\n')}\n${pad}EOT` : JSON.stringify(v);
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map(x => `${pad}    ${hclValue(x, indent + 4)},`).join('\n')}\n${pad}]` : '[]';
  const ks = Object.keys(v);
  if (!ks.length) return '{}';
  const w = Math.max(...ks.map(k => JSON.stringify(k).length));
  return `{\n${ks.map(k => `${pad}    ${JSON.stringify(k).padEnd(w)} = ${hclValue(v[k], indent + 4)}`).join('\n')}\n${pad}}`;
}
