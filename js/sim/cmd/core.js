// Core file and system-information commands: ls, cat, cp, mv, rm, mkdir, chmod, chown,
// find, stat, du, df, free, date, env, which, tree, tar, sleep, seq, base64, sha256sum…

import { def, opts, registry, commandAvailable } from '../registry.js';
import { fsx, modeString, humanSize, parseMode, normPath, dirname, basename } from '../fsx.js';
import { SimError } from '../host.js';
import { access } from '../session.js';
import { C, stripAnsi } from '../../git/world.js';
import { globToRegex, parse as parseBash } from '../bash.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function lsTime(ts, now) {
  const d = new Date(ts * 1000);
  const recent = Math.abs(now - ts) < 182 * 86400;
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${recent ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : ' ' + d.getUTCFullYear()}`;
}

export function fmtDate(ts, fmt) {
  const d = new Date(ts * 1000);
  if (!fmt) return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
  return fmt.replace(/%([a-zA-Z%])/g, (_, k) => ({
    Y: d.getUTCFullYear(), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), H: pad(d.getUTCHours()), M: pad(d.getUTCMinutes()), S: pad(d.getUTCSeconds()),
    y: pad(d.getUTCFullYear() % 100), b: MONTHS[d.getUTCMonth()], a: DAYS[d.getUTCDay()], s: ts, F: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    T: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`, Z: 'UTC', z: '+0000', j: pad(Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000), 3), '%': '%',
  })[k] ?? '%' + k);
}

const fileSize = (host, p, st) => host.fakeSizes?.get(p) ?? st.size;

// ---------- ls ----------
def(['ls', 'dir'], c => {
  const o = opts(c.args, { bool: 'lahrtRS1dFi', val: [], alias: { '--all': '-a', '--human-readable': '-h', '--recursive': '-R' } });
  const f = fsx(c);
  const targets = o._.length ? o._ : ['.'];
  let code = 0;
  const showAll = o['-a'];
  const entriesOf = (p) => {
    const a = f.abs(p);
    let list = f.list(p).map(([n]) => n);
    if (!showAll) list = list.filter(n => !n.startsWith('.'));
    else list = ['.', '..', ...list];
    let items = list.map(n => { const ap = n === '.' ? a : n === '..' ? dirname(a) : (a === '/' ? '/' + n : a + '/' + n); return { n, ap, st: o['-l'] ? (c.host.lstat(ap) || c.host.stat(ap)) : (c.host.stat(ap) || c.host.lstat(ap)) }; }).filter(x => x.st);
    if (o['-t']) items.sort((x, y) => y.st.mtime - x.st.mtime);
    if (o['-S']) items.sort((x, y) => fileSize(c.host, y.ap, y.st) - fileSize(c.host, x.ap, x.st));
    if (o['-r']) items.reverse();
    return items;
  };
  const color = (n, st) => st.type === 'link' ? C.cyan(C.bold(n)) + (o['-l'] ? ` -> ${st.target}` : '') : st.type === 'dir' ? C.blue(C.bold(n)) + (o['-F'] ? '/' : '') : (st.mode & 0o111) ? C.green(C.bold(n)) + (o['-F'] ? '*' : '') : n;
  const long = (items, withTotal = true) => {
    const total = items.reduce((s, x) => s + Math.ceil(fileSize(c.host, x.ap, x.st) / 4096) * 4, 0);
    if (withTotal) c.print(`total ${total}`);
    const rows = items.map(x => {
      const size = fileSize(c.host, x.ap, x.st);
      return [modeString(x.st), x.st.type === 'dir' ? '2' : '1', x.st.owner, x.st.group, o['-h'] ? humanSize(size) : String(size), lsTime(x.st.mtime, c.uni.time), color(x.n, x.st)];
    });
    const w = [0, 1, 2, 3, 4].map(k => Math.max(...rows.map(r => r[k].length)));
    for (const r of rows) c.print(`${r[0]} ${r[1].padStart(w[1])} ${r[2].padEnd(w[2])} ${r[3].padEnd(w[3])} ${r[4].padStart(w[4])} ${r[5]} ${r[6]}`);
  };
  const short = (items) => { if (!items.length) return; c.print(items.map(x => color(x.n, x.st)).join(o['-1'] || c.inPipe ? '\n' : '  ')); };
  const files = [], dirs = [];
  for (const t of targets) {
    const st = f.stat(t);
    if (!st) { c.eprint(`ls: cannot access '${t}': No such file or directory`); code = 2; continue; }
    if (st.type === 'dir' && !o['-d']) dirs.push(t); else files.push({ n: t, ap: f.abs(t), st });
  }
  if (files.length) { if (o['-l']) long(files, false); else short(files); }
  const showHeaders = targets.length > 1 || o['-R'];
  const visit = (d, first) => {
    let items;
    try { items = entriesOf(d); } catch (e) { c.eprint(e.message); code = 2; return; }
    if (showHeaders) { if (!first || files.length) c.print(''); c.print(`${d}:`); }
    (o['-l'] ? long : short)(items);
    if (o['-R']) for (const x of items) if (x.st.type === 'dir' && x.n !== '.' && x.n !== '..') visit(d === '/' ? '/' + x.n : `${d.replace(/\/$/, '')}/${x.n}`, false);
  };
  dirs.forEach((d, k) => visit(d, k === 0));
  return code;
});

def('tree', c => {
  const o = opts(c.args, { bool: 'adf', val: ['-L', '-I'] });
  const f = fsx(c);
  const root = o._[0] || '.';
  if (!f.isDir(root)) return c.fail(`${root} [error opening dir]`, 2);
  const max = o['-L'] ? Number(o['-L']) : Infinity;
  const ignore = o['-I'] ? globToRegex(o['-I']) : null;
  let nd = 0, nf = 0;
  c.print(C.blue(C.bold(root)));
  const walk = (p, prefix, depth) => {
    if (depth > max) return;
    let items = c.host.listDir(f.abs(p)).filter(([n]) => (o['-a'] || !n.startsWith('.')) && !(ignore && ignore.test(n)));
    if (o['-d']) items = items.filter(([, k]) => k === 'dir');
    items.forEach(([n, kind], k) => {
      const last = k === items.length - 1;
      c.print(prefix + (last ? '└── ' : '├── ') + (kind === 'dir' ? C.blue(C.bold(n)) : n));
      if (kind === 'dir') { nd++; walk(p + '/' + n, prefix + (last ? '    ' : '│   '), depth + 1); } else nf++;
    });
  };
  walk(root, '', 1);
  c.print('', `${nd} director${nd === 1 ? 'y' : 'ies'}${o['-d'] ? '' : `, ${nf} file${nf === 1 ? '' : 's'}`}`);
  return 0;
}, { pkg: 'tree' });

// ---------- cat & friends ----------
def(['cat', 'less', 'more', 'most'], c => {
  const o = opts(c.args, { bool: 'nAsE', val: [] });
  const f = fsx(c);
  if (!o._.length) { c.out(c.stdin ?? ''); return 0; }
  let code = 0, n = 0;
  for (const p of o._) {
    try {
      let t = f.read(p);
      if (o['-n']) t = t.replace(/\n$/, '').split('\n').map(l => `${String(++n).padStart(6)}\t${l}`).join('\n') + '\n';
      if (o['-A'] || o['-E']) t = t.replace(/\n/g, '$\n');
      c.out(t);
    } catch (e) { c.eprint(e.message); code = 1; }
  }
  return code;
});

def('tac', c => { const f = fsx(c); const t = c.args.length ? c.args.map(p => f.read(p)).join('') : (c.stdin ?? ''); c.out(t.replace(/\n$/, '').split('\n').reverse().join('\n') + '\n'); return 0; });
def('nl', c => { const f = fsx(c); const t = c.args.length ? f.read(c.args[c.args.length - 1]) : (c.stdin ?? ''); let n = 0; c.out(t.replace(/\n$/, '').split('\n').map(l => l.trim() ? `${String(++n).padStart(6)}\t${l}` : '').join('\n') + '\n'); return 0; });
def('rev', c => { const t = c.args.length ? fsx(c).read(c.args[0]) : (c.stdin ?? ''); c.out(t.replace(/\n$/, '').split('\n').map(l => [...l].reverse().join('')).join('\n') + '\n'); return 0; });

function linesOf(text) { const t = text ?? ''; if (!t) return []; const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; }

def('head', c => {
  const o = opts(c.args, { bool: 'qv', val: ['-n', '-c', '--lines', '--bytes'], alias: { '--lines': '-n', '--bytes': '-c' } });
  const f = fsx(c);
  const n = o.num ?? (o['-n'] !== undefined ? Number(o['-n']) : 10);
  const files = o._.length ? o._ : ['-'];
  let code = 0;
  files.forEach((p, k) => {
    try {
      const t = f.read(p);
      if (files.length > 1) c.print(`${k ? '\n' : ''}==> ${p} <==`);
      if (o['-c']) { c.out(t.slice(0, Number(o['-c']))); return; }
      const l = linesOf(t);
      const sel = n < 0 ? l.slice(0, n) : l.slice(0, n);
      if (sel.length) c.print(...sel);
    } catch (e) { c.eprint(e.message.replace(/^head: /, 'head: cannot open ').replace(/: No such/, "' for reading: No such").replace("cannot open ", "cannot open '")); code = 1; }
  });
  return code;
});

def('tail', c => {
  const o = opts(c.args, { bool: 'fFq', val: ['-n', '-c', '--lines'], alias: { '--lines': '-n', '--follow': '-f' } });
  const f = fsx(c);
  let spec = o.num !== undefined ? String(o.num) : (o['-n'] ?? '10');
  const files = o._.length ? o._ : ['-'];
  let code = 0;
  files.forEach((p, k) => {
    try {
      const t = f.read(p);
      if (files.length > 1) c.print(`${k ? '\n' : ''}==> ${p} <==`);
      const l = linesOf(t);
      const sel = String(spec).startsWith('+') ? l.slice(Number(spec.slice(1)) - 1) : l.slice(Math.max(0, l.length - Number(spec)));
      if (sel.length) c.print(...sel);
    } catch (e) { c.eprint(`tail: cannot open '${p}' for reading: ${/denied/.test(e.message) ? 'Permission denied' : 'No such file or directory'}`); code = 1; }
  });
  if (o['-f'] || o['-F']) c.eprint(C.dim('(tail -f keeps watching in a real terminal; here it shows what is there now. Run it again to see new lines.)'));
  return code;
});

def('touch', c => {
  const o = opts(c.args, { bool: 'ac', val: ['-d', '-t'] });
  const f = fsx(c);
  let code = 0;
  for (const p of o._) {
    try {
      const a = f.abs(p);
      if (c.host.stat(a)) { if (!access(c.host, c.user, a, 'w') && c.host.stat(a).owner !== c.user) throw new SimError(`touch: cannot touch '${p}': Permission denied`); c.host.setMeta(a, { mtime: c.uni.time }); }
      else if (!o['-c']) f.write(p, '');
    } catch (e) { c.eprint(e.message.replace(/^touch: [^:]*: No such/, `touch: cannot touch '${p}': No such`)); code = 1; }
  }
  return code;
});

def('mkdir', c => {
  const o = opts(c.args, { bool: 'pv', val: ['-m'], alias: { '--parents': '-p' } });
  const f = fsx(c);
  if (!o._.length) return c.fail('mkdir: missing operand\nTry \'mkdir --help\' for more information.');
  let code = 0;
  for (const p of o._) {
    try { f.mkdir(p, { parents: o['-p'], mode: o['-m'] ? parseInt(o['-m'], 8) : 0o755 }); if (o['-v']) c.print(`mkdir: created directory '${p}'`); } catch (e) { c.eprint(e.message); code = 1; }
  }
  return code;
});

def('rmdir', c => {
  const f = fsx(c);
  let code = 0;
  for (const p of c.args.filter(a => !a.startsWith('-'))) {
    if (!f.isDir(p)) { c.eprint(`rmdir: failed to remove '${p}': ${f.exists(p) ? 'Not a directory' : 'No such file or directory'}`); code = 1; continue; }
    if (c.host.listDir(f.abs(p)).length) { c.eprint(`rmdir: failed to remove '${p}': Directory not empty`); code = 1; continue; }
    try { f.remove(p, { recursive: true }); } catch (e) { c.eprint(e.message); code = 1; }
  }
  return code;
});

def('rm', c => {
  const o = opts(c.args, { bool: 'rRfivd', val: [], alias: { '--recursive': '-r', '--force': '-f' } });
  const f = fsx(c);
  if (!o._.length) return o['-f'] ? 0 : c.fail("rm: missing operand\nTry 'rm --help' for more information.");
  let code = 0;
  for (const p of o._) {
    if (['/', '/*'].includes(p) && !c.args.includes('--no-preserve-root')) { c.eprint("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe"); code = 1; continue; }
    try { f.remove(p, { recursive: o['-r'] || o['-R'], force: o['-f'] }); if (o['-v']) c.print(`removed '${p}'`); } catch (e) { c.eprint(e.message); code = 1; }
  }
  return code;
});

function copyTree(c, f, src, dst, { move = false, recursive = false, preserve = false } = {}) {
  const host = c.host;
  const sa = f.abs(src);
  const st = host.stat(sa);
  if (!st) throw new SimError(`${c.name}: cannot stat '${src}': No such file or directory`);
  let da = f.abs(dst);
  if (host.stat(da)?.type === 'dir') da = normPath(da + '/' + basename(sa));
  if (da === sa || da.startsWith(sa + '/')) throw new SimError(`${c.name}: cannot ${move ? 'move' : 'copy'} a directory, '${src}', into itself, '${dst}'`);
  if (st.type === 'dir') {
    if (!recursive && !move) throw new SimError(`cp: -r not specified; omitting directory '${src}'`);
    const parent = dirname(da);
    if (!host.isDir(parent)) throw new SimError(`${c.name}: cannot create directory '${dst}': No such file or directory`);
    if (!access(host, c.user, parent, 'w')) throw new SimError(`${c.name}: cannot create directory '${dst}': Permission denied`);
    host.mkdirMeta(da, c.user, st.mode);
    for (const p of [...host.files.keys()].filter(p => p.startsWith(sa + '/'))) {
      const np = da + p.slice(sa.length);
      host.writeFile(np, host.files.get(p), c.user);
      const m = host.meta.get(p);
      if (m) host.meta.set(np, { ...m, owner: preserve || move ? m.owner : c.user, mtime: c.uni.time });
    }
    for (const d of [...host.dirs].filter(d => d.startsWith(sa + '/'))) host.mkdirMeta(da + d.slice(sa.length), c.user);
    if (move) { if (host.repos.has(sa)) { const r = host.repos.get(sa); host.repos.delete(sa); r.root = da; host.repos.set(da, r); } f.remove(src, { recursive: true }); }
    return;
  }
  if (!access(host, c.user, sa, 'r')) throw new SimError(`${c.name}: cannot open '${src}' for reading: Permission denied`);
  const content = host.files.get(sa);
  const m = host.meta.get(sa);
  const parent = dirname(da);
  if (!host.isDir(parent)) throw new SimError(`${c.name}: cannot create regular file '${dst}': No such file or directory`);
  if (host.stat(da) ? !access(host, c.user, da, 'w') : !access(host, c.user, parent, 'w')) throw new SimError(`${c.name}: cannot create regular file '${dst}': Permission denied`);
  host.writeFile(da, content, c.user);
  if (m) host.meta.set(da, { ...m, owner: preserve || move ? m.owner : c.user, group: preserve || move ? m.group : host.newMeta(c.user, 0).group, mtime: move || preserve ? m.mtime : c.uni.time });
  if (move) f.remove(src);
}

def('cp', c => {
  const o = opts(c.args, { bool: 'rRapfvn', val: [] });
  const f = fsx(c);
  if (o._.length < 2) return c.fail(`cp: missing destination file operand after '${o._[0] || ''}'`);
  const dst = o._.pop();
  if (o._.length > 1 && !f.isDir(dst)) return c.fail(`cp: target '${dst}' is not a directory`);
  let code = 0;
  for (const s of o._) { try { copyTree(c, f, s, dst, { recursive: o['-r'] || o['-R'] || o['-a'], preserve: o['-a'] || o['-p'] }); if (o['-v']) c.print(`'${s}' -> '${dst}'`); } catch (e) { c.eprint(e.message); code = 1; } }
  return code;
});

def('mv', c => {
  const o = opts(c.args, { bool: 'fivn', val: [] });
  const f = fsx(c);
  if (o._.length < 2) return c.fail(`mv: missing destination file operand after '${o._[0] || ''}'`);
  const dst = o._.pop();
  if (o._.length > 1 && !f.isDir(dst)) return c.fail(`mv: target '${dst}' is not a directory`);
  let code = 0;
  for (const s of o._) {
    try {
      const sa = f.abs(s);
      if (!access(c.host, c.user, dirname(sa), 'w')) throw new SimError(`mv: cannot move '${s}' to '${dst}': Permission denied`);
      copyTree(c, f, s, dst, { move: true });
      if (o['-v']) c.print(`renamed '${s}' -> '${dst}'`);
    } catch (e) { c.eprint(e.message); code = 1; }
  }
  return code;
});

def('ln', c => {
  const o = opts(c.args, { bool: 'sfnvT', val: [] });
  const f = fsx(c);
  const [target, link] = o._;
  if (!target) return c.fail('ln: missing file operand');
  if (!o['-s']) return c.fail(C.dim('(hard links are not simulated: use ln -s for a symbolic link)'), 1);
  let la = link ? f.abs(link) : f.abs(basename(target));
  // ln -s target dir/  creates dir/basename(target), unless -n/-T and the link already exists
  if (c.host.isDir(la) && !c.host.isLink(la) && !(o['-T'])) la = normPath(la + '/' + basename(target));
  else if (c.host.isLink(la) && c.host.isDir(la) && !o['-n'] && !o['-T']) la = normPath(c.host.realPath(la) + '/' + basename(target));
  if (c.host.lstat(la)) {
    if (!o['-f']) return c.fail(`ln: failed to create symbolic link '${link || basename(target)}': File exists`);
    if (c.host.lstat(la).type === 'dir') return c.fail(`ln: cannot overwrite directory '${link}'`);
    c.host.removeFile(la);
  }
  const parent = dirname(la);
  if (!c.host.isDir(parent)) return c.fail(`ln: failed to create symbolic link '${link}': No such file or directory`);
  if (!access(c.host, c.user, parent, 'w')) return c.fail(`ln: failed to create symbolic link '${link}': Permission denied`);
  c.host.links.set(la, target);
  c.host.meta.set(la, c.host.newMeta(c.user, 0o777));
  if (o['-v']) c.print(`'${link}' -> '${target}'`);
  c.uni.emit({ type: 'symlink', host: c.host.name, link: la, target });
  return 0;
});

def(['readlink', 'realpath'], c => {
  const f = fsx(c);
  const canon = c.name === 'realpath' || c.args.includes('-f') || c.args.includes('-e');
  let code = 0;
  for (const p of c.args.filter(a => !a.startsWith('-'))) {
    const a = f.abs(p);
    if (canon) c.print(c.host.realPath(a));
    else if (c.host.isLink(a)) c.print(c.host.links.get(a));
    else code = 1;
  }
  return code;
});

def('chmod', c => {
  const o = opts(c.args, { bool: 'Rvcf', val: [] });
  const f = fsx(c);
  const [spec, ...paths] = o._;
  if (!spec || !paths.length) return c.fail(`chmod: missing operand${spec ? ` after '${spec}'` : ''}`);
  let code = 0;
  for (const p of paths) {
    const list = o['-R'] ? f.walk(p) : [[f.abs(p), f.stat(p)]];
    if (!list[0][1]) { c.eprint(`chmod: cannot access '${p}': No such file or directory`); code = 1; continue; }
    for (const [a, st] of list) {
      if (c.user !== 'root' && st.owner !== c.user) { c.eprint(`chmod: changing permissions of '${a === f.abs(p) ? p : a}': Operation not permitted`); code = 1; continue; }
      const m = parseMode(spec, st.mode, st.type === 'dir');
      if (m === null) return c.fail(`chmod: invalid mode: '${spec}'`);
      c.host.setMeta(a, { mode: m });
      if (o['-v']) c.print(`mode of '${a}' changed to ${m.toString(8).padStart(4, '0')} (${modeString({ ...st, mode: m }).slice(1)})`);
    }
  }
  c.uni.emit({ type: 'chmod', host: c.host.name, spec, paths: paths.map(p => f.abs(p)) });
  return code;
});

function chownLike(c, groupOnly) {
  const o = opts(c.args, { bool: 'Rvhf', val: [] });
  const f = fsx(c);
  const [spec, ...paths] = o._;
  if (!spec || !paths.length) return c.fail(`${c.name}: missing operand`);
  let owner = null, group = null;
  if (groupOnly) group = spec; else { [owner, group] = spec.split(/[:.]/); if (spec.endsWith(':') && owner) group = c.host.userGroups(owner)[0]; }
  if (owner && !c.host.users.has(owner)) return c.fail(`${c.name}: invalid user: '${spec}'`);
  if (group && !c.host.groups.has(group)) return c.fail(`${c.name}: invalid group: '${spec}'`);
  let code = 0;
  for (const p of paths) {
    const list = o['-R'] ? f.walk(p) : [[f.abs(p), f.stat(p)]];
    if (!list[0][1]) { c.eprint(`${c.name}: cannot access '${p}': No such file or directory`); code = 1; continue; }
    for (const [a, st] of list) {
      const allowed = c.user === 'root' || (!owner && st.owner === c.user && c.host.userGroups(c.user).includes(group));
      if (!allowed) { c.eprint(`${c.name}: changing ${owner ? 'ownership' : 'group'} of '${a === f.abs(p) ? p : a}': Operation not permitted`); code = 1; continue; }
      c.host.setMeta(a, { ...(owner ? { owner } : {}), ...(group ? { group } : {}) });
    }
  }
  c.uni.emit({ type: 'chown', host: c.host.name, spec, paths: paths.map(p => f.abs(p)) });
  return code;
}
def('chown', c => chownLike(c, false));
def('chgrp', c => chownLike(c, true));

def('stat', c => {
  const f = fsx(c);
  const o = opts(c.args, { bool: [], val: ['-c', '--format'] });
  let code = 0;
  for (const p of o._) {
    const st = f.stat(p);
    if (!st) { c.eprint(`stat: cannot statx '${p}': No such file or directory`); code = 1; continue; }
    const fmt = o['-c'] || o['--format'];
    if (fmt) { c.print(fmt.replace(/%([anUGsAy])/g, (_, k) => ({ a: (st.mode & 0o7777).toString(8), n: p, U: st.owner, G: st.group, s: fileSize(c.host, f.abs(p), st), A: modeString(st), y: fmtDate(st.mtime, '%F %T') })[k])); continue; }
    c.print(`  File: ${p}`, `  Size: ${fileSize(c.host, f.abs(p), st)}\t\tBlocks: 8          IO Block: 4096   ${st.type === 'dir' ? 'directory' : 'regular file'}`,
      `Access: (${(st.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(st)})  Uid: ( ${c.host.users.get(st.owner)?.uid ?? 0}/ ${st.owner.padStart(8)})   Gid: ( ${c.host.groups.get(st.group)?.gid ?? 0}/ ${st.group.padStart(8)})`,
      `Modify: ${fmtDate(st.mtime, '%F %T')}.000000000 +0000`);
  }
  return code;
});

def('file', c => {
  const f = fsx(c);
  for (const p of c.args) {
    const st = f.stat(p);
    if (!st) { c.print(`${p}: cannot open \`${p}' (No such file or directory)`); continue; }
    if (st.type === 'dir') { c.print(`${p}: directory`); continue; }
    const t = c.host.files.get(f.abs(p));
    const kind = t.startsWith('#!') ? `${/bash/.test(t.split('\n')[0]) ? 'Bourne-Again' : 'POSIX'} shell script, ASCII text executable` : /^\s*[{[]/.test(t) ? 'JSON text data' : t === '' ? 'empty' : /\x00/.test(t) ? 'data' : 'ASCII text';
    c.print(`${p}: ${kind}`);
  }
  return 0;
});

// ---------- find ----------
def('find', c => {
  const args = [...c.args];
  const f = fsx(c);
  const roots = [];
  while (args.length && !args[0].startsWith('-') && args[0] !== '!' && args[0] !== '(') roots.push(args.shift());
  if (!roots.length) roots.push('.');
  // parse expression into a list of OR-groups of AND-terms
  let maxdepth = Infinity, mindepth = 0;
  const groups = [[]];
  const actions = [];
  let negate = false;
  const sizeTest = (spec) => { const m = spec.match(/^([+-]?)(\d+)([ckMG]?)$/); const mult = { c: 1, k: 1024, M: 1048576, G: 1073741824, '': 512 }[m[3]]; const n = Number(m[2]) * mult; return s => m[1] === '+' ? s > n : m[1] === '-' ? s < n : Math.ceil(s / mult) === Number(m[2]); };
  const numTest = (spec, val) => spec.startsWith('+') ? val > Number(spec.slice(1)) : spec.startsWith('-') ? val < Number(spec.slice(1)) : val === Number(spec);
  while (args.length) {
    const a = args.shift();
    let test = null;
    switch (a) {
      case '!': case '-not': negate = true; continue;
      case '-o': case '-or': groups.push([]); continue;
      case '-a': case '-and': continue;
      case '(': case ')': continue;
      case '-maxdepth': maxdepth = Number(args.shift()); continue;
      case '-mindepth': mindepth = Number(args.shift()); continue;
      case '-name': { const re = globToRegex(args.shift()); test = (p) => re.test(basename(p)); break; }
      case '-iname': { const re = new RegExp(globToRegex(args.shift()).source, 'i'); test = (p) => re.test(basename(p)); break; }
      case '-path': case '-wholename': { const re = globToRegex(args.shift()); test = (p, st, rel) => re.test(rel); break; }
      case '-type': { const t = args.shift(); test = (p, st) => (t === 'f' && st.type === 'file') || (t === 'd' && st.type === 'dir'); break; }
      case '-size': { const fn = sizeTest(args.shift()); test = (p, st) => fn(fileSize(c.host, p, st)); break; }
      case '-mtime': { const spec = args.shift(); test = (p, st) => numTest(spec, Math.floor((c.uni.time - st.mtime) / 86400)); break; }
      case '-mmin': { const spec = args.shift(); test = (p, st) => numTest(spec, Math.floor((c.uni.time - st.mtime) / 60)); break; }
      case '-user': { const u = args.shift(); test = (p, st) => st.owner === u; break; }
      case '-group': { const g = args.shift(); test = (p, st) => st.group === g; break; }
      case '-perm': { const spec = args.shift(); const want = parseInt(spec.replace(/^[-/]/, ''), 8); test = (p, st) => spec.startsWith('-') ? (st.mode & want) === want : spec.startsWith('/') ? (st.mode & want) !== 0 : (st.mode & 0o7777) === want; break; }
      case '-empty': test = (p, st) => st.type === 'dir' ? c.host.listDir(p).length === 0 : fileSize(c.host, p, st) === 0; break;
      case '-newer': { const ref = f.stat(args.shift()); test = (p, st) => ref && st.mtime > ref.mtime; break; }
      case '-print': continue;
      case '-print0': actions.push({ kind: 'print0' }); continue;
      case '-delete': actions.push({ kind: 'delete' }); continue;
      case '-ls': actions.push({ kind: 'ls' }); continue;
      case '-exec': case '-execdir': {
        const cmd = [];
        while (args.length && args[0] !== ';' && args[0] !== '+' && args[0] !== '\\;') cmd.push(args.shift());
        const term = args.shift();
        if (!term) return c.fail("find: missing argument to `-exec'");
        actions.push({ kind: 'exec', cmd, batch: term === '+' });
        continue;
      }
      default: return c.fail(`find: unknown predicate \`${a}'`);
    }
    const t = test;
    groups[groups.length - 1].push(negate ? (...x) => !t(...x) : t);
    negate = false;
  }
  const matches = [];
  let code = 0;
  for (const r of roots) {
    const ra = f.abs(r);
    if (!c.host.stat(ra)) { c.eprint(`find: '${r}': No such file or directory`); code = 1; continue; }
    for (const [p, st] of f.walk(r)) {
      if (st.denied) { c.eprint(`find: '${r === '.' ? '.' + p.slice(ra.length) : r.replace(/\/$/, '') + p.slice(ra.length)}': Permission denied`); code = 1; continue; }
      const rel = r === '.' ? (p === ra ? '.' : './' + p.slice(ra.length + (ra === '/' ? 0 : 1))) : (p === ra ? r : r.replace(/\/$/, '') + '/' + p.slice(ra.length + (ra === '/' ? 0 : 1)));
      const depth = p === ra ? 0 : p.slice(ra.length).split('/').filter(Boolean).length;
      if (depth > maxdepth || depth < mindepth) continue;
      const ok = groups.some(g => g.every(t => t(p, st, rel)));
      if (ok) matches.push({ p, rel, st });
    }
  }
  if (!actions.length) { if (matches.length) c.print(...matches.map(m => m.rel)); return code; }
  const batch = [];
  for (const m of matches) {
    for (const act of actions) {
      if (act.kind === 'print0') c.out(m.rel + '\0');
      if (act.kind === 'ls') c.print(`${modeString(m.st)} ${m.st.owner} ${m.st.group} ${fileSize(c.host, m.p, m.st)} ${m.rel}`);
      if (act.kind === 'delete') { try { fsx(c).remove(m.p, { recursive: m.st.type === 'dir' }); } catch (e) { c.eprint(e.message.replace(/^find: /, 'find: ')); code = 1; } }
      if (act.kind === 'exec') {
        if (act.batch) batch.push(m.rel);
        else { const argv = act.cmd.map(x => x === '{}' ? m.rel : x.replace('{}', m.rel)); const r = c.sh.runArgv(argv, c.e, c.io, c.result, {}); if (r !== 0) code = 1; }
      }
    }
  }
  for (const act of actions) if (act.kind === 'exec' && act.batch && batch.length) {
    const i = act.cmd.indexOf('{}');
    const argv = [...act.cmd.slice(0, i), ...batch, ...act.cmd.slice(i + 1)];
    c.sh.runArgv(argv, c.e, c.io, c.result, {});
  }
  return code;
});

// ---------- disk & memory ----------
def('du', c => {
  const o = opts(c.args, { bool: 'shac', val: ['-d', '--max-depth'], alias: { '--max-depth': '-d' } });
  const f = fsx(c);
  const targets = o._.length ? o._ : ['.'];
  const fmt = n => o['-h'] ? humanSize(n) : String(Math.ceil(n / 1024));
  const maxd = o['-d'] !== undefined ? Number(o['-d']) : (o['-s'] ? 0 : Infinity);
  let total = 0;
  for (const t of targets) {
    const ta = f.abs(t);
    if (!c.host.stat(ta)) { c.eprint(`du: cannot access '${t}': No such file or directory`); continue; }
    const sizes = new Map();
    for (const [p, st] of f.walk(t)) {
      if (st.denied) continue;
      const sz = st.type === 'dir' ? 4096 : Math.max(4096, fileSize(c.host, p, st));
      if (st.type === 'dir') sizes.set(p, (sizes.get(p) || 0) + sz);
      else if (o['-a']) sizes.set(p, sz);
      let d = p;
      while (d !== ta && d.length > ta.length) { d = dirname(d); sizes.set(d, (sizes.get(d) || 0) + sz); }
    }
    if (c.host.stat(ta).type === 'file') sizes.set(ta, fileSize(c.host, ta, c.host.stat(ta)));
    const rows = [...sizes].filter(([p]) => { const depth = p === ta ? 0 : p.slice(ta.length).split('/').filter(Boolean).length; return depth <= maxd; }).sort((a, b) => b[0].length - a[0].length);
    for (const [p, n] of rows) c.print(`${fmt(n)}\t${p === ta ? t : (t === '.' ? '.' : t.replace(/\/$/, '')) + p.slice(ta.length)}`);
    total += sizes.get(ta) || 0;
  }
  if (o['-c']) c.print(`${fmt(total)}\ttotal`);
  return 0;
});

def('df', c => {
  const o = opts(c.args, { bool: 'hTi', val: [] });
  const h = c.host;
  const G = 1073741824;
  const mounts = h.mounts || [{ fs: '/dev/sda1', type: 'ext4', size: h.diskGB * G, used: h.diskUsedGB * G, mount: '/' }, { fs: 'tmpfs', type: 'tmpfs', size: 0.5 * G, used: 0.001 * G, mount: '/run' }];
  const paths = o._.length ? o._.map(p => c.resolve(p)) : null;
  const shown = paths ? [...new Set(paths.map(p => [...mounts].sort((x, y) => y.mount.length - x.mount.length).find(m => p === m.mount || p.startsWith(m.mount === '/' ? '/' : m.mount + '/'))))].filter(Boolean) : mounts;
  if (o['-i']) { c.print('Filesystem      Inodes  IUsed   IFree IUse% Mounted on'); for (const m of mounts) c.print(`${m.fs.padEnd(14)} ${String(2621440).padStart(7)} ${String(m.inodesUsed ?? 184211).padStart(6)} ${String(2621440 - (m.inodesUsed ?? 184211)).padStart(7)} ${String(Math.round(((m.inodesUsed ?? 184211) / 2621440) * 100)).padStart(4)}% ${m.mount}`); return 0; }
  const fmt = n => o['-h'] ? humanSize(n) : String(Math.round(n / 1024));
  c.print(`Filesystem     ${o['-T'] ? 'Type  ' : ''}${o['-h'] ? ' Size  Used Avail' : '1K-blocks     Used Available'} Use% Mounted on`);
  for (const m of shown) c.print(`${m.fs.padEnd(14)} ${o['-T'] ? m.type.padEnd(6) : ''}${fmt(m.size).padStart(o['-h'] ? 5 : 9)} ${fmt(m.used).padStart(o['-h'] ? 5 : 8)} ${fmt(Math.max(0, m.size - m.used)).padStart(o['-h'] ? 5 : 9)} ${String(Math.min(100, Math.round((m.used / m.size) * 100))).padStart(3)}% ${m.mount}`);
  return 0;
});

def('free', c => {
  const o = opts(c.args, { bool: 'hmgb', val: [] });
  const h = c.host;
  const total = h.memMB, used = Math.min(total, Math.round(h.memUsedMB())), cache = Math.round(Math.min(total - used, total * 0.18)), free = Math.max(0, total - used - cache);
  const fmt = mb => o['-h'] ? (mb >= 1024 ? (mb / 1024).toFixed(1) + 'Gi' : mb + 'Mi') : o['-m'] ? String(mb) : o['-g'] ? String(Math.round(mb / 1024)) : String(mb * 1024);
  c.print('               total        used        free      shared  buff/cache   available');
  c.print(`Mem:    ${fmt(total).padStart(12)}${fmt(used).padStart(12)}${fmt(free).padStart(12)}${fmt(12).padStart(12)}${fmt(cache).padStart(12)}${fmt(free + cache).padStart(12)}`);
  c.print(`Swap:   ${fmt(h.swapMB || 0).padStart(12)}${fmt(h.swapUsedMB || 0).padStart(12)}${fmt((h.swapMB || 0) - (h.swapUsedMB || 0)).padStart(12)}`);
  return 0;
});

def('uptime', c => {
  const h = c.host;
  const up = h.bootTime ? c.uni.time - h.bootTime : 86400 * 12 + 3600 * 3;
  const days = Math.floor(up / 86400), hrs = Math.floor((up % 86400) / 3600), mins = Math.floor((up % 3600) / 60);
  const la = h.loadAvg.map(x => x.toFixed(2)).join(', ');
  if (c.args.includes('-p')) { c.print(`up ${days} days, ${hrs} hours, ${mins} minutes`); return 0; }
  c.print(` ${fmtDate(c.uni.time, '%T')} up ${days} days, ${pad(hrs)}:${pad(mins)},  1 user,  load average: ${la}`);
  return 0;
});

def('nproc', c => { c.print(String(c.host.cpus)); return 0; });
def('lscpu', c => { c.print('Architecture:            x86_64', `CPU(s):                  ${c.host.cpus}`, 'Model name:              Intel(R) Xeon(R) Platinum (virtual)', 'Thread(s) per core:      1'); return 0; });

// ---------- identity & environment ----------
def('whoami', c => { c.print(c.user); return 0; });
def('id', c => {
  const name = c.args.find(a => !a.startsWith('-')) || c.user;
  const u = c.host.users.get(name);
  if (!u) return c.fail(`id: '${name}': no such user`);
  const groups = c.host.userGroups(name).map(g => `${c.host.groups.get(g).gid}(${g})`);
  if (c.args.includes('-u')) { c.print(String(u.uid)); return 0; }
  if (c.args.includes('-nG') || c.args.includes('-Gn')) { c.print(c.host.userGroups(name).join(' ')); return 0; }
  c.print(`uid=${u.uid}(${name}) gid=${u.gid}(${c.host.userGroups(name)[0]}) groups=${groups.join(',')}`);
  return 0;
});
def('groups', c => { const name = c.args[0] || c.user; c.print((c.args[0] ? name + ' : ' : '') + c.host.userGroups(name).join(' ')); return 0; });
def('hostname', c => { if (c.args.includes('-I')) c.print(c.host.ip + ' '); else if (c.args.includes('-f')) c.print(c.host.fqdn || c.host.name); else c.print(c.host.name); return 0; });
def('hostnamectl', c => { c.print(` Static hostname: ${c.host.name}`, `Operating System: ${c.host.os}`, '          Kernel: Linux 6.8.0-45-generic', '    Architecture: x86-64'); return 0; });
def('uname', c => {
  const o = opts(c.args, { bool: 'asnrvmo', val: [] });
  if (o['-a']) c.print(`Linux ${c.host.name} 6.8.0-45-generic #45-Ubuntu SMP x86_64 x86_64 x86_64 GNU/Linux`);
  else if (o['-r']) c.print('6.8.0-45-generic');
  else if (o['-m']) c.print('x86_64');
  else if (o['-n']) c.print(c.host.name);
  else c.print('Linux');
  return 0;
});
def('date', c => {
  const fmt = c.args.find(a => a.startsWith('+'));
  let ts = c.uni.time;
  const di = c.args.findIndex(a => a === '-d' || a === '--date');
  if (di >= 0) {
    const spec = c.args[di + 1] || '';
    let m;
    if (spec === 'yesterday') ts -= 86400; else if (spec === 'tomorrow') ts += 86400;
    else if ((m = spec.match(/^(-?\d+) (second|minute|hour|day|week)s? ?(ago)?$/))) ts += (m[3] ? -1 : 1) * Number(m[1]) * { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 }[m[2]];
    else if (/^@\d+$/.test(spec)) ts = Number(spec.slice(1));
    else { const t = Date.parse(spec); if (!isNaN(t)) ts = Math.floor(t / 1000); }
  }
  c.print(fmtDate(ts, fmt ? fmt.slice(1) : null));
  return 0;
});
def(['env', 'printenv'], c => {
  if (c.name === 'env' && c.args.length) {
    // env VAR=x cmd …
    const extra = {};
    let i = 0;
    for (; i < c.args.length && /^\w+=/.test(c.args[i]); i++) { const k = c.args[i].indexOf('='); extra[c.args[i].slice(0, k)] = c.args[i].slice(k + 1); }
    if (i < c.args.length) return c.sh.runArgv(c.args.slice(i), c.e, c.io, c.result, { tempEnv: extra });
    for (const [k, v] of Object.entries({ ...c.env, ...extra })) c.print(`${k}=${v}`);
    return 0;
  }
  if (c.name === 'printenv' && c.args.length) { let code = 0; for (const a of c.args) { if (a in c.env) c.print(c.env[a]); else code = 1; } return code; }
  for (const [k, v] of Object.entries(c.env).sort()) c.print(`${k}=${v}`);
  return 0;
});
def(['which', 'whereis'], c => {
  let code = 0;
  for (const a of c.args.filter(x => !x.startsWith('-'))) {
    const onPath = c.sh.findOnPath(a, c.e);
    if (onPath) c.print(onPath);
    else if (registry[a] && commandAvailable(c.host, a)) c.print(`/usr/bin/${a}`);
    else code = 1;
  }
  return code;
});

// ---------- small utilities ----------
def('sleep', c => {
  const s = c.args.reduce((t, a) => { const m = String(a).match(/^(\d+(?:\.\d+)?)([smhd]?)$/); return m ? t + Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, '': 1 })[m[2]] : t; }, 0);
  if (c.bg) {
    const p = c.host.addProc({ cmd: `sleep ${c.args.join(' ')}`, user: c.user, mem: 1, cpu: 0 });
    p.expires = c.uni.time + Math.round(s);
    const n = c.sh.jobs.push({ pid: p.pid, cmd: `sleep ${c.args.join(' ')}` });
    c.e.lastBg = p.pid;
    c.eprint(`[${n}] ${p.pid}`);
    return 0;
  }
  c.uni.advance(Math.round(s));
  return 0;
});
def('seq', c => {
  const nums = c.args.filter(a => !a.startsWith('-') || /^-\d/.test(a)).map(Number);
  const sep = c.args.includes('-s') ? c.args[c.args.indexOf('-s') + 1] : '\n';
  let [a, step, b] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
  const out = [];
  for (let x = a; step > 0 ? x <= b : x >= b; x += step) { out.push(String(x)); if (out.length > 100000) break; }
  c.out(out.join(sep) + '\n');
  return 0;
});
def('yes', c => { const s = c.args.join(' ') || 'y'; c.out((s + '\n').repeat(c.inPipe ? 100 : 5)); if (!c.inPipe) c.eprint(C.dim('(yes prints forever in a real terminal; the simulator stops after a few lines)')); return 0; });
def('basename', c => { const [p, suf] = c.args; let b = basename(p.replace(/\/+$/, '')); if (suf && b.endsWith(suf)) b = b.slice(0, -suf.length); c.print(b); return 0; });
def('dirname', c => { c.print(dirname(c.args[0].replace(/\/+$/, '')) || '.'); return 0; });
def('mktemp', c => { const d = c.args.includes('-d'); const p = `/tmp/tmp.${Math.random().toString(36).slice(2, 12)}`; if (d) c.host.mkdirMeta(p, c.user, 0o700); else c.host.writeFile(p, '', c.user); c.print(p); return 0; });
def('base64', c => {
  const decode = c.args.includes('-d') || c.args.includes('--decode');
  const file = c.args.find(a => !a.startsWith('-'));
  const input = file ? fsx(c).read(file) : (c.stdin ?? '');
  try {
    if (decode) c.out(new TextDecoder().decode(Uint8Array.from(atob(input.replace(/\s+/g, '')), ch => ch.charCodeAt(0))));
    else { const bytes = new TextEncoder().encode(input); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); c.print(btoa(bin)); }
  } catch { return c.fail('base64: invalid input'); }
  return 0;
});
async function noop() {}
void noop;
def(['sha256sum', 'md5sum', 'sha1sum'], c => {
  const f = fsx(c);
  const files = c.args.filter(a => !a.startsWith('-'));
  const hash = s => { let h1 = 0x811c9dc5, h2 = 0x1234567; for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0; h2 = Math.imul(h2 + s.charCodeAt(i), 2654435761) >>> 0; } const hex = (h1.toString(16) + h2.toString(16)).padStart(16, '0'); return (hex.repeat(c.name === 'md5sum' ? 2 : c.name === 'sha1sum' ? 3 : 4)).slice(0, c.name === 'md5sum' ? 32 : c.name === 'sha1sum' ? 40 : 64); };
  if (!files.length) { c.print(`${hash(c.stdin ?? '')}  -`); return 0; }
  let code = 0;
  for (const p of files) { try { c.print(`${hash(f.read(p))}  ${p}`); } catch (e) { c.eprint(e.message); code = 1; } }
  return code;
});
def('timeout', c => { const [, ...cmd] = c.args; return c.sh.runArgv(cmd, c.e, c.io, c.result, {}); });
def('nohup', c => { c.eprint('nohup: ignoring input and appending output to \'nohup.out\''); return c.sh.runArgv(c.args, c.e, c.io, c.result, { bg: true }); });
def('time', c => { const r = c.sh.runArgv(c.args, c.e, c.io, c.result, {}); c.eprint('', 'real\t0m0.042s', 'user\t0m0.012s', 'sys\t0m0.008s'); return r; });
def('watch', c => {
  const o = opts(c.args, { bool: 'dt', val: ['-n'] });
  c.eprint(C.dim(`Every ${o['-n'] || '2.0'}s: ${o._.join(' ')}   (the simulator runs it once; press ↑ Enter to refresh)`));
  return c.runLine(o._.join(' '));
});
def('xdg-open', c => { c.eprint(C.dim('(no browser in the simulator: use curl, or the panels on the right)')); return 0; });
def('man', c => { c.print(C.dim(`(no manual pages in the simulator; try \`${c.args[0] || 'command'} --help\`, or the Field Guide)`)); return 0; });
def('help', c => {
  c.print('This is a simulated Linux shell (bash). Common commands:',
    '  files:    ls cd pwd cat less head tail touch mkdir cp mv rm find tree chmod chown',
    '  text:     grep sed awk sort uniq cut wc tr tee xargs jq diff',
    '  system:   ps top kill systemctl journalctl df du free uptime whoami id sudo apt',
    '  network:  ip ss ping curl dig nc ufw ssh scp',
    '  editors:  nano / vim / code <file>   (opens an editor; Ctrl+S saves)',
    'Also, when the lesson provides them: git gh docker kubectl helm terraform aws ansible …');
  return 0;
});

def('truncate', c => {
  const o = opts(c.args, { bool: ['-c'], val: ['-s', '--size'] });
  const size = o['-s'] ?? o['--size'];
  if (size === undefined) return c.fail("truncate: you must specify either '--size' or '--reference'", 1);
  const f = fsx(c);
  let code = 0;
  for (const p of o._) {
    try {
      const a = f.abs(p);
      if (!c.host.stat(a)) { if (o['-c']) continue; f.write(p, ''); continue; }
      if (!access(c.host, c.user, a, 'w')) throw new SimError(`truncate: cannot open '${p}' for writing: Permission denied`);
      c.host.writeFile(a, String(size) === '0' ? '' : c.host.files.get(a), c.user);
      if (String(size) === '0') c.host.fakeSizes?.delete(c.host.realPath(a));
      else { const m = String(size).match(/^(\d+)([KMG]?)$/); if (m) { c.host.fakeSizes = c.host.fakeSizes || new Map(); c.host.fakeSizes.set(c.host.realPath(a), Number(m[1]) * ({ K: 1024, M: 1048576, G: 1073741824 }[m[2]] || 1)); } }
      c.uni.emit({ type: 'truncate', host: c.host.name, path: a, size: String(size) });
    } catch (e) { c.eprint(e.message); code = 1; }
  }
  return code;
});

// ---------- bash / sh as commands ----------
def(['bash', 'sh', 'dash', 'zsh'], c => {
  const a = [...c.args];
  const flags = [];
  while (a[0] && /^-[a-z]+$/.test(a[0]) && a[0] !== '-c') flags.push(a.shift());
  if (a[0] === '-c') {
    const ce = { ...c.e, vars: new Map(c.e.vars), positional: a.slice(2), opts: { ...c.e.opts } };
    return c.sh.runIn(a[1] || '', ce, c.io, c.result);
  }
  if (!a.length) {
    if (c.stdin) return c.sh.runScript(c.stdin, c.e, c.io, { name: c.name, result: c.result });
    c.eprint('\x1b[2m(you are already in bash; type exit to leave an ssh session)\x1b[0m');
    return 0;
  }
  const p = c.resolve(a[0]);
  const st = c.host.stat(p);
  if (!st) return c.fail(`${c.name}: ${a[0]}: No such file or directory`, 127);
  if (!access(c.host, c.user, p, 'r')) return c.fail(`${c.name}: ${a[0]}: Permission denied`, 126);
  if (flags.some(f => f.includes('n'))) {
    // -n: read and parse the script without running it
    try { parseBash(c.host.files.get(p)); return 0; } catch (err) { return c.fail(`${a[0]}: ${String(err.message).replace(/^bash: /, '')}`, 2); }
  }
  const e2 = { ...c.e, opts: { ...c.e.opts, x: flags.some(f => f.includes('x')) || c.e.opts.x, e: flags.some(f => f.includes('e')) || false } };
  return c.sh.runScript(c.host.files.get(p), e2, c.io, { args: a.slice(1), name: a[0], result: c.result });
}, { always: true });

// ---------- tar / gzip (archives are simulated as JSON blobs) ----------
def('tar', c => {
  const a = c.args.slice();
  let flags = '';
  if (a[0] && !a[0].startsWith('-') && /^[cxtzvfjC]+$/.test(a[0])) flags = a.shift();
  const o = opts(a, { bool: 'cxtzvjp', val: ['-f', '-C'] });
  for (const k of ['c', 'x', 't', 'z', 'v', 'j']) if (flags.includes(k)) o['-' + k] = true;
  if (flags.includes('f') && !o['-f']) o['-f'] = o._.shift();
  const f = fsx(c);
  const file = o['-f'];
  if (!file) return c.fail('tar: Refusing to read archive contents from terminal (missing -f option?)', 2);
  if (o['-c']) {
    const entries = {};
    for (const p of o._) {
      if (!f.exists(p)) { c.eprint(`tar: ${p}: Cannot stat: No such file or directory`); continue; }
      for (const [ap, st] of f.walk(p)) {
        const rel = p.replace(/\/$/, '') + ap.slice(f.abs(p).length);
        if (st.type === 'file') { entries[rel] = c.host.files.get(ap); if (o['-v']) c.print(rel); } else if (o['-v']) c.print(rel + '/');
      }
    }
    f.write(file, 'TAR1' + JSON.stringify(entries));
    if (c.host.fakeSizes) c.host.fakeSizes.delete(f.abs(file));
    return 0;
  }
  const raw = f.read(file);
  if (!raw.startsWith('TAR1')) return c.fail('tar: This does not look like a tar archive', 2);
  const entries = JSON.parse(raw.slice(4));
  if (o['-t']) { c.print(...Object.keys(entries)); return 0; }
  if (o['-x']) {
    const base = o['-C'] ? f.abs(o['-C']) : c.cwd;
    for (const [rel, content] of Object.entries(entries)) { const ap = normPath(base + '/' + rel); c.host.writeFile(ap, content, c.user); if (o['-v']) c.print(rel); }
    return 0;
  }
  return c.fail('tar: You must specify one of the \'-Acdtrux\' options', 2);
});
def(['gzip', 'gunzip', 'zcat'], c => {
  const f = fsx(c);
  for (const p of c.args.filter(a => !a.startsWith('-'))) {
    try {
      if (c.name === 'gzip' && !c.args.includes('-d')) { f.write(p + '.gz', 'GZ1' + f.read(p)); f.remove(p); }
      else { const t = f.read(p); if (c.name === 'zcat') { c.out(t.replace(/^GZ1/, '')); continue; } f.write(p.replace(/\.gz$/, ''), t.replace(/^GZ1/, '')); f.remove(p); }
    } catch (e) { c.eprint(e.message); return 1; }
  }
  return 0;
});

export { stripAnsi };
