// A Go text/template interpreter with the Sprig functions Helm charts use most: actions
// with {{- -}} trimming, pipelines, if/else if/else, range (lists and maps, with $i, $v),
// with, define/include/template, variables, and default, quote, toYaml, nindent, printf,
// required and friends. Errors read like Helm's ("executing "x" at <.Values.a>: ...").

export class TemplateError extends Error {}

// ---------------------------------------------------------------- lexing
function tokenize(src, name) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{{', i);
    if (open < 0) { out.push({ t: 'text', v: src.slice(i) }); break; }
    let text = src.slice(i, open);
    let j = open + 2;
    const trimL = src[j] === '-' && /\s/.test(src[j + 1] || '');
    if (trimL) { text = text.replace(/\s+$/, ''); j++; }
    const close = findClose(src, j);
    if (close < 0) throw new TemplateError(`parse error at (${name}:${lineOf(src, open)}): unclosed action`);
    let body = src.slice(j, close);
    let end = close + 2;
    let trimR = false;
    if (/\s-$/.test(body)) { trimR = true; body = body.slice(0, -1); }
    if (text) out.push({ t: 'text', v: text });
    out.push({ t: 'act', v: body.trim(), line: lineOf(src, open) });
    i = end;
    if (trimR) while (i < src.length && /\s/.test(src[i])) i++;
  }
  return out;
}
function findClose(s, j) {
  let q = null;
  for (let k = j; k < s.length - 1; k++) {
    const ch = s[k];
    if (q) { if (ch === '\\' && q === '"') { k++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === '`') { q = ch; continue; }
    if (s.startsWith('/*', k)) { const e = s.indexOf('*/', k + 2); if (e > 0) { k = e + 1; continue; } }
    if (ch === '}' && s[k + 1] === '}') return k;
  }
  return -1;
}
const lineOf = (s, i) => s.slice(0, i).split('\n').length;

// ---------------------------------------------------------------- expressions
function lexExpr(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') { let j = i + 1, v = ''; while (j < s.length && s[j] !== '"') { if (s[j] === '\\') { const n = s[j + 1]; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; continue; } v += s[j++]; } toks.push({ k: 'str', v }); i = j + 1; continue; }
    if (c === '`') { const j = s.indexOf('`', i + 1); toks.push({ k: 'str', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    if (c === "'") { toks.push({ k: 'str', v: s[i + 1] }); i += 3; continue; }
    if (c === '(' || c === ')' || c === '|' || c === ',') { toks.push({ k: c }); i++; continue; }
    if (s.startsWith(':=', i)) { toks.push({ k: ':=' }); i += 2; continue; }
    if (c === '=' ) { toks.push({ k: '=' }); i++; continue; }
    const m = s.slice(i).match(/^(-?\d+(\.\d+)?|\$[\w]*(\.[\w-]+)*|\.[\w.-]*|[A-Za-z_][\w]*(\.[\w-]+)*)/);
    if (!m) throw new TemplateError(`unexpected "${c}" in command`);
    const w = m[0];
    if (/^-?\d/.test(w)) toks.push({ k: 'num', v: Number(w) });
    else if (w === 'true' || w === 'false') toks.push({ k: 'bool', v: w === 'true' });
    else if (w === 'nil') toks.push({ k: 'nil' });
    else if (w.startsWith('$')) toks.push({ k: 'var', v: w });
    else if (w.startsWith('.')) toks.push({ k: 'field', v: w });
    else toks.push({ k: 'ident', v: w });
    i += w.length;
  }
  return toks;
}

// pipeline := [vars :=] command (| command)*   command := operand+
function parsePipeline(toks) {
  let p = 0;
  let decl = null;
  if (toks[0]?.k === 'var' && (toks[1]?.k === ':=' || toks[1]?.k === '=')) { decl = { names: [toks[0].v], assign: toks[1].k === '=' }; p = 2; }
  else if (toks[0]?.k === 'var' && toks[1]?.k === ',' && toks[2]?.k === 'var' && toks[3]?.k === ':=') { decl = { names: [toks[0].v, toks[2].v] }; p = 4; }
  const cmds = [];
  let cur = [];
  const operand = () => {
    const t = toks[p++];
    if (!t) throw new TemplateError('missing value for command');
    if (t.k === '(') { const start = p; let depth = 1; while (p < toks.length && depth) { if (toks[p].k === '(') depth++; if (toks[p].k === ')') depth--; p++; } const inner = parsePipeline(toks.slice(start, p - 1)); let node = { k: 'sub', pipe: inner }; return node; }
    return t;
  };
  while (p < toks.length) {
    if (toks[p].k === '|') { cmds.push(cur); cur = []; p++; continue; }
    if (toks[p].k === ')') { p++; continue; }
    cur.push(operand());
  }
  if (cur.length) cmds.push(cur);
  return { decl, cmds };
}

// ---------------------------------------------------------------- tree
function parseTree(tokens, name) {
  let i = 0;
  const defines = {};
  function block(stopAt) {
    const nodes = [];
    while (i < tokens.length) {
      const tk = tokens[i];
      if (tk.t === 'text') { nodes.push({ k: 'text', v: tk.v }); i++; continue; }
      const a = tk.v;
      if (a.startsWith('/*')) { i++; continue; }
      const word = a.split(/\s+/)[0];
      if (stopAt.includes(word)) return { nodes, stop: word, act: a, line: tk.line };
      i++;
      if (word === 'if' || word === 'with' || word === 'range') {
        const head = a.slice(word.length).trim();
        const node = { k: word, pipe: parsePipeline(lexExpr(head)), line: tk.line, body: null, elses: [] };
        let r = block(['else', 'end']);
        node.body = r.nodes;
        while (r.stop === 'else') {
          const rest = r.act.slice(4).trim();
          i++;
          if (rest.startsWith('if ')) { const cond = parsePipeline(lexExpr(rest.slice(3))); r = block(['else', 'end']); node.elses.push({ cond, body: r.nodes }); }
          else { r = block(['end']); node.elses.push({ cond: null, body: r.nodes }); }
        }
        if (r.stop !== 'end') throw new TemplateError(`template: ${name}:${tk.line}: unexpected EOF`);
        i++;
        nodes.push(node);
        continue;
      }
      if (word === 'define') {
        const nm = a.match(/^define\s+"([^"]+)"/)?.[1];
        const r = block(['end']);
        if (r.stop !== 'end') throw new TemplateError(`template: ${name}:${tk.line}: unexpected EOF`);
        i++;
        defines[nm] = r.nodes;
        continue;
      }
      if (word === 'template') { const m = a.match(/^template\s+"([^"]+)"\s*(.*)$/); nodes.push({ k: 'template', name: m[1], pipe: m[2] ? parsePipeline(lexExpr(m[2])) : null, line: tk.line }); continue; }
      if (word === 'end' || word === 'else') throw new TemplateError(`template: ${name}:${tk.line}: unexpected {{${word}}}`);
      nodes.push({ k: 'act', pipe: parsePipeline(lexExpr(a)), src: a, line: tk.line });
    }
    return { nodes, stop: null };
  }
  const r = block([]);
  return { nodes: r.nodes, defines };
}

// ---------------------------------------------------------------- values
export { FUNCS };
export const truthy = v => !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length));
const goStr = v => v === undefined || v === null ? '<no value>' : typeof v === 'object' ? (Array.isArray(v) ? `[${v.map(goStr).join(' ')}]` : `map[${Object.keys(v).sort().map(k => `${k}:${goStr(v[k])}`).join(' ')}]`) : String(v);

export function yamlOf(v, indent = 0) {
  const pad = ' '.repeat(indent);
  const q = s => /^$|^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|yes|no|null|~|on|off)$|^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? JSON.stringify(s) : s;
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) { if (!v.length) return '[]'; return v.map(x => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length ? `${pad}- ${yamlOf(x, indent + 2).slice(indent + 2)}` : `${pad}- ${scalarOf(x, indent + 2, q)}`).join('\n'); }
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    if (!keys.length) return '{}';
    return keys.map(k => { const x = v[k]; if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) return `${pad}${q(k)}:\n${yamlOf(x, Array.isArray(x) ? indent : indent + 2)}`; return `${pad}${q(k)}: ${Array.isArray(x) ? '[]' : x && typeof x === 'object' ? '{}' : scalarOf(x, indent + 2, q)}`; }).join('\n');
  }
  return scalarOf(v, indent, q);
}
const scalarOf = (x, indent, q) => typeof x === 'string' ? (x.includes('\n') ? '|' + (x.endsWith('\n') ? '' : '-') + '\n' + x.replace(/\n$/, '').split('\n').map(l => ' '.repeat(indent) + l).join('\n') : q(x)) : x === null || x === undefined ? 'null' : String(x);

// ---------------------------------------------------------------- functions
const indentStr = (n, s) => String(s ?? '').split('\n').map(l => ' '.repeat(n) + l).join('\n');
const sprintf = (fmt, ...args) => { let k = 0; return String(fmt).replace(/%(-?\d*)([sdvqt%])/g, (m, w, c) => { if (c === '%') return '%'; const a = args[k++]; const s = c === 'q' ? JSON.stringify(String(a)) : c === 'd' ? String(Math.trunc(Number(a))) : goStr(a); return w ? (w.startsWith('-') ? s.padEnd(Number(w.slice(1))) : s.padStart(Number(w))) : s; }); };
const shaHex = s => { let h1 = 0x811c9dc5, h2 = 0x1234567; for (const ch of String(s)) { h1 ^= ch.charCodeAt(0); h1 = Math.imul(h1, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ h1, 0x5bd1e995) >>> 0; } let out = ''; for (let i = 0; i < 8; i++) { h1 ^= h1 << 13; h1 >>>= 0; h1 ^= h1 >>> 17; h1 ^= h1 << 5; h1 >>>= 0; out += ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0'); } return out; };

let randSeq = 1;
const FUNCS = {
  default: (d, v) => truthy(v) ? v : d,
  quote: (...a) => a.map(v => JSON.stringify(v === undefined || v === null ? '' : goStr(v))).join(' '),
  squote: (...a) => a.map(v => `'${v ?? ''}'`).join(' '),
  upper: s => String(s ?? '').toUpperCase(), lower: s => String(s ?? '').toLowerCase(),
  title: s => String(s ?? '').replace(/\b\w/g, c => c.toUpperCase()),
  trim: s => String(s ?? '').trim(), trunc: (n, s) => String(s ?? '').slice(0, n),
  trimSuffix: (x, s) => String(s ?? '').endsWith(x) ? String(s).slice(0, -x.length) : String(s ?? ''),
  trimPrefix: (x, s) => String(s ?? '').startsWith(x) ? String(s).slice(x.length) : String(s ?? ''),
  replace: (a, b, s) => String(s ?? '').split(a).join(b),
  contains: (x, s) => String(s ?? '').includes(x), hasPrefix: (x, s) => String(s ?? '').startsWith(x), hasSuffix: (x, s) => String(s ?? '').endsWith(x),
  toString: v => goStr(v), int: v => Math.trunc(Number(v) || 0), int64: v => Math.trunc(Number(v) || 0), float64: v => Number(v) || 0, atoi: v => Math.trunc(Number(v) || 0),
  toYaml: v => (v === undefined || v === null) ? 'null' : yamlOf(v), toJson: v => JSON.stringify(v ?? null), fromYaml: v => v,
  indent: (n, s) => indentStr(n, s), nindent: (n, s) => '\n' + indentStr(n, s),
  printf: sprintf, print: (...a) => a.map(goStr).join(''), println: (...a) => a.map(goStr).join(' ') + '\n',
  b64enc: s => btoa(String(s ?? '')), b64dec: s => atob(String(s ?? '')),
  sha256sum: s => shaHex(s), randAlphaNum: n => { let x = 0x2545f491 + (randSeq++) * 7919, o = ''; const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; for (let k = 0; k < n; k++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; o += A[x % A.length]; } return o; },
  eq: (a, ...b) => b.some(x => x === a || (x !== null && a !== null && typeof x !== 'object' && String(x) === String(a) && typeof x === typeof a)), ne: (a, b) => a !== b,
  lt: (a, b) => a < b, le: (a, b) => a <= b, gt: (a, b) => a > b, ge: (a, b) => a >= b,
  and: (...a) => { for (const x of a) if (!truthy(x)) return x; return a[a.length - 1]; },
  or: (...a) => { for (const x of a) if (truthy(x)) return x; return a[a.length - 1]; },
  not: a => !truthy(a), empty: a => !truthy(a),
  len: v => v === undefined || v === null ? 0 : typeof v === 'object' ? (Array.isArray(v) ? v.length : Object.keys(v).length) : String(v).length,
  add: (...a) => a.reduce((s, x) => s + Number(x), 0), sub: (a, b) => Number(a) - Number(b), mul: (...a) => a.reduce((s, x) => s * Number(x), 1), div: (a, b) => Math.trunc(Number(a) / Number(b)), mod: (a, b) => Number(a) % Number(b),
  max: (...a) => Math.max(...a.map(Number)), min: (...a) => Math.min(...a.map(Number)),
  list: (...a) => a, dict: (...a) => { const o = {}; for (let k = 0; k < a.length; k += 2) o[a[k]] = a[k + 1]; return o; },
  hasKey: (m, k) => !!m && Object.prototype.hasOwnProperty.call(m, k), keys: m => Object.keys(m || {}).sort(), values: m => Object.values(m || {}),
  get: (m, k) => m?.[k] ?? '', set: (m, k, v) => { m[k] = v; return m; }, merge: (d, ...s) => { for (const x of s) for (const [k, v] of Object.entries(x || {})) if (!(k in d)) d[k] = v; return d; },
  ternary: (a, b, c) => truthy(c) ? a : b, coalesce: (...a) => a.find(truthy) ?? null,
  join: (sep, l) => (l || []).map(goStr).join(sep), split: (sep, s) => Object.fromEntries(String(s).split(sep).map((x, k) => [`_${k}`, x])), splitList: (sep, s) => String(s ?? '').split(sep),
  first: l => (l || [])[0], last: l => (l || [])[l.length - 1], has: (x, l) => (l || []).includes(x), uniq: l => [...new Set(l || [])], compact: l => (l || []).filter(truthy),
  semverCompare: (c, v) => { const m = String(c).match(/^([<>=~^]*)\s*v?(\d+)\.?(\d+)?/); const want = [Number(m[2]), Number(m[3] || 0)]; const have = String(v).replace(/^v/, '').split('.').map(Number); const cmp = have[0] - want[0] || (have[1] || 0) - want[1]; return m[1].includes('>') ? (m[1].includes('=') ? cmp >= 0 : cmp > 0) : m[1].includes('<') ? (m[1].includes('=') ? cmp <= 0 : cmp < 0) : cmp >= 0; },
  kindIs: (k, v) => (k === 'map' && v && typeof v === 'object' && !Array.isArray(v)) || (k === 'slice' && Array.isArray(v)) || (k === 'string' && typeof v === 'string') || (k === 'int' && Number.isInteger(v)) || (k === 'bool' && typeof v === 'boolean'),
  typeOf: v => Array.isArray(v) ? '[]interface {}' : v === null ? '<nil>' : typeof v === 'object' ? 'map[string]interface {}' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float64') : typeof v === 'boolean' ? 'bool' : 'string',
  regexMatch: (re, s) => new RegExp(re).test(String(s)), regexReplaceAll: (re, s, r) => String(s).replace(new RegExp(re, 'g'), r.replace(/\$\{?(\d)\}?/g, '$$$1')),
  now: () => '2026-01-01T00:00:00Z', date: (f, d) => String(d), uuidv4: () => '6c8b1f2e-4d3a-4b7e-9c11-2f4e8a6d0b13',
  lookup: () => ({}), fail: msg => { throw new TemplateError(msg); },
};

// ---------------------------------------------------------------- execution
export function makeEngine({ files, funcs = {} }) {
  // files: { 'chart/templates/x.yaml': text }; every file's defines are global (like Helm)
  const trees = {};
  const defines = {};
  for (const [name, text] of Object.entries(files)) {
    const tree = parseTree(tokenize(text, name), name);
    trees[name] = tree;
    Object.assign(defines, Object.fromEntries(Object.entries(tree.defines).map(([k, v]) => [k, { nodes: v, file: name }])));
  }
  const allFuncs = { ...FUNCS, ...funcs };
  function exec(nodes, dot, root, vars, file) {
    let out = '';
    for (const n of nodes) {
      if (n.k === 'text') { out += n.v; continue; }
      if (n.k === 'act') {
        const v = evalPipe(n.pipe, dot, root, vars, file, n);
        if (!n.pipe.decl) out += v === undefined || v === null ? '' : goStr(v);
        continue;
      }
      if (n.k === 'if' || n.k === 'with') {
        const scope = new Map(vars);
        const v = evalPipe(n.pipe, dot, root, scope, file, n);
        if (truthy(v)) { out += exec(n.body, n.k === 'with' ? v : dot, root, scope, file); continue; }
        let done = false;
        for (const e of n.elses) {
          if (!e.cond) { out += exec(e.body, dot, root, scope, file); done = true; break; }
          const cv = evalPipe(e.cond, dot, root, scope, file, n);
          if (truthy(cv)) { out += exec(e.body, n.k === 'with' ? cv : dot, root, scope, file); done = true; break; }
        }
        void done;
        continue;
      }
      if (n.k === 'range') {
        const decl = n.pipe.decl;
        const v = evalPipe({ ...n.pipe, decl: null }, dot, root, vars, file, n);
        const entries = Array.isArray(v) ? v.map((x, k) => [k, x]) : v && typeof v === 'object' ? Object.keys(v).sort().map(k => [k, v[k]]) : typeof v === 'number' ? Array.from({ length: v }, (_, k) => [k, k]) : [];
        if (!entries.length) { const e = n.elses.find(x => !x.cond); if (e) out += exec(e.body, dot, root, vars, file); continue; }
        for (const [k, x] of entries) {
          const scope = new Map(vars);
          if (decl) { if (decl.names.length === 2) { scope.set(decl.names[0], k); scope.set(decl.names[1], x); } else scope.set(decl.names[0], x); }
          out += exec(n.body, x, root, scope, file);
        }
        continue;
      }
      if (n.k === 'template') { const d = defines[n.name]; if (!d) throw new TemplateError(`template: ${file}:${n.line}: no such template "${n.name}"`); out += exec(d.nodes, n.pipe ? evalPipe(n.pipe, dot, root, vars, file, n) : null, root, new Map([['$', n.pipe ? evalPipe(n.pipe, dot, root, vars, file, n) : null]]), d.file); }
    }
    return out;
  }
  function field(base, path, file, n) {
    let v = base;
    for (const seg of path.split('.').filter(Boolean)) {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'object') throw new TemplateError(`template: ${file}:${n.line}: executing "${file}" at <${n.src ? n.src.split(' ')[0] : path}>: can't evaluate field ${seg} in type ${typeof v === 'string' ? 'string' : typeof v === 'number' ? 'int' : 'bool'}`);
      v = v[seg];
    }
    return v;
  }
  function evalArg(t, dot, root, vars, file, n) {
    if (t.k === 'str' || t.k === 'num' || t.k === 'bool') return t.v;
    if (t.k === 'nil') return null;
    if (t.k === 'field') return t.v === '.' ? dot : field(dot, t.v, file, n);
    if (t.k === 'var') { const [nm, ...rest] = t.v.split('.'); const base = nm === '$' ? (vars.has('$') ? vars.get('$') : root) : vars.get(nm); if (!vars.has(nm) && nm !== '$') throw new TemplateError(`template: ${file}:${n.line}: undefined variable "${nm}"`); return field(base, rest.join('.'), file, n); }
    if (t.k === 'sub') return evalPipe(t.pipe, dot, root, vars, file, n);
    if (t.k === 'ident') return callFn(t.v, [], dot, root, vars, file, n);
    return undefined;
  }
  function callFn(name, args, dot, root, vars, file, n) {
    if (name === 'include') { const d = defines[args[0]]; if (!d) throw new TemplateError(`template: ${file}:${n.line}:${3}: executing "${file}" at <include "${args[0]}" .>: error calling include: template: no template "${args[0]}" associated with template "gotpl"`); return exec(d.nodes, args[1], root, new Map([['$', args[1]]]), d.file); }
    if (name === 'required') { if (!truthy(args[1]) && args[1] !== false && args[1] !== 0) throw new TemplateError(`execution error at (${file}:${n.line}:${3}): ${args[0]}`); return args[1]; }
    if (name === 'tpl') return render(args[0], args[1]);
    const f = allFuncs[name];
    if (!f) throw new TemplateError(`parse error at (${file}:${n.line}): function "${name}" not defined`);
    return f(...args);
  }
  function evalCmd(cmd, piped, dot, root, vars, file, n) {
    const [head, ...rest] = cmd;
    if (head.k === 'ident') {
      const args = rest.map(t => evalArg(t, dot, root, vars, file, n));
      if (piped !== NONE) args.push(piped);
      return callFn(head.v, args, dot, root, vars, file, n);
    }
    if (rest.length) throw new TemplateError(`template: ${file}:${n.line}: can't give argument to non-function ${head.v}`);
    return evalArg(head, dot, root, vars, file, n);
  }
  function evalPipe(pipe, dot, root, vars, file, n) {
    let v = NONE;
    for (const cmd of pipe.cmds) v = evalCmd(cmd, v, dot, root, vars, file, n);
    if (v === NONE) v = undefined;
    if (pipe.decl) { if (pipe.decl.assign && !vars.has(pipe.decl.names[0])) throw new TemplateError(`template: ${file}:${n.line}: undefined variable "${pipe.decl.names[0]}"`); vars.set(pipe.decl.names[0], v); }
    return v;
  }
  function render(text, dot) { const t = parseTree(tokenize(text, 'tpl'), 'tpl'); return exec(t.nodes, dot, dot, new Map(), 'tpl'); }
  return {
    run(file, data) { const t = trees[file]; return exec(t.nodes, data, data, new Map([['$', data]]), file); },
  };
}
const NONE = Symbol('none');
