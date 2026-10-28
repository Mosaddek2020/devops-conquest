// jq: a practical subset of the JSON processor. Filters: . .a .a.b .["k"] .[] .[n] .[a:b]
// | , select(cond) map(f) keys length has("k") to_entries from_entries sort sort_by(f)
// group_by(f) unique min max add first last type tostring tonumber ascii_downcase
// ascii_upcase join(s) split(s) test("re") contains(x) not, comparisons, and/or,
// object construction {a: .x, b}, array construction [ … ], string interpolation "\(.a)".
// Options: -r (raw strings) -c (compact) -e (exit 1 on null/false) -s (slurp) -n.

import { def } from '../registry.js';
import { fsx } from '../fsx.js';

class JqError extends Error {}

function parse(src) {
  let i = 0;
  const s = src;
  const ws = () => { while (/\s/.test(s[i])) i++; };
  const peek = (t) => { ws(); return s.startsWith(t, i); };
  const eat = (t) => { ws(); if (!s.startsWith(t, i)) throw new JqError(`jq: error: syntax error, expected ${t} at position ${i}`); i += t.length; };
  function pipe() {
    let l = comma();
    if (peek('as ') || peek('as$')) { i += 2; ws(); const m = s.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/); if (!m) throw new JqError(`jq: error: syntax error, expected $name after as`); i += m[0].length; eat('|'); return { k: 'bind', src: l, name: m[1], body: pipe() }; }
    while (peek('|') && !peek('||')) { i++; const r = comma(); const a = l; l = { k: 'pipe', a, b: r }; if (peek('as ')) { i += 2; ws(); const m = s.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/); i += m[0].length; eat('|'); return { k: 'pipe', a, b: { k: 'bind', src: r, name: m[1], body: pipe() } }; } }
    return l;
  }
  function comma() { let l = alt(); while (peek(',')) { i++; const r = alt(); l = { k: 'comma', a: l, b: r }; } return l; }
  function alt() { let l = or(); while (peek('//')) { i += 2; l = { k: 'alt', a: l, b: or() }; } return l; }
  function or() { let l = and(); while (peek('or ')) { i += 2; l = { k: 'or', a: l, b: and() }; } return l; }
  function and() { let l = cmp(); while (peek('and ')) { i += 3; l = { k: 'and', a: l, b: cmp() }; } return l; }
  function cmp() { let l = add(); ws(); const m = s.slice(i).match(/^(==|!=|<=|>=|<|>)/); if (m) { i += m[0].length; return { k: 'cmp', op: m[0], a: l, b: add() }; } return l; }
  function add() { let l = mul(); while (true) { ws(); if (s[i] === '+' || (s[i] === '-' && !/\d/.test(s[i + 1] || ''))) { const op = s[i++]; l = { k: 'arith', op, a: l, b: mul() }; } else return l; } }
  function mul() { let l = postfix(); while (true) { ws(); if (s[i] === '*' || (s[i] === '/' && s[i + 1] !== '/') || s[i] === '%') { const op = s[i++]; l = { k: 'arith', op, a: l, b: postfix() }; } else return l; } }
  function postfix() {
    let t = term();
    while (true) {
      ws();
      if (s[i] === '[' ) { t = { k: 'pipe', a: t, b: bracket() }; continue; }
      if (s[i] === '.' && /[A-Za-z_"]/.test(s[i + 1] || '')) { i++; t = { k: 'pipe', a: t, b: field() }; continue; }
      if (s[i] === '?') { i++; t = { k: 'try', a: t }; continue; }
      return t;
    }
  }
  function field() {
    if (s[i] === '"') { const str = stringLit(); return { k: 'field', name: str.v }; }
    const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    i += m[0].length;
    return { k: 'field', name: m[0] };
  }
  function bracket() {
    eat('[');
    if (peek(']')) { i++; return { k: 'iter' }; }
    const a = pipe();
    if (peek(':')) { i++; const b = peek(']') ? null : pipe(); eat(']'); return { k: 'slice', a, b }; }
    eat(']');
    return { k: 'index', a };
  }
  function stringLit() {
    i++;
    const parts = [];
    let cur = '';
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && s[i + 1] === '(') { if (cur) parts.push(cur); cur = ''; i += 2; let d = 1, j = i; while (j < s.length && d) { if (s[j] === '(') d++; if (s[j] === ')') d--; j++; } parts.push(parse(s.slice(i, j - 1))); i = j; continue; }
      if (s[i] === '\\') { const n = s[i + 1]; cur += n === 'n' ? '\n' : n === 't' ? '\t' : n; i += 2; continue; }
      cur += s[i++];
    }
    i++;
    if (cur || !parts.length) parts.push(cur);
    return parts.length === 1 && typeof parts[0] === 'string' ? { k: 'lit', v: parts[0] } : { k: 'interp', parts };
  }
  function term() {
    ws();
    const c = s[i];
    if (c === '.') {
      if (s[i + 1] === '.') { i += 2; return { k: 'recurse' }; }
      i++;
      if (/[A-Za-z_"]/.test(s[i] || '')) return field();
      if (s[i] === '[') return bracket();
      return { k: 'id' };
    }
    if (c === '"') return stringLit();
    if (c === '$') { const m = s.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/); if (!m) throw new JqError(`jq: error: syntax error at position ${i}`); i += 1 + m[0].length; return { k: 'var', name: m[0] }; }
    if (c === '@') { const m = s.slice(i + 1).match(/^[a-z0-9]+/); i += 1 + m[0].length; return { k: 'format', name: m[0] }; }
    if (s.startsWith('if', i) && /[\s(]/.test(s[i + 2] || '')) {
      i += 2;
      const cond = pipe(); eat('then'); const then = pipe();
      const elifs = [];
      while (peek('elif')) { i += 4; const c2 = pipe(); eat('then'); elifs.push([c2, pipe()]); }
      let els = null;
      if (peek('else')) { i += 4; els = pipe(); }
      eat('end');
      return { k: 'if', cond, then, elifs, els };
    }
    if (c === '(') { i++; const e = pipe(); eat(')'); return e; }
    if (c === '[') { i++; if (peek(']')) { i++; return { k: 'arr', e: null }; } const e = pipe(); eat(']'); return { k: 'arr', e }; }
    if (c === '{') {
      i++;
      const entries = [];
      while (!peek('}')) {
        ws();
        let key;
        if (s[i] === '"') key = stringLit();
        else if (s[i] === '(') { i++; key = pipe(); eat(')'); }
        else { const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/); key = { k: 'lit', v: m[0] }; i += m[0].length; }
        ws();
        let val;
        if (s[i] === ':') { i++; val = alt(); } else val = { k: 'field', name: key.v };
        entries.push([key, val]);
        ws();
        if (s[i] === ',') i++;
      }
      eat('}');
      return { k: 'obj', entries };
    }
    if (/[-\d]/.test(c)) { const m = s.slice(i).match(/^-?\d+(\.\d+)?/); i += m[0].length; return { k: 'lit', v: Number(m[0]) }; }
    const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) {
      i += m[0].length;
      const name = m[0];
      if (name === 'true' || name === 'false') return { k: 'lit', v: name === 'true' };
      if (name === 'null') return { k: 'lit', v: null };
      const args = [];
      if (peek('(')) { i++; args.push(pipe()); while (peek(';')) { i++; args.push(pipe()); } eat(')'); }
      return { k: 'fn', name, args };
    }
    throw new JqError(`jq: error: syntax error, unexpected ${JSON.stringify(c ?? 'end')} at position ${i}`);
  }
  const r = pipe();
  ws();
  if (i < s.length) throw new JqError(`jq: error: syntax error, unexpected ${JSON.stringify(s.slice(i, i + 6))}`);
  return r;
}

const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;
const truthy = v => v !== null && v !== false && v !== undefined;
const cmpVals = (a, b) => { const order = ['null', 'boolean', 'number', 'string', 'array', 'object']; const ta = order.indexOf(typeOf(a)), tb = order.indexOf(typeOf(b)); if (ta !== tb) return ta - tb; if (typeof a === 'number' || typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0; return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0; };

let VARS = {};
function run(node, input) {
  switch (node.k) {
    case 'id': return [input];
    case 'recurse': { const out = []; const walk = v => { out.push(v); if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x); }; walk(input); return out; }
    case 'lit': return [node.v];
    case 'field': if (input === null || input === undefined) return [null]; if (typeof input !== 'object' || Array.isArray(input)) throw new JqError(`jq: error: Cannot index ${typeOf(input)} with "${node.name}"`); return [input[node.name] ?? null];
    case 'iter': if (Array.isArray(input)) return input; if (input && typeof input === 'object') return Object.values(input); throw new JqError(`jq: error: Cannot iterate over ${typeOf(input)}`);
    case 'index': return run(node.a, input).map(k => input === null ? null : (typeof k === 'number' ? (Array.isArray(input) ? input[k < 0 ? input.length + k : k] ?? null : (() => { throw new JqError(`jq: error: Cannot index ${typeOf(input)} with number`); })()) : input[k] ?? null));
    case 'slice': { const a = run(node.a, input)[0]; const b = node.b ? run(node.b, input)[0] : undefined; return [input.slice(a, b)]; }
    case 'pipe': return run(node.a, input).flatMap(v => run(node.b, v));
    case 'comma': return [...run(node.a, input), ...run(node.b, input)];
    case 'alt': { const a = run(node.a, input).filter(truthy); return a.length ? a : run(node.b, input); }
    case 'or': return [truthy(run(node.a, input)[0]) || truthy(run(node.b, input)[0])];
    case 'and': return [truthy(run(node.a, input)[0]) && truthy(run(node.b, input)[0])];
    case 'cmp': { const a = run(node.a, input)[0], b = run(node.b, input)[0]; const c = cmpVals(a, b); return [{ '==': JSON.stringify(a) === JSON.stringify(b), '!=': JSON.stringify(a) !== JSON.stringify(b), '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[node.op]]; }
    case 'arith': { const a = run(node.a, input)[0], b = run(node.b, input)[0]; if (node.op === '+') { if (a === null) return [b]; if (Array.isArray(a)) return [[...a, ...b]]; if (typeof a === 'object' && a) return [{ ...a, ...b }]; return [a + b]; } if (node.op === '-') return [Array.isArray(a) ? a.filter(x => !b.some(y => JSON.stringify(y) === JSON.stringify(x))) : a - b]; if (node.op === '*') return [a * b]; if (node.op === '/') return [typeof a === 'string' ? a.split(b) : a / b]; return [a % b]; }
    case 'try': try { return run(node.a, input); } catch { return []; }
    case 'arr': return [node.e ? run(node.e, input) : []];
    case 'obj': {
      let outs = [{}];
      for (const [kNode, vNode] of node.entries) {
        const keys = run(kNode, input), vals = run(vNode, input);
        const next = [];
        for (const o of outs) for (const k of keys) for (const v of vals) next.push({ ...o, [k]: v });
        outs = next;
      }
      return outs;
    }
    case 'interp': return [node.parts.map(p => typeof p === 'string' ? p : (() => { const v = run(p, input)[0]; return typeof v === 'string' ? v : JSON.stringify(v); })()).join('')];
    case 'fn': return fn(node, input);
    case 'var': { if (node.name === 'ENV') return [VARS.ENV || {}]; if (!(node.name in VARS)) throw new JqError(`jq: error: $${node.name} is not defined`); return [VARS[node.name]]; }
    case 'bind': return run(node.src, input).flatMap(v => { const prev = VARS[node.name], had = node.name in VARS; VARS[node.name] = v; try { return run(node.body, input); } finally { if (had) VARS[node.name] = prev; else delete VARS[node.name]; } });
    case 'if': { for (const [c2, b] of [[node.cond, node.then], ...node.elifs]) if (truthy(run(c2, input)[0])) return run(b, input); return node.els ? run(node.els, input) : [input]; }
    case 'format': {
      const cell = v => v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      switch (node.name) {
        case 'csv': if (!Array.isArray(input)) throw new JqError(`jq: error: ${typeOf(input)} cannot be csv-formatted, only an array can be`); return [input.map(v => typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : cell(v)).join(',')];
        case 'tsv': if (!Array.isArray(input)) throw new JqError(`jq: error: ${typeOf(input)} cannot be tsv-formatted, only an array can be`); return [input.map(v => cell(v).replace(/\t/g, '\\t')).join('\t')];
        case 'json': return [JSON.stringify(input)];
        case 'text': return [cell(input)];
        case 'base64': return [btoa(cell(input))];
        case 'base64d': return [atob(cell(input))];
        case 'uri': return [encodeURIComponent(cell(input))];
        case 'sh': return [Array.isArray(input) ? input.map(v => `'${cell(v).replace(/'/g, "'\\''")}'`).join(' ') : `'${cell(input).replace(/'/g, "'\\''")}'`];
      }
      throw new JqError(`jq: error: ${node.name} is not a valid format`);
    }
  }
  throw new JqError('jq: error: unsupported filter');
}

function fn(node, input) {
  const a = node.args;
  const arg = (k, v = input) => run(a[k], v)[0];
  switch (node.name) {
    case 'select': return truthy(arg(0)) ? [input] : [];
    case 'map': return [(Array.isArray(input) ? input : Object.values(input || {})).flatMap(v => run(a[0], v))];
    case 'keys': return [Object.keys(input).sort()];
    case 'keys_unsorted': return [Object.keys(input)];
    case 'length': return [input === null ? 0 : typeof input === 'string' || Array.isArray(input) ? input.length : typeof input === 'object' ? Object.keys(input).length : Math.abs(input)];
    case 'has': return [Object.prototype.hasOwnProperty.call(input, arg(0))];
    case 'to_entries': return [Object.entries(input).map(([key, value]) => ({ key, value }))];
    case 'from_entries': return [Object.fromEntries(input.map(e => [e.key ?? e.name ?? e.k, e.value ?? e.v]))];
    case 'with_entries': return [Object.fromEntries(Object.entries(input).map(([key, value]) => run(a[0], { key, value })[0]).map(e => [e.key, e.value]))];
    case 'sort': return [[...input].sort(cmpVals)];
    case 'sort_by': return [[...input].sort((x, y) => cmpVals(run(a[0], x)[0], run(a[0], y)[0]))];
    case 'group_by': { const m = new Map(); for (const v of [...input].sort((x, y) => cmpVals(run(a[0], x)[0], run(a[0], y)[0]))) { const k = JSON.stringify(run(a[0], v)[0]); if (!m.has(k)) m.set(k, []); m.get(k).push(v); } return [[...m.values()]]; }
    case 'unique': return [[...new Map(input.map(v => [JSON.stringify(v), v])).values()].sort(cmpVals)];
    case 'unique_by': return [[...new Map(input.map(v => [JSON.stringify(run(a[0], v)[0]), v])).values()]];
    case 'min': return [input.length ? [...input].sort(cmpVals)[0] : null];
    case 'max': return [input.length ? [...input].sort(cmpVals).at(-1) : null];
    case 'min_by': return [input.length ? [...input].sort((x, y) => cmpVals(run(a[0], x)[0], run(a[0], y)[0]))[0] : null];
    case 'max_by': return [input.length ? [...input].sort((x, y) => cmpVals(run(a[0], x)[0], run(a[0], y)[0])).at(-1) : null];
    case 'add': return [input.length ? input.reduce((x, y) => x === null ? y : Array.isArray(x) ? [...x, ...y] : typeof x === 'object' ? { ...x, ...y } : x + y) : null];
    case 'first': return a.length ? run(a[0], input).slice(0, 1) : [input[0] ?? null];
    case 'last': return a.length ? run(a[0], input).slice(-1) : [input[input.length - 1] ?? null];
    case 'type': return [typeOf(input)];
    case 'tostring': return [typeof input === 'string' ? input : JSON.stringify(input)];
    case 'tonumber': return [Number(input)];
    case 'ascii_downcase': return [String(input).toLowerCase()];
    case 'ascii_upcase': return [String(input).toUpperCase()];
    case 'join': return [input.map(v => v === null ? '' : String(v)).join(arg(0))];
    case 'split': return [String(input).split(arg(0))];
    case 'test': return [new RegExp(arg(0), a[1] ? arg(1) : '').test(input)];
    case 'contains': { const b = arg(0); return [typeof input === 'string' ? input.includes(b) : JSON.stringify(input).includes(JSON.stringify(b).replace(/^[[{]|[\]}]$/g, ''))]; }
    case 'startswith': return [String(input).startsWith(arg(0))];
    case 'endswith': return [String(input).endsWith(arg(0))];
    case 'not': return [!truthy(input)];
    case 'empty': return [];
    case 'values': return truthy(input) ? [input] : [];
    case 'del': { const o = Array.isArray(input) ? [...input] : { ...input }; const path = a[0]; if (path.k === 'field') delete o[path.name]; return [o]; }
    case 'tojson': return [JSON.stringify(input)];
    case 'fromjson': return [JSON.parse(input)];
    case 'env': return [{}];
    case 'any': return [input.some(truthy)];
    case 'all': return [input.every(truthy)];
    case 'flatten': return [input.flat(Infinity)];
    case 'reverse': return [[...input].reverse()];
    case 'ltrimstr': { const p = arg(0); return [String(input).startsWith(p) ? String(input).slice(p.length) : input]; }
    case 'rtrimstr': { const p = arg(0); return [String(input).endsWith(p) ? String(input).slice(0, -p.length) : input]; }
    case 'floor': return [Math.floor(input)];
    case 'length_': return [0];
    case 'ascii': return [String.fromCharCode(input)];
    case 'tojson_': return [JSON.stringify(input)];
    case 'limit': return run(a[1], input).slice(0, arg(0));
    case 'range': return Array.from({ length: Math.max(0, (a.length > 1 ? arg(1) : arg(0)) - (a.length > 1 ? arg(0) : 0)) }, (_, k) => k + (a.length > 1 ? arg(0) : 0));
    case 'paths': { const out = []; const walk = (v, p) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { const q = [...p, Array.isArray(v) ? Number(k) : k]; out.push(q); walk(x, q); } }; walk(input, []); return out; }
    case 'isnull': return [input === null];
    case 'error': throw new JqError(`jq: error (at <stdin>:0): ${a.length ? arg(0) : JSON.stringify(input)}`);
    case 'input_line_number': return [0];
    case 'sub': case 'gsub': return [String(input).replace(new RegExp(arg(0), node.name === 'gsub' ? 'g' : ''), arg(1))];
    case 'ceil': return [Math.ceil(input)];
    case 'sqrt': return [Math.sqrt(input)];
    case 'todate': return [new Date(input * 1000).toISOString().replace(/\.\d+Z$/, 'Z')];
    case 'fromdate': case 'fromdateiso8601': return [Math.floor(Date.parse(input) / 1000)];
    case 'now': return [Math.floor(Date.now() / 1000)];
    case 'round': return [Math.round(input)];
  }
  throw new JqError(`jq: error: ${node.name}/${a.length} is not defined`);
}

function format(v, { raw, compact, color }) {
  if (raw && typeof v === 'string') return v;
  return compact ? JSON.stringify(v) : JSON.stringify(v, null, 2);
}

def('jq', c => {
  const flags = new Set();
  const rest = [];
  VARS = { ENV: { ...(c.env || {}) } };
  const argv = [];
  for (let k = 0; k < c.args.length; k++) {
    const a = c.args[k];
    if (a === '--arg' || a === '--argjson') { const name = c.args[k + 1], v = c.args[k + 2]; k += 2; if (a === '--arg') VARS[name] = v; else { try { VARS[name] = JSON.parse(v); } catch { return c.fail(`jq: Invalid JSON text passed to --argjson`, 2); } } continue; }
    argv.push(a);
  }
  for (const a of argv) { if (/^-[rcesnaj]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch); else if (a === '--raw-output') flags.add('r'); else if (a === '--compact-output') flags.add('c'); else rest.push(a); }
  const filter = rest.shift() ?? '.';
  let text;
  try { text = flags.has('n') ? 'null' : rest.length ? rest.map(p => fsx(c).read(p)).join('\n') : (c.stdin ?? ''); } catch (e) { return c.fail(e.message.replace(/^jq: /, 'jq: error: Could not open '), 2); }
  let inputs = [];
  try {
    const t = text.trim();
    if (!t) inputs = [];
    else { try { inputs = [JSON.parse(t)]; } catch { inputs = t.split(/\n(?=[[{"\d-]|true|false|null)/).map(x => JSON.parse(x)); } }
  } catch (e) { return c.fail(`jq: error (at <stdin>:1): Cannot parse input: ${e.message.replace(/^.*?:\s*/, '')}`, 2); }
  if (flags.has('s')) inputs = [inputs];
  let ast;
  try { ast = parse(filter); } catch (e) { return c.fail(e.message + '\njq: 1 compile error', 3); }
  let last = null;
  try {
    for (const inp of inputs) for (const v of run(ast, inp)) { last = v; c.print(format(v, { raw: flags.has('r') || flags.has('j'), compact: flags.has('c') })); }
  } catch (e) { if (e instanceof JqError) return c.fail(e.message, 5); throw e; }
  if (flags.has('e')) return truthy(last) ? 0 : 1;
  return 0;
}, { pkg: 'jq' });
