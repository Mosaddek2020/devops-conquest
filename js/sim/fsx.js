// Permission-aware filesystem helpers for commands. Errors are thrown as SimError with
// the same wording coreutils uses, prefixed by the command name.

import { SimError, normPath, dirname, basename } from './host.js';
import { access } from './session.js';

export function fsx(c) {
  const host = c.host, user = c.user, name = c.name;
  const abs = p => c.resolve(p);
  const api = {
    abs,
    exists: p => !!host.stat(abs(p)),
    stat: p => host.stat(abs(p)),
    isDir: p => host.stat(abs(p))?.type === 'dir',
    isFile: p => host.stat(abs(p))?.type === 'file',
    read(p, { quietName = name } = {}) {
      if (p === '-' ) return c.stdin ?? '';
      const a = abs(p);
      if (a === '/dev/null') return '';
      const v = c.sh.readVirtual?.(a, c);
      if (v !== undefined) return v;
      const st = host.stat(a);
      if (!st) throw new SimError(`${quietName}: ${p}: No such file or directory`, 1);
      if (st.type === 'dir') throw new SimError(`${quietName}: ${p}: Is a directory`, 1);
      if (!access(host, user, a, 'r')) throw new SimError(`${quietName}: ${p}: Permission denied`, 1);
      return host.files.get(a);
    },
    write(p, content, { append = false, mode } = {}) {
      const a = abs(p);
      const st = host.stat(a);
      if (st?.type === 'dir') throw new SimError(`${name}: ${p}: Is a directory`, 1);
      if (st) { if (!access(host, user, a, 'w')) throw new SimError(`${name}: ${p}: Permission denied`, 1); }
      else {
        const parent = dirname(a);
        if (!host.isDir(parent)) throw new SimError(`${name}: ${p}: No such file or directory`, 1);
        if (!access(host, user, parent, 'w')) throw new SimError(`${name}: cannot create '${p}': Permission denied`, 1);
      }
      host.writeFile(a, append && st ? host.files.get(a) + content : content, user);
      if (mode !== undefined) host.setMeta(a, { mode });
      host.uni.emit({ type: 'file-write', host: host.name, path: a, by: name });
    },
    mkdir(p, { parents = false, mode = 0o755 } = {}) {
      const a = abs(p);
      if (host.stat(a)) { if (parents && host.stat(a).type === 'dir') return; throw new SimError(`mkdir: cannot create directory '${p}': File exists`, 1); }
      const parent = dirname(a);
      if (!host.isDir(parent)) {
        if (!parents) throw new SimError(`mkdir: cannot create directory '${p}': No such file or directory`, 1);
        api.mkdir(parent, { parents: true });
      }
      if (!access(host, user, parent, 'w')) throw new SimError(`mkdir: cannot create directory '${p}': Permission denied`, 1);
      host.mkdirMeta(a, user, mode);
    },
    remove(p, { recursive = false, force = false } = {}) {
      const a = abs(p);
      const st = host.stat(a);
      if (!st) { if (force) return; throw new SimError(`${name}: cannot remove '${p}': No such file or directory`, 1); }
      if (a === '/' ) throw new SimError(`${name}: it is dangerous to operate recursively on '/'\n${name}: use --no-preserve-root to override this failsafe`, 1);
      const parent = dirname(a);
      if (!access(host, user, parent, 'w')) throw new SimError(`${name}: cannot remove '${p}': Permission denied`, 1);
      const pst = host.stat(parent);
      if (pst && (pst.mode & 0o1000) && user !== 'root' && st.owner !== user) throw new SimError(`${name}: cannot remove '${p}': Operation not permitted`, 1);
      if (st.type === 'dir') {
        if (!recursive) throw new SimError(`${name}: cannot remove '${p}': Is a directory`, 1);
        for (const f of [...host.files.keys()]) if (f.startsWith(a + '/')) host.removeFile(f);
        for (const d of [...host.dirs]) if (d === a || d.startsWith(a + '/')) { host.dirs.delete(d); host.meta.delete(d); }
        for (const r of [...host.repos.keys()]) if (r === a || r.startsWith(a + '/')) host.repos.delete(r);
      } else host.removeFile(a);
      host.uni.emit({ type: 'file-remove', host: host.name, path: a });
    },
    list(p) {
      const a = abs(p);
      if (!access(host, user, a, 'r')) throw new SimError(`${name}: cannot open directory '${p}': Permission denied`, 2);
      return host.listDir(a);
    },
    // walk a tree: yields [absPath, stat]
    walk(p) {
      const root = abs(p);
      const out = [];
      const visit = (a) => {
        const st = host.stat(a);
        if (!st) return;
        out.push([a, st]);
        if (st.type === 'dir') {
          if (!access(host, user, a, 'r') || !access(host, user, a, 'x')) { out.push([a, { ...st, denied: true }]); return; }
          for (const [n] of host.listDir(a)) visit(a === '/' ? '/' + n : a + '/' + n);
        }
      };
      visit(root);
      return out;
    },
  };
  return api;
}

export function modeString(st) {
  const t = st.type === 'dir' ? 'd' : '-';
  const m = st.mode;
  const rwx = (b, s, ch) => ((m >> b) & 4 ? 'r' : '-') + ((m >> b) & 2 ? 'w' : '-') + (((m >> b) & 1) ? (s ? ch : 'x') : (s ? ch.toUpperCase() : '-'));
  return t + rwx(6, m & 0o4000, 's') + rwx(3, m & 0o2000, 's') + rwx(0, m & 0o1000, 't');
}

export function humanSize(n) {
  if (n < 1024) return String(n);
  const units = ['K', 'M', 'G', 'T'];
  let v = n, u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + units[u];
}

export function parseMode(spec, cur, isDir) {
  if (/^[0-7]{3,4}$/.test(spec)) return parseInt(spec, 8);
  let mode = cur;
  for (const part of spec.split(',')) {
    const m = part.match(/^([ugoa]*)([-+=])([rwxXst]*)$/);
    if (!m) return null;
    const who = m[1] || 'a';
    let bits = 0;
    for (const ch of m[3]) {
      const v = ch === 'r' ? 4 : ch === 'w' ? 2 : ch === 'x' || (ch === 'X' && (isDir || (cur & 0o111))) ? 1 : 0;
      for (const w of who === 'a' ? 'ugo' : who) {
        const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
        bits |= v << shift;
        if (ch === 's' && w === 'u') bits |= 0o4000;
        if (ch === 's' && w === 'g') bits |= 0o2000;
      }
      if (ch === 't') bits |= 0o1000;
    }
    if (m[2] === '+') mode |= bits;
    else if (m[2] === '-') mode &= ~bits;
    else {
      let mask = 0;
      for (const w of who === 'a' ? 'ugo' : who) mask |= 7 << (w === 'u' ? 6 : w === 'g' ? 3 : 0);
      mode = (mode & ~mask) | bits;
    }
  }
  return mode;
}

export { normPath, dirname, basename };
