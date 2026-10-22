// A time-series store and a PromQL evaluator: selectors with label matchers, range
// vectors, rate/irate/increase/*_over_time, aggregations with by/without, topk/bottomk,
// histogram_quantile, arithmetic and comparison operators with vector matching.

export class TSDB {
  constructor() { this.series = new Map(); this.retention = 6 * 3600; }
  key(name, labels) { return name + '{' + Object.keys(labels).sort().map(k => `${k}="${labels[k]}"`).join(',') + '}'; }
  add(name, labels, t, v) {
    const k = this.key(name, labels);
    let s = this.series.get(k);
    if (!s) { s = { name, labels: { ...labels }, samples: [] }; this.series.set(k, s); }
    const last = s.samples[s.samples.length - 1];
    if (last && last.t >= t) { last.v = v; return; }
    s.samples.push({ t, v });
    if (s.samples.length > 4000) s.samples.splice(0, 1000);
  }
  select(name, matchers) {
    const out = [];
    for (const s of this.series.values()) {
      if (name && s.name !== name) continue;
      if (matchers.every(m => matchLabel(m, m.name === '__name__' ? s.name : s.labels[m.name] ?? ''))) out.push(s);
    }
    return out;
  }
  names() { return [...new Set([...this.series.values()].map(s => s.name))].sort(); }
}
function matchLabel(m, v) {
  switch (m.op) {
    case '=': return v === m.value;
    case '!=': return v !== m.value;
    case '=~': return new RegExp(`^(?:${m.value})$`).test(v);
    case '!~': return !new RegExp(`^(?:${m.value})$`).test(v);
  }
  return false;
}

export class PromQLError extends Error {}

// ---------------------------------------------------------------- parser
const DUR = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
export const parseDuration = s => { let t = 0; for (const m of String(s).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g)) t += Number(m[1]) * DUR[m[2]]; return t; };
const AGG = ['sum', 'avg', 'min', 'max', 'count', 'topk', 'bottomk', 'stddev', 'group', 'quantile', 'count_values'];
const FUNCS = ['rate', 'irate', 'increase', 'delta', 'histogram_quantile', 'abs', 'ceil', 'floor', 'round', 'sqrt', 'exp', 'ln', 'log2', 'log10', 'clamp_min', 'clamp_max', 'absent', 'avg_over_time', 'max_over_time', 'min_over_time', 'sum_over_time', 'count_over_time', 'last_over_time', 'quantile_over_time', 'time', 'vector', 'scalar', 'sort', 'sort_desc', 'label_replace', 'changes', 'resets', 'deriv', 'predict_linear', 'timestamp', 'day_of_week', 'hour'];

function lex(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const dur = src.slice(i).match(/^\[\s*(\d+(?:ms|[smhdwy])(?:\d+(?:ms|[smhdwy]))*)\s*(?::\s*(\d+(?:ms|[smhdwy]))?\s*)?\]/);
    if (dur) { toks.push({ t: 'range', v: parseDuration(dur[1]), sub: dur[0].includes(':'), step: dur[2] ? parseDuration(dur[2]) : null }); i += dur[0].length; continue; }
    const num = src.slice(i).match(/^(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|Inf|NaN)/i);
    if (num && !/[a-zA-Z_:]/.test(src[i + num[0].length] || '') || (num && /^(Inf|NaN)$/i.test(num[0]))) { toks.push({ t: 'num', v: Number(num[0].replace(/^inf$/i, 'Infinity')) }); i += num[0].length; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { const j = src.indexOf(ch, i + 1); if (j < 0) throw new PromQLError(`1:${i + 1}: parse error: unterminated quoted string ${src.slice(i)}`); toks.push({ t: 'str', v: src.slice(i + 1, j).replace(/\\(.)/g, '$1') }); i = j + 1; continue; }
    const id = src.slice(i).match(/^[a-zA-Z_:][\w:]*/);
    if (id) { toks.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = ['==', '!=', '>=', '<=', '=~', '!~', '+', '-', '*', '/', '%', '^', '>', '<', '=', '(', ')', '{', '}', ',', '[', ']'].find(o => src.startsWith(o, i));
    if (op) { toks.push({ t: 'op', v: op }); i += op.length; continue; }
    throw new PromQLError(`1:${i + 1}: parse error: unexpected character: '${ch}'`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

export function parsePromQL(src) {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const isOp = v => toks[i].t === 'op' && toks[i].v === v;
  const isId = v => toks[i].t === 'id' && toks[i].v === v;
  const expect = v => { const t = next(); if (!(t.t === 'op' && t.v === v)) throw new PromQLError(`1:${i}: parse error: unexpected ${t.t === 'eof' ? 'end of input' : `"${t.v}"`}${v ? `, expected "${v}"` : ''}`); return t; };
  const PREC = [['or'], ['and', 'unless'], ['==', '!=', '>', '<', '>=', '<='], ['+', '-'], ['*', '/', '%'], ['^']];
  function binary(level) {
    if (level >= PREC.length) return unary();
    let l = binary(level + 1);
    while (true) {
      const t = peek();
      const opv = t.t === 'op' || t.t === 'id' ? t.v : null;
      if (!PREC[level].includes(opv)) return l;
      next();
      let bool = false, on = null, ignoring = null, group = null;
      if (isId('bool')) { next(); bool = true; }
      if (isId('on') || isId('ignoring')) { const kind = next().v; const ls = labelList(); if (kind === 'on') on = ls; else ignoring = ls; }
      if (isId('group_left') || isId('group_right')) { group = next().v; if (isOp('(')) labelList(); }
      const r = level === 5 ? binary(level) : binary(level + 1);
      l = { t: 'bin', op: opv, l, r, bool, on, ignoring, group };
    }
  }
  function labelList() { expect('('); const out = []; while (!isOp(')')) { out.push(next().v); if (isOp(',')) next(); } expect(')'); return out; }
  function unary() { if (isOp('-')) { next(); return { t: 'bin', op: '*', l: { t: 'num', v: -1 }, r: unary() }; } if (isOp('+')) { next(); return unary(); } return postfix(primary()); }
  function postfix(e) {
    while (true) {
      if (peek().t === 'range') { const r = next(); e = r.sub ? { t: 'subquery', e, range: r.v, step: r.step } : { t: 'matrix', e, range: r.v }; continue; }
      if (isId('offset')) { next(); const d = next(); e = { ...e, offset: parseDuration(d.v ?? d) }; continue; }
      return e;
    }
  }
  function matchers() {
    const ms = [];
    expect('{');
    while (!isOp('}')) {
      const n = next();
      if (n.t !== 'id') throw new PromQLError(`1:${i}: parse error: unexpected "${n.v}" in label matching, expected label`);
      const o = next();
      if (!(o.t === 'op' && ['=', '!=', '=~', '!~'].includes(o.v))) throw new PromQLError(`1:${i}: parse error: unexpected "${o.v}" in label matching, expected label matching operator`);
      const v = next();
      if (v.t !== 'str') throw new PromQLError(`1:${i}: parse error: unexpected "${v.v}" in label matching, expected string`);
      ms.push({ name: n.v, op: o.v, value: v.v });
      if (isOp(',')) next();
    }
    expect('}');
    return ms;
  }
  function primary() {
    const t = next();
    if (t.t === 'num') return { t: 'num', v: t.v };
    if (t.t === 'str') return { t: 'str', v: t.v };
    if (t.t === 'op' && t.v === '(') { const e = binary(0); expect(')'); return { t: 'paren', e }; }
    if (t.t === 'op' && t.v === '{') { i--; return { t: 'sel', name: null, matchers: matchers() }; }
    if (t.t === 'id') {
      if (AGG.includes(t.v) && (isOp('(') || isId('by') || isId('without'))) {
        let grouping = null, without = false;
        if (isId('by') || isId('without')) { without = next().v === 'without'; grouping = labelList(); }
        expect('(');
        const args = [binary(0)];
        while (isOp(',')) { next(); args.push(binary(0)); }
        expect(')');
        if (isId('by') || isId('without')) { without = next().v === 'without'; grouping = labelList(); }
        return { t: 'agg', op: t.v, args, grouping, without };
      }
      if (FUNCS.includes(t.v) && isOp('(')) {
        next();
        const args = [];
        while (!isOp(')')) { args.push(binary(0)); if (isOp(',')) next(); }
        expect(')');
        return { t: 'call', fn: t.v, args };
      }
      if (isOp('(')) throw new PromQLError(`1:1: parse error: unknown function with name "${t.v}"`);
      const ms = isOp('{') ? matchers() : [];
      return { t: 'sel', name: t.v, matchers: ms };
    }
    throw new PromQLError(`1:${i}: parse error: unexpected ${t.t === 'eof' ? 'end of input' : `"${t.v}"`}`);
  }
  const e = binary(0);
  if (peek().t !== 'eof') throw new PromQLError(`1:${i}: parse error: unexpected "${peek().v}"`);
  return e;
}

// ---------------------------------------------------------------- evaluation
// values: { type: 'vector', samples: [{labels, v}] } | { type: 'matrix', series: [{labels, points}] } | { type: 'scalar', v } | { type: 'string', v }
const lblKey = (l, drop = []) => Object.keys(l).filter(k => !drop.includes(k)).sort().map(k => `${k}=${l[k]}`).join(',');
const withoutName = l => { const o = { ...l }; delete o.__name__; return o; };
const LOOKBACK = 300;

export function evalPromQL(db, src, t) {
  const ast = typeof src === 'string' ? parsePromQL(src) : src;
  return ev(ast, db, t);
}

function ev(n, db, t) {
  const at = t - (n.offset || 0);
  switch (n.t) {
    case 'num': return { type: 'scalar', v: n.v };
    case 'str': return { type: 'string', v: n.v };
    case 'paren': return ev(n.e, db, t);
    case 'sel': {
      if (!n.name && !n.matchers.some(m => !['=~', '!='].includes(m.op) || m.value !== '.*')) throw new PromQLError('vector selector must contain at least one non-empty matcher');
      const samples = [];
      for (const s of db.select(n.name, n.matchers)) {
        let last = null;
        for (let k = s.samples.length - 1; k >= 0; k--) { const p = s.samples[k]; if (p.t <= at) { if (at - p.t <= LOOKBACK) last = p; break; } }
        if (last && !Number.isNaN(last.v) && last.stale !== true) samples.push({ labels: { __name__: s.name, ...s.labels }, v: last.v });
      }
      return { type: 'vector', samples };
    }
    case 'matrix': {
      if (n.e.t !== 'sel') throw new PromQLError('ranges only allowed for vector selectors');
      const att = t - (n.e.offset || n.offset || 0);
      const series = [];
      for (const s of db.select(n.e.name, n.e.matchers)) {
        const points = s.samples.filter(p => p.t > att - n.range && p.t <= att);
        if (points.length) series.push({ labels: { __name__: s.name, ...s.labels }, points });
      }
      return { type: 'matrix', series, range: n.range };
    }
    case 'subquery': {
      const step = n.step || 60;
      const map = new Map();
      for (let tt = Math.floor((t - n.range) / step) * step + step; tt <= t; tt += step) {
        const v = ev(n.e, db, tt);
        if (v.type !== 'vector') continue;
        for (const s of v.samples) { const k = lblKey(s.labels); if (!map.has(k)) map.set(k, { labels: s.labels, points: [] }); map.get(k).points.push({ t: tt, v: s.v }); }
      }
      return { type: 'matrix', series: [...map.values()], range: n.range };
    }
    case 'call': return call(n, db, t);
    case 'agg': return agg(n, db, t);
    case 'bin': return bin(n, db, t);
  }
  throw new PromQLError('unsupported expression');
}

function counterIncrease(points) {
  let inc = 0;
  for (let k = 1; k < points.length; k++) { const d = points[k].v - points[k - 1].v; inc += d >= 0 ? d : points[k].v; }
  return inc;
}

function call(n, db, t) {
  const arg = k => ev(n.args[k], db, t);
  const needMatrix = v => { if (v.type !== 'matrix') throw new PromQLError(`expected type range vector in call to function "${n.fn}", got instant vector`); return v; };
  const overTime = f => { const m = needMatrix(arg(0)); return { type: 'vector', samples: m.series.map(s => ({ labels: withoutName(s.labels), v: f(s.points.map(p => p.v), s.points) })) }; };
  const mapV = f => { const v = arg(0); if (v.type === 'scalar') return { type: 'scalar', v: f(v.v) }; return { type: 'vector', samples: v.samples.map(s => ({ labels: withoutName(s.labels), v: f(s.v) })) }; };
  switch (n.fn) {
    case 'rate': case 'increase': case 'irate': case 'delta': case 'deriv': {
      const m = needMatrix(arg(0));
      const out = [];
      for (const s of m.series) {
        if (s.points.length < 2) continue;
        const span = s.points[s.points.length - 1].t - s.points[0].t;
        if (n.fn === 'irate') { const a = s.points[s.points.length - 2], b = s.points[s.points.length - 1]; out.push({ labels: withoutName(s.labels), v: (b.v - a.v >= 0 ? b.v - a.v : b.v) / (b.t - a.t) }); continue; }
        if (n.fn === 'delta' || n.fn === 'deriv') { const d = s.points[s.points.length - 1].v - s.points[0].v; out.push({ labels: withoutName(s.labels), v: n.fn === 'deriv' ? d / (span || 1) : d * m.range / (span || 1) }); continue; }
        const inc = counterIncrease(s.points);
        // extrapolate to the full window, like Prometheus does
        const ext = inc * (m.range / (span || m.range));
        out.push({ labels: withoutName(s.labels), v: n.fn === 'rate' ? ext / m.range : ext });
      }
      return { type: 'vector', samples: out };
    }
    case 'avg_over_time': return overTime(v => v.reduce((a, b) => a + b, 0) / v.length);
    case 'max_over_time': return overTime(v => Math.max(...v));
    case 'min_over_time': return overTime(v => Math.min(...v));
    case 'sum_over_time': return overTime(v => v.reduce((a, b) => a + b, 0));
    case 'count_over_time': return overTime(v => v.length);
    case 'last_over_time': return overTime(v => v[v.length - 1]);
    case 'changes': return overTime(v => v.slice(1).filter((x, k) => x !== v[k]).length);
    case 'resets': return overTime(v => v.slice(1).filter((x, k) => x < v[k]).length);
    case 'quantile_over_time': { const q = arg(0).v; const m = needMatrix(ev(n.args[1], db, t)); return { type: 'vector', samples: m.series.map(s => ({ labels: withoutName(s.labels), v: quantile(q, s.points.map(p => p.v)) })) }; }
    case 'predict_linear': { const m = needMatrix(arg(0)); const secs = arg(1).v; return { type: 'vector', samples: m.series.filter(s => s.points.length > 1).map(s => { const a = s.points[0], b = s.points[s.points.length - 1]; const slope = (b.v - a.v) / ((b.t - a.t) || 1); return { labels: withoutName(s.labels), v: b.v + slope * secs }; }) }; }
    case 'abs': return mapV(Math.abs); case 'ceil': return mapV(Math.ceil); case 'floor': return mapV(Math.floor); case 'sqrt': return mapV(Math.sqrt); case 'exp': return mapV(Math.exp); case 'ln': return mapV(Math.log); case 'log2': return mapV(Math.log2); case 'log10': return mapV(Math.log10);
    case 'round': { const to = n.args[1] ? arg(1).v : 1; return mapV(v => Math.round(v / to) * to); }
    case 'clamp_min': { const lim = arg(1).v; return mapV(v => Math.max(v, lim)); }
    case 'clamp_max': { const lim = arg(1).v; return mapV(v => Math.min(v, lim)); }
    case 'absent': { const v = arg(0); const empty = v.type === 'vector' ? !v.samples.length : !v.series?.length; const lbl = {}; const sel = n.args[0].t === 'matrix' ? n.args[0].e : n.args[0]; for (const m of sel.matchers || []) if (m.op === '=') lbl[m.name] = m.value; return { type: 'vector', samples: empty ? [{ labels: lbl, v: 1 }] : [] }; }
    case 'time': return { type: 'scalar', v: t };
    case 'timestamp': { const v = arg(0); return { type: 'vector', samples: v.samples.map(s => ({ labels: withoutName(s.labels), v: t })) }; }
    case 'vector': return { type: 'vector', samples: [{ labels: {}, v: arg(0).v }] };
    case 'scalar': { const v = arg(0); return { type: 'scalar', v: v.samples.length === 1 ? v.samples[0].v : NaN }; }
    case 'sort': case 'sort_desc': { const v = arg(0); const s = [...v.samples].sort((a, b) => n.fn === 'sort' ? a.v - b.v : b.v - a.v); return { type: 'vector', samples: s, sorted: true }; }
    case 'hour': return { type: 'vector', samples: [{ labels: {}, v: new Date(t * 1000).getUTCHours() }] };
    case 'day_of_week': return { type: 'vector', samples: [{ labels: {}, v: new Date(t * 1000).getUTCDay() }] };
    case 'label_replace': { const v = arg(0); const [dst, repl, src, re] = [1, 2, 3, 4].map(k => arg(k).v); return { type: 'vector', samples: v.samples.map(s => { const m = String(s.labels[src] ?? '').match(new RegExp(`^(?:${re})$`)); return { labels: m ? { ...s.labels, [dst]: repl.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '') } : s.labels, v: s.v }; }) }; }
    case 'histogram_quantile': {
      const q = arg(0).v;
      const v = ev(n.args[1], db, t);
      if (v.type !== 'vector') throw new PromQLError('expected type instant vector in call to function "histogram_quantile"');
      const groups = new Map();
      for (const s of v.samples) { const k = lblKey(s.labels, ['le', '__name__']); if (!groups.has(k)) groups.set(k, { labels: withoutName(Object.fromEntries(Object.entries(s.labels).filter(([x]) => x !== 'le'))), buckets: [] }); groups.get(k).buckets.push({ le: s.labels.le === '+Inf' ? Infinity : Number(s.labels.le), c: s.v }); }
      const out = [];
      for (const g of groups.values()) {
        const b = g.buckets.sort((x, y) => x.le - y.le);
        const total = b[b.length - 1]?.c || 0;
        if (!total || b[b.length - 1].le !== Infinity) { out.push({ labels: g.labels, v: NaN }); continue; }
        const rank = q * total;
        let prevLe = 0, prevC = 0, val = b[b.length - 2]?.le ?? 0;
        for (const x of b) { if (x.c >= rank) { val = x.le === Infinity ? prevLe : prevLe + (x.le - prevLe) * ((rank - prevC) / ((x.c - prevC) || 1)); break; } prevLe = x.le; prevC = x.c; }
        out.push({ labels: g.labels, v: val });
      }
      return { type: 'vector', samples: out };
    }
  }
  throw new PromQLError(`function "${n.fn}" is not supported in the simulator`);
}
function quantile(q, vals) { const s = [...vals].sort((a, b) => a - b); if (!s.length) return NaN; const r = q * (s.length - 1); const lo = Math.floor(r), hi = Math.ceil(r); return s[lo] + (s[hi] - s[lo]) * (r - lo); }

function agg(n, db, t) {
  const param = ['topk', 'bottomk', 'quantile', 'count_values'].includes(n.op) ? ev(n.args[0], db, t).v : null;
  const v = ev(n.args[param !== null ? 1 : 0], db, t);
  if (v.type !== 'vector') throw new PromQLError(`expected type instant vector in aggregation expression, got ${v.type === 'matrix' ? 'range vector' : v.type}`);
  const keyLabels = l => { const base = withoutName(l); if (!n.grouping) return n.without ? base : {}; if (n.without) { const o = { ...base }; for (const g of n.grouping) delete o[g]; return o; } return Object.fromEntries(n.grouping.filter(g => g in base).map(g => [g, base[g]])); };
  const groups = new Map();
  for (const s of v.samples) { const kl = keyLabels(s.labels); const k = lblKey(kl); if (!groups.has(k)) groups.set(k, { labels: kl, items: [] }); groups.get(k).items.push(s); }
  const out = [];
  for (const g of groups.values()) {
    const vals = g.items.map(x => x.v);
    switch (n.op) {
      case 'sum': out.push({ labels: g.labels, v: vals.reduce((a, b) => a + b, 0) }); break;
      case 'avg': out.push({ labels: g.labels, v: vals.reduce((a, b) => a + b, 0) / vals.length }); break;
      case 'min': out.push({ labels: g.labels, v: Math.min(...vals) }); break;
      case 'max': out.push({ labels: g.labels, v: Math.max(...vals) }); break;
      case 'count': out.push({ labels: g.labels, v: vals.length }); break;
      case 'group': out.push({ labels: g.labels, v: 1 }); break;
      case 'stddev': { const m = vals.reduce((a, b) => a + b, 0) / vals.length; out.push({ labels: g.labels, v: Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) }); break; }
      case 'quantile': out.push({ labels: g.labels, v: quantile(param, vals) }); break;
      case 'topk': case 'bottomk': out.push(...[...g.items].sort((a, b) => n.op === 'topk' ? b.v - a.v : a.v - b.v).slice(0, param).map(x => ({ labels: withoutName(x.labels), v: x.v }))); break;
      case 'count_values': for (const [val, cnt] of Object.entries(vals.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {}))) out.push({ labels: { ...g.labels, [ev(n.args[0], db, t).v]: val }, v: cnt }); break;
    }
  }
  return { type: 'vector', samples: out, sorted: ['topk', 'bottomk'].includes(n.op) };
}

const CMP = ['==', '!=', '>', '<', '>=', '<='];
function applyOp(op, a, b) {
  switch (op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b; case '^': return a ** b; case '==': return a === b; case '!=': return a !== b; case '>': return a > b; case '<': return a < b; case '>=': return a >= b; case '<=': return a <= b; }
  return NaN;
}
function bin(n, db, t) {
  const l = ev(n.l, db, t), r = ev(n.r, db, t);
  const op = n.op;
  if (['and', 'or', 'unless'].includes(op)) {
    if (l.type !== 'vector' || r.type !== 'vector') throw new PromQLError(`set operator "${op}" not allowed in binary scalar expression`);
    const key = s => n.on ? lblKey(Object.fromEntries(n.on.map(k => [k, s.labels[k] ?? '']))) : lblKey(s.labels, ['__name__', ...(n.ignoring || [])]);
    const rk = new Set(r.samples.map(key));
    if (op === 'and') return { type: 'vector', samples: l.samples.filter(s => rk.has(key(s))) };
    if (op === 'unless') return { type: 'vector', samples: l.samples.filter(s => !rk.has(key(s))) };
    const lk = new Set(l.samples.map(key));
    return { type: 'vector', samples: [...l.samples, ...r.samples.filter(s => !lk.has(key(s)))] };
  }
  const isCmp = CMP.includes(op);
  if (l.type === 'scalar' && r.type === 'scalar') { const v = applyOp(op, l.v, r.v); return { type: 'scalar', v: isCmp ? (v ? 1 : 0) : v }; }
  if (l.type === 'vector' && r.type === 'scalar') return { type: 'vector', samples: l.samples.flatMap(s => { const v = applyOp(op, s.v, r.v); if (isCmp) return n.bool ? [{ labels: withoutName(s.labels), v: v ? 1 : 0 }] : v ? [{ labels: s.labels, v: s.v }] : []; return [{ labels: withoutName(s.labels), v }]; }) };
  if (l.type === 'scalar' && r.type === 'vector') return { type: 'vector', samples: r.samples.flatMap(s => { const v = applyOp(op, l.v, s.v); if (isCmp) return n.bool ? [{ labels: withoutName(s.labels), v: v ? 1 : 0 }] : v ? [{ labels: s.labels, v: s.v }] : []; return [{ labels: withoutName(s.labels), v }]; }) };
  if (l.type !== 'vector' || r.type !== 'vector') throw new PromQLError(`binary expression must contain only scalar and instant vector types`);
  const key = s => n.on ? lblKey(Object.fromEntries(n.on.map(k => [k, s.labels[k] ?? '']))) : lblKey(s.labels, ['__name__', ...(n.ignoring || [])]);
  const right = new Map();
  for (const s of r.samples) { const k = key(s); if (right.has(k) && !n.group) throw new PromQLError(`found duplicate series for the match group ${k} on the right hand-side of the operation: many-to-many matching not allowed: matching labels must be unique on one side`); right.set(k, s); }
  const out = [];
  for (const s of l.samples) {
    const m = right.get(key(s));
    if (!m) continue;
    const v = applyOp(op, s.v, m.v);
    if (isCmp) { if (n.bool) out.push({ labels: withoutName(s.labels), v: v ? 1 : 0 }); else if (v) out.push({ labels: s.labels, v: s.v }); continue; }
    out.push({ labels: n.on && !n.group ? Object.fromEntries(n.on.map(k => [k, s.labels[k]]).filter(([, x]) => x !== undefined)) : withoutName(s.labels), v });
  }
  return { type: 'vector', samples: out };
}

export function formatValue(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(6)));
}
export const seriesName = l => { const name = l.__name__ || ''; const rest = Object.keys(l).filter(k => k !== '__name__').sort().map(k => `${k}="${l[k]}"`).join(', '); return `${name}${rest ? `{${rest}}` : name ? '' : '{}'}`; };
