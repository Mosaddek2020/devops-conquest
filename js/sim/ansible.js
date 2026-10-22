// Ansible for the simulated machines: INI/YAML inventories, ad-hoc commands, playbooks with
// the common modules (apt, copy, template, file, lineinfile, user, service, ufw, command…),
// Jinja2 templates and conditions, loops, register, handlers, roles, check and diff mode,
// ansible-vault and a small ansible-lint. Hosts are reached over SSH with your keys.

import { def } from './registry.js';
import { C } from '../git/world.js';
import { parseYaml } from '../git/yaml.js';
import { normPath, dirname, basename } from './host.js';
import { connect, httpRequest } from './net.js';
import { Session } from './session.js';
import { installPkg, CATALOG, UBUNTU_BASE } from './packages.js';
import { startUnit, stopUnit, unitState } from './systemd.js';
import { diffLines } from '../git/diff.js';
import { fakeHash } from './hcl.js';

// ---------------------------------------------------------------- Jinja2 (subset)
function jTokens(src) { return src.match(/\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?|==|!=|<=|>=|[A-Za-z_][\w]*|[()[\].,|+\-*/%<>~:]|\S)/g)?.map(t => t.trim()) || []; }
export function jEval(expr, vars) {
  const toks = jTokens(expr);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const lookup = name => { if (name === 'true' || name === 'True') return true; if (name === 'false' || name === 'False') return false; if (name === 'none' || name === 'None') return null; if (!(name in vars)) return { __undef: name }; return vars[name]; };
  const isUndef = v => v && typeof v === 'object' && v.__undef;
  const FILTERS = {
    default: (v, d = '', b = false) => isUndef(v) || v === undefined || (b && !v) ? d : v, d: (v, d = '') => isUndef(v) ? d : v,
    upper: v => String(v).toUpperCase(), lower: v => String(v).toLowerCase(), capitalize: v => String(v).charAt(0).toUpperCase() + String(v).slice(1),
    join: (v, s = '') => (v || []).join(s), length: v => (Array.isArray(v) || typeof v === 'string') ? v.length : Object.keys(v || {}).length, count: v => (v || []).length,
    int: v => parseInt(v, 10) || 0, string: v => String(v), bool: v => v === true || ['yes', 'true', '1', 'on'].includes(String(v).toLowerCase()), float: v => Number(v),
    to_json: v => JSON.stringify(v), to_nice_json: v => JSON.stringify(v, null, 4), to_yaml: v => JSON.stringify(v), quote: v => `'${String(v).replace(/'/g, "'\"'\"'")}'`,
    replace: (v, a, b) => String(v).split(a).join(b), trim: v => String(v).trim(), first: v => v?.[0], last: v => v?.[v.length - 1], sort: v => [...v].sort(), unique: v => [...new Set(v)],
    map: (v, a, b) => a === 'attribute' ? (v || []).map(x => x?.[b]) : (v || []).map(x => FILTERS[a]?.(x, b) ?? x), list: v => [...(v || [])], dict2items: v => Object.entries(v || {}).map(([key, value]) => ({ key, value })),
    b64encode: v => btoa(String(v)), b64decode: v => atob(String(v)), password_hash: v => `$6$rounds=656000$${fakeHash(v, 16)}$${fakeHash(v + 'x', 86)}`, regex_replace: (v, a, b) => String(v).replace(new RegExp(a, 'g'), b),
    basename: v => String(v).split('/').pop(), dirname: v => String(v).split('/').slice(0, -1).join('/'), mandatory: v => { if (isUndef(v)) throw new Error(`Mandatory variable '${v.__undef}' not defined.`); return v; },
  };
  function primary() {
    const t = next();
    if (t === undefined) throw new Error(`unexpected end of template`);
    if (t === '(') { const v = or(); next(); return post(v); }
    if (t === '[') { const items = []; while (peek() !== ']') { items.push(or()); if (peek() === ',') next(); } next(); return post(items); }
    if (t === 'not') return !truthy(cmp());
    if (t === '-') return -primary();
    if (/^["']/.test(t)) return post(t.slice(1, -1).replace(/\\(.)/g, '$1'));
    if (/^\d/.test(t)) return post(Number(t));
    return post(lookup(t));
  }
  function post(v) {
    while (true) {
      if (peek() === '.') { next(); const k = next(); if (isUndef(v)) return v; v = v == null ? { __undef: k } : (k in Object(v) ? v[k] : { __undef: k }); continue; }
      if (peek() === '[') { next(); const k = or(); next(); if (isUndef(v)) return v; v = v?.[k] ?? { __undef: String(k) }; continue; }
      if (peek() === '|') {
        next(); const name = next(); const args = [];
        if (peek() === '(') { next(); while (peek() !== ')') { args.push(or()); if (peek() === ',') next(); } next(); }
        if (!FILTERS[name]) throw new Error(`template error while templating string: No filter named '${name}'.`);
        v = FILTERS[name](v, ...args);
        continue;
      }
      return v;
    }
  }
  const truthy = v => !isUndef(v) && !!v && !(Array.isArray(v) && !v.length);
  function arith() { let l = primary(); while (['+', '-', '*', '/', '%', '~'].includes(peek())) { const op = next(); const r = primary(); l = op === '+' ? (typeof l === 'string' || typeof r === 'string' ? String(l) + String(r) : l + r) : op === '~' ? String(l) + String(r) : op === '-' ? l - r : op === '*' ? l * r : op === '/' ? l / r : l % r; } return l; }
  function cmp() {
    const l = arith();
    const op = peek();
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) { next(); const r = arith(); const a = isUndef(l) ? undefined : l, b = isUndef(r) ? undefined : r; return op === '==' ? a == b : op === '!=' ? a != b : op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b; } // eslint-disable-line eqeqeq
    if (op === 'in') { next(); const r = arith(); return Array.isArray(r) ? r.includes(l) : typeof r === 'string' ? r.includes(l) : !!r && l in r; }
    if (op === 'not' && toks[i + 1] === 'in') { next(); next(); const r = arith(); return !(Array.isArray(r) ? r.includes(l) : String(r).includes(l)); }
    if (op === 'is') { next(); let neg = false; if (peek() === 'not') { next(); neg = true; } const test = next(); const res = test === 'defined' ? !isUndef(l) : test === 'undefined' ? isUndef(l) : test === 'none' ? l === null : test === 'string' ? typeof l === 'string' : test === 'number' ? typeof l === 'number' : test === 'changed' ? !!l?.changed : test === 'failed' ? !!l?.failed : test === 'succeeded' || test === 'success' ? !l?.failed : test === 'skipped' ? !!l?.skipped : false; return neg ? !res : res; }
    return l;
  }
  function and() { let l = cmp(); while (peek() === 'and') { next(); const r = cmp(); l = truthy(l) && truthy(r); } return l; }
  function or() { let l = and(); while (peek() === 'or') { next(); const r = and(); l = truthy(l) || truthy(r); } if (peek() === 'if') { next(); const c = or(); let e = ''; if (peek() === 'else') { next(); e = or(); } return truthy(c) ? l : e; } return l; }
  const v = or();
  if (i < toks.length) throw new Error(`template error while templating string: expected token 'end of print statement', got '${toks[i]}'. String: {{ ${expr} }}`);
  return v;
}
export function jRender(text, vars) {
  if (typeof text !== 'string' || !/[{][{%]/.test(text)) return text;
  // whole-value expression keeps its type
  const whole = text.match(/^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/);
  if (whole) { const v = jEval(whole[1], vars); if (v && typeof v === 'object' && v.__undef) throw new Error(`'${v.__undef}' is undefined`); return v; }
  // statements
  const toks = text.split(/(\{%-?[\s\S]*?-?%\}|\{\{[\s\S]*?\}\})/);
  let pos = 0;
  function block(stop) {
    let outS = '';
    while (pos < toks.length) {
      const t = toks[pos];
      if (t.startsWith('{%')) {
        const st = t.replace(/^\{%-?\s*|\s*-?%\}$/g, '');
        const [kw] = st.split(/\s+/);
        if (stop.includes(kw)) return { out: outS, end: kw, st };
        pos++;
        if (kw === 'if') {
          let branches = [[st.slice(3), null]];
          let cur = block(['elif', 'else', 'endif']);
          branches[0][1] = cur.out;
          while (cur.end !== 'endif') { pos++; if (cur.end === 'elif') { const cond = cur.st.slice(5); cur = block(['elif', 'else', 'endif']); branches.push([cond, cur.out]); } else { cur = block(['endif']); branches.push(['true', cur.out]); } }
          pos++;
          const hit = branches.find(([c]) => { const v = jEval(c, vars); return !(v && v.__undef) && !!v && !(Array.isArray(v) && !v.length); });
          if (hit) outS += hit[1];
          continue;
        }
        if (kw === 'for') {
          const m = st.match(/^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+)$/);
          const start = pos;
          // find the matching endfor without rendering the body
          let depth = 0, endPos = pos;
          for (; endPos < toks.length; endPos++) { const tk = toks[endPos]; if (!tk.startsWith('{%')) continue; const k2 = tk.replace(/^\{%-?\s*|\s*-?%\}$/g, '').split(/\s+/)[0]; if (k2 === 'for') depth++; else if (k2 === 'endfor') { if (!depth) break; depth--; } }
          let coll = jEval(m[3], vars);
          if (coll && coll.__undef) throw new Error(`'${coll.__undef}' is undefined`);
          const items = Array.isArray(coll) ? coll.map(x => [x]) : Object.entries(coll || {});
          let rendered = '';
          for (const it of items) { pos = start; const saved = { ...vars }; if (m[2]) { vars[m[1]] = it[0]; vars[m[2]] = it[1]; } else vars[m[1]] = it.length === 1 ? it[0] : it; rendered += block(['endfor']).out; Object.keys(vars).forEach(k => { if (!(k in saved)) delete vars[k]; }); Object.assign(vars, saved); }
          pos = endPos + 1;
          outS += items.length ? rendered : '';
          continue;
        }
        if (kw === 'set') { const m = st.match(/^set\s+(\w+)\s*=\s*(.+)$/); vars[m[1]] = jEval(m[2], vars); continue; }
        continue;
      }
      if (t.startsWith('{{')) { const v = jEval(t.slice(2, -2), vars); if (v && v.__undef) throw new Error(`'${v.__undef}' is undefined`); outS += typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''); pos++; continue; }
      outS += t; pos++;
    }
    return { out: outS, end: null };
  }
  return block([]).out;
}
const renderDeep = (v, vars) => typeof v === 'string' ? jRender(v, vars) : Array.isArray(v) ? v.map(x => renderDeep(x, vars)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, vars)])) : v;

// ---------------------------------------------------------------- inventory
const scalar = v => v === 'true' || v === 'True' ? true : v === 'false' || v === 'False' ? false : /^\d+$/.test(v) ? Number(v) : v.replace(/^["']|["']$/g, '');
export function parseInventory(text, path = 'inventory') {
  const inv = { groups: { all: { hosts: [], vars: {}, children: [] }, ungrouped: { hosts: [], vars: {}, children: [] } }, hosts: {} };
  const group = n => (inv.groups[n] = inv.groups[n] || { hosts: [], vars: {}, children: [] });
  const addHost = (name, vars, g) => {
    const m = name.match(/^(.*)\[(\d+):(\d+)\](.*)$/);
    const names = m ? Array.from({ length: Number(m[3]) - Number(m[2]) + 1 }, (_, k) => `${m[1]}${String(Number(m[2]) + k).padStart(m[2].length, '0')}${m[4]}`) : [name];
    for (const n of names) { inv.hosts[n] = { ...(inv.hosts[n] || {}), ...vars }; if (!group(g).hosts.includes(n)) group(g).hosts.push(n); }
  };
  if (/^\s*all\s*:/m.test(text) || /\.ya?ml$/.test(path)) {
    const doc = parseYaml(text) || {};
    const walk = (name, g) => { group(name); for (const [h, v] of Object.entries(g?.hosts || {})) addHost(h, v || {}, name); Object.assign(group(name).vars, g?.vars || {}); for (const [cn, cg] of Object.entries(g?.children || {})) { if (!group(name).children.includes(cn)) group(name).children.push(cn); walk(cn, cg); } };
    for (const [n, g] of Object.entries(doc)) walk(n, g);
  } else {
    let cur = 'ungrouped', mode = 'hosts';
    for (const raw of text.split('\n')) {
      const l = raw.replace(/\s*[#;].*$/, '').trim();
      if (!l) continue;
      const sec = l.match(/^\[([^\]:]+)(?::(vars|children))?\]$/);
      if (sec) { cur = sec[1]; mode = sec[2] || 'hosts'; group(cur); continue; }
      if (mode === 'vars') { const m = l.match(/^([\w.]+)\s*=\s*(.*)$/); if (m) group(cur).vars[m[1]] = scalar(m[2]); continue; }
      if (mode === 'children') { group(l); if (!group(cur).children.includes(l)) group(cur).children.push(l); continue; }
      const [h, ...kvs] = l.split(/\s+/);
      addHost(h, Object.fromEntries(kvs.map(kv => { const k = kv.indexOf('='); return [kv.slice(0, k), scalar(kv.slice(k + 1))]; })), cur);
    }
  }
  return inv;
}
function groupHosts(inv, g, seen = new Set()) {
  if (seen.has(g)) return [];
  seen.add(g);
  if (g === 'all') return Object.keys(inv.hosts);
  const grp = inv.groups[g];
  if (!grp) return [];
  return [...new Set([...grp.hosts, ...grp.children.flatMap(c => groupHosts(inv, c, seen))])];
}
export function selectHosts(inv, pattern) {
  let out = [];
  for (const part of String(pattern).split(/[:,]/).filter(Boolean)) {
    if (part.startsWith('!')) { const ex = new Set(inv.groups[part.slice(1)] ? groupHosts(inv, part.slice(1)) : [part.slice(1)]); out = out.filter(h => !ex.has(h)); continue; }
    if (part.startsWith('&')) { const keep = new Set(groupHosts(inv, part.slice(1))); out = out.filter(h => keep.has(h)); continue; }
    if (part === 'all' || part === '*') out.push(...Object.keys(inv.hosts));
    else if (inv.groups[part]) out.push(...groupHosts(inv, part));
    else if (inv.hosts[part]) out.push(part);
    else if (part.includes('*')) { const re = new RegExp('^' + part.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'); out.push(...Object.keys(inv.hosts).filter(h => re.test(h))); }
  }
  return [...new Set(out)];
}
function hostGroupVars(inv, h) {
  const vars = { ...inv.groups.all.vars };
  for (const [g, grp] of Object.entries(inv.groups)) if (g !== 'all' && groupHosts(inv, g).includes(h)) Object.assign(vars, grp.vars);
  return { ...vars, ...inv.hosts[h] };
}

// ---------------------------------------------------------------- connecting
function sshPubs(c, keyFile) {
  const home = c.host.users.get(c.user)?.home || '/root';
  const keys = keyFile ? [c.resolve(String(keyFile).replace(/^~/, home))] : ['id_ed25519', 'id_rsa', 'id_ecdsa'].map(k => `${home}/.ssh/${k}`);
  const out = [];
  for (const k of keys) { const t = c.host.files.get(k); if (!t) continue; const pub = c.host.files.get(k + '.pub') || (() => { for (const line of t.split('\n')) { try { const d = atob(line.trim()); if (d.startsWith('pub:')) return d.slice(4); } catch { /* not base64 */ } } return null; })(); if (pub) out.push(pub.trim().split(/\s+/).slice(0, 2).join(' ')); }
  return out;
}
function reach(c, hv, name) {
  const addr = hv.ansible_host || name;
  const user = hv.ansible_user || hv.ansible_ssh_user || c.cfg.remote_user || c.user;
  const port = Number(hv.ansible_port || 22);
  const r = connect(c.uni, c.host, String(addr), port);
  if (r.error) return { unreachable: true, msg: r.error === 'ENOTFOUND' ? `Failed to connect to the host via ssh: ssh: Could not resolve hostname ${addr}: Name or service not known` : r.error === 'ETIMEDOUT' ? `Failed to connect to the host via ssh: ssh: connect to host ${r.ip || addr} port ${port}: Connection timed out` : `Failed to connect to the host via ssh: ssh: connect to host ${r.ip || addr} port ${port}: Connection refused` };
  const target = r.host;
  const tu = target.users.get(user);
  const ak = tu ? target.files.get(`${tu.home}/.ssh/authorized_keys`) || '' : '';
  const pubs = sshPubs(c, hv.ansible_ssh_private_key_file || c.cfg.private_key_file);
  if (!tu || !pubs.some(p => ak.includes(p))) return { unreachable: true, msg: `Failed to connect to the host via ssh: ${user}@${addr}: Permission denied (publickey).` };
  if (!target.packages.has('python3') && !target.binaries?.has('python3')) return { failed: true, msg: 'The module failed to execute correctly, you probably need to set the interpreter.\nSee stdout/stderr for the exact error', module_stderr: '/bin/sh: 1: /usr/bin/python3: not found' };
  return { host: target, user };
}

// ---------------------------------------------------------------- modules
const DIFF = (before, after, path) => ({ before, after, path });
function writeTracked(ctx, path, content, { owner, group, mode } = {}) {
  const h = ctx.host;
  const cur = h.files.get(path);
  const st = h.stat(path);
  const metaChange = (owner && st?.owner !== owner) || (mode !== undefined && st && (st.mode & 0o7777) !== parseMode(mode));
  const changed = cur !== content || metaChange || !st;
  if (changed && !ctx.check) {
    if (!dirExists(h, dirname(path))) return { failed: true, msg: `Destination directory ${dirname(path)} does not exist` };
    if (!ctx.root && !canWrite(h, ctx.user, path)) return { failed: true, msg: `Destination ${dirname(path)} not writable` };
    h.writeFile(path, content, owner || ctx.user);
    if (owner || group) h.setMeta(path, { ...(owner ? { owner } : {}), ...(group ? { group } : {}) });
    if (mode !== undefined) h.setMeta(path, { mode: parseMode(mode) });
  }
  return { changed, diff: cur !== content ? DIFF(cur ?? '', content, path) : null, dest: path };
}
const dirExists = (h, d) => h.isDir(d);
const canWrite = (h, user, path) => { const d = h.stat(dirname(path)); const f = h.stat(path); const t = f || d; if (!t) return false; if (user === 'root') return true; if (t.owner === user) return !!(t.mode & 0o200); return !!(t.mode & 0o002); };
const parseMode = m => typeof m === 'number' ? (m > 0o7777 ? parseInt(String(m), 8) : (String(m).length >= 3 && /^[0-7]+$/.test(String(m)) ? parseInt(String(m), 8) : m)) : parseInt(String(m).replace(/^0o/, ''), 8);

function runShell(ctx, cmd, { chdir } = {}) {
  const sh = new Session(ctx.uni, ctx.host, { user: ctx.root ? 'root' : ctx.user, cwd: chdir || ctx.host.users.get(ctx.root ? 'root' : ctx.user)?.home || '/' });
  sh.advancePerCommand = 0;
  const mark = ctx.uni.events.length;
  const r = sh.run(cmd, { record: false });
  ctx.uni.events.length = mark;
  const lines = r.out.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
  return { rc: r.code, stdout: lines.join('\n'), stdout_lines: lines, stderr: '' };
}

const MODULES = {
  ping: () => ({ changed: false, ping: 'pong' }),
  setup: ctx => ({ changed: false, ansible_facts: facts(ctx) }),
  debug: (ctx, a) => ({ changed: false, msg: a.var !== undefined ? undefined : a.msg ?? 'Hello world!', ...(a.var !== undefined ? { [a.var]: (() => { try { const v = jEval(a.var, ctx.vars); return v && v.__undef ? 'VARIABLE IS NOT DEFINED!' : v; } catch { return 'VARIABLE IS NOT DEFINED!'; } })() } : {}) }),
  set_fact: (ctx, a) => { Object.assign(ctx.facts, a); return { changed: false, ansible_facts: a }; },
  fail: (ctx, a) => ({ failed: true, msg: a.msg || 'Failed as requested from task' }),
  assert: (ctx, a) => { for (const cond of [].concat(a.that || [])) { const v = jEval(String(cond), ctx.vars); if (!v || v.__undef) return { failed: true, assertion: cond, evaluated_to: false, msg: a.fail_msg || a.msg || 'Assertion failed' }; } return { changed: false, msg: a.success_msg || 'All assertions passed' }; },
  command: (ctx, a) => { const cmd = a._raw || a.cmd || (a.argv || []).join(' '); if (a.creates && ctx.host.stat(a.creates)) return { changed: false, skipped_reason: `${a.creates} exists`, rc: 0, stdout: `skipped, since ${a.creates} exists` }; if (a.removes && !ctx.host.stat(a.removes)) return { changed: false, rc: 0, stdout: `skipped, since ${a.removes} does not exist` }; if (ctx.check) return { changed: true, skipped: false, msg: 'Command would have run if not in check mode' }; const bin = cmd.trim().split(/\s+/)[0]; if (ctx.shell === false && /[|<>&;$]/.test(cmd)) { /* command module does not use a shell */ } const r = runShell(ctx, cmd, a); return { changed: true, cmd, ...r, ...(r.rc ? { failed: true, msg: 'non-zero return code' } : {}), bin }; },
  apt(ctx, a) {
    const names = [].concat(a.name || a.pkg || []).flatMap(n => String(n).split(',')).map(s => s.trim()).filter(Boolean);
    if (!ctx.root) return { failed: true, msg: `'/usr/bin/apt-get -y install ${names.join(' ')}' failed: E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n`, rc: 100 };
    let changed = false;
    if (a.update_cache) { ctx.host.aptUpdated = true; }
    const state = a.state || 'present';
    for (const n of names) {
      if (!CATALOG[n] && !UBUNTU_BASE.includes(n)) return { failed: true, msg: `No package matching '${n}' is available` };
      const has = ctx.host.packages.has(n);
      if ((state === 'present' || state === 'latest') && !has) { changed = true; if (!ctx.check) installPkg(ctx.host, ctx.uni, n, []); }
      if (state === 'absent' && has) { changed = true; if (!ctx.check) ctx.host.packages.delete(n); }
    }
    return { changed, ...(changed ? { stdout: `Reading package lists...\nSetting up ${names.join(' ')} ...` } : {}) };
  },
  copy(ctx, a) {
    if (!a.dest) return { failed: true, msg: 'missing required arguments: dest' };
    let content = a.content;
    if (content === undefined) { const t = ctx.readLocal(a.src, 'files'); if (t === null) return { failed: true, msg: `Could not find or access '${a.src}'\nSearched in:\n\t${ctx.base}/files/${a.src}\n\t${ctx.base}/${a.src}\non the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option` }; content = t; }
    if (typeof content !== 'string') content = JSON.stringify(content);
    const dest = a.dest.endsWith('/') ? a.dest + basename(a.src || 'file') : a.dest;
    return writeTracked(ctx, dest, content, { owner: a.owner, group: a.group, mode: a.mode });
  },
  template(ctx, a) {
    const t = ctx.readLocal(a.src, 'templates');
    if (t === null) return { failed: true, msg: `Could not find or access '${a.src}'\nSearched in:\n\t${ctx.base}/templates/${a.src}\n\t${ctx.base}/${a.src}\non the Ansible Controller.` };
    let content;
    try { content = jRender(t, { ...ctx.vars }); } catch (e) { return { failed: true, msg: `AnsibleUndefinedVariable: ${e.message}. ${e.message}` }; }
    return writeTracked(ctx, a.dest, String(content), { owner: a.owner, group: a.group, mode: a.mode });
  },
  file(ctx, a) {
    const p = a.path || a.dest || a.name;
    const h = ctx.host;
    const st = h.stat(p);
    const state = a.state || (st ? (st.type === 'dir' ? 'directory' : 'file') : 'file');
    let changed = false;
    if (state === 'directory') { if (!st) { changed = true; if (!ctx.check) h.mkdirMeta(p, a.owner || ctx.user, a.mode !== undefined ? parseMode(a.mode) : 0o755); } }
    else if (state === 'absent') { if (st) { changed = true; if (!ctx.check) { if (st.type === 'dir') { for (const k of [...h.files.keys()]) if (k.startsWith(p + '/')) h.removeFile(k); for (const d of [...h.dirs]) if (d === p || d.startsWith(p + '/')) h.dirs.delete(d); } else h.removeFile(p); } } return { changed, path: p, state: 'absent' }; }
    else if (state === 'touch') { changed = true; if (!ctx.check && !st) h.writeFile(p, '', a.owner || ctx.user); }
    else if (state === 'link') { const cur = h.links?.get(p); if (cur !== a.src) { changed = true; if (!ctx.check) { h.links.set(p, a.src); } } }
    else if (state === 'file' && !st) return { failed: true, msg: `file (${p}) is absent, cannot continue`, path: p };
    const st2 = h.stat(p);
    if (st2 && !ctx.check) {
      if (a.owner && st2.owner !== a.owner) { changed = true; h.setMeta(p, { owner: a.owner }); }
      if (a.group && st2.group !== a.group) { changed = true; h.setMeta(p, { group: a.group }); }
      if (a.mode !== undefined && (st2.mode & 0o7777) !== parseMode(a.mode)) { changed = true; h.setMeta(p, { mode: parseMode(a.mode) }); }
    }
    return { changed, path: p, state };
  },
  lineinfile(ctx, a) {
    const p = a.path || a.dest;
    const h = ctx.host;
    let text = h.files.get(p);
    if (text === undefined) { if (!a.create) return { failed: true, rc: 257, msg: `Destination ${p} does not exist !` }; text = ''; }
    const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
    const re = a.regexp ? new RegExp(a.regexp) : null;
    let out = [...lines];
    if ((a.state || 'present') === 'absent') out = lines.filter(l => !(re ? re.test(l) : l === a.line));
    else {
      const idx = re ? lines.map((l, k) => re.test(l) ? k : -1).filter(k => k >= 0).pop() : lines.indexOf(a.line);
      if (idx !== undefined && idx >= 0) out[idx] = a.line; else out.push(a.line);
    }
    const nt = out.join('\n') + '\n';
    return writeTracked(ctx, p, nt, {});
  },
  user(ctx, a) {
    const h = ctx.host;
    if (!ctx.root) return { failed: true, msg: 'useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.\n' };
    const ex = h.users.get(a.name);
    if ((a.state || 'present') === 'absent') { if (ex && !ctx.check) { h.users.delete(a.name); h.syncPasswd(); } return { changed: !!ex, name: a.name }; }
    let changed = false;
    if (!ex) { changed = true; if (!ctx.check) h.addUser(a.name, { shell: a.shell || '/bin/bash', noHome: a.create_home === false, uid: a.uid }); }
    const groups = [].concat(a.groups || []).flatMap(g => String(g).split(',')).map(s => s.trim()).filter(Boolean);
    for (const g of groups) { if (!h.groups.has(g)) return { failed: true, msg: `Group ${g} does not exist` }; if (!h.userGroups(a.name).includes(g)) { changed = true; if (!ctx.check) h.addToGroup(a.name, g); } }
    if (a.shell && ex && ex.shell !== a.shell) { changed = true; if (!ctx.check) { ex.shell = a.shell; h.syncPasswd(); } }
    return { changed, name: a.name };
  },
  group(ctx, a) { const h = ctx.host; if (h.groups.has(a.name)) return { changed: false }; if (!ctx.check) h.addGroup(a.name); return { changed: true, name: a.name }; },
  service(ctx, a) {
    const h = ctx.host;
    const unit = a.name.endsWith('.service') ? a.name : a.name + '.service';
    if (!h.files.has(`/etc/systemd/system/${unit}`) && !h.files.has(`/lib/systemd/system/${unit}`)) return { failed: true, msg: `Could not find the requested service ${a.name}: host` };
    if (!ctx.root) return { failed: true, msg: `Unable to start service ${a.name}: Failed to start ${unit}: Interactive authentication required.` };
    const st = unitState(h, unit);
    let changed = false;
    if (a.daemon_reload && !ctx.check) st.loadedText = h.files.get(`/etc/systemd/system/${unit}`) || st.loadedText;
    if (a.enabled !== undefined && !!st.enabled !== !!a.enabled) { changed = true; if (!ctx.check) st.enabled = !!a.enabled; }
    if (a.state === 'started' && st.active !== 'active') { changed = true; if (!ctx.check) { const r = startUnit(h, ctx.uni, unit); if (!r.ok) return { failed: true, msg: `Unable to start service ${a.name}: Job for ${unit} failed because the control process exited with error code.\nSee "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.\n` }; } }
    if (a.state === 'stopped' && st.active === 'active') { changed = true; if (!ctx.check) stopUnit(h, ctx.uni, unit); }
    if (a.state === 'restarted') { changed = true; if (!ctx.check) { stopUnit(h, ctx.uni, unit); const r = startUnit(h, ctx.uni, unit); if (!r.ok) return { failed: true, msg: `Unable to restart service ${a.name}: Job for ${unit} failed because the control process exited with error code.` }; } }
    if (a.state === 'reloaded') { changed = true; if (!ctx.check) { if (a.name === 'nginx') { const sh = runShell(ctx, 'nginx -s reload'); if (sh.rc) return { failed: true, msg: `Unable to reload service nginx: ${sh.stdout}` }; } } }
    return { changed, name: a.name, state: a.state };
  },
  ufw(ctx, a) {
    const fw = ctx.host.firewall;
    if (!ctx.root) return { failed: true, msg: 'ERROR: You need to be root to run this script' };
    let changed = false;
    if (a.rule) { const port = Number(a.port); if (!fw.rules.some(r => r.action === a.rule && r.port === port)) { changed = true; if (!ctx.check) fw.rules.push({ action: a.rule, port, proto: a.proto || 'tcp', from: a.from_ip || a.src || 'any' }); } }
    if (a.state === 'enabled' && !fw.enabled) { changed = true; if (!ctx.check) fw.enabled = true; }
    if (a.state === 'disabled' && fw.enabled) { changed = true; if (!ctx.check) fw.enabled = false; }
    if (a.policy) { const want = a.policy === 'allow' ? 'allow' : 'deny'; if (fw.defaultIn !== want) { changed = true; if (!ctx.check) fw.defaultIn = want; } }
    return { changed };
  },
  uri(ctx, a) {
    const r = httpRequest(ctx.uni, ctx.host, a.url, { method: a.method || 'GET' });
    const want = [].concat(a.status_code ?? 200).map(Number);
    if (r.error) return { failed: true, msg: `Status code was -1 and not [${want}]: Request failed: <urlopen error [Errno 111] Connection refused>`, status: -1 };
    if (!want.includes(r.status)) return { failed: true, msg: `Status code was ${r.status} and not [${want}]: HTTP Error ${r.status}`, status: r.status };
    return { changed: false, status: r.status, content: a.return_content ? r.body : undefined };
  },
  wait_for(ctx, a) {
    const host = a.host || '127.0.0.1';
    for (let t = 0; t < Number(a.timeout || 300); t += 5) { const r = connect(ctx.uni, ctx.host, host, Number(a.port)); if (!r.error) return { changed: false, port: a.port, elapsed: t }; ctx.uni.advance(5); }
    return { failed: true, msg: `Timeout when waiting for ${host}:${a.port}`, elapsed: Number(a.timeout || 300) };
  },
  stat(ctx, a) { const st = ctx.host.stat(a.path); return { changed: false, stat: st ? { exists: true, isdir: st.type === 'dir', mode: '0' + (st.mode & 0o7777).toString(8), pw_name: st.owner, size: (ctx.host.files.get(a.path) || '').length } : { exists: false } }; },
};
MODULES.shell = (ctx, a) => MODULES.command(ctx, a);
MODULES.package = MODULES.apt;
MODULES.systemd = MODULES.service;
MODULES.raw = (ctx, a) => MODULES.command(ctx, a);
MODULES['ansible.builtin.systemd_service'] = MODULES.service;

function facts(ctx) {
  const h = ctx.host;
  return { hostname: h.name, fqdn: h.name, os_family: 'Debian', distribution: 'Ubuntu', distribution_version: '24.04', distribution_release: 'noble', architecture: 'x86_64', default_ipv4: { address: h.cloudInstance?.private_ip || h.ip }, memtotal_mb: h.memMB, processor_vcpus: h.cpus, python_version: '3.12.3', user_id: ctx.user, env: { HOME: h.users.get(ctx.user)?.home } };
}

// ---------------------------------------------------------------- playbooks
const banner = (label, w = 79) => { const s = `${label} `; return s + '*'.repeat(Math.max(3, w - s.length)); };
const MOD_KEYS = new Set([...Object.keys(MODULES), 'include_tasks', 'import_tasks', 'block', 'meta']);
const TASK_KEYS = new Set(['name', 'when', 'loop', 'with_items', 'register', 'notify', 'become', 'become_user', 'tags', 'ignore_errors', 'changed_when', 'failed_when', 'vars', 'loop_control', 'delegate_to', 'run_once', 'no_log', 'check_mode', 'rescue', 'always', 'listen', 'environment', 'args']);
const modOf = t => Object.keys(t).find(k => !TASK_KEYS.has(k));
const shortMod = m => m.replace(/^ansible\.(builtin|posix|community\.general)\./, '').replace(/^community\.general\./, '').replace(/^ansible\.posix\./, '');

function parseArgsString(s) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|'([^']*)'|\S+)/g;
  let m, last = 0, free = [];
  while ((m = re.exec(s))) { free.push(s.slice(last, m.index)); out[m[1]] = m[3] ?? m[4] ?? m[2]; last = re.lastIndex; }
  free.push(s.slice(last));
  const raw = free.join(' ').trim();
  if (raw) out._raw = raw;
  return out;
}

class Runner {
  constructor(c, { inv, extraVars = {}, check = false, diff = false, limit = null, tags = null, verbose = 0, base, vaultPass = null }) {
    Object.assign(this, { c, inv, extraVars, check, diff, limit, tags, verbose, base, vaultPass });
    this.uni = c.uni;
    this.stats = {};
    this.lines = [];
    this.hostFacts = {};
    this.registered = {};
    this.failedHosts = new Set();
    this.unreachable = new Set();
  }
  out(...l) { this.lines.push(...l); }
  stat(h) { return (this.stats[h] = this.stats[h] || { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 }); }
  readLocal(base, rel, sub) {
    if (rel === undefined || rel === null) return null;
    const h = this.c.host;
    for (const p of [rel.startsWith('/') ? rel : null, `${base}/${sub}/${rel}`, `${base}/${rel}`, `${this.base}/${sub}/${rel}`, `${this.base}/${rel}`].filter(Boolean)) { const t = h.files.get(normPath(p)); if (t !== undefined) return t; }
    return null;
  }
  loadYaml(path, what = 'file') {
    const t = this.c.host.files.get(path);
    if (t === undefined) throw new AnsErr(`ERROR! Unable to retrieve file contents\nCould not find or access '${path}' on the Ansible Controller.`);
    if (/^\$ANSIBLE_VAULT/.test(t)) {
      if (!this.vaultPass) throw new AnsErr(`ERROR! Attempting to decrypt but no vault secrets found`);
      const plain = vaultDecrypt(t, this.vaultPass);
      if (plain === null) throw new AnsErr(`ERROR! Decryption failed (no vault secrets were found that could decrypt) on ${path}`);
      return parseYamlSafe(plain, path);
    }
    return parseYamlSafe(t, path, what);
  }

  varsFor(h, play, extra = {}) {
    const hv = hostGroupVars(this.inv, h);
    const fileVars = {};
    for (const dirName of ['group_vars', 'host_vars']) {
      const dir = `${this.base}/${dirName}`;
      const names = dirName === 'host_vars' ? [h] : ['all', ...Object.keys(this.inv.groups).filter(g => g !== 'all' && groupHosts(this.inv, g).includes(h))];
      for (const n of names) for (const p of [`${dir}/${n}.yml`, `${dir}/${n}.yaml`, `${dir}/${n}/main.yml`, `${dir}/${n}/vault.yml`]) if (this.c.host.files.has(p)) Object.assign(fileVars, this.loadYaml(p) || {});
    }
    const groups = Object.fromEntries(Object.keys(this.inv.groups).map(g => [g, groupHosts(this.inv, g)]));
    const hostvars = Object.fromEntries(Object.keys(this.inv.hosts).map(n => [n, { ...hostGroupVars(this.inv, n), ...(this.hostFacts[n] ? { ansible_facts: this.hostFacts[n] } : {}), inventory_hostname: n }]));
    const f = this.hostFacts[h];
    return { ...(play?.roleDefaults || {}), ...hv, ...fileVars, ...(play?.vars || {}), ...(play?.varsFiles || {}), ...(f ? { ansible_facts: f, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [`ansible_${k}`, v])) } : {}), ...(this.registered[h] || {}), ...extra, ...this.extraVars, inventory_hostname: h, inventory_hostname_short: h.split('.')[0], groups, hostvars, group_names: Object.keys(groups).filter(g => g !== 'all' && groups[g].includes(h)), ansible_check_mode: this.check, playbook_dir: this.base };
  }

  runTask(task, hosts, play, { handler = false, roleBase = null } = {}) {
    const mod = modOf(task);
    if (!mod) throw new AnsErr(`ERROR! no module/action detected in task.\n\nThe error appears to be in '${play.file}': line ?, column 3\n\nThe offending line appears to be:\n\n  - name: ${task.name || ''}\n    ^ here`);
    if (mod === 'include_tasks' || mod === 'import_tasks') {
      const p = normPath((roleBase || this.base) + '/' + (roleBase ? 'tasks/' : '') + task[mod]);
      const sub = this.loadYaml(this.c.host.files.has(p) ? p : normPath(this.base + '/' + task[mod])) || [];
      for (const t of sub) this.runTask({ ...t, when: [task.when, t.when].filter(Boolean).join(' and ') || undefined }, hosts.filter(h => !this.failedHosts.has(h)), play, { roleBase });
      return;
    }
    if (mod === 'block') { for (const t of task.block) this.runTask({ ...t, when: [task.when, t.when].filter(Boolean).join(' and ') || undefined, become: t.become ?? task.become }, hosts, play, { roleBase }); return; }
    if (mod === 'meta') { if (task.meta === 'flush_handlers') this.flushHandlers(play); return; }
    const short = shortMod(mod);
    if (!MODULES[short]) throw new AnsErr(`ERROR! couldn't resolve module/action '${mod}'. This often indicates a misspelling, missing collection, or incorrect module path.\n\nThe error appears to be in '${play.file}': line ?, column 7`);
    if (this.tags && !(task.tags ? [].concat(task.tags) : []).some(t => this.tags.includes(t)) && !(play.tags || []).some(t => this.tags.includes(t))) return;
    const title = task.name ? jRenderSafe(task.name, this.varsFor(hosts[0] || '', play)) : short;
    this.out('', banner(`${handler ? 'RUNNING HANDLER' : 'TASK'} [${roleBase ? basename(roleBase) + ' : ' : ''}${title}]`));
    for (const h of hosts) {
      if (this.failedHosts.has(h) || this.unreachable.has(h)) continue;
      const vars = this.varsFor(h, play, task.vars || {});
      const conn = this.conns[h];
      const become = task.become ?? play.become ?? false;
      const ctx = { uni: this.uni, host: conn.host, user: conn.user, root: !!become && (task.become_user || play.become_user || 'root') === 'root', check: this.check || task.check_mode === true, vars, facts: this.registered[h] = this.registered[h] || {}, base: roleBase || this.base, readLocal: (rel, sub) => this.readLocal(roleBase || this.base, rel, sub) };
      const loop = task.loop ?? task.with_items;
      const items = loop === undefined ? [undefined] : (() => { const v = typeof loop === 'string' ? jRender(loop, vars) : renderDeep(loop, vars); return Array.isArray(v) ? v : [v]; })();
      const results = [];
      let anyChanged = false, anyFailed = false, allSkipped = true;
      for (const item of items) {
        const iv = item === undefined ? vars : { ...vars, item, [task.loop_control?.loop_var || 'item']: item };
        const itemLabel = item === undefined ? '' : ` => (item=${typeof item === 'object' ? JSON.stringify(item) : item})`;
        if (task.when !== undefined) {
          let ok;
          try { ok = [].concat(task.when).every(w => { const v = typeof w === 'boolean' ? w : jEval(String(w).replace(/^\{\{\s*|\s*\}\}$/g, ''), iv); if (v && v.__undef) throw new Error(`'${v.__undef}' is undefined`); return !!v; }); }
          catch (e) { this.out(C.red(`fatal: [${h}]: FAILED! => {"msg": "The conditional check '${task.when}' failed. The error was: error while evaluating conditional (${task.when}): ${e.message}"}`)); this.stat(h).failed++; this.failedHosts.add(h); anyFailed = true; break; }
          if (!ok) { this.out(C.cyan(`skipping: [${h}]${itemLabel}`)); results.push({ skipped: true, changed: false }); continue; }
        }
        allSkipped = false;
        let args = task[mod];
        if (typeof args === 'string') args = parseArgsString(args);
        else args = { ...(args || {}) };
        if (task.args) Object.assign(args, task.args);
        let r;
        try { args = renderDeep(args, iv); }
        catch (e) { r = { failed: true, msg: `The task includes an option with an undefined variable. The error was: ${e.message}` }; }
        if (!r) { const mctx = { ...ctx, vars: iv }; r = MODULES[short](mctx, args); }
        if (task.changed_when !== undefined) { r.changed = [].concat(task.changed_when).every(w => { const v = typeof w === 'boolean' ? w : jEval(String(w), { ...iv, ...r, [task.register || '__r']: r }); return !!v && !v.__undef; }); }
        if (task.failed_when !== undefined) { r.failed = [].concat(task.failed_when).some(w => { const v = typeof w === 'boolean' ? w : jEval(String(w), { ...iv, ...r, [task.register || '__r']: r }); return !!v && !v.__undef; }); }
        results.push(r);
        if (r.failed) {
          anyFailed = true;
          const body = JSON.stringify(Object.fromEntries(Object.entries({ changed: !!r.changed, msg: r.msg, rc: r.rc, stderr: r.stderr || undefined, stdout: r.stdout || undefined }).filter(([, v]) => v !== undefined)));
          this.out(C.red(`${item === undefined ? 'fatal' : 'failed'}: [${h}]${itemLabel ? itemLabel.replace(' => ', ' ') : ''}: FAILED! => ${body}`));
          if (task.ignore_errors) { this.out(C.cyan('...ignoring')); }
          continue;
        }
        if (r.changed) anyChanged = true;
        const label = this.check && r.changed && ['command', 'shell'].includes(short) ? 'skipping' : r.changed ? 'changed' : 'ok';
        const colour = label === 'changed' ? C.yellow : label === 'skipping' ? C.cyan : C.green;
        let extraOut = '';
        if (short === 'debug') extraOut = ` => ${JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'changed')), null, 4)}`;
        else if (this.verbose && (r.stdout !== undefined || r.ping)) extraOut = ` => ${JSON.stringify(r)}`;
        this.out(colour(`${label}: [${h}]${itemLabel}${extraOut}`));
        if (this.diff && r.diff && r.changed) this.out(...renderDiff(r.diff));
      }
      if (anyFailed && !task.ignore_errors) { this.stat(h).failed++; this.failedHosts.add(h); }
      else if (anyFailed) { this.stat(h).ignored++; this.stat(h).ok++; }
      else if (allSkipped && results.length) this.stat(h).skipped++;
      else { this.stat(h).ok++; if (anyChanged) this.stat(h).changed++; }
      if (task.register) this.registered[h][task.register] = items.length === 1 && loop === undefined ? (results[0] || { skipped: true }) : { changed: anyChanged, results };
      if (anyChanged && task.notify && !this.check) for (const n of [].concat(task.notify)) { (this.notified[n] = this.notified[n] || new Set()).add(h); }
      if (anyChanged && task.notify && this.check) for (const n of [].concat(task.notify)) { (this.notified[n] = this.notified[n] || new Set()).add(h); }
    }
  }

  flushHandlers(play) {
    for (const hd of play.handlers || []) {
      const names = [hd.name, ...[].concat(hd.listen || [])];
      const hs = new Set(names.flatMap(n => [...(this.notified[n] || [])]));
      if (!hs.size) continue;
      this.runTask(hd, [...hs], play, { handler: true, roleBase: hd.__roleBase });
      for (const n of names) delete this.notified[n];
    }
  }

  runPlay(play) {
    const pattern = play.hosts;
    let hosts = selectHosts(this.inv, pattern);
    if (this.limit) { const lim = new Set(selectHosts(this.inv, this.limit)); hosts = hosts.filter(h => lim.has(h)); }
    this.out('', banner(`PLAY [${play.name || pattern}]`));
    if (!hosts.length) { this.out(C.yellow('skipping: no hosts matched')); return; }
    this.notified = {};
    this.conns = {};
    // connect (and gather facts)
    const gather = play.gather_facts !== false;
    if (gather) this.out('', banner('TASK [Gathering Facts]'));
    for (const h of hosts) {
      const hv = this.varsFor(h, play);
      const r = reach(this.c, renderDeep(hv, hv), h);
      if (r.unreachable || r.failed) {
        this.out(C.red(`fatal: [${h}]: ${r.unreachable ? 'UNREACHABLE' : 'FAILED'}! => ${JSON.stringify({ changed: false, msg: r.msg, unreachable: r.unreachable || undefined })}`));
        if (r.unreachable) { this.unreachable.add(h); this.stat(h).unreachable++; } else { this.failedHosts.add(h); this.stat(h).failed++; }
        continue;
      }
      this.conns[h] = r;
      if (gather) { this.hostFacts[h] = facts({ host: r.host, user: r.user }); this.out(C.green(`ok: [${h}]`)); this.stat(h).ok++; }
    }
    const live = hosts.filter(h => this.conns[h]);
    // roles
    play.roleDefaults = {};
    const roleTasks = [];
    for (const r of play.roles || []) {
      const name = typeof r === 'string' ? r : r.role || r.name;
      const rb = `${this.base}/roles/${name}`;
      if (!this.c.host.isDir(rb)) throw new AnsErr(`ERROR! the role '${name}' was not found in ${this.base}/roles:${this.base}\n\nThe error appears to be in '${play.file}': line ?, column 7`);
      const load = p => this.c.host.files.has(p) ? this.loadYaml(p) : null;
      Object.assign(play.roleDefaults, load(`${rb}/defaults/main.yml`) || {}, load(`${rb}/vars/main.yml`) || {}, typeof r === 'object' ? r.vars || Object.fromEntries(Object.entries(r).filter(([k]) => !['role', 'name'].includes(k))) : {});
      for (const t of load(`${rb}/tasks/main.yml`) || []) roleTasks.push([t, rb]);
      for (const hd of load(`${rb}/handlers/main.yml`) || []) (play.handlers = play.handlers || []).push({ ...hd, __roleBase: rb });
    }
    for (const t of play.pre_tasks || []) this.runTask(t, live, play);
    for (const [t, rb] of roleTasks) this.runTask(t, live, play, { roleBase: rb });
    for (const t of play.tasks || []) this.runTask(t, live, play);
    for (const t of play.post_tasks || []) this.runTask(t, live, play);
    this.flushHandlers(play);
  }

  recap() {
    this.out('', banner('PLAY RECAP'));
    for (const [h, s] of Object.entries(this.stats)) {
      const col = s.failed || s.unreachable ? C.red : s.changed ? C.yellow : C.green;
      this.out(`${col(h.padEnd(26))} : ${C.green(`ok=${s.ok}`.padEnd(4))}    ${(s.changed ? C.yellow : x => x)(`changed=${s.changed}`.padEnd(8))}    ${(s.unreachable ? C.red : x => x)(`unreachable=${s.unreachable}`)}    ${(s.failed ? C.red : x => x)(`failed=${s.failed}`)}    ${(s.skipped ? C.cyan : x => x)(`skipped=${s.skipped}`)}    rescued=${s.rescued}    ignored=${s.ignored}   `);
    }
    this.out('');
  }
}
class AnsErr extends Error {}
const jRenderSafe = (s, v) => { try { return jRender(s, v); } catch { return s; } };
function parseYamlSafe(text, path, what) {
  try { return parseYaml(text); }
  catch (e) { throw new AnsErr(`ERROR! We were unable to read either as JSON nor YAML, these are the errors we got from each:\nJSON: Expecting value: line 1 column 1 (char 0)\n\nSyntax Error while loading YAML.\n  ${e.message}\n\nThe error appears to be in '${path}'`); }
}
function renderDiff(d) {
  const a = (d.before || '').split('\n'), b = (d.after || '').split('\n');
  const L = [C.red(`--- before: ${d.path}`), C.green(`+++ after: ${d.path}`)];
  try {
    const ops = diffLines(a, b);
    L.push(C.cyan(`@@ -1,${a.length} +1,${b.length} @@`));
    for (const op of ops) { if (op.op === '-') L.push(C.red('-' + a[op.a])); else if (op.op === '+') L.push(C.green('+' + b[op.b])); else L.push(' ' + a[op.a]); }
  } catch { for (const l of a) if (!b.includes(l)) L.push(C.red('-' + l)); for (const l of b) if (!a.includes(l)) L.push(C.green('+' + l)); }
  L.push('');
  return L;
}

// ---------------------------------------------------------------- vault
const VAULT_HDR = '$ANSIBLE_VAULT;1.1;AES256';
export function vaultEncrypt(plain, pw) { const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ k: fakeHash(pw, 16), d: plain })))); const hex = [...payload].map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join(''); return VAULT_HDR + '\n' + hex.match(/.{1,80}/g).join('\n') + '\n'; }
export function vaultDecrypt(text, pw) {
  const hex = text.split('\n').slice(1).join('').trim();
  try { const payload = hex.match(/.{2}/g).map(x => String.fromCharCode(parseInt(x, 16))).join(''); const o = JSON.parse(decodeURIComponent(escape(atob(payload)))); return o.k === fakeHash(pw, 16) ? o.d : null; } catch { return null; }
}

// ---------------------------------------------------------------- CLI
function ansibleCfg(c) {
  const cfg = {};
  const t = c.host.files.get(c.resolve('ansible.cfg')) || c.host.files.get(`${c.host.users.get(c.user)?.home}/.ansible.cfg`);
  if (t) { let sec = ''; for (const l of t.split('\n')) { const s = l.match(/^\s*\[(\w+)\]/); if (s) { sec = s[1]; continue; } const m = l.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/); if (m && sec === 'defaults') cfg[m[1]] = m[2]; } }
  return cfg;
}
function cliOpts(args) {
  const o = { _: [], e: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const take = () => args[++i];
    if (a === '-i' || a === '--inventory') o.inventory = take();
    else if (a.startsWith('--inventory=')) o.inventory = a.slice(12);
    else if (a === '-m' || a === '--module-name') o.module = take();
    else if (a === '-a' || a === '--args') o.args = take();
    else if (a === '-b' || a === '--become') o.become = true;
    else if (a === '-u' || a === '--user') o.user = take();
    else if (a === '-l' || a === '--limit') o.limit = take();
    else if (a.startsWith('--limit=')) o.limit = a.slice(8);
    else if (a === '-e' || a === '--extra-vars') { const v = take(); if (/^\s*\{/.test(v)) Object.assign(o.e, JSON.parse(v)); else for (const kv of v.split(/\s+/)) { const k = kv.indexOf('='); o.e[kv.slice(0, k)] = kv.slice(k + 1); } }
    else if (a === '-C' || a === '--check') o.check = true;
    else if (a === '-D' || a === '--diff') o.diff = true;
    else if (a === '-t' || a === '--tags') o.tags = take().split(',');
    else if (a === '--syntax-check') o.syntax = true;
    else if (a === '--list-hosts') o.listHosts = true;
    else if (a === '--list-tasks') o.listTasks = true;
    else if (a === '--ask-vault-pass' || a === '-J') o.askVault = true;
    else if (a.startsWith('--vault-password-file')) o.vaultFile = a.includes('=') ? a.split('=')[1] : take();
    else if (/^-v+$/.test(a)) o.verbose = a.length - 1;
    else if (a === '--list' || a === '--graph' || a === '--host') o[a.slice(2)] = a === '--host' ? take() : true;
    else if (a === '-k' || a === '--ask-pass' || a === '-K' || a === '--ask-become-pass') o.askPass = true;
    else o._.push(a);
  }
  return o;
}
function loadInv(c, o) {
  const cfg = ansibleCfg(c);
  const p = o.inventory || cfg.inventory || '/etc/ansible/hosts';
  if (p.includes(',') && !c.host.files.has(c.resolve(p))) { const inv = parseInventory(''); for (const h of p.split(',').filter(Boolean)) { inv.hosts[h] = {}; inv.groups.ungrouped.hosts.push(h); } return { inv, cfg }; }
  const path = c.resolve(p);
  const text = c.host.files.get(path);
  if (text === undefined) return { inv: parseInventory(''), cfg, warn: [`[WARNING]: Unable to parse ${path} as an inventory source`, '[WARNING]: No inventory was parsed, only implicit localhost is available'] };
  return { inv: parseInventory(text, path), cfg };
}
const needsPython = c => { if (!c.host.packages.has('ansible')) return c.fail(`Command '${c.name}' not found, but can be installed with:\n  sudo apt install ansible`, 127); return null; };

def('ansible', c => {
  const o = cliOpts(c.args);
  const pattern = o._[0];
  if (!pattern) return c.fail('usage: ansible [-h] [--version] [-v] [-b] [--become-method BECOME_METHOD] ...\n                  pattern\nansible: error: the following arguments are required: pattern', 2);
  if (pattern === '--version') { c.print('ansible [core 2.17.5]'); return 0; }
  const { inv, cfg, warn } = loadInv(c, o);
  if (warn) c.eprint(...warn.map(w => C.yellow(w)));
  c.cfg = { ...cfg, remote_user: o.user || cfg.remote_user };
  const hosts = selectHosts(inv, pattern);
  if (!hosts.length) { c.eprint(C.yellow(`[WARNING]: Could not match supplied host pattern, ignoring: ${pattern}`), C.yellow('[WARNING]: No hosts matched, nothing to do')); return 0; }
  if (o.listHosts) { c.print(`  hosts (${hosts.length}):`, ...hosts.map(h => `    ${h}`)); return 0; }
  const mod = shortMod(o.module || 'command');
  if (!MODULES[mod]) return c.fail(`ERROR! couldn't resolve module/action '${o.module}'. This often indicates a misspelling, missing collection, or incorrect module path.`, 2);
  let rc = 0;
  const runner = new Runner(c, { inv, base: c.cwd, check: o.check, extraVars: o.e });
  for (const h of hosts) {
    const hv = hostGroupVars(inv, h);
    const conn = reach(c, hv, h);
    if (conn.unreachable || conn.failed) { c.print(C.red(`${h} | ${conn.unreachable ? 'UNREACHABLE' : 'FAILED'}! => ${JSON.stringify({ changed: false, msg: conn.msg, unreachable: conn.unreachable || undefined }, null, 4)}`)); rc = Math.max(rc, conn.unreachable ? 4 : 2); continue; }
    const args = mod === 'command' || mod === 'shell' || mod === 'raw' ? { _raw: o.args || '' } : parseArgsString(o.args || '');
    const ctx = { uni: c.uni, host: conn.host, user: conn.user, root: !!o.become, check: !!o.check, vars: runner.varsFor(h, null), facts: {}, base: c.cwd, readLocal: (rel, sub) => runner.readLocal(c.cwd, rel, sub) };
    const r = MODULES[mod](ctx, renderDeep(args, ctx.vars));
    const state = r.failed ? 'FAILED' : r.changed ? 'CHANGED' : 'SUCCESS';
    const colour = r.failed ? C.red : r.changed ? C.yellow : C.green;
    if ((mod === 'command' || mod === 'shell') && !r.failed) c.print(colour(`${h} | ${state} | rc=${r.rc} >>`), r.stdout || '');
    else if ((mod === 'command' || mod === 'shell')) c.print(colour(`${h} | FAILED | rc=${r.rc} >>`), r.stdout || '', `non-zero return code`);
    else c.print(colour(`${h} | ${state} => ${JSON.stringify(Object.fromEntries(Object.entries({ ansible_facts: mod === 'ping' ? { discovered_interpreter_python: '/usr/bin/python3' } : undefined, changed: !!r.changed, ...r, diff: undefined }).filter(([, v]) => v !== undefined)), null, 4)}`));
    if (r.failed) rc = 2;
  }
  c.uni.emit({ type: 'ansible', host: c.host.name, pattern, module: mod, args: o.args, become: !!o.become, rc, hosts });
  return rc;
}, { pkg: 'ansible' });

def('ansible-playbook', c => {
  const o = cliOpts(c.args);
  const pb = o._[0];
  if (!pb) return c.fail('usage: ansible-playbook [-h] [--version] [-v] [--private-key PRIVATE_KEY_FILE]\n                        playbook [playbook ...]\nansible-playbook: error: the following arguments are required: playbook', 2);
  const path = c.resolve(pb);
  const text = c.host.files.get(path);
  if (text === undefined) return c.fail(`ERROR! the playbook: ${pb} could not be found`, 1);
  const go = (vaultPass) => {
    const sink = [];
    const print = (...l) => sink.push(...l);
    let rc = 0;
    try {
      let plays;
      try { plays = parseYaml(text); } catch (e) { throw new AnsErr(`ERROR! We were unable to read either as JSON nor YAML, these are the errors we got from each:\nJSON: Expecting value: line 1 column 1 (char 0)\n\nSyntax Error while loading YAML.\n  ${e.message}\n\nThe error appears to be in '${path}': line ${e.line || '?'}, column 1, but may\nbe elsewhere in the file depending on the exact syntax problem.`); }
      if (!Array.isArray(plays)) throw new AnsErr(`ERROR! A playbook must be a list of plays, got a ${typeof plays} instead\n\nThe error appears to be in '${path}': line 1, column 1, but may\nbe elsewhere in the file depending on the exact syntax problem.`);
      for (const p of plays) {
        if (!p.hosts && !p.import_playbook) throw new AnsErr(`ERROR! the field 'hosts' is required but was not set`);
        for (const t of [...(p.tasks || []), ...(p.handlers || [])]) {
          const extra = Object.keys(t).filter(k => !TASK_KEYS.has(k) && !MOD_KEYS.has(k) && !MODULES[shortMod(k)]);
          const mods = Object.keys(t).filter(k => MOD_KEYS.has(k) || MODULES[shortMod(k)]);
          if (mods.length > 1) throw new AnsErr(`ERROR! conflicting action statements: ${mods.join(', ')}\n\nThe error appears to be in '${path}': line ?, column 7, but may\nbe elsewhere in the file depending on the exact syntax problem.\n\nThe offending line appears to be:\n\n  - name: ${t.name}\n    ^ here`);
          if (!mods.length && extra.length) throw new AnsErr(`ERROR! couldn't resolve module/action '${extra[0]}'. This often indicates a misspelling, missing collection, or incorrect module path.\n\nThe error appears to be in '${path}': line ?, column 7, but may\nbe elsewhere in the file depending on the exact syntax problem.\n\nThe offending line appears to be:\n\n  - name: ${t.name}\n    ^ here`);
          if (!mods.length) throw new AnsErr(`ERROR! no module/action detected in task.\n\nThe error appears to be in '${path}'`);
        }
      }
      if (o.syntax) { print('', `playbook: ${pb}`); c.uni.emit({ type: 'ansible-playbook', host: c.host.name, playbook: pb, syntax: true, ok: true }); return { rc: 0, sink }; }
      const { inv, cfg, warn } = loadInv(c, o);
      if (warn) print(...warn.map(w => C.yellow(w)));
      c.cfg = { ...cfg, remote_user: o.user || cfg.remote_user };
      const runner = new Runner(c, { inv, extraVars: o.e, check: o.check, diff: o.diff, limit: o.limit, tags: o.tags, verbose: o.verbose, base: dirname(path), vaultPass });
      for (const p of plays) {
        const play = { ...p, file: path, vars: renderDeep(p.vars || {}, { ...o.e }), varsFiles: {} };
        for (const vf of [].concat(p.vars_files || [])) Object.assign(play.varsFiles, runner.loadYaml(normPath(dirname(path) + '/' + vf)) || {});
        if (o.listHosts) { print('', `playbook: ${pb}`, '', `  play #1 (${p.hosts}): ${p.name || p.hosts}\tTAGS: []`, `    pattern: ['${p.hosts}']`, `    hosts (${selectHosts(inv, p.hosts).length}):`, ...selectHosts(inv, p.hosts).map(h => `      ${h}`)); continue; }
        runner.runPlay(play);
      }
      if (o.listHosts) return { rc: 0, sink };
      runner.recap();
      print(...runner.lines);
      const st = Object.values(runner.stats);
      rc = st.some(s => s.unreachable) ? 4 : st.some(s => s.failed) ? 2 : 0;
      c.uni.emit({ type: 'ansible-playbook', host: c.host.name, playbook: pb, check: !!o.check, diff: !!o.diff, rc, stats: runner.stats, limit: o.limit || null });
    } catch (e) {
      if (e instanceof AnsErr) { print(C.red(e.message)); c.uni.emit({ type: 'ansible-playbook', host: c.host.name, playbook: pb, rc: 1, error: e.message.split('\n')[0] }); return { rc: 1, sink }; }
      throw e;
    }
    return { rc, sink };
  };
  const needsVault = () => [...c.host.files.entries()].some(([p, t]) => p.startsWith(dirname(path) + '/') && /^\$ANSIBLE_VAULT/.test(t));
  if (o.vaultFile) { const pw = (c.host.files.get(c.resolve(o.vaultFile)) || '').trim(); const r = go(pw); c.print(...r.sink); return r.rc; }
  if (o.askVault) {
    c.result.ask = { prompt: 'Vault password:', secret: true, onAnswer(ans, { io }) { const r = go(ans.trim()); io.out(r.sink.join('\n') + '\n'); return r.rc; } };
    return 0;
  }
  void needsVault;
  const r = go(null);
  c.print(...r.sink);
  return r.rc;
}, { pkg: 'ansible' });

def('ansible-inventory', c => {
  const o = cliOpts(c.args);
  const { inv } = loadInv(c, o);
  if (o.graph) {
    const L = ['@all:'];
    const walk = (g, d) => { const grp = inv.groups[g]; for (const ch of grp.children) { L.push(`${'  |'.repeat(d)}--@${ch}:`); walk(ch, d + 1); } for (const h of grp.hosts) L.push(`${'  |'.repeat(d)}--${h}`); };
    const tops = Object.keys(inv.groups).filter(g => g !== 'all' && !Object.values(inv.groups).some(x => x.children.includes(g)) && (inv.groups[g].hosts.length || inv.groups[g].children.length));
    for (const g of tops) { L.push(`  |--@${g}:`); walk(g, 2); }
    c.print(...L);
    c.uni.emit({ type: 'ansible-inventory', host: c.host.name, graph: true });
    return 0;
  }
  if (o.host) { c.print(JSON.stringify(hostGroupVars(inv, o.host), null, 4)); return 0; }
  const outObj = { _meta: { hostvars: Object.fromEntries(Object.keys(inv.hosts).map(h => [h, hostGroupVars(inv, h)])) }, all: { children: ['ungrouped', ...Object.keys(inv.groups).filter(g => !['all', 'ungrouped'].includes(g) && !Object.values(inv.groups).some(x => x.children.includes(g)))] } };
  for (const [g, grp] of Object.entries(inv.groups)) if (!['all'].includes(g) && (grp.hosts.length || grp.children.length)) outObj[g] = { ...(grp.hosts.length ? { hosts: grp.hosts } : {}), ...(grp.children.length ? { children: grp.children } : {}) };
  c.print(...JSON.stringify(outObj, null, 4).split('\n'));
  c.uni.emit({ type: 'ansible-inventory', host: c.host.name, list: true });
  return 0;
}, { pkg: 'ansible' });

def('ansible-vault', c => {
  const [op, ...rest] = c.args;
  const files = rest.filter(a => !a.startsWith('-'));
  const vf = rest.find(a => a.startsWith('--vault-password-file'));
  const pwFile = vf ? (vf.includes('=') ? vf.split('=')[1] : rest[rest.indexOf(vf) + 1]) : null;
  const doIt = pw => {
    const L = [];
    for (const f of files.filter(x => x !== pwFile)) {
      const p = c.resolve(f);
      const t = c.host.files.get(p);
      if (t === undefined && op !== 'create') return { code: 1, L: [`ERROR! input is not vault encrypted data for ${f}`] };
      if (op === 'encrypt') { if (/^\$ANSIBLE_VAULT/.test(t)) return { code: 1, L: [`ERROR! input is already encrypted`] }; c.host.writeFile(p, vaultEncrypt(t, pw), c.user); L.push(C.green('Encryption successful')); }
      else if (op === 'decrypt' || op === 'view') { if (!/^\$ANSIBLE_VAULT/.test(t)) return { code: 1, L: [`ERROR! input is not vault encrypted data for ${f}`] }; const d = vaultDecrypt(t, pw); if (d === null) return { code: 1, L: [C.red('ERROR! Decryption failed (no vault secrets were found that could decrypt)')] }; if (op === 'view') L.push(...d.replace(/\n$/, '').split('\n')); else { c.host.writeFile(p, d, c.user); L.push(C.green('Decryption successful')); } }
    }
    c.uni.emit({ type: 'ansible-vault', host: c.host.name, op, files });
    return { code: 0, L };
  };
  if (!['encrypt', 'decrypt', 'view'].includes(op)) return c.fail('usage: ansible-vault [-h] [--version] [-v] {create,decrypt,edit,view,encrypt,encrypt_string,rekey} ...', 2);
  if (pwFile) { const r = doIt((c.host.files.get(c.resolve(pwFile)) || '').trim()); c.print(...r.L); return r.code; }
  const first = op === 'encrypt';
  c.result.ask = { prompt: first ? 'New Vault password:' : 'Vault password:', secret: true, onAnswer(pw, { io, result }) {
    if (!first) { const r = doIt(pw.trim()); io.out(r.L.join('\n') + '\n'); return r.code; }
    result.ask = { prompt: 'Confirm New Vault password:', secret: true, onAnswer(pw2, { io: io2 }) { if (pw2 !== pw) { io2.out('ERROR! Passwords do not match\n'); return 1; } const r = doIt(pw.trim()); io2.out(r.L.join('\n') + '\n'); return r.code; } };
    return 0;
  } };
  return 0;
}, { pkg: 'ansible' });

// a small ansible-lint: the rules AI-written playbooks break most often
def('ansible-lint', c => {
  const files = c.args.filter(a => !a.startsWith('-'));
  const targets = files.length ? files.map(f => c.resolve(f)) : [...c.host.files.keys()].filter(p => p.startsWith(c.cwd + '/') && /\.ya?ml$/.test(p) && !/inventory|group_vars|host_vars/.test(p));
  const found = [];
  for (const p of targets) {
    let doc;
    try { doc = parseYaml(c.host.files.get(p) || ''); } catch (e) { found.push(['syntax-check[unknown]', p, 1, e.message]); continue; }
    const rel = p.replace(c.cwd + '/', '');
    const tasks = Array.isArray(doc) ? doc.flatMap(pl => pl && typeof pl === 'object' ? [...(pl.tasks || []), ...(pl.handlers || []), ...(pl.hosts ? [] : [pl])] : []) : [];
    const lines = (c.host.files.get(p) || '').split('\n');
    const lineOf = t => { const n = t.name ? lines.findIndex(l => l.includes(`name: ${t.name}`)) : -1; return n >= 0 ? n + 1 : 1; };
    for (const t of tasks) {
      if (!t || typeof t !== 'object') continue;
      const m = modOf(t) || '';
      const s = shortMod(m);
      if (!t.name && !t.import_tasks && !t.include_tasks) found.push(['name[missing]', rel, lineOf(t), 'All tasks should be named.']);
      if (['command', 'shell'].includes(s) && t.changed_when === undefined && !(t[m]?.creates || t[m]?.removes || /creates=|removes=/.test(String(t[m])))) found.push(['no-changed-when', rel, lineOf(t), 'Commands should not change things if nothing needs doing.']);
      const cmd = String(typeof t[m] === 'object' ? t[m]?.cmd || '' : t[m] || '');
      if (['command', 'shell'].includes(s) && /\b(apt-get|apt|yum|systemctl|service|curl|wget|chmod|chown|mkdir|ln|useradd)\b/.test(cmd)) found.push(['command-instead-of-module', rel, lineOf(t), `${cmd.match(/\b(apt-get|apt|yum|systemctl|service|curl|wget|chmod|chown|mkdir|ln|useradd)\b/)[1]} used in place of ${/apt/.test(cmd) ? 'apt' : /systemctl|service/.test(cmd) ? 'systemd_service' : /curl|wget/.test(cmd) ? 'get_url or uri' : /chmod|chown|mkdir|ln/.test(cmd) ? 'file' : 'user'} module`]);
      if (s === 'shell' && !/[|<>&;$*]/.test(cmd)) found.push(['command-instead-of-shell', rel, lineOf(t), 'Use shell only when shell functionality is required.']);
      if (['apt', 'package'].includes(s) && t[m]?.state === 'latest') found.push(['package-latest', rel, lineOf(t), 'Package installs should not use latest.']);
      if (['copy', 'template', 'file'].includes(s) && typeof t[m] === 'object' && t[m].mode === undefined && (s !== 'file' || ['touch', 'directory'].includes(t[m].state))) found.push(['risky-file-permissions', rel, lineOf(t), 'File permissions unset or incorrect.']);
      if (m && !m.startsWith('ansible.') && MODULES[m]) found.push(['fqcn[action-core]', rel, lineOf(t), `Use FQCN for builtin module actions (${m}).`]);
      if (!t.no_log && typeof t[m] === 'object' && Object.entries(t[m] || {}).some(([k, v]) => /password|secret|token|content/i.test(k) && /password|secret|token/i.test(String(v)) && !/\{\{/.test(String(v)) && !String(v).startsWith('/')) || Object.entries(t.vars || {}).some(([k, v]) => /password|secret|token/i.test(k) && typeof v === 'string' && !/\{\{|vault/.test(v))) found.push(['no-log-password', rel, lineOf(t), 'Use no_log: true and a vaulted variable for secrets.']);
    }
  }
  for (const [rule, file, line, msg] of found) c.print(`${C.red(rule)}: ${msg}`, `${C.dim(`${file}:${line}`)} ${C.dim('Task/Handler: …')}`, '');
  const counts = found.reduce((m, f) => ({ ...m, [f[0]]: (m[f[0]] || 0) + 1 }), {});
  if (found.length) {
    c.print('Read documentation for instructions on how to ignore specific rule violations.', '', '# Rule Violation Summary', '', ...Object.entries(counts).map(([r, n]) => `  ${String(n).padStart(2)} ${r}`), '', C.red(`Failed: ${found.length} failure(s), 0 warning(s) on ${targets.length} files.`));
  } else c.print(C.green(`Passed: 0 failure(s), 0 warning(s) on ${targets.length} files. Last profile that met the validation criteria was 'production'.`));
  c.uni.emit({ type: 'ansible-lint', host: c.host.name, failures: found.length, rules: Object.keys(counts) });
  return found.length ? 2 : 0;
}, { pkg: 'ansible' });

export { MODULES, Runner };
