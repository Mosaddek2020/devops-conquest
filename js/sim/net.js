// The network: name resolution, TCP connects (with firewalls and bind addresses),
// HTTP requests routed to whatever program listens on the port, and TLS certificates.
//
// connect() distinguishes the failures people actually meet:
//   ENOTFOUND     the name does not resolve
//   ECONNREFUSED  the host is up but nothing listens there (or it listens on 127.0.0.1 only)
//   ETIMEDOUT     a firewall silently drops the packets (or the host is down)

export function parseUrl(raw) {
  let url = String(raw).trim();
  if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
  const m = url.match(/^([a-z]+):\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?([^?#]*)(\?[^#]*)?/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  return { scheme, auth: m[2] || null, host: m[3].toLowerCase(), port: m[4] ? Number(m[4]) : (scheme === 'https' ? 443 : scheme === 'http' ? 80 : null), path: m[5] || '/', query: m[6] || '', raw: url };
}

// cloud security groups / network ACLs can veto traffic between hosts (set by the cloud sim)
function cloudAllows(uni, from, to, port) {
  if (!uni.cloudFilter) return true;
  return uni.cloudFilter(from, to, port);
}

function firewallAllows(target, fromIp, port, proto = 'tcp') {
  const fw = target.firewall;
  if (!fw?.enabled) return true;
  for (const r of fw.rules) {
    if (r.port !== undefined && r.port !== port && !(r.ports && r.ports.includes(port))) continue;
    if (r.proto && r.proto !== proto && r.proto !== 'any') continue;
    if (r.from && r.from !== 'any' && !ipMatches(fromIp, r.from)) continue;
    return r.action === 'allow';
  }
  return fw.defaultIn === 'allow';
}

export function ipMatches(ip, cidr) {
  if (!cidr || cidr === 'any' || cidr === '0.0.0.0/0') return true;
  const [base, bits = '32'] = cidr.split('/');
  const toInt = s => s.split('.').reduce((a, x) => (a << 8) + Number(x), 0) >>> 0;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

// where does a packet from `from` to `name` land? returns { host, ip } or { error }
export function resolveTarget(uni, from, name) {
  const ip = uni.resolveName(name, from);
  if (!ip) return { error: 'ENOTFOUND', name };
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return { host: from, ip, loopback: true };
  if (from.ip === ip) return { host: from, ip, loopback: true };
  const target = from.netLookup ? from.netLookup(ip) : null;
  if (target) return { host: target, ip };
  const host = uni.byIp.get(ip);
  if (!host) return { error: 'EHOSTUNREACH', ip };
  return { host, ip };
}

export function connect(uni, from, name, port) {
  const t = resolveTarget(uni, from, name);
  if (t.error) return t;
  const target = t.host;
  if (target.down) return { error: 'ETIMEDOUT', ip: t.ip };
  if (!t.loopback) {
    if (from.netBlocked?.(target)) return { error: 'ETIMEDOUT', ip: t.ip };
    if (!cloudAllows(uni, from, target, port)) return { error: 'ETIMEDOUT', ip: t.ip };
    if (!firewallAllows(target, from.ip, port)) return { error: 'ETIMEDOUT', ip: t.ip };
  }
  const l = target.listening.get(port);
  if (!l || !target.procs.has(l.pid)) return { error: 'ECONNREFUSED', ip: t.ip, port };
  if (!t.loopback && (l.addr === '127.0.0.1' || l.addr === 'localhost')) return { error: 'ECONNREFUSED', ip: t.ip, port };
  return { host: target, ip: t.ip, listener: l, proc: target.procs.get(l.pid) };
}

const REASONS = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
export const reason = s => REASONS[s] || '';

// Make an HTTP(S) request from a host. Returns { status, headers, body, cert? } or { error, detail }.
export function httpRequest(uni, from, rawUrl, { method = 'GET', headers = {}, body = '', insecure = false, depth = 0 } = {}) {
  const u = parseUrl(rawUrl);
  if (!u) return { error: 'BADURL', detail: `URL rejected: Malformed input to a URL function` };
  for (const hook of uni.httpHooks) {
    const r = hook({ url: u, method, headers, body, from });
    if (r) return r;
  }
  const conn = connect(uni, from, u.host, u.port);
  if (conn.error) return { error: conn.error, ip: conn.ip, host: u.host, port: u.port };
  const prog = conn.listener.program;
  if (!prog || !prog.handle) return { error: 'EMPTY', detail: 'Empty reply from server', host: u.host, port: u.port };
  let cert = null;
  if (u.scheme === 'https') {
    cert = prog.certFor?.(u.port, u.host) || null;
    if (!cert) return { error: 'TLS', detail: `OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to ${u.host}:${u.port}`, code: 35 };
    const problem = certProblem(cert, u.host, uni.time);
    if (problem && !insecure) return { error: 'TLS', detail: `SSL certificate problem: ${problem}`, code: 60, cert };
  } else if (prog.tlsOnly?.(u.port)) {
    return { status: 400, headers: { 'content-type': 'text/html' }, body: '<html><center><h1>400 Bad Request</h1>The plain HTTP request was sent to HTTPS port</center></html>' };
  }
  const req = { method, path: u.path, query: u.query, headers: { host: u.host, ...lower(headers) }, body, port: u.port, scheme: u.scheme, fromIp: conn.loopback ? '127.0.0.1' : from.ip, host: u.host, depth };
  let res;
  try { res = prog.handle(req, { uni, host: conn.host, proc: conn.proc }); }
  catch (e) { console.error(e); res = { status: 500, body: 'Internal Server Error' }; }
  if (!res) return { error: 'EMPTY', detail: 'Empty reply from server' };
  if (res.error) return res;
  return { status: res.status || 200, headers: { 'content-type': guessType(res.body), ...(res.headers || {}) }, body: res.body ?? '', cert, latencyMs: res.latencyMs };
}

const lower = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
export const guessType = b => /^\s*[{[]/.test(String(b ?? '')) ? 'application/json' : /^\s*</.test(String(b ?? '')) ? 'text/html' : 'text/plain';

// ---------- certificates ----------
// A certificate is stored as a PEM-looking file whose base64 body encodes JSON metadata.

export function makeCertPem(meta) {
  const b64 = btoa(JSON.stringify(meta));
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

export function readCertPem(text) {
  const m = String(text || '').match(/-----BEGIN CERTIFICATE-----\n([\s\S]*?)\n-----END CERTIFICATE-----/);
  if (!m) return null;
  try { return JSON.parse(atob(m[1].replace(/\s+/g, ''))); } catch { return null; }
}

const TRUSTED = new Set(["Let's Encrypt R10", "Let's Encrypt R11", 'DigiCert Global G2', 'Amazon RSA 2048 M02', 'Internal CA']);

export function certProblem(cert, hostname, now) {
  if (cert.selfSigned) return 'self-signed certificate';
  if (!TRUSTED.has(cert.issuer)) return 'unable to get local issuer certificate';
  if (now > cert.notAfter) return 'certificate has expired';
  if (now < cert.notBefore) return 'certificate is not yet valid';
  const names = [cert.cn, ...(cert.sans || [])];
  const ok = names.some(n => n === hostname || (n?.startsWith('*.') && hostname.endsWith(n.slice(1)) && hostname.split('.').length === n.split('.').length));
  if (!ok) return `no alternative certificate subject name matches target host name '${hostname}'`;
  return null;
}
