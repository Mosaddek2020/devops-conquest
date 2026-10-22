// Text tools: grep, sed, awk, sort, uniq, cut, wc, tr, tee, xargs, diff, column, paste.

import { def, opts } from '../registry.js';
import { fsx } from '../fsx.js';
import { SimError } from '../host.js';
import { C, stripAnsi } from '../../git/world.js';
import { diffLines } from '../../git/diff.js';

const lines = t => { if (!t) return []; const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };

function inputs(c, files) {
  const f = fsx(c);
  if (!files.length) return [{ name: '(standard input)', text: c.stdin ?? '' }];
  const out = [];
  for (const p of files) {
    try { out.push({ name: p, text: f.read(p) }); }
    catch (e) { out.push({ name: p, error: e.message }); }
  }
  return out;
}

// convert a basic/extended regex to a JS RegExp
export function toRegex(pat, { extended = false, fixed = false, ignore = false, word = false, line = false, global = false } = {}) {
  let src;
  if (fixed) src = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  else if (extended) src = pat;
  else {
    // BRE: \( \) \{ \} \| \+ \? are special; bare ( ) { } | + ? are literal
    src = '';
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (ch === '\\' && i + 1 < pat.length) {
        const n = pat[i + 1];
        if ('(){}|+?'.includes(n)) { src += n; i++; continue; }
        src += ch + n; i++; continue;
      }
      if ('(){}|+?'.includes(ch)) { src += '\\' + ch; continue; }
      src += ch;
    }
  }
  src = src.replace(/\[\[:(alpha|digit|alnum|upper|lower|space|punct|xdigit):\]\]/g, (_, k) => ({ alpha: '[A-Za-z]', digit: '[0-9]', alnum: '[A-Za-z0-9]', upper: '[A-Z]', lower: '[a-z]', space: '\\s', punct: '[!-/:-@[-`{-~]', xdigit: '[0-9A-Fa-f]' })[k])
    .replace(/\[:(alpha|digit|alnum|upper|lower|space|punct|xdigit):\]/g, (_, k) => ({ alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', punct: '!-/:-@[-`{-~', xdigit: '0-9A-Fa-f' })[k]);
  if (word) src = `\\b(?:${src})\\b`;
  if (line) src = `^(?:${src})$`;
  try { return new RegExp(src, (ignore ? 'i' : '') + (global ? 'g' : '')); }
  catch { throw new SimError(`grep: Unmatched ( or \\(`, 2); }
}

// ---------- grep ----------
def(['grep', 'egrep', 'fgrep'], c => {
  const o = opts(c.args, { bool: 'ivnclLrRhHoqswxEFzZ', val: ['-e', '-A', '-B', '-C', '-m', '--color', '--include', '--exclude', '-f'], alias: { '--ignore-case': '-i', '--invert-match': '-v', '--count': '-c', '--recursive': '-r', '--extended-regexp': '-E', '--fixed-strings': '-F', '--only-matching': '-o', '--quiet': '-q', '--word-regexp': '-w', '--line-number': '-n', '--files-with-matches': '-l', '--max-count': '-m' } });
  const pats = [];
  if (o['-e']) pats.push(o['-e']);
  if (o['-f']) pats.push(...lines(fsx(c).read(o['-f'])));
  if (!pats.length) { if (!o._.length) return c.fail('Usage: grep [OPTION]... PATTERNS [FILE]...\nTry \'grep --help\' for more information.', 2); pats.push(o._.shift()); }
  const extended = o['-E'] || c.name === 'egrep';
  const fixed = o['-F'] || c.name === 'fgrep';
  const re = toRegex(pats.length > 1 ? pats.map(p => fixed ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p).join('|') : pats[0], { extended: extended || pats.length > 1, fixed: fixed && pats.length === 1, ignore: o['-i'], word: o['-w'], line: o['-x'] });
  const reG = new RegExp(re.source, re.flags + 'g');
  const recursive = o['-r'] || o['-R'];
  let files = o._;
  const f = fsx(c);
  if (recursive) {
    if (!files.length) files = ['.'];
    const exp = [];
    const inc = o['--include'] ? new RegExp('^' + o['--include'].replace(/\./g, '\\.').replace(/\*/g, '.*') + '$') : null;
    for (const p of files) {
      if (f.isDir(p)) { for (const [a, st] of f.walk(p)) if (st.type === 'file' && (!inc || inc.test(a.split('/').pop()))) exp.push(p === '.' ? '.' + a.slice(f.abs('.').length) : p.replace(/\/$/, '') + a.slice(f.abs(p).length)); }
      else exp.push(p);
    }
    files = exp.map(p => p.replace(/^\.\//, ''));
  }
  const multi = (files.length > 1 || recursive) && !o['-h'] || o['-H'];
  const color = !c.inPipe && !o['-o'];
  const hl = s => color ? s.replace(reG, m => C.red(C.bold(m))) : s;
  let any = false, code = 1;
  const ctxA = Number(o['-A'] ?? o['-C'] ?? 0), ctxB = Number(o['-B'] ?? o['-C'] ?? 0);
  for (const inp of inputs(c, files)) {
    if (inp.error) { if (!o['-s']) c.eprint(inp.error.replace(/^grep: /, 'grep: ')); code = 2; continue; }
    if (f.isDir(inp.name) && !recursive) { c.eprint(`grep: ${inp.name}: Is a directory`); continue; }
    const ls = lines(inp.text);
    let count = 0;
    const prefix = (n, sep = ':') => (multi ? C.magenta(inp.name) + C.cyan(sep) : '') + (o['-n'] ? C.green(String(n)) + C.cyan(sep) : '');
    let lastPrinted = -1;
    const max = o['-m'] !== undefined ? Number(o['-m']) : Infinity;
    for (let k = 0; k < ls.length && count < max; k++) {
      const l = ls[k];
      const m = re.test(l);
      if (m === !!o['-v']) continue;
      count++; any = true;
      if (o['-q'] || o['-l'] || o['-L'] || o['-c']) continue;
      if (o['-o'] && !o['-v']) { for (const mm of l.match(reG) || []) c.print(prefix(k + 1) + mm); continue; }
      if (ctxB || ctxA) {
        const from = Math.max(lastPrinted + 1, k - ctxB);
        if (lastPrinted >= 0 && from > lastPrinted + 1) c.print(C.cyan('--'));
        for (let j = from; j < k; j++) c.print(prefix(j + 1, '-') + ls[j]);
        c.print(prefix(k + 1) + hl(l));
        let j = k + 1, added = 0;
        while (j < ls.length && added < ctxA) { if (re.test(ls[j]) !== !!o['-v']) break; c.print(prefix(j + 1, '-') + ls[j]); j++; added++; }
        lastPrinted = j - 1;
        continue;
      }
      c.print(prefix(k + 1) + hl(l));
    }
    if (o['-c']) c.print((multi ? inp.name + ':' : '') + count);
    if (o['-l'] && count) c.print(C.magenta(inp.name));
    if (o['-L'] && !count) c.print(C.magenta(inp.name));
    if (count && code !== 2) code = 0;
  }
  if (o['-q']) return any ? 0 : 1;
  return any ? (code === 2 ? 2 : 0) : code;
});

// ---------- sed ----------
function parseSedScript(script) {
  const cmds = [];
  let i = 0;
  const s = script;
  const ws = () => { while (i < s.length && /[\s;]/.test(s[i])) i++; };
  const readAddr = () => {
    if (s[i] === '$') { i++; return { last: true }; }
    let m = s.slice(i).match(/^\d+/);
    if (m) { i += m[0].length; return { line: Number(m[0]) }; }
    if (s[i] === '/' || s[i] === '\\') {
      const delim = s[i] === '\\' ? s[++i] : '/';
      i++;
      let re = '';
      while (i < s.length && s[i] !== delim) { if (s[i] === '\\' && s[i + 1] === delim) { re += delim; i += 2; continue; } re += s[i++]; }
      i++;
      let flags = '';
      if (s[i] === 'I') { flags = 'i'; i++; }
      return { re, flags };
    }
    return null;
  };
  while (true) {
    ws();
    if (i >= s.length) break;
    const cmd = {};
    const a1 = readAddr();
    if (a1) {
      cmd.a1 = a1;
      if (s[i] === ',') { i++; cmd.a2 = readAddr(); }
    }
    ws();
    if (s[i] === '!') { cmd.neg = true; i++; ws(); }
    const op = s[i++];
    cmd.op = op;
    if (op === 's' || op === 'y') {
      const delim = s[i++];
      const parts = [];
      for (let k = 0; k < 2; k++) {
        let t = '';
        while (i < s.length && s[i] !== delim) { if (s[i] === '\\' && s[i + 1] === delim) { t += delim; i += 2; continue; } if (s[i] === '\\') { t += s[i] + s[i + 1]; i += 2; continue; } t += s[i++]; }
        i++;
        parts.push(t);
      }
      cmd.find = parts[0]; cmd.repl = parts[1];
      let flags = '';
      while (i < s.length && /[gipI0-9w]/.test(s[i])) flags += s[i++];
      cmd.flags = flags;
    } else if (op === 'a' || op === 'i' || op === 'c') {
      if (s[i] === '\\') i++;
      while (s[i] === ' ' ) i++;
      let t = '';
      while (i < s.length && s[i] !== '\n' && s[i] !== ';') t += s[i++];
      cmd.text = t.replace(/^\n/, '');
    } else if (!'dpPqn=hHgGxlN'.includes(op)) {
      throw new SimError(`sed: -e expression #1, char ${i}: unknown command: \`${op}'`, 1);
    }
    cmds.push(cmd);
  }
  return cmds;
}

function sedRun(text, cmds, { quiet = false, extended = false } = {}) {
  const ls = lines(text);
  const out = [];
  const ranges = new Map();
  const reOf = (src, flags = '') => toRegex(src, { extended, ignore: flags.includes('i') || flags.includes('I') });
  const matchAddr = (a, n, l) => a.last ? n === ls.length : a.line !== undefined ? n === a.line : reOf(a.re, a.flags).test(l);
  for (let k = 0; k < ls.length; k++) {
    let l = ls[k];
    const n = k + 1;
    let deleted = false;
    const extraBefore = [], extraAfter = [];
    let quit = false;
    for (let ci = 0; ci < cmds.length; ci++) {
      const cmd = cmds[ci];
      let on = true;
      if (cmd.a1) {
        if (cmd.a2) {
          const active = ranges.get(ci);
          if (active) { on = true; if (matchAddr(cmd.a2, n, l) || (cmd.a2.line !== undefined && n >= cmd.a2.line)) ranges.delete(ci); }
          else if (matchAddr(cmd.a1, n, l)) { on = true; if (!(cmd.a2.line !== undefined && cmd.a2.line <= n)) ranges.set(ci, true); }
          else on = false;
        } else on = matchAddr(cmd.a1, n, l);
      }
      if (cmd.neg) on = !on;
      if (!on) continue;
      switch (cmd.op) {
        case 's': {
          const g = cmd.flags.includes('g');
          const nth = Number((cmd.flags.match(/\d+/) || [])[0] || 0);
          const re = new RegExp(reOf(cmd.find, cmd.flags).source, 'g' + (/[iI]/.test(cmd.flags) ? 'i' : ''));
          let count = 0, changed = false;
          const repl = cmd.repl;
          l = l.replace(re, (...m) => {
            count++;
            if (!g && nth ? count !== nth : (!g && count > 1)) return m[0];
            changed = true;
            const groups = m.slice(0, -2);
            return repl.replace(/\\(\d)|&|\\n|\\t|\\(.)/g, (x, d, lit) => d !== undefined ? (groups[Number(d)] ?? '') : x === '&' ? groups[0] : x === '\\n' ? '\n' : x === '\\t' ? '\t' : lit);
          });
          if (changed && cmd.flags.includes('p')) out.push(l);
          break;
        }
        case 'y': { const from = cmd.find, to = cmd.repl; l = [...l].map(ch => { const j = from.indexOf(ch); return j >= 0 ? to[j] : ch; }).join(''); break; }
        case 'd': deleted = true; break;
        case 'p': out.push(l); break;
        case 'q': quit = true; break;
        case 'a': extraAfter.push(cmd.text); break;
        case 'i': extraBefore.push(cmd.text); break;
        case 'c': l = cmd.text; break;
        case '=': out.push(String(n)); break;
      }
      if (deleted || quit) break;
    }
    out.push(...extraBefore);
    if (!deleted && !quiet) out.push(l);
    out.push(...extraAfter);
    if (quit) break;
  }
  return out.length ? out.join('\n') + '\n' : '';
}

def('sed', c => {
  const o = opts(c.args, { bool: 'nEri', val: ['-e', '-f'], alias: { '--in-place': '-i', '--quiet': '-n', '--regexp-extended': '-E' } });
  let inplace = o['-i'];
  const scripts = [];
  if (o['-e']) scripts.push(o['-e']);
  // allow multiple -e
  for (let k = 0; k < c.args.length; k++) if (c.args[k] === '-e' && c.args[k + 1] !== o['-e']) scripts.push(c.args[k + 1]);
  if (o['-f']) scripts.push(fsx(c).read(o['-f']));
  if (!scripts.length) { if (!o._.length) return c.fail('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...', 1); scripts.push(o._.shift()); }
  for (const a of c.args) if (/^-i\S+/.test(a)) inplace = true;
  let cmds;
  try { cmds = parseSedScript(scripts.join('\n')); } catch (e) { return c.fail(e.message, 1); }
  const f = fsx(c);
  const flags = { quiet: o['-n'], extended: o['-E'] || o['-r'] };
  if (inplace) {
    if (!o._.length) return c.fail('sed: no input files', 1);
    let code = 0;
    for (const p of o._) { try { f.write(p, sedRun(f.read(p), cmds, flags)); } catch (e) { c.eprint(e.message.replace(/^sed: /, 'sed: can\'t read ').replace("can't read can't", "can't")); code = 2; } }
    return code;
  }
  let code = 0;
  for (const inp of inputs(c, o._)) {
    if (inp.error) { c.eprint(`sed: can't read ${inp.name}: No such file or directory`); code = 2; continue; }
    c.out(sedRun(inp.text, cmds, flags));
  }
  return code;
});

// ---------- awk ----------
// A compact awk: BEGIN/END, /re/ and expression patterns, ranges, print/printf, variables,
// associative arrays, for (k in a), for(;;), while, if/else, next, exit, += ++ --, ~ !~,
// string concatenation, NR NF FS OFS ORS $0..$n, length substr index split sprintf
// tolower toupper int gsub sub match.

function awkLex(src) {
  const toks = [];
  let i = 0;
  const prevSignificant = () => { for (let k = toks.length - 1; k >= 0; k--) if (toks[k].t !== 'nl') return toks[k]; return null; };
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (ch === '\n' || ch === ';') { toks.push({ t: 'nl', v: ch }); i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '"') {
      let s = ''; i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\') { const n = src[i + 1]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' ? '"' : n === '\\' ? '\\' : n === '/' ? '/' : '\\' + n; i += 2; continue; } s += src[i++]; }
      i++; toks.push({ t: 'str', v: s }); continue;
    }
    if (ch === '/') {
      const prev = prevSignificant();
      const regexOk = !prev || (prev.t === 'op' && !([')', ']'].includes(prev.v))) || prev.t === 'nl' || prev.v === '{' || prev.v === '(' || prev.v === ',' || prev.v === '!' || prev.v === '~' || prev.v === '!~' || prev.v === '&&' || prev.v === '||';
      if (regexOk) {
        let s = ''; i++;
        while (i < src.length && src[i] !== '/') { if (src[i] === '\\' && src[i + 1] === '/') { s += '/'; i += 2; continue; } s += src[i++]; }
        i++; toks.push({ t: 're', v: s }); continue;
      }
    }
    const m3 = src.slice(i, i + 3);
    const m2 = src.slice(i, i + 2);
    if (['**='].includes(m3)) { toks.push({ t: 'op', v: m3 }); i += 3; continue; }
    if (['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '!~', '>>', '**'].includes(m2)) { toks.push({ t: 'op', v: m2 }); i += 2; continue; }
    if ('{}()[],;<>!~+-*/%^=?:$|'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    let m = src.slice(i).match(/^\d+(\.\d+)?([eE][-+]?\d+)?|^\.\d+/);
    if (m) { toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    m = src.slice(i).match(/^[A-Za-z_]\w*/);
    if (m) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    throw new SimError(`awk: syntax error at source line 1: unexpected character '${ch}'`, 2);
  }
  return toks;
}

function awkParse(src) {
  const toks = awkLex(src);
  let p = 0;
  const peek = (k = 0) => toks[p + k];
  const isOp = (v, k = 0) => peek(k)?.t === 'op' && peek(k).v === v;
  const isId = (v) => peek()?.t === 'id' && peek().v === v;
  const eat = (v) => { if (!isOp(v)) throw new SimError(`awk: syntax error: expected '${v}' near ${peek() ? JSON.stringify(peek().v) : 'end'}`, 2); p++; };
  const skipNl = () => { while (peek()?.t === 'nl') p++; };
  const optNl = () => { while (peek()?.t === 'nl' && peek().v === '\n') p++; };

  function program() {
    const rules = [];
    skipNl();
    while (peek()) {
      const rule = {};
      if (isId('BEGIN')) { p++; rule.begin = true; }
      else if (isId('END')) { p++; rule.end = true; }
      else if (isId('function')) { p++; const name = peek().v; p++; eat('('); const params = []; while (!isOp(')')) { params.push(peek().v); p++; if (isOp(',')) p++; } eat(')'); optNl(); rule.func = { name, params, body: block() }; rules.push(rule); skipNl(); continue; }
      else if (!isOp('{')) {
        rule.pattern = expr();
        if (isOp(',')) { p++; rule.pattern2 = expr(); }
      }
      optNl();
      if (isOp('{')) rule.action = block();
      rules.push(rule);
      skipNl();
    }
    return rules;
  }
  function block() {
    eat('{');
    const stmts = [];
    skipNl();
    while (!isOp('}')) { if (!peek()) throw new SimError("awk: syntax error: missing '}'", 2); stmts.push(statement()); skipNl(); }
    eat('}');
    return { k: 'block', stmts };
  }
  function simpleOrBlock() { optNl(); if (isOp('{')) return block(); const s = statement(); return s; }
  function statement() {
    if (isOp('{')) return block();
    if (isId('if')) { p++; eat('('); const c = expr(); eat(')'); const t = simpleOrBlock(); let save = p; skipNl(); let e = null; if (isId('else')) { p++; e = simpleOrBlock(); } else p = save; return { k: 'if', c, t, e }; }
    if (isId('while')) { p++; eat('('); const c = expr(); eat(')'); return { k: 'while', c, b: simpleOrBlock() }; }
    if (isId('do')) { p++; const b = simpleOrBlock(); skipNl(); if (!isId('while')) throw new SimError('awk: syntax error: expected while', 2); p++; eat('('); const c = expr(); eat(')'); return { k: 'do', c, b }; }
    if (isId('for')) {
      p++; eat('(');
      if (peek()?.t === 'id' && isId2('in')) { const v = peek().v; p += 2; const arr = peek().v; p++; eat(')'); return { k: 'forin', v, arr, b: simpleOrBlock() }; }
      const init = isOp(';') || peek()?.v === ';' ? null : simple();
      if (peek()?.t === 'nl') p++; else eat(';');
      const c = peek()?.v === ';' ? null : expr();
      if (peek()?.t === 'nl') p++; else eat(';');
      const step = isOp(')') ? null : simple();
      eat(')');
      return { k: 'for', init, c, step, b: simpleOrBlock() };
    }
    if (isId('next')) { p++; return { k: 'next' }; }
    if (isId('exit')) { p++; const v = (peek() && peek().t !== 'nl' && !isOp('}')) ? expr() : null; return { k: 'exit', v }; }
    if (isId('break')) { p++; return { k: 'break' }; }
    if (isId('continue')) { p++; return { k: 'continue' }; }
    if (isId('return')) { p++; const v = (peek() && peek().t !== 'nl' && !isOp('}')) ? expr() : null; return { k: 'return', v }; }
    if (isId('delete')) { p++; const name = peek().v; p++; let idx = null; if (isOp('[')) { p++; idx = exprList(); eat(']'); } return { k: 'delete', name, idx }; }
    return simple();
  }
  function isId2(v) { return peek(1)?.t === 'id' && peek(1).v === v; }
  function simple() {
    if (isId('print') || isId('printf')) {
      const kind = peek().v; p++;
      let args = [];
      const paren = isOp('(') && !isGroupedExpr();
      if (paren) { p++; args = exprList(true); eat(')'); }
      else if (peek() && peek().t !== 'nl' && !isOp('}') && !isOp('>') && !isOp('|')) args = exprList(true);
      let redir = null;
      if (isOp('>') || isOp('>>') || isOp('|')) { const op = peek().v; p++; redir = { op, target: primary() }; }
      return { k: kind, args, redir };
    }
    return { k: 'expr', e: expr() };
  }
  function isGroupedExpr() {
    // print (a)(b) or print (a) " x" → treat as expression; print (a, b) → arg list
    let depth = 0, k = p;
    for (; k < toks.length; k++) { const t = toks[k]; if (t.t === 'op' && t.v === '(') depth++; if (t.t === 'op' && t.v === ')') { depth--; if (depth === 0) break; } }
    const after = toks[k + 1];
    return after && !(after.t === 'nl' || (after.t === 'op' && ['}', '>', '>>', '|'].includes(after.v)));
  }
  function exprList(noGt = false) { const a = [expr(noGt)]; while (isOp(',')) { p++; optNl(); a.push(expr(noGt)); } return a; }
  function expr(noGt = false) { return ternary(noGt); }
  function ternary(noGt) { const c = assignment(noGt); if (isOp('?')) { p++; const a = ternary(noGt); eat(':'); const b = ternary(noGt); return { k: '?:', c, a, b }; } return c; }
  function assignment(noGt) {
    const save = p;
    const lhs = orE(noGt);
    if (peek()?.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^=', '**='].includes(peek().v) && (lhs.k === 'var' || lhs.k === 'idx' || lhs.k === 'field')) {
      const op = peek().v; p++;
      const rhs = assignment(noGt);
      return { k: 'assign', op, lhs, rhs };
    }
    void save;
    return lhs;
  }
  function orE(noGt) { let a = andE(noGt); while (isOp('||')) { p++; optNl(); a = { k: '||', a, b: andE(noGt) }; } return a; }
  function andE(noGt) { let a = inE(noGt); while (isOp('&&')) { p++; optNl(); a = { k: '&&', a, b: inE(noGt) }; } return a; }
  function inE(noGt) { let a = matchE(noGt); while (isId('in')) { p++; const arr = peek().v; p++; a = { k: 'in', key: a, arr }; } return a; }
  function matchE(noGt) { let a = relE(noGt); while (isOp('~') || isOp('!~')) { const neg = peek().v === '!~'; p++; a = { k: 'match', a, re: relE(noGt), neg }; } return a; }
  function relE(noGt) {
    let a = concatE();
    while (peek()?.t === 'op' && ['<', '<=', '==', '!=', '>=', '>'].includes(peek().v) && !(noGt && peek().v === '>')) { const op = peek().v; p++; a = { k: 'cmp', op, a, b: concatE() }; }
    return a;
  }
  function concatE() {
    let a = addE();
    while (peek() && (peek().t === 'str' || peek().t === 'num' || peek().t === 're' || (peek().t === 'id' && !['in', 'getline'].includes(peek().v)) || isOp('$') || isOp('(') || isOp('!') || (isOp('-') && false) || isOp('++') || isOp('--'))) {
      if (isOp('!') && (peek(1)?.v === '=' )) break;
      a = { k: 'concat', a, b: addE() };
    }
    return a;
  }
  function addE() { let a = mulE(); while (isOp('+') || isOp('-')) { const op = peek().v; p++; a = { k: 'bin', op, a, b: mulE() }; } return a; }
  function mulE() { let a = unaryE(); while (isOp('*') || isOp('/') || isOp('%')) { const op = peek().v; p++; a = { k: 'bin', op, a, b: unaryE() }; } return a; }
  function unaryE() {
    if (isOp('!')) { p++; return { k: 'not', a: unaryE() }; }
    if (isOp('-')) { p++; return { k: 'neg', a: unaryE() }; }
    if (isOp('+')) { p++; return { k: 'num', a: unaryE() }; }
    return powE();
  }
  function powE() { const a = postE(); if (isOp('^') || isOp('**')) { p++; return { k: 'bin', op: '^', a, b: unaryE() }; } return a; }
  function postE() {
    if (isOp('++') || isOp('--')) { const op = peek().v; p++; const t = primary(); return { k: 'pre', op, t }; }
    const a = primary();
    if ((isOp('++') || isOp('--')) && (a.k === 'var' || a.k === 'idx' || a.k === 'field')) { const op = peek().v; p++; return { k: 'post', op, t: a }; }
    return a;
  }
  function primary() {
    const t = peek();
    if (!t) throw new SimError('awk: syntax error: unexpected end of program', 2);
    if (t.t === 'num') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'str') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 're') { p++; return { k: 're', v: t.v }; }
    if (isOp('$')) { p++; return { k: 'field', i: primaryNoConcat() }; }
    if (isOp('(')) { p++; const e = expr(); if (isOp(',')) { const list = [e]; while (isOp(',')) { p++; list.push(expr()); } eat(')'); return { k: 'group', list }; } eat(')'); return e; }
    if (t.t === 'id') {
      p++;
      if (isOp('(') && BUILTIN_FNS.has(t.v) || isOp('(')) { p++; const args = isOp(')') ? [] : exprList(); eat(')'); return { k: 'call', name: t.v, args }; }
      if (BUILTIN_FNS.has(t.v) && t.v === 'length') return { k: 'call', name: 'length', args: [] };
      if (isOp('[')) { p++; const idx = exprList(); eat(']'); return { k: 'idx', name: t.v, idx }; }
      return { k: 'var', name: t.v };
    }
    throw new SimError(`awk: syntax error at source line 1 near ${JSON.stringify(t.v)}`, 2);
  }
  function primaryNoConcat() {
    if (isOp('(')) { p++; const e = expr(); eat(')'); return e; }
    if (peek()?.t === 'num') { const v = peek().v; p++; return { k: 'lit', v }; }
    if (peek()?.t === 'id') { const v = peek().v; p++; if (isOp('[')) { p++; const idx = exprList(); eat(']'); return { k: 'idx', name: v, idx }; } return { k: 'var', name: v }; }
    if (isOp('$')) { p++; return { k: 'field', i: primaryNoConcat() }; }
    if (isOp('-')) { p++; return { k: 'neg', a: primaryNoConcat() }; }
    return primary();
  }
  return program();
}

const BUILTIN_FNS = new Set(['length', 'substr', 'index', 'split', 'sprintf', 'tolower', 'toupper', 'int', 'gsub', 'sub', 'match', 'sqrt', 'log', 'exp', 'rand', 'srand', 'systime', 'strftime', 'printf']);

class AwkNext {}
class AwkExit { constructor(code) { this.code = code; } }
class AwkBreak {}
class AwkContinue {}
class AwkReturn { constructor(v) { this.v = v; } }

function awkRun(src, inputsList, { fs = null, vars = {}, out, err }) {
  const rules = awkParse(src);
  const V = { FS: fs ?? ' ', OFS: ' ', ORS: '\n', NR: 0, NF: 0, FNR: 0, FILENAME: '', SUBSEP: '\x1c', RSTART: 0, RLENGTH: -1, ...vars };
  const A = {};
  const funcs = {};
  for (const r of rules) if (r.func) funcs[r.func.name] = r.func;
  let fields = [''];
  const outputs = {};
  const setRecord = (line) => { fields = [line, ...splitFields(line)]; V.NF = fields.length - 1; };
  const splitFields = (line) => {
    if (V.FS === ' ') return line.trim() === '' ? [] : line.trim().split(/[ \t\n]+/);
    if (V.FS.length === 1 && V.FS !== '\\') return line === '' ? [] : line.split(V.FS);
    return line === '' ? [] : line.split(new RegExp(V.FS));
  };
  const rebuild = () => { fields[0] = fields.slice(1, V.NF + 1).map(x => x ?? '').join(V.OFS); };
  const num = v => { if (typeof v === 'number') return v; const m = String(v).match(/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/); return m ? Number(m[0]) : 0; };
  const str = v => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))) : (v ?? '');
  const isNumStr = v => typeof v === 'number' || /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(String(v));
  const truth = v => typeof v === 'number' ? v !== 0 : (v !== '' && v !== undefined);
  const key = (idx, env) => idx.map(e => str(ev(e, env))).join(V.SUBSEP);
  const reOf = (e, env) => e.k === 're' ? toRegex(e.v, { extended: true }) : toRegex(str(ev(e, env)), { extended: true });
  function lval(t, env) {
    if (t.k === 'var') return { get: () => (env && t.name in env ? env[t.name] : V[t.name] ?? ''), set: v => { if (env && t.name in env) env[t.name] = v; else { V[t.name] = v; if (t.name === 'NF') { fields.length = v + 1; rebuild(); } } } };
    if (t.k === 'idx') { const arr = (env && t.name in env && typeof env[t.name] === 'object') ? env[t.name] : (A[t.name] = A[t.name] || {}); const k = key(t.idx, env); return { get: () => arr[k] ?? '', set: v => { arr[k] = v; } }; }
    if (t.k === 'field') { const i = num(ev(t.i, env)); return { get: () => fields[i] ?? '', set: v => { if (i === 0) setRecord(str(v)); else { fields[i] = str(v); if (i > V.NF) V.NF = i; rebuild(); } } }; }
    throw new SimError('awk: invalid assignment target', 2);
  }
  function ev(e, env) {
    switch (e.k) {
      case 'lit': return e.v;
      case 're': return toRegex(e.v, { extended: true }).test(fields[0]) ? 1 : 0;
      case 'var': return env && e.name in env ? env[e.name] : (V[e.name] ?? '');
      case 'field': { const i = num(ev(e.i, env)); return fields[i] ?? ''; }
      case 'idx': { const arr = (env && e.name in env && typeof env[e.name] === 'object') ? env[e.name] : (A[e.name] = A[e.name] || {}); const k = key(e.idx, env); if (!(k in arr)) arr[k] = ''; return arr[k]; }
      case 'group': return e.list.map(x => str(ev(x, env))).join(V.SUBSEP);
      case 'assign': {
        const lv = lval(e.lhs, env);
        const r = ev(e.rhs, env);
        let v = r;
        if (e.op !== '=') { const a = num(lv.get()), b = num(r); v = e.op === '+=' ? a + b : e.op === '-=' ? a - b : e.op === '*=' ? a * b : e.op === '/=' ? a / b : e.op === '%=' ? a % b : a ** b; }
        lv.set(v); return v;
      }
      case 'pre': { const lv = lval(e.t, env); const v = num(lv.get()) + (e.op === '++' ? 1 : -1); lv.set(v); return v; }
      case 'post': { const lv = lval(e.t, env); const old = num(lv.get()); lv.set(old + (e.op === '++' ? 1 : -1)); return old; }
      case '?:': return truth(ev(e.c, env)) ? ev(e.a, env) : ev(e.b, env);
      case '||': return truth(ev(e.a, env)) || truth(ev(e.b, env)) ? 1 : 0;
      case '&&': return truth(ev(e.a, env)) && truth(ev(e.b, env)) ? 1 : 0;
      case 'in': { const arr = A[e.arr] || {}; return (e.key.k === 'group' ? e.key.list.map(x => str(ev(x, env))).join(V.SUBSEP) : str(ev(e.key, env))) in arr ? 1 : 0; }
      case 'match': { const r = reOf(e.re, env).test(str(ev(e.a, env))); return (e.neg ? !r : r) ? 1 : 0; }
      case 'cmp': {
        const a = ev(e.a, env), b = ev(e.b, env);
        const numeric = isNumStr(a) && isNumStr(b) && !(e.a.k === 'lit' && typeof e.a.v === 'string') && !(e.b.k === 'lit' && typeof e.b.v === 'string');
        const x = numeric ? num(a) : str(a), y = numeric ? num(b) : str(b);
        switch (e.op) { case '<': return x < y ? 1 : 0; case '<=': return x <= y ? 1 : 0; case '>': return x > y ? 1 : 0; case '>=': return x >= y ? 1 : 0; case '==': return x === y ? 1 : 0; case '!=': return x !== y ? 1 : 0; }
        return 0;
      }
      case 'concat': return str(ev(e.a, env)) + str(ev(e.b, env));
      case 'bin': {
        const a = num(ev(e.a, env)), b = num(ev(e.b, env));
        switch (e.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': if (b === 0) throw new SimError('awk: division by zero', 2); return a / b; case '%': return a % b; case '^': return a ** b; }
        return 0;
      }
      case 'not': return truth(ev(e.a, env)) ? 0 : 1;
      case 'neg': return -num(ev(e.a, env));
      case 'num': return num(ev(e.a, env));
      case 'call': return call(e, env);
    }
    throw new SimError(`awk: cannot evaluate ${e.k}`, 2);
  }
  function call(e, env) {
    const a = e.args;
    const S = i => str(ev(a[i], env));
    switch (e.name) {
      case 'length': return a.length ? (a[0].k === 'var' && A[a[0].name] ? Object.keys(A[a[0].name]).length : S(0).length) : fields[0].length;
      case 'substr': { const s = S(0); const st = Math.round(num(ev(a[1], env))); const len = a[2] ? Math.round(num(ev(a[2], env))) : Infinity; const from = Math.max(1, st); const to = st + len; return s.slice(from - 1, Math.max(from - 1, to - 1)); }
      case 'index': return S(0).indexOf(S(1)) + 1;
      case 'split': { const s = S(0); const name = a[1].name; const sep = a[2] ? (a[2].k === 're' ? new RegExp(a[2].v) : S(2)) : (V.FS === ' ' ? /\s+/ : V.FS); const parts = s === '' ? [] : (sep instanceof RegExp ? s.trim().split(sep) : s.split(sep)); A[name] = {}; parts.forEach((x, k) => { A[name][k + 1] = x; }); return parts.length; }
      case 'sprintf': return awkSprintf(S(0), a.slice(1).map(x => ev(x, env)));
      case 'tolower': return S(0).toLowerCase();
      case 'toupper': return S(0).toUpperCase();
      case 'int': return Math.trunc(num(ev(a[0], env)));
      case 'sqrt': return Math.sqrt(num(ev(a[0], env)));
      case 'log': return Math.log(num(ev(a[0], env)));
      case 'exp': return Math.exp(num(ev(a[0], env)));
      case 'rand': return Math.random();
      case 'srand': return 0;
      case 'systime': return Math.floor(Date.now() / 1000);
      case 'sub': case 'gsub': {
        const re = new RegExp(reOf(a[0], env).source, e.name === 'gsub' ? 'g' : '');
        const repl = S(1);
        const target = a[2] || { k: 'field', i: { k: 'lit', v: 0 } };
        const lv = lval(target, env);
        let count = 0;
        const v = str(lv.get()).replace(re, m => { count++; return repl.replace(/\\&/g, '\u0000').replace(/&/g, m).replace(/\u0000/g, '&'); });
        lv.set(v);
        return count;
      }
      case 'match': { const m = S(0).match(reOf(a[1], env)); V.RSTART = m ? m.index + 1 : 0; V.RLENGTH = m ? m[0].length : -1; return V.RSTART; }
    }
    const fn = funcs[e.name];
    if (!fn) throw new SimError(`awk: calling undefined function ${e.name}`, 2);
    const local = {};
    fn.params.forEach((pn, k) => { local[pn] = a[k] ? (a[k].k === 'var' && A[a[k].name] ? A[a[k].name] : ev(a[k], env)) : ''; });
    try { exec(fn.body, local); } catch (x) { if (x instanceof AwkReturn) return x.v; throw x; }
    return '';
  }
  function emit(text, redir, env) {
    if (!redir) { out(text); return; }
    const target = str(ev(redir.target, env));
    if (redir.op === '|') { (outputs['|' + target] = outputs['|' + target] || []).push(text); return; }
    (outputs[target] = outputs[target] || { append: redir.op === '>>', chunks: [] }).chunks.push(text);
  }
  function exec(s, env) {
    switch (s.k) {
      case 'block': for (const x of s.stmts) exec(x, env); return;
      case 'expr': ev(s.e, env); return;
      case 'print': {
        const text = s.args.length ? s.args.map(x => { const v = ev(x, env); return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))) : str(v); }).join(V.OFS) : fields[0];
        emit(text + V.ORS, s.redir, env); return;
      }
      case 'printf': { const [f, ...rest] = s.args.map(x => ev(x, env)); emit(awkSprintf(str(f), rest), s.redir, env); return; }
      case 'if': if (truth(ev(s.c, env))) exec(s.t, env); else if (s.e) exec(s.e, env); return;
      case 'while': { let g = 0; while (truth(ev(s.c, env))) { if (++g > 100000) break; try { exec(s.b, env); } catch (x) { if (x instanceof AwkBreak) break; if (x instanceof AwkContinue) continue; throw x; } } return; }
      case 'do': { let g = 0; do { if (++g > 100000) break; try { exec(s.b, env); } catch (x) { if (x instanceof AwkBreak) break; if (x instanceof AwkContinue) continue; throw x; } } while (truth(ev(s.c, env))); return; }
      case 'for': { if (s.init) exec(s.init, env); let g = 0; while (!s.c || truth(ev(s.c, env))) { if (++g > 100000) break; try { exec(s.b, env); } catch (x) { if (x instanceof AwkBreak) break; if (!(x instanceof AwkContinue)) throw x; } if (s.step) exec(s.step, env); } return; }
      case 'forin': { const arr = (env && typeof env[s.arr] === 'object') ? env[s.arr] : (A[s.arr] || {}); for (const k of Object.keys(arr)) { if (env && s.v in env) env[s.v] = k; else V[s.v] = k; try { exec(s.b, env); } catch (x) { if (x instanceof AwkBreak) break; if (!(x instanceof AwkContinue)) throw x; } } return; }
      case 'next': throw new AwkNext();
      case 'exit': throw new AwkExit(s.v ? num(ev(s.v, env)) : 0);
      case 'break': throw new AwkBreak();
      case 'continue': throw new AwkContinue();
      case 'return': throw new AwkReturn(s.v ? ev(s.v, env) : '');
      case 'delete': { if (s.idx) { const arr = A[s.name] || {}; delete arr[key(s.idx, env)]; } else A[s.name] = {}; return; }
    }
  }
  let exitCode = 0;
  const ranges = new Map();
  try {
    for (const r of rules) if (r.begin) exec(r.action, null);
    const hasMain = rules.some(r => !r.begin && !r.end && !r.func);
    const hasEnd = rules.some(r => r.end);
    if (hasMain || hasEnd) {
      for (const inp of inputsList) {
        V.FILENAME = inp.name; V.FNR = 0;
        for (const line of lines(inp.text)) {
          V.NR++; V.FNR++;
          setRecord(line);
          try {
            rules.forEach((r, ri) => {
              if (r.begin || r.end || r.func) return;
              let on;
              if (r.pattern2) {
                if (ranges.get(ri)) { on = true; if (truth(ev(r.pattern2, null))) ranges.delete(ri); }
                else if (truth(ev(r.pattern, null))) { on = true; if (!truth(ev(r.pattern2, null))) ranges.set(ri, true); }
                else on = false;
              } else on = !r.pattern || truth(ev(r.pattern, null));
              if (!on) return;
              if (r.action) exec(r.action, null); else out(fields[0] + V.ORS);
            });
          } catch (x) { if (x instanceof AwkNext) continue; throw x; }
        }
      }
    }
  } catch (x) { if (x instanceof AwkExit) exitCode = x.code; else throw x; }
  try { for (const r of rules) if (r.end) exec(r.action, null); } catch (x) { if (x instanceof AwkExit) exitCode = x.code; else throw x; }
  return { code: exitCode, outputs };
}

function awkSprintf(fmt, args) {
  let k = 0;
  return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([sdifxXoceEgG%])/g, (m, flags, width, prec, conv) => {
    if (conv === '%') return '%';
    let a = args[k++];
    if (width === '*') { width = String(a); a = args[k++]; }
    let v;
    const n = typeof a === 'number' ? a : Number(String(a ?? '').match(/^\s*[-+]?\d*\.?\d*/)?.[0] || 0);
    switch (conv) {
      case 's': v = typeof a === 'number' ? (Number.isInteger(a) ? String(a) : String(Number(a.toPrecision(6)))) : String(a ?? ''); if (prec !== undefined) v = v.slice(0, Number(prec)); break;
      case 'd': case 'i': v = String(Math.trunc(n)); break;
      case 'f': v = n.toFixed(prec !== undefined ? Number(prec) : 6); break;
      case 'e': case 'E': v = n.toExponential(prec !== undefined ? Number(prec) : 6); break;
      case 'g': case 'G': v = String(Number(n.toPrecision(prec ? Number(prec) : 6))); break;
      case 'x': v = Math.trunc(n).toString(16); break; case 'X': v = Math.trunc(n).toString(16).toUpperCase(); break;
      case 'o': v = Math.trunc(n).toString(8); break;
      case 'c': v = typeof a === 'number' ? String.fromCharCode(a) : String(a ?? '').charAt(0); break;
    }
    if (flags.includes('+') && /[dif]/.test(conv) && n >= 0) v = '+' + v;
    if (width) { const w = Number(width); v = flags.includes('-') ? v.padEnd(w) : v.padStart(w, flags.includes('0') && conv !== 's' ? '0' : ' '); }
    return v;
  }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

def(['awk', 'gawk', 'mawk'], c => {
  const args = [...c.args];
  let fs = null, prog = null;
  const vars = {};
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-F') { fs = args[++i]; continue; }
    if (a.startsWith('-F')) { fs = a.slice(2); continue; }
    if (a === '-v') { const [k, ...v] = args[++i].split('='); vars[k] = v.join('='); continue; }
    if (a === '-f') { prog = fsx(c).read(args[++i]); continue; }
    if (prog === null) { prog = a; continue; }
    if (/^\w+=/.test(a)) { const [k, ...v] = a.split('='); vars[k] = v.join('='); continue; }
    files.push(a);
  }
  if (prog === null) return c.fail("usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]", 2);
  if (fs === '\\t' || fs === 't') fs = '\t';
  const ins = inputs(c, files);
  for (const x of ins) if (x.error) { c.eprint(`awk: can't open file ${x.name}`); return 2; }
  try {
    const r = awkRun(prog, ins, { fs, vars, out: s => c.out(s), err: s => c.err(s) });
    for (const [target, o] of Object.entries(r.outputs)) {
      if (target.startsWith('|')) { c.runLine(target.slice(1), { io: { ...c.io, in: { text: o.join('') } } }); continue; }
      fsx(c).write(target, o.chunks.join(''), { append: o.append });
    }
    return r.code;
  } catch (e) {
    if (e instanceof SimError) return c.fail(e.message.replace(/^awk: /, 'awk: '), 2);
    throw e;
  }
});

// ---------- sort / uniq / cut / wc / tr / tee ----------
const humanNum = s => { const m = String(s).trim().match(/^([\d.]+)\s*([KMGTP]?)i?B?/i); if (!m) return 0; return Number(m[1]) * 1024 ** ('KMGTP'.indexOf(m[2].toUpperCase()) + 1); };

def('sort', c => {
  const o = opts(c.args, { bool: 'nrufhVbsM', val: ['-k', '-t', '-o'], alias: { '--numeric-sort': '-n', '--reverse': '-r', '--unique': '-u', '--human-numeric-sort': '-h' } });
  let ls = [];
  for (const inp of inputs(c, o._)) { if (inp.error) return c.fail(inp.error.replace(/^sort: /, 'sort: cannot read: '), 2); ls.push(...lines(inp.text)); }
  const sep = o['-t'];
  const keyOf = (l) => {
    if (!o['-k']) return l;
    const [a, b] = o['-k'].split(',');
    const from = parseInt(a, 10), to = b ? parseInt(b, 10) : null;
    const parts = sep ? l.split(sep) : l.trim().split(/\s+/);
    return (to ? parts.slice(from - 1, to) : parts.slice(from - 1)).join(sep || ' ');
  };
  const kflags = o['-k'] ? (o['-k'].match(/[nrh]+$/) || [''])[0] : '';
  const numeric = o['-n'] || kflags.includes('n'), human = o['-h'] || kflags.includes('h'), rev = o['-r'] || kflags.includes('r');
  const cmp = (x, y) => {
    const a = keyOf(x), b = keyOf(y);
    let r;
    if (human) r = humanNum(a) - humanNum(b);
    else if (numeric) r = (parseFloat(a) || 0) - (parseFloat(b) || 0);
    else if (o['-V']) r = a.localeCompare(b, undefined, { numeric: true });
    else { const A = o['-f'] ? a.toLowerCase() : a, B = o['-f'] ? b.toLowerCase() : b; r = A < B ? -1 : A > B ? 1 : 0; }
    if (r === 0 && !o['-s']) r = x < y ? -1 : x > y ? 1 : 0;
    return rev ? -r : r;
  };
  ls.sort(cmp);
  if (o['-u']) ls = ls.filter((l, k) => k === 0 || cmp(ls[k - 1], l) !== 0 || keyOf(ls[k - 1]) !== keyOf(l));
  const text = ls.length ? ls.join('\n') + '\n' : '';
  if (o['-o']) fsx(c).write(o['-o'], text); else c.out(text);
  return 0;
});

def('uniq', c => {
  const o = opts(c.args, { bool: 'cdui', val: ['-f'] });
  const inp = inputs(c, o._.slice(0, 1))[0];
  if (inp.error) return c.fail(inp.error);
  const ls = lines(inp.text);
  const groups = [];
  for (const l of ls) {
    const last = groups[groups.length - 1];
    if (last && (o['-i'] ? last.l.toLowerCase() === l.toLowerCase() : last.l === l)) last.n++;
    else groups.push({ l, n: 1 });
  }
  for (const g of groups) {
    if (o['-d'] && g.n < 2) continue;
    if (o['-u'] && g.n > 1) continue;
    c.print(o['-c'] ? `${String(g.n).padStart(7)} ${g.l}` : g.l);
  }
  return 0;
});

function parseList(spec) {
  return spec.split(',').map(r => { const m = r.match(/^(\d*)(-?)(\d*)$/); if (!m) return null; const a = m[1] ? Number(m[1]) : 1; const b = m[2] ? (m[3] ? Number(m[3]) : Infinity) : a; return [a, b]; }).filter(Boolean);
}
def('cut', c => {
  const o = opts(c.args, { bool: 's', val: ['-d', '-f', '-c', '-b', '--output-delimiter'], alias: { '--delimiter': '-d', '--fields': '-f' } });
  if (!o['-f'] && !o['-c'] && !o['-b']) return c.fail('cut: you must specify a list of bytes, characters, or fields', 1);
  const inp = inputs(c, o._);
  for (const x of inp) {
    if (x.error) { c.eprint(x.error); continue; }
    for (const l of lines(x.text)) {
      if (o['-f']) {
        const d = o['-d'] ?? '\t';
        if (!l.includes(d)) { if (!o['-s']) c.print(l); continue; }
        const parts = l.split(d);
        const sel = [];
        for (const [a, b] of parseList(o['-f'])) for (let k = a; k <= Math.min(b, parts.length); k++) sel.push(parts[k - 1]);
        c.print(sel.join(o['--output-delimiter'] ?? d));
      } else {
        const sel = [];
        for (const [a, b] of parseList(o['-c'] || o['-b'])) sel.push(l.slice(a - 1, b === Infinity ? undefined : b));
        c.print(sel.join(''));
      }
    }
  }
  return 0;
});

def('wc', c => {
  const o = opts(c.args, { bool: 'lwcmL', val: [] });
  const all = !o['-l'] && !o['-w'] && !o['-c'] && !o['-m'];
  const ins = inputs(c, o._);
  const tot = [0, 0, 0];
  let code = 0;
  const row = (l, w, ch, name) => {
    const cols = [];
    if (all || o['-l']) cols.push(l); if (all || o['-w']) cols.push(w); if (all || o['-c'] || o['-m']) cols.push(ch);
    const width = cols.length === 1 && !name ? 0 : 7;
    return cols.map(n => String(n).padStart(width)).join(' ') + (name ? ' ' + name : '');
  };
  for (const x of ins) {
    if (x.error) { c.eprint(`wc: ${x.name}: No such file or directory`); code = 1; continue; }
    const t = x.text;
    const l = (t.match(/\n/g) || []).length, w = t.split(/\s+/).filter(Boolean).length, ch = new TextEncoder().encode(t).length;
    tot[0] += l; tot[1] += w; tot[2] += ch;
    c.print(row(l, w, ch, o._.length ? x.name : ''));
  }
  if (ins.length > 1) c.print(row(...tot, 'total'));
  return code;
});

function expandSet(s) {
  s = s.replace(/\[:(alpha|digit|alnum|upper|lower|space|punct):\]/g, (_, k) => ({ alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \t\n\r', punct: '!-/:-@[-`{-~' })[k])
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i + 1] === '-' && i + 2 < s.length) { for (let ch = s.charCodeAt(i); ch <= s.charCodeAt(i + 2); ch++) out.push(String.fromCharCode(ch)); i += 2; }
    else out.push(s[i]);
  }
  return out;
}
def('tr', c => {
  const o = opts(c.args, { bool: 'dsc', val: [] });
  const t = c.stdin ?? '';
  const a = expandSet(o._[0] || ''), b = expandSet(o._[1] || '');
  let r = '';
  if (o['-d']) { const set = new Set(a); r = [...t].filter(ch => o['-c'] ? set.has(ch) || ch === '\n' : !set.has(ch)).join(''); }
  else if (b.length) { r = [...t].map(ch => { const k = a.indexOf(ch); return k >= 0 ? (b[k] ?? b[b.length - 1]) : ch; }).join(''); }
  else r = t;
  if (o['-s']) { const set = new Set(b.length ? b : a); r = r.replace(/(.)\1+/g, (m, ch) => set.has(ch) ? ch : m); }
  c.out(r);
  return 0;
});

def('tee', c => {
  const o = opts(c.args, { bool: 'a', val: [] });
  const t = c.stdin ?? '';
  const f = fsx(c);
  let code = 0;
  for (const p of o._) { try { f.write(p, t, { append: o['-a'] }); } catch (e) { c.eprint(e.message); code = 1; } }
  c.out(t);
  return code;
});

def('xargs', c => {
  const o = opts(c.args, { bool: 'rt0', val: ['-n', '-I', '-P', '-d'] });
  const items = (o['-0'] ? (c.stdin ?? '').split('\0') : o['-d'] ? (c.stdin ?? '').split(o['-d'].replace('\\n', '\n')) : (c.stdin ?? '').split(/\s+/)).filter(Boolean);
  const cmd = o._.length ? o._ : ['echo'];
  if (!items.length && o['-r']) return 0;
  let code = 0;
  const run = argv => { if (o['-t']) c.eprint(argv.join(' ')); const r = c.sh.runArgv(argv, c.e, { ...c.io, in: null }, c.result, {}); if (r !== 0) code = 123; };
  if (o['-I']) { const ph = o['-I']; for (const it of (c.stdin ?? '').split('\n').filter(Boolean)) run(cmd.map(x => x.split(ph).join(it))); return code; }
  const n = o['-n'] ? Number(o['-n']) : items.length || 1;
  for (let k = 0; k < Math.max(items.length, 1); k += n) run([...cmd, ...items.slice(k, k + n)]);
  return code;
});

def('diff', c => {
  const o = opts(c.args, { bool: 'uqyrNB', val: [] });
  const [a, b] = o._;
  if (!a || !b) return c.fail(`diff: missing operand after '${a || 'diff'}'`, 2);
  const f = fsx(c);
  let ta, tb;
  try { ta = f.read(a); tb = f.read(b); } catch (e) { return c.fail(e.message, 2); }
  if (ta === tb) return 0;
  if (o['-q']) { c.print(`Files ${a} and ${b} differ`); return 1; }
  const A = lines(ta), B = lines(tb);
  const ops = diffLines(A, B);
  if (o['-u']) {
    c.print(C.bold(`--- ${a}`), C.bold(`+++ ${b}`));
    c.print(C.cyan(`@@ -1,${A.length} +1,${B.length} @@`));
    for (const op of ops) c.print(op.op === '=' ? ' ' + A[op.a] : op.op === '-' ? C.red('-' + A[op.a]) : C.green('+' + B[op.b]));
    return 1;
  }
  for (const op of ops) { if (op.op === '-') c.print(C.red('< ' + A[op.a])); if (op.op === '+') c.print(C.green('> ' + B[op.b])); }
  return 1;
});

def('column', c => {
  const o = opts(c.args, { bool: 't', val: ['-s'] });
  const ls = lines(o._.length ? fsx(c).read(o._[0]) : c.stdin);
  if (!o['-t']) { c.out(ls.join('\n') + (ls.length ? '\n' : '')); return 0; }
  const rows = ls.map(l => o['-s'] ? l.split(o['-s']) : l.trim().split(/\s+/));
  const w = [];
  for (const r of rows) r.forEach((x, k) => { w[k] = Math.max(w[k] || 0, x.length); });
  for (const r of rows) c.print(r.map((x, k) => k === r.length - 1 ? x : x.padEnd(w[k])).join('  '));
  return 0;
});

def('paste', c => {
  const o = opts(c.args, { bool: 's', val: ['-d'] });
  const d = o['-d'] ?? '\t';
  const ins = inputs(c, o._.length ? o._ : ['-']).map(x => lines(x.text));
  if (o['-s']) { for (const l of ins) c.print(l.join(d)); return 0; }
  const n = Math.max(...ins.map(l => l.length));
  for (let k = 0; k < n; k++) c.print(ins.map(l => l[k] ?? '').join(d));
  return 0;
});

export { awkRun, sedRun, parseSedScript, lines, stripAnsi };
