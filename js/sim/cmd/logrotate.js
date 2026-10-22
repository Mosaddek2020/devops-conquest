// logrotate: reads /etc/logrotate.conf and /etc/logrotate.d/*, rotates matching logs.
// Supports: daily/weekly/monthly, size, rotate N, compress, delaycompress, missingok,
// notifempty, copytruncate, create MODE USER GROUP, dateext, postrotate…endscript.
// -d (debug: show what would happen) and -f (force rotation now).

import { def } from '../registry.js';
import { normPath, dirname, basename } from '../host.js';
import { globToRegex } from '../bash.js';

function parseConf(text, file) {
  const blocks = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/#.*/, '').trim();
    if (!l) continue;
    const m = l.match(/^(.+?)\s*\{$/);
    if (!m) continue;
    const b = { paths: m[1].split(/\s+/), opts: {}, post: [], file, line: i + 1 };
    for (i++; i < lines.length; i++) {
      const d = lines[i].replace(/#.*/, '').trim();
      if (d === '}') break;
      if (!d) continue;
      if (d === 'postrotate') { for (i++; i < lines.length && lines[i].trim() !== 'endscript'; i++) b.post.push(lines[i].trim()); continue; }
      const [k, ...v] = d.split(/\s+/);
      b.opts[k] = v.length ? v.join(' ') : true;
    }
    blocks.push(b);
  }
  return blocks;
}

const SIZE = s => { const m = String(s).match(/^(\d+)([kKMG]?)$/); return m ? Number(m[1]) * ({ k: 1024, K: 1024, M: 1048576, G: 1073741824 }[m[2]] || 1) : Infinity; };

def('logrotate', c => {
  const host = c.host;
  const debug = c.args.includes('-d'), force = c.args.includes('-f') || c.args.includes('--force');
  const confArg = c.args.find(a => !a.startsWith('-'));
  if (c.user !== 'root' && !debug) return c.fail('error: error setting owner of /var/lib/logrotate/status: Operation not permitted', 1);
  const files = confArg ? [c.resolve(confArg)] : ['/etc/logrotate.conf', ...[...host.files.keys()].filter(p => p.startsWith('/etc/logrotate.d/'))];
  let blocks = [];
  for (const f of files) {
    if (host.isDir(f)) { for (const [n] of host.listDir(f)) blocks.push(...parseConf(host.files.get(f + '/' + n) || '', f + '/' + n)); continue; }
    const t = host.files.get(f);
    if (t === undefined) return c.fail(`error: stat of ${f} failed: No such file or directory`, 1);
    blocks.push(...parseConf(t, f));
  }
  if (!blocks.length) { c.print('reading config file ' + files[0], 'Handling 0 logs'); return 0; }
  const sizeOf = p => host.fakeSizes?.get(p) ?? (host.files.get(p) || '').length;
  let rotated = 0;
  for (const b of blocks) {
    const targets = [];
    for (const pat of b.paths) {
      const dir = dirname(pat), re = globToRegex(basename(pat));
      if (!host.isDir(dir)) { if (!b.opts.missingok) c.eprint(`error: stat of ${pat} failed: No such file or directory`); continue; }
      for (const [n, k] of host.listDir(dir)) if (k === 'file' && re.test(n) && !/\.\d+(\.gz)?$/.test(n)) targets.push(normPath(dir + '/' + n));
    }
    if (debug) c.print(`rotating pattern: ${b.paths.join(' ')}  ${b.opts.size ? b.opts.size + ' bytes' : b.opts.weekly ? 'weekly' : b.opts.monthly ? 'monthly' : 'after 1 days'} (${b.opts.rotate || 0} rotations)`);
    for (const p of targets) {
      const size = sizeOf(p);
      const due = force || (b.opts.size ? size >= SIZE(b.opts.size) : true);
      if (debug) c.print(`considering log ${p}`, `  log ${due ? 'needs' : 'does not need'} rotating`);
      if (!due || (b.opts.notifempty && size === 0)) continue;
      if (debug) continue;
      const keep = Number(b.opts.rotate || 0);
      const gz = b.opts.compress ? '.gz' : '';
      // shift older generations
      for (let n = keep; n >= 1; n--) {
        for (const ext of ['', '.gz']) {
          const from = `${p}.${n}${ext}`;
          if (!host.files.has(from)) continue;
          if (n === keep) { host.removeFile(from); continue; }
          const to = `${p}.${n + 1}${ext}`;
          host.writeFile(to, host.files.get(from), 'root');
          if (host.fakeSizes?.has(from)) { host.fakeSizes.set(to, Math.round(host.fakeSizes.get(from) * (ext ? 1 : 0.12))); host.fakeSizes.delete(from); }
          host.removeFile(from);
        }
      }
      if (keep >= 1) {
        // the current log becomes .1 (compressed unless delaycompress)
        const comp = b.opts.compress && !b.opts.delaycompress;
        const dest = `${p}.1${comp ? '.gz' : ''}`;
        host.writeFile(dest, (comp ? 'GZ1' : '') + (host.files.get(p) || ''), 'root');
        if (host.fakeSizes?.has(p)) { host.fakeSizes = host.fakeSizes || new Map(); host.fakeSizes.set(dest, Math.round(size * (comp ? 0.12 : 1))); }
        if (b.opts.delaycompress && host.files.has(`${p}.2`)) { host.writeFile(`${p}.2${gz}`, 'GZ1' + host.files.get(`${p}.2`), 'root'); if (gz) host.removeFile(`${p}.2`); }
      }
      // copytruncate keeps the same file (safe for apps that keep it open); otherwise a new file is created
      const holders = [...host.procs.values()].filter(x => x.openFiles?.includes(p));
      if (b.opts.copytruncate || holders.length === 0) { host.writeFile(p, '', 'root'); host.fakeSizes?.delete(p); }
      else {
        // moved: the app keeps writing into the rotated file until it reopens its log
        for (const h of holders) h.openFiles = h.openFiles.map(f => f === p ? `${p}.1` : f);
        host.writeFile(p, '', 'root'); host.fakeSizes?.delete(p);
      }
      if (b.opts.create) { const [mode, user, group] = String(b.opts.create).split(/\s+/); host.setMeta(p, { mode: parseInt(mode, 8), ...(user ? { owner: user } : {}), ...(group ? { group } : {}) }); }
      rotated++;
      c.uni.emit({ type: 'logrotate', host: host.name, path: p });
    }
    if (!debug && b.post.length && targets.length) c.runLine(b.post.join('\n'), { e: { ...c.e, user: 'root' } });
  }
  if (debug) c.print('', '(debug mode: nothing was changed)');
  return 0;
}, { always: true });
