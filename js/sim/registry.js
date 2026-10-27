// Command registry. Each command is fn(c) -> exit code, where c gives args, stdin,
// out/err/print/eprint, the session (c.sh), env (c.e), host, user, cwd and resolve().
// Commands that ship in a package (nginx, jq, docker…) are only found once installed.

export const registry = Object.create(null);
export const meta = Object.create(null);

export function def(names, fn, opts = {}) {
  for (const n of [].concat(names)) { registry[n] = fn; meta[n] = { ...opts }; }
}

export function commandAvailable(host, name) {
  if (host.binaries) return host.binaries.has(name) || !!meta[name]?.always;
  const m = meta[name];
  if (!m || !m.pkg) return true;
  return host.packages.has(m.pkg);
}

export function suggestPackage(name) { return meta[name]?.pkg || null; }

// parse flags: spec = { bool: 'abc' or ['-a','--all'], val: ['-n', '--lines'] }
export function opts(args, { bool = [], val = [], alias = {} } = {}) {
  const o = { _: [] };
  const boolSet = new Set(typeof bool === 'string' ? bool.split('').map(c => '-' + c) : bool);
  const valSet = new Set(val);
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (a === '--') { o._.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--') && a.includes('=')) { const k = a.slice(0, a.indexOf('=')); o[alias[k] || k] = a.slice(a.indexOf('=') + 1); continue; }
    if (alias[a]) a = alias[a];
    if (valSet.has(a)) { o[a] = args[++i]; continue; }
    if (boolSet.has(a)) { o[a] = true; continue; }
    if (a.length > 2 && !a.startsWith('--') && valSet.has(a.slice(0, 2)) && !boolSet.has(a.slice(0, 2))) { o[a.slice(0, 2)] = a.slice(2); continue; }
    if (/^-[A-Za-z]./.test(a)) {
      // combined short flags, the last may take a value: -n5 or -czf file
      let ok = true;
      for (let k = 1; k < a.length; k++) {
        const f = '-' + a[k];
        if (boolSet.has(f)) { o[f] = true; continue; }
        if (valSet.has(f)) { o[f] = k < a.length - 1 ? a.slice(k + 1) : args[++i]; break; }
        ok = false; break;
      }
      if (ok) continue;
    }
    if (/^-[A-Za-z]\d+$/.test(a) && valSet.has(a.slice(0, 2))) { o[a.slice(0, 2)] = a.slice(2); continue; }
    if (/^-\d+$/.test(a)) { o.num = Number(a.slice(1)); continue; }
    o._.push(a);
  }
  return o;
}

export function unknownFlag(c, flag) {
  return c.fail(`${c.name}: invalid option -- '${flag.replace(/^-+/, '')}'\nTry '${c.name} --help' for more information.`, 2);
}
