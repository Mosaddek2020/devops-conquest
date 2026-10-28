// Block devices and filesystems: disks and partitions (lsblk, blkid), mkfs, mount and
// umount with the files really living on the device (unmount it and they disappear;
// mount over a non-empty directory and its old files are hidden), /etc/fstab with
// `mount -a`, df per filesystem in bytes and inodes, and `reboot`, which remounts from
// fstab and drops into emergency mode when an entry is broken and lacks `nofail`.

import { def } from './registry.js';
import { C } from '../git/world.js';
import { normPath } from './host.js';
import { opts } from './registry.js';
import { unitState, startUnit } from './systemd.js';

const G = 1073741824;
const hex = (seed, n) => { let x = seed >>> 0 || 7, s = ''; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; s += (x & 15).toString(16); } return s; };
const uuidFor = seed => { const h = hex(seed, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
let uuidSeq = 911;

// give a host a disk layout: a root disk plus extra volumes
export function storageOf(host) {
  if (host.blockDevices) return host;
  const rootUuid = uuidFor(host.name.length * 7919 + 13);
  host.blockDevices = [{ name: 'xvda', sizeGB: host.diskGB, type: 'disk', children: [{ name: 'xvda1', sizeGB: host.diskGB - 0.1, type: 'part', fs: 'ext4', uuid: rootUuid, label: 'cloudimg-rootfs', inodes: Math.round(host.diskGB * 65536), root: true }, { name: 'xvda15', sizeGB: 0.1, type: 'part', fs: 'vfat', uuid: '7B77-95E7', mountAt: '/boot/efi' }] }];
  host.mountTable = [{ dev: 'xvda1', mount: '/' }, { dev: 'xvda15', mount: '/boot/efi' }];
  host.fsStores = new Map();      // device -> Map(path -> { content, meta, size })
  host.hiddenUnder = new Map();   // mount point -> files hidden by a mount
  if (!host.files.has('/etc/fstab')) host.writeSys('/etc/fstab', `LABEL=cloudimg-rootfs\t/\text4\tdiscard,commit=30,errors=remount-ro\t0 1\nLABEL=UEFI\t/boot/efi\tvfat\tumask=0077\t0 1\n`);
  host.mountsFn = () => mountsOf(host);
  if (!host.isDir('/mnt')) host.mkdirMeta('/mnt', 'root');
  return host;
}
export function addDisk(host, { name, sizeGB, fs = null, inodes = null, mount = null, label = null }) {
  storageOf(host);
  const dev = { name, sizeGB, type: 'disk', fs, uuid: fs ? uuidFor(uuidSeq++ * 31) : null, label, inodes: inodes ?? Math.round(sizeGB * 65536), children: [] };
  host.blockDevices.push(dev);
  if (mount) { host.mkdirMeta(mount, 'root'); host.mountTable.push({ dev: name, mount }); }
  return dev;
}
export function findDev(host, name) {
  const n = String(name || '').replace(/^\/dev\//, '');
  for (const d of host.blockDevices || []) { if (d.name === n) return d; for (const p of d.children || []) if (p.name === n) return p; }
  if (/^UUID=/.test(name)) { const u = name.slice(5).replace(/"/g, ''); for (const d of host.blockDevices || []) { if (d.uuid === u) return d; for (const p of d.children || []) if (p.uuid === u) return p; } }
  if (/^LABEL=/.test(name)) { const l = name.slice(6); for (const d of host.blockDevices || []) { if (d.label === l) return d; for (const p of d.children || []) if (p.label === l) return p; } }
  return null;
}
const mountOfDev = (host, dev) => host.mountTable.find(m => m.dev === dev.name) || null;
const under = (p, m) => m === '/' || p === m || p.startsWith(m + '/');
// the mount that owns a path (longest prefix wins)
export function mountFor(host, p) { return [...host.mountTable].sort((a, b) => b.mount.length - a.mount.length).find(m => under(p, m.mount)) || null; }
const rawRemove = (host, p) => { Map.prototype.delete.call(host.files, p); host.meta.delete(p); host.fakeSizes?.delete(p); };
const fileBytes = (host, p) => host.fakeSizes?.get(p) ?? String(Map.prototype.get.call(host.files, p) ?? '').length;

export function mountsOf(host) {
  const out = [];
  for (const m of host.mountTable) {
    const dev = findDev(host, m.dev);
    if (!dev || dev.fs === 'vfat') continue;
    const others = host.mountTable.filter(x => x !== m && x.mount.length > m.mount.length && under(x.mount, m.mount));
    let bytes = 0, files = 0;
    for (const p of host.files.keys()) { if (!under(p, m.mount) || others.some(o => under(p, o.mount))) continue; files++; bytes += fileBytes(host, p); }
    for (const d of host.dirs) if (under(d, m.mount) && !others.some(o => under(d, o.mount))) files++;
    const used = dev.root ? Math.max(host.diskUsedGB * G - otherBytes(host, m), 0) : bytes + dev.sizeGB * G * 0.012;
    out.push({ fs: `/dev/${dev.name}`, type: dev.fs, size: dev.sizeGB * G, used, mount: m.mount, inodes: dev.inodes, inodesUsed: dev.root ? 184211 + files - 40 : files + 11 });
  }
  out.push({ fs: 'tmpfs', type: 'tmpfs', size: 0.5 * G, used: 0.001 * G, mount: '/run', inodes: 98304, inodesUsed: 812 });
  return out;
}
function otherBytes(host, rootMount) { let b = 0; for (const m of host.mountTable) { if (m === rootMount) continue; for (const p of host.files.keys()) if (under(p, m.mount) && host.fakeSizes?.has(p)) b += host.fakeSizes.get(p); } return b; }

function doMount(host, dev, mount) {
  const at = normPath(mount);
  if (!host.isDir(at)) return `mount: ${at}: mount point does not exist.`;
  if (!dev.fs) return `mount: ${at}: wrong fs type, bad option, bad superblock on /dev/${dev.name}, missing codepage or helper program, or other error.\n       dmesg(1) may have more information after failed mount system call.`;
  if (mountOfDev(host, dev)) return `mount: ${at}: /dev/${dev.name} already mounted on ${mountOfDev(host, dev).mount}.`;
  if (host.mountTable.some(m => m.mount === at)) return `mount: ${at}: ${at} already mounted or mount point busy.`;
  // hide what was in the directory, then bring the device's files in
  const hidden = new Map();
  for (const p of [...host.files.keys()]) if (p.startsWith(at + '/')) { hidden.set(p, { content: Map.prototype.get.call(host.files, p), meta: host.meta.get(p), size: host.fakeSizes?.get(p) }); rawRemove(host, p); }
  for (const d of [...host.dirs]) if (d.startsWith(at + '/')) { hidden.set(d, { dir: true, meta: host.meta.get(d) }); host.dirs.delete(d); }
  host.hiddenUnder.set(at, hidden);
  const store = host.fsStores.get(dev.name) || new Map();
  for (const [p, f] of store) {
    const abs = at + p;
    if (f.dir) { host.dirs.add(abs); if (f.meta) host.meta.set(abs, f.meta); continue; }
    host.ensureParents?.(abs, 'root');
    Map.prototype.set.call(host.files, abs, f.content);
    if (f.meta) host.meta.set(abs, f.meta);
    if (f.size) { host.fakeSizes = host.fakeSizes || new Map(); host.fakeSizes.set(abs, f.size); }
  }
  if (!store.size) host.setMeta(at, { owner: 'root', group: 'root', mode: 0o755 });
  host.mountTable.push({ dev: dev.name, mount: at });
  return null;
}
function doUmount(host, at) {
  const m = host.mountTable.find(x => x.mount === at);
  if (!m) return `umount: ${at}: not mounted.`;
  if (m.mount === '/') return 'umount: /: target is busy.';
  const busy = [...host.procs.values()].find(p => (p.openFiles || []).some(f => under(f, at)) || (p.cwd && under(p.cwd, at)));
  if (busy) return `umount: ${at}: target is busy.`;
  const store = new Map();
  for (const p of [...host.files.keys()]) if (p.startsWith(at + '/')) { store.set(p.slice(at.length), { content: Map.prototype.get.call(host.files, p), meta: host.meta.get(p), size: host.fakeSizes?.get(p) }); rawRemove(host, p); }
  for (const d of [...host.dirs]) if (d.startsWith(at + '/')) { store.set(d.slice(at.length), { dir: true, meta: host.meta.get(d) }); host.dirs.delete(d); }
  host.fsStores.set(m.dev, store);
  host.mountTable = host.mountTable.filter(x => x !== m);
  for (const [p, f] of host.hiddenUnder.get(at) || []) { if (f.dir) { host.dirs.add(p); if (f.meta) host.meta.set(p, f.meta); continue; } Map.prototype.set.call(host.files, p, f.content); if (f.meta) host.meta.set(p, f.meta); if (f.size) { host.fakeSizes = host.fakeSizes || new Map(); host.fakeSizes.set(p, f.size); } }
  host.hiddenUnder.delete(at);
  return null;
}

export function parseFstab(text) {
  const out = [];
  String(text || '').split('\n').forEach((line, i) => {
    const l = line.replace(/#.*/, '').trim();
    if (!l) return;
    const [spec, file, type, options = 'defaults', dump = '0', pass = '0'] = l.split(/\s+/);
    out.push({ spec, file, type, options: options.split(','), dump, pass, line: i + 1 });
  });
  return out;
}
// mount every fstab entry that is not mounted yet: returns error lines
function mountAll(host) {
  const errs = [];
  for (const e of parseFstab(host.files.get('/etc/fstab'))) {
    if (e.options.includes('noauto') || e.type === 'swap') continue;
    if (host.mountTable.some(m => m.mount === normPath(e.file))) continue;
    const dev = findDev(host, e.spec);
    if (!dev) { errs.push({ e, msg: `mount: ${e.file}: special device ${e.spec} does not exist.` }); continue; }
    if (dev.fs && e.type !== 'auto' && dev.fs !== e.type) { errs.push({ e, msg: `mount: ${e.file}: wrong fs type, bad option, bad superblock on /dev/${dev.name}, missing codepage or helper program, or other error.` }); continue; }
    if (!host.isDir(normPath(e.file))) { errs.push({ e, msg: `mount: ${e.file}: mount point does not exist.` }); continue; }
    const r = doMount(host, dev, e.file);
    if (r && !/already mounted/.test(r)) errs.push({ e, msg: r });
  }
  return errs;
}

const needRoot = c => c.user === 'root' ? null : c.fail(`${c.name}: must be superuser.`, 32);
const human = gb => gb >= 1 ? `${+gb.toFixed(1)}G` : `${Math.round(gb * 1024)}M`;

def('lsblk', c => {
  const h = storageOf(c.host);
  const o = opts(c.args, { bool: ['-f', '-o', '-p', '-a'], val: [] });
  const rows = [];
  const mp = d => mountOfDev(h, d)?.mount || '';
  for (const d of h.blockDevices) {
    rows.push([d.name, d, '']);
    (d.children || []).forEach((p, i) => rows.push([`${i === d.children.length - 1 ? '└─' : '├─'}${p.name}`, p, '']));
  }
  if (o['-f']) {
    c.print('NAME     FSTYPE FSVER LABEL           UUID                                 FSAVAIL FSUSE% MOUNTPOINTS');
    for (const [n, d] of rows) { const m = mountsOf(h).find(x => x.fs === `/dev/${d.name}`); c.print(`${n.padEnd(8)} ${(d.fs || '').padEnd(6)} ${(d.fs === 'ext4' ? '1.0' : d.fs === 'xfs' ? '' : d.fs === 'vfat' ? 'FAT32' : '').padEnd(5)} ${(d.label || '').padEnd(15)} ${(d.uuid || '').padEnd(36)} ${(m ? human((m.size - m.used) / G) : '').padStart(7)} ${(m ? Math.round(m.used / m.size * 100) + '%' : '').padStart(6)} ${mp(d)}`.trimEnd()); }
  } else {
    c.print('NAME     MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS');
    rows.forEach(([n, d], i) => c.print(`${n.padEnd(8)} 202:${String(i * 16).padEnd(3)}  0 ${human(d.sizeGB).padStart(5)}  0 ${d.type.padEnd(4)} ${mp(d)}`.trimEnd()));
  }
  c.uni.emit({ type: 'lsblk', host: c.host.name, f: !!o['-f'] });
  return 0;
}, { always: true });

def('blkid', c => {
  const h = storageOf(c.host);
  if (c.user !== 'root' && !c.args.length) return 0;
  const o = opts(c.args, { bool: [], val: ['-s', '-o'] });
  const list = o._.length ? o._.map(a => findDev(h, a)).filter(Boolean) : h.blockDevices.flatMap(d => [d, ...(d.children || [])]);
  let any = false;
  for (const d of list) {
    if (!d.fs) continue;
    any = true;
    const tags = { LABEL: d.label, UUID: d.uuid, BLOCK_SIZE: '4096', TYPE: d.fs };
    const pick = o['-s'] ? [o['-s']] : Object.keys(tags).filter(k => tags[k]);
    if (o['-o'] === 'value') c.print(...pick.map(k => tags[k]).filter(Boolean));
    else c.print(`/dev/${d.name}: ${pick.filter(k => tags[k]).map(k => `${k}="${tags[k]}"`).join(' ')}`);
  }
  c.uni.emit({ type: 'blkid', host: c.host.name, args: c.args.join(' ') });
  return any ? 0 : 2;
}, { always: true });

def(['mkfs', 'mkfs.ext4', 'mkfs.xfs'], c => {
  const h = storageOf(c.host);
  if (needRoot(c) !== null) return 1;
  const o = opts(c.args, { bool: ['-F', '-f', '-q'], val: ['-t', '-L', '-i', '-N', '-T'] });
  const fs = c.name === 'mkfs' ? (o['-t'] || 'ext2') : c.name.split('.')[1];
  const target = o._[0];
  const dev = findDev(h, target);
  if (!dev) return c.fail(`mke2fs 1.47.0 (5-Feb-2023)\nThe file ${target} does not exist and no size was specified.`, 1);
  if (dev.children?.length) return c.fail(`mke2fs 1.47.0 (5-Feb-2023)\n/dev/${dev.name} contains a partition table; refusing to make a filesystem over it (pick a partition, e.g. /dev/${dev.children[0].name}).`, 1);
  if (mountOfDev(h, dev)) return c.fail(`mke2fs 1.47.0 (5-Feb-2023)\n/dev/${dev.name} contains a ${dev.fs} file system${dev.label ? ` labelled '${dev.label}'` : ''}\n\t/dev/${dev.name} is mounted; will not make a filesystem here!`, 1);
  const finish = () => {
    dev.fs = fs; dev.uuid = uuidFor(uuidSeq++ * 977 + dev.name.length); dev.label = o['-L'] || null;
    if (o['-N']) dev.inodes = Number(o['-N']);
    else if (o['-T'] === 'largefile') dev.inodes = Math.round(dev.sizeGB * 1024);
    else dev.inodes = Math.round(dev.sizeGB * 65536);
    h.fsStores.set(dev.name, new Map());
    const blocks = Math.round(dev.sizeGB * 262144);
    const lines = fs === 'xfs' ? [`meta-data=/dev/${dev.name}            isize=512    agcount=4, agsize=${Math.round(blocks / 4)} blks`, `data     =                       bsize=4096   blocks=${blocks}, imaxpct=25`, `naming   =version 2              bsize=4096   ascii-ci=0, ftype=1`, `log      =internal log           bsize=4096   blocks=16384, version=2`] : ['mke2fs 1.47.0 (5-Feb-2023)', `Creating filesystem with ${blocks} 4k blocks and ${dev.inodes} inodes`, `Filesystem UUID: ${dev.uuid}`, 'Superblock backups stored on blocks: ', '\t32768, 98304, 163840, 229376, 294912, 819200, 884736, 1605632, 2654208', '', 'Allocating group tables: done                            ', 'Writing inode tables: done                            ', 'Creating journal (65536 blocks): done', 'Writing superblocks and filesystem accounting information: done', ''];
    c.uni.emit({ type: 'mkfs', host: h.name, dev: dev.name, fs });
    return lines;
  };
  if (dev.fs && !o['-F'] && !o['-f']) {
    if (fs === 'xfs') return c.fail(`mkfs.xfs: /dev/${dev.name} appears to contain an existing filesystem (${dev.fs}).\nmkfs.xfs: Use the -f option to force overwrite.`, 1);
    c.print('mke2fs 1.47.0 (5-Feb-2023)', `/dev/${dev.name} contains a ${dev.fs} file system`);
    c.result.ask = { prompt: 'Proceed anyway? (y,N) ', onAnswer(a, { io }) { if (!/^y/i.test(a)) { io.out('\n'); return 1; } for (const l of finish().slice(1)) io.out(l + '\n'); return 0; } };
    return 0;
  }
  c.print(...finish());
  return 0;
}, { always: true });

def('mount', c => {
  const h = storageOf(c.host);
  const o = opts(c.args, { bool: ['-a', '-v', '-l', '--fake'], val: ['-t', '-o'] });
  if (!o._.length && !o['-a']) {
    for (const m of h.mountTable) { const d = findDev(h, m.dev); c.print(`/dev/${m.dev} on ${m.mount} type ${d?.fs} (rw,relatime)`); }
    c.print('tmpfs on /run type tmpfs (rw,nosuid,nodev,size=402540k,mode=755)', 'proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)');
    return 0;
  }
  if (needRoot(c) !== null) return 1;
  if (o['-a']) {
    const errs = mountAll(h);
    for (const x of errs) c.eprint(x.msg);
    c.uni.emit({ type: 'mount', host: h.name, all: true, ok: !errs.length, errors: errs.map(x => x.msg) });
    if (errs.length) return 32;
    if (o['-v']) for (const e of parseFstab(h.files.get('/etc/fstab'))) c.print(`${e.file.padEnd(20)}: already mounted`);
    return 0;
  }
  let [what, where] = o._;
  if (!where) { const e = parseFstab(h.files.get('/etc/fstab')).find(x => x.file === what || x.spec === what); if (!e) return c.fail(`mount: ${what}: can't find in /etc/fstab.`, 1); what = e.spec; where = e.file; }
  const dev = findDev(h, what);
  if (!dev) return c.fail(`mount: ${where}: special device ${what} does not exist.`, 32);
  const err = doMount(h, dev, c.resolve(where));
  if (err) return c.fail(err, 32);
  c.uni.emit({ type: 'mount', host: h.name, dev: dev.name, mount: c.resolve(where), ok: true });
  return 0;
}, { always: true });

def('umount', c => {
  const h = storageOf(c.host);
  if (needRoot(c) !== null) return 1;
  const t = c.args.filter(a => !a.startsWith('-'))[0];
  if (!t) return c.fail('umount: bad usage', 1);
  const dev = findDev(h, t);
  const at = dev ? mountOfDev(h, dev)?.mount : c.resolve(t);
  if (c.cwd && at && (c.cwd === at || c.cwd.startsWith(at + '/'))) return c.fail(`umount: ${at}: target is busy.`, 32);
  const err = doUmount(h, at || c.resolve(t));
  if (err) return c.fail(err, 32);
  c.uni.emit({ type: 'umount', host: h.name, mount: at });
  return 0;
}, { always: true });

def('findmnt', c => {
  const h = storageOf(c.host);
  const t = c.args.find(a => !a.startsWith('-'));
  const list = t ? h.mountTable.filter(m => m.mount === c.resolve(t) || `/dev/${m.dev}` === t) : h.mountTable;
  if (!list.length) return 1;
  c.print('TARGET          SOURCE        FSTYPE OPTIONS');
  for (const m of list) c.print(`${m.mount.padEnd(15)} /dev/${m.dev.padEnd(8)} ${(findDev(h, m.dev)?.fs || '').padEnd(6)} rw,relatime`);
  return 0;
}, { always: true });

// reboot: services and mounts come back from their configuration, nothing else does
def(['reboot', 'shutdown'], c => {
  const h = c.host;
  if (h.kind === 'laptop') return c.fail(C.dim('(the simulator will not reboot your laptop)'), 1);
  if (c.user !== 'root') return c.fail('Call to Reboot failed: Interactive authentication required.', 1);
  if (c.name === 'shutdown' && !c.args.includes('-r')) return c.fail(C.dim('(shutdown -h would leave the server off; use shutdown -r now or reboot)'), 1);
  storageOf(h);
  c.print('Broadcast message from root@' + h.name + ' on pts/1:', '', 'The system will reboot now!');
  rebootHost(h, c.uni);
  // the session on this machine ends with it
  while (c.sh.e.host === h && c.sh.stack.length) c.sh.e = c.sh.stack.pop();
  c.print(`Connection to ${h.name} closed by remote host.`, `Connection to ${h.name} closed.`);
  c.uni.emit({ type: 'reboot', host: h.name, emergency: !!h.emergency });
  return 0;
}, { always: true });

export function rebootHost(h, uni) {
  // the base system (init, sshd, cron, logging) comes back by itself; everything else is gone
  for (const p of [...h.procs.values()]) if (p.pid !== 1 && !/sshd|cron|systemd|journald|rsyslog|agetty|networkd|resolved/.test(p.cmd)) h.killProc(p.pid, 'KILL');
  for (const m of [...h.mountTable]) if (m.mount !== '/' && m.mount !== '/boot/efi') doUmount(h, m.mount);
  for (const p of [...h.files.keys()]) if (p.startsWith('/tmp/')) h.removeFile(p);
  uni.advance(40);
  h.bootTime = uni.time;
  const errs = mountAll(h);
  const fatal = errs.filter(x => !x.e.options.includes('nofail'));
  for (const x of errs) h.journal.push({ time: uni.time, unit: 'kernel', prio: 'err', msg: x.msg });
  if (fatal.length) {
    h.emergency = true; h.down = true;
    h.journal.push({ time: uni.time, unit: 'systemd', prio: 'crit', msg: `Dependency failed for ${fatal[0].e.file.replace(/^\//, '').replace(/\//g, '-')}.mount - ${fatal[0].e.file}. You are in emergency mode.` });
    return;
  }
  h.emergency = false; h.down = false;
  for (const [name, st] of h.units || []) if (st.enabled && !/^(ssh|cron)\.service$/.test(name)) { st.active = 'inactive'; st.pid = null; startUnit(h, uni, name, { quiet: true }); }
  void unitState;
}
