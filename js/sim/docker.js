// The Docker engine and CLI. Each container is a small simulated machine (its own files,
// users, processes and IP) started from an image. Ports are published through a proxy on
// the host, user-defined networks resolve container names, named volumes outlive the
// containers using them, and `docker compose` brings up whole stacks from compose.yaml.

import { def, opts } from './registry.js';
import { parseYaml } from '../git/yaml.js';
import { launch } from './runtime.js';
import { httpRequest, connect } from './net.js';
import { Nginx } from './nginx.js';
import { SimError, normPath, dirname, basename } from './host.js';
import { Session } from './session.js';
import { C, stripAnsi } from '../git/world.js';
import { BASE_IMAGES, baseFor, baseFiles, makeContainerHost, snapshotFiles, snapshotUsers, parseRef, shortId, dockerBuild, fmtMB, sizeOf } from './docker-images.js';

let netSeq = 18;

export class Engine {
  constructor(host, uni) {
    this.host = host; this.uni = uni;
    this.images = new Map();      // id -> image
    this.tags = new Map();        // 'repo:tag' (short form) -> id
    this.containers = new Map();  // id -> container
    this.networks = new Map([['bridge', { name: 'bridge', driver: 'bridge', subnet: `172.17.${host.dockerIndex}.0/24`, next: 2, dns: false }], ['host', { name: 'host', driver: 'host' }], ['none', { name: 'none', driver: 'null' }]]);
    this.volumes = new Map();     // name -> { files: {path: f} }
    this.cache = new Map();       // build cache
    this.loggedIn = new Set();
  }
  findImage(ref) {
    if (!ref) return null;
    if (/^(sha256:)?[0-9a-f]{6,64}$/.test(ref)) { const id = ref.replace(/^sha256:/, ''); for (const [k, v] of this.images) if (k.startsWith(id)) return v; }
    const p = parseRef(ref);
    const id = this.tags.get(p.short);
    return id ? this.images.get(id) : null;
  }
  addImage(img, tags = []) {
    const id = shortId();
    const image = { ...img, id, created: img.created ?? this.uni.time, tags: new Set() };
    this.images.set(id, image);
    for (const t of tags) this.tag(image, t);
    return image;
  }
  tag(image, ref) {
    const p = parseRef(ref);
    const old = this.tags.get(p.short);
    if (old && this.images.get(old)) this.images.get(old).tags.delete(p.short);
    this.tags.set(p.short, image.id);
    image.tags.add(p.short);
  }
  // pull from the base catalog or a registry
  pullImage(ref, { quiet = false, out = null } = {}) {
    const p = parseRef(ref);
    const reg = this.uni.registry;
    const remote = reg.get(p.short);
    const have = this.findImage(ref);
    if (have && (!remote || have.digest === remote.digest)) { out?.(`${p.tag}: Pulling from ${p.repo}`, `Digest: ${have.digest}`, `Status: Image is up to date for ${p.short}`); return have; }
    if (remote) {
      if (remote.private && !this.loggedIn.has(p.registry)) { out?.(`Error response from daemon: pull access denied for ${p.name}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`); return null; }
      const img = this.addImage(JSON.parse(JSON.stringify({ ...remote.image, tags: undefined, users: remote.image.users })), [p.short]);
      img.digest = remote.digest;
      out?.(`${p.tag}: Pulling from ${p.repo}`, ...remote.image.layers.slice(-3).map((l, k) => `${remote.digest.slice(7 + k, 19 + k)}: Pull complete`), `Digest: ${remote.digest}`, `Status: Downloaded newer image for ${p.short}`, p.registry === 'docker.io' ? `docker.io/${p.repo.includes('/') ? '' : 'library/'}${p.short}` : p.short);
      return img;
    }
    const base = baseFor(ref);
    if (!base) { out?.(`Error response from daemon: pull access denied for ${p.repo}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`); return null; }
    const img = this.addImage({ files: baseFiles(base), users: null, binaries: base.bins, packages: [], base, baseRef: base.key, sizeMB: base.size, layers: [{ created: this.uni.time - 86400 * 12, by: `base image ${base.key}`, sizeMB: base.size }], config: { cmd: base.cmd, entrypoint: base.entrypoint || null, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...(base.nodeUser ? { NODE_VERSION: '20.18.0' } : {}) }, workdir: '/', user: base.user || 'root', exposed: base.expose || [] } }, [p.short, base.key]);
    img.digest = 'sha256:' + shortId();
    const box = makeContainerHost(this.uni, 'tmp', { base, files: img.files });
    img.users = snapshotUsers(box);
    img.files = snapshotFiles(box);
    if (!quiet) out?.(`${p.tag}: Pulling from ${p.repo.includes('/') ? p.repo : 'library/' + p.repo}`, `${img.digest.slice(7, 19)}: Pull complete`, `Digest: ${img.digest}`, `Status: Downloaded newer image for ${p.short}`, `docker.io/library/${p.short}`);
    return img;
  }
  network(name) { return this.networks.get(name) || null; }
  allocIp(netName) {
    const n = this.networks.get(netName);
    const base = n.subnet.split('.').slice(0, 3).join('.');
    return `${base}.${n.next++}`;
  }
}

export function engineOf(host, uni) {
  if (!host.docker) {
    host.dockerIndex = host.dockerIndex ?? (uni.dockerHosts = (uni.dockerHosts || 0) + 1);
    host.docker = new Engine(host, uni);
  }
  return host.docker;
}

// ---------------------------------------------------------------- containers

function resolveCommand(img, override) {
  const ep = img.config.entrypoint || [];
  const cmd = override && override.length ? override : (img.config.cmd || []);
  let argv = [...ep, ...cmd];
  if (argv[0] === '/bin/sh' && argv[1] === '-c') argv = argv[2].split(/\s+/);
  if (argv[0] === '/nodejs/bin/node') argv[0] = 'node';
  return argv;
}

export function createContainer(engine, img, { name, env = {}, ports = [], network = 'bridge', aliases = [], volumes = [], cmd = null, restart = 'no', user = null, workdir = null, memory = null, project = null, service = null, healthcheck = undefined, labels = {} } = {}) {
  const uni = engine.uni;
  const id = shortId();
  name = name || `${['eager', 'brave', 'calm', 'quirky', 'sharp'][engine.containers.size % 5]}_${['turing', 'hopper', 'lovelace', 'ritchie', 'torvalds'][(engine.containers.size * 3) % 5]}`;
  if ([...engine.containers.values()].some(c => c.name === name)) throw new SimError(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${[...engine.containers.values()].find(c => c.name === name).id}". You have to remove (or rename) that container to be able to reuse that name.`, 125);
  for (const p of ports) {
    const busy = engine.host.listening.get(p.host);
    if (busy && engine.host.procs.has(busy.pid)) throw new SimError(`docker: Error response from daemon: driver failed programming external connectivity on endpoint ${name}: Bind for 0.0.0.0:${p.host} failed: port is already allocated.`, 125);
  }
  if (!engine.networks.has(network)) throw new SimError(`docker: Error response from daemon: network ${network} not found.`, 125);
  const ctr = { userSet: !!user, id, name, image: img, imageRef: [...img.tags][0] || img.id.slice(0, 12), env: { ...img.config.env, ...env }, ports, network, aliases: [name, ...aliases], volumes, cmd, restart, user: user || img.config.user || 'root', workdir: workdir || img.config.workdir || '/', memory, project, service, labels, created: uni.time, status: 'created', exitCode: null, logs: [], restarts: 0, health: null, healthcheck: healthcheck === undefined ? img.config.healthcheck : healthcheck };
  engine.containers.set(id, ctr);
  return ctr;
}

function volumeFiles(engine, ctr, h) {
  for (const v of ctr.volumes) {
    if (v.type === 'volume') {
      const vol = engine.volumes.get(v.source) || (engine.volumes.set(v.source, { name: v.source, files: null, created: engine.uni.time }), engine.volumes.get(v.source));
      if (vol.files === null) { vol.files = {}; for (const [p, f] of Object.entries(snapshotFiles(h))) if (p === v.target || p.startsWith(v.target + '/')) vol.files[p.slice(v.target.length)] = f; }
      for (const p of [...h.files.keys()]) if (p.startsWith(v.target + '/')) h.removeFile(p);
      h.mkdirMeta(v.target, ctr.image.config.user || 'root');
      for (const [rel, f] of Object.entries(vol.files)) { if (f.dir) h.mkdirMeta(v.target + rel, f.owner || 'root'); else { h.writeFile(v.target + rel, f.content, f.owner || 'root'); if (f.mode) h.setMeta(v.target + rel, { mode: f.mode }); } }
    } else if (v.type === 'bind') {
      const src = engine.host;
      h.mkdirMeta(v.target, 'root');
      for (const [p, c] of src.files) if (p === v.source || p.startsWith(v.source + '/')) h.writeFile(v.target + p.slice(v.source.length), c, 'root');
      for (const d of src.dirs) if (d.startsWith(v.source + '/')) h.mkdirMeta(v.target + d.slice(v.source.length));
    }
  }
}

// write volume contents back (so data outlives the container)
export function syncVolumes(engine, ctr) {
  const h = ctr.h;
  if (!h) return;
  for (const v of ctr.volumes) {
    if (v.type === 'volume') {
      const vol = engine.volumes.get(v.source);
      vol.files = {};
      for (const [p, f] of Object.entries(snapshotFiles(h))) if (p.startsWith(v.target + '/')) vol.files[p.slice(v.target.length)] = f;
    } else if (v.type === 'bind' && !v.ro) {
      for (const [p, c] of h.files) if (p.startsWith(v.target + '/')) engine.host.writeFile(v.source + p.slice(v.target.length), c, engine.host.defaultUser);
    }
  }
}

export function startContainer(engine, ctr) {
  const uni = engine.uni;
  const img = ctr.image;
  if (ctr.status === 'running') return { ok: true };
  let h = ctr.h;
  if (!h) {
    const ip = engine.allocIp(ctr.network === 'host' ? 'bridge' : ctr.network);
    h = makeContainerHost(uni, ctr.id.slice(0, 12), { base: img.base, files: img.files, users: img.users, binaries: img.binaries, packages: img.packages, ip });
    h.promptName = ctr.id.slice(0, 12);
    h.container = ctr;
    h.env = { ...ctr.env, HOSTNAME: ctr.id.slice(0, 12) };
    h.writeSys('/etc/hostname', ctr.id.slice(0, 12) + '\n');
    h.writeSys('/etc/hosts', `127.0.0.1\tlocalhost\n${ip}\t${ctr.id.slice(0, 12)}\n`);
    h.memMB = ctr.memory || engine.host.memMB;
    ctr.h = h; ctr.ip = ip;
    uni.byIp.set(ip, h);
    // name resolution: only on user-defined networks (like real Docker)
    h.containerNet = (name) => {
      const net = engine.networks.get(ctr.network);
      if (!net?.dns) return null;
      for (const o of engine.containers.values()) if (o.status === 'running' && o.network === ctr.network && o.aliases.includes(name)) return o.ip;
      return null;
    };
    volumeFiles(engine, ctr, h);
  }
  // official images refuse to start without required settings
  const argv0 = resolveCommand(img, ctr.cmd)[0]?.split('/').pop();
  if (img.base?.postgres && argv0 === 'postgres' && !ctr.env.POSTGRES_PASSWORD) return exitWith(engine, ctr, 1, ['Error: Database is uninitialized and superuser password is not specified.', '       You must specify POSTGRES_PASSWORD to a non-empty value for the', '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".']);
  if (img.base?.postgres) h.labDbPassword = ctr.env.POSTGRES_PASSWORD;
  const argv = resolveCommand(img, ctr.cmd);
  const sink = line => { ctr.logs.push({ time: uni.time, line }); if (ctr.logs.length > 2000) ctr.logs.splice(0, 500); };
  ctr.status = 'running'; ctr.started = uni.time; ctr.exitCode = null;
  if (!argv.length) return exitWith(engine, ctr, 0, []);
  const bin = argv[0].split('/').pop();
  if (!h.binaries.has(bin) && !['node', 'nginx', 'redis-server', 'postgres', 'python3', 'python', 'sleep', 'sh', 'bash', 'npm', 'gunicorn', 'uvicorn'].includes(bin)) return exitWith(engine, ctr, 127, [`docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "${argv[0]}": executable file not found in $PATH: unknown.`]);
  if (!h.binaries.has(bin) && ['sh', 'bash'].includes(bin)) return exitWith(engine, ctr, 127, [`exec: "${bin}": executable file not found in $PATH`]);
  let r;
  if (bin === 'nginx') {
    const prog = new Nginx({ host: h, uni });
    const s = prog.start();
    if (!s.ok) return exitWith(engine, ctr, 1, s.logs);
    const proc = h.addProc({ cmd: 'nginx: master process nginx -g daemon off;', user: 'root', mem: 8, program: prog });
    prog.proc = proc;
    for (const p of s.ports) h.listen(p.port, proc.pid, { addr: p.addr, program: prog });
    r = { ok: true, proc, logs: ['/docker-entrypoint.sh: Configuration complete; ready for start up'] };
  } else if ((bin === 'sleep' && argv[1] !== '0') || (bin === 'tail' && argv.includes('-f')) || ((bin === 'sh' || bin === 'bash') && argv.length === 1)) {
    const proc = h.addProc({ cmd: argv.join(' '), user: ctr.user, mem: 1 });
    r = { ok: true, proc, logs: [] };
    if (bin === 'sh' || bin === 'bash') ctr.interactiveShell = true;
  } else {
    // official database images start as root and drop to their own user
    const user = (img.base?.postgres && bin === 'postgres' && !ctr.userSet) ? 'postgres' : (img.base?.redis && bin === 'redis-server' && !ctr.userSet) ? 'redis' : h.users.has(ctr.user) ? ctr.user : 'root';
    r = launch(h, argv, { uni, user, env: { ...h.env }, cwd: ctr.workdir, logSink: sink });
    if (r.notProgram || r.script !== undefined) {
      // an ordinary command (echo, ls, a script): run it to completion, its output is the log
      const sh = new Session(uni, h, { user, cwd: ctr.workdir });
      sh.advancePerCommand = 0;
      for (const [k, v] of Object.entries(h.env)) sh.setVar(sh.e, k, v, { exported: true });
      const line = (bin === 'sh' || bin === 'bash') && argv[1] === '-c' ? argv.slice(2).join(' ') : argv.map(x => /[\s'"$|;&<>]/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : x).join(' ');
      const mark = uni.events.length;
      const res = sh.run(r.script !== undefined ? `python3 ${argv.slice(1).join(' ')}` : line, { record: false });
      uni.events.length = mark;
      for (const l of res.out) sink(stripAnsi(l));
      return exitWith(engine, ctr, res.code, []);
    }
  }
  for (const l of r.logs || []) sink(l);
  if (!r.ok) return exitWith(engine, ctr, r.code ?? 1, []);
  if (r.oneShot || !r.proc) return exitWith(engine, ctr, 0, []);
  ctr.pid = r.proc.pid;
  if (ctr.memory && (r.proc.mem || 0) > ctr.memory) { r.proc.mem = ctr.memory; return exitWith(engine, ctr, 137, [], { oom: true }); }
  // published ports: a proxy on the docker host forwards to the container
  for (const p of ctr.ports) publish(engine, ctr, p);
  if (img.base?.postgres) sink('LOG:  database system is ready to accept connections');
  if (img.base?.redis) sink('* Ready to accept connections tcp');
  evalHealth(engine, ctr);
  uni.emit({ type: 'container-start', host: engine.host.name, id: ctr.id, name: ctr.name, image: ctr.imageRef });
  return { ok: true };
}

function exitWith(engine, ctr, code, lines, { oom = false } = {}) {
  for (const l of lines) ctr.logs.push({ time: engine.uni.time, line: l });
  stopProcesses(engine, ctr);
  ctr.status = 'exited'; ctr.exitCode = code; ctr.finished = engine.uni.time; ctr.oom = oom;
  engine.uni.emit({ type: 'container-exit', host: engine.host.name, id: ctr.id, name: ctr.name, code, oom });
  return { ok: false, code };
}

function stopProcesses(engine, ctr) {
  if (ctr.h) for (const p of [...ctr.h.procs.values()]) ctr.h.killProc(p.pid, 'TERM');
  for (const [port, l] of [...engine.host.listening]) if (l.program?.containerId === ctr.id) { engine.host.killProc(l.pid); engine.host.listening.delete(port); }
}

export function stopContainer(engine, ctr, { remove = false } = {}) {
  if (ctr.status === 'running') {
    syncVolumes(engine, ctr);
    stopProcesses(engine, ctr);
    ctr.status = 'exited'; ctr.exitCode = 0; ctr.finished = engine.uni.time; ctr.stoppedByUser = true;
  }
  if (remove) {
    syncVolumes(engine, ctr);
    if (ctr.ip) engine.uni.byIp.delete(ctr.ip);
    engine.containers.delete(ctr.id);
  }
}

function publish(engine, ctr, p) {
  const host = engine.host, uni = engine.uni;
  const prog = {
    kind: 'docker-proxy', containerId: ctr.id, memMB: 2,
    handle(req) {
      const r = httpRequest(uni, host, `http://${ctr.ip}:${p.container}${req.path}${req.query || ''}`, { method: req.method, headers: req.headers, body: req.body, depth: (req.depth || 0) + 1 });
      if (r.error === 'ECONNREFUSED') {
        const l = ctr.h?.listening.get(p.container);
        return { error: 'RESET', detail: l && l.addr === '127.0.0.1' ? 'Recv failure: Connection reset by peer' : 'Recv failure: Connection reset by peer' };
      }
      if (r.error) return { error: 'RESET', detail: 'Recv failure: Connection reset by peer' };
      return r;
    },
  };
  const proc = host.addProc({ cmd: `/usr/bin/docker-proxy -proto tcp -host-ip ${p.ip || '0.0.0.0'} -host-port ${p.host} -container-ip ${ctr.ip} -container-port ${p.container}`, user: 'root', mem: 2, program: prog });
  host.listen(p.host, proc.pid, { addr: p.ip || '0.0.0.0', program: prog });
}

function evalHealth(engine, ctr) {
  const hc = ctr.healthcheck;
  if (!hc || ctr.status !== 'running') { ctr.health = null; return; }
  const sh = new Session(engine.uni, ctr.h, { user: 'root', cwd: ctr.workdir });
  sh.advancePerCommand = 0;
  const mark = engine.uni.events.length;
  const r = sh.run(hc.test.replace(/^CMD(-SHELL)?\s+/, ''), { record: false });
  engine.uni.events.length = mark;
  const prev = ctr.health;
  ctr.health = r.code === 0 ? 'healthy' : (ctr.healthFails = (ctr.healthFails || 0) + 1) >= 3 ? 'unhealthy' : (prev === 'healthy' ? 'healthy' : 'starting');
  if (r.code === 0) ctr.healthFails = 0;
  ctr.healthLog = r.out.map(stripAnsi).slice(-3);
}

export function installDockerTicker(uni) {
  uni.tickers.push(() => {
    for (const host of uni.hosts.values()) {
      const eng = host.docker;
      if (!eng) continue;
      for (const ctr of eng.containers.values()) {
        if (ctr.status === 'running' && ctr.pid && ctr.h && !ctr.h.procs.has(ctr.pid)) {
          exitWith(eng, ctr, 137, []);
        }
        if (ctr.status === 'exited' && !ctr.stoppedByUser && ['always', 'unless-stopped', 'on-failure'].includes(ctr.restart) && (ctr.restart !== 'on-failure' || ctr.exitCode !== 0)) {
          const wait = Math.min(60, 2 ** Math.min(ctr.restarts, 5));
          if (uni.time - (ctr.finished || 0) >= wait) { ctr.restarts++; startContainer(eng, ctr); }
        }
        if (ctr.status === 'running' && ctr.healthcheck && (!ctr.lastHealth || uni.time - ctr.lastHealth >= 10)) { ctr.lastHealth = uni.time; evalHealth(eng, ctr); }
      }
    }
  });
}

// ---------------------------------------------------------------- CLI

const ago = (uni, t) => { const s = Math.max(1, uni.time - t); return s < 60 ? `${s} seconds ago` : s < 3600 ? `${Math.round(s / 60)} minutes ago` : s < 86400 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`; };
const dur = s => s < 60 ? `${Math.max(1, s)} seconds` : s < 3600 ? `${Math.round(s / 60)} minutes` : `${Math.round(s / 3600)} hours`;

function findContainer(engine, ref) {
  if (!ref) return null;
  for (const c of engine.containers.values()) if (c.name === ref || c.id.startsWith(ref)) return c;
  return null;
}

function parsePorts(list) {
  return list.map(s => {
    const parts = s.split(':');
    if (parts.length === 3) return { ip: parts[0], host: Number(parts[1]), container: Number(parts[2].split('/')[0]) };
    if (parts.length === 2) return { host: Number(parts[0]), container: Number(parts[1].split('/')[0]) };
    return { host: Number(parts[0]), container: Number(parts[0]) };
  });
}

function parseVolumes(c, list) {
  return list.map(s => {
    const [src, target, mode] = s.split(':');
    if (!target) return { type: 'volume', source: shortId().slice(0, 12), target: src };
    if (src.startsWith('/') || src.startsWith('.') || src.startsWith('~')) return { type: 'bind', source: c.resolve(src), target, ro: mode === 'ro' };
    return { type: 'volume', source: src, target, ro: mode === 'ro' };
  });
}

function needDocker(c) {
  const eng = engineOf(c.host, c.uni);
  if (c.user !== 'root' && !c.host.userGroups(c.user).includes('docker')) throw new SimError('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: permission denied', 1);
  return eng;
}

function collectMulti(args, flag, long) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag || args[i] === long) out.push(args[i + 1]); else if (long && args[i].startsWith(long + '=')) out.push(args[i].slice(long.length + 1));
  return out;
}

function runCmd(c, eng, args) {
  // docker run [opts] image [cmd…]
  const a = [...args];
  const o = { env: {}, ports: [], volumes: [], detach: false, rm: false, it: false, name: null, network: 'bridge', restart: 'no', user: null, workdir: null, memory: null, envFiles: [], healthCmd: null };
  let i = 0;
  for (; i < a.length; i++) {
    const x = a[i];
    if (!x.startsWith('-')) break;
    const val = () => a[++i];
    if (x === '-d' || x === '--detach') o.detach = true;
    else if (x === '--rm') o.rm = true;
    else if (/^-(it|ti|i|t)$/.test(x)) o.it = o.it || x.includes('t');
    else if (x === '-dit' || x === '-itd') { o.it = true; o.detach = true; }
    else if (x === '--name') o.name = val();
    else if (x === '-p' || x === '--publish') o.ports.push(val());
    else if (x === '-P') { /* publish all: ignore */ }
    else if (x === '-e' || x === '--env') { const kv = val(); const k = kv.indexOf('='); if (k > 0) o.env[kv.slice(0, k)] = kv.slice(k + 1); else if (c.env[kv] !== undefined) o.env[kv] = c.env[kv]; }
    else if (x === '--env-file') o.envFiles.push(val());
    else if (x === '-v' || x === '--volume') o.volumes.push(val());
    else if (x === '--network' || x === '--net') o.network = val();
    else if (x === '--restart') o.restart = val();
    else if (x === '-u' || x === '--user') o.user = val();
    else if (x === '-w' || x === '--workdir') o.workdir = val();
    else if (x === '-m' || x === '--memory') { const m = String(val()).match(/^(\d+)([mMgG]?)/); o.memory = m ? Number(m[1]) * (/[gG]/.test(m[2]) ? 1024 : 1) : null; }
    else if (x === '--health-cmd') o.healthCmd = val();
    else if (x.startsWith('--name=')) o.name = x.slice(7);
    else if (x.startsWith('--network=')) o.network = x.slice(10);
    else if (x.startsWith('--restart=')) o.restart = x.slice(10);
    else if (x.startsWith('--memory=')) { const m = x.slice(9).match(/^(\d+)([mMgG]?)/); o.memory = m ? Number(m[1]) * (/[gG]/.test(m[2]) ? 1024 : 1) : null; }
    else if (x === '--cpus' || x === '--platform' || x === '--label' || x === '-l' || x === '--hostname' || x === '-h') val();
    else if (x === '--privileged' || x === '--init' || x === '-q') { if (x === '--privileged') o.privileged = true; }
    else return c.fail(`unknown flag: ${x}\nSee 'docker run --help'.`, 125);
  }
  const ref = a[i];
  if (!ref) return c.fail('"docker run" requires at least 1 argument.\nSee \'docker run --help\'.\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]', 125);
  let img = eng.findImage(ref);
  if (!img) {
    c.eprint(`Unable to find image '${parseRef(ref).short}' locally`);
    img = eng.pullImage(ref, { out: (...l) => c.eprint(...l) });
    if (!img) return 125;
  }
  for (const f of o.envFiles) {
    const t = c.host.files.get(c.resolve(f));
    if (t === undefined) return c.fail(`docker: open ${f}: no such file or directory.`, 125);
    for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Za-z_]\w*)=(.*)$/); if (m) o.env[m[1]] = m[2]; }
  }
  const cmd = a.slice(i + 1);
  let ctr;
  try {
    ctr = createContainer(eng, img, { name: o.name, env: o.env, ports: parsePorts(o.ports), network: o.network, volumes: parseVolumes(c, o.volumes), cmd: cmd.length ? cmd : null, restart: o.restart, user: o.user, workdir: o.workdir, memory: o.memory, healthcheck: o.healthCmd ? { test: o.healthCmd } : undefined });
  } catch (e) { if (e instanceof SimError) return c.fail(e.message, e.code); throw e; }
  ctr.privileged = !!o.privileged;
  const r = startContainer(eng, ctr);
  c.uni.emit({ type: 'docker-run', host: c.host.name, id: ctr.id, name: ctr.name, image: ctr.imageRef, ok: r.ok });
  if (o.it && ctr.interactiveShell && ctr.status === 'running') {
    c.sh.enter(ctr.h, ctr.h.users.has(ctr.user) ? ctr.user : 'root', { kind: 'exec', cwd: ctr.workdir });
    c.sh.e.onExit = () => { stopContainer(eng, ctr, { remove: o.rm }); };
    return 0;
  }
  if (o.detach) {
    if (!r.ok && ctr.logs.some(l => /OCI runtime|executable file not found/.test(l.line))) { c.eprint(ctr.logs.map(l => l.line).join('\n')); return 127; }
    c.print(ctr.id);
    return 0;
  }
  // attached: show the output; long-running servers are left running in the background with a note
  for (const l of ctr.logs) c.print(l.line);
  if (ctr.status === 'running' && !ctr.interactiveShell) {
    c.eprint(C.dim(`(the container keeps running and would hold this terminal; the simulator detached it for you. Next time use -d. See it with: docker ps)`));
    return 0;
  }
  const code = ctr.exitCode ?? 0;
  if (o.rm) stopContainer(eng, ctr, { remove: true });
  return code;
}

function psCmd(c, eng, args) {
  const all = args.includes('-a') || args.includes('--all');
  const quiet = args.includes('-q');
  const rows = [...eng.containers.values()].filter(x => all || x.status === 'running').sort((a, b) => b.created - a.created);
  if (quiet) { for (const x of rows) c.print(x.id.slice(0, 12)); return 0; }
  const status = x => x.status === 'running' ? `Up ${dur(c.uni.time - x.started)}${x.health ? ` (${x.health})` : ''}` : x.status === 'created' ? 'Created' : `Exited (${x.exitCode}) ${ago(c.uni, x.finished)}`;
  const ports = x => x.status === 'running' ? x.ports.map(p => `${p.ip || '0.0.0.0'}:${p.host}->${p.container}/tcp`).join(', ') : '';
  const cmdOf = x => `"${resolveCommand(x.image, x.cmd).join(' ').slice(0, 20)}${resolveCommand(x.image, x.cmd).join(' ').length > 20 ? '…' : ''}"`;
  const head = ['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES'];
  const data = rows.map(x => [x.id.slice(0, 12), x.imageRef, cmdOf(x), ago(c.uni, x.created), status(x), ports(x), x.name]);
  const w = head.map((h, k) => Math.max(h.length, ...data.map(r => r[k].length)));
  c.print(head.map((h, k) => h.padEnd(w[k])).join('   ').trimEnd());
  for (const r of data) c.print(r.map((v, k) => v.padEnd(w[k])).join('   ').trimEnd());
  return 0;
}

function imagesCmd(c, eng) {
  const rows = [];
  for (const img of eng.images.values()) {
    const tags = [...img.tags];
    if (!tags.length) rows.push(['<none>', '<none>', img.id.slice(0, 12), ago(c.uni, img.created), fmtMB(img.sizeMB)]);
    for (const t of tags) { const p = parseRef(t); rows.push([p.name, p.tag, img.id.slice(0, 12), ago(c.uni, img.created), fmtMB(img.sizeMB)]); }
  }
  const head = ['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE'];
  const w = head.map((h, k) => Math.max(h.length, ...rows.map(r => r[k].length)));
  c.print(head.map((h, k) => h.padEnd(w[k])).join('   ').trimEnd());
  for (const r of rows) c.print(r.map((v, k) => v.padEnd(w[k])).join('   ').trimEnd());
  return 0;
}

function execCmd(c, eng, args) {
  const a = [...args];
  let it = false, user = null, workdir = null;
  const env = {};
  while (a[0]?.startsWith('-')) {
    const x = a.shift();
    if (/^-(it|ti|i|t)$/.test(x)) it = true;
    else if (x === '-u' || x === '--user') user = a.shift();
    else if (x === '-w' || x === '--workdir') workdir = a.shift();
    else if (x === '-e' || x === '--env') { const kv = a.shift(); const k = kv.indexOf('='); env[kv.slice(0, k)] = kv.slice(k + 1); }
    else if (x === '-d') { /* detached */ }
    else return c.fail(`unknown flag: ${x}`, 125);
  }
  const ctr = findContainer(eng, a.shift());
  if (!ctr) return c.fail(`Error response from daemon: No such container: ${args.find(x => !x.startsWith('-'))}`, 1);
  if (ctr.status !== 'running') return c.fail(`Error response from daemon: container ${ctr.id} is not running`, 1);
  if (!a.length) return c.fail('"docker exec" requires at least 2 arguments.', 1);
  const bin = a[0].split('/').pop();
  if (!ctr.h.binaries.has(bin) && !['echo', 'cd', 'pwd', 'export', 'true', 'false', 'test', '[', 'printf'].includes(bin)) return c.fail(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${a[0]}": executable file not found in $PATH: unknown`, 126);
  const u = user || ctr.user;
  const asUser = ctr.h.users.has(u) ? u : 'root';
  if (it && ['sh', 'bash', 'ash'].includes(bin) && a.length === 1) {
    c.sh.enter(ctr.h, asUser, { kind: 'exec', cwd: workdir || ctr.workdir, env: { ...ctr.env, ...env } });
    c.sh.e.onExit = () => syncVolumes(eng, ctr);
    c.uni.emit({ type: 'docker-exec', host: c.host.name, name: ctr.name, cmd: a.join(' '), interactive: true });
    return 0;
  }
  const sh = new Session(c.uni, ctr.h, { user: asUser, cwd: workdir || ctr.workdir });
  sh.advancePerCommand = 0;
  for (const [k, v] of Object.entries({ ...ctr.env, ...env })) sh.setVar(sh.e, k, v, { exported: true });
  const line = (bin === 'sh' || bin === 'bash') && a[1] === '-c' ? a.slice(2).join(' ') : a.map(x => /[\s'"$]/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : x).join(' ');
  const r = sh.run(line, { record: false });
  if (r.out.length) c.print(...r.out);
  syncVolumes(eng, ctr);
  c.uni.emit({ type: 'docker-exec', host: c.host.name, name: ctr.name, cmd: a.join(' '), code: r.code });
  return r.code;
}

function inspectCmd(c, eng, refs, args) {
  const fmt = (args.find(x => x.startsWith('--format=')) || '').slice(9) || (args.includes('--format') || args.includes('-f') ? args[args.indexOf(args.includes('--format') ? '--format' : '-f') + 1] : null);
  const outs = [];
  for (const ref of refs) {
    const ctr = findContainer(eng, ref);
    const img = ctr ? null : eng.findImage(ref);
    if (!ctr && !img) return c.fail(`Error: No such object: ${ref}`, 1);
    const obj = ctr ? { Id: ctr.id, Name: '/' + ctr.name, Created: new Date(ctr.created * 1000).toISOString(), State: { Status: ctr.status, Running: ctr.status === 'running', ExitCode: ctr.exitCode ?? 0, OOMKilled: !!ctr.oom, Health: ctr.health ? { Status: ctr.health, Log: ctr.healthLog } : undefined }, RestartCount: ctr.restarts, Config: { Image: ctr.imageRef, User: ctr.user, Env: Object.entries(ctr.env).map(([k, v]) => `${k}=${v}`), Cmd: resolveCommand(ctr.image, ctr.cmd), WorkingDir: ctr.workdir }, HostConfig: { RestartPolicy: { Name: ctr.restart }, Memory: (ctr.memory || 0) * 1048576, Privileged: !!ctr.privileged }, Mounts: ctr.volumes.map(v => ({ Type: v.type, Source: v.type === 'volume' ? `/var/lib/docker/volumes/${v.source}/_data` : v.source, Destination: v.target, Name: v.type === 'volume' ? v.source : undefined })), NetworkSettings: { Networks: { [ctr.network]: { IPAddress: ctr.ip || '', Aliases: ctr.aliases } }, Ports: Object.fromEntries(ctr.ports.map(p => [`${p.container}/tcp`, [{ HostIp: p.ip || '0.0.0.0', HostPort: String(p.host) }]])) } }
      : { Id: 'sha256:' + img.id, RepoTags: [...img.tags], Created: new Date(img.created * 1000).toISOString(), Size: Math.round(img.sizeMB * 1e6), Config: { User: img.config.user || '', Env: Object.entries(img.config.env || {}).map(([k, v]) => `${k}=${v}`), Cmd: img.config.cmd, Entrypoint: img.config.entrypoint, WorkingDir: img.config.workdir, ExposedPorts: Object.fromEntries((img.config.exposed || []).map(p => [`${p}/tcp`, {}])), Healthcheck: img.config.healthcheck ? { Test: ['CMD-SHELL', img.config.healthcheck.test] } : undefined, Labels: img.config.labels || null }, RootFS: { Layers: img.layers.map(() => 'sha256:' + shortId()) } };
    if (fmt) {
      outs.push(fmt.replace(/\{\{\s*(?:json\s+)?\.([\w.]+)\s*\}\}/g, (_, path) => { let v = obj; for (const k of path.split('.')) v = v?.[k]; return typeof v === 'object' ? JSON.stringify(v) : String(v ?? '<no value>'); }));
    } else outs.push(JSON.stringify([obj], null, 4));
  }
  c.print(...outs);
  return 0;
}

def('docker', c => {
  const [sub, ...rest] = c.args;
  if (!sub || sub === '--help' || sub === 'help') { c.print('Usage:  docker [OPTIONS] COMMAND', '', 'Common Commands:', '  run         Create and run a new container from an image', '  exec        Execute a command in a running container', '  ps          List containers', '  build       Build an image from a Dockerfile', '  pull        Download an image from a registry', '  push        Upload an image to a registry', '  images      List images', '  login       Log in to a registry', '  logs        Fetch the logs of a container', '  stop / start / restart / rm', '  inspect     Return low-level information on Docker objects', '  history     Show the history of an image', '  network / volume / system', '  compose     Docker Compose'); return 0; }
  if (sub === '--version' || sub === 'version' && !rest.length) { c.print('Docker version 27.3.1, build ce12230'); return 0; }
  let eng;
  try { eng = needDocker(c); } catch (e) { return c.fail(e.message, e.code); }
  const uni = c.uni;
  switch (sub) {
    case 'run': return runCmd(c, eng, rest);
    case 'ps': return psCmd(c, eng, rest);
    case 'container': {
      if (rest[0] === 'ls') return psCmd(c, eng, rest.slice(1));
      if (rest[0] === 'prune') { let n = 0; for (const x of [...eng.containers.values()]) if (x.status !== 'running') { stopContainer(eng, x, { remove: true }); n++; } c.print(`Deleted Containers: ${n}`, '', 'Total reclaimed space: 0B'); return 0; }
      return c.sh.runArgv(['docker', ...rest], c.e, c.io, c.result, {});
    }
    case 'images': return imagesCmd(c, eng);
    case 'image': {
      if (rest[0] === 'ls') return imagesCmd(c, eng);
      if (rest[0] === 'prune') { let n = 0; for (const [id, img] of [...eng.images]) if (!img.tags.size && ![...eng.containers.values()].some(x => x.image === img)) { eng.images.delete(id); n++; } c.print(`Deleted Images: ${n}`); return 0; }
      return c.sh.runArgv(['docker', ...rest], c.e, c.io, c.result, {});
    }
    case 'pull': {
      const ref = rest.find(x => !x.startsWith('-'));
      if (!ref) return c.fail('"docker pull" requires exactly 1 argument.', 1);
      const img = eng.pullImage(ref, { out: (...l) => c.print(...l) });
      return img ? 0 : 1;
    }
    case 'build': {
      const o = opts(rest, { bool: ['--no-cache', '-q', '--pull'], val: ['-t', '--tag', '-f', '--file', '--build-arg', '--target', '--platform'], alias: { '--tag': '-t', '--file': '-f' } });
      const tags = collectMulti(rest, '-t', '--tag');
      const buildArgs = Object.fromEntries(collectMulti(rest, '--build-arg', '--build-arg').map(kv => [kv.split('=')[0], kv.split('=').slice(1).join('=')]));
      const ctxArg = o._[0];
      if (!ctxArg) return c.fail('ERROR: "docker buildx build" requires exactly 1 argument.\nSee \'docker buildx build --help\'.\n\nUsage:  docker buildx build [OPTIONS] PATH | URL | -', 1);
      const ctx = c.resolve(ctxArg);
      if (!c.host.isDir(ctx)) return c.fail(`ERROR: unable to prepare context: path "${ctxArg}" not found`, 1);
      for (const t of tags) if (/[A-Z]/.test(t.split(':')[0])) return c.fail(`ERROR: invalid tag "${t}": repository name must be lowercase`, 1);
      const r = dockerBuild(eng, { contextDir: ctx, dockerfile: o['-f'], tags, buildArgs, noCache: o['--no-cache'], target: o['--target'] });
      for (const l of r.log) c.eprint(l);
      const steps = r.log.filter(l => /^ => (CACHED )?\[/.test(l)).map(l => ({ cached: / => CACHED/.test(l), text: l.replace(/^ => (CACHED )?\[[^\]]*\]\s*/, '').replace(/\s+[\d.]+[kMG]?B$/, '') }));
      uni.emit({ type: 'docker-build', host: c.host.name, ok: r.ok, tags, image: r.image?.id, sizeMB: r.image?.sizeMB, cached: steps.filter(x => x.cached).length, steps, context: ctx });
      if (!r.ok) { c.eprint(C.red(r.error)); return 1; }
      return 0;
    }
    case 'history': {
      const img = eng.findImage(rest.find(x => !x.startsWith('-')));
      if (!img) return c.fail(`Error response from daemon: No such image: ${rest[0]}`, 1);
      c.print('IMAGE          CREATED         CREATED BY                                      SIZE');
      [...img.layers].reverse().forEach((l, k) => c.print(`${k === 0 ? img.id.slice(0, 12) : '<missing>   '}   ${ago(c.uni, l.created).padEnd(14)}  ${l.by.slice(0, 45).padEnd(46)}  ${fmtMB(l.sizeMB)}`));
      return 0;
    }
    case 'tag': {
      const [src, dst] = rest;
      const img = eng.findImage(src);
      if (!img) return c.fail(`Error response from daemon: No such image: ${src}`, 1);
      eng.tag(img, dst);
      return 0;
    }
    case 'rmi': case 'image rm': {
      let code = 0;
      for (const ref of rest.filter(x => !x.startsWith('-'))) {
        const img = eng.findImage(ref);
        if (!img) { c.eprint(`Error response from daemon: No such image: ${ref}`); code = 1; continue; }
        const user = [...eng.containers.values()].find(x => x.image === img);
        if (user && !rest.includes('-f')) { c.eprint(`Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container ${user.id.slice(0, 12)} is using its referenced image ${img.id.slice(0, 12)}`); code = 1; continue; }
        const p = parseRef(ref);
        if (img.tags.has(p.short) && img.tags.size > 1) { img.tags.delete(p.short); eng.tags.delete(p.short); c.print(`Untagged: ${p.short}`); continue; }
        for (const t of img.tags) { eng.tags.delete(t); c.print(`Untagged: ${t}`); }
        eng.images.delete(img.id);
        c.print(`Deleted: sha256:${img.id}`);
      }
      return code;
    }
    case 'login': {
      const o = opts(rest, { bool: ['--password-stdin'], val: ['-u', '--username', '-p', '--password'], alias: { '--username': '-u', '--password': '-p' } });
      const server = o._[0] || 'docker.io';
      const creds = uni.registryAuth?.[server];
      const pw = o['-p'] ?? (o['--password-stdin'] ? String(c.stdin || '').trim() : null);
      if (!o['-u'] || pw == null) return c.fail('Error: Cannot perform an interactive login from a non TTY device (use -u and --password-stdin)', 1);
      if (creds && (creds.user !== o['-u'] || creds.password !== pw)) return c.fail(`Error response from daemon: Get "https://${server}/v2/": unauthorized: incorrect username or password`, 1);
      eng.loggedIn.add(server);
      if (o['-p']) c.eprint('WARNING! Using --password via the CLI is insecure. Use --password-stdin.');
      c.print('Login Succeeded');
      uni.emit({ type: 'docker-login', host: c.host.name, server, stdin: !!o['--password-stdin'] });
      return 0;
    }
    case 'logout': { eng.loggedIn.delete(rest[0] || 'docker.io'); c.print(`Removing login credentials for ${rest[0] || 'https://index.docker.io/v1/'}`); return 0; }
    case 'push': {
      const ref = rest.find(x => !x.startsWith('-'));
      const img = eng.findImage(ref);
      const p = parseRef(ref || '');
      if (!img) return c.fail(`An image does not exist locally with the tag: ${p.name}`, 1);
      if (p.registry === 'docker.io' && !p.repo.includes('/')) return c.fail(`denied: requested access to the resource is denied`, 1);
      if (!eng.loggedIn.has(p.registry)) return c.fail(`${p.tag === 'latest' ? 'Using default tag: latest\n' : ''}The push refers to repository [${p.name}]\nunauthorized: authentication required`, 1);
      const digest = 'sha256:' + shortId();
      const existing = uni.registry.get(p.short);
      c.print(`The push refers to repository [${p.name}]`, ...img.layers.slice(-4).map((l, k) => `${digest.slice(9 + k, 21 + k)}: ${existing ? 'Layer already exists' : 'Pushed'}`), `${p.tag}: digest: ${digest} size: ${1200 + img.layers.length * 211}`);
      uni.registry.set(p.short, { image: { ...img, tags: undefined }, digest, private: p.registry !== 'docker.io', pushed: uni.time });
      uni.emit({ type: 'docker-push', host: c.host.name, ref: p.short, digest });
      return 0;
    }
    case 'logs': {
      const o = opts(rest, { bool: ['-f', '--follow', '-t', '--timestamps'], val: ['--tail', '-n', '--since'] });
      const ctr = findContainer(eng, o._[0]);
      if (!ctr) return c.fail(`Error response from daemon: No such container: ${o._[0]}`, 1);
      let lines = ctr.logs;
      const n = o['--tail'] ?? o['-n'];
      if (n !== undefined && n !== 'all') lines = lines.slice(-Number(n));
      for (const l of lines) c.print((o['-t'] || o['--timestamps'] ? new Date(l.time * 1000).toISOString() + ' ' : '') + l.line);
      if (o['-f'] || o['--follow']) c.eprint(C.dim('(docker logs -f keeps following in a real terminal; this is what is there now)'));
      return 0;
    }
    case 'exec': return execCmd(c, eng, rest);
    case 'stop': case 'kill': case 'start': case 'restart': case 'rm': case 'pause': {
      const o = opts(rest, { bool: ['-f', '--force', '-v'], val: ['-t', '--time', '-s'] });
      let code = 0;
      for (const ref of o._) {
        const ctr = findContainer(eng, ref);
        if (!ctr) { c.eprint(`Error response from daemon: No such container: ${ref}`); code = 1; continue; }
        if (sub === 'rm') {
          if (ctr.status === 'running' && !o['-f'] && !o['--force']) { c.eprint(`Error response from daemon: cannot remove container "/${ctr.name}": container is running: stop the container before removing or force remove`); code = 1; continue; }
          stopContainer(eng, ctr, { remove: true });
        } else if (sub === 'start') { ctr.stoppedByUser = false; startContainer(eng, ctr); }
        else if (sub === 'restart') { stopContainer(eng, ctr); ctr.stoppedByUser = false; startContainer(eng, ctr); }
        else stopContainer(eng, ctr);
        c.print(ref);
        uni.emit({ type: 'docker-' + sub, host: c.host.name, name: ctr.name });
      }
      return code;
    }
    case 'top': {
      const ctr = findContainer(eng, rest[0]);
      if (!ctr) return c.fail(`Error response from daemon: No such container: ${rest[0]}`, 1);
      if (ctr.status !== 'running') return c.fail(`Error response from daemon: container ${ctr.id} is not running`, 1);
      const k = [...eng.containers.values()].indexOf(ctr) + 1;
      c.print('UID        PID       PPID      CMD');
      for (const p of ctr.h.procs.values()) c.print(`${(c.host.users.has(p.user) ? p.user : String(ctr.h.users.get(p.user)?.uid ?? p.user)).padEnd(10)} ${String(20000 + k * 100 + (p.pid % 100)).padEnd(9)} ${String(19000 + k).padEnd(9)} ${p.cmd}`);
      return 0;
    }
    case 'inspect': return inspectCmd(c, eng, rest.filter((x, k) => !x.startsWith('-') && !['--format', '-f'].includes(rest[k - 1])), rest);
    case 'stats': {
      c.print('CONTAINER ID   NAME             CPU %     MEM USAGE / LIMIT     MEM %     NET I/O');
      for (const x of eng.containers.values()) if (x.status === 'running') { const mem = [...x.h.procs.values()].reduce((s, p) => s + (p.mem || 0), 0); const lim = x.memory || c.host.memMB; c.print(`${x.id.slice(0, 12)}   ${x.name.padEnd(16)} ${(0.3 + mem / 200).toFixed(2).padStart(5)}%    ${(mem + 'MiB').padStart(8)} / ${(lim >= 1024 ? (lim / 1024).toFixed(2) + 'GiB' : lim + 'MiB').padEnd(9)} ${((mem / lim) * 100).toFixed(2).padStart(6)}%    1.2kB / 0B`); }
      if (rest.includes('--no-stream') === false) c.eprint(C.dim('(docker stats refreshes live; one snapshot shown)'));
      return 0;
    }
    case 'network': {
      const [op, ...more] = rest;
      if (op === 'ls') { c.print('NETWORK ID     NAME              DRIVER    SCOPE'); for (const n of eng.networks.values()) c.print(`${shortId().slice(0, 12)}   ${n.name.padEnd(17)} ${n.driver.padEnd(9)} local`); return 0; }
      if (op === 'create') { const name = more.filter(x => !x.startsWith('-')).pop(); if (eng.networks.has(name)) return c.fail(`Error response from daemon: network with name ${name} already exists`, 1); eng.networks.set(name, { name, driver: 'bridge', subnet: `172.${netSeq++}.${c.host.dockerIndex}.0/24`, next: 2, dns: true }); c.print(shortId()); uni.emit({ type: 'docker-network', name }); return 0; }
      if (op === 'rm') { for (const n of more) eng.networks.delete(n); c.print(...more); return 0; }
      if (op === 'connect') { const [net, ref] = more; const ctr = findContainer(eng, ref); if (!ctr || !eng.networks.has(net)) return c.fail('Error response from daemon: network or container not found', 1); ctr.network = net; c.uni.byIp.delete(ctr.ip); ctr.ip = eng.allocIp(net); ctr.h.ip = ctr.ip; c.uni.byIp.set(ctr.ip, ctr.h); return 0; }
      if (op === 'inspect') { const n = eng.networks.get(more[0]); if (!n) return c.fail(`Error: No such network: ${more[0]}`, 1); c.print(JSON.stringify([{ Name: n.name, Driver: n.driver, IPAM: { Config: [{ Subnet: n.subnet }] }, Containers: Object.fromEntries([...eng.containers.values()].filter(x => x.network === n.name && x.status === 'running').map(x => [x.id, { Name: x.name, IPv4Address: x.ip + '/24' }])) }], null, 4)); return 0; }
      return c.fail(`docker network ${op}: unknown command`, 1);
    }
    case 'volume': {
      const [op, ...more] = rest;
      if (op === 'ls') { c.print('DRIVER    VOLUME NAME'); for (const v of eng.volumes.values()) c.print(`local     ${v.name}`); return 0; }
      if (op === 'create') { const name = more[0] || shortId(); if (!eng.volumes.has(name)) eng.volumes.set(name, { name, files: null, created: uni.time }); c.print(name); return 0; }
      if (op === 'rm') { for (const n of more) { if ([...eng.containers.values()].some(x => x.volumes.some(v => v.source === n))) { c.eprint(`Error response from daemon: remove ${n}: volume is in use`); return 1; } eng.volumes.delete(n); uni.emit({ type: 'docker-volume-deleted', name: n }); c.print(n); } return 0; }
      if (op === 'prune') { const gone = []; for (const v of [...eng.volumes.keys()]) if (![...eng.containers.values()].some(x => x.volumes.some(y => y.source === v)) && (more.includes('-a') || more.includes('--all') || /^[0-9a-f]{12}$|_anon_/.test(v))) { eng.volumes.delete(v); gone.push(v); uni.emit({ type: 'docker-volume-deleted', name: v }); } c.print('Deleted Volumes:', ...gone, '', `Total reclaimed space: ${gone.length ? '312MB' : '0B'}`); return 0; }
      if (op === 'inspect') { const v = eng.volumes.get(more[0]); if (!v) return c.fail(`Error: No such volume: ${more[0]}`, 1); c.print(JSON.stringify([{ Name: v.name, Driver: 'local', Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, CreatedAt: new Date(v.created * 1000).toISOString() }], null, 4)); return 0; }
      return c.fail(`docker volume ${op}: unknown command`, 1);
    }
    case 'system': {
      if (rest[0] === 'df') { const imgs = [...eng.images.values()]; c.print('TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE', `Images          ${String(imgs.length).padEnd(9)} ${String(new Set([...eng.containers.values()].map(x => x.image)).size).padEnd(9)} ${fmtMB(imgs.reduce((s, i) => s + i.sizeMB, 0)).padEnd(9)} -`, `Containers      ${String(eng.containers.size).padEnd(9)} ${String([...eng.containers.values()].filter(x => x.status === 'running').length).padEnd(9)} 0B        0B`, `Local Volumes   ${String(eng.volumes.size).padEnd(9)} -         -         -`, `Build Cache     ${String(eng.cache.size).padEnd(9)} 0         -         -`); return 0; }
      if (rest[0] === 'prune') {
        let n = 0;
        for (const x of [...eng.containers.values()]) if (x.status !== 'running') { stopContainer(eng, x, { remove: true }); n++; }
        if (rest.includes('-a')) for (const [id, img] of [...eng.images]) if (![...eng.containers.values()].some(x => x.image === img)) { eng.images.delete(id); for (const t of img.tags) eng.tags.delete(t); }
        if (rest.includes('--volumes')) for (const v of [...eng.volumes.keys()]) if (![...eng.containers.values()].some(x => x.volumes.some(y => y.source === v))) { eng.volumes.delete(v); uni.emit({ type: 'docker-volume-deleted', name: v }); }
        eng.cache.clear();
        c.print('WARNING! This will remove all stopped containers and dangling images. Are you sure you want to continue? [y/N] y', `Deleted Containers: ${n}`, '', 'Total reclaimed space: 1.2GB');
        return 0;
      }
      return c.fail(`docker system ${rest[0]}: unknown command`, 1);
    }
    case 'compose': return composeCmd(c, eng, rest);
    case 'info': c.print('Client: Docker Engine - Community', ' Version:    27.3.1', 'Server:', ` Containers: ${eng.containers.size}`, ` Images: ${eng.images.size}`, ' Storage Driver: overlay2', ' Cgroup Driver: systemd'); return 0;
    case 'scout': case 'scan': return scoutCmd(c, eng, sub === 'scan' ? ['cves', ...rest] : rest);
  }
  return c.fail(`docker: '${sub}' is not a docker command.\nSee 'docker --help'`, 1);
}, { pkg: 'docker.io' });

// ---------------------------------------------------------------- scanning

// known vulnerabilities: what the base image ships, plus risky things added on top
export function vulnsOf(img) {
  const v = [...(img.base?.vulns || [0, 0, 0, 0])];
  const pk = new Set((img.packages || []).map(p => Array.isArray(p) ? p[0] : p));
  if (pk.has('build-essential')) { v[1] += 4; v[2] += 18; }
  if (pk.has('curl') && img.base?.os !== 'alpine') v[2] += 2;
  for (const [p, f] of Object.entries(img.files || {})) if (/node_modules\/lodash\/package\.json$/.test(p) && /"4\.17\.(1\d|20)"/.test(f.content || '')) v[0] += 1;
  return v;
}
const CVES = [['CVE-2024-6119', 'openssl', 'critical'], ['CVE-2024-45490', 'libexpat1', 'critical'], ['CVE-2024-2961', 'glibc', 'high'], ['CVE-2023-45853', 'zlib1g', 'high'], ['CVE-2024-37371', 'krb5', 'high'], ['CVE-2023-52425', 'expat', 'medium'], ['CVE-2024-28182', 'nghttp2', 'medium'], ['CVE-2023-50495', 'ncurses', 'medium'], ['CVE-2023-4039', 'gcc-12', 'low']];

function scoutCmd(c, eng, args) {
  const [op, ...rest] = args;
  const ref = rest.find(x => !x.startsWith('-'));
  if (!['cves', 'quickview'].includes(op) || !ref) return c.fail('Usage:  docker scout quickview IMAGE | docker scout cves IMAGE', 1);
  const img = eng.findImage(ref);
  if (!img) return c.fail(`ERROR could not find image ${ref}`, 1);
  const [cr, hi, me, lo] = vulnsOf(img);
  c.print(`    ✓ SBOM of image already cached, ${40 + img.layers.length * 37} packages indexed`, '');
  c.print(`  Target   │ ${ref.padEnd(28)} │ ${cr}C ${hi}H ${me}M ${lo}L`, `    digest │ ${img.id.slice(0, 12)}`, `  Base     │ ${(img.baseRef || '?').padEnd(28)} │ ${img.base?.vulns.join(' / ') || '-'}`);
  if (op === 'cves') {
    c.print('');
    const pick = [...CVES.filter(x => x[2] === 'critical').slice(0, cr), ...CVES.filter(x => x[2] === 'high').slice(0, Math.min(hi, 3)), ...CVES.filter(x => x[2] === 'medium').slice(0, Math.min(me, 2))];
    for (const [id, pkg, sev] of pick) c.print(`    ${sev === 'critical' ? C.red(sev.toUpperCase().padEnd(9)) : sev === 'high' ? C.yellow(sev.toUpperCase().padEnd(9)) : sev.toUpperCase().padEnd(9)} ${id.padEnd(16)} ${pkg}`);
    if (cr + hi + me + lo === 0) c.print(C.green('    No vulnerable packages detected'));
    c.print('', `  ${cr + hi + me + lo} vulnerabilities found in ${Math.max(1, Math.ceil((cr + hi + me + lo) / 3))} packages`, `    CRITICAL  ${cr}`, `    HIGH      ${hi}`, `    MEDIUM    ${me}`, `    LOW       ${lo}`);
  }
  if (img.base && (cr + hi) > 0) c.print('', C.dim(`  What's next: a smaller base usually removes most of these: try ${img.base.os === 'debian' ? (/slim/.test(img.baseRef) ? 'an -alpine tag or distroless' : 'a -slim or -alpine tag, or distroless') : 'updating the base image'}.`));
  c.uni.emit({ type: 'docker-scan', host: c.host.name, ref, image: img.id, counts: [cr, hi, me, lo] });
  const exitOn = (args.find(a => a.startsWith('--only-severity=')) || '').split('=')[1];
  if (args.includes('--exit-code') && (exitOn ? exitOn.split(',').some(sv => ({ critical: cr, high: hi, medium: me, low: lo })[sv] > 0) : cr + hi + me + lo > 0)) return 2;
  return 0;
}

// ---------------------------------------------------------------- compose

function loadCompose(c, file) {
  const path = c.resolve(file);
  const text = c.host.files.get(path);
  if (text === undefined) throw new SimError(`no configuration file provided: not found`, 1);
  let doc;
  try { doc = parseYaml(text); } catch (e) { throw new SimError(`yaml: ${e.message}`, 15); }
  if (!doc?.services) throw new SimError(`validating ${basename(path)}: (root) Additional property or missing "services"`, 15);
  const dir = dirname(path);
  const project = (doc.name || basename(dir)).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return { doc, dir, project, path };
}

function order(services) {
  const out = [];
  const seen = new Set();
  const visit = (n, stack = []) => {
    if (seen.has(n)) return;
    if (stack.includes(n)) throw new SimError(`dependency cycle detected: ${[...stack, n].join(' -> ')}`, 1);
    const dep = services[n]?.depends_on;
    for (const d of Array.isArray(dep) ? dep : Object.keys(dep || {})) { if (!services[d]) throw new SimError(`service "${n}" depends on undefined service "${d}": invalid compose project`, 15); visit(d, [...stack, n]); }
    seen.add(n); out.push(n);
  };
  for (const n of Object.keys(services)) visit(n);
  return out;
}

function composeCmd(c, eng, args) {
  const a = [...args];
  let file = 'compose.yaml';
  const fi = a.indexOf('-f');
  if (fi >= 0) { file = a[fi + 1]; a.splice(fi, 2); }
  else if (!c.host.files.has(c.resolve('compose.yaml')) && c.host.files.has(c.resolve('docker-compose.yml'))) file = 'docker-compose.yml';
  else if (!c.host.files.has(c.resolve('compose.yaml')) && c.host.files.has(c.resolve('compose.yml'))) file = 'compose.yml';
  const [sub, ...rest] = a;
  let cfg;
  try { cfg = loadCompose(c, file); } catch (e) { if (sub === 'version') { c.print('Docker Compose version v2.29.7'); return 0; } return c.fail(e.message, e.code); }
  const { doc, dir, project } = cfg;
  const services = doc.services;
  const netName = `${project}_default`;
  const ctrOf = svc => [...eng.containers.values()].find(x => x.project === project && x.service === svc);
  const envOf = (s) => {
    const env = {};
    for (const f of [].concat(s.env_file || [])) { const t = c.host.files.get(normPath(dir + '/' + f)); if (t === undefined) throw new SimError(`env file ${normPath(dir + '/' + f)} not found: stat ${normPath(dir + '/' + f)}: no such file or directory`, 1); for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Za-z_]\w*)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } }
    if (Array.isArray(s.environment)) for (const kv of s.environment) { const k = String(kv).indexOf('='); env[String(kv).slice(0, k)] = String(kv).slice(k + 1); }
    else for (const [k, v] of Object.entries(s.environment || {})) env[k] = String(v ?? '');
    // ${VAR} interpolation from the shell environment and .env
    const dotenv = {};
    const t = c.host.files.get(dir + '/.env');
    if (t) for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Za-z_]\w*)=(.*)$/); if (m) dotenv[m[1]] = m[2]; }
    for (const k of Object.keys(env)) env[k] = env[k].replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, n, d) => c.env[n] ?? dotenv[n] ?? d ?? '');
    return env;
  };
  const out = (...l) => c.eprint(...l);
  switch (sub) {
    case 'config': { c.print(c.host.files.get(cfg.path)); return 0; }
    case 'build': case 'up': {
      const detach = rest.includes('-d') || rest.includes('--detach');
      const forceBuild = sub === 'build' || rest.includes('--build');
      let names;
      try { names = order(services); } catch (e) { return c.fail(e.message, e.code); }
      const only = rest.filter(x => !x.startsWith('-'));
      if (only.length) names = names.filter(n => only.includes(n) || only.some(o => (services[o]?.depends_on && (Array.isArray(services[o].depends_on) ? services[o].depends_on : Object.keys(services[o].depends_on)).includes(n))));
      // build
      for (const n of names) {
        const s = services[n];
        if (!s.build) continue;
        const tag = s.image || `${project}-${n}`;
        if (eng.findImage(tag) && !forceBuild) continue;
        const ctxDir = normPath(dir + '/' + (typeof s.build === 'string' ? s.build : s.build.context || '.'));
        const r = dockerBuild(eng, { contextDir: ctxDir, dockerfile: typeof s.build === 'object' ? s.build.dockerfile : null, tags: [tag] });
        out(...r.log.slice(0, 2), ...r.log.filter(l => /CACHED|RUN|COPY|ERROR/.test(l)).slice(-6));
        if (!r.ok) { out(C.red(`failed to solve: ${n}: ${r.error.replace(/^ERROR: failed to solve: /, '')}`)); return 17; }
      }
      if (sub === 'build') return 0;
      const created = [];
      if (!eng.networks.has(netName)) { eng.networks.set(netName, { name: netName, driver: 'bridge', subnet: `172.${netSeq++}.${c.host.dockerIndex}.0/24`, next: 2, dns: true }); created.push(` ${C.green('✔')} Network ${netName}  Created`); }
      for (const v of Object.keys(doc.volumes || {})) { const vn = `${project}_${v}`; if (!eng.volumes.has(vn)) { eng.volumes.set(vn, { name: vn, files: null, created: c.uni.time }); created.push(` ${C.green('✔')} Volume "${vn}"  Created`); } }
      for (const n of names) {
        const s = services[n];
        const existing = ctrOf(n);
        const want = JSON.stringify(s) + (s.build ? '' : String(eng.findImage(s.image)?.id || ''));
        if (existing && existing.status === 'running' && !forceBuild && existing.composeHash === want) { created.push(` ${C.green('✔')} Container ${existing.name}  Running`); continue; }
        if (existing) stopContainer(eng, existing, { remove: true });
        // wait for dependencies that must be healthy
        const deps = s.depends_on && !Array.isArray(s.depends_on) ? Object.entries(s.depends_on) : [];
        for (const [d, cond] of deps) {
          if (cond?.condition === 'service_healthy') {
            const dc = ctrOf(d);
            let waited = 0;
            while (dc && dc.health !== 'healthy' && waited < 60) { c.uni.advance(5); waited += 5; if (dc.healthcheck) evalHealth(eng, dc); }
            if (!dc || dc.health !== 'healthy') { out(C.red(` ✘ Container ${project}-${d}-1  Error`), `dependency failed to start: container ${project}-${d}-1 is unhealthy`); return 1; }
            created.push(` ${C.green('✔')} Container ${project}-${d}-1  Healthy`);
          }
        }
        let img = eng.findImage(s.build ? (s.image || `${project}-${n}`) : s.image);
        if (!img && s.image) { img = eng.pullImage(s.image, { out: () => {} }); if (img) created.push(` ${C.green('✔')} ${n} Pulled`); }
        if (!img) { out(C.red(`Error response from daemon: pull access denied for ${s.image}, repository does not exist or may require 'docker login'`)); return 18; }
        let env;
        try { env = envOf(s); } catch (e) { return c.fail(e.message, e.code); }
        const vols = (s.volumes || []).map(v => { const str = typeof v === 'string' ? v : `${v.source}:${v.target}`; const [src, target, mode] = str.split(':'); if (!target) return { type: 'volume', source: `${project}_anon_${n}`, target: src }; if (/^[./~]/.test(src)) return { type: 'bind', source: normPath(dir + '/' + src), target, ro: mode === 'ro' }; return { type: 'volume', source: `${project}_${src}`, target, ro: mode === 'ro' }; });
        for (const v of vols) if (v.type === 'volume' && !eng.volumes.has(v.source)) eng.volumes.set(v.source, { name: v.source, files: null, created: c.uni.time });
        const hc = s.healthcheck ? { test: [].concat(s.healthcheck.test).filter(x => x !== 'CMD' && x !== 'CMD-SHELL').join(' '), interval: s.healthcheck.interval || '30s' } : undefined;
        let ctr;
        try { ctr = createContainer(eng, img, { name: s.container_name || `${project}-${n}-1`, env, ports: parsePorts((s.ports || []).map(String)), network: netName, aliases: [n], volumes: vols, cmd: s.command ? (Array.isArray(s.command) ? s.command : String(s.command).split(/\s+/)) : null, restart: s.restart || 'no', user: s.user ? String(s.user) : null, project, service: n, healthcheck: hc, memory: s.mem_limit ? parseInt(s.mem_limit, 10) : null }); }
        catch (e) { if (e instanceof SimError) return c.fail(e.message, e.code); throw e; }
        ctr.composeHash = want;
        startContainer(eng, ctr);
        created.push(` ${C.green('✔')} Container ${ctr.name}  ${existing ? 'Recreated' : 'Started'}`);
      }
      out(`[+] Running ${created.length}/${created.length}`, ...created);
      c.uni.emit({ type: 'compose-up', host: c.host.name, project, services: names });
      if (!detach) { c.eprint(C.dim('(attached mode would stream logs and hold the terminal; the simulator detached. Use -d, then docker compose logs.)')); }
      return 0;
    }
    case 'pull': {
      const lines = [];
      for (const [n, s] of Object.entries(services)) {
        if (!s.image) continue;
        const img = eng.pullImage(s.image, { out: () => {} });
        lines.push(img ? ` ${C.green('✔')} ${n} Pulled` : C.red(` ✘ ${n} Error  pull access denied for ${s.image}`));
        if (!img) { out(...lines); return 18; }
      }
      out(`[+] Pulling ${lines.length}/${lines.length}`, ...lines);
      return 0;
    }
    case 'down': {
      const removed = [];
      for (const x of [...eng.containers.values()]) if (x.project === project) { stopContainer(eng, x, { remove: true }); removed.push(` ${C.green('✔')} Container ${x.name}  Removed`); }
      if (eng.networks.has(netName)) { eng.networks.delete(netName); removed.push(` ${C.green('✔')} Network ${netName}  Removed`); }
      if (rest.includes('-v') || rest.includes('--volumes')) for (const v of [...eng.volumes.keys()]) if (v.startsWith(project + '_')) { eng.volumes.delete(v); removed.push(` ${C.green('✔')} Volume ${v}  Removed`); c.uni.emit({ type: 'docker-volume-deleted', name: v }); }
      out(`[+] Running ${removed.length}/${removed.length}`, ...removed);
      c.uni.emit({ type: 'compose-down', host: c.host.name, project, volumes: rest.includes('-v') });
      return 0;
    }
    case 'ps': {
      c.print('NAME                IMAGE              SERVICE    STATUS                    PORTS');
      for (const x of eng.containers.values()) if (x.project === project && (x.status === 'running' || rest.includes('-a'))) c.print(`${x.name.padEnd(19)} ${x.imageRef.padEnd(18)} ${x.service.padEnd(10)} ${(x.status === 'running' ? `Up ${dur(c.uni.time - x.started)}${x.health ? ` (${x.health})` : ''}` : `Exited (${x.exitCode})`).padEnd(25)} ${x.ports.map(p => `0.0.0.0:${p.host}->${p.container}/tcp`).join(', ')}`);
      return 0;
    }
    case 'logs': {
      const svcs = rest.filter(x => !x.startsWith('-'));
      const tail = rest.includes('--tail') ? Number(rest[rest.indexOf('--tail') + 1]) : null;
      for (const n of svcs.length ? svcs : Object.keys(services)) { const x = ctrOf(n); if (!x) continue; for (const l of (tail ? x.logs.slice(-tail) : x.logs)) c.print(`${C.cyan(`${n}-1`.padEnd(10))} | ${l.line}`); }
      return 0;
    }
    case 'exec': {
      const r = [...rest];
      const flags = [];
      while (r[0]?.startsWith('-')) flags.push(r.shift());
      const x = ctrOf(r.shift());
      if (!x) return c.fail(`service "${rest.find(y => !y.startsWith('-'))}" is not running`, 1);
      return execCmd(c, eng, [...flags.includes('-T') ? [] : ['-it'], x.name, ...r]);
    }
    case 'restart': case 'stop': case 'start': {
      for (const n of rest.length ? rest : Object.keys(services)) { const x = ctrOf(n); if (!x) continue; if (sub !== 'start') stopContainer(eng, x); if (sub !== 'stop') { x.stoppedByUser = false; startContainer(eng, x); } c.eprint(` ${C.green('✔')} Container ${x.name}  ${sub === 'stop' ? 'Stopped' : 'Started'}`); }
      return 0;
    }
  }
  return c.fail(`unknown docker command: "compose ${sub}"`, 1);
}

export { findContainer };

// ---------------------------------------------------------------- client tools

def('redis-cli', c => {
  const a = [...c.args];
  let hostName = '127.0.0.1', port = 6379;
  const u = a.indexOf('-u'); if (u >= 0) { const m = String(a[u + 1]).match(/redis:\/\/(?:[^@]*@)?([^:/]+)(?::(\d+))?/); if (m) { hostName = m[1]; port = Number(m[2] || 6379); } a.splice(u, 2); }
  const hi = a.indexOf('-h'); if (hi >= 0) { hostName = a[hi + 1]; a.splice(hi, 2); }
  const pi = a.indexOf('-p'); if (pi >= 0) { port = Number(a[pi + 1]); a.splice(pi, 2); }
  const r = connect(c.uni, c.host, hostName, port);
  if (r.error) return c.fail(r.error === 'ENOTFOUND' ? `Could not connect to Redis at ${hostName}:${port}: Name or service not known` : `Could not connect to Redis at ${hostName}:${port}: Connection refused`, 1);
  const store = r.listener.program?.data || new Map();
  const [cmd, ...args] = a;
  switch ((cmd || 'ping').toLowerCase()) {
    case 'ping': c.print('PONG'); return 0;
    case 'set': store.set(args[0], args.slice(1).join(' ')); c.print('OK'); return 0;
    case 'get': c.print(store.has(args[0]) ? store.get(args[0]) : '(nil)'); return 0;
    case 'incr': { const v = Number(store.get(args[0]) || 0) + 1; store.set(args[0], String(v)); c.print(`(integer) ${v}`); return 0; }
    case 'del': c.print(`(integer) ${store.delete(args[0]) ? 1 : 0}`); return 0;
    case 'keys': { const re = new RegExp('^' + String(args[0] || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); const ks = [...store.keys()].filter(k => re.test(k)); if (!ks.length) c.print('(empty array)'); ks.forEach((k, i) => c.print(`${i + 1}) "${k}"`)); return 0; }
    case 'dbsize': c.print(`(integer) ${store.size}`); return 0;
    case 'info': c.print('# Server', 'redis_version:7.2.4', `# Keyspace`, `db0:keys=${store.size}`); return 0;
  }
  return c.fail(`(error) ERR unknown command '${cmd}'`, 1);
}, { pkg: 'redis-tools' });

def('pg_isready', c => {
  const hi = c.args.indexOf('-h'); const hostName = hi >= 0 ? c.args[hi + 1] : '127.0.0.1';
  const r = connect(c.uni, c.host, hostName, 5432);
  if (r.error) { c.print(`${hostName}:5432 - no response`); return 2; }
  c.print(`${hostName}:5432 - accepting connections`);
  return 0;
}, { pkg: 'postgresql-client' });

// A tiny psql: enough SQL to create a table, insert rows and read them back. Tables are
// stored in the database server's data directory, so they live exactly as long as it does.
function pgDataFile(server) { return (server.container ? (server.container.env.PGDATA || '/var/lib/postgresql/data') : '/var/lib/postgresql/16/main') + '/lumen_tables.json'; }
function splitValues(s) { const out = []; let cur = '', q = false; for (const ch of s) { if (ch === "'") { q = !q; continue; } if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; continue; } cur += ch; } if (cur.trim() || out.length) out.push(cur.trim()); return out; }
def('psql', c => {
  const a = [...c.args];
  let hostName = '127.0.0.1', user = 'postgres', sql = null, url = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-h') hostName = a[++i]; else if (a[i] === '-U') user = a[++i]; else if (a[i] === '-c') sql = a[++i]; else if (a[i] === '-d') { const d = a[++i]; if (/^postgres(ql)?:\/\//.test(d)) url = d; } else if (/^postgres(ql)?:\/\//.test(a[i])) url = a[i];
  }
  if (url) { const m = url.match(/^\w+:\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:/]+)/); if (m) { user = m[1] || user; hostName = m[3]; } }
  if (sql === null) return c.fail('psql: the simulator runs one statement at a time: psql -U postgres -c "SELECT …"', 2);
  const r = connect(c.uni, c.host, hostName, 5432);
  if (r.error) return c.fail(r.error === 'ENOTFOUND' ? `psql: error: could not translate host name "${hostName}" to address: Name or service not known` : `psql: error: connection to server at "${hostName}", port 5432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?`, 2);
  const auth = r.listener.program?.checkAuth?.(url || `postgres://${user}:${c.env.PGPASSWORD ?? (hostName === '127.0.0.1' || hostName === 'localhost' ? r.listener.program?.host?.labDbPassword : '')}@x`);
  if (auth) return c.fail(`psql: ${auth}`, 2);
  const server = r.listener.program?.host || c.host;
  const file = pgDataFile(server);
  let db; try { db = JSON.parse(server.files.get(file) || '{"tables":{}}'); } catch { db = { tables: {} }; }
  const save = () => { server.mkdirMeta(dirname(file), 'postgres'); server.writeFile(file, JSON.stringify(db), 'postgres'); if (server.container) { const eng = [...c.uni.hosts.values()].find(x => x.docker?.containers.has(server.container.id))?.docker; if (eng) syncVolumes(eng, server.container); } };
  let code = 0;
  for (const stmt0 of sql.split(';').map(x => x.trim()).filter(Boolean)) {
    const stmt = stmt0.replace(/\s+/g, ' ');
    let m;
    if ((m = stmt.match(/^CREATE TABLE (?:IF NOT EXISTS )?(\w+) ?\((.*)\)$/i))) {
      if (db.tables[m[1]]) { if (/IF NOT EXISTS/i.test(stmt)) { c.print('NOTICE:  relation already exists, skipping'); continue; } c.eprint(`ERROR:  relation "${m[1]}" already exists`); code = 1; continue; }
      db.tables[m[1]] = { cols: splitValues(m[2]).map(x => x.split(' ')[0]), rows: [] }; save(); c.print('CREATE TABLE');
    } else if ((m = stmt.match(/^INSERT INTO (\w+)(?: ?\([^)]*\))? VALUES ?(.*)$/i))) {
      const t = db.tables[m[1]];
      if (!t) { c.eprint(`ERROR:  relation "${m[1]}" does not exist`); code = 1; continue; }
      const tuples = [...m[2].matchAll(/\(([^)]*)\)/g)].map(x => splitValues(x[1]));
      t.rows.push(...tuples); save(); c.print(`INSERT 0 ${tuples.length}`);
    } else if ((m = stmt.match(/^SELECT (.+) FROM (\w+)$/i))) {
      const t = db.tables[m[2]];
      if (!t) { c.eprint(`ERROR:  relation "${m[2]}" does not exist\nLINE 1: ${stmt}`); code = 1; continue; }
      if (/count\(\*\)/i.test(m[1])) { c.print(' count ', '-------', `     ${t.rows.length}`, '(1 row)'); continue; }
      const w = t.cols.map((col, k) => Math.max(col.length, ...t.rows.map(r => String(r[k] ?? '').length)));
      c.print(' ' + t.cols.map((col, k) => col.padEnd(w[k])).join(' | '), t.cols.map((_, k) => '-'.repeat(w[k] + 2)).join('+'));
      for (const r of t.rows) c.print(' ' + t.cols.map((_, k) => String(r[k] ?? '').padEnd(w[k])).join(' | '));
      c.print(`(${t.rows.length} row${t.rows.length === 1 ? '' : 's'})`);
    } else if ((m = stmt.match(/^DROP TABLE (\w+)$/i))) { delete db.tables[m[1]]; save(); c.print('DROP TABLE'); }
    else if (/^\\dt$/.test(stmt)) { const names = Object.keys(db.tables); if (!names.length) c.print('Did not find any relations.'); else { c.print('         List of relations', ' Schema |  Name   | Type  |  Owner', '--------+---------+-------+----------'); for (const n of names) c.print(` public | ${n.padEnd(7)} | table | ${user}`); } }
    else if (/^SELECT 1$/i.test(stmt)) c.print(' ?column? ', '----------', '        1', '(1 row)');
    else { c.eprint(`ERROR:  the simulator's psql understands CREATE TABLE, INSERT INTO … VALUES, SELECT … FROM, DROP TABLE and \\dt`); code = 1; }
  }
  c.uni.emit({ type: 'psql', host: c.host.name, server: server.name, sql });
  return code;
}, { pkg: 'postgresql-client' });
