// nginx: parses the real config syntax (nginx.conf + include), validates it like
// `nginx -t`, and serves requests: server selection by port and server_name, location
// matching (=, ^~, ~, ~*, prefix), root/alias/index/try_files, return, proxy_pass
// (with a 502 when the upstream is down), add_header, and TLS via ssl_certificate.

import { normPath, dirname } from './host.js';
import { httpRequest, readCertPem } from './net.js';
import { globToRegex } from './bash.js';

const KNOWN = new Set(['user', 'worker_processes', 'pid', 'include', 'events', 'worker_connections', 'http', 'server', 'listen', 'server_name', 'root', 'index', 'location', 'proxy_pass', 'proxy_set_header', 'proxy_http_version', 'proxy_read_timeout', 'proxy_connect_timeout', 'return', 'rewrite', 'try_files', 'alias', 'add_header', 'error_page', 'access_log', 'error_log', 'ssl_certificate', 'ssl_certificate_key', 'ssl_protocols', 'ssl_ciphers', 'ssl_prefer_server_ciphers', 'sendfile', 'tcp_nopush', 'types_hash_max_size', 'default_type', 'gzip', 'gzip_types', 'keepalive_timeout', 'client_max_body_size', 'upstream', 'deny', 'allow', 'autoindex', 'expires', 'limit_req_zone', 'limit_req', 'server_tokens', 'charset', 'types', 'multi_accept', 'auth_basic', 'auth_basic_user_file', 'internal', 'set', 'if', 'map', 'resolver', 'proxy_buffering', 'proxy_cache', 'http2', 'ssl_session_cache', 'ssl_session_timeout', 'ssl_stapling', 'ssl_dhparam', 'include_shared']);

export class NginxConfigError extends Error {
  constructor(msg, file, line) { super(`nginx: [emerg] ${msg} in ${file}:${line}`); this.file = file; this.line = line; }
}

function tokenize(text, file) {
  const toks = [];
  let line = 1, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}' || c === ';') { toks.push({ v: c, line, punct: true }); i++; continue; }
    if (c === '"' || c === "'") { let j = i + 1, s = ''; while (j < text.length && text[j] !== c) { if (text[j] === '\n') line++; s += text[j++]; } toks.push({ v: s, line }); i = j + 1; continue; }
    let s = '';
    while (i < text.length && !/[\s{};]/.test(text[i])) s += text[i++];
    toks.push({ v: s, line });
  }
  return toks;
}

// parse into a tree of { name, args, block?, file, line }
function parseBlock(toks, pos, file, depth, parent = null) {
  const items = [];
  while (pos < toks.length) {
    const t = toks[pos];
    if (t.punct && t.v === '}') { if (depth === 0) throw new NginxConfigError('unexpected "}"', file, t.line); return { items, pos: pos + 1 }; }
    if (t.punct) throw new NginxConfigError(`unexpected "${t.v}"`, file, t.line);
    const name = t.v, line = t.line;
    const args = [];
    pos++;
    while (pos < toks.length && !toks[pos].punct) args.push(toks[pos++].v);
    const end = toks[pos];
    if (!end) throw new NginxConfigError('unexpected end of file, expecting ";" or "}"', file, toks[toks.length - 1]?.line || 1);
    if (!KNOWN.has(name) && parent !== 'types' && parent !== 'map') throw new NginxConfigError(`unknown directive "${name}"`, file, line);
    if (end.v === '{') {
      const r = parseBlock(toks, pos + 1, file, depth + 1, name);
      items.push({ name, args, block: r.items, file, line });
      pos = r.pos;
      continue;
    }
    if (end.v === '}') throw new NginxConfigError(`directive "${name}" is not terminated by ";"`, file, line);
    if (['server', 'location', 'http', 'events', 'upstream', 'types', 'if', 'map'].includes(name) && !(name === 'server' && parent === 'upstream')) throw new NginxConfigError(`directive "${name}" has no opening "{"`, file, line);
    items.push({ name, args, file, line });
    pos++;
  }
  if (depth > 0) throw new NginxConfigError('unexpected end of file, expecting "}"', file, toks[toks.length - 1]?.line || 1);
  return { items, pos };
}

export function loadConfig(host, path = '/etc/nginx/nginx.conf') {
  const files = [];
  const read = (p, depth) => {
    if (depth > 8) throw new NginxConfigError('too deep include', p, 1);
    const text = host.files.get(p);
    if (text === undefined) throw new Error(`nginx: [emerg] open() "${p}" failed (2: No such file or directory)`);
    files.push(p);
    const items = parseBlock(tokenize(text, p), 0, p, 0).items;
    // expand includes in place
    const expand = list => list.flatMap(d => {
      if (d.name === 'include') {
        const pat = d.args[0];
        const abs = pat.startsWith('/') ? pat : normPath('/etc/nginx/' + pat);
        if (/[*?]/.test(abs)) {
          const dir = dirname(abs);
          const re = globToRegex(abs.slice(dir.length + 1));
          if (!host.isDir(dir)) return [];
          return host.listDir(dir).filter(([n, k]) => k === 'file' && re.test(n)).flatMap(([n]) => read(dir + '/' + n, depth + 1));
        }
        if (/mime\.types$/.test(abs) && !host.files.has(abs)) return [];
        return read(abs, depth + 1);
      }
      if (d.block) return [{ ...d, block: expand(d.block) }];
      return [d];
    });
    return expand(items);
  };
  const tree = read(path, 0);
  const http = tree.find(d => d.name === 'http');
  const user = (tree.find(d => d.name === 'user')?.args[0] || 'www-data').replace(/;$/, '');
  const servers = [];
  const upstreams = {};
  // server_tokens and add_header set in http {} apply to servers that do not set their own
  const httpTokens = http?.block.find(x => x.name === 'server_tokens')?.args[0] !== 'off';
  const httpHeaders = (http?.block || []).filter(x => x.name === 'add_header').map(x => [x.args[0], x.args[1]]);
  for (const d of http?.block || []) {
    if (d.name === 'upstream') { const list = d.block.filter(x => x.name === 'server'); upstreams[d.args[0]] = list.filter(x => !x.args.includes('backup') && !x.args.includes('down')).map(x => x.args[0]); upstreams[d.args[0]].backup = list.filter(x => x.args.includes('backup')).map(x => x.args[0]); }
    if (d.name !== 'server') continue;
    const srv = { listens: [], names: [], root: null, index: ['index.html'], locations: [], headers: [], returns: null, file: d.file, line: d.line, certs: {}, tokens: httpTokens };
    for (const x of d.block) {
      switch (x.name) {
        case 'listen': {
          const a = x.args;
          const portSpec = a[0];
          const port = Number(portSpec.includes(':') ? portSpec.split(':').pop() : portSpec);
          if (!Number.isFinite(port)) throw new NginxConfigError(`invalid port in "${portSpec}" of the "listen" directive`, x.file, x.line);
          srv.listens.push({ port, ssl: a.includes('ssl'), def: a.includes('default_server'), addr: portSpec.includes(':') ? portSpec.split(':')[0] : '0.0.0.0' });
          break;
        }
        case 'server_name': srv.names.push(...x.args); break;
        case 'root': srv.root = x.args[0]; break;
        case 'index': srv.index = x.args; break;
        case 'location': srv.locations.push(parseLocation(x)); break;
        case 'return': srv.returns = x.args; break;
        case 'add_header': srv.headers.push([x.args[0], x.args[1]]); break;
        case 'server_tokens': srv.tokens = x.args[0] !== 'off'; break;
        case 'ssl_certificate': srv.certs.cert = x.args[0]; srv.certLine = x; break;
        case 'ssl_certificate_key': srv.certs.key = x.args[0]; break;
        case 'try_files': srv.tryFiles = x.args; break;
      }
    }
    if (!srv.headers.length) srv.headers.push(...httpHeaders);
    if (!srv.listens.length) srv.listens.push({ port: 80, ssl: false, def: false, addr: '0.0.0.0' });
    if (srv.listens.some(l => l.ssl)) {
      if (!srv.certs.cert) throw new NginxConfigError(`no "ssl_certificate" is defined for the "listen ... ssl" directive`, d.file, d.line);
      if (!host.files.has(srv.certs.cert)) throw new Error(`nginx: [emerg] cannot load certificate "${srv.certs.cert}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory)`);
      if (srv.certs.key && !host.files.has(srv.certs.key)) throw new Error(`nginx: [emerg] cannot load certificate key "${srv.certs.key}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory)`);
    }
    servers.push(srv);
  }
  // duplicate default_server check
  const defs = {};
  for (const s of servers) for (const l of s.listens) if (l.def) { if (defs[l.port]) throw new NginxConfigError(`a duplicate default server for 0.0.0.0:${l.port}`, s.file, s.line); defs[l.port] = true; }
  return { servers, upstreams, user, files };
}

function parseLocation(x) {
  let mod = '', path = x.args[0];
  if (['=', '~', '~*', '^~'].includes(x.args[0])) { mod = x.args[0]; path = x.args[1]; }
  const loc = { mod, path, root: null, alias: null, proxy: null, returns: null, tryFiles: null, index: null, headers: [], deny: false };
  for (const d of x.block || []) {
    switch (d.name) {
      case 'root': loc.root = d.args[0]; break;
      case 'alias': loc.alias = d.args[0]; break;
      case 'proxy_pass': loc.proxy = d.args[0]; break;
      case 'return': loc.returns = d.args; break;
      case 'try_files': loc.tryFiles = d.args; break;
      case 'index': loc.index = d.args; break;
      case 'add_header': loc.headers.push([d.args[0], d.args[1]]); break;
      case 'deny': if (d.args[0] === 'all') loc.deny = true; break;
    }
  }
  return loc;
}

const ERR = (code, msg) => `<html>\r\n<head><title>${code} ${msg}</title></head>\r\n<body>\r\n<center><h1>${code} ${msg}</h1></center>\r\n<hr><center>nginx/1.24.0 (Ubuntu)</center>\r\n</body>\r\n</html>`;

export class Nginx {
  constructor({ host, uni }) {
    this.host = host; this.uni = uni; this.kind = 'nginx'; this.memMB = 12;
  }
  start() {
    try { this.conf = loadConfig(this.host); }
    catch (e) { return { ok: false, code: 1, logs: [e.message] }; }
    const ports = new Map();
    for (const s of this.conf.servers) for (const l of s.listens) ports.set(l.port, l.addr === '0.0.0.0' || l.addr === '*' ? '0.0.0.0' : l.addr);
    return { ok: true, ports: [...ports].map(([port, addr]) => ({ port, addr })), logs: [] };
  }
  reload() {
    const conf = loadConfig(this.host);
    // rebind ports
    for (const [port, l] of [...this.host.listening]) if (l.pid === this.proc.pid) this.host.listening.delete(port);
    this.conf = conf;
    for (const s of conf.servers) for (const l of s.listens) { try { this.host.listen(l.port, this.proc.pid, { addr: l.addr === '*' ? '0.0.0.0' : l.addr, program: this }); } catch (e) { this.host.log('nginx.service', `[emerg] bind() to 0.0.0.0:${l.port} failed (98: Address already in use)`, 'err'); } }
  }
  serversOn(port) { return this.conf.servers.filter(s => s.listens.some(l => l.port === port)); }
  pickServer(port, hostHeader) {
    const list = this.serversOn(port);
    const name = String(hostHeader || '').split(':')[0];
    return list.find(s => s.names.includes(name)) || list.find(s => s.names.some(n => n.startsWith('*.') && name.endsWith(n.slice(1)))) || list.find(s => s.listens.some(l => l.port === port && l.def)) || list[0];
  }
  tlsOnly(port) { return this.serversOn(port).every(s => s.listens.find(l => l.port === port)?.ssl); }
  certFor(port, sni) {
    const s = this.pickServer(port, sni);
    if (!s || !s.listens.find(l => l.port === port)?.ssl) return null;
    return readCertPem(this.host.files.get(s.certs.cert));
  }
  log(req, status, bytes) {
    const line = `${req.fromIp} - - [${new Date(this.uni.time * 1000).toUTCString().slice(5, 25)} +0000] "${req.method} ${req.path} HTTP/1.1" ${status} ${bytes} "-" "curl/8.5.0"`;
    const p = '/var/log/nginx/access.log';
    this.host.writeFile(p, (this.host.files.get(p) || '') + line + '\n', 'www-data');
  }
  errlog(msg) {
    const p = '/var/log/nginx/error.log';
    const ts = new Date(this.uni.time * 1000).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/');
    this.host.writeFile(p, (this.host.files.get(p) || '') + `${ts} [error] 4242#4242: *1 ${msg}\n`, 'www-data');
  }
  handle(req) {
    const r = this.route(req);
    this.log(req, r.status, String(r.body ?? '').length);
    return r;
  }
  route(req) {
    const srv = this.pickServer(req.port, req.headers.host);
    const r = this.route0(req, srv);
    // the Server header carries the version unless server_tokens is off
    r.headers = { ...(r.headers || {}), server: srv && !srv.tokens ? 'nginx' : 'nginx/1.24.0 (Ubuntu)' };
    return r;
  }
  route0(req, srv) {
    if (!srv) return { status: 404, body: ERR(404, 'Not Found') };
    const subst = s => s.replace(/\$host/g, String(req.headers.host).split(':')[0]).replace(/\$request_uri/g, req.path + (req.query || '')).replace(/\$uri/g, req.path).replace(/\$scheme/g, req.scheme).replace(/\$server_name/g, srv.names[0] || '');
    const headers = Object.fromEntries(srv.headers.map(([k, v]) => [k.toLowerCase(), v]));
    if (srv.returns) return this.doReturn(srv.returns, subst, headers);
    const loc = this.matchLocation(srv, req.path);
    if (loc) Object.assign(headers, Object.fromEntries(loc.headers.map(([k, v]) => [k.toLowerCase(), v])));
    if (loc?.deny) return { status: 403, headers, body: ERR(403, 'Forbidden') };
    if (loc?.returns) return this.doReturn(loc.returns, subst, headers);
    if (loc?.proxy) return this.proxy(loc, req, headers);
    const root = loc?.root || srv.root || '/usr/share/nginx/html';
    const tryFiles = loc?.tryFiles || srv.tryFiles;
    const index = loc?.index || srv.index;
    const fileFor = (uri) => loc?.alias ? normPath(loc.alias + '/' + uri.slice(loc.path.length)) : normPath(root + uri);
    const candidates = tryFiles ? tryFiles.slice(0, -1).map(t => subst(t)) : [req.path];
    for (const cand of candidates) {
      const p = fileFor(cand.replace(/\/$/, '') || '/');
      const st = this.host.stat(p);
      if (st?.type === 'file') return this.serveFile(p, headers);
      if (st?.type === 'dir' && (cand.endsWith('/') || !tryFiles)) {
        for (const ix of index) { const ip = normPath(p + '/' + ix); if (this.host.files.has(ip)) return this.serveFile(ip, headers); }
        if (!tryFiles) { this.errlog(`directory index of "${p}/" is forbidden, client: ${req.fromIp}, server: ${srv.names[0] || '_'}, request: "${req.method} ${req.path} HTTP/1.1"`); return { status: 403, headers, body: ERR(403, 'Forbidden') }; }
      }
    }
    if (tryFiles) {
      const last = tryFiles[tryFiles.length - 1];
      if (/^=\d+$/.test(last)) return { status: Number(last.slice(1)), headers, body: ERR(Number(last.slice(1)), Number(last.slice(1)) === 404 ? 'Not Found' : 'Error') };
      const p = fileFor(subst(last));
      if (this.host.files.has(p)) return this.serveFile(p, headers);
    }
    this.errlog(`open() "${fileFor(req.path)}" failed (2: No such file or directory), client: ${req.fromIp}, server: ${srv.names[0] || '_'}, request: "${req.method} ${req.path} HTTP/1.1"`);
    return { status: 404, headers, body: ERR(404, 'Not Found') };
  }
  serveFile(p, headers) {
    const user = this.conf.user;
    // nginx workers run as www-data: they need read permission (and x on every directory)
    let d = dirname(p);
    const chain = [];
    while (true) { chain.push(d); if (d === '/') break; d = dirname(d); }
    const denied = chain.some(dir => !this.host.can(user, dir, 'x')) || !this.host.can(user, p, 'r');
    if (denied) { this.errlog(`open() "${p}" failed (13: Permission denied)`); return { status: 403, headers, body: ERR(403, 'Forbidden') }; }
    return { status: 200, headers: { 'content-type': p.endsWith('.json') ? 'application/json' : p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'application/javascript' : 'text/html', ...headers }, body: this.host.files.get(p) };
  }
  doReturn(args, subst, headers) {
    const code = Number(args[0]);
    if ([301, 302, 307, 308].includes(code)) return { status: code, headers: { ...headers, location: subst(args[1] || '') }, body: ERR(code, code === 301 ? 'Moved Permanently' : 'Found') };
    return { status: code, headers, body: args[1] !== undefined ? subst(args[1]) : '' };
  }
  matchLocation(srv, path) {
    const locs = srv.locations;
    const exact = locs.find(l => l.mod === '=' && l.path === path);
    if (exact) return exact;
    let best = null;
    for (const l of locs) if ((l.mod === '' || l.mod === '^~') && path.startsWith(l.path) && (!best || l.path.length > best.path.length)) best = l;
    if (best?.mod === '^~') return best;
    for (const l of locs) if (l.mod === '~' || l.mod === '~*') { try { if (new RegExp(l.path, l.mod === '~*' ? 'i' : '').test(path)) return l; } catch { /* ignore bad regex */ } }
    return best;
  }
  proxy(loc, req, headers) {
    let target = loc.proxy;
    const m = target.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/);
    if (!m) return { status: 500, headers, body: ERR(500, 'Internal Server Error') };
    let [, scheme, hostName, port, base] = m;
    let upstreamHosts = [`${hostName}${port ? ':' + port : ''}`];
    if (this.conf.upstreams[hostName]) {
      // round robin over the primary servers, backups only when every primary fails
      const ups = this.conf.upstreams[hostName];
      this.rr = (this.rr || 0) + 1;
      const k = ups.length ? this.rr % ups.length : 0;
      upstreamHosts = [...ups.slice(k), ...ups.slice(0, k), ...(ups.backup || [])];
      if (upstreamHosts.length === 1) upstreamHosts = [...upstreamHosts];
      upstreamHosts.multi = true;
    }
    // with a URI in proxy_pass, the matched location prefix is replaced by it
    const rest = base !== undefined ? normPath(base + '/' + req.path.slice(loc.path.length)).replace(/\/$/, req.path.endsWith('/') ? '/' : '') : req.path;
    for (const up of upstreamHosts) {
      const url = `${scheme}://${up}${rest || '/'}${req.query || ''}`;
      if (req.depth > 4) return { status: 508, headers, body: ERR(508, 'Loop Detected') };
      const r = httpRequest(this.uni, this.host, url, { method: req.method, headers: { ...req.headers, 'x-forwarded-for': req.fromIp }, body: req.body, depth: (req.depth || 0) + 1 });
      if (!r.error) return { status: r.status, headers: { ...r.headers, ...headers, 'x-upstream': up }, body: r.body };
      const why = r.error === 'ECONNREFUSED' ? '111: Connection refused' : r.error === 'ETIMEDOUT' ? '110: Connection timed out' : r.error === 'ENOTFOUND' ? `host not found in upstream "${up}"` : r.error;
      this.errlog(`connect() failed (${why}) while connecting to upstream, client: ${req.fromIp}, server: _, request: "${req.method} ${req.path} HTTP/1.1", upstream: "${url}"`);
      if (upstreamHosts.length === 1 && !upstreamHosts.multi) return r.error === 'ETIMEDOUT' ? { status: 504, headers, body: ERR(504, 'Gateway Time-out') } : { status: 502, headers, body: ERR(502, 'Bad Gateway') };
    }
    return { status: 502, headers, body: ERR(502, 'Bad Gateway') };
  }
}

export const DEFAULT_NGINX_CONF = `user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 768;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`;

export const DEFAULT_SITE = `server {
    listen 80 default_server;
    server_name _;

    root /var/www/html;
    index index.html index.htm index.nginx-debian.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
`;

export const WELCOME_PAGE = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
</body>
</html>
`;
