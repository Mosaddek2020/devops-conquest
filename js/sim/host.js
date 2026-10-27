// Hosts and the universe they live in.
//
// A Universe holds what every machine shares: the clock, the event log, DNS, the git
// object store and the pretend GitHub, a container registry, clusters and cloud accounts.
// A Host is one machine (a laptop, a VM, a container): its own filesystem with owners
// and permission bits, users, processes, systemd units, packages, listening ports and a
// firewall. Host extends the git World so git commands work on any machine.

import { World, normPath, dirname, basename } from '../git/world.js';

// A file map that follows symlinks: get/has/set resolve the path through host.links.
class LinkMap extends Map {
  constructor(host) { super(); this.host = host; }
  get(p) { return super.get(this.host.links?.size ? this.host.realPath(p) : p); }
  has(p) { return super.has(this.host.links?.size ? this.host.realPath(p) : p); }
  set(p, v) { return super.set(this.host?.links?.size ? this.host.realPath(p) : p, v); }
}

export class SimError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

// The image registry: tags point at manifests, and every manifest stays addressable by digest
// after its tag moves (repo@sha256:…), like a real registry.
export class Registry extends Map {
  constructor() { super(); this.byDigest = new Map(); }
  set(k, v) { super.set(k, v); if (v?.digest) this.byDigest.set(v.digest, { ...v, ref: k }); return this; }
  // p: a parsed reference ({ short, name, digest })
  lookup(p) {
    if (p.digest) { const e = this.byDigest.get(p.digest); return e && e.ref.startsWith(p.name + ':') ? e : null; }
    return this.get(p.short) || null;
  }
}

export class Universe extends World {
  constructor(opts = {}) {
    super(opts);
    this.hosts = new Map();       // name -> Host
    this.dns = new Map();         // fqdn -> ip
    this.byIp = new Map();        // ip -> Host
    this.nextIp = 10;
    this.registry = new Registry(); // 'repo:tag' -> image (docker), plus every pushed digest
    this.clusters = new Map();    // name -> Cluster (kubernetes)
    this.cloud = null;            // cloud account (terraform/aws)
    this.metrics = null;          // metrics store
    this.tickers = [];            // fn(seconds) run when time advances
    this.httpHooks = [];          // fn(req) -> response|null (labs, external sites)
    this.labData = {};
  }

  addHost(name, opts = {}) {
    const ip = opts.ip || `10.0.0.${this.nextIp++}`;
    const host = new Host(this, name, { ...opts, ip });
    this.hosts.set(name, host);
    this.byIp.set(ip, host);
    if (opts.fqdn) for (const n of [].concat(opts.fqdn)) this.dns.set(n, ip);
    this.dns.set(name, ip);
    return host;
  }

  host(name) { return this.hosts.get(name) || null; }

  // advance the clock and let controllers (systemd restarts, kubernetes, cron) catch up
  advance(seconds = 2) {
    let left = seconds;
    while (left > 0) {
      const step = Math.min(left, 10);
      this.time += step;
      left -= step;
      for (const t of this.tickers) { try { t(step); } catch (e) { console.error('ticker failed', e); } }
    }
  }

  resolveName(name, fromHost) {
    if (!name) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return name;
    if (name === 'localhost' && fromHost) return '127.0.0.1';
    if (fromHost) {
      const hosts = fromHost.files.get('/etc/hosts') || '';
      for (const line of hosts.split('\n')) {
        const parts = line.replace(/#.*/, '').trim().split(/\s+/);
        if (parts.length > 1 && parts.slice(1).includes(name)) return parts[0];
      }
      if (fromHost.containerNet) { const ip = fromHost.containerNet(name); if (ip) return ip; }
    }
    return this.dns.get(name) || null;
  }
}

const DEFAULT_USERS = {
  root: { uid: 0, gid: 0, home: '/root', shell: '/bin/bash' },
  www: { uid: 33, gid: 33, home: '/var/www', shell: '/usr/sbin/nologin', name: 'www-data' },
};

export class Host extends World {
  constructor(uni, name, opts = {}) {
    super({ time: uni.time });
    this.uni = uni;
    this.name = name;
    this.ip = opts.ip;
    this.os = opts.os || 'Ubuntu 24.04 LTS';
    this.kind = opts.kind || 'vm';               // laptop | vm | container
    this.cpus = opts.cpus || 2;
    this.memMB = opts.memMB || 4096;
    this.diskGB = opts.diskGB || 40;
    this.baseDiskGB = opts.diskUsedGB || 6.2;
    // share the universe's git object store, GitHub and event log
    this.objects = uni.objects;
    this.remotes = uni.remotes;
    this.github = uni.github;
    this.treeCache = uni.treeCache;
    this.listeners = uni.listeners;
    this.events = uni.events;
    this.globalConfig = { ...uni.globalConfig };
    // filesystem metadata: path -> { mode, owner, group, mtime }
    this.meta = new Map();
    this.links = new Map();      // symlink path -> target (absolute or relative)
    const plain = this.files;
    this.files = new LinkMap(this);
    for (const [k, v] of plain) this.files.set(k, v);
    this.users = new Map();
    this.groups = new Map();
    const user = opts.user || 'dev';
    this.defaultUser = user;
    this.home = user === 'root' ? '/root' : `/home/${user}`;
    this.dirs = new Set(['/']);
    for (const d of ['/bin', '/usr', '/usr/bin', '/usr/local', '/usr/local/bin', '/etc', '/etc/systemd', '/etc/systemd/system', '/var', '/var/log', '/var/lib', '/tmp', '/opt', '/home', '/root', '/srv', '/proc', '/dev', '/run', '/etc/logrotate.d', '/etc/cron.d', '/etc/profile.d', '/etc/ssl', '/var/mail', '/var/backups', '/var/lib', '/var/tmp']) this.mkdirMeta(d, 'root', 0o755);
    this.meta.get('/tmp').mode = 0o1777;
    this.meta.get('/root').mode = 0o700;
    this.addUser('root', { ...DEFAULT_USERS.root, noHome: true });
    if (opts.withWww !== false) this.addGroup('www-data', 33);
    this.addUser(user, { sudo: opts.sudo !== false });
    this.procs = new Map();      // pid -> process
    this.nextPid = 1000;
    this.units = new Map();      // unit name -> runtime state
    this.packages = new Map(Object.entries(opts.packages || {}));
    this.listening = new Map();  // port -> { pid, addr, proto, program }
    this.firewall = { enabled: false, rules: [], defaultIn: 'deny' };
    this.journal = [];           // { time, unit, prio, msg }
    this.crontabs = new Map();   // user -> text
    this.env = { LANG: 'C.UTF-8', ...(opts.env || {}) };
    this.dmesg = [];
    this.loadAvg = opts.loadAvg || [0.12, 0.08, 0.05];
    this.writeSys('/etc/hostname', name + '\n');
    this.writeSys('/etc/os-release', `NAME="Ubuntu"\nVERSION="24.04 LTS (Noble Numbat)"\nID=ubuntu\nPRETTY_NAME="${this.os}"\n`);
    this.writeSys('/etc/hosts', `127.0.0.1 localhost\n${this.ip} ${name}\n`);
    this.writeSys('/etc/resolv.conf', 'nameserver 127.0.0.53\n');
    this.syncPasswd();
    this.addProc({ cmd: '/sbin/init', user: 'root', pid: 1, mem: 12 });
    if (this.kind === 'vm') this.addProc({ cmd: '/usr/sbin/sshd -D', user: 'root', mem: 6, ports: [22], unit: 'ssh.service' });
  }

  get time() { return this.uni ? this.uni.time : this._time; }
  set time(v) { if (this.uni) this.uni.time = v; else this._time = v; }

  // ---------- users & groups ----------
  addGroup(name, gid) {
    if (this.groups.has(name)) return this.groups.get(name);
    const g = { name, gid: gid ?? 1000 + this.groups.size, members: new Set() };
    this.groups.set(name, g);
    return g;
  }

  addUser(name, { uid, gid, home, shell = '/bin/bash', sudo = false, groups = [], noHome = false } = {}) {
    const isRoot = name === 'root';
    const u = { name, uid: uid ?? (isRoot ? 0 : 1000 + [...this.users.values()].filter(x => x.uid >= 1000).length), home: home || (isRoot ? '/root' : `/home/${name}`), shell, groups: new Set() };
    const g = this.addGroup(name, gid ?? u.uid);
    u.gid = g.gid;
    this.users.set(name, u);
    if (sudo) { this.addGroup('sudo', 27); this.addToGroup(name, 'sudo'); }
    for (const gr of groups) { this.addGroup(gr); this.addToGroup(name, gr); }
    if (!noHome && !this.dirs.has(u.home)) this.mkdirMeta(u.home, name, 0o750);
    this.syncPasswd?.();
    return u;
  }

  addToGroup(user, group) {
    const g = this.groups.get(group) || this.addGroup(group);
    g.members.add(user);
    this.users.get(user)?.groups.add(group);
    this.syncPasswd?.();
  }

  userGroups(user) {
    const u = this.users.get(user);
    if (!u) return [];
    const primary = [...this.groups.values()].find(g => g.gid === u.gid)?.name;
    return [...new Set([primary, ...u.groups].filter(Boolean))];
  }

  syncPasswd() {
    if (!this.users) return;
    const pw = [...this.users.values()].map(u => `${u.name}:x:${u.uid}:${u.gid}::${u.home}:${u.shell}`).join('\n') + '\n';
    const gr = [...this.groups.values()].map(g => `${g.name}:x:${g.gid}:${[...g.members].join(',')}`).join('\n') + '\n';
    this.files.set('/etc/passwd', pw);
    this.files.set('/etc/group', gr);
    if (!this.meta.has('/etc/passwd')) { this.meta.set('/etc/passwd', this.newMeta('root', 0o644)); this.meta.set('/etc/group', this.newMeta('root', 0o644)); }
  }

  // ---------- filesystem with metadata ----------
  newMeta(owner, mode, group) {
    const u = this.users?.get(owner);
    const grp = group || (u ? [...this.groups.values()].find(g => g.gid === u.gid)?.name : owner) || 'root';
    return { mode, owner, group: grp, mtime: this.time };
  }

  mkdirMeta(p, owner = 'root', mode = 0o755) {
    p = normPath(p);
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (const seg of parts) {
      cur += '/' + seg;
      if (!this.dirs.has(cur)) { this.dirs.add(cur); }
      if (!this.meta.has(cur)) this.meta.set(cur, this.newMeta(cur === p ? owner : (this.users ? this.ownerFor(cur) : 'root'), cur === p ? mode : 0o755));
    }
    if (!this.meta.has('/')) this.meta.set('/', this.newMeta('root', 0o755));
  }

  writeSys(p, content, { owner = 'root', mode = 0o644 } = {}) {
    p = normPath(p);
    this.ensureParents(p, 'root');
    this.files.set(p, content);
    this.meta.set(p, this.newMeta(owner, mode));
  }

  ensureParents(p, owner) {
    let d = dirname(p);
    const missing = [];
    while (d !== '/' && !this.dirs.has(d)) { missing.push(d); d = dirname(d); }
    for (const m of missing.reverse()) { this.dirs.add(m); if (!this.meta.has(m)) this.meta.set(m, this.newMeta(owner, 0o755)); }
  }

  // resolve symlinks in every component of an absolute path
  realPath(p, depth = 0) {
    if (!this.links.size || depth > 8) return p;
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      const t = this.links.get(cur);
      if (t !== undefined) {
        const target = t.startsWith('/') ? t : normPath(dirname(cur) + '/' + t);
        return this.realPath(normPath(target + '/' + parts.slice(i + 1).join('/')), depth + 1);
      }
    }
    return p;
  }

  isLink(p) { return this.links.has(p); }

  isDir(p) {
    if (this.links.size) p = this.realPath(p);
    if (this.dirs.has(p)) return true;
    // every repository has .git and .git/hooks (hook scripts live there as plain files)
    const g = p.match(/^(.*)\/\.git(\/hooks)?$/);
    if (g && this.repos?.has(g[1] || '/')) return true;
    const pre = p === '/' ? '/' : p + '/';
    for (const f of Map.prototype.keys.call(this.files)) if (f.startsWith(pre)) return true;
    return false;
  }

  listDir(p) {
    const real = this.links.size ? this.realPath(p) : p;
    const out = new Map(super.listDir(real));
    const pre = p === '/' ? '/' : p + '/';
    for (const [l, t] of this.links) if (l.startsWith(pre) && !l.slice(pre.length).includes('/')) { const tt = t.startsWith('/') ? t : normPath(dirname(l) + '/' + t); out.set(l.slice(pre.length), this.isDir(tt) ? 'dir' : 'file'); }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  // World API used by git: keep metadata in step
  writeFile(p, content, owner) {
    if (this.links.size) p = this.realPath(p);
    const existed = this.files.has(p);
    this.ensureParents(p, owner || this.defaultUser);
    this.files.set(p, content);
    if (!existed || !this.meta.has(p)) this.meta.set(p, this.newMeta(owner || this.ownerFor(p), 0o644));
    else this.meta.get(p).mtime = this.time;
  }

  ownerFor(p) {
    for (const u of this.users.values()) if (u.uid >= 1000 && (p === u.home || p.startsWith(u.home + '/'))) return u.name;
    return this.defaultUser && p.startsWith('/home/') ? this.defaultUser : 'root';
  }

  removeFile(p) {
    if (this.links.has(p)) { this.links.delete(p); this.meta.delete(p); return; }
    const r = this.links.size ? this.realPath(p) : p;
    const size = this.fakeSizes?.get(r);
    if (size) {
      const holder = [...this.procs.values()].find(x => x.openFiles?.includes(r));
      if (holder) (holder.deletedOpen = holder.deletedOpen || []).push({ path: r, bytes: size });
      this.fakeSizes.delete(r);
    }
    Map.prototype.delete.call(this.files, r); this.meta.delete(r);
  }

  lstat(p) {
    p = normPath(p);
    if (this.links.has(p)) return { type: 'link', size: this.links.get(p).length, mode: 0o777, owner: this.meta.get(p)?.owner || 'root', group: this.meta.get(p)?.group || 'root', mtime: this.meta.get(p)?.mtime || this.time, target: this.links.get(p) };
    return this.stat(p);
  }

  stat(p) {
    p = normPath(p);
    if (this.links.size) { const r = this.realPath(p); if (r !== p) { if (!this.files.has(r) && !this.isDir(r)) return null; p = r; } }
    // paths created without metadata (e.g. by git) belong to whoever owns that part of the tree
    if (this.files.has(p)) return { type: 'file', size: new TextEncoder().encode(this.files.get(p)).length, ...(this.meta.get(p) || this.newMeta(this.ownerFor(p), 0o644)) };
    if (this.isDir(p)) return { type: 'dir', size: 4096, ...(this.meta.get(p) || this.newMeta(this.ownerFor(p), 0o755)) };
    return null;
  }

  setMeta(p, patch) {
    if (this.links.size) p = this.realPath(p);
    const s = this.stat(p);
    if (!s) return false;
    const cur = this.meta.get(p) || { mode: s.mode, owner: s.owner, group: s.group, mtime: s.mtime };
    this.meta.set(p, { ...cur, ...patch });
    return true;
  }

  // permission check: want is 'r' | 'w' | 'x'
  can(user, p, want) {
    if (user === 'root') return true;
    const s = this.stat(p);
    if (!s) return false;
    const u = this.users.get(user);
    const bit = { r: 4, w: 2, x: 1 }[want];
    let shift = 0;
    if (s.owner === user) shift = 6;
    else if (u && this.userGroups(user).includes(s.group)) shift = 3;
    return ((s.mode >> shift) & bit) !== 0;
  }

  // ---------- processes ----------
  addProc({ cmd, user = 'root', pid, ppid = 1, mem = 20, cpu = 0, ports = [], unit = null, program = null, env = {}, cwd = '/' }) {
    pid = pid || this.nextPid++;
    const p = { pid, ppid, user, cmd, mem, cpu, start: this.time, state: 'S', unit, program, env, cwd, ports: [] };
    this.procs.set(pid, p);
    for (const port of ports) this.listen(port, pid, { program });
    return p;
  }

  listen(port, pid, { addr = '0.0.0.0', proto = 'tcp', program = null } = {}) {
    const cur = this.listening.get(port);
    if (cur && this.procs.has(cur.pid) && cur.pid !== pid) throw new SimError(`listen EADDRINUSE: address already in use :::${port}`, 98);
    this.listening.set(port, { pid, addr, proto, program });
    this.procs.get(pid)?.ports.push(port);
  }

  killProc(pid, signal = 'TERM') {
    const p = this.procs.get(pid);
    if (!p) return false;
    this.procs.delete(pid);
    for (const [port, l] of this.listening) if (l.pid === pid) this.listening.delete(port);
    p.program?.stop?.(signal);
    this.uni.emit({ type: 'proc-exit', host: this.name, pid, cmd: p.cmd, signal });
    return true;
  }

  log(unit, msg, prio = 'info') {
    this.journal.push({ time: this.time, unit, prio, msg });
    if (this.journal.length > 4000) this.journal.splice(0, 1000);
  }

  // ---------- disk accounting ----------
  // used = base system + every file with a (simulated) size + deleted files still held open
  get diskUsedGB() {
    let bytes = 0;
    if (this.fakeSizes) for (const [p, n] of this.fakeSizes) if (Map.prototype.has.call(this.files, p)) bytes += n;
    for (const p of this.procs?.values() || []) for (const d of p.deletedOpen || []) bytes += d.bytes;
    return this.baseDiskGB + bytes / 1073741824;
  }
  set diskUsedGB(v) { this.baseDiskGB = v; }

  // ---------- misc ----------
  memUsedMB() { let m = 180; for (const p of this.procs.values()) m += p.mem || 0; return m; }
  cpuBusy() { let c = 0; for (const p of this.procs.values()) c += p.cpu || 0; return c; }
  hasPackage(name) { return this.packages.has(name); }
}

export { normPath, dirname, basename };
