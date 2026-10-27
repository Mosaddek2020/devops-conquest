// Docker images: a catalog of base images that behave like the real ones (alpine has no
// bash, slim images have no curl, distroless has no shell at all), and `docker build`:
// Dockerfile parsing, RUN steps executed in a build container by the bash interpreter,
// layer caching, .dockerignore, multi-stage builds and honest layer sizes.

import { Host, normPath, dirname, basename } from './host.js';
import { Session } from './session.js';
import { globToRegex } from './bash.js';
import { CATALOG } from './packages.js';

const BUSYBOX = ['sh', 'ash', 'ls', 'cat', 'echo', 'ps', 'grep', 'sed', 'awk', 'wget', 'vi', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'env', 'printenv', 'id', 'whoami', 'hostname', 'df', 'du', 'top', 'kill', 'pkill', 'sleep', 'tail', 'head', 'wc', 'find', 'chmod', 'chown', 'ping', 'nc', 'nslookup', 'tar', 'gzip', 'date', 'sort', 'uniq', 'cut', 'tr', 'xargs', 'tee', 'which', 'touch', 'ln', 'stat', 'test', '[', 'true', 'false', 'seq', 'basename', 'dirname', 'free', 'uptime', 'adduser', 'addgroup', 'su', 'netstat', 'ip', 'diff', 'md5sum', 'sha256sum', 'base64', 'mktemp', 'readlink', 'realpath', 'yes', 'nl', 'tac', 'rev', 'nohup', 'timeout', 'watch'];
const COREUTILS = ['sh', 'bash', 'dash', 'ls', 'cat', 'echo', 'grep', 'sed', 'awk', 'mawk', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'env', 'printenv', 'id', 'whoami', 'hostname', 'df', 'du', 'kill', 'sleep', 'tail', 'head', 'wc', 'find', 'chmod', 'chown', 'tar', 'gzip', 'date', 'sort', 'uniq', 'cut', 'tr', 'xargs', 'tee', 'which', 'touch', 'ln', 'stat', 'test', '[', 'true', 'false', 'seq', 'basename', 'dirname', 'apt', 'apt-get', 'dpkg', 'useradd', 'groupadd', 'usermod', 'adduser', 'addgroup', 'su', 'mktemp', 'readlink', 'realpath', 'diff', 'md5sum', 'sha256sum', 'base64', 'yes', 'nl', 'tac', 'rev', 'nohup', 'timeout', 'gunzip', 'zcat', 'logrotate'];
const FULL = [...COREUTILS, 'ps', 'top', 'curl', 'wget', 'git', 'ssh', 'scp', 'ping', 'ip', 'nc', 'make', 'python3', 'free', 'uptime', 'pgrep', 'pkill', 'less', 'more', 'netstat', 'ss', 'file', 'gpg'];

// size in MB, binaries, user, default command, known vulnerabilities (critical/high/medium/low)
export const BASE_IMAGES = {
  'ubuntu:24.04': { size: 78, os: 'ubuntu', bins: [...COREUTILS], cmd: ['/bin/bash'], vulns: [0, 0, 6, 11] },
  'debian:bookworm-slim': { size: 74, os: 'debian', bins: COREUTILS, cmd: ['bash'], vulns: [0, 1, 9, 20] },
  'alpine:3.20': { size: 7.8, os: 'alpine', bins: [...BUSYBOX, 'apk'], cmd: ['/bin/sh'], vulns: [0, 0, 1, 2] },
  'busybox:1.36': { size: 4.3, os: 'busybox', bins: BUSYBOX, cmd: ['sh'], vulns: [0, 0, 0, 1] },
  'node:20': { size: 1100, os: 'debian', bins: [...FULL, 'node', 'npm', 'npx'], cmd: ['node'], user: 'root', nodeUser: true, vulns: [3, 41, 160, 280] },
  'node:20-slim': { size: 196, os: 'debian', bins: [...COREUTILS, 'node', 'npm', 'npx'], cmd: ['node'], nodeUser: true, vulns: [0, 2, 12, 31] },
  'node:20-alpine': { size: 135, os: 'alpine', bins: [...BUSYBOX, 'apk', 'node', 'npm', 'npx'], cmd: ['node'], nodeUser: true, vulns: [0, 0, 1, 3] },
  'gcr.io/distroless/nodejs20-debian12': { size: 128, os: 'distroless', bins: ['node'], cmd: [], entrypoint: ['/nodejs/bin/node'], user: 'nonroot', vulns: [0, 0, 1, 2] },
  'python:3.12': { size: 1020, os: 'debian', bins: [...FULL, 'python3', 'python', 'pip', 'pip3'], cmd: ['python3'], vulns: [2, 35, 140, 260] },
  'python:3.12-slim': { size: 130, os: 'debian', bins: [...COREUTILS, 'python3', 'python', 'pip', 'pip3'], cmd: ['python3'], vulns: [0, 1, 10, 28] },
  'nginx:1.27': { size: 192, os: 'debian', bins: [...COREUTILS, 'nginx', 'curl'], cmd: ['nginx', '-g', 'daemon off;'], expose: [80], nginx: true, vulns: [0, 3, 25, 60] },
  'nginx:1.27-alpine': { size: 48, os: 'alpine', bins: [...BUSYBOX, 'apk', 'nginx', 'curl'], cmd: ['nginx', '-g', 'daemon off;'], expose: [80], nginx: true, vulns: [0, 0, 2, 4] },
  'redis:7': { size: 117, os: 'debian', bins: [...COREUTILS, 'redis-server', 'redis-cli'], cmd: ['redis-server'], expose: [6379], redis: true, vulns: [0, 1, 8, 22] },
  'redis:7-alpine': { size: 41, os: 'alpine', bins: [...BUSYBOX, 'redis-server', 'redis-cli'], cmd: ['redis-server'], expose: [6379], redis: true, vulns: [0, 0, 1, 2] },
  'postgres:16': { size: 432, os: 'debian', bins: [...COREUTILS, 'postgres', 'psql', 'pg_dump', 'pg_isready'], cmd: ['postgres'], expose: [5432], postgres: true, vulns: [0, 2, 20, 45] },
  'curlimages/curl:8.10.1': { size: 22, os: 'alpine', bins: [...BUSYBOX, 'curl'], cmd: ['curl'], user: 'curl_user', vulns: [0, 0, 0, 1] },
  'hashicorp/http-echo:1.0': { size: 4.2, os: 'distroless', bins: ['http-echo'], cmd: [], entrypoint: ['/http-echo'], expose: [5678], vulns: [0, 0, 0, 0] },
  'postgres:16-alpine': { size: 243, os: 'alpine', bins: [...BUSYBOX, 'postgres', 'psql', 'pg_dump', 'pg_isready'], cmd: ['postgres'], expose: [5432], postgres: true, vulns: [0, 0, 2, 5] },
};
const ALIASES = { 'curlimages/curl': 'curlimages/curl:8.10.1', 'curlimages/curl:latest': 'curlimages/curl:8.10.1', 'hashicorp/http-echo': 'hashicorp/http-echo:1.0', 'hashicorp/http-echo:latest': 'hashicorp/http-echo:1.0', 'busybox:latest': 'busybox:1.36', 'gcr.io/distroless/nodejs20-debian12:latest': 'gcr.io/distroless/nodejs20-debian12', 'gcr.io/distroless/nodejs20-debian12:nonroot': 'gcr.io/distroless/nodejs20-debian12', 'ubuntu': 'ubuntu:24.04', 'ubuntu:latest': 'ubuntu:24.04', 'alpine': 'alpine:3.20', 'alpine:latest': 'alpine:3.20', 'node': 'node:20', 'node:latest': 'node:20', 'node:lts': 'node:20', 'node:20-bookworm-slim': 'node:20-slim', 'nginx': 'nginx:1.27', 'nginx:latest': 'nginx:1.27', 'nginx:alpine': 'nginx:1.27-alpine', 'redis': 'redis:7', 'redis:latest': 'redis:7', 'redis:alpine': 'redis:7-alpine', 'postgres': 'postgres:16', 'postgres:latest': 'postgres:16', 'postgres:alpine': 'postgres:16-alpine', 'python': 'python:3.12', 'python:3.12-alpine': 'python:3.12-slim', 'debian': 'debian:bookworm-slim', 'busybox': 'busybox:1.36' };

let seq = 0;
export const shortId = () => { seq++; let h = 0x9e3779b1 ^ seq; let out = ''; for (let i = 0; i < 64; i++) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; out += (h & 15).toString(16); } return out; };

export function parseRef(ref) {
  let r = String(ref).trim();
  let registry = 'docker.io';
  const first = r.split('/')[0];
  if (r.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) { registry = first; r = r.slice(first.length + 1); }
  const at = r.indexOf('@');
  let digest = null;
  if (at >= 0) { digest = r.slice(at + 1); r = r.slice(0, at); }
  const colon = r.lastIndexOf(':');
  let repo = r, tag = 'latest';
  if (colon > r.lastIndexOf('/')) { repo = r.slice(0, colon); tag = r.slice(colon + 1); }
  const short = registry === 'docker.io' ? `${repo}:${tag}` : `${registry}/${repo}:${tag}`;
  return { registry, repo, tag, digest, short, name: registry === 'docker.io' ? repo : `${registry}/${repo}` };
}

export function baseFor(ref) {
  const p = parseRef(ref);
  const key = p.registry === 'docker.io' ? `${p.repo}:${p.tag}` : `${p.registry}/${p.repo}:${p.tag}`;
  const k = ALIASES[key] || key;
  return BASE_IMAGES[k] ? { key: k, ...BASE_IMAGES[k] } : null;
}

// the filesystem every image of a family starts with
export function baseFiles(base) {
  const f = {};
  f['/etc/os-release'] = base.os === 'alpine' ? 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\n' : base.os === 'distroless' ? 'PRETTY_NAME="Distroless"\n' : 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n';
  if (base.nginx) {
    f['/etc/nginx/nginx.conf'] = 'user nginx;\nworker_processes auto;\nevents {\n    worker_connections 1024;\n}\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n}\n';
    f['/etc/nginx/conf.d/default.conf'] = 'server {\n    listen 80;\n    server_name localhost;\n    location / {\n        root /usr/share/nginx/html;\n        index index.html;\n    }\n}\n';
    f['/usr/share/nginx/html/index.html'] = '<!DOCTYPE html>\n<html>\n<head><title>Welcome to nginx!</title></head>\n<body><h1>Welcome to nginx!</h1></body>\n</html>\n';
  }
  if (base.redis) f['/etc/redis/redis.conf'] = 'bind 0.0.0.0\nport 6379\nprotected-mode no\n';
  if (base.postgres) f['/etc/postgresql/16/main/postgresql.conf'] = "listen_addresses = '*'\nport = 5432\n";
  return f;
}

// a container-like Host for builds and for running containers
export function makeContainerHost(uni, name, { base, files = {}, users = null, binaries = null, packages = null, ip = null }) {
  const h = new Host(uni, name, { ip: ip || '0.0.0.0', kind: 'container', user: 'root', withWww: false, memMB: 2048, cpus: 2 });
  h.dirs = new Set(['/']);
  for (const d of ['/bin', '/etc', '/usr', '/usr/bin', '/usr/local', '/usr/local/bin', '/var', '/var/log', '/var/lib', '/tmp', '/root', '/home', '/opt', '/srv', '/run', '/proc', '/dev']) h.mkdirMeta(d);
  h.meta.get('/tmp').mode = 0o1777;
  for (const k of [...h.files.keys()]) if (!k.startsWith('/etc/passwd') && !k.startsWith('/etc/group')) Map.prototype.delete.call(h.files, k);
  h.procs.clear();
  h.binaries = new Set(binaries || base.bins);
  h.packages = new Map(packages || []);
  if (users) {
    h.users.clear(); h.groups.clear();
    for (const [n, u] of users.users) h.users.set(n, { ...u, groups: new Set(u.groups) });
    for (const [n, g] of users.groups) h.groups.set(n, { ...g, members: new Set(g.members) });
    h.syncPasswd();
  } else {
    if (base.nodeUser && !h.users.has('node')) h.addUser('node', { uid: 1000 });
    if (base.user === 'nonroot') h.addUser('nonroot', { uid: 65532, noHome: true });
    if (base.user === 'curl_user') h.addUser('curl_user', { uid: 100, noHome: true });
    if (base.nginx) h.addUser('nginx', { uid: 101, shell: '/sbin/nologin', noHome: true });
    if (base.postgres) h.addUser('postgres', { uid: 999, home: '/var/lib/postgresql' });
    if (base.redis) h.addUser('redis', { uid: 999, noHome: true });
    if (h.users.has('dev')) { h.users.delete('dev'); h.groups.delete('dev'); h.syncPasswd(); }
  }
  for (const [p, c] of Object.entries(files)) {
    if (c && typeof c === 'object' && c.dir) { h.mkdirMeta(p, c.owner || 'root', c.mode || 0o755); continue; }
    const content = typeof c === 'object' ? c.content : c;
    h.writeFile(p, content, typeof c === 'object' ? c.owner || 'root' : 'root');
    if (typeof c === 'object') { if (c.mode) h.setMeta(p, { mode: c.mode }); if (c.size) { h.fakeSizes = h.fakeSizes || new Map(); h.fakeSizes.set(p, c.size); } }
  }
  h.home = '/root';
  return h;
}

// snapshot a host's filesystem as image files
export function snapshotFiles(h) {
  const out = {};
  for (const d of h.dirs) { if (d === '/') continue; const m = h.meta.get(d); out[d] = { dir: true, owner: m?.owner || 'root', mode: m?.mode || 0o755 }; }
  for (const [p, c] of h.files) { if (p === '/etc/passwd' || p === '/etc/group') continue; const m = h.meta.get(p); out[p] = { content: c, owner: m?.owner || 'root', mode: m?.mode || 0o644, size: h.fakeSizes?.get(p) }; }
  return out;
}
export const snapshotUsers = h => ({ users: [...h.users].map(([n, u]) => [n, { ...u, groups: [...u.groups] }]), groups: [...h.groups].map(([n, g]) => [n, { ...g, members: [...g.members] }]) });

const sizeOf = f => (f && typeof f === 'object' ? (f.dir ? 0 : (f.size ?? new TextEncoder().encode(f.content || '').length)) : new TextEncoder().encode(f || '').length);
export const fmtMB = mb => mb >= 1000 ? `${(mb / 1000).toFixed(2)}GB` : mb >= 1 ? `${mb.toFixed(mb >= 100 ? 0 : 1)}MB` : `${Math.max(1, Math.round(mb * 1000))}kB`;

// ---------------------------------------------------------------- Dockerfile

export function parseDockerfile(text) {
  const out = [];
  const errors = [];
  const raw = text.replace(/\\\r?\n/g, ' ').split('\n');
  raw.forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith('#')) return;
    const m = l.match(/^([A-Za-z]+)\s+([\s\S]*)$/) || l.match(/^([A-Za-z]+)$/);
    if (!m) { errors.push(`dockerfile parse error on line ${i + 1}: unknown instruction: ${l}`); return; }
    const ins = m[1].toUpperCase();
    if (!['FROM', 'RUN', 'COPY', 'ADD', 'WORKDIR', 'ENV', 'ARG', 'EXPOSE', 'USER', 'CMD', 'ENTRYPOINT', 'HEALTHCHECK', 'LABEL', 'VOLUME', 'STOPSIGNAL', 'SHELL', 'ONBUILD'].includes(ins)) { errors.push(`dockerfile parse error on line ${i + 1}: unknown instruction: ${m[1]}`); return; }
    out.push({ ins, args: (m[2] || '').trim(), line: i + 1, text: l });
  });
  if (!errors.length && !out.some(x => x.ins === 'FROM')) errors.push('failed to solve: no build stage in current context: Dockerfile must start with FROM');
  else if (!errors.length && out[0].ins !== 'FROM' && out[0].ins !== 'ARG') errors.push(`failed to solve: dockerfile parse error on line ${out[0].line}: ${out[0].ins} before FROM`);
  return { steps: out, errors };
}

// content checksum for the COPY cache (FNV-1a)
const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16) + ':' + s.length; };

const execForm = s => { const t = s.trim(); if (t.startsWith('[')) { try { return JSON.parse(t); } catch { return null; } } return null; };

function ignoreMatcher(text) {
  const pats = String(text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const rules = pats.map(p => { const neg = p.startsWith('!'); const q = (neg ? p.slice(1) : p).replace(/^\.?\//, '').replace(/\/$/, ''); return { neg, re: globToRegex(q.replace(/\*\*/g, '*')) , raw: q }; });
  return rel => {
    let ignored = false;
    for (const r of rules) {
      const hit = r.re.test(rel) || rel.split('/').some((_, k, a) => r.re.test(a.slice(0, k + 1).join('/')));
      if (hit) ignored = !r.neg;
    }
    return ignored;
  };
}

// build an image; returns { ok, image, log[], error }
export function dockerBuild(engine, { contextDir, dockerfile, tags = [], buildArgs = {}, noCache = false, target = null }) {
  const host = engine.host, uni = engine.uni;
  const log = [];
  const t0 = uni.time;
  const dfPath = dockerfile ? normPath(dockerfile.startsWith('/') ? dockerfile : contextDir + '/' + dockerfile) : contextDir + '/Dockerfile';
  const text = host.files.get(dfPath);
  if (text === undefined) return { ok: false, log, error: `ERROR: failed to solve: failed to read dockerfile: open ${dfPath.split('/').pop()}: no such file or directory` };
  const { steps, errors } = parseDockerfile(text);
  if (errors.length) return { ok: false, log, error: 'ERROR: ' + errors[0] };
  // build context, minus .dockerignore
  const ign = ignoreMatcher(host.files.get(contextDir + '/.dockerignore'));
  const context = {};
  let contextBytes = 0;
  for (const [p, c] of host.files) {
    if (!p.startsWith(contextDir + '/')) continue;
    const rel = p.slice(contextDir.length + 1);
    if (ign(rel)) continue;
    const sz = host.fakeSizes?.get(p) ?? new TextEncoder().encode(c).length;
    context[rel] = { content: c, size: host.fakeSizes?.get(p), mode: host.stat(p)?.mode };
    contextBytes += sz;
  }
  for (const d of host.dirs) if (d.startsWith(contextDir + '/')) { const rel = d.slice(contextDir.length + 1); if (!ign(rel)) context[rel + '/'] = { dir: true }; }
  log.push(`[+] Building ${steps.length > 0 ? '' : ''}(${steps.length} steps)`, ' => [internal] load build definition from ' + basename(dfPath), ` => [internal] load .dockerignore${host.files.has(contextDir + '/.dockerignore') ? '' : ' (none)'}`, ` => [internal] load build context: transferring ${fmtMB(contextBytes / 1e6)}`);
  // stages
  const stages = [];
  let cur = null;
  const args = { ...buildArgs };
  const total = steps.filter(s => !['ARG'].includes(s.ins) || cur).length;
  let n = 0;
  const fail = (s, msg) => ({ ok: false, log, error: `ERROR: failed to solve: ${msg}`, step: s });
  for (const s of steps) {
    const expandArgs = v => v.replace(/\$\{?(\w+)\}?/g, (m, k) => (cur?.env?.[k] ?? args[k] ?? m));
    if (s.ins === 'ARG' && !cur) { const [k, v] = s.args.split('='); if (!(k in args)) args[k] = v ?? ''; continue; }
    n++;
    const label = `[${cur?.name ? cur.name + ' ' : ''}${n}/${total}] ${s.ins} ${s.args}`;
    if (s.ins === 'FROM') {
      const m = expandArgs(s.args).match(/^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i);
      if (!m) return fail(s, `dockerfile parse error on line ${s.line}: FROM requires one argument`);
      const ref = m[1];
      const prev = stages.find(x => x.name && x.name === ref);
      let state;
      if (prev) state = { files: { ...prev.files }, users: prev.users, binaries: [...prev.binaries], packages: [...prev.packages], base: prev.base, baseRef: prev.baseRef, sizeMB: prev.sizeMB, layers: [...prev.layers], env: { ...prev.env }, workdir: prev.workdir, user: prev.user, config: { ...prev.config } };
      else {
        const img = engine.findImage(ref) || engine.pullImage(ref, { quiet: true });
        if (!img) return fail(s, `${ref}: failed to resolve source metadata for docker.io/library/${ref}: pull access denied, repository does not exist or may require authorization`);
        state = { files: { ...img.files }, users: img.users, binaries: [...img.binaries], packages: [...img.packages], base: img.base, baseRef: img.baseRef || ref, sizeMB: img.sizeMB, layers: [...img.layers], env: { ...img.config.env }, workdir: img.config.workdir || '/', user: img.config.user || 'root', config: { ...img.config, env: { ...img.config.env } } };
      }
      cur = { name: m[2] || null, ...state, cacheKey: prev ? `${prev.cacheKey}\nFROM stage` : `FROM ${engine.findImage(ref)?.id || ref}` };
      stages.push(cur);
      log.push(` => [${cur.name ? cur.name + ' ' : ''}${n}/${total}] ${s.ins} ${s.args}`);
      continue;
    }
    if (!cur) return fail(s, 'no FROM');
    const prevKey = cur.cacheKey;
    let key = prevKey + '\n' + s.text;
    const cached = !noCache && engine.cache.get(key);
    const applyCached = (c) => { Object.assign(cur, { files: { ...c.files }, users: c.users, binaries: [...c.binaries], packages: [...c.packages], sizeMB: c.sizeMB, layers: [...c.layers], env: { ...c.env }, workdir: c.workdir, user: c.user, config: { ...c.config, env: { ...c.config.env } } }); };
    const record = () => engine.cache.set(cur.cacheKey, { files: { ...cur.files }, users: cur.users, binaries: [...cur.binaries], packages: [...cur.packages], sizeMB: cur.sizeMB, layers: [...cur.layers], env: { ...cur.env }, workdir: cur.workdir, user: cur.user, config: { ...cur.config, env: { ...cur.config.env } } });
    switch (s.ins) {
      case 'WORKDIR': {
        const w = normPath(expandArgs(s.args).startsWith('/') ? expandArgs(s.args) : (cur.workdir || '/') + '/' + expandArgs(s.args));
        cur.workdir = w; cur.config.workdir = w;
        let d = w; while (d !== '/') { if (!cur.files[d]) cur.files[d] = { dir: true, owner: 'root', mode: 0o755 }; d = dirname(d); }
        cur.cacheKey = key; log.push(` => ${label}`); record(); continue;
      }
      case 'ENV': {
        const pairs = s.args.includes('=') ? [...s.args.matchAll(/(\w+)=("([^"]*)"|'([^']*)'|\S+)/g)].map(m => [m[1], m[3] ?? m[4] ?? m[2]]) : [[s.args.split(/\s+/)[0], s.args.split(/\s+/).slice(1).join(' ')]];
        for (const [k, v] of pairs) { cur.env[k] = expandArgs(v); cur.config.env = { ...cur.config.env, [k]: expandArgs(v) }; }
        cur.cacheKey = key; log.push(` => ${label}`); record(); continue;
      }
      case 'ARG': { const [k, v] = s.args.split('='); if (!(k in args)) args[k] = v ?? ''; cur.cacheKey = key; continue; }
      case 'EXPOSE': cur.config.exposed = [...new Set([...(cur.config.exposed || []), ...s.args.split(/\s+/).map(p => Number(p.split('/')[0]))])]; cur.cacheKey = key; continue;
      case 'LABEL': cur.config.labels = { ...(cur.config.labels || {}), ...Object.fromEntries([...s.args.matchAll(/([\w.-]+)=("([^"]*)"|\S+)/g)].map(m => [m[1], m[3] ?? m[2]])) }; cur.cacheKey = key; continue;
      case 'USER': {
        const u = expandArgs(s.args).split(':')[0];
        const known = new Map(cur.users ? cur.users.users : []);
        if (!/^\d+$/.test(u) && cur.users && !known.has(u)) return fail(s, `failed to compute cache key: unable to find user ${u}: no matching entries in passwd file`);
        cur.user = u; cur.config.user = u; cur.cacheKey = key; log.push(` => ${label}`); continue;
      }
      case 'CMD': case 'ENTRYPOINT': {
        const ef = execForm(s.args);
        const v = ef || ['/bin/sh', '-c', s.args];
        if (s.ins === 'CMD') cur.config.cmd = v; else { cur.config.entrypoint = v; cur.config.cmd = cur.config.cmd && execForm(JSON.stringify(cur.config.cmd)) ? cur.config.cmd : []; }
        cur.config.shellForm = cur.config.shellForm || {};
        cur.config.shellForm[s.ins] = !ef;
        cur.cacheKey = key; continue;
      }
      case 'HEALTHCHECK': {
        const m = s.args.match(/^(?:(--\S+\s+)*)CMD\s+([\s\S]+)$/i);
        if (/^NONE$/i.test(s.args)) cur.config.healthcheck = null;
        else if (m) { const ef = execForm(m[2]); cur.config.healthcheck = { test: ef ? ef.join(' ') : m[2], interval: (s.args.match(/--interval=(\S+)/) || [])[1] || '30s' }; }
        cur.cacheKey = key; continue;
      }
      case 'VOLUME': cur.config.volumes = [...(cur.config.volumes || []), ...(execForm(s.args) || s.args.split(/\s+/))]; cur.cacheKey = key; continue;
      case 'COPY': case 'ADD': {
        let a = expandArgs(s.args);
        let from = null, chown = null, chmod = null;
        a = a.replace(/--from=(\S+)\s*/, (_, f) => { from = f; return ''; }).replace(/--chown=(\S+)\s*/, (_, f) => { chown = f.split(':')[0]; return ''; }).replace(/--chmod=(\S+)\s*/, (_, f) => { chmod = parseInt(f, 8); return ''; });
        const parts = execForm(a) || a.trim().split(/\s+/);
        if (parts.length < 2) return fail(s, `dockerfile parse error on line ${s.line}: COPY requires at least two arguments`);
        const dest0 = parts.pop();
        const destAbs = normPath(dest0.startsWith('/') ? dest0 : (cur.workdir || '/') + '/' + dest0);
        const destIsDir = dest0.endsWith('/') || parts.length > 1 || dest0 === '.' || dest0 === './';
        let srcFiles;
        if (from) {
          const st = stages.find(x => x.name === from) || stages[Number(from)];
          if (!st) { const img = engine.findImage(from) || engine.pullImage(from, { quiet: true }); if (!img) return fail(s, `failed to resolve source metadata for ${from}`); srcFiles = Object.fromEntries(Object.entries(img.files)); }
          else srcFiles = st.files;
        }
        const pick = [];
        for (const src of parts) {
          if (from) {
            const sAbs = normPath(src.startsWith('/') ? src : '/' + src);
            const hits = Object.entries(srcFiles).filter(([p]) => p === sAbs || p.startsWith(sAbs + '/'));
            if (!hits.length) return fail(s, `failed to compute cache key: failed to calculate checksum of ref: "${src}": not found`);
            for (const [p, f] of hits) pick.push([p === sAbs ? basename(p) : p.slice(sAbs.length + 1), f, p === sAbs && !f.dir]);
            continue;
          }
          const s0 = src.replace(/^\.\//, '').replace(/\/$/, '');
          if (s0 === '.' || s0 === '') { for (const [rel, f] of Object.entries(context)) pick.push([rel.replace(/\/$/, ''), f, false]); continue; }
          const re = globToRegex(s0);
          const hits = Object.entries(context).filter(([rel]) => re.test(rel.replace(/\/$/, '')) || rel.startsWith(s0 + '/'));
          if (!hits.length) return fail(s, `failed to compute cache key: failed to calculate checksum of ref: "/${s0}": not found${ign(s0) ? ' (it is excluded by .dockerignore)' : ''}`);
          for (const [rel, f] of hits) {
            const top = re.test(rel.replace(/\/$/, ''));
            pick.push([top && !rel.endsWith('/') ? basename(rel) : (rel.startsWith(s0 + '/') ? rel.slice(s0.length + 1) : basename(rel)), f, top && !rel.endsWith('/')]);
          }
        }
        // cache key includes the content being copied
        const sig = pick.map(([p, f]) => p + ':' + (f.dir ? 'd' : hash(f.content || '') + ':' + (f.size || ''))).join('|');
        key = prevKey + '\n' + s.text + '\n' + sig;
        const cc = !noCache && engine.cache.get(key);
        if (cc) { applyCached(cc); cur.cacheKey = key; log.push(` => CACHED ${label}`); continue; }
        let bytes = 0;
        for (const [rel, f, single] of pick) {
          const target = single && !destIsDir ? destAbs : normPath(destAbs + '/' + rel);
          if (f.dir) { cur.files[target] = { dir: true, owner: chown || 'root', mode: 0o755 }; continue; }
          cur.files[target] = { content: f.content, owner: chown || (typeof f === 'object' && from ? f.owner : 'root'), mode: chmod || f.mode || 0o644, size: f.size };
          let d = dirname(target); while (d !== '/' && !cur.files[d]) { cur.files[d] = { dir: true, owner: chown || 'root', mode: 0o755 }; d = dirname(d); }
          bytes += sizeOf(f);
        }
        const mb = bytes / 1e6;
        cur.sizeMB += mb;
        cur.layers.push({ created: uni.time, by: s.text, sizeMB: mb });
        cur.cacheKey = key;
        log.push(` => ${label}${mb >= 1 ? `   ${fmtMB(mb)}` : ''}`);
        record();
        continue;
      }
      case 'RUN': {
        if (cached) { applyCached(cached); cur.cacheKey = key; log.push(` => CACHED ${label}`); continue; }
        const box = makeContainerHost(uni, 'buildkit', { base: cur.base, files: cur.files, users: cur.users ? { users: cur.users.users, groups: cur.users.groups } : null, binaries: cur.binaries, packages: cur.packages });
        const before = new Map(Object.entries(cur.files).filter(([, f]) => !f.dir).map(([p, f]) => [p, sizeOf(f)]));
        const sh = new Session(uni, box, { user: cur.user && cur.user !== 'root' && box.users.has(cur.user) ? cur.user : 'root', cwd: cur.workdir || '/' });
        sh.advancePerCommand = 0;
        for (const [k, v] of Object.entries(cur.env)) sh.setVar(sh.e, k, v, { exported: true });
        for (const [k, v] of Object.entries(args)) if (!sh.e.vars.has(k)) sh.setVar(sh.e, k, v, { exported: false });
        sh.e.opts.e = true;
        const cmd = execForm(s.args) ? execForm(s.args).join(' ') : expandArgs(s.args);
        const chunks = [];
        const code = sh.runScript(cmd, sh.e, { in: null, out: x => chunks.push(x), err: x => chunks.push(x) }, { name: '/bin/sh', result: { editor: null } });
        const out = chunks.join('').replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, '');
        log.push(` => ${label}`);
        if (out) log.push(...out.split('\n').slice(-12).map(l => `#${n} ${l}`));
        if (code !== 0) return { ok: false, log, error: `ERROR: failed to solve: process "/bin/sh -c ${cmd}" did not complete successfully: exit code: ${code}`, step: s };
        const after = snapshotFiles(box);
        let bytes = 0;
        for (const [p, f] of Object.entries(after)) if (!f.dir) { const sz = sizeOf(f); if (!before.has(p) || before.get(p) !== sz) bytes += sz; }
        // package installs add their real weight; apt lists stay in the layer unless removed in the same RUN
        const newPkgs = [...box.packages.keys()].filter(p => !cur.packages.some(([q]) => q === p));
        for (const p of newPkgs) { const m = String(CATALOG[p]?.size || '2 MB').match(/([\d.,]+)\s*(kB|MB|B)/); bytes += m ? Number(m[1].replace(',', '')) * (m[2] === 'MB' ? 1e6 : m[2] === 'kB' ? 1e3 : 1) * 3 : 3e6; }
        cur.files = after;
        cur.users = snapshotUsers(box);
        cur.binaries = [...box.binaries];
        cur.packages = [...box.packages];
        const mb = bytes / 1e6;
        cur.sizeMB += mb;
        cur.layers.push({ created: uni.time, by: `RUN ${cmd}`, sizeMB: mb });
        cur.cacheKey = key;
        record();
        uni.advance(Math.min(30, 2 + Math.round(mb / 10)));
        continue;
      }
      default: cur.cacheKey = key; continue;
    }
  }
  const final = target ? stages.find(x => x.name === target) : stages[stages.length - 1];
  if (!final) return { ok: false, log, error: `ERROR: failed to solve: target stage "${target}" could not be found` };
  // an identical build (every step cached) gives back the same image, not a new one
  const sameKey = 'IMAGE\n' + final.cacheKey;
  const prevImg = !noCache && engine.cache.get(sameKey);
  if (prevImg && engine.images.has(prevImg)) {
    const img = engine.images.get(prevImg);
    for (const tg of tags) engine.tag(img, tg);
    log.push(' => exporting to image', ` => => writing image sha256:${img.id}`, ...tags.map(tg => ` => => naming to ${parseRef(tg).registry}/${parseRef(tg).repo.includes('/') || parseRef(tg).registry !== 'docker.io' ? '' : 'library/'}${parseRef(tg).repo}:${parseRef(tg).tag}`));
    log[0] = `[+] Building 0.${n}s (${n}/${n}) FINISHED`;
    return { ok: true, log, image: img };
  }
  const img = engine.addImage({ files: final.files, users: final.users, binaries: final.binaries, packages: final.packages, base: final.base, baseRef: final.baseRef, sizeMB: final.sizeMB, layers: final.layers, config: { ...final.config, env: final.env, workdir: final.workdir, user: final.user } }, tags);
  engine.cache.set(sameKey, img.id);
  log.push(' => exporting to image', ` => => writing image sha256:${img.id}`, ...tags.map(tg => ` => => naming to ${parseRef(tg).registry}/${parseRef(tg).repo.includes('/') || parseRef(tg).registry !== 'docker.io' ? '' : 'library/'}${parseRef(tg).repo}:${parseRef(tg).tag}`));
  log[0] = `[+] Building ${Math.max(1, uni.time - t0)}.${String(n * 7 % 10)}s (${n}/${n}) FINISHED`;
  return { ok: true, log, image: img };
}

export { sizeOf };
