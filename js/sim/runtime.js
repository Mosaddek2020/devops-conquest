// Programs that run as processes: Node/Express apps, Python apps and http.server, nginx,
// redis, postgres, and lab-defined programs. A program is started with launch(); it may
// listen on ports, answer HTTP requests via handle(), write log lines, and crash.
//
// App behaviour is read from the app's own source the way a reader would: the port from
// `process.env.PORT || 3000`, required settings from `if (!X) throw …`, dependencies from
// `connect(process.env.DATABASE_URL)`, routes from `app.get('/path', … res.json({…}))`.

import { connect, httpRequest, parseUrl } from './net.js';
import { SimError, normPath, dirname } from './host.js';

export const programFactories = new Map();   // name -> (ctx) => Program (labs add more)

// ---------- a tiny JS-expression evaluator for literals in app code ----------
export function evalJs(src, scope = {}) {
  const s = String(src).trim();
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function value() {
    ws();
    const c = s[i];
    if (c === '{') {
      i++; const o = {};
      ws();
      while (s[i] !== '}') {
        ws();
        let key;
        if (s[i] === '"' || s[i] === "'") key = str();
        else if (s[i] === '[') { i++; key = String(expr()); ws(); i++; }
        else { const m = s.slice(i).match(/^[\w$]+/); key = m[0]; i += key.length; }
        ws();
        if (s[i] === ':') { i++; o[key] = expr(); }
        else o[key] = lookup(key);
        ws();
        if (s[i] === ',') i++;
        ws();
        if (i >= s.length) break;
      }
      i++;
      return o;
    }
    if (c === '[') { i++; const a = []; ws(); while (s[i] !== ']' && i < s.length) { a.push(expr()); ws(); if (s[i] === ',') i++; ws(); } i++; return a; }
    if (c === '"' || c === "'") return str();
    if (c === '`') return tmpl();
    if (c === '(') { i++; const v = expr(); ws(); i++; return v; }
    if (c === '!') { i++; return !value(); }
    if (c === '-' && /\d/.test(s[i + 1])) { i++; return -value(); }
    let m = s.slice(i).match(/^\d+(\.\d+)?/);
    if (m) { i += m[0].length; return Number(m[0]); }
    m = s.slice(i).match(/^[\w$.]+(\(\s*([^()]*)\s*\))?/);
    if (m) { i += m[0].length; return callOrLookup(m[0]); }
    throw new Error('cannot evaluate: ' + s);
  }
  function str() { const q = s[i++]; let out = ''; while (i < s.length && s[i] !== q) { if (s[i] === '\\') { out += s[i + 1] === 'n' ? '\n' : s[i + 1]; i += 2; continue; } out += s[i++]; } i++; return out; }
  function tmpl() { i++; let out = ''; while (i < s.length && s[i] !== '`') { if (s[i] === '$' && s[i + 1] === '{') { let d = 0, j = i + 1; for (; j < s.length; j++) { if (s[j] === '{') d++; if (s[j] === '}') { d--; if (!d) break; } } out += String(evalJs(s.slice(i + 2, j), scope) ?? ''); i = j + 1; continue; } out += s[i++]; } i++; return out; }
  function lookup(name) {
    if (name === 'true') return true; if (name === 'false') return false; if (name === 'null') return null; if (name === 'undefined') return undefined;
    if (name.startsWith('process.env.')) return scope.env?.[name.slice(12)];
    if (name === 'os.hostname' || name === 'require("os").hostname') return scope.hostname;
    if (name in scope) return scope[name];
    const parts = name.split('.');
    let v = scope[parts[0]];
    for (const p of parts.slice(1)) v = v?.[p];
    return v;
  }
  function callOrLookup(tok) {
    const m = tok.match(/^([\w$.]+)\(\s*([^()]*)\s*\)$/);
    if (!m) return lookup(tok);
    const [, fn, arg] = m;
    const a = arg ? evalJs(arg, scope) : undefined;
    switch (fn) {
      case 'Number': case 'parseInt': return Number(a);
      case 'String': return String(a);
      case 'os.hostname': return scope.hostname;
      case 'Date.now': return (scope.time || 0) * 1000;
      case 'new Date().toISOString': case 'Date().toISOString': return new Date((scope.time || 0) * 1000).toISOString();
      case 'process.uptime': return scope.uptime || 1;
      case 'Math.random': return 0.42;
    }
    return lookup(fn);
  }
  function expr() {
    let v = value();
    while (true) {
      ws();
      if (s.startsWith('||', i)) { i += 2; const r = value(); v = v || r; continue; }
      if (s.startsWith('??', i)) { i += 2; const r = value(); v = v ?? r; continue; }
      if (s.startsWith('&&', i)) { i += 2; const r = value(); v = v && r; continue; }
      if (s[i] === '+') { i++; const r = value(); v = v + r; continue; }
      if (s.startsWith('===', i) || s.startsWith('==', i)) { i += s.startsWith('===', i) ? 3 : 2; const r = value(); v = v == r; continue; } // eslint-disable-line eqeqeq
      if (s[i] === '?' ) { i++; const a = expr(); ws(); i++; const b = expr(); v = v ? a : b; continue; }
      break;
    }
    return v;
  }
  return expr();
}

// find the end of a balanced (...) starting at s[i] === '('
function balanced(s, i) {
  let d = 0, q = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '{' || c === '[') d++;
    if (c === ')' || c === '}' || c === ']') { d--; if (d === 0) return j; }
  }
  return s.length - 1;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ---------- Node / Express apps ----------
export class NodeApp {
  constructor({ host, uni, file, src, env, cwd, user }) {
    Object.assign(this, { host, uni, file, src, env, cwd, user });
    this.kind = 'node';
    this.routes = [];
    this.memMB = 48;
    this.cpu = 0.5;
    this.reqLog = /morgan\(|app\.use\(\s*\(req/.test(src);
    this.instrumented = /prom-client/.test(src);
    this.parse();
  }

  scope() {
    const scope = { env: this.env, hostname: this.host.name, time: this.uni.time };
    // const NAME = expr  (simple top-level constants)
    for (const m of this.src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);?\s*$/gm)) {
      const [, name, expr] = m;
      if (/require\(|express\(|new |=>|await |connect\(|createClient\(/.test(expr)) continue;
      try { scope[name] = evalJs(expr, scope); } catch { /* not a literal */ }
    }
    return scope;
  }

  parse() {
    const s = this.src;
    this.requires = [...s.matchAll(/require\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g)].map(m => m[1].split('/')[0]).filter(x => !['fs', 'os', 'path', 'http', 'https', 'crypto', 'url', 'util', 'events', 'child_process', 'net', 'cluster', 'node:fs', 'node:os', 'node:http', 'node:path'].includes(x) && !x.startsWith('node:'));
    // listen
    const lm = s.match(/\.listen\(\s*([^,)]+)(?:\s*,\s*(['"][^'"]+['"]))?/);
    this.listenExpr = lm ? lm[1].trim() : null;
    this.bindExpr = lm?.[2] || null;
    // startup checks: if (!X) throw new Error('...')  or  if (!X) { console.error('...'); process.exit(1) }
    this.checks = [];
    for (const m of s.matchAll(/if\s*\(\s*!\s*([\w$.]+)\s*\)\s*\{?\s*(?:throw\s+new\s+Error\(\s*(['"`])([\s\S]*?)\2\s*\)|console\.error\(\s*(['"`])([\s\S]*?)\4\s*\)\s*;?\s*process\.exit\(\s*(\d+)\s*\))/g)) {
      this.checks.push({ expr: m[1], message: m[3] ?? m[5], viaExit: !!m[5], line: lineOf(s, m.index), code: m[6] ? Number(m[6]) : 1 });
    }
    // files opened for writing at startup: fs.openSync('/var/lib/app/x.db', 'a') and friends
    this.opens = [...s.matchAll(/fs\.(openSync|appendFileSync|writeFileSync|createWriteStream)\(\s*(['"])([^'"]+)\2/g)].map(m => ({ path: m[3], fn: m[1], line: lineOf(s, m.index) }));
    // dependencies: connect(process.env.DATABASE_URL) / createClient({ url: … }) / new Pool({ connectionString: … })
    this.deps = [];
    for (const m of s.matchAll(/(connect|createClient|createPool|new\s+Pool|new\s+Redis|new\s+Client)\s*\(/g)) {
      const start = m.index + m[0].length - 1;
      const end = balanced(s, start);
      const arg = s.slice(start + 1, end).trim();
      this.deps.push({ arg, kind: /redis/i.test(m[0] + arg) ? 'redis' : 'db', line: lineOf(s, m.index) });
    }
    // routes
    const re = /app\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2\s*,/g;
    let m;
    while ((m = re.exec(s))) {
      const open = s.indexOf('(', m.index);
      const end = balanced(s, open);
      const body = s.slice(m.index + m[0].length, end);
      this.routes.push({ method: m[1].toUpperCase(), path: m[3], body, line: lineOf(s, m.index) });
    }
    this.staticDir = (s.match(/express\.static\(\s*['"]([^'"]+)['"]/) || [])[1] || null;
    // startup log lines inside the listen callback
    this.startLogs = [];
    const li = s.search(/\.listen\(/);
    if (li >= 0) {
      const end = balanced(s, s.indexOf('(', li));
      const seg = s.slice(li, end + 1);
      let k = 0;
      while ((k = seg.indexOf('console.log(', k)) !== -1) { const open = k + 11; const close = balanced(seg, open); this.startLogs.push(seg.slice(open + 1, close)); k = close; }
    }
  }

  depUrl(dep, scope) {
    try {
      const v = evalJs(dep.arg, scope);
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        if (v.url || v.connectionString || v.uri) return v.url || v.connectionString || v.uri;
        if (v.host) return `${dep.kind === 'redis' ? 'redis' : 'postgres'}://${v.host}:${v.port || (dep.kind === 'redis' ? 6379 : 5432)}`;
        if (v.socket?.host) return `redis://${v.socket.host}:${v.socket.port || 6379}`;
      }
    } catch { /* fall through */ }
    return null;
  }

  stack(msg, line) {
    return [`${this.file}:${line}`, '', `Error: ${msg}`, `    at Object.<anonymous> (${this.file}:${line}:9)`, '    at Module._compile (node:internal/modules/cjs/loader:1504:14)', '', 'Node.js v20.18.0'];
  }

  start() {
    // a full disk stops apps at startup (they cannot open their log or temp files)
    if (this.host.diskGB && this.host.diskUsedGB >= this.host.diskGB * 0.999) return { ok: false, code: 1, logs: [`node:internal/fs/utils:351`, '    throw err;', '    ^', '', `Error: ENOSPC: no space left on device, open '/var/log/${(this.file.split('/').slice(-2, -1)[0]) || 'app'}/app.log'`, "    at Object.openSync (node:fs:573:18)", "  errno: -28,", "  code: 'ENOSPC',", '', 'Node.js v20.18.0'] };
    const scope = this.scope();
    this.scopeCache = scope;
    // modules installed?
    for (const mod of this.requires) {
      let d = dirname(this.file), found = false;
      while (true) { if (this.host.isDir(normPath(d + '/node_modules/' + mod))) { found = true; break; } if (d === '/') break; d = dirname(d); }
      if (!found) return { ok: false, code: 1, logs: ['node:internal/modules/cjs/loader:1228', '  throw err;', '  ^', '', `Error: Cannot find module '${mod}'`, `Require stack:`, `- ${this.file}`, '    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)', '  code: \'MODULE_NOT_FOUND\',', '', 'Node.js v20.18.0'] };
    }
    for (const o of this.opens || []) {
      const p = normPath(o.path.startsWith('/') ? o.path : dirname(this.file) + '/' + o.path);
      const h = this.host, st = h.stat(p) || h.stat(dirname(p));
      if (!st || this.user === 'root') continue;
      const bits = st.owner === this.user ? st.mode >> 6 : h.userGroups(this.user).includes(st.group) ? st.mode >> 3 : st.mode;
      if (!(bits & 2)) return { ok: false, code: 1, logs: ['node:fs:573', '  return binding.open(', '         ^', '', `Error: EACCES: permission denied, open '${p}'`, `    at Object.${o.fn} (node:fs:573:18)`, `    at Object.<anonymous> (${this.file}:${o.line}:${4})`, '    at Module._compile (node:internal/modules/cjs/loader:1469:14) {', '  errno: -13,', "  code: 'EACCES',", "  syscall: 'open',", `  path: '${p}'`, '}', '', 'Node.js v20.18.0'] };
    }
    for (const ch of this.checks) {
      let v;
      try { v = evalJs(ch.expr, scope); } catch { v = undefined; }
      if (!v) return ch.viaExit ? { ok: false, code: ch.code, logs: [ch.message] } : { ok: false, code: 1, logs: this.stack(ch.message, ch.line) };
    }
    for (const dep of this.deps) {
      const url = this.depUrl(dep, scope);
      if (!url) return { ok: false, code: 1, logs: [`TypeError [ERR_INVALID_ARG_TYPE]: The "url" argument must be of type string. Received undefined`, `    at ${dep.kind === 'redis' ? 'createClient' : 'connect'} (${this.file}:${dep.line}:3)`, '', 'Node.js v20.18.0'] };
      const u = parseUrl(url);
      const port = u.port && ![80, 443].includes(u.port) || /:\d+/.test(url.replace(/^\w+:\/\//, '').split('/')[0]) ? u.port : (dep.kind === 'redis' ? 6379 : 5432);
      const c = connect(this.uni, this.host, u.host, port);
      if (c.error) {
        if (c.error === 'ENOTFOUND') return { ok: false, code: 1, logs: [`Error: getaddrinfo ENOTFOUND ${u.host}`, '    at GetAddrInfoReqWrap.onlookup [as oncomplete] (node:dns:109:26) {', "  errno: -3008,", "  code: 'ENOTFOUND',", "  syscall: 'getaddrinfo',", `  hostname: '${u.host}'`, '}', '', 'Node.js v20.18.0'] };
        if (c.error === 'ETIMEDOUT') return { ok: false, code: 1, logs: [`Error: connect ETIMEDOUT ${c.ip}:${port}`, '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16) {', "  errno: -110,", "  code: 'ETIMEDOUT',", "  syscall: 'connect',", `  address: '${c.ip}',`, `  port: ${port}`, '}', '', 'Node.js v20.18.0'] };
        return { ok: false, code: 1, logs: [`Error: connect ECONNREFUSED ${c.ip || u.host}:${port}`, '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16) {', "  errno: -111,", "  code: 'ECONNREFUSED',", "  syscall: 'connect',", `  address: '${c.ip || u.host}',`, `  port: ${port}`, '}', '', 'Node.js v20.18.0'] };
      }
      const auth = c.listener.program?.checkAuth?.(url);
      if (auth) return { ok: false, code: 1, logs: [auth, '', 'Node.js v20.18.0'] };
    }
    // apps that hold a big in-memory cache say so: const CACHE_SIZE_MB = …
    if (scope.CACHE_SIZE_MB !== undefined && Number.isFinite(Number(scope.CACHE_SIZE_MB))) this.memMB = 48 + Number(scope.CACHE_SIZE_MB);
    if (!this.listenExpr) return { ok: true, ports: [], logs: [], oneShot: true };
    let port;
    try { port = Number(evalJs(this.listenExpr, scope)); } catch { port = NaN; }
    if (!Number.isFinite(port) || port <= 0) port = 3000;
    if (port < 1024 && this.user !== 'root') return { ok: false, code: 1, logs: [`Error: listen EACCES: permission denied 0.0.0.0:${port}`, '    at Server.setupListenHandle [as _listen2] (node:net:1882:21) {', "  code: 'EACCES',", "  errno: -13,", "  syscall: 'listen',", `  port: ${port}`, '}', '', 'Node.js v20.18.0'] };
    this.port = port;
    const bind = this.bindExpr ? evalJs(this.bindExpr, scope) : '0.0.0.0';
    const logs = this.startLogs.map(x => { try { return String(evalJs(x, { ...scope, port, PORT: port })); } catch { return x.replace(/^['"`]|['"`]$/g, ''); } });
    return { ok: true, ports: [{ port, addr: bind === 'localhost' ? '127.0.0.1' : bind }], logs };
  }

  match(route, path) {
    if (route === '*' || route === '/*') return {};
    const rp = route.split('/'), pp = path.split('/');
    if (rp.length !== pp.length) return null;
    const params = {};
    for (let k = 0; k < rp.length; k++) {
      if (rp[k].startsWith(':')) params[rp[k].slice(1)] = decodeURIComponent(pp[k]);
      else if (rp[k] !== pp[k]) return null;
    }
    return params;
  }

  handle(req) {
    const res = this.handleInner(req);
    // apps using prom-client count their own requests (served on /metrics)
    if (this.instrumented && this.uni.obs && req.path !== '/metrics' && res && !res.error) {
      const route = this.routes.find(r => r.method === req.method && this.match(r.path, req.path.replace(/\/+$/, '') || '/'))?.path || req.path;
      const prof = this.uni.obs.profileFor(this.host, this.port)?.routes[route];
      this.uni.obs.statsFor(this.host, this.port).add(req.method, route, String(res.status || 200), 1, prof && (res.status || 200) < 500 ? prof.p50 : 0.012);
    }
    return res;
  }

  handleInner(req) {
    const path = req.path.replace(/\/+$/, '') || '/';
    if (path === '/metrics' && this.instrumented) {
      const st = this.uni.obs ? this.uni.obs.statsFor(this.host, this.port) : null;
      const proc = this.proc;
      const extra = ['# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${Math.round((proc?.mem || this.memMB) * 1048576)}`, '# TYPE process_cpu_seconds_total counter', `process_cpu_seconds_total ${((this.uni.time - (proc?.start || this.uni.time)) * (proc?.cpu || 0.3) / 10).toFixed(2)}`, '# TYPE nodejs_eventloop_lag_seconds gauge', `nodejs_eventloop_lag_seconds ${this.lagSeconds ?? 0.0021}`];
      // app-specific metric families a simulator registers for this app (e.g. an LLM gateway's token counters)
      extra.push(...(this.uni.obs?.metricHooks?.get(`${this.host.name}:${this.port}`)?.(this) || []));
      return { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }, body: st ? st.exposition(extra) : extra.join('\n') + '\n' };
    }
    const hook = this.uni.appHooks?.[this.hookKey || this.host.name]?.(req, this);
    if (hook) { this.logReq(req, hook.status || 200); return hook; }
    for (const r of this.routes) {
      if (r.method !== 'ALL' && r.method !== req.method) continue;
      const params = this.match(r.path, path);
      if (!params) continue;
      const res = this.runRoute(r, { ...req, params });
      this.logReq(req, res.status);
      return res;
    }
    if (this.staticDir && req.method === 'GET') {
      const base = normPath(dirname(this.file) + '/' + this.staticDir);
      const p = normPath(base + (path === '/' ? '/index.html' : path));
      if (p.startsWith(base) && this.host.files.has(p)) { this.logReq(req, 200); return { status: 200, body: this.host.files.get(p) }; }
    }
    this.logReq(req, 404);
    return { status: 404, headers: { 'content-type': 'text/html' }, body: `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Error</title></head>\n<body><pre>Cannot ${req.method} ${req.path}</pre></body>\n</html>` };
  }

  runRoute(r, req) {
    const scope = { ...(this.scopeCache || this.scope()), req, env: this.env, hostname: this.host.name, time: this.uni.time };
    const b = r.body;
    const thr = b.match(/throw\s+new\s+Error\(\s*(['"`])([\s\S]*?)\1\s*\)/);
    if (thr) { this.log(`Error: ${thr[2]}`); this.log(`    at ${this.file}:${r.line}:${11}`); return { status: 500, headers: { 'content-type': 'text/html' }, body: `<pre>Error: ${thr[2]}</pre>` }; }
    let status = 200;
    const sm = b.match(/res\.status\(\s*(\d+)\s*\)/);
    if (sm) status = Number(sm[1]);
    const ss = b.match(/res\.sendStatus\(\s*(\d+)\s*\)/);
    if (ss) return { status: Number(ss[1]), body: { 200: 'OK', 204: '', 404: 'Not Found', 500: 'Internal Server Error' }[ss[1]] ?? '' };
    const rd = b.match(/res\.redirect\(\s*(?:(\d+)\s*,\s*)?(['"`])([^'"`]+)\2/);
    if (rd) return { status: Number(rd[1] || 302), headers: { location: rd[3] }, body: `Found. Redirecting to ${rd[3]}` };
    const jm = b.match(/res(?:\.status\(\s*\d+\s*\))?\.(json|send)\(/);
    if (jm) {
      const open = b.indexOf('(', b.indexOf(jm[0]) + jm[0].length - 1);
      const end = balanced(b, open);
      const arg = b.slice(open + 1, end);
      let v;
      try { v = evalJs(arg, scope); } catch { v = arg; }
      if (jm[1] === 'json' || (v && typeof v === 'object')) return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(v) };
      return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: String(v ?? '') };
    }
    return { status, body: '' };
  }

  logReq(req, status) { if (this.reqLog) this.log(`${req.fromIp} - - [${new Date(this.uni.time * 1000).toUTCString()}] "${req.method} ${req.path} HTTP/1.1" ${status} - "-" "curl/8.5.0"`); }
  log(line) { this.proc?.logSink?.(line); }
}

// ---------- Python ----------
class PyHttpServer {
  constructor({ host, uni, args, cwd, user }) { Object.assign(this, { host, uni, cwd, user }); this.kind = 'python'; this.memMB = 18; this.args = args; }
  start() {
    let port = 8000, bind = '0.0.0.0', dir = this.cwd;
    const a = this.args;
    for (let i = 0; i < a.length; i++) { if (/^\d+$/.test(a[i])) port = Number(a[i]); if (a[i] === '--bind' || a[i] === '-b') bind = a[++i]; if (a[i] === '--directory' || a[i] === '-d') dir = normPath(this.cwd + '/' + a[++i]); }
    if (port < 1024 && this.user !== 'root') return { ok: false, code: 1, logs: ['Traceback (most recent call last):', '  File "<frozen runpy>", line 198, in _run_module_as_main', 'PermissionError: [Errno 13] Permission denied'] };
    this.dir = dir;
    return { ok: true, ports: [{ port, addr: bind }], logs: [`Serving HTTP on ${bind} port ${port} (http://${bind}:${port}/) ...`] };
  }
  handle(req) {
    const p = normPath(this.dir + decodeURIComponent(req.path));
    let status = 200, body;
    if (this.host.isDir(p)) {
      if (this.host.files.has(p + '/index.html')) body = this.host.files.get(p + '/index.html');
      else body = `<!DOCTYPE HTML>\n<html><head><title>Directory listing for ${req.path}</title></head>\n<body><h1>Directory listing for ${req.path}</h1>\n<hr>\n<ul>\n${this.host.listDir(p).map(([n, k]) => `<li><a href="${n}${k === 'dir' ? '/' : ''}">${n}${k === 'dir' ? '/' : ''}</a></li>`).join('\n')}\n</ul>\n<hr>\n</body></html>`;
    } else if (this.host.files.has(p)) body = this.host.files.get(p);
    else { status = 404; body = '<!DOCTYPE HTML>\n<html><head><title>Error response</title></head><body><h1>Error response</h1><p>Error code: 404</p><p>Message: File not found.</p></body></html>'; }
    this.proc?.logSink?.(`${req.fromIp} - - [${new Date(this.uni.time * 1000).toUTCString().slice(5, 25)}] "${req.method} ${req.path} HTTP/1.1" ${status} -`);
    return { status, body };
  }
}

class FlaskApp {
  constructor({ host, uni, file, src, env, user }) {
    Object.assign(this, { host, uni, file, src, env, user });
    this.kind = 'python'; this.memMB = 40;
    this.routes = [];
    for (const m of src.matchAll(/@app\.(?:route|get|post)\(\s*['"]([^'"]+)['"][^)]*\)\s*\n\s*def\s+\w+\([^)]*\):\s*\n([\s\S]*?)(?=\n@app|\nif __name__|\n\S|$)/g)) {
      const ret = m[2].match(/return\s+(.+)/);
      this.routes.push({ path: m[1], ret: ret ? ret[1].trim() : "''" });
    }
  }
  start() {
    for (const m of this.src.matchAll(/os\.environ\[\s*['"](\w+)['"]\s*\]/g)) if (!(m[1] in this.env)) return { ok: false, code: 1, logs: ['Traceback (most recent call last):', `  File "${this.file}", line ${lineOf(this.src, m.index)}, in <module>`, `    ${this.src.split('\n')[lineOf(this.src, m.index) - 1].trim()}`, `KeyError: '${m[1]}'`] };
    if (/^\s*(from flask|import flask)/m.test(this.src) && !this.host.flaskInstalled && !this.host.packages.has('python3-flask')) return { ok: false, code: 1, logs: ['Traceback (most recent call last):', `  File "${this.file}", line 1, in <module>`, '    from flask import Flask', "ModuleNotFoundError: No module named 'flask'"] };
    const pm = this.src.match(/port\s*=\s*(?:int\(\s*os\.environ\.get\(\s*['"](\w+)['"]\s*,\s*['"]?(\d+)['"]?\s*\)\s*\)|(\d+))/);
    const port = pm ? Number(pm[3] || this.env[pm[1]] || pm[2]) : 5000;
    const hm = this.src.match(/host\s*=\s*['"]([^'"]+)['"]/);
    const bind = hm ? hm[1] : '127.0.0.1';
    return { ok: true, ports: [{ port, addr: bind }], logs: [` * Serving Flask app '${this.file.split('/').pop().replace('.py', '')}'`, ' * Debug mode: off', ` * Running on http://${bind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'}:${port}`, 'Press CTRL+C to quit'] };
  }
  handle(req) {
    const r = this.routes.find(x => x.path === req.path);
    if (!r) return { status: 404, body: '<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>' };
    let body = r.ret;
    const j = body.match(/^jsonify\(([\s\S]*)\)$/);
    try {
      const v = evalJs((j ? j[1] : body).replace(/os\.environ\.get\(\s*['"](\w+)['"]\s*(?:,\s*([^)]+))?\)/g, (_, k, d) => JSON.stringify(this.env[k] ?? (d ? evalJs(d) : null))).replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null'), { env: this.env });
      body = typeof v === 'object' ? JSON.stringify(v) : String(v);
    } catch { /* keep raw */ }
    return { status: 200, body };
  }
}

// ---------- datastores ----------
class Datastore {
  constructor({ host, uni, kind, port, conf }) { Object.assign(this, { host, uni, kind, port, conf }); this.memMB = kind === 'redis' ? 8 : 60; this.data = new Map(); }
  start() {
    let bind = this.kind === 'redis' ? '127.0.0.1' : 'localhost';
    if (this.conf) {
      const text = this.host.files.get(this.conf) || '';
      const b = text.match(this.kind === 'redis' ? /^\s*bind\s+([^\s#]+)/m : /^\s*listen_addresses\s*=\s*'([^']+)'/m);
      if (b) bind = b[1] === '*' ? '0.0.0.0' : b[1];
      const p = text.match(this.kind === 'redis' ? /^\s*port\s+(\d+)/m : /^\s*port\s*=\s*(\d+)/m);
      if (p) this.port = Number(p[1]);
      const pw = text.match(/^\s*requirepass\s+(\S+)/m);
      this.password = pw ? pw[1] : this.host.labDbPassword || null;
    }
    const logs = this.kind === 'redis' ? [`* Redis version=7.2.4, bits=64, pid=${Math.floor(Math.random() * 9000) + 1000}, just started`, `* Running mode=standalone, port=${this.port}.`, '* Ready to accept connections tcp'] : ['LOG:  starting PostgreSQL 16.4 (Ubuntu 16.4-0ubuntu0.24.04.2) on x86_64-pc-linux-gnu', `LOG:  listening on IPv4 address "${bind === 'localhost' ? '127.0.0.1' : bind}", port ${this.port}`, 'LOG:  database system is ready to accept connections'];
    return { ok: true, ports: [{ port: this.port, addr: bind === 'localhost' ? '127.0.0.1' : bind }], logs };
  }
  checkAuth(url) {
    if (this.kind !== 'postgres') return null;
    const m = String(url).match(/^\w+:\/\/([^:@]+)(?::([^@]*))?@/);
    const want = this.host.labDbPassword;
    if (want && (!m || m[2] !== want)) return `error: password authentication failed for user "${m ? m[1] : 'postgres'}"`;
    return null;
  }
  handle() { return { error: 'EMPTY', detail: 'Empty reply from server' }; }
}

// hashicorp/http-echo: answers every request with the text it was started with
programFactories.set('http-echo', ({ argv }) => {
  const text = (argv.find(x => x.startsWith('-text=')) || '-text=hello-world').slice(6).replace(/^["']|["']$/g, '');
  const port = Number(((argv.find(x => x.startsWith('-listen=')) || '-listen=:5678').split(':').pop()));
  return { kind: 'http-echo', memMB: 4, start: () => ({ ok: true, ports: [{ port, addr: '0.0.0.0' }], logs: [`${new Date().toISOString().slice(0, 10)} [INFO] server is listening on :${port}`] }), handle: () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text + '\n' }) };
});

// ---------- launching ----------
export function resolveProgram(host, argv, { cwd, env, user, uni }) {
  const name = argv[0].split('/').pop();
  const absArg = p => normPath(p.startsWith('/') ? p : cwd + '/' + p);
  if (programFactories.has(name)) return programFactories.get(name)({ host, uni, argv, cwd, env, user });
  if (name === 'node' || name === 'nodejs') {
    const fileArg = argv.slice(1).find(a => !a.startsWith('-'));
    if (!fileArg) return { error: 'node: the simulator has no interactive REPL; run a file: node server.js', code: 1 };
    let file = absArg(fileArg);
    if (!host.files.has(file) && host.files.has(file + '.js')) file += '.js';
    if (host.isDir(file) && host.files.has(file + '/index.js')) file += '/index.js';
    if (!host.files.has(file)) return { error: ['node:internal/modules/cjs/loader:1228', '  throw err;', '  ^', '', `Error: Cannot find module '${file}'`, '    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)', "  code: 'MODULE_NOT_FOUND',", '', 'Node.js v20.18.0'].join('\n'), code: 1 };
    return new NodeApp({ host, uni, file, src: host.files.get(file), env, cwd, user });
  }
  if (name === 'python3' || name === 'python') {
    if (argv[1] === '-m' && argv[2] === 'http.server') return new PyHttpServer({ host, uni, args: argv.slice(3), cwd, user });
    const fileArg = argv.slice(1).find(a => !a.startsWith('-'));
    if (!fileArg) return { error: 'python3: the simulator has no interactive REPL; run a file: python3 app.py', code: 1 };
    const file = absArg(fileArg);
    if (!host.files.has(file)) return { error: `python3: can't open file '${file}': [Errno 2] No such file or directory`, code: 2 };
    const src = host.files.get(file);
    if (/Flask\(/.test(src)) return new FlaskApp({ host, uni, file, src, env, user });
    return { script: src, file };
  }
  if (name === 'gunicorn' || name === 'uvicorn') {
    const mod = argv.find(a => /^[\w.]+:\w+$/.test(a)) || 'app:app';
    const file = normPath(cwd + '/' + mod.split(':')[0].replace(/\./g, '/') + '.py');
    if (!host.files.has(file)) return { error: `ModuleNotFoundError: No module named '${mod.split(':')[0]}'`, code: 1 };
    const app = new FlaskApp({ host, uni, file, src: host.files.get(file), env, user });
    const bindArg = argv[argv.indexOf('--bind') + 1] || argv[argv.indexOf('-b') + 1];
    const portArg = argv[argv.indexOf('--port') + 1];
    const orig = app.start.bind(app);
    app.start = () => { const r = orig(); if (!r.ok) return r; const [h, p] = (bindArg && bindArg.includes(':')) ? bindArg.split(':') : ['127.0.0.1', portArg || '8000']; return { ok: true, ports: [{ port: Number(p), addr: h }], logs: [`[INFO] Starting ${name}`, `[INFO] Listening at: http://${h}:${p}`, '[INFO] Booting worker with pid: 4242'] }; };
    return app;
  }
  if (name === 'redis-server') return new Datastore({ host, uni, kind: 'redis', port: Number(argv[argv.indexOf('--port') + 1]) || 6379, conf: argv.find(a => a.endsWith('.conf')) || '/etc/redis/redis.conf' });
  if (name === 'postgres' || name === 'postgresql') return new Datastore({ host, uni, kind: 'postgres', port: 5432, conf: '/etc/postgresql/16/main/postgresql.conf' });
  if (name === 'npm' && (argv[1] === 'start' || (argv[1] === 'run' && argv[2]))) {
    const pkgPath = normPath(cwd + '/package.json');
    if (!host.files.has(pkgPath)) return { error: `npm error code ENOENT\nnpm error path ${pkgPath}\nnpm error enoent Could not read package.json`, code: 254 };
    let pkg; try { pkg = JSON.parse(host.files.get(pkgPath)); } catch { return { error: 'npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json', code: 1 }; }
    const script = pkg.scripts?.[argv[1] === 'start' ? 'start' : argv[2]] || (argv[1] === 'start' && host.files.has(normPath(cwd + '/server.js')) ? 'node server.js' : null);
    if (!script) return { error: `npm error Missing script: "${argv[1] === 'start' ? 'start' : argv[2]}"`, code: 1 };
    const p = resolveProgram(host, script.split(/\s+/), { cwd, env, user, uni });
    if (p && !p.error) p.banner = [`> ${pkg.name}@${pkg.version || '1.0.0'} ${argv[1] === 'start' ? 'start' : argv[2]}`, `> ${script}`, ''];
    return p;
  }
  return null;
}

// Start a program as a process. Returns { ok, code, logs, proc }.
export function launch(host, argv, { uni, user = 'root', env = {}, cwd = '/', unit = null, logSink = null } = {}) {
  const prog = resolveProgram(host, argv, { cwd, env, user, uni });
  if (!prog) return { ok: false, code: 127, logs: [], notProgram: true };
  if (prog.error) return { ok: false, code: prog.code || 1, logs: String(prog.error).split('\n') };
  if (prog.script !== undefined) return { ok: true, code: 0, logs: [], script: prog.script, oneShot: true };
  const r = prog.start();
  const logs = [...(prog.banner || []), ...(r.logs || [])];
  if (!r.ok) return { ok: false, code: r.code ?? 1, logs };
  if (r.oneShot) return { ok: true, code: 0, logs, oneShot: true };
  const proc = host.addProc({ cmd: argv.join(' '), user, mem: prog.memMB || 30, cpu: prog.cpu || 0.3, unit, program: prog, env, cwd });
  prog.proc = proc;
  proc.logSink = logSink;
  for (const p of r.ports || []) {
    try { host.listen(p.port, proc.pid, { addr: p.addr, program: prog }); }
    catch (e) {
      host.procs.delete(proc.pid);
      const port = p.port;
      return { ok: false, code: 1, logs: [...logs.slice(0, prog.banner?.length || 0), `Error: listen EADDRINUSE: address already in use :::${port}`, '    at Server.setupListenHandle [as _listen2] (node:net:1872:16) {', "  code: 'EADDRINUSE',", "  errno: -98,", "  syscall: 'listen',", `  port: ${port}`, '}', '', 'Node.js v20.18.0'] };
    }
  }
  uni.emit({ type: 'proc-start', host: host.name, pid: proc.pid, cmd: proc.cmd, ports: (r.ports || []).map(p => p.port), unit });
  return { ok: true, code: 0, logs, proc };
}

export { SimError, httpRequest };
