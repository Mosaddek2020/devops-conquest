// A bash interpreter for the simulator. Words are kept raw by the parser and expanded at
// execution time (parameters, $(…), $((…)), tilde, field splitting, globbing, quote
// removal), so scripts behave like bash: variables set earlier on a line are visible
// later, loops and functions work, `set -euo pipefail` is honoured.
//
// Supported: pipelines, ! , && ||, ; & newlines, redirections (> >> < 2> 2>> &> 2>&1 >&2,
// heredocs << <<- with quoted/unquoted delimiters, here-strings <<<), if/elif/else,
// for…in, for ((…)), while/until, case, { …; }, ( … ), functions, local, return,
// break/continue, arrays, ${#x} ${x:-d} ${x:=d} ${x:?m} ${x:+a} ${x#p} ${x##p} ${x%p}
// ${x%%p} ${x/a/b} ${x//a/b} ${x^^} ${x,,} ${x:off:len}, [[ … ]], (( … )).

import { SimError } from './host.js';

export class ExitSignal { constructor(code) { this.code = code; } }
class ReturnSignal { constructor(code) { this.code = code; } }
class LoopSignal { constructor(kind, n) { this.kind = kind; this.n = n; } }

const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', '{', '}', '!', '[[', ']]', 'select']);

// ---------------------------------------------------------------- lexer

const isSpace = c => c === ' ' || c === '\t';

export function lex(src) {
  const toks = [];
  let i = 0;
  const pendingHeredocs = [];
  const n = src.length;

  const readHeredocBodies = () => {
    for (const hd of pendingHeredocs.splice(0)) {
      const lines = [];
      while (i <= n) {
        let end = src.indexOf('\n', i);
        if (end === -1) end = n;
        let line = src.slice(i, end);
        i = end + 1;
        const cmp = hd.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === hd.delim) { hd.found = true; break; }
        lines.push(hd.strip ? line.replace(/^\t+/, '') : line);
        if (end >= n) break;
      }
      if (!hd.found) throw new SimError(`bash: warning: here-document delimited by end-of-file (wanted \`${hd.delim}')`, 0);
      hd.tok.body = lines.join('\n') + (lines.length ? '\n' : '');
    }
  };

  // consume a word starting at i; returns raw text (quotes kept)
  const readWord = () => {
    let s = '';
    while (i < n) {
      const c = src[i];
      if (isSpace(c) || c === '\n' || c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || c === '(' || c === ')') {
        // allow ( ) inside a word only for array assignment / extglob — keep simple: stop
        if ((c === '(' && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(s))) { const j = matchParen(src, i); s += src.slice(i, j + 1); i = j + 1; continue; }
        break;
      }
      if (c === '\\') { s += src.slice(i, i + 2); i += 2; continue; }
      if (c === "'") { const j = src.indexOf("'", i + 1); if (j === -1) throw new SimError("bash: unexpected EOF while looking for matching `''", 2); s += src.slice(i, j + 1); i = j + 1; continue; }
      if (c === '"') { const j = matchDouble(src, i); s += src.slice(i, j + 1); i = j + 1; continue; }
      if (c === '`') { const j = src.indexOf('`', i + 1); if (j === -1) throw new SimError('bash: unexpected EOF while looking for matching ``\'', 2); s += src.slice(i, j + 1); i = j + 1; continue; }
      if (c === '$' && src[i + 1] === '(') { const j = matchParen(src, i + 1); s += src.slice(i, j + 1); i = j + 1; continue; }
      if (c === '$' && src[i + 1] === '{') { const j = matchBrace(src, i + 1); s += src.slice(i, j + 1); i = j + 1; continue; }
      if (c === '$' && src[i + 1] === "'") { const j = src.indexOf("'", i + 2); s += src.slice(i, j + 1); i = j + 1; continue; }
      s += c; i++;
    }
    return s;
  };

  while (i < n) {
    const c = src[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '\n') { toks.push({ t: 'nl' }); i++; if (pendingHeredocs.length) readHeredocBodies(); continue; }
    // arithmetic command (( … ))
    if (c === '(' && src[i + 1] === '(' && (toks.length === 0 || ['nl', 'op'].includes(toks[toks.length - 1].t) || (toks[toks.length - 1].t === 'word' && ['for', 'do', 'then', 'else', '{', 'if', 'while', 'until', '!'].includes(toks[toks.length - 1].v)))) {
      const j = matchParen(src, i + 1);
      if (src[j + 1] === ')') { toks.push({ t: 'arith', v: src.slice(i + 2, j) }); i = j + 2; continue; }
    }
    // io number: 2> 2>> 2>&1 1>&2
    let m = src.slice(i).match(/^(\d)?(>>|>&|>\||<<<|<<-|<<|<&|<>|>|<)/);
    if (m && (m[1] === undefined || /\d/.test(c))) {
      if (m[1] !== undefined && i > 0 && !isSpace(src[i - 1]) && !';|&()\n'.includes(src[i - 1])) { /* part of a word like a2>b: treat as word */ }
      else {
        const fd = m[1] !== undefined ? Number(m[1]) : null;
        const op = m[2];
        i += m[0].length;
        while (isSpace(src[i])) i++;
        if (op === '<<' || op === '<<-') {
          const raw = readWord();
          const quoted = /['"\\]/.test(raw);
          const delim = raw.replace(/['"\\]/g, '');
          const tok = { t: 'redir', op: '<<', fd: fd ?? 0, target: delim, quoted, body: '' };
          toks.push(tok);
          pendingHeredocs.push({ delim, strip: op === '<<-', tok });
          continue;
        }
        const target = readWord();
        if (!target) throw new SimError(`bash: syntax error near unexpected token \`${src[i] === '\n' || i >= n ? 'newline' : src[i]}'`, 2);
        toks.push({ t: 'redir', op, fd, target });
        continue;
      }
    }
    if (c === '&' && src[i + 1] === '>') {
      const app = src[i + 2] === '>';
      i += app ? 3 : 2;
      while (isSpace(src[i])) i++;
      const target = readWord();
      toks.push({ t: 'redir', op: app ? '&>>' : '&>', fd: null, target });
      continue;
    }
    const ops = ['&&', '||', ';;', ';&', '|&', ';', '&', '|', '(', ')'];
    const op = ops.find(o => src.startsWith(o, i));
    if (op) { toks.push({ t: 'op', v: op }); i += op.length; continue; }
    const w = readWord();
    if (w === '') { throw new SimError(`bash: syntax error near unexpected token \`${c}'`, 2); }
    toks.push({ t: 'word', v: w });
  }
  if (pendingHeredocs.length) readHeredocBodies();
  return toks;
}

function matchDouble(s, i) {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '"') return j;
    if (s[j] === '$' && s[j + 1] === '(') { j = matchParen(s, j + 1) + 1; continue; }
    if (s[j] === '`') { j = s.indexOf('`', j + 1) + 1; continue; }
    j++;
  }
  throw new SimError('bash: unexpected EOF while looking for matching `"\'', 2);
}

function matchParen(s, i) {
  // s[i] === '('
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { j = s.indexOf("'", j + 1); if (j === -1) break; continue; }
    if (c === '"') { j = matchDouble(s, j); continue; }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (depth === 0) return j; }
  }
  throw new SimError("bash: unexpected EOF while looking for matching `)'", 2);
}

function matchBrace(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === "'" && depth > 0) { const k = s.indexOf("'", j + 1); if (k !== -1) { j = k; continue; } }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return j; }
  }
  throw new SimError("bash: unexpected EOF while looking for matching `}'", 2);
}

// ---------------------------------------------------------------- parser

export function parse(src) {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const isWord = (v, t = peek()) => t && t.t === 'word' && t.v === v;
  const skipNl = () => { while (peek() && (peek().t === 'nl')) p++; };
  const skipSep = () => { while (peek() && (peek().t === 'nl' || (peek().t === 'op' && peek().v === ';'))) p++; };
  const err = (what) => { const t = peek(); const near = !t ? 'end of file' : t.t === 'nl' ? 'newline' : t.v ?? t.op; throw new SimError(`bash: syntax error near unexpected token \`${near}'${what ? ` (expected ${what})` : ''}`, 2); };
  const expectWord = (v) => { skipSep(); if (!isWord(v)) err(`'${v}'`); p++; };

  function parseList(stops = []) {
    const items = [];
    skipSep();
    while (peek()) {
      const t = peek();
      if (t.t === 'word' && stops.includes(t.v)) break;
      if (t.t === 'op' && (t.v === ')' || t.v === ';;' || t.v === ';&') && stops.includes(t.v)) break;
      if (t.t === 'op' && t.v === ')' && stops.includes(')')) break;
      const ao = parseAndOr(stops);
      if (!ao) break;
      let bg = false;
      if (peek()?.t === 'op' && peek().v === '&') { bg = true; p++; }
      items.push({ ...ao, bg });
      if (peek()?.t === 'op' && peek().v === ';') p++;
      skipSep();
    }
    return items;
  }

  function parseAndOr(stops) {
    const first = parsePipeline(stops);
    if (!first) return null;
    const rest = [];
    while (peek()?.t === 'op' && (peek().v === '&&' || peek().v === '||')) {
      const op = peek().v; p++;
      skipNl();
      const pl = parsePipeline(stops);
      if (!pl) err();
      rest.push({ op, pipeline: pl });
    }
    return { kind: 'andor', first, rest };
  }

  function parsePipeline(stops) {
    let negate = false;
    if (isWord('!')) { negate = true; p++; }
    const cmds = [];
    const c = parseCommand(stops);
    if (!c) { if (negate) err(); return null; }
    cmds.push(c);
    while (peek()?.t === 'op' && (peek().v === '|' || peek().v === '|&')) {
      if (peek().v === '|&') c.stderrToPipe = true;
      p++;
      skipNl();
      const c2 = parseCommand(stops);
      if (!c2) err();
      cmds.push(c2);
    }
    return { kind: 'pipeline', negate, cmds };
  }

  function parseRedirs(node) {
    node.redirs = node.redirs || [];
    while (peek()?.t === 'redir') node.redirs.push(toks[p++]);
    return node;
  }

  function parseCommand(stops) {
    const t = peek();
    if (!t) return null;
    if (t.t === 'arith') { p++; return parseRedirs({ kind: 'arith', expr: t.v }); }
    if (t.t === 'op' && t.v === '(') {
      p++;
      const body = parseList([')']);
      if (!(peek()?.t === 'op' && peek().v === ')')) err("')'");
      p++;
      return parseRedirs({ kind: 'subshell', body });
    }
    if (t.t !== 'word' && t.t !== 'redir') return null;
    if (t.t === 'word') {
      if (stops.includes(t.v)) return null;
      switch (t.v) {
        case 'if': return parseRedirs(parseIf());
        case 'while': case 'until': return parseRedirs(parseWhile(t.v));
        case 'for': return parseRedirs(parseFor());
        case 'case': return parseRedirs(parseCase());
        case '{': { p++; const body = parseList(['}']); expectWord('}'); return parseRedirs({ kind: 'group', body }); }
        case 'function': {
          p++;
          const name = peek().v; p++;
          if (peek()?.t === 'op' && peek().v === '(') { p++; if (!(peek()?.t === 'op' && peek().v === ')')) err("')'"); p++; }
          skipNl();
          const body = parseCommand([]);
          return { kind: 'funcdef', name, body };
        }
        case 'then': case 'fi': case 'do': case 'done': case 'esac': case 'elif': case 'else': case '}':
          err();
      }
      // name() { … }
      if (/^[A-Za-z_][\w.:-]*$/.test(t.v) && toks[p + 1]?.t === 'op' && toks[p + 1].v === '(' && toks[p + 2]?.t === 'op' && toks[p + 2].v === ')') {
        const name = t.v; p += 3; skipNl();
        const body = parseCommand([]);
        if (!body) err('function body');
        return { kind: 'funcdef', name, body };
      }
    }
    return parseSimple(stops);
  }

  function parseSimple() {
    const node = { kind: 'simple', assigns: [], words: [], redirs: [] };
    while (peek()) {
      const t = peek();
      if (t.t === 'redir') { node.redirs.push(t); p++; continue; }
      if (t.t !== 'word') break;
      if (node.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(t.v)) { node.assigns.push(t.v); p++; continue; }
      if (node.words.length === 0 && t.v === '[[') {
        // collect raw tokens until ]]
        p++;
        const parts = [];
        while (peek() && !isWord(']]')) {
          const x = toks[p++];
          if (x.t === 'word') parts.push(x.v);
          else if (x.t === 'op') parts.push(x.v);
          else if (x.t === 'redir') parts.push((x.op === '<' || x.op === '>') ? x.op : x.op, x.target);
          else if (x.t === 'nl') err("']]'");
        }
        if (!isWord(']]')) err("']]'");
        p++;
        node.words = ['[[', ...parts, ']]'];
        node.dbracket = true;
        continue;
      }
      node.words.push(t.v); p++;
    }
    if (!node.words.length && !node.assigns.length && !node.redirs.length) return null;
    return node;
  }

  function parseIf() {
    p++;
    const clauses = [];
    const cond = parseList(['then']);
    expectWord('then');
    const body = parseList(['elif', 'else', 'fi']);
    clauses.push({ cond, body });
    let elseBody = null;
    while (true) {
      skipSep();
      if (isWord('elif')) { p++; const c = parseList(['then']); expectWord('then'); const b = parseList(['elif', 'else', 'fi']); clauses.push({ cond: c, body: b }); continue; }
      if (isWord('else')) { p++; elseBody = parseList(['fi']); }
      break;
    }
    expectWord('fi');
    return { kind: 'if', clauses, elseBody };
  }

  function parseWhile(kw) {
    p++;
    const cond = parseList(['do']);
    expectWord('do');
    const body = parseList(['done']);
    expectWord('done');
    return { kind: 'while', until: kw === 'until', cond, body };
  }

  function parseFor() {
    p++;
    if (peek()?.t === 'arith') {
      const parts = splitTop(peek().v, ';');
      p++;
      skipSep();
      if (isWord('do')) { p++; } else if (isWord('{')) { p++; const body = parseList(['}']); expectWord('}'); return { kind: 'cfor', init: parts[0], cond: parts[1], step: parts[2], body }; } else err("'do'");
      const body = parseList(['done']);
      expectWord('done');
      return { kind: 'cfor', init: parts[0] || '', cond: parts[1] || '', step: parts[2] || '', body };
    }
    const name = peek()?.v;
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) err('a variable name');
    p++;
    let items = null;
    skipNl();
    if (isWord('in')) {
      p++;
      items = [];
      while (peek()?.t === 'word') items.push(toks[p++].v);
    }
    skipSep();
    expectWord('do');
    const body = parseList(['done']);
    expectWord('done');
    return { kind: 'for', name, items, body };
  }

  function parseCase() {
    p++;
    const word = peek()?.v; p++;
    skipNl();
    expectWord('in');
    const arms = [];
    skipSep();
    while (peek() && !isWord('esac')) {
      if (peek().t === 'op' && peek().v === '(') p++;
      const pats = [];
      while (true) {
        const t = peek();
        if (!t || t.t !== 'word') err('a pattern');
        pats.push(t.v); p++;
        if (peek()?.t === 'op' && peek().v === '|') { p++; continue; }
        break;
      }
      if (!(peek()?.t === 'op' && peek().v === ')')) err("')'");
      p++;
      const body = parseList([';;', ';&', 'esac']);
      let fall = false;
      if (peek()?.t === 'op' && (peek().v === ';;' || peek().v === ';&')) { fall = peek().v === ';&'; p++; }
      arms.push({ pats, body, fall });
      skipSep();
    }
    expectWord('esac');
    return { kind: 'case', word, arms };
  }

  const prog = parseList([]);
  if (p < toks.length) err();
  return prog;
}

function splitTop(s, sep) {
  const out = []; let depth = 0, cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------- glob helpers

export function globToRegex(pat, { anchored = true, dotAll = true } = {}) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') { re += '\\' + (pat[++i] ?? ''); continue; }
    if (c === '*') { re += dotAll ? '.*' : '[^/]*'; continue; }
    if (c === '?') { re += dotAll ? '.' : '[^/]'; continue; }
    if (c === '[') {
      const j = pat.indexOf(']', i + 2);
      if (j === -1) { re += '\\['; continue; }
      let cls = pat.slice(i + 1, j);
      if (cls[0] === '!') cls = '^' + cls.slice(1);
      re += '[' + cls.replace(/\\/g, '\\\\') + ']';
      i = j; continue;
    }
    re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(anchored ? '^' + re + '$' : re);
}

// ---------------------------------------------------------------- arithmetic

function arithCore(expr, getVar, setVar) {
  const s = expr;
  let i = 0;
  const ws = () => { while (/\s/.test(s[i])) i++; };
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.trunc(x) : 0; };
  function primary() {
    ws();
    if (s[i] === '(') { i++; const v = assign(); ws(); if (s[i] === ')') i++; return v; }
    if (s[i] === '-' && s[i + 1] !== '-') { i++; return -primary(); }
    if (s[i] === '+' && s[i + 1] !== '+') { i++; return primary(); }
    if (s[i] === '!' && s[i + 1] !== '=') { i++; return primary() ? 0 : 1; }
    if (s[i] === '~') { i++; return ~primary(); }
    if (s.startsWith('++', i) || s.startsWith('--', i)) { const op = s.slice(i, i + 2); i += 2; ws(); const m = s.slice(i).match(/^[A-Za-z_]\w*/); if (!m) throw new SimError(`bash: ${expr}: syntax error`, 1); i += m[0].length; const v = num(getVar(m[0])) + (op === '++' ? 1 : -1); setVar(m[0], v); return v; }
    let m = s.slice(i).match(/^0x[0-9a-f]+|^\d+/i);
    if (m) { i += m[0].length; return Number(m[0]); }
    m = s.slice(i).match(/^[A-Za-z_]\w*/);
    if (m) {
      i += m[0].length; ws();
      if (s.startsWith('++', i) || s.startsWith('--', i)) { const op = s.slice(i, i + 2); i += 2; const old = num(getVar(m[0])); setVar(m[0], old + (op === '++' ? 1 : -1)); return old; }
      const v = getVar(m[0]);
      const str = String(v ?? '').trim();
      if (str === '') return 0;
      if (/^-?\d+$/.test(str)) return Number(str);
      return arithCore(str, getVar, setVar);
    }
    throw new SimError(`bash: ${expr.trim()}: syntax error: operand expected (error token is "${s.slice(i).trim()}")`, 1);
  }
  const OPS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<=', '>=', '<', '>'], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  function level(k) {
    if (k === OPS.length) return pow();
    let a = level(k + 1);
    while (true) {
      ws();
      const op = OPS[k].find(o => s.startsWith(o, i) && !(o === '|' && s[i + 1] === '|') && !(o === '&' && s[i + 1] === '&') && !((o === '<' || o === '>') && (s[i + 1] === '=' || s[i + 1] === o)) && !(o === '*' && s[i + 1] === '*') && !(['+', '-', '*', '/', '%', '|', '&', '^', '<<', '>>'].includes(o) && s[i + o.length] === '='));
      if (!op) return a;
      i += op.length;
      const b = level(k + 1);
      switch (op) {
        case '*': a = a * b; break;
        case '/': if (b === 0) throw new SimError('bash: division by 0 (error token is "0")', 1); a = Math.trunc(a / b); break;
        case '%': if (b === 0) throw new SimError('bash: division by 0 (error token is "0")', 1); a = a % b; break;
        case '+': a = a + b; break; case '-': a = a - b; break;
        case '<<': a = a << b; break; case '>>': a = a >> b; break;
        case '<=': a = +(a <= b); break; case '>=': a = +(a >= b); break; case '<': a = +(a < b); break; case '>': a = +(a > b); break;
        case '==': a = +(a === b); break; case '!=': a = +(a !== b); break;
        case '&&': a = +(!!a && !!b); break; case '||': a = +(!!a || !!b); break;
        case '&': a = a & b; break; case '|': a = a | b; break; case '^': a = a ^ b; break;
      }
    }
  }
  function pow() { let a = primary(); ws(); if (s.startsWith('**', i)) { i += 2; a = a ** pow(); } return a; }
  function ternary() { const c = level(0); ws(); if (s[i] === '?') { i++; const a = assign(); ws(); if (s[i] === ':') i++; const b = assign(); return c ? a : b; } return c; }
  function assign() {
    ws();
    const m = s.slice(i).match(/^([A-Za-z_]\w*)\s*(\+=|-=|\*=|\/=|%=|=(?!=))/);
    if (m) {
      i += m[0].length;
      const v = assign();
      const old = num(getVar(m[1]));
      const r = m[2] === '=' ? v : m[2] === '+=' ? old + v : m[2] === '-=' ? old - v : m[2] === '*=' ? old * v : m[2] === '/=' ? Math.trunc(old / v) : old % v;
      setVar(m[1], r);
      return r;
    }
    return ternary();
  }
  const v = assign();
  ws();
  if (i < s.length) throw new SimError(`bash: ${expr.trim()}: syntax error in expression (error token is "${s.slice(i).trim()}")`, 1);
  return v;
}

export function evalArith(expr, getVar, setVar) {
  let v = 0;
  for (const part of splitTop(expr, ',')) if (part.trim()) v = arithCore(part.replace(/\$\{?(\w+)\}?/g, (_, n) => String(getVar(n) ?? 0)), getVar, setVar);
  return v;
}
