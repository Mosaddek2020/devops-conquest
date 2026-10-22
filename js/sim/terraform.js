// Terraform for the simulated cloud: loads *.tf (and local modules), evaluates variables,
// locals, data sources, resources (count/for_each) and outputs in dependency order,
// refreshes state against the real cloud (drift), plans create/update/replace/delete with
// the familiar symbols, applies with confirmation, and keeps state locally or in an S3
// bucket with locking.

import { def } from './registry.js';
import { C } from '../git/world.js';
import { normPath, dirname, basename, SimError } from './host.js';
import { parseHcl, evaluate, refsOf, UNKNOWN, isUnknown, deepUnknown, HclError, EvalError, hclValue, fakeHash } from './hcl.js';
import { SCHEMAS, DATA_SOURCES, PROVIDER_VERSIONS } from './tfproviders.js';

const TF_VERSION = '1.9.8';
const ok = s => C.green(s), bold = s => C.bold(s);

// ---------------------------------------------------------------- diagnostics
function diag(kind, summary, detail = '', where = null) {
  const red = kind === 'Error' ? C.red : C.yellow;
  const lines = [red('╷'), `${red('│')} ${bold(`${red(kind + ':')} ${summary}`)}`, red('│')];
  if (where) { lines.push(`${red('│')}   on ${where.file} line ${where.line}${where.in ? `, in ${where.in}` : ''}:`); if (where.src) lines.push(`${red('│')}   ${String(where.line).padStart(2)}: ${where.src}`); lines.push(red('│')); }
  for (const l of String(detail).split('\n')) if (l || detail) lines.push(`${red('│')} ${l}`);
  lines.push(red('╵'));
  return lines;
}
class TfError extends Error { constructor(lines) { super('terraform error'); this.lines = lines; } }
const fail = (summary, detail, where) => { throw new TfError(diag('Error', summary, detail, where)); };

const closest = (w, list) => { let best = null, bd = 3; for (const x of list) { const d = lev(w, x); if (d < bd) { bd = d; best = x; } } return best; };
function lev(a, b) { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }

// ---------------------------------------------------------------- loading
function loadDir(host, dir) {
  const files = [...host.files.keys()].filter(p => dirname(p) === dir && /\.tf$/.test(p)).sort();
  const mod = { dir, files: {}, terraform: [], providers: [], variables: {}, locals: {}, resources: {}, data: {}, outputs: {}, modules: {}, imports: [] };
  for (const f of files) {
    const src = host.files.get(f);
    mod.files[basename(f)] = src;
    let body;
    try { body = parseHcl(src, basename(f)); }
    catch (e) { if (e instanceof HclError) fail(e.message.split(':')[0], e.message.split(':').slice(1).join(':').trim(), { file: basename(f), line: e.line, src: src.split('\n')[e.line - 1]?.trim() }); throw e; }
    for (const b of body.blocks) {
      const where = { file: basename(f), line: b.line };
      const lbl = (n, what) => { if (b.labels.length !== n) fail(`Missing name for ${b.type}`, `All ${b.type} blocks must have ${n} labels (${what}).`, where); };
      switch (b.type) {
        case 'terraform': mod.terraform.push(b); break;
        case 'provider': lbl(1, 'name'); mod.providers.push(b); break;
        case 'variable': lbl(1, 'name'); if (mod.variables[b.labels[0]]) fail('Duplicate variable declaration', `A variable named "${b.labels[0]}" was already declared.`, where); mod.variables[b.labels[0]] = b; break;
        case 'locals': for (const [k, v] of Object.entries(b.attrs)) { if (mod.locals[k]) fail('Duplicate local value definition', `A local value named "${k}" was already defined.`, where); mod.locals[k] = { ...v, file: basename(f) }; } break;
        case 'resource': {
          lbl(2, 'type, name');
          const [t, n] = b.labels;
          if (!SCHEMAS[t]) fail('Invalid resource type', `The provider ${providerOf(t)} does not support resource type "${t}".${closest(t, Object.keys(SCHEMAS)) ? `\n\nDid you mean "${closest(t, Object.keys(SCHEMAS))}"?` : ''}`, { ...where, in: `resource "${t}" "${n}"`, src: `resource "${t}" "${n}" {` });
          if (mod.resources[`${t}.${n}`]) fail('Duplicate resource "' + t + '" configuration', `A ${t} resource named "${n}" was already declared.`, where);
          mod.resources[`${t}.${n}`] = b;
          break;
        }
        case 'data': { lbl(2, 'type, name'); const [t, n] = b.labels; if (!DATA_SOURCES[t]) fail('Invalid data source', `The provider ${providerOf(t)} does not support data source "${t}".`, where); mod.data[`${t}.${n}`] = b; break; }
        case 'output': lbl(1, 'name'); mod.outputs[b.labels[0]] = b; break;
        case 'module': lbl(1, 'name'); mod.modules[b.labels[0]] = b; break;
        case 'import': mod.imports.push(b); break;
        case 'moved': case 'removed': case 'check': break;
        default: fail('Unsupported block type', `Blocks of type "${b.type}" are not expected here.${closest(b.type, ['resource', 'variable', 'output', 'locals', 'provider', 'module', 'data', 'terraform']) ? ` Did you mean "${closest(b.type, ['resource', 'variable', 'output', 'locals', 'provider', 'module', 'data', 'terraform'])}"?` : ''}`, where);
      }
    }
  }
  return mod;
}
const providerOf = t => `registry.terraform.io/hashicorp/${t.split('_')[0]}`;

// ---------------------------------------------------------------- the run
// A Run evaluates one configuration against state: plan() returns the actions, apply() executes.
class Run {
  constructor(tf, { vars = {}, destroy = false, targets = [], replace = [], refreshOnly = false } = {}) {
    Object.assign(this, { tf, vars, destroy, targets, replace, refreshOnly });
    this.cloud = tf.uni.cloud;
    this.values = new Map();      // node key -> value
    this.instances = new Map();   // address -> planned { action, before, after, schema, block, ... }
    this.drift = [];
    this.outputs = {};
  }

  // nodes for a module (recursively)
  collect(mod, prefix = '', inputs = null, parentCtx = null) {
    const nodes = [];
    for (const [n, b] of Object.entries(mod.variables)) nodes.push({ key: `${prefix}var.${n}`, kind: 'var', name: n, b, mod, prefix, inputs, deps: inputs?.[n] ? refsOf(inputs[n].expr).map(r => this.refKey(r, parentCtx.prefix, parentCtx.mod)).filter(Boolean) : [] });
    for (const [n, a] of Object.entries(mod.locals)) nodes.push({ key: `${prefix}local.${n}`, kind: 'local', name: n, a, mod, prefix, deps: refsOf(a.expr).map(r => this.refKey(r, prefix, mod)).filter(Boolean) });
    for (const [k, b] of Object.entries(mod.data)) nodes.push({ key: `${prefix}data.${k}`, kind: 'data', addr: `${prefix}data.${k}`, type: b.labels[0], name: b.labels[1], b, mod, prefix, deps: this.blockDeps(b, prefix, mod) });
    for (const [k, b] of Object.entries(mod.resources)) nodes.push({ key: `${prefix}${k}`, kind: 'resource', addr: `${prefix}${k}`, type: b.labels[0], name: b.labels[1], b, mod, prefix, deps: this.blockDeps(b, prefix, mod) });
    for (const [n, b] of Object.entries(mod.outputs)) nodes.push({ key: `${prefix}output.${n}`, kind: 'output', name: n, b, mod, prefix, deps: this.blockDeps(b, prefix, mod) });
    for (const [n, b] of Object.entries(mod.modules)) {
      const src = b.attrs.source ? evaluate(b.attrs.source.expr, { lookup: () => null }) : null;
      const child = this.tf.loadModule(normPath(mod.dir + '/' + src), n);
      const childPrefix = `${prefix}module.${n}.`;
      const ins = Object.fromEntries(Object.entries(b.attrs).filter(([k]) => !['source', 'version', 'count', 'for_each', 'depends_on', 'providers'].includes(k)));
      for (const k of Object.keys(ins)) if (!child.variables[k]) fail('Unsupported argument', `An argument named "${k}" is not expected here.`, { file: 'main.tf', line: ins[k].line, in: `module "${n}"` });
      for (const [k, v] of Object.entries(child.variables)) if (!ins[k] && !v.attrs.default) fail('Missing required argument', `The argument "${k}" is required, but no definition was found.`, { file: 'main.tf', line: b.line, in: `module "${n}"` });
      nodes.push(...this.collect(child, childPrefix, ins, { prefix, mod }));
      // module outputs are reachable as module.<n>.<output>
      for (const o of Object.keys(child.outputs)) nodes.push({ key: `${prefix}module.${n}.${o}`, kind: 'modout', name: o, deps: [`${childPrefix}output.${o}`] });
    }
    return nodes;
  }
  blockDeps(b, prefix, mod) {
    const out = [];
    const walk = blk => { for (const [k, a] of Object.entries(blk.attrs)) { if (k === 'depends_on') { for (const r of (a.expr.items || [])) { const parts = []; let n = r; while (n.t === 'get') { parts.unshift(n.a); n = n.e; } if (n.t === 'ref') parts.unshift(n.name); out.push(this.refKey(parts, prefix, mod)); } continue; } for (const r of refsOf(a.expr)) out.push(this.refKey(r, prefix, mod)); } for (const c of blk.blocks) walk(c); };
    walk(b);
    return out.filter(Boolean);
  }
  refKey(r, prefix, mod) {
    const [root, a, b2] = r;
    if (root === 'var') { if (!mod.variables[a]) this.undeclared.push(['var', a, mod]); return `${prefix}var.${a}`; }
    if (root === 'local') { if (!(a in mod.locals)) this.undeclared.push(['local', a, mod]); return `${prefix}local.${a}`; }
    if (root === 'data') return `${prefix}data.${a}.${b2}`;
    if (root === 'module') return `${prefix}module.${a}.${b2}`;
    if (['count', 'each', 'path', 'self', 'terraform'].includes(root)) return null;
    if (root.includes('_')) { if (a && !mod.resources[`${root}.${a}`]) this.undeclared.push(['resource', `${root}.${a}`, mod]); return a ? `${prefix}${root}.${a}` : null; }
    this.undeclared.push(['ref', root, mod]);
    return null;
  }

  order(nodes) {
    const byKey = new Map(nodes.map(n => [n.key, n]));
    const out = [], seen = new Set(), stack = new Set();
    const visit = n => {
      if (seen.has(n.key)) return;
      if (stack.has(n.key)) fail('Cycle: ' + [...stack, n.key].slice([...stack].indexOf(n.key)).join(', '), '');
      stack.add(n.key);
      for (const d of n.deps) { const dn = byKey.get(d); if (dn) visit(dn); }
      stack.delete(n.key); seen.add(n.key); out.push(n);
    };
    for (const n of nodes) visit(n);
    return out;
  }

  ctxFor(node, extra = {}) {
    const self = this;
    const { prefix, mod } = node;
    return {
      locals: extra.locals,
      lookup(name) {
        if (name === 'var') return ns(k => { const key = `${prefix}var.${k}`; if (!mod.variables[k]) throw new EvalError('Reference to undeclared input variable', `An input variable with the name "${k}" has not been declared.${closest(k, Object.keys(mod.variables)) ? ` Did you mean "${closest(k, Object.keys(mod.variables))}"?` : ''}`); return self.values.get(key); });
        if (name === 'local') return ns(k => { const key = `${prefix}local.${k}`; if (!self.values.has(key)) throw new EvalError('Reference to undeclared local value', `A local value with the name "${k}" has not been declared.`); return self.values.get(key); });
        if (name === 'count') { if (extra.count === undefined) throw new EvalError('Reference to "count" in non-counted context', 'The "count" object can only be used in "module", "resource", and "data" blocks, and only when the "count" argument is set.'); return { index: extra.count }; }
        if (name === 'each') { if (extra.each === undefined) throw new EvalError('Reference to "each" in context without for_each', 'The "each" object can be used only in "module" or "resource" blocks, and only when the "for_each" argument is set.'); return extra.each; }
        if (name === 'path') return { module: mod.dir, root: self.tf.dir, cwd: self.tf.dir };
        if (name === 'terraform') return { workspace: 'default' };
        if (name === 'data') return ns(t => ns(n => { const key = `${prefix}data.${t}.${n}`; if (!self.values.has(key)) throw new EvalError('Reference to undeclared resource', `A data resource "${t}" "${n}" has not been declared in the root module.`); return self.values.get(key); }));
        if (name === 'module') return ns(m => { const outs = {}; let found = false; for (const [k, v] of self.values) if (k.startsWith(`${prefix}module.${m}.`) && !k.slice(`${prefix}module.${m}.`.length).includes('.')) { outs[k.slice(`${prefix}module.${m}.`.length)] = v; found = true; } if (!found && !mod.modules[m]) throw new EvalError('Reference to undeclared module', `No module call named "${m}" is declared in the root module.`); return outs; });
        if (name.includes('_')) {
          return ns(n => { const key = `${prefix}${name}.${n}`; if (!mod.resources[`${name}.${n}`]) throw new EvalError('Reference to undeclared resource', `A managed resource "${name}" "${n}" has not been declared in the root module.`); return self.values.get(key); });
        }
        throw new EvalError(`Invalid reference`, `A reference to a resource type must be followed by at least one attribute access, specifying the resource name.`);
      },
      call: (fn, args) => {
        const p = String(args[0] || '').replace(/^~/, this.tf.home);
        const abs = normPath(p.startsWith('/') ? p : mod.dir + '/' + p);
        if (fn === 'fileexists') return this.tf.host.files.has(abs);
        if (fn === 'pathexpand') return p;
        const text = this.tf.host.files.get(abs);
        if (text === undefined) throw new EvalError('Invalid function argument', `Invalid value for "path" parameter: no file exists at "${args[0]}"; this function works only with files that are distributed as part of the configuration source code, so if this file will be created by a resource in this configuration you must instead obtain this result from an attribute of that resource.`);
        if (fn === 'filebase64') return btoa(text);
        if (fn === 'templatefile') { const vars = args[1] || {}; return text.replace(/\$\{\s*([\w.]+)\s*\}/g, (m, k) => { const v = k.split('.').reduce((o, x) => o?.[x], vars); if (v === undefined) throw new EvalError('Invalid function argument', `Invalid value for "vars" parameter: vars map does not contain key "${k}", referenced at ${args[0]}:1.`); return String(v); }); }
        return text;
      },
    };
  }

  ev(node, expr, extra, where) {
    try { return evaluate(expr, this.ctxFor(node, extra)); }
    catch (e) { if (e instanceof EvalError) fail(e.message, e.detail, where); throw e; }
  }

  // ------------------------------------------------------------ variables
  varValue(node) {
    const b = node.b;
    const where = { file: 'variables.tf', line: b.line, in: `variable "${node.name}"` };
    let v;
    if (node.inputs) {
      if (node.inputs[node.name]) v = this.ev({ prefix: node.prefix.replace(/module\.[^.]+\.$/, ''), mod: node.parentMod || this.tf.root }, node.inputs[node.name].expr, {}, where);
    } else if (node.name in this.vars) v = this.vars[node.name];
    if (v === undefined && b.attrs.default) v = this.ev(node, b.attrs.default.expr, {}, where);
    if (v === undefined) {
      if (node.inputs) fail('Missing required argument', `The argument "${node.name}" is required, but no definition was found.`);
      throw Object.assign(new Error('need var'), { needVar: node.name, description: b.attrs.description ? this.ev(node, b.attrs.description.expr, {}) : null, sensitive: b.attrs.sensitive ? this.ev(node, b.attrs.sensitive.expr, {}) : false });
    }
    // type conversion
    const type = b.attrs.type ? typeText(b.attrs.type.expr) : 'any';
    if (type === 'number' && typeof v === 'string') { if (isNaN(Number(v))) fail('Invalid value for input variable', `The given value is not suitable for var.${node.name} declared at variables.tf:${b.line},1-${node.name.length + 12}: a number is required.`); v = Number(v); }
    if (type === 'bool' && typeof v === 'string') v = v === 'true';
    if (/^(list|set)/.test(type) && typeof v === 'string') { try { v = JSON.parse(v); } catch { fail('Invalid value for input variable', `The given value is not suitable for var.${node.name}: list of string required.`); } }
    if (/^map/.test(type) && typeof v === 'string') { try { v = JSON.parse(v); } catch { fail('Invalid value for input variable', `The given value is not suitable for var.${node.name}: map of string required.`); } }
    this.values.set(node.key, v);
    for (const val of b.blocks.filter(x => x.type === 'validation')) {
      const okv = this.ev(node, val.attrs.condition.expr, {}, where);
      if (okv === false) fail('Invalid value for variable', `${this.ev(node, val.attrs.error_message.expr, {}, where)}\n\nThis was checked by the validation rule at variables.tf:${val.line},3-13.`, { ...where, line: b.line });
    }
    return v;
  }
  parentMod(node) { return node.parentMod || this.tf.root; }

  // ------------------------------------------------------------ resources
  argsOf(node, blk, schema, extra) {
    const where = { file: blk.file || 'main.tf', line: blk.line, in: `resource "${node.type}" "${node.name}"` };
    const a = {};
    const known = { ...schema.args, count: 1, for_each: 1, depends_on: 1, provider: 1, lifecycle: 1 };
    for (const [k, attr] of Object.entries(blk.attrs)) {
      if (!(k in known)) fail('Unsupported argument', `An argument named "${k}" is not expected here.${closest(k, Object.keys(schema.args)) ? ` Did you mean "${closest(k, Object.keys(schema.args))}"?` : ''}`, { ...where, line: attr.line, src: `${k} = …` });
      if (['count', 'for_each', 'depends_on', 'provider'].includes(k)) continue;
      a[k] = this.ev(node, attr.expr, extra, { ...where, line: attr.line });
    }
    for (const [k, spec] of Object.entries(schema.args)) {
      if (spec.req && !(k in a)) fail('Missing required argument', `The argument "${k}" is required, but no definition was found.`, where);
      if (!(k in a) && 'def' in spec) a[k] = spec.def;
      if (spec.type === 'number' && typeof a[k] === 'string' && !isUnknown(a[k])) a[k] = Number(a[k]);
    }
    for (const bname of Object.keys(schema.blocks || {})) a[bname] = blk.blocks.filter(x => x.type === bname).map(x => { const o = {}; for (const [k, spec] of Object.entries(schema.blocks[bname])) { if (x.attrs[k]) o[k] = this.ev(node, x.attrs[k].expr, extra, where); else if ('def' in spec) o[k] = spec.def; else if (spec.req) fail('Missing required argument', `The argument "${k}" is required, but no definition was found.`, { ...where, line: x.line }); } for (const k of Object.keys(x.attrs)) if (!(k in schema.blocks[bname])) fail('Unsupported argument', `An argument named "${k}" is not expected here.`, { ...where, line: x.line }); return o; });
    for (const dyn of blk.blocks.filter(x => x.type === 'dynamic')) {
      const bname = dyn.labels[0];
      const coll = this.ev(node, dyn.attrs.for_each.expr, extra, where);
      const content = dyn.blocks.find(x => x.type === 'content');
      const iter = dyn.attrs.iterator ? dyn.attrs.iterator.expr.name : bname;
      for (const [k, v] of Array.isArray(coll) ? coll.map((v2, i) => [i, v2]) : Object.entries(coll || {})) {
        const o = {};
        for (const [ak, spec] of Object.entries(schema.blocks?.[bname] || {})) { if (content.attrs[ak]) o[ak] = this.ev(node, content.attrs[ak].expr, { ...extra, locals: { ...(extra.locals || {}), [iter]: { key: k, value: v } } }, where); else if ('def' in spec) o[ak] = spec.def; }
        (a[bname] = a[bname] || []).push(o);
      }
    }
    for (const b of blk.blocks) if (!['lifecycle', 'dynamic', ...Object.keys(schema.blocks || {})].includes(b.type)) fail('Unsupported block type', `Blocks of type "${b.type}" are not expected here.`, { ...where, line: b.line });
    return a;
  }

  lifecycle(blk) {
    const lc = blk.blocks.find(x => x.type === 'lifecycle');
    if (!lc) return {};
    const get = k => lc.attrs[k] ? evaluate(lc.attrs[k].expr, { lookup: () => null }) : undefined;
    const ignore = lc.attrs.ignore_changes ? (lc.attrs.ignore_changes.expr.items || []).map(x => x.name || x.v) : [];
    return { prevent_destroy: get('prevent_destroy'), create_before_destroy: get('create_before_destroy'), ignore_changes: ignore };
  }

  instanceKeys(node) {
    const blk = node.b;
    const where = { file: blk.file || 'main.tf', line: blk.line, in: `resource "${node.type}" "${node.name}"` };
    if (blk.attrs.count && blk.attrs.for_each) fail('Invalid combination of "count" and "for_each"', 'The "count" and "for_each" meta-arguments are mutually-exclusive, only one should be used to be explicit about the number of resources to be created.', where);
    if (blk.attrs.count) {
      const n = this.ev(node, blk.attrs.count.expr, {}, where);
      if (isUnknown(n)) fail('Invalid count argument', 'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created. To work around this, use the -target argument to first apply only the resources that the count depends on.', where);
      return { kind: 'count', keys: Array.from({ length: Number(n) }, (_, i) => i) };
    }
    if (blk.attrs.for_each) {
      const fe = this.ev(node, blk.attrs.for_each.expr, {}, where);
      if (isUnknown(fe)) fail('Invalid for_each argument', 'The "for_each" map includes keys derived from resource attributes that cannot be determined until apply.', where);
      if (Array.isArray(fe) && fe.some(x => typeof x !== 'string')) fail('Invalid for_each argument', 'The given "for_each" argument value is unsuitable: the "for_each" argument must be a map, or set of strings, and you have provided a value of type tuple.', where);
      const entries = Array.isArray(fe) ? fe.map(k => [k, k]) : Object.entries(fe || {});
      return { kind: 'each', keys: entries.map(([k]) => k), map: Object.fromEntries(entries) };
    }
    return { kind: 'single', keys: [null] };
  }

  addrOf(node, key) { return key === null ? node.addr : typeof key === 'number' ? `${node.addr}[${key}]` : `${node.addr}["${key}"]`; }

  plan() {
    const tf = this.tf;
    this.undeclared = [];
    const nodes = this.collect(tf.root);
    for (const [kind, name, mod] of this.undeclared) {
      if (kind === 'var') fail('Reference to undeclared input variable', `An input variable with the name "${name}" has not been declared.${closest(name, Object.keys(mod.variables)) ? ` Did you mean "${closest(name, Object.keys(mod.variables))}"?` : ' This variable can be declared with a variable "' + name + '" {} block.'}`);
      if (kind === 'resource') fail('Reference to undeclared resource', `A managed resource "${name.split('.')[0]}" "${name.split('.')[1]}" has not been declared in the root module.`);
      if (kind === 'local') fail('Reference to undeclared local value', `A local value with the name "${name}" has not been declared.`);
    }
    // child module variable nodes need their parent module for input evaluation
    for (const n of nodes) if (n.kind === 'var' && n.inputs) n.parentMod = nodes.find(x => x.prefix === n.prefix.replace(/module\.[^.]+\.$/, '') && x.mod)?.mod || tf.root;
    const ordered = this.order(nodes);
    this.ordered = ordered;
    // refresh
    const state = tf.state();
    this.priorByAddr = new Map();
    for (const r of state.resources) for (const inst of r.instances) {
      const addr = `${r.module ? r.module + '.' : ''}${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}${inst.index_key === undefined ? '' : typeof inst.index_key === 'number' ? `[${inst.index_key}]` : `["${inst.index_key}"]`}`;
      if (r.mode === 'data') continue;
      const schema = SCHEMAS[r.type];
      let cur = inst.attributes;
      if (schema && !this.destroy || schema) {
        const read = schema.read ? schema.read(this.cloud, cur.id, cur, tf.env) : (schema.local ? { ...cur } : this.cloud.get(r.type, cur.id));
        if (!read) { this.drift.push({ addr, type: r.type, kind: 'deleted', before: cur }); cur = null; }
        else {
          const refreshed = pick(read, schema, cur);
          const changed = Object.keys(refreshed).filter(k => JSON.stringify(norm(refreshed[k])) !== JSON.stringify(norm(cur[k])));
          if (changed.length) this.drift.push({ addr, type: r.type, kind: 'changed', before: cur, after: refreshed, changed });
          cur = refreshed;
        }
      }
      this.priorByAddr.set(addr, { type: r.type, name: r.name, module: r.module, key: inst.index_key, attrs: cur, deps: inst.dependencies || [] });
    }
    if (this.refreshOnly) return this;
    // evaluate everything in order
    for (const n of ordered) this.visit(n);
    // orphans
    for (const [addr, p] of this.priorByAddr) if (!this.instances.has(addr) && p.attrs) {
      if (this.targets.length && !this.targets.some(t => addr === t || addr.startsWith(t + '[') || addr.startsWith(t + '.'))) continue;
      this.instances.set(addr, { addr, type: p.type, name: p.name, module: p.module, key: p.key, action: 'delete', before: p.attrs, after: null, schema: SCHEMAS[p.type], orphan: !this.destroy, deps: p.deps });
    }
    for (const i of this.instances.values()) if (['delete', 'replace'].includes(i.action) && i.lc?.prevent_destroy) fail('Instance cannot be destroyed', `Resource ${i.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`, { file: 'main.tf', line: i.block?.line || 1, in: `resource "${i.type}" "${i.name}"` });
    return this;
  }

  visit(n) {
    switch (n.kind) {
      case 'var': this.values.set(n.key, this.varValue(n)); return;
      case 'local': this.values.set(n.key, this.ev(n, n.a.expr, {}, { file: n.a.file || 'main.tf', line: n.a.line, in: 'locals' })); return;
      case 'modout': this.values.set(n.key, this.values.get(n.deps[0])); return;
      case 'output': {
        const v = this.ev(n, n.b.attrs.value.expr, {}, { file: 'outputs.tf', line: n.b.line, in: `output "${n.name}"` });
        const sens = n.b.attrs.sensitive ? evaluate(n.b.attrs.sensitive.expr, { lookup: () => null }) : false;
        if (!sens && !n.prefix && this.sensitiveDeps(n)) fail('Output refers to sensitive values', 'To reduce the risk of accidentally exporting sensitive data that was intended to be only internal, Terraform requires that any root module output containing sensitive data be explicitly marked as sensitive, to confirm your intent.\n\nIf you do intend to export this data, annotate the output value as sensitive by adding the following argument:\n    sensitive = true', { file: 'outputs.tf', line: n.b.line, in: `output "${n.name}"` });
        this.values.set(n.key, v);
        if (!n.prefix) this.outputs[n.name] = { value: v, sensitive: !!sens };
        return;
      }
      case 'data': {
        const ds = DATA_SOURCES[n.type];
        const a = {};
        for (const [k, attr] of Object.entries(n.b.attrs)) a[k] = this.ev(n, attr.expr, {}, { file: 'main.tf', line: attr.line });
        for (const bname of Object.keys(ds.blocks || {})) a[bname] = n.b.blocks.filter(x => x.type === bname).map(x => Object.fromEntries(Object.entries(x.attrs).map(([k, v]) => [k, this.ev(n, v.expr, {})])));
        let v;
        if (deepUnknown(a)) v = UNKNOWN;
        else { try { v = ds.read(this.cloud, a); } catch (e) { fail(`reading ${n.type}`, e.message, { file: 'main.tf', line: n.b.line, in: `data "${n.type}" "${n.name}"` }); } }
        this.values.set(n.key, v);
        return;
      }
      case 'resource': {
        const schema = SCHEMAS[n.type];
        const ks = this.instanceKeys(n);
        const lc = this.lifecycle(n.b);
        const vals = ks.kind === 'single' ? null : ks.kind === 'count' ? [] : {};
        let only = vals;
        for (const key of ks.keys) {
          const addr = this.addrOf(n, key);
          const extra = ks.kind === 'count' ? { count: key } : ks.kind === 'each' ? { each: { key, value: ks.map[key] } } : {};
          const targeted = !this.targets.length || this.targets.some(t => addr === t || n.addr === t || addr.startsWith(t + '['));
          const prior = this.priorByAddr.get(addr)?.attrs || null;
          let planned;
          if (this.destroy) { if (prior && targeted) this.instances.set(addr, { addr, type: n.type, name: n.name, module: n.prefix ? n.prefix.replace(/\.$/, '') : undefined, key: key ?? undefined, action: 'delete', before: prior, after: null, schema, lc, block: n.b, deps: n.deps }); planned = prior; }
          else if (!targeted) planned = prior;
          else {
            const args = this.argsOf(n, n.b, schema, extra);
            planned = this.diff(n, addr, key, args, prior, schema, lc);
          }
          if (ks.kind === 'single') only = planned; else vals[key] = planned;
        }
        this.values.set(n.key, ks.kind === 'single' ? only : vals);
        return;
      }
    }
  }
  sensitiveDeps(n) {
    for (const d of n.deps) {
      if (/var\./.test(d)) { const vn = this.ordered.find(x => x.key === d); if (vn?.b?.attrs.sensitive && evaluate(vn.b.attrs.sensitive.expr, { lookup: () => null })) return true; }
      if (/^random_password\./.test(d)) return true;
    }
    return false;
  }

  diff(n, addr, key, args, prior, schema, lc) {
    const base = { addr, type: n.type, name: n.name, module: n.prefix ? n.prefix.replace(/\.$/, '') : undefined, key: key ?? undefined, schema, lc, block: n.b, deps: n.deps, args };
    const computedAfter = () => Object.fromEntries(schema.computed.filter(k => !(k in args) || args[k] === undefined || (schema.args[k]?.computedDef && (args[k] === undefined || args[k] === null))).map(k => [k, UNKNOWN]));
    if (!prior) {
      const after = { ...args, ...computedAfter() };
      for (const k of Object.keys(args)) if (schema.args[k]?.computedDef && (args[k] === undefined || args[k] === null || (Array.isArray(args[k]) && !args[k].length && k !== 'records'))) after[k] = UNKNOWN;
      this.instances.set(addr, { ...base, action: 'create', before: null, after });
      return after;
    }
    const changed = [];
    for (const [k, v] of Object.entries(args)) {
      if (lc.ignore_changes?.includes(k) || lc.ignore_changes?.includes('all')) continue;
      const spec = schema.args[k] || (schema.blocks?.[k] ? { block: true } : null);
      if (!spec) continue;
      if (spec.computedDef && (v === null || v === undefined || (Array.isArray(v) && !v.length))) continue;
      if (isUnknown(v) || deepUnknown(v)) { changed.push(k); continue; }
      if (JSON.stringify(norm(v)) !== JSON.stringify(norm(prior[k] ?? (spec.def ?? null)))) changed.push(k);
    }
    const forced = this.replace.includes(addr) ? ['(requested)'] : changed.filter(k => schema.args[k]?.force).concat(schema.forceIf ? schema.forceIf(changed, args) : []);
    if (!changed.length && !forced.length) { this.instances.set(addr, { ...base, action: 'noop', before: prior, after: prior }); return prior; }
    if (forced.length) {
      const after = { ...args, ...computedAfter() };
      for (const k of schema.computed) if (!(k in args) || args[k] === null || (Array.isArray(args[k]) && !args[k].length)) after[k] = UNKNOWN;
      this.instances.set(addr, { ...base, action: 'replace', before: prior, after, changed, forced, cbd: !!lc.create_before_destroy });
      return after;
    }
    const after = { ...prior, ...Object.fromEntries(changed.map(k => [k, args[k]])) };
    this.instances.set(addr, { ...base, action: 'update', before: prior, after, changed });
    return after;
  }

  counts() { const c = { add: 0, change: 0, destroy: 0, import: 0 }; for (const i of this.instances.values()) { if (i.action === 'create') c.add++; if (i.action === 'update') c.change++; if (i.action === 'delete') c.destroy++; if (i.action === 'replace') { c.add++; c.destroy++; } if (i.import) c.import++; } return c; }
}

const internal = k => typeof k === 'symbol' || String(k).startsWith('__') || k === 'then' || k === 'toJSON';
// a lazily-resolving namespace (var, local, data, module, resource types) for the evaluator
const ns = getter => new Proxy({}, { get: (_, k) => k === '__proxy' ? true : internal(k) ? undefined : getter(String(k)) });
function typeText(e) { if (e.t === 'ref') return e.name; if (e.t === 'call') return `${e.fn}(${e.args.map(typeText).join(',')})`; return 'any'; }
function norm(v) { if (Array.isArray(v)) return v.map(norm); if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = norm(v[k]); return o; } return v; }
function pick(read, schema, prior) {
  const out = { ...prior };
  for (const k of [...Object.keys(schema.args), ...Object.keys(schema.blocks || {}), ...schema.computed]) if (k in read) out[k] = read[k];
  return out;
}

// ---------------------------------------------------------------- rendering
const SYM = { create: C.green('+'), delete: C.red('-'), update: C.yellow('~'), replace: `${C.red('-')}/${C.green('+')}`, read: C.cyan('<=') };
function renderVal(v, ind, mark, quote = true) {
  const pad = ' '.repeat(ind);
  if (isUnknown(v)) return '(known after apply)';
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) { if (!v.length) return '[]'; return `[\n${v.map(x => `${pad}    ${mark}${renderVal(x, ind + 4, mark, !(x && typeof x === 'object' && !Array.isArray(x)) && quote)},`).join('\n')}\n${pad}  ]`; }
  if (typeof v === 'object') { const ks = Object.keys(v).sort(); if (!ks.length) return '{}'; const key = k => quote ? JSON.stringify(k) : k; const w = Math.max(...ks.map(k => key(k).length)); return `{\n${ks.map(k => `${pad}    ${mark}${key(k).padEnd(w)} = ${renderVal(v[k], ind + 4, mark, true)}`).join('\n')}\n${pad}  }`; }
  if (typeof v === 'string' && v.includes('\n')) return `<<-EOT\n${v.replace(/\n$/, '').split('\n').map(l => pad + '        ' + l).join('\n')}\n${pad}    EOT`;
  return JSON.stringify(v);
}
function shownAttrs(i, which) {
  const o = { ...(which === 'before' ? i.before : i.after) };
  const s = i.schema;
  for (const [k, spec] of Object.entries(s?.args || {})) if (spec.hashed && typeof o[k] === 'string') o[k] = fakeHash(o[k], 40);
  for (const k of s?.sensitive || []) if (k in o && !isUnknown(o[k])) o[k] = '(sensitive value)';
  for (const k of ['host', 'launched', 'created']) delete o[k];
  return o;
}
function renderInstance(i) {
  const L = [];
  const head = { create: 'will be created', delete: i.orphan ? 'will be destroyed' : 'will be destroyed', update: 'will be updated in-place', replace: 'must be replaced' }[i.action];
  L.push(`  ${bold(`# ${i.addr}`)} ${head}`);
  if (i.orphan) L.push(`  # (because ${i.addr} is not in configuration)`);
  const res = `resource "${i.type}" "${i.name}"`;
  if (i.action === 'create' || i.action === 'delete') {
    const sym = i.action === 'create' ? SYM.create : SYM.delete;
    const mark = i.action === 'create' ? `${C.green('+')} ` : `${C.red('-')} `;
    const attrs = shownAttrs(i, i.action === 'create' ? 'after' : 'before');
    const keys = Object.keys(attrs).filter(k => attrs[k] !== undefined && !(attrs[k] === null && i.action === 'create') && !(Array.isArray(attrs[k]) && !attrs[k].length && i.action === 'create')).sort();
    const w = Math.max(0, ...keys.map(k => k.length));
    L.push(`  ${sym} ${res} {`);
    for (const k of keys) L.push(`      ${mark}${k.padEnd(w)} = ${renderVal(attrs[k], 6, mark, !(i.schema?.blocks?.[k]))}${i.action === 'delete' ? ' -> null' : ''}`);
    L.push('    }');
    return L;
  }
  const before = shownAttrs(i, 'before'), after = shownAttrs(i, 'after');
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !['host', 'launched', 'created'].includes(k)).sort();
  const changed = keys.filter(k => JSON.stringify(norm(before[k])) !== JSON.stringify(norm(after[k])));
  const w = Math.max(0, ...[...changed, 'id'].map(k => k.length));
  L.push(`${i.action === 'replace' ? '' : '  '}${SYM[i.action]} ${res} {`);
  if (!changed.includes('id') && before.id) L.push(`        ${'id'.padEnd(w)} = ${JSON.stringify(before.id)}`);
  for (const k of changed) {
    const forces = i.forced?.includes(k) ? C.red(' # forces replacement') : '';
    const b0 = before[k], a0 = after[k];
    if (Array.isArray(b0) && Array.isArray(a0)) {
      // element-wise: show what was added or removed, hide the rest
      const key = x => JSON.stringify(norm(x));
      const bk = b0.map(key), ak = a0.map(key);
      const lines = [`      ${C.yellow('~')} ${k.padEnd(w)} = [${forces}`];
      for (const x of b0) if (!ak.includes(key(x))) lines.push(`          ${C.red('-')} ${renderVal(x, 10, `${C.red('-')} `, false)},`);
      for (const x of a0) if (!bk.includes(key(x))) lines.push(`          ${C.green('+')} ${renderVal(x, 10, `${C.green('+')} `, false)},`);
      const same = b0.filter(x => ak.includes(key(x))).length;
      if (same) lines.push(C.dim(`            # (${same} unchanged element${same > 1 ? 's' : ''} hidden)`));
      lines.push('        ]');
      L.push(...lines);
    } else if (b0 && a0 && typeof b0 === 'object' && typeof a0 === 'object' && !isUnknown(a0) && !Array.isArray(b0)) {
      const ks = [...new Set([...Object.keys(b0), ...Object.keys(a0)])].sort();
      const kw = Math.max(...ks.map(x => JSON.stringify(x).length));
      L.push(`      ${C.yellow('~')} ${k.padEnd(w)} = {${forces}`);
      let same = 0;
      for (const x of ks) {
        if (!(x in a0)) L.push(`          ${C.red('-')} ${JSON.stringify(x).padEnd(kw)} = ${renderVal(b0[x], 10, '')} -> null`);
        else if (!(x in b0)) L.push(`          ${C.green('+')} ${JSON.stringify(x).padEnd(kw)} = ${renderVal(a0[x], 10, '')}`);
        else if (JSON.stringify(norm(b0[x])) !== JSON.stringify(norm(a0[x]))) L.push(`          ${C.yellow('~')} ${JSON.stringify(x).padEnd(kw)} = ${renderVal(b0[x], 10, '')} -> ${renderVal(a0[x], 10, '')}`);
        else same++;
      }
      if (same) L.push(C.dim(`            # (${same} unchanged element${same > 1 ? 's' : ''} hidden)`));
      L.push('        }');
    }
    else L.push(`      ${C.yellow('~')} ${k.padEnd(w)} = ${renderVal(b0, 6, '')} -> ${renderVal(a0, 6, '')}${forces}`);
  }
  const hidden = keys.length - changed.length - (before.id && !changed.includes('id') ? 1 : 0);
  if (hidden > 0) L.push(C.dim(`        # (${hidden} unchanged attributes hidden)`));
  L.push('    }');
  return L;
}

// ---------------------------------------------------------------- workspace (one config dir)
class Workspace {
  constructor(c, dir) {
    this.c = c; this.uni = c.uni; this.host = c.host; this.dir = dir; this.user = c.user;
    this.home = c.host.users.get(c.user)?.home || '/root';
    this.modCache = new Map();
    const self = this;
    this.env = {
      readFile: p => { const abs = normPath(String(p).startsWith('/') ? p : dir + '/' + p); const t = self.host.files.get(abs); if (t === undefined) throw new SimError(`open ${p}: no such file or directory`); return t; },
      writeFile: (p, content, perm) => { const abs = normPath(String(p).startsWith('/') ? p : dir + '/' + p); self.host.ensureParents?.(abs, self.user); self.host.writeFile(abs, content, self.user); self.host.setMeta(abs, { mode: parseInt(perm || '0777', 8) & 0o777 }); },
      fileContent: p => self.host.files.get(normPath(String(p).startsWith('/') ? p : dir + '/' + p)),
      removeFile: p => self.host.removeFile(normPath(String(p).startsWith('/') ? p : dir + '/' + p)),
    };
  }
  get root() { if (!this._root) this._root = loadDir(this.host, this.dir); return this._root; }
  loadModule(dir, name) {
    if (!this.host.isDir(dir)) fail('Unreadable module directory', `The directory ${dir.replace(this.dir + '/', '')} does not exist or cannot be read.`);
    if (!this.initModules().has(name) && !this.host.files.has(this.dir + '/.terraform/modules/modules.json')) fail('Module not installed', `This module is not yet installed. Run "terraform init" to install all modules required by this configuration.`);
    if (!this.modCache.has(dir)) this.modCache.set(dir, loadDir(this.host, dir));
    return this.modCache.get(dir);
  }
  initModules() { const t = this.host.files.get(this.dir + '/.terraform/modules/modules.json'); try { return new Set(JSON.parse(t || '{"Modules":[]}').Modules.map(m => m.Key)); } catch { return new Set(); } }

  backend() {
    const tb = this.root.terraform.find(b => b.blocks.some(x => x.type === 'backend'));
    if (!tb) return { type: 'local' };
    const bb = tb.blocks.find(x => x.type === 'backend');
    const cfg = Object.fromEntries(Object.entries(bb.attrs).map(([k, v]) => [k, evaluate(v.expr, { lookup: () => { fail('Variables not allowed', 'Variables may not be used here.', { file: 'backend.tf', line: v.line }); } })]));
    return { type: bb.labels[0], ...cfg };
  }
  initialized() { return this.host.files.has(this.dir + '/.terraform.lock.hcl') || this.host.isDir(this.dir + '/.terraform'); }
  initBackend() { try { return JSON.parse(this.host.files.get(this.dir + '/.terraform/terraform.tfstate') || 'null')?.backend || null; } catch { return null; } }
  requiredProviders() {
    const set = new Set();
    for (const tb of this.root.terraform) for (const rp of tb.blocks.filter(x => x.type === 'required_providers')) for (const k of Object.keys(rp.attrs)) set.add(k);
    const walk = mod => { for (const k of Object.keys(mod.resources)) set.add(k.split('_')[0]); for (const k of Object.keys(mod.data)) set.add(k.split('_')[0]); };
    walk(this.root);
    for (const m of this.modCache.values()) walk(m);
    return [...set];
  }
  checkInit() {
    if (!this.initialized()) fail('Inconsistent dependency lock file', 'The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n  - provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init');
    const lock = this.host.files.get(this.dir + '/.terraform.lock.hcl') || '';
    for (const p of this.requiredProviders()) if (!lock.includes(`hashicorp/${p}"`)) fail('Inconsistent dependency lock file', `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n  - provider registry.terraform.io/hashicorp/${p}: required by this configuration but no version is selected\n\nTo update the locked dependency selections to match a changed configuration, run:\n  terraform init -upgrade`);
    const be = this.backend();
    const ib = this.initBackend();
    if ((be.type !== 'local' || ib) && JSON.stringify(ib || { type: 'local' }) !== JSON.stringify(be)) fail('Backend initialization required, please run "terraform init"', `Reason: ${ib ? 'Backend configuration block has changed' : `Initial configuration of the requested backend "${be.type}"`}\n\nThe "backend" is the interface that Terraform uses to store state,\nperform operations, etc. If this message is showing up, it means that the\nTerraform configuration you're using is using a custom configuration for\nthe Terraform backend.\n\nChanges to backend configurations require reinitialization. This allows\nTerraform to set up the new configuration, copy existing state, etc. Please run\n"terraform init" with either the "-reconfigure" or "-migrate-state" flags to\nuse the current configuration.`);
    if (!this.uni.cloud && this.requiredProviders().includes('aws')) fail('No valid credential sources found', 'Please see https://registry.terraform.io/providers/hashicorp/aws\nfor more information about providing credentials.');
    if (this.requiredProviders().includes('aws') && !this.host.files.has(`${this.home}/.aws/credentials`) && !this.c.env.AWS_ACCESS_KEY_ID) fail('No valid credential sources found', 'Please see https://registry.terraform.io/providers/hashicorp/aws\nfor more information about providing credentials.\n\nError: failed to refresh cached credentials, no EC2 IMDS role found, operation error ec2imds: GetMetadata, request canceled, context deadline exceeded', { file: 'main.tf', line: this.root.providers[0]?.line || 1, in: 'provider "aws"' });
  }

  // state storage: local file or an S3 object
  stateLoc() {
    const be = this.backend();
    if (be.type === 's3') return { remote: true, bucket: be.bucket, key: be.key, lock: be.dynamodb_table || be.use_lockfile };
    return { remote: false, path: this.dir + '/terraform.tfstate' };
  }
  state() {
    const loc = this.stateLoc();
    let text;
    if (loc.remote) text = this.uni.cloud?.buckets.get(loc.bucket)?.objects.get(loc.key)?.body;
    else text = this.host.files.get(loc.path);
    if (!text) return { version: 4, terraform_version: TF_VERSION, serial: 0, lineage: fakeHash(this.dir, 8) + '-' + fakeHash(this.dir + 'l', 4) + '-4' + fakeHash(this.dir, 3), outputs: {}, resources: [] };
    try { return JSON.parse(text); } catch { fail('Failed to load state', `Error reading state: Unsupported state file format: invalid character in state file`); }
  }
  saveState(st) {
    st.serial = (st.serial || 0) + 1;
    const text = JSON.stringify(st, null, 2) + '\n';
    const loc = this.stateLoc();
    if (loc.remote) { const b = this.uni.cloud.buckets.get(loc.bucket); b.objects.set(loc.key, { body: text, size: text.length, time: this.uni.time }); }
    else { if (this.host.files.has(loc.path)) this.host.writeFile(loc.path + '.backup', this.host.files.get(loc.path), this.user); this.host.writeFile(loc.path, text, this.user); }
  }
  lockCheck(op) {
    const loc = this.stateLoc();
    if (!loc.remote || !loc.lock) return;
    const lock = this.uni.tfLocks?.[`${loc.bucket}/${loc.key}`];
    if (lock) throw new TfError([...diag('Error', 'Error acquiring the state lock', `Error message: operation error DynamoDB: PutItem, https response error StatusCode: 400, RequestID: ${fakeHash(op, 26).toUpperCase()}, ConditionalCheckFailedException: The conditional request failed\nLock Info:\n  ID:        ${lock.id}\n  Path:      ${loc.bucket}/${loc.key}\n  Operation: ${lock.op}\n  Who:       ${lock.who}\n  Version:   ${TF_VERSION}\n  Created:   ${new Date(lock.time * 1000).toISOString()}\n  Info:\n\n\nTerraform acquires a state lock to protect the state from being written\nby multiple users at the same time. Please resolve the issue above and try\nagain. For most commands, you can disable locking with the "-lock=false"\nflag, but this is not recommended.`)]);
  }

  // write the results of an apply into state
  record(st, i, attrs) {
    const mode = 'managed';
    let r = st.resources.find(x => x.mode === mode && x.type === i.type && x.name === i.name && (x.module || undefined) === (i.module || undefined));
    if (!attrs) {
      if (!r) return;
      r.instances = r.instances.filter(x => (x.index_key ?? null) !== (i.key ?? null));
      if (!r.instances.length) st.resources = st.resources.filter(x => x !== r);
      return;
    }
    if (!r) { r = { ...(i.module ? { module: i.module } : {}), mode, type: i.type, name: i.name, provider: `provider["registry.terraform.io/hashicorp/${i.type.split('_')[0]}"]`, instances: [] }; st.resources.push(r); }
    const clean = Object.fromEntries(Object.entries(attrs).filter(([k]) => !['host', 'launched', 'created'].includes(k)));
    const inst = { ...(i.key !== undefined && i.key !== null ? { index_key: i.key } : {}), schema_version: 1, attributes: clean, sensitive_attributes: [], dependencies: (i.deps || []).filter(d => !/(^|\.)(var|local|output)\./.test(d) && !d.startsWith('data.')).sort() };
    const k = r.instances.findIndex(x => (x.index_key ?? null) === (i.key ?? null));
    if (k >= 0) r.instances[k] = inst; else r.instances.push(inst);
  }
}

// ---------------------------------------------------------------- applying
function applyRun(c, ws, run, { quiet = false } = {}) {
  const st = ws.state();
  const out = (...l) => c.print(...l);
  const uni = c.uni;
  const cloud = uni.cloud;
  const order = new Map(run.ordered.map((n, k) => [n.key, k]));
  const nodeKey = i => i.addr.replace(/\[[^\]]*\]$/, '');
  const list = [...run.instances.values()].filter(i => i.action !== 'noop');
  const creates = list.filter(i => i.action !== 'delete').sort((a, b) => (order.get(nodeKey(a)) ?? 0) - (order.get(nodeKey(b)) ?? 0));
  const deletes = list.filter(i => i.action === 'delete').sort((a, b) => (order.get(nodeKey(b)) ?? 1e9) - (order.get(nodeKey(a)) ?? 1e9));
  let added = 0, changed = 0, destroyed = 0;
  const elapsed = (verb, i, secs, id) => { for (let t = 10; t < secs; t += 10) { uni.advance(10); out(`${bold(i.addr)}: Still ${verb}... [${id ? 'id=' + id + ', ' : ''}${t}s elapsed]`); } uni.advance(Math.max(1, secs % 10)); };
  const values = run.values;
  const setValue = (i, attrs) => {
    const k = nodeKey(i);
    const cur = values.get(k);
    if (i.key === undefined || i.key === null) values.set(k, attrs);
    else if (Array.isArray(cur)) cur[i.key] = attrs;
    else if (cur && typeof cur === 'object') cur[i.key] = attrs;
  };
  const evalArgs = i => {
    const n = run.ordered.find(x => x.key === nodeKey(i));
    const ks = run.instanceKeys(n);
    const extra = ks.kind === 'count' ? { count: i.key } : ks.kind === 'each' ? { each: { key: i.key, value: ks.map[i.key] } } : {};
    return run.argsOf(n, n.b, i.schema, extra);
  };
  const doDelete = i => {
    out(`${bold(i.addr)}: Destroying... [id=${i.before.id}]`);
    try { (i.schema.del || ((cl, id) => cl.table(i.type).delete(id)))(cloud, i.before.id, i.before, ws.env); }
    catch (e) { ws.saveState(st); throw new TfError(diag('Error', e.message.split(':')[0], e.message)); }
    if (!i.schema.local) cloud.record('delete', i.type, i.before.id);
    elapsed('destroying', i, i.schema.times?.[2] ?? 1, i.before.id);
    out(`${bold(i.addr)}: Destruction complete after ${i.schema.times?.[2] ?? 0}s`);
    ws.record(st, i, null);
  };
  const doCreate = i => {
    const a = evalArgs(i);
    if (deepUnknown(a)) throw new TfError(diag('Error', 'Provider produced inconsistent final plan', `When expanding the plan for ${i.addr} to include new values learned so far during apply, some values are still unknown.`));
    out(`${bold(i.addr)}: Creating...`);
    let attrs;
    try { attrs = i.schema.create(cloud, a, ws.env); }
    catch (e) { ws.saveState(st); throw new TfError(diag('Error', e.message.split(':')[0], e.message, { file: 'main.tf', line: i.block?.line || 1, in: `resource "${i.type}" "${i.name}"` })); }
    attrs = { ...a, ...attrs };
    if (!i.schema.local) cloud.record('create', i.type, attrs.id);
    elapsed('creating', i, i.schema.times?.[0] ?? 1);
    out(`${bold(i.addr)}: Creation complete after ${i.schema.times?.[0] ?? 0}s [id=${attrs.id}]`);
    ws.record(st, i, attrs);
    setValue(i, attrs);
  };
  for (const i of creates) {
    if (i.action === 'create') { doCreate(i); added++; continue; }
    if (i.action === 'replace') {
      if (i.cbd) { doCreate(i); doDelete({ ...i, action: 'delete' }); }
      else { doDelete(i); doCreate(i); }
      added++; destroyed++;
      continue;
    }
    if (i.action === 'update') {
      const a = evalArgs(i);
      out(`${bold(i.addr)}: Modifying... [id=${i.before.id}]`);
      let attrs;
      const ch = i.changed.filter(k => !isUnknown(a[k]));
      try { attrs = i.schema.update ? i.schema.update(cloud, i.before.id, a, ch, ws.env) : Object.assign(cloud.get(i.type, i.before.id), Object.fromEntries(ch.map(k => [k, a[k]]))); }
      catch (e) { ws.saveState(st); throw new TfError(diag('Error', e.message.split(':')[0], e.message)); }
      attrs = { ...i.before, ...attrs, ...Object.fromEntries(ch.map(k => [k, a[k]])) };
      if (!i.schema.local) cloud.record('update', i.type, i.before.id);
      elapsed('modifying', i, i.schema.times?.[1] ?? 1, i.before.id);
      out(`${bold(i.addr)}: Modifications complete after ${i.schema.times?.[1] ?? 0}s [id=${i.before.id}]`);
      ws.record(st, i, attrs);
      setValue(i, attrs);
      changed++;
    }
  }
  for (const i of deletes) { doDelete(i); destroyed++; }
  // outputs with final values
  st.outputs = {};
  if (!run.destroy) for (const n of run.ordered.filter(x => x.kind === 'output' && !x.prefix)) {
    const v = run.ev(n, n.b.attrs.value.expr, {}, {});
    const sens = n.b.attrs.sensitive ? evaluate(n.b.attrs.sensitive.expr, { lookup: () => null }) : false;
    st.outputs[n.name] = { value: v, type: Array.isArray(v) ? ['tuple', v.map(() => 'string')] : typeof v === 'object' ? ['object', {}] : typeof v, ...(sens ? { sensitive: true } : {}) };
  }
  // keep refreshed attributes for untouched resources
  for (const i of run.instances.values()) if (i.action === 'noop') ws.record(st, i, i.after);
  ws.saveState(st);
  out('', ok(bold(`Apply complete! Resources: ${added} added, ${changed} changed, ${destroyed} destroyed.`)));
  if (run.destroy) { /* no outputs */ }
  else if (Object.keys(st.outputs).length) { out('', ok(bold('Outputs:')), ''); for (const [k, o] of Object.entries(st.outputs)) out(`${k} = ${o.sensitive ? '<sensitive>' : renderVal(o.value, 0, '')}`); }
  uni.emit({ type: 'terraform-apply', host: c.host.name, dir: ws.dir, added, changed, destroyed, destroy: run.destroy });
  return 0;
}

function printPlan(c, run, { verb = 'plan' } = {}) {
  const out = (...l) => c.print(...l);
  if (run.drift.length) {
    out(bold('Note: Objects have changed outside of Terraform'), '', `Terraform detected the following changes made outside of Terraform since the last "terraform apply" which may have affected this plan:`, '');
    for (const d of run.drift) {
      if (d.kind === 'deleted') { out(`  ${bold(`# ${d.addr}`)} has been deleted`, `  ${C.red('-')} resource "${d.type}" "${d.addr.split('.').pop().replace(/\[.*$/, '')}" {`, `      ${C.red('-')} id = ${JSON.stringify(d.before.id)}`, '    }', ''); continue; }
      out(`  ${bold(`# ${d.addr}`)} has changed`, ...renderInstance({ addr: d.addr, type: d.type, name: d.addr.split('.').pop().replace(/\[.*$/, ''), action: 'update', before: d.before, after: d.after, schema: SCHEMAS[d.type] }).slice(1), '');
    }
    out(`Unless you have made equivalent changes to your configuration, or ignored the relevant attributes using ignore_changes, the following plan may include actions to undo or respond to these changes.`, '', C.dim('─'.repeat(77)), '');
  }
  if (run.refreshOnly) {
    if (!run.drift.length) out(ok(bold('No changes.')) + bold(' Your infrastructure still matches the configuration.'));
    else out('This is a refresh-only plan, so Terraform will not take any actions to undo these. If you were expecting these changes then you can apply this plan to record the updated values in the Terraform state without changing any remote objects.');
    return;
  }
  const acts = [...run.instances.values()].filter(i => i.action !== 'noop');
  if (!acts.length) {
    out(ok(bold('No changes.')) + bold(' Your infrastructure matches the configuration.'), '', `Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.`);
    const oc = outputChanges(run);
    if (oc.length) { out('', 'Changes to Outputs:', ...oc); }
    return;
  }
  const kinds = new Set(acts.map(i => i.action));
  out('Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:');
  if (kinds.has('create')) out(`  ${SYM.create} create`);
  if (kinds.has('update')) out(`  ${SYM.update} update in-place`);
  if (kinds.has('delete')) out(`  ${SYM.delete} destroy`);
  if (kinds.has('replace')) out(`${SYM.replace} destroy and then create replacement`);
  out('', 'Terraform will perform the following actions:', '');
  for (const i of acts.sort((a, b) => a.addr.localeCompare(b.addr))) out(...renderInstance(i), '');
  const n = run.counts();
  out(`${bold('Plan:')} ${n.add} to add, ${n.change} to change, ${n.destroy} to destroy.`);
  const oc = outputChanges(run);
  if (oc.length) out('', 'Changes to Outputs:', ...oc);
}
function outputChanges(run) {
  const prev = run.tf.state().outputs || {};
  const L = [];
  for (const [k, o] of Object.entries(run.outputs)) {
    const p = prev[k];
    const show = v => o.sensitive ? '(sensitive value)' : renderVal(v, 2, '');
    if (!p) L.push(`  ${C.green('+')} ${k} = ${show(o.value)}`);
    else if (JSON.stringify(p.value) !== JSON.stringify(o.value)) L.push(`  ${C.yellow('~')} ${k} = ${show(p.value)} -> ${show(o.value)}`);
  }
  if (run.destroy) for (const k of Object.keys(prev)) L.push(`  ${C.red('-')} ${k} = ${prev[k].sensitive ? '(sensitive value)' : renderVal(prev[k].value, 2, '')} -> null`);
  return L;
}

// ---------------------------------------------------------------- fmt
export function formatHcl(src) {
  const lines = src.replace(/\t/g, '  ').split('\n');
  const out = [];
  let depth = 0, inHeredoc = null;
  for (const raw of lines) {
    if (inHeredoc) { out.push(raw); if (raw.trim() === inHeredoc) inHeredoc = null; continue; }
    let l = raw.trim();
    if (!l) { if (out.length && out[out.length - 1] === '') continue; out.push(''); continue; }
    const hd = l.match(/<<-?(\w+)\s*$/);
    if (/^[}\]]/.test(l)) depth = Math.max(0, depth - 1);
    l = l.replace(/\s*=\s*/, m => (/^[\w"-]+\s*=/.test(l) ? ' = ' : m)).replace(/\s+\{$/, ' {').replace(/\s{2,}(?=[^"]*(?:"[^"]*"[^"]*)*$)/g, ' ');
    out.push('  '.repeat(depth) + l);
    if (hd) inHeredoc = hd[1];
    const opens = (l.replace(/"(?:[^"\\]|\\.)*"/g, '').match(/[{[(]/g) || []).length;
    const closes = (l.replace(/"(?:[^"\\]|\\.)*"/g, '').match(/[}\])]/g) || []).length;
    depth += opens - closes + (/^[}\]]/.test(l) ? 1 : 0);
    if (depth < 0) depth = 0;
  }
  // align = in consecutive single-line attributes at the same indent
  const res = [...out];
  let i = 0;
  while (i < res.length) {
    const m = res[i].match(/^(\s*)([\w"-]+) = (.*)$/);
    if (!m) { i++; continue; }
    let j = i;
    const group = [];
    while (j < res.length) { const mm = res[j].match(/^(\s*)([\w"-]+) = (.*)$/); if (!mm || mm[1] !== m[1]) break; group.push(j); if (/[{[(]\s*$|<<-?\w+$/.test(mm[3])) { j++; break; } j++; }
    const w = Math.max(...group.map(k => res[k].match(/^(\s*)([\w"-]+) =/)[2].length));
    for (const k of group) res[k] = res[k].replace(/^(\s*)([\w"-]+) = /, (_, s, key) => `${s}${key.padEnd(w)} = `);
    i = j > i ? j : i + 1;
  }
  while (res.length && res[res.length - 1] === '') res.pop();
  return res.join('\n') + '\n';
}

// ---------------------------------------------------------------- CLI
function parseFlags(args) {
  const f = { _: [], vars: {}, varFiles: [], targets: [], replace: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = a.match(/^--?([\w-]+)(?:=(.*))?$/);
    if (!m) { f._.push(a); continue; }
    const k = m[1]; let v = m[2];
    const needs = ['var', 'var-file', 'target', 'replace', 'out', 'lock', 'input', 'state', 'chdir', 'parallelism'];
    if (v === undefined && needs.includes(k) && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) v = args[++i];
    if (k === 'var') { const e = String(v).indexOf('='); f.vars[String(v).slice(0, e)] = String(v).slice(e + 1); continue; }
    if (k === 'var-file') { f.varFiles.push(v); continue; }
    if (k === 'target') { f.targets.push(v); continue; }
    if (k === 'replace') { f.replace.push(v); continue; }
    f[k] = v === undefined ? true : v;
  }
  return f;
}

function tfvarsFrom(ws, f) {
  const vars = {};
  const load = (path, explicit) => {
    const t = ws.host.files.get(path);
    if (t === undefined) { if (explicit) fail('Failed to read variables file', `Given variables file ${path.replace(ws.dir + '/', '')} does not exist.`); return; }
    let body;
    try { body = parseHcl(t, basename(path)); } catch (e) { fail(e.message.split(':')[0], e.message, { file: basename(path), line: e.line }); }
    for (const [k, a] of Object.entries(body.attrs)) { if (!ws.root.variables[k]) { ws.warnings.push(...diag('Warning', 'Value for undeclared variable', `The root module does not declare a variable named "${k}" but a value was found in file "${basename(path)}". If you meant to use this value, add a "variable" block to the configuration.\n\nTo silence these warnings, use TF_VAR_... environment variables to provide certain "global" settings to all configurations in your organization. To reduce the verbosity of these warnings, use the -compact-warnings option.`)); continue; } vars[k] = evaluate(a.expr, { lookup: () => null }); }
  };
  for (const [k, v] of Object.entries(ws.c.env)) if (k.startsWith('TF_VAR_')) vars[k.slice(7)] = v;
  load(ws.dir + '/terraform.tfvars', false);
  for (const p of [...ws.host.files.keys()].filter(p => dirname(p) === ws.dir && /\.auto\.tfvars$/.test(p)).sort()) load(p, false);
  for (const vf of f.varFiles) load(normPath(ws.dir + '/' + vf), true);
  for (const [k, v] of Object.entries(f.vars)) { if (!ws.root.variables[k]) fail('Value for undeclared variable', `A variable named "${k}" was assigned on the command line, but the root module does not declare a variable of that name. To use this value, add a "variable" block to the configuration.`); vars[k] = v; }
  return vars;
}

def(['terraform', 'tofu'], c => {
  const [sub0, ...rest] = c.args;
  const f = parseFlags(rest);
  let dir = c.cwd;
  if (f.chdir) dir = c.resolve(f.chdir);
  const out = (...l) => c.print(...l);
  if (!sub0 || sub0 === '-help' || sub0 === '--help' || sub0 === 'help') { out('Usage: terraform [global options] <subcommand> [args]', '', 'Main commands:', '  init          Prepare your working directory for other commands', '  validate      Check whether the configuration is valid', '  plan          Show changes required by the current configuration', '  apply         Create or update infrastructure', '  destroy       Destroy previously-created infrastructure', '', 'All other commands:', '  fmt           Reformat your configuration in the standard style', '  output        Show output values from your root module', '  show          Show the current state or a saved plan', '  state         Advanced state management (list, show, rm, mv)', '  import        Associate existing infrastructure with a Terraform resource', '  force-unlock  Release a stuck lock on the current workspace', '  version       Show the current Terraform version'); return 0; }
  if (sub0 === 'version' || sub0 === '-version' || sub0 === '--version') { out(`Terraform v${TF_VERSION}`, 'on linux_amd64'); return 0; }
  const ws = new Workspace(c, dir);
  ws.warnings = [];
  const emit = extra => c.uni.emit({ type: 'terraform', host: c.host.name, dir, sub: sub0, ...extra });
  const run = () => {
    switch (sub0) {
      case 'init': return initCmd(c, ws, f, emit);
      case 'fmt': {
        const files = [...c.host.files.keys()].filter(p => (f.recursive ? p.startsWith(dir + '/') && !p.includes('/.terraform/') : dirname(p) === dir) && /\.(tf|tfvars)$/.test(p)).sort();
        const bad = [];
        for (const p of files) { const src = c.host.files.get(p); let fm; try { parseHcl(src, basename(p)); fm = formatHcl(src); } catch (e) { fail(e.message.split(':')[0], e.message, { file: basename(p), line: e.line }); } if (fm !== src) { bad.push(p.slice(dir.length + 1)); if (!f.check) c.host.writeFile(p, fm, c.user); } }
        if (bad.length) out(...bad);
        emit({ check: !!f.check, files: bad });
        return f.check && bad.length ? 3 : 0;
      }
      case 'validate': {
        ws.checkInit();
        const r = new Run(ws, { vars: Object.fromEntries(Object.keys(ws.root.variables).map(k => [k, UNKNOWN])) });
        r.cloud = c.uni.cloud;
        try { r.plan(); } catch (e) { if (e.needVar) { /* fine */ } else throw e; }
        out(ok(bold('Success!')) + ' The configuration is valid.', '');
        emit({ ok: true });
        return 0;
      }
      case 'plan': case 'apply': case 'destroy': return planApply(c, ws, f, emit);
      case 'output': {
        const st = ws.state();
        const name = f._[0];
        if (f.json) { out(...JSON.stringify(name ? st.outputs[name]?.value : Object.fromEntries(Object.entries(st.outputs).map(([k, o]) => [k, { sensitive: !!o.sensitive, type: o.type, value: o.value }])), null, 2).split('\n')); emit({ name, json: true }); return 0; }
        if (name) { const o = st.outputs[name]; if (!o) fail('Output "' + name + '" not found', 'The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run `terraform apply`, since the state won\'t be updated with new output variables until that command is run.'); if (f.raw) { if (typeof o.value === 'object') fail('Unsupported value for raw output', `The -raw option only supports strings, numbers, and boolean values, but output value "${name}" is ${Array.isArray(o.value) ? 'tuple' : 'object'}.\n\nUse the -json option for machine-readable representations of output values that have complex types.`); c.print(String(o.value)); return 0; } out(o.sensitive && !f.raw ? renderVal(o.value, 0, '') : renderVal(o.value, 0, '')); emit({ name }); return 0; }
        if (!Object.keys(st.outputs).length) { out(...diag('Warning', 'No outputs found', 'The state file either has no outputs defined, or all the defined outputs are empty. Please define an output in your configuration with the `output` keyword and run `terraform refresh` for it to become available. If you are using interpolation, please verify the interpolated value is not empty. You can use the `terraform console` command to assist.')); return 0; }
        for (const [k, o] of Object.entries(st.outputs)) out(`${k} = ${o.sensitive ? '<sensitive>' : renderVal(o.value, 0, '')}`);
        emit({});
        return 0;
      }
      case 'show': {
        const st = ws.state();
        if (f.json) { out(JSON.stringify({ format_version: '1.0', terraform_version: TF_VERSION, values: { root_module: { resources: st.resources.flatMap(r => r.instances.map(i => ({ address: `${r.type}.${r.name}`, type: r.type, name: r.name, values: i.attributes }))) } } })); return 0; }
        if (!st.resources.length) { out('No state.'); return 0; }
        for (const r of st.resources) for (const i of r.instances) {
          out(`# ${r.module ? r.module + '.' : ''}${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}${i.index_key === undefined ? '' : `[${JSON.stringify(i.index_key)}]`}:`, `resource "${r.type}" "${r.name}" {`);
          const ks = Object.keys(i.attributes).sort(); const w = Math.max(...ks.map(k => k.length));
          for (const k of ks) out(`    ${k.padEnd(w)} = ${SCHEMAS[r.type]?.sensitive?.includes(k) ? '(sensitive value)' : renderVal(i.attributes[k], 4, '')}`);
          out('}', '');
        }
        if (Object.keys(st.outputs).length) { out('', 'Outputs:', ''); for (const [k, o] of Object.entries(st.outputs)) out(`${k} = ${o.sensitive ? '(sensitive value)' : renderVal(o.value, 0, '')}`); }
        emit({});
        return 0;
      }
      case 'state': {
        const [op, ...args] = f._;
        const st = ws.state();
        const addrs = st.resources.flatMap(r => r.instances.map(i => ({ r, i, addr: `${r.module ? r.module + '.' : ''}${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}${i.index_key === undefined ? '' : `[${JSON.stringify(i.index_key)}]`}` })));
        if (op === 'list') { out(...addrs.map(x => x.addr).filter(a => !args[0] || a.startsWith(args[0]))); emit({ op }); return 0; }
        if (op === 'show') { const x = addrs.find(y => y.addr === args[0]); if (!x) { c.eprint(`No instance found for the given address!\n\nThis command requires that the address references one specific instance.\nTo view the available instances, use "terraform state list". Please modify\nthe address to reference a specific instance.`); return 1; } out(`# ${x.addr}:`, `resource "${x.r.type}" "${x.r.name}" {`); const ks = Object.keys(x.i.attributes).sort(); const w = Math.max(...ks.map(k => k.length)); for (const k of ks) out(`    ${k.padEnd(w)} = ${SCHEMAS[x.r.type]?.sensitive?.includes(k) ? '(sensitive value)' : renderVal(x.i.attributes[k], 4, '')}`); out('}'); emit({ op, addr: args[0] }); return 0; }
        if (op === 'rm') { ws.lockCheck('OperationTypeInvalid'); let n = 0; for (const a of args) { const x = addrs.find(y => y.addr === a); if (!x) continue; x.r.instances = x.r.instances.filter(i => i !== x.i); n++; out(`Removed ${a}`); } st.resources = st.resources.filter(r => r.instances.length); ws.saveState(st); out(ok(`Successfully removed ${n} resource instance(s).`)); emit({ op, addrs: args }); return 0; }
        if (op === 'mv') { const [from, to] = args; const x = addrs.find(y => y.addr === from); if (!x) fail('Invalid source address', `Cannot move ${from}: does not match anything in the current state.`); const m = to.match(/^([\w]+)\.([\w-]+)(?:\[(.+)\])?$/); x.r.instances = x.r.instances.filter(i => i !== x.i); const ni = { ...x.i }; if (m[3] !== undefined) ni.index_key = JSON.parse(m[3]); else delete ni.index_key; let r = st.resources.find(y => y.type === m[1] && y.name === m[2]); if (!r) { r = { ...x.r, name: m[2], instances: [] }; st.resources.push(r); } r.instances.push(ni); st.resources = st.resources.filter(y => y.instances.length); ws.saveState(st); out(`Move "${from}" to "${to}"`, ok('Successfully moved 1 object(s).')); emit({ op }); return 0; }
        if (op === 'pull') { out(JSON.stringify(st, null, 2)); return 0; }
        fail('Invalid state subcommand', 'Usage: terraform state <list|show|rm|mv|pull>');
        return 1;
      }
      case 'import': {
        ws.checkInit();
        const [addr, id] = f._;
        if (!addr || !id) fail('Missing required argument', 'The import command expects two arguments: ADDR ID.');
        const m = addr.match(/^([\w]+)\.([\w-]+)(?:\[(.+)\])?$/);
        const b = m && ws.root.resources[`${m[1]}.${m[2]}`];
        if (!b) fail('resource address "' + addr + '" does not exist in the configuration.', `Before importing this resource, please create its configuration in the root module. For example:\n\nresource "${m?.[1] || 'aws_instance'}" "${m?.[2] || 'name'}" {\n  # (resource arguments)\n}`);
        const schema = SCHEMAS[m[1]];
        const real = schema.read ? schema.read(c.uni.cloud, id) : c.uni.cloud.get(m[1], id);
        if (!real) fail('Cannot import non-existent remote object', `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`);
        const st = ws.state();
        if (st.resources.some(r => r.type === m[1] && r.name === m[2])) fail('Resource already managed by Terraform', `Terraform is already managing a remote object for ${addr}. To import to this address you must first remove the existing object from the state.`);
        out(`${bold(addr)}: Importing from ID "${id}"...`, `${bold(addr)}: Import prepared!`, `  Prepared ${m[1]} for import`, `${bold(addr)}: Refreshing state... [id=${id}]`, '', ok(bold('Import successful!')), '', 'The resources that were imported are shown above. These resources are now in', 'your Terraform state and will henceforth be managed by Terraform.');
        ws.record(st, { type: m[1], name: m[2], key: m[3] !== undefined ? JSON.parse(m[3]) : undefined, deps: [] }, pick(real, schema, {}));
        ws.saveState(st);
        emit({ addr, id });
        return 0;
      }
      case 'force-unlock': {
        const id = f._[0];
        const loc = ws.stateLoc();
        const key = `${loc.bucket}/${loc.key}`;
        const lock = c.uni.tfLocks?.[key];
        if (!lock || lock.id !== id) fail('Failed to unlock state', `failed to retrieve lock info for lock ID "${id}": unable to find lock`);
        delete c.uni.tfLocks[key];
        out(ok(bold('Terraform state has been successfully unlocked!')), '', 'The state has been unlocked, and Terraform commands should now be able to', 'obtain a new lock on the remote state.');
        emit({ id });
        return 0;
      }
      case 'providers': { out('', 'Providers required by configuration:', '.', ...ws.requiredProviders().map(p => `├── provider[registry.terraform.io/hashicorp/${p}] ${p === 'aws' ? '~> 5.0' : ''}`)); return 0; }
      case 'console': fail('Interactive console not available', 'The simulator has no interactive terraform console. Use outputs, or `terraform state show`.');
    }
    c.eprint(`Terraform has no command named "${sub0}".`, '', 'To see all of Terraform\'s top-level commands, run:', '  terraform -help');
    return 1;
  };
  try { const code = run(); if (ws.warnings.length) c.print(...ws.warnings); return code; }
  catch (e) {
    if (e instanceof TfError) { c.eprint(...e.lines); emit({ ok: false, error: stripCodes(e.lines.find(l => /Error:/.test(stripCodes(l))) || '') }); return 1; }
    if (e instanceof SimError) { c.eprint(...diag('Error', e.message)); emit({ ok: false }); return 1; }
    throw e;
  }
}, { pkg: 'terraform' });
const stripCodes = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function initCmd(c, ws, f, emit) {
  const out = (...l) => c.print(...l);
  const root = ws.root;
  const be = ws.backend();
  const ib = ws.initBackend();
  if (Object.keys(root.modules).length) {
    out(bold('Initializing modules...'));
    const keys = [];
    const walk = (mod, prefix) => { for (const [n, b] of Object.entries(mod.modules)) { const src = evaluate(b.attrs.source.expr, { lookup: () => null }); const d = normPath(mod.dir + '/' + src); if (!/^\.\.?\//.test(src)) fail('Module source not available in the lab', `The simulator installs local modules only (source = "./modules/..."). "${src}" is a registry or remote source.`); if (!c.host.isDir(d)) fail('Unreadable module directory', `The directory ${src} does not exist or cannot be read.`, { file: 'main.tf', line: b.line, in: `module "${n}"` }); out(`- ${prefix}${n} in ${src.replace(/^\.\//, '')}`); keys.push(prefix + n); walk(loadDir(c.host, d), prefix + n + '.'); } };
    walk(root, '');
    c.host.ensureParents?.(ws.dir + '/.terraform/modules/modules.json', c.user);
    c.host.writeFile(ws.dir + '/.terraform/modules/modules.json', JSON.stringify({ Modules: keys.map(k => ({ Key: k, Source: './modules', Dir: 'modules' })) }), c.user);
  }
  out(bold('Initializing the backend...'));
  if (be.type === 's3') {
    if (!c.uni.cloud?.buckets.has(be.bucket)) fail('Failed to get existing workspaces: S3 bucket "' + be.bucket + '" does not exist.', `The referenced S3 bucket must have been previously created. If the S3 bucket\nwas created within the last minute, please wait for a minute or two and try\nagain.\n\nError: operation error S3: ListObjectsV2, https response error StatusCode: 404, api error NoSuchBucket: The specified bucket does not exist`);
    const local = c.host.files.get(ws.dir + '/terraform.tfstate');
    const migrate = local && JSON.parse(local).resources?.length && !c.uni.cloud.buckets.get(be.bucket).objects.has(be.key);
    if (migrate && !f['force-copy'] && !f['migrate-state'] && f.input !== 'false') {
      c.result.ask = { prompt: '  Enter a value:', onAnswer(ans, { io }) { if (ans.trim() !== 'yes') { io.out('\nThe backend migration was cancelled.\n'); return 1; } const b = c.uni.cloud.buckets.get(be.bucket); b.objects.set(be.key, { body: local, size: local.length, time: c.uni.time }); c.host.removeFile(ws.dir + '/terraform.tfstate'); finishInit(c, ws, be, (...l) => io.out(l.join('\n') + '\n'), emit, true); return 0; } };
      out(`Do you want to copy existing state to the new backend?`, `  Pre-existing state was found while migrating the previous "local" backend to the`, `  newly configured "s3" backend. No existing state was found in the newly`, `  configured "s3" backend. Do you want to copy this state to the new "s3"`, `  backend? Enter "yes" to copy and "no" to start with an empty state.`, '');
      return 0;
    }
    if (migrate) { const b = c.uni.cloud.buckets.get(be.bucket); b.objects.set(be.key, { body: local, size: local.length, time: c.uni.time }); c.host.removeFile(ws.dir + '/terraform.tfstate'); }
  }
  finishInit(c, ws, be, out, emit, !!ib);
  return 0;
}
function finishInit(c, ws, be, out, emit, migrated) {
  if (be.type !== 'local') out(ok(`Successfully configured the backend "${be.type}"! Terraform will automatically`), ok('use this backend unless the backend configuration changes.'));
  out(bold('Initializing provider plugins...'));
  const provs = ws.requiredProviders();
  const lockPath = ws.dir + '/.terraform.lock.hcl';
  const had = c.host.files.get(lockPath) || '';
  for (const p of provs) {
    const v = PROVIDER_VERSIONS[p] || '1.0.0';
    if (had.includes(`hashicorp/${p}"`)) { out(`- Reusing previous version of hashicorp/${p} from the dependency lock file`, `- Using previously-installed hashicorp/${p} v${v}`); continue; }
    out(`- Finding ${p === 'aws' ? 'hashicorp/aws versions matching "~> 5.0"' : `latest version of hashicorp/${p}`}...`, `- Installing hashicorp/${p} v${v}...`, `- Installed hashicorp/${p} v${v} (signed by HashiCorp)`);
  }
  c.host.ensureParents?.(ws.dir + '/.terraform/providers/registry.terraform.io/x', c.user);
  c.host.fakeSizes = c.host.fakeSizes || new Map();
  for (const p of provs) { const pf = `${ws.dir}/.terraform/providers/registry.terraform.io/hashicorp/${p}/${PROVIDER_VERSIONS[p] || '1.0.0'}/linux_amd64/terraform-provider-${p}`; c.host.ensureParents?.(pf, c.user); c.host.writeFile(pf, 'ELF', c.user); c.host.fakeSizes.set(pf, p === 'aws' ? 678e6 : 14e6); }
  const lock = ['# This file is maintained automatically by "terraform init".', '# Manual edits may be lost in future updates.', '', ...provs.map(p => `provider "registry.terraform.io/hashicorp/${p}" {\n  version     = "${PROVIDER_VERSIONS[p] || '1.0.0'}"\n  constraints = "${p === 'aws' ? '~> 5.0' : ''}"\n  hashes = [\n    "h1:${btoa(fakeHash(p, 32)).slice(0, 43)}=",\n  ]\n}\n`)].join('\n');
  if (!had) out(`Terraform has created a lock file ${bold('.terraform.lock.hcl')} to record the provider`, 'selections it made above. Include this file in your version control repository', 'so that Terraform can guarantee to make the same selections by default when', 'you run "terraform init" in the future.');
  c.host.writeFile(lockPath, lock, c.user);
  c.host.writeFile(ws.dir + '/.terraform/terraform.tfstate', JSON.stringify({ version: 3, backend: be.type === 'local' ? null : be }), c.user);
  out('', ok(bold('Terraform has been successfully initialized!')), '', ok('You may now begin working with Terraform. Try running "terraform plan" to see'), ok('any changes that are required for your infrastructure. All Terraform commands'), ok('should now work.'), '', ok('If you ever set or change modules or backend configuration for Terraform,'), ok('rerun this command to reinitialize your working directory. If you forget, other'), ok('commands will detect it and remind you to do so if necessary.'));
  emit({ ok: true, backend: be.type, migrated });
}

function planApply(c, ws, f, emit, extraVars = {}) {
  const sub = c.args[0];
  const out = (...l) => c.print(...l);
  ws.checkInit();
  const destroy = sub === 'destroy' || !!f.destroy;
  // saved plan
  if (sub === 'apply' && f._[0]) {
    const pf = c.resolve(f._[0]);
    const text = c.host.files.get(pf);
    if (text === undefined) fail('Failed to load "' + f._[0] + '" as a plan file', `Error: stat ${f._[0]}: no such file or directory`);
    let saved; try { saved = JSON.parse(atob(text.split('\n')[1] || '')); } catch { fail('Failed to load "' + f._[0] + '" as a plan file', 'The given file is not a valid plan file.'); }
    if (saved.serial !== ws.state().serial) fail('Saved plan is stale', 'The given plan file can no longer be applied because the state was changed by another operation after the plan was created.');
    const run = new Run(ws, { vars: saved.vars, destroy: saved.destroy, targets: saved.targets, replace: saved.replace });
    run.plan();
    ws.lockCheck('OperationTypeApply');
    return applyRun(c, ws, run);
  }
  let vars;
  vars = { ...tfvarsFrom(ws, f), ...extraVars };
  const run = new Run(ws, { vars, destroy, targets: f.targets, replace: f.replace, refreshOnly: !!f['refresh-only'] });
  ws.lockCheck(sub === 'plan' ? 'OperationTypePlan' : 'OperationTypeApply');
  try { run.plan(); }
  catch (e) {
    if (e.needVar) {
      if (f.input === 'false') fail('No value for required variable', `The root module input variable "${e.needVar}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`);
      out(`${bold(`var.${e.needVar}`)}`, ...(e.description ? [`  ${e.description}`, ''] : []), '');
      c.result.ask = { prompt: '  Enter a value:', secret: !!e.sensitive, onAnswer(ans, { io, result }) {
        const sink = []; const c2 = { ...c, print: (...l) => sink.push(...l), eprint: (...l) => sink.push(...l), result };
        let code;
        try { code = planApply(c2, ws, f, emit, { ...extraVars, [e.needVar]: ans }); }
        catch (err) { if (err instanceof TfError) { sink.push(...err.lines); code = 1; } else throw err; }
        io.out(sink.join('\n') + '\n');
        return code;
      } };
      return 0;
    }
    throw e;
  }
  if (sub !== 'plan' || !f.out) { /* fallthrough */ }
  const acts = [...run.instances.values()].filter(i => i.action !== 'noop');
  if (run.instances.size || run.drift.length) out(...[...run.instances.values()].filter(i => i.before?.id).map(i => `${bold(i.addr)}: Refreshing state... [id=${i.before.id}]`), '');
  printPlan(c, run, { verb: sub });
  if (f.targets.length) out('', ...diag('Warning', 'Resource targeting is in effect', 'You are creating a plan with the -target option, which means that the result\nof this plan may not represent all of the changes requested by the current\nconfiguration.\n\nThe -target option is not for routine use, and is provided only for\nexceptional situations such as recovering from errors or mistakes, or when\nTerraform specifically suggests to use it as part of an error message.'));
  if (sub === 'plan') {
    if (f.out) { const pf = c.resolve(f.out); c.host.writeFile(pf, `TFPLAN1\n${btoa(JSON.stringify({ serial: ws.state().serial, vars, destroy, targets: f.targets, replace: f.replace }))}\n`, c.user); out('', C.dim('─'.repeat(77)), '', `Saved the plan to: ${f.out}`, '', 'To perform exactly these actions, run the following command to apply:', `    terraform apply "${f.out}"`); }
    else if (acts.length) out('', C.dim('─'.repeat(77)), '', 'Note: You didn\'t use the -out option to save this plan, so Terraform can\'t', 'guarantee to take exactly these actions if you run "terraform apply" now.');
    emit({ ok: true, counts: run.counts(), drift: run.drift.length, actions: acts.map(i => ({ addr: i.addr, action: i.action })), targets: f.targets, destroy, saved: !!f.out });
    return f['detailed-exitcode'] && acts.length ? 2 : 0;
  }
  if (!acts.length && !(run.refreshOnly && run.drift.length)) { emit({ ok: true, counts: run.counts(), actions: [], destroy }); return 0; }
  const go = (io) => {
    const sink = io ? [] : null;
    const c2 = io ? { ...c, print: (...l) => sink.push(...l), eprint: (...l) => sink.push(...l) } : c;
    let code;
    try {
      if (run.refreshOnly) { const st = ws.state(); for (const d of run.drift) { const p = run.priorByAddr.get(d.addr); if (d.kind === 'deleted') ws.record(st, { type: d.type, name: p.name, module: p.module, key: p.key }, null); else ws.record(st, { type: d.type, name: p.name, module: p.module, key: p.key, deps: p.deps }, d.after); } ws.saveState(st); c2.print('', ok(bold('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.'))); code = 0; }
      else code = applyRun(c2, ws, run);
    } catch (err) { if (err instanceof TfError) { (sink || []).push(...err.lines); if (!io) c.eprint(...err.lines); code = 1; } else throw err; }
    emit({ ok: code === 0, counts: run.counts(), actions: acts.map(i => ({ addr: i.addr, action: i.action })), destroy, applied: true, auto: !!f['auto-approve'], targets: f.targets });
    if (io) io.out(sink.join('\n') + '\n');
    return code;
  };
  if (f['auto-approve']) return go(null);
  if (f.input === 'false') fail('No value for required variable', 'Apply requires approval; use -auto-approve with -input=false.');
  out('', bold(destroy ? 'Do you really want to destroy all resources?' : 'Do you want to perform these actions?'), destroy ? '  Terraform will destroy all your managed infrastructure, as shown above.\n  There is no undo. Only \'yes\' will be accepted to confirm.' : '  Terraform will perform the actions described above.\n  Only \'yes\' will be accepted to approve.', '');
  c.result.ask = { prompt: '  Enter a value:', onAnswer(ans, { io }) { if (ans.trim() !== 'yes') { io.out(`\n${destroy ? 'Destroy cancelled.' : 'Apply cancelled.'}\n`); emit({ ok: false, cancelled: true }); return 1; } io.out('\n'); return go(io); } };
  return 0;
}

export { formatHcl as fmt, Workspace };
