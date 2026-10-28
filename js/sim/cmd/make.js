// make and bats. make reads a Makefile (variables with = := ?= +=, rules with prerequisites,
// tab-indented recipes, .PHONY, $@ $< $^, $(shell …) and $(wildcard …)), rebuilds only what
// is out of date by modification time, runs each recipe line in its own shell, and reports
// errors the way GNU make does. bats runs @test blocks with `run`, $status and $output.

import { def } from '../registry.js';
import { normPath, dirname } from '../host.js';
import { cloneEnv } from '../session.js';
import { globToRegex } from '../bash.js';

class MakeError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }

export function parseMakefile(text, file = 'Makefile') {
  const vars = {}, rules = new Map(), phony = new Set();
  let order = [], cur = null;
  const lines = String(text).replace(/\\\n/g, ' ').split('\n');
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (raw.startsWith('\t')) {
      if (!cur) throw new MakeError(`${file}:${n}: *** recipe commences before first target.  Stop.`);
      cur.recipe.push({ line: raw.slice(1), n });
      return;
    }
    const line = raw.replace(/(^|[^\\])#.*$/, '$1').trimEnd();
    if (!line.trim()) { return; }
    if (/^\s+\S/.test(raw) && cur && !/[:=]/.test(line)) throw new MakeError(`${file}:${n}: *** missing separator (did you mean TAB instead of 8 spaces?).  Stop.`);
    const asg = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(\?=|:=|::=|\+=|=)\s*(.*)$/);
    if (asg) {
      cur = null;
      const [, k, op, v] = asg;
      if (op === '?=') { if (!(k in vars)) vars[k] = { v, lazy: true }; }
      else if (op === '+=') vars[k] = { v: `${vars[k]?.v ?? ''} ${v}`.trim(), lazy: vars[k]?.lazy ?? true };
      else vars[k] = { v, lazy: op === '=' };
      return;
    }
    const rule = line.match(/^([^:=]+?)\s*:(?!=)\s*(.*)$/);
    if (rule) {
      const targets = rule[1].trim().split(/\s+/);
      let [prereqs, inline] = rule[2].split(';');
      const deps = (prereqs || '').trim().split(/\s+/).filter(Boolean);
      if (targets[0] === '.PHONY') { for (const d of deps) phony.add(d); cur = null; return; }
      if (targets[0].startsWith('.')) { cur = null; return; }
      for (const t of targets) {
        const r = rules.get(t) || { target: t, deps: [], recipe: [], n };
        r.deps.push(...deps);
        if (inline !== undefined && inline.trim()) r.recipe.push({ line: inline.trim(), n });
        rules.set(t, r);
        if (!order.includes(t)) order.push(t);
      }
      cur = rules.get(targets[0]);
      if (targets.length > 1) cur = { recipe: rules.get(targets[0]).recipe };
      return;
    }
    throw new MakeError(`${file}:${n}: *** missing separator.  Stop.`);
  });
  return { vars, rules, phony, order };
}

def('make', c => {
  const args = [...c.args];
  let file = null, dir = c.cwd, dry = false, silent = false, keep = false, question = false;
  const targets = [], cli = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--file') { file = args[++i]; continue; }
    if (a === '-C' || a === '--directory') { dir = normPath(c.resolve(args[++i])); continue; }
    if (a === '-n' || a === '--dry-run' || a === '--just-print') { dry = true; continue; }
    if (a === '-s' || a === '--silent') { silent = true; continue; }
    if (a === '-k') { keep = true; continue; }
    if (a === '-q') { question = true; continue; }
    if (/^-j\d*$/.test(a)) continue;
    if (a === '--version' || a === '-v') { c.print('GNU Make 4.3', 'Built for x86_64-pc-linux-gnu'); return 0; }
    const m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) { cli[m[1]] = m[2]; continue; }
    targets.push(a);
  }
  const host = c.host;
  const mfPath = file ? normPath(dir + '/' + file) : ['GNUmakefile', 'makefile', 'Makefile'].map(f => `${dir}/${f}`).find(p => host.files.has(p));
  if (!mfPath || !host.files.has(mfPath)) return c.fail(file ? `make: ${file}: No such file or directory\nmake: *** No rule to make target '${file}'.  Stop.` : 'make: *** No targets specified and no makefile found.  Stop.', 2);
  const mfName = mfPath.split('/').pop();
  let mk;
  try { mk = parseMakefile(host.files.get(mfPath), mfName); } catch (e) { if (e instanceof MakeError) return c.fail(`${e.message}`, 2); throw e; }
  const runShell = (line, capture = false) => {
    const sub = cloneEnv(c.e, { child: true });
    sub.cwd = dir; sub.interactive = false;
    const chunks = [];
    const io = capture ? { in: null, out: s => chunks.push(s), err: () => {} } : c.io;
    const code = c.sh.runIn(line, sub, io, c.result);
    return capture ? chunks.join('').replace(/\n+$/, '').replace(/\n/g, ' ') : code;
  };
  const cache = {};
  const expand = (s, auto = {}, depth = 0) => {
    if (depth > 20) throw new MakeError(`make: *** Recursive variable references itself (eventually).  Stop.`);
    return String(s).replace(/\$\$/g, '\u0001').replace(/\$([@<^*?])/g, (m, k) => auto[k] ?? '').replace(/\$[({]([^)}]+)[)}]/g, (m, body) => {
      const fn = body.match(/^(shell|wildcard|notdir|basename|dir|subst|patsubst|strip|words)\s+([\s\S]*)$/);
      if (fn) {
        const arg = expand(fn[2], auto, depth + 1);
        if (fn[1] === 'shell') return runShell(arg, true);
        if (fn[1] === 'wildcard') return arg.split(/\s+/).filter(Boolean).flatMap(pat => { const re = globToRegex(pat); const base = dirname(normPath(dir + '/' + pat)); return [...host.files.keys(), ...host.dirs].filter(p => p.startsWith(dir + '/') && re.test(p.slice(dir.length + 1))).map(p => p.slice(dir.length + 1)).sort(); void base; }).join(' ');
        if (fn[1] === 'notdir') return arg.split(/\s+/).map(x => x.split('/').pop()).join(' ');
        if (fn[1] === 'dir') return arg.split(/\s+/).map(x => x.includes('/') ? x.slice(0, x.lastIndexOf('/') + 1) : './').join(' ');
        if (fn[1] === 'basename') return arg.split(/\s+/).map(x => x.replace(/\.[^./]*$/, '')).join(' ');
        if (fn[1] === 'strip') return arg.trim().replace(/\s+/g, ' ');
        if (fn[1] === 'words') return String(arg.split(/\s+/).filter(Boolean).length);
        if (fn[1] === 'subst' || fn[1] === 'patsubst') { const [from, to, text] = arg.split(','); if (fn[1] === 'subst') return text.split(from).join(to); const re = new RegExp('^' + from.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace('%', '(.*)') + '$'); return text.trim().split(/\s+/).map(w => w.replace(re, to.replace('%', '$1'))).join(' '); }
      }
      if (body in cli) return cli[body];
      if (mk.vars[body]) { if (!mk.vars[body].lazy) { if (!(body in cache)) cache[body] = expand(mk.vars[body].v, auto, depth + 1); return cache[body]; } return expand(mk.vars[body].v, auto, depth + 1); }
      return c.env[body] ?? '';
    }).replace(/\u0001/g, '$');
  };
  // target names are expanded when the makefile is read
  { const rules = new Map(); for (const [k, r] of mk.rules) for (const t of expand(k).split(/\s+/).filter(Boolean)) rules.set(t, r); mk.rules = rules; mk.order = mk.order.flatMap(t => expand(t).split(/\s+/)).filter(Boolean); mk.phony = new Set([...mk.phony].flatMap(t => expand(t).split(/\s+/))); }
  const mtime = p => { const st = host.stat(normPath(dir + '/' + p)); return st ? (st.mtime ?? 0) : null; };
  const goals = targets.length ? targets : [mk.order[0]];
  if (!goals[0]) return c.fail('make: *** No targets.  Stop.', 2);
  const built = new Map();
  let ranSomething = false, failed = false;
  const make = (t, chain = []) => {
    if (built.has(t)) return built.get(t);
    if (chain.includes(t)) { c.eprint(`make: Circular ${chain[chain.length - 1]} <- ${t} dependency dropped.`); return 0; }
    const r = mk.rules.get(t);
    if (!r) {
      if (mtime(t) !== null) { built.set(t, mtime(t)); return mtime(t); }
      throw new MakeError(chain.length ? `make: *** No rule to make target '${t}', needed by '${chain[chain.length - 1]}'.  Stop.` : `make: *** No rule to make target '${t}'.  Stop.`);
    }
    const deps = r.deps.flatMap(d => expand(d).split(/\s+/)).filter(Boolean);
    let newest = 0;
    for (const d of deps) { const tm = make(d, [...chain, t]); if (tm === 'fail') { built.set(t, 'fail'); return 'fail'; } newest = Math.max(newest, typeof tm === 'number' ? tm : 0); }
    const own = mk.phony.has(t) ? null : mtime(t);
    const stale = mk.phony.has(t) || own === null || deps.some(d => (built.get(d) === Infinity) || (mtime(d) ?? 0) > own) || newest > own;
    if (!stale) { built.set(t, own); return own; }
    const auto = { '@': t, '<': deps[0] || '', '^': [...new Set(deps)].join(' '), '*': t.replace(/\.[^.]*$/, ''), '?': deps.join(' ') };
    for (const step of r.recipe) {
      let line = expand(step.line, auto);
      let quiet = silent, ignore = false;
      while (/^[@+-]/.test(line)) { if (line[0] === '@') quiet = true; if (line[0] === '-') ignore = true; line = line.slice(1); }
      if (!line.trim()) continue;
      ranSomething = true;
      if (dry) { c.print(line); continue; }
      if (!quiet) c.print(line);
      const code = runShell(line);
      if (code !== 0) {
        if (ignore) { c.eprint(`make: [${mfName}:${step.n}: ${t}] Error ${code} (ignored)`); continue; }
        c.eprint(`make: *** [${mfName}:${step.n}: ${t}] Error ${code}`);
        failed = true; built.set(t, 'fail');
        return 'fail';
      }
    }
    const after = mk.phony.has(t) ? Infinity : (mtime(t) ?? Infinity);
    built.set(t, after);
    return after;
  };
  let ranAny = false;
  for (const g of goals) {
    ranSomething = false;
    try { const r = make(g); if (r === 'fail' && !keep) break; }
    catch (e) { if (e instanceof MakeError) { c.uni.emit({ type: 'make', host: host.name, dir, goals, ok: false, dry }); return c.fail(e.message, 2); } throw e; }
    ranAny = ranAny || ranSomething;
    if (!ranSomething && !failed) c.print(mk.phony.has(g) || !mtime(g) ? `make: Nothing to be done for '${g}'.` : `make: '${g}' is up to date.`);
  }
  if (question) return failed ? 2 : 0;
  c.uni.emit({ type: 'make', host: host.name, dir, goals, ok: !failed, dry, vars: cli, ran: ranAny });
  return failed ? 2 : 0;
}, { pkg: 'make' });

// ---------------------------------------------------------------- bats
function parseBats(text) {
  const lines = String(text).split('\n');
  const tests = [], top = [];
  let setup = null, teardown = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^@test\s+(["'])(.*)\1\s*\{\s*$/);
    const fm = lines[i].match(/^(setup|teardown)\s*\(\)\s*\{\s*$/);
    if (m || fm) {
      const body = [];
      let depth = 1, j = i + 1;
      for (; j < lines.length; j++) { const l = lines[j]; depth += (l.match(/\{\s*$/) ? 1 : 0) - (l.trim() === '}' || /^\s*\}\s*$/.test(l) ? 1 : 0); if (depth === 0) break; body.push({ text: l, n: j + 1 }); }
      if (m) tests.push({ name: m[2], body, n: i + 1 }); else if (fm[1] === 'setup') setup = body; else teardown = body;
      i = j;
      continue;
    }
    if (!/^\s*load\b/.test(lines[i])) top.push(lines[i]);
  }
  return { tests, setup, teardown, top: top.join('\n') };
}
const SIMPLE = /^\s*(if|then|else|elif|fi|for|while|until|do|done|case|esac|\{|\}|function\b|\w+\s*\(\)|#)/;
function instrument(body) {
  let depth = 0;
  return body.map(({ text, n }) => {
    const t = text.trim();
    if (!t) return '';
    const opens = /^(if|for|while|until|case)\b/.test(t) && !/\b(fi|done|esac)\s*;?\s*$/.test(t);
    const closes = /^(fi|done|esac)\b/.test(t);
    let line = text;
    const run = t.match(/^run\s+(.*)$/);
    if (run) line = `set +e; output="$(${run[1]} 2>&1)"; status=$?; set -e`;
    if (depth === 0 && !SIMPLE.test(t) && !opens && !/\\$/.test(t)) line = `${line} || { echo "__BATS_FAIL__ ${n} ${t.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}" >&2; exit 1; }`;
    if (opens) depth++;
    if (closes) depth = Math.max(0, depth - 1);
    return line;
  }).join('\n');
}

def('bats', c => {
  const paths = c.args.filter(a => !a.startsWith('-'));
  if (!paths.length) return c.fail('Error: Must specify at least one <test>', 1);
  const files = [];
  for (const p of paths) {
    const abs = c.resolve(p);
    if (c.host.isDir(abs)) files.push(...[...c.host.files.keys()].filter(f => f.startsWith(abs + '/') && f.endsWith('.bats')).sort());
    else if (c.host.files.has(abs)) files.push(abs);
    else return c.fail(`bats: ${p} does not exist`, 1);
  }
  let total = 0, failures = 0;
  const results = [];
  for (const f of files) {
    const spec = parseBats(c.host.files.get(f));
    const rel = f.startsWith(c.cwd + '/') ? f.slice(c.cwd.length + 1) : f;
    if (files.length > 1 || true) c.print(rel.split('/').pop());
    for (const t of spec.tests) {
      total++;
      const env = cloneEnv(c.e, { child: true });
      env.cwd = c.cwd; env.interactive = false;
      c.sh.setVar(env, 'BATS_TEST_DIRNAME', dirname(f), { exported: true });
      c.sh.setVar(env, 'BATS_TEST_FILENAME', f, { exported: true });
      c.sh.setVar(env, 'BATS_TMPDIR', '/tmp', { exported: true });
      const script = ['set -e', spec.top, spec.setup ? instrument(spec.setup) : '', instrument(t.body)].join('\n');
      const chunks = [];
      const io = { in: null, out: s => chunks.push(s), err: s => chunks.push(s) };
      let code;
      try { code = c.sh.runScript(script, env, io, { name: f, result: { editor: null } }); } catch (e) { code = 1; chunks.push(String(e.message || e)); }
      if (spec.teardown) { try { c.sh.runScript(instrument(spec.teardown), env, { in: null, out: () => {}, err: () => {} }, { name: f, result: { editor: null } }); } catch { /* teardown errors are ignored */ } }
      const out = chunks.join('');
      const failLine = out.match(/__BATS_FAIL__ (\d+) (.*)/);
      if (code === 0) { c.print(` ✓ ${t.name}`); results.push({ name: t.name, ok: true }); continue; }
      failures++;
      results.push({ name: t.name, ok: false });
      c.print(` ✗ ${t.name}`, `   (in test file ${rel}, line ${failLine ? failLine[1] : t.n})`, `     \`${failLine ? failLine[2] : 'test'}' failed${failLine ? '' : ` with status ${code}`}`);
      for (const l of out.split('\n').filter(x => x && !x.startsWith('__BATS_FAIL__')).slice(0, 8)) c.print(`   ${l}`);
    }
  }
  c.print('', `${total} test${total === 1 ? '' : 's'}, ${failures} failure${failures === 1 ? '' : 's'}`);
  c.uni.emit({ type: 'bats', host: c.host.name, files, total, failures, results });
  return failures ? 1 : 0;
}, { pkg: 'bats' });
