// Network commands: ip, ifconfig, ss, netstat, ping, traceroute, curl, wget, dig, nslookup,
// host, nc, ufw, iptables, openssl and certbot.

import { def, opts } from '../registry.js';
import { fsx } from '../fsx.js';
import { connect, httpRequest, parseUrl, reason, resolveTarget, makeCertPem, readCertPem, certProblem, ipMatches } from '../net.js';
import { loadConfig, Nginx } from '../nginx.js';
import { C } from '../../git/world.js';
import { fmtDate } from './core.js';

def('ip', c => {
  const [obj = '', sub] = c.args.filter(a => !a.startsWith('-'));
  const h = c.host;
  if ('address'.startsWith(obj) || obj === 'a') {
    c.print('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000', '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00', '    inet 127.0.0.1/8 scope host lo', '       valid_lft forever preferred_lft forever',
      `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu ${h.mtu || 1500} qdisc fq_codel state UP group default qlen 1000`, `    link/ether 02:42:${h.ip.split('.').map(x => Number(x).toString(16).padStart(2, '0')).join(':')} brd ff:ff:ff:ff:ff:ff`, `    inet ${h.ip}/${h.prefix || 24} brd ${h.ip.replace(/\.\d+$/, '.255')} scope global eth0`, '       valid_lft forever preferred_lft forever');
    if (h.extraIfaces) for (const l of h.extraIfaces) c.print(l);
    return 0;
  }
  if ('route'.startsWith(obj) || obj === 'r') { c.print(`default via ${h.gateway || h.ip.replace(/\.\d+$/, '.1')} dev eth0 proto dhcp src ${h.ip} metric 100`, `${h.ip.replace(/\.\d+$/, '.0')}/${h.prefix || 24} dev eth0 proto kernel scope link src ${h.ip}`); return 0; }
  if ('link'.startsWith(obj) || obj === 'l') { c.print('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN', `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu ${h.mtu || 1500} state UP`); return 0; }
  return c.fail(`Object "${obj}" is unknown, try "ip help".`, 1);
});

def('ifconfig', c => { const h = c.host; c.print(`eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`, `        inet ${h.ip}  netmask 255.255.255.0  broadcast ${h.ip.replace(/\.\d+$/, '.255')}`, '', 'lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536', '        inet 127.0.0.1  netmask 255.0.0.0'); return 0; });

def(['ss', 'netstat'], c => {
  const flags = c.args.filter(a => a.startsWith('-')).join('');
  const h = c.host;
  const showProc = flags.includes('p');
  const rows = [...h.listening].sort((a, b) => a[0] - b[0]);
  if (c.name === 'netstat') c.print('Active Internet connections (only servers)', 'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name');
  else c.print(`${'State'.padEnd(10)}${'Recv-Q'.padStart(6)} ${'Send-Q'.padStart(6)} ${'Local Address:Port'.padEnd(24)} ${'Peer Address:Port'.padEnd(18)}${showProc ? 'Process' : ''}`);
  for (const [port, l] of rows) {
    const p = h.procs.get(l.pid);
    if (!p) continue;
    const local = `${l.addr === '0.0.0.0' ? (c.name === 'ss' ? '0.0.0.0' : '0.0.0.0') : l.addr}:${port}`;
    const name = p.cmd.split(' ')[0].split('/').pop().replace(':', '');
    const proc = showProc ? (c.user === 'root' || p.user === c.user ? (c.name === 'ss' ? `users:(("${name}",pid=${p.pid},fd=6))` : `${p.pid}/${name}`) : (c.name === 'ss' ? '' : '-')) : '';
    if (c.name === 'netstat') c.print(`tcp        0      0 ${local.padEnd(23)} 0.0.0.0:*               LISTEN      ${proc}`);
    else c.print(`${'LISTEN'.padEnd(10)}${'0'.padStart(6)} ${'4096'.padStart(6)} ${local.padEnd(24)} ${'0.0.0.0:*'.padEnd(18)}${proc}`);
  }
  if (showProc && c.user !== 'root' && rows.some(([, l]) => h.procs.get(l.pid)?.user !== c.user)) c.eprint(C.dim(c.name === 'netstat' ? '(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)' : '(processes owned by other users are hidden: run with sudo to see them)'));
  return 0;
}, { always: true });

def('ping', c => {
  const o = opts(c.args, { bool: ['-q', '-4', '-n'], val: ['-c', '-W', '-i', '-w'] });
  const name = o._[0];
  if (!name) return c.fail('ping: usage error: Destination address required', 1);
  const count = Math.min(Number(o['-c'] || 4), 10);
  const t = resolveTarget(c.uni, c.host, name);
  if (t.error === 'ENOTFOUND') return c.fail(`ping: ${name}: Temporary failure in name resolution`, 2);
  const ip = t.ip || name;
  const dropped = t.error || t.host?.down || t.host?.icmpBlocked || (t.host && c.uni.cloudFilter && !t.loopback && !c.uni.cloudFilter(c.host, t.host, 'icmp'));
  c.print(`PING ${name} (${ip}) 56(84) bytes of data.`);
  if (!dropped) for (let i = 1; i <= count; i++) c.print(`64 bytes from ${t.loopback ? 'localhost (127.0.0.1)' : ip}: icmp_seq=${i} ttl=${t.loopback ? 64 : 63} time=${(t.loopback ? 0.04 : (t.host.latencyMs || 0.4)) + (i % 3) * 0.07} ms`);
  c.print('', `--- ${name} ping statistics ---`, `${count} packets transmitted, ${dropped ? 0 : count} received, ${dropped ? 100 : 0}% packet loss, time ${count * 1000 - 3}ms`);
  if (!dropped) c.print(`rtt min/avg/max/mdev = 0.041/0.152/0.398/0.091 ms`);
  c.uni.emit({ type: 'ping', host: c.host.name, target: name, ok: !dropped });
  return dropped ? 1 : 0;
});

def(['traceroute', 'tracepath', 'mtr'], c => {
  const name = c.args.filter(a => !a.startsWith('-'))[0];
  const t = resolveTarget(c.uni, c.host, name);
  if (t.error === 'ENOTFOUND') return c.fail(`${name}: Name or service not known\nCannot handle "host" cmdline arg \`${name}' on position 1 (argc 1)`, 2);
  c.print(`traceroute to ${name} (${t.ip}), 30 hops max, 60 byte packets`);
  c.print(` 1  _gateway (${c.host.ip.replace(/\.\d+$/, '.1')})  0.412 ms  0.388 ms  0.371 ms`);
  if (t.host?.down || t.error) for (let i = 2; i <= 5; i++) c.print(` ${i}  * * *`);
  else c.print(` 2  ${name} (${t.ip})  0.902 ms  0.871 ms  0.866 ms`);
  return 0;
});

function dnsAnswer(uni, from, name, type = 'A') {
  const recs = uni.dnsRecords?.[name.replace(/\.$/, '')];
  if (recs && recs[type]) return [].concat(recs[type]);
  if (type === 'A') { const ip = uni.dns.get(name.replace(/\.$/, '')); return ip ? [ip] : []; }
  return [];
}

def('dig', c => {
  const args = c.args.filter(a => !a.startsWith('@') && !a.startsWith('+'));
  const short = c.args.includes('+short');
  const name = args.find(a => !/^(A|AAAA|MX|TXT|CNAME|NS|SOA|ANY)$/i.test(a)) || '.';
  const type = (args.find(a => /^(A|AAAA|MX|TXT|CNAME|NS|SOA|ANY)$/i.test(a)) || 'A').toUpperCase();
  let answers = dnsAnswer(c.uni, c.host, name, type);
  let cname = null;
  if (type === 'A' && !answers.length) { const cn = c.uni.dnsRecords?.[name]?.CNAME; if (cn) { cname = cn; answers = dnsAnswer(c.uni, c.host, cn, 'A'); } }
  c.uni.emit({ type: 'dns', host: c.host.name, name, rtype: type, answers });
  if (short) { if (cname) c.print(cname + '.'); c.print(...answers); return 0; }
  c.print('', `; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${name}${type !== 'A' ? ' ' + type : ''}`, ';; global options: +cmd', ';; Got answer:', `;; ->>HEADER<<- opcode: QUERY, status: ${answers.length || cname ? 'NOERROR' : 'NXDOMAIN'}, id: 41372`, `;; flags: qr rd ra; QUERY: 1, ANSWER: ${answers.length + (cname ? 1 : 0)}, AUTHORITY: 0, ADDITIONAL: 1`, '', ';; QUESTION SECTION:', `;${name}.\t\t\tIN\t${type}`);
  if (answers.length || cname) {
    c.print('', ';; ANSWER SECTION:');
    if (cname) c.print(`${name}.\t300\tIN\tCNAME\t${cname}.`);
    for (const a of answers) c.print(`${cname || name}.\t300\tIN\t${type}\t${a}`);
  }
  c.print('', `;; Query time: 12 msec`, `;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)`, `;; WHEN: ${fmtDate(c.uni.time)}`, ';; MSG SIZE  rcvd: 56', '');
  return 0;
});
def(['nslookup', 'host'], c => {
  const name = c.args.filter(a => !a.startsWith('-'))[0];
  const ans = dnsAnswer(c.uni, c.host, name, 'A');
  const cn = c.uni.dnsRecords?.[name]?.CNAME;
  const final = ans.length ? ans : (cn ? dnsAnswer(c.uni, c.host, cn, 'A') : []);
  if (c.name === 'host') { if (!final.length) return c.fail(`Host ${name} not found: 3(NXDOMAIN)`, 1); if (cn) c.print(`${name} is an alias for ${cn}.`); for (const a of final) c.print(`${cn || name} has address ${a}`); return 0; }
  c.print('Server:\t\t127.0.0.53', 'Address:\t127.0.0.53#53', '');
  if (!final.length) { c.print(`** server can't find ${name}: NXDOMAIN`); return 1; }
  c.print('Non-authoritative answer:');
  if (cn) c.print(`${name}\tcanonical name = ${cn}.`);
  for (const a of final) c.print(`Name:\t${cn || name}`, `Address: ${a}`);
  return 0;
});

const CURL_ERR = { ENOTFOUND: [6, h => `Could not resolve host: ${h}`], ECONNREFUSED: [7, (h, p) => `Failed to connect to ${h} port ${p} after 0 ms: Couldn't connect to server`], ETIMEDOUT: [28, (h, p) => `Failed to connect to ${h} port ${p} after 10002 ms: Timeout was reached`], EHOSTUNREACH: [7, (h, p) => `Failed to connect to ${h} port ${p} after 3061 ms: No route to host`], EMPTY: [52, () => 'Empty reply from server'], RESET: [56, () => 'Recv failure: Connection reset by peer'], BADURL: [3, () => 'URL rejected: Malformed input to a URL function'] };

def('curl', c => {
  const o = opts(c.args, { bool: ['-s', '-S', '-f', '-i', '-I', '-L', '-k', '-v', '-sS', '--fail', '--silent', '--include', '--head', '--location', '--insecure', '--verbose', '-fsS', '-sf', '-fs'], val: ['-X', '-H', '-d', '-o', '-w', '-u', '--data', '--header', '--request', '--connect-timeout', '-m', '--max-time', '--data-raw', '-A', '--json'], alias: { '--fail': '-f', '--silent': '-s', '--include': '-i', '--head': '-I', '--location': '-L', '--insecure': '-k', '--verbose': '-v', '--request': '-X', '--data': '-d', '--data-raw': '-d', '--header': '-H' } });
  // collect repeated -H
  const headers = {};
  for (let i = 0; i < c.args.length; i++) if (c.args[i] === '-H' || c.args[i] === '--header') { const [k, ...v] = c.args[i + 1].split(':'); headers[k.trim()] = v.join(':').trim(); }
  const flagStr = c.args.filter(a => /^-[a-zA-Z]+$/.test(a)).join('');
  const has = f => o['-' + f] || flagStr.includes(f);
  const silent = has('s'), showErr = has('S'), fail = has('f'), incl = has('i'), head = has('I'), follow = has('L'), insecure = has('k'), verbose = has('v');
  const url = o._[0];
  if (!url) return c.fail("curl: try 'curl --help' or 'curl --manual' for more information", 2);
  let method = o['-X'] || (head ? 'HEAD' : (o['-d'] !== undefined || o['--json'] !== undefined) ? 'POST' : 'GET');
  let body = o['-d'] ?? o['--json'] ?? '';
  if (o['--json'] !== undefined) headers['Content-Type'] = 'application/json';
  let target = url, res, hops = 0;
  const u0 = parseUrl(url);
  if (verbose) c.eprint(`*   Trying ${c.uni.resolveName(u0?.host, c.host) || u0?.host}:${u0?.port}...`);
  while (true) {
    res = httpRequest(c.uni, c.host, target, { method: method === 'HEAD' ? 'GET' : method, headers, body, insecure });
    c.uni.emit({ type: 'http', host: c.host.name, url: target, method, status: res.status ?? null, error: res.error || null });
    if (!res.error && follow && [301, 302, 303, 307, 308].includes(res.status) && res.headers?.location && hops < 10) {
      if (incl || head) { c.print(`HTTP/1.1 ${res.status} ${reason(res.status)}`, `Location: ${res.headers.location}`, ''); }
      const loc = res.headers.location;
      target = /^https?:\/\//.test(loc) ? loc : (() => { const u = parseUrl(target); return `${u.scheme}://${u.host}${u.port && ![80, 443].includes(u.port) ? ':' + u.port : ''}${loc}`; })();
      hops++; continue;
    }
    break;
  }
  const u = parseUrl(target);
  if (res.error) {
    if (res.error === 'TLS') {
      if (!silent || showErr) c.eprint(`curl: (${res.code || 60}) ${res.detail}`, res.code === 60 ? `More details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it. To learn more about this situation and\nhow to fix it, please visit the webpage mentioned above.` : '');
      return res.code || 60;
    }
    const [code, fn] = CURL_ERR[res.error] || [7, () => res.detail || res.error];
    if (!silent || showErr) c.eprint(`curl: (${code}) ${fn(u?.host, u?.port)}`);
    if (o['-w']) c.out(o['-w'].replace(/%\{http_code\}/g, '000').replace(/%\{time_total\}/g, '0.000000').replace(/%\{size_download\}/g, '0').replace(/\\n/g, '\n'));
    return code;
  }
  if (verbose) { c.eprint(`* Connected to ${u.host} port ${u.port}`, `> ${method} ${u.path}${u.query} HTTP/1.1`, `> Host: ${u.host}`, '> User-Agent: curl/8.5.0', '> Accept: */*', '>', `< HTTP/1.1 ${res.status} ${reason(res.status)}`, ...Object.entries(res.headers || {}).map(([k, v]) => `< ${k}: ${v}`), '<'); }
  if (fail && res.status >= 400) { if (!silent || showErr) c.eprint(`curl: (22) The requested URL returned error: ${res.status}`); return 22; }
  const lines = [];
  if (incl || head) { lines.push(`HTTP/1.1 ${res.status} ${reason(res.status)}`, ...Object.entries(res.headers || {}).map(([k, v]) => `${k.replace(/(^|-)\w/g, m => m.toUpperCase())}: ${v}`), `Content-Length: ${String(res.body).length}`, ''); }
  const text = (head ? lines.join('\n') + '\n' : lines.join('\n') + (lines.length ? '\n' : '') + String(res.body ?? '') + (String(res.body ?? '').endsWith('\n') || !res.body ? '' : '\n'));
  if (o['-o']) { if (o['-o'] !== '/dev/null') fsx(c).write(o['-o'], String(res.body ?? '')); if (!silent) c.eprint(`  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n100  ${String(String(res.body).length).padStart(4)}  100  ${String(String(res.body).length).padStart(4)}    0     0  41213      0 --:--:-- --:--:-- --:--:-- 41213`); }
  else c.out(text);
  if (o['-w']) c.out(o['-w'].replace(/%\{http_code\}/g, String(res.status)).replace(/%\{time_total\}/g, ((res.latencyMs || 12) / 1000).toFixed(6)).replace(/%\{size_download\}/g, String(String(res.body).length)).replace(/\\n/g, '\n'));
  return 0;
});

def('wget', c => {
  const o = opts(c.args, { bool: ['-q', '--spider', '-S'], val: ['-O', '-T'] });
  const url = o._[0];
  if (!url) return c.fail('wget: missing URL', 1);
  const u = parseUrl(url);
  const res = httpRequest(c.uni, c.host, url);
  c.uni.emit({ type: 'http', host: c.host.name, url, method: 'GET', status: res.status ?? null, error: res.error || null });
  if (!o['-q']) c.eprint(`--${fmtDate(c.uni.time, '%F %T')}--  ${url}`, `Resolving ${u.host}... ${c.uni.resolveName(u.host, c.host) || 'failed'}`);
  if (res.error) { if (!o['-q']) c.eprint(res.error === 'ENOTFOUND' ? `wget: unable to resolve host address '${u.host}'` : `Connecting to ${u.host}|${c.uni.resolveName(u.host, c.host)}|:${u.port}... failed: ${res.error === 'ETIMEDOUT' ? 'Connection timed out' : 'Connection refused'}.`); return 4; }
  if (!o['-q']) c.eprint(`HTTP request sent, awaiting response... ${res.status} ${reason(res.status)}`);
  if (res.status >= 400) { if (!o['-q']) c.eprint(`${fmtDate(c.uni.time, '%F %T')} ERROR ${res.status}: ${reason(res.status)}.`); return 8; }
  if (o['--spider']) return 0;
  const out = o['-O'] || (u.path.split('/').pop() || 'index.html');
  if (out === '-') c.out(String(res.body)); else { fsx(c).write(out, String(res.body)); if (!o['-q']) c.eprint(`Saving to: '${out}'`, '', `'${out}' saved [${String(res.body).length}]`); }
  return 0;
});

def(['nc', 'netcat', 'telnet'], c => {
  const o = opts(c.args, { bool: ['-z', '-v', '-u', '-l', '-n', '-zv', '-vz'], val: ['-w'] });
  const [hostName, portSpec] = o._;
  if (o['-l']) return c.fail(C.dim('(listening with nc is not simulated)'), 1);
  if (!hostName || !portSpec) return c.fail(`usage: ${c.name} [-46CDdFhklNnrStUuvZz] [-I length] [-i interval] [-M ttl]\n\t  [-m minttl] [-O length] [-P proxy_username] [-p source_port]\n\t  [-q seconds] [-s sourceaddr] [-T keyword] [-V rtable] [-W recvlimit]\n\t  [-w timeout] [-X proxy_protocol] [-x proxy_address[:port]]\n\t  [destination] [port]`, 1);
  const ports = portSpec.includes('-') ? (() => { const [a, b] = portSpec.split('-').map(Number); return Array.from({ length: Math.min(b - a + 1, 50) }, (_, k) => a + k); })() : [Number(portSpec)];
  let ok = false;
  for (const port of ports) {
    const r = connect(c.uni, c.host, hostName, port);
    c.uni.emit({ type: 'tcp-check', host: c.host.name, target: hostName, port, ok: !r.error, error: r.error || null });
    if (c.name === 'telnet') {
      if (r.error) { c.print(`Trying ${r.ip || hostName}...`); c.eprint(r.error === 'ENOTFOUND' ? `telnet: could not resolve ${hostName}/${port}: Name or service not known` : `telnet: Unable to connect to remote host: ${r.error === 'ETIMEDOUT' ? 'Connection timed out' : 'Connection refused'}`); return 1; }
      c.print(`Trying ${r.ip}...`, `Connected to ${hostName}.`, "Escape character is '^]'.", 'Connection closed by foreign host.');
      return 0;
    }
    const verbose = o['-v'] || o['-zv'] || o['-vz'] || c.args.some(a => /^-[a-z]*v/.test(a));
    if (r.error === 'ENOTFOUND') { c.eprint(`nc: getaddrinfo for host "${hostName}" port ${port}: Name or service not known`); return 1; }
    if (r.error) { if (verbose) c.eprint(`nc: connect to ${hostName} (${r.ip}) port ${port} (tcp) ${r.error === 'ETIMEDOUT' ? 'timed out: Operation now in progress' : 'failed: Connection refused'}`); continue; }
    ok = true;
    if (verbose) c.eprint(`Connection to ${hostName} (${r.ip}) ${port} port [tcp/*] succeeded!`);
  }
  return ok ? 0 : 1;
});

def('nmap', c => {
  const o = opts(c.args, { bool: ['-sT', '-sV', '-Pn', '-v', '-F'], val: ['-p'] });
  const target = o._[0];
  if (!target) return c.fail('Nmap 7.94SVN: no target specified', 1);
  const t = resolveTarget(c.uni, c.host, target);
  if (t.error === 'ENOTFOUND') return c.fail(`Failed to resolve "${target}".\nWARNING: No targets were specified, so 0 hosts scanned.`, 1);
  const spec = o['-p'] || '1-10000';
  const ports = spec === '-' ? Array.from({ length: 65535 }, (_, k) => k + 1) : spec.split(',').flatMap(r => { const [a, b] = r.split('-').map(Number); return b ? Array.from({ length: Math.min(b - a + 1, 65535) }, (_, k) => a + k) : [a]; });
  const NAMES = { 22: 'ssh', 25: 'smtp', 53: 'domain', 80: 'http', 443: 'https', 3000: 'ppp', 3306: 'mysql', 5432: 'postgresql', 6379: 'redis', 8080: 'http-proxy', 9090: 'zeus-admin', 9100: 'jetdirect', 27017: 'mongod' };
  c.print(`Starting Nmap 7.94SVN ( https://nmap.org ) at ${fmtDate(c.uni.time, '%F %H:%M')} UTC`, `Nmap scan report for ${target} (${t.ip})`);
  if (t.host?.down) { c.print('Host seems down. If it is really up, but blocking our ping probes, try -Pn'); return 0; }
  const rows = [];
  let filtered = 0, closed = 0;
  const interesting = new Set([...ports.filter(p => t.host?.listening.has(p)), ...ports.filter(p => NAMES[p])]);
  for (const p of ports) {
    if (!interesting.has(p)) { closed++; continue; }
    const r = connect(c.uni, c.host, target, p);
    if (!r.error) rows.push([p, 'open']);
    else if (r.error === 'ETIMEDOUT') { if (t.host?.listening.has(p)) rows.push([p, 'filtered']); else filtered++; }
    else closed++;
  }
  const fw = t.host && !t.loopback && t.host.firewall.enabled;
  if (fw) c.print(`Not shown: ${ports.length - rows.length} filtered tcp ports (no-response)`); else c.print(`Not shown: ${ports.length - rows.length} closed tcp ports (conn-refused)`);
  c.print('PORT      STATE    SERVICE');
  for (const [p, st] of rows) c.print(`${(p + '/tcp').padEnd(9)} ${st.padEnd(8)} ${NAMES[p] || 'unknown'}`);
  c.print('', `Nmap done: 1 IP address (1 host up) scanned in 1.${String(rows.length * 7 % 100).padStart(2, '0')} seconds`);
  c.uni.emit({ type: 'nmap', host: c.host.name, target, open: rows.filter(r => r[1] === 'open').map(r => r[0]) });
  void filtered; void closed;
  return 0;
}, { pkg: 'nmap' });

// ---------- ufw ----------
def('ufw', c => {
  const h = c.host;
  const fw = h.firewall;
  const args = c.args;
  if (c.user !== 'root') return c.fail('ERROR: You need to be root to run this script', 1);
  const [sub, ...rest] = args;
  const fmtRule = r => `${(r.port !== undefined ? r.port + (r.proto ? '/' + r.proto : '') : 'Anywhere').padEnd(27)}${(r.action === 'allow' ? 'ALLOW' : 'DENY').padEnd(11)} ${r.from && r.from !== 'any' ? r.from : 'Anywhere'}`;
  const named = { ssh: 22, http: 80, https: 443, OpenSSH: 22, 'Nginx Full': [80, 443], 'Nginx HTTP': 80, 'Nginx HTTPS': 443 };
  const parseRule = (action, words) => {
    // ufw allow 22/tcp | ufw allow ssh | ufw allow from 10.0.0.0/24 to any port 5432 | ufw allow proto tcp from x to any port 80
    const r = { action };
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (w === 'from') { r.from = words[++i]; i++; continue; }
      if (w === 'to') { i += 2; continue; }
      if (w === 'port') { r.port = Number(words[++i]); i++; continue; }
      if (w === 'proto') { r.proto = words[++i]; i++; continue; }
      if (w === 'in' || w === 'on') { i++; continue; }
      const m = w.match(/^(\d+)(?:\/(tcp|udp))?$/);
      if (m) { r.port = Number(m[1]); r.proto = m[2]; i++; continue; }
      const nm = named[[w, words[i + 1]].join(' ')] !== undefined ? [w, words[++i]].join(' ') : w;
      if (named[nm] !== undefined) { const v = named[nm]; if (Array.isArray(v)) { r.port = v[0]; r.ports = v; } else r.port = v; r.proto = 'tcp'; i++; continue; }
      return null;
    }
    return r;
  };
  switch (sub) {
    case 'status': {
      if (!fw.enabled) { c.print('Status: inactive'); return 0; }
      c.print('Status: active');
      if (rest[0] === 'verbose') c.print('Logging: on (low)', `Default: ${fw.defaultIn} (incoming), allow (outgoing), disabled (routed)`, 'New profiles: skip');
      c.print('', `${'To'.padEnd(27)}${'Action'.padEnd(11)} From`, `${'--'.padEnd(27)}${'------'.padEnd(11)} ----`);
      fw.rules.forEach((r, k) => c.print((rest[0] === 'numbered' ? `[${String(k + 1).padStart(2)}] ` : '') + fmtRule(r)));
      return 0;
    }
    case 'enable': {
      const sshOk = fw.rules.some(r => r.action === 'allow' && (r.port === 22 || r.ports?.includes(22)) && (!r.from || r.from === 'any'));
      fw.enabled = true;
      c.print('Command may disrupt existing ssh connections. Proceed with operation (y|n)? y', 'Firewall is active and enabled on system startup');
      c.uni.emit({ type: 'ufw', host: h.name, action: 'enable', sshAllowed: sshOk });
      const viaSsh = [c.sh.e, ...c.sh.stack].some(x => x.host === h && x.loginKind === 'ssh');
      if (!sshOk && viaSsh && h.firewall.defaultIn === 'deny') {
        c.uni.emit({ type: 'ufw-lockout', host: h.name });
        // the SSH connection drops: unwind back to the machine you connected from
        while (c.sh.stack.length && [c.sh.e, ...c.sh.stack.slice(1)].some(x => x.host === h)) c.sh.e = c.sh.stack.pop();
        c.print('', C.red(`client_loop: send disconnect: Broken pipe`), C.yellow(`You enabled the firewall without allowing SSH (port 22), so ${h.name} just dropped your connection.`), C.dim(`Recover through the cloud provider's web console: console ${h.name}`));
      }
      return 0;
    }
    case 'disable': fw.enabled = false; c.print('Firewall stopped and disabled on system startup'); c.uni.emit({ type: 'ufw', host: h.name, action: 'disable' }); return 0;
    case 'reset': fw.enabled = false; fw.rules = []; c.print('Resetting all rules to installed defaults. Proceed with operation (y|n)? y'); return 0;
    case 'default': { const [pol, dir] = rest; if (dir === 'incoming') fw.defaultIn = pol === 'allow' ? 'allow' : 'deny'; c.print(`Default ${dir} policy changed to '${pol}'`, '(be sure to update your rules accordingly)'); return 0; }
    case 'allow': case 'deny': case 'reject': case 'limit': {
      const r = parseRule(sub === 'reject' ? 'deny' : sub === 'limit' ? 'allow' : sub, rest);
      if (!r || r.port === undefined && !r.from) return c.fail('ERROR: Wrong number of arguments', 1);
      fw.rules.push(r);
      c.print(fw.enabled ? 'Rule added' : 'Rules updated');
      c.uni.emit({ type: 'ufw', host: h.name, action: sub, rule: r });
      return 0;
    }
    case 'delete': {
      if (/^\d+$/.test(rest[0])) { const k = Number(rest[0]) - 1; if (!fw.rules[k]) return c.fail('ERROR: Could not find rule', 1); fw.rules.splice(k, 1); c.print('Rule deleted'); return 0; }
      const r = parseRule(rest[0], rest.slice(1));
      const k = fw.rules.findIndex(x => x.action === r?.action && x.port === r?.port && (x.from || 'any') === (r?.from || 'any'));
      if (k < 0) return c.fail('Could not delete non-existent rule', 1);
      fw.rules.splice(k, 1); c.print('Rule deleted');
      return 0;
    }
    case 'app': { c.print('Available applications:', '  Nginx Full', '  Nginx HTTP', '  Nginx HTTPS', '  OpenSSH'); return 0; }
  }
  return c.fail(`ERROR: Invalid syntax\n\nUsage: ufw COMMAND`, 1);
}, { always: true });

def(['iptables', 'nft'], c => {
  if (c.user !== 'root') return c.fail('iptables v1.8.10 (nf_tables): Permission denied (you must be root)', 4);
  const fw = c.host.firewall;
  c.print(`Chain INPUT (policy ${fw.enabled && fw.defaultIn === 'deny' ? 'DROP' : 'ACCEPT'})`, 'target     prot opt source               destination');
  if (fw.enabled) for (const r of fw.rules) c.print(`${(r.action === 'allow' ? 'ACCEPT' : 'DROP').padEnd(10)} tcp  --  ${(r.from || '0.0.0.0/0').padEnd(20)} 0.0.0.0/0            tcp dpt:${r.port}`);
  return 0;
});

// ---------- openssl & certbot ----------
def('openssl', c => {
  const [sub, ...rest] = c.args;
  const o = opts(rest, { bool: ['-noout', '-dates', '-subject', '-issuer', '-text', '-enddate', '-servername'], val: ['-connect', '-in', '-servername', '-checkend'] });
  if (sub === 'version') { c.print('OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)'); return 0; }
  if (sub === 'rand') { c.print(Array.from({ length: Number(rest[rest.length - 1]) || 16 }, (_, k) => ((k * 7919 + c.uni.time) % 256).toString(16).padStart(2, '0')).join('')); return 0; }
  let cert = null;
  if (sub === 's_client') {
    const [hostName, port = '443'] = (o['-connect'] || '').split(':');
    const r = connect(c.uni, c.host, hostName, Number(port));
    if (r.error) return c.fail(`${r.error === 'ENOTFOUND' ? `BIO_lookup_ex:system lib:../crypto/bio/bio_addr.c:742:Name or service not known\nconnect:errno=22` : `connect:errno=111`}`, 1);
    cert = r.listener.program?.certFor?.(Number(port), o['-servername'] || hostName);
    if (!cert) return c.fail(`${'C0B76FB9EE7F0000'}:error:0A00010B:SSL routines:ssl3_get_record:wrong version number:../ssl/record/ssl3_record.c:354:`, 1);
    const prob = certProblem(cert, o['-servername'] || hostName, c.uni.time);
    c.print('CONNECTED(00000003)', `depth=0 CN = ${cert.cn}`, prob ? `verify error:num=${prob.includes('expired') ? 10 : 18}:${prob}` : 'verify return:1', '---', 'Certificate chain', ` 0 s:CN = ${cert.cn}`, `   i:${cert.selfSigned ? 'CN = ' + cert.cn : 'C = US, O = Let\'s Encrypt, CN = ' + cert.issuer.replace("Let's Encrypt ", '')}`, `   v:NotBefore: ${fmtDate(cert.notBefore, '%b %d %T %Y GMT')}; NotAfter: ${fmtDate(cert.notAfter, '%b %d %T %Y GMT')}`, '---', `Verify return code: ${prob ? (prob.includes('expired') ? '10 (certificate has expired)' : '18 (self-signed certificate)') : '0 (ok)'}`);
    return 0;
  }
  if (sub === 'x509') {
    const text = o['-in'] ? fsx(c).read(o['-in']) : c.stdin;
    cert = readCertPem(text);
    if (!cert) return c.fail('Could not read certificate from ' + (o['-in'] || '<stdin>') + '\nUnable to load certificate', 1);
    if (o['-checkend'] !== undefined) { const ok = cert.notAfter > c.uni.time + Number(o['-checkend']); c.print(ok ? 'Certificate will not expire' : 'Certificate will expire'); return ok ? 0 : 1; }
    if (o['-subject']) c.print(`subject=CN = ${cert.cn}`);
    if (o['-issuer']) c.print(`issuer=${cert.selfSigned ? 'CN = ' + cert.cn : "C = US, O = Let's Encrypt, CN = " + cert.issuer.replace("Let's Encrypt ", '')}`);
    if (o['-dates']) c.print(`notBefore=${fmtDate(cert.notBefore, '%b %d %T %Y GMT')}`, `notAfter=${fmtDate(cert.notAfter, '%b %d %T %Y GMT')}`);
    if (o['-enddate']) c.print(`notAfter=${fmtDate(cert.notAfter, '%b %d %T %Y GMT')}`);
    if (o['-text']) c.print('Certificate:', '    Data:', `        Issuer: ${cert.issuer}`, `        Validity`, `            Not Before: ${fmtDate(cert.notBefore, '%b %d %T %Y GMT')}`, `            Not After : ${fmtDate(cert.notAfter, '%b %d %T %Y GMT')}`, `        Subject: CN = ${cert.cn}`, `            X509v3 Subject Alternative Name:`, `                ${(cert.sans || [cert.cn]).map(s => 'DNS:' + s).join(', ')}`);
    return 0;
  }
  if (sub === 'req' && rest.includes('-x509')) {
    const out = rest[rest.indexOf('-out') + 1], keyout = rest[rest.indexOf('-keyout') + 1];
    const subj = rest[rest.indexOf('-subj') + 1] || '/CN=localhost';
    const days = Number(rest[rest.indexOf('-days') + 1]) || 30;
    const cn = (subj.match(/CN=([^/]+)/) || [])[1] || 'localhost';
    if (out) fsx(c).write(out, makeCertPem({ cn, sans: [cn], issuer: cn, selfSigned: true, notBefore: c.uni.time, notAfter: c.uni.time + days * 86400 }));
    if (keyout) { fsx(c).write(keyout, '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n'); c.host.setMeta(c.resolve(keyout), { mode: 0o600 }); }
    c.eprint('.....+.........+...+..+.+......+++++++++', '-----');
    return 0;
  }
  return c.fail(`Invalid command '${sub}'; type "help" for a list.`, 1);
});

def('certbot', c => {
  const o = opts(c.args, { bool: ['--nginx', '--non-interactive', '--agree-tos', '--redirect', '--dry-run', '-n', '--standalone', 'renew', 'certificates'], val: ['-d', '--domain', '-m', '--email'] });
  if (c.user !== 'root') return c.fail('The following error was encountered:\n[Errno 13] Permission denied: \'/var/log/letsencrypt/.certbot.lock\'\nEither run as root, or set --config-dir, --work-dir, and --logs-dir to writeable paths.', 1);
  const h = c.host, uni = c.uni;
  if (o._[0] === 'certificates') {
    const certs = h.certbotCerts || {};
    if (!Object.keys(certs).length) { c.print('No certificates found.'); return 0; }
    for (const [d, cert] of Object.entries(certs)) c.print('Found the following certs:', `  Certificate Name: ${d}`, `    Domains: ${cert.sans.join(' ')}`, `    Expiry Date: ${fmtDate(cert.notAfter, '%F %T')}+00:00 (VALID: ${Math.round((cert.notAfter - uni.time) / 86400)} days)`, `    Certificate Path: /etc/letsencrypt/live/${d}/fullchain.pem`);
    return 0;
  }
  if (o._[0] === 'renew') {
    const certs = h.certbotCerts || {};
    for (const [d, cert] of Object.entries(certs)) { if (cert.notAfter - uni.time < 30 * 86400 || o['--dry-run']) { cert.notAfter = uni.time + 90 * 86400; h.writeSys(`/etc/letsencrypt/live/${d}/fullchain.pem`, makeCertPem(cert)); c.print(`Renewing an existing certificate for ${d}`); } else c.print(`Certificate not yet due for renewal`); }
    c.print('', 'Congratulations, all renewals succeeded.');
    return 0;
  }
  const domains = [];
  for (let i = 0; i < c.args.length; i++) if (c.args[i] === '-d' || c.args[i] === '--domain') domains.push(...c.args[i + 1].split(','));
  if (!domains.length) return c.fail('certbot: error: no domains specified (use -d example.com)', 1);
  c.print('Saving debug log to /var/log/letsencrypt/letsencrypt.log', `Requesting a certificate for ${domains.join(' and ')}`);
  // HTTP-01 challenge: Let's Encrypt must reach this host on port 80 at each domain
  for (const d of domains) {
    const ip = uni.dns.get(d);
    if (!ip) { c.print('', 'Certbot failed to authenticate some domains (authenticator: nginx). The Certificate Authority reported these problems:', `  Domain: ${d}`, '  Type:   dns', `  Detail: DNS problem: NXDOMAIN looking up A for ${d} - check that a DNS record exists for this domain`, '', 'Hint: The Certificate Authority failed to verify the temporary nginx configuration changes made by Certbot. Ensure the listed domains point to this nginx server and that it is accessible from the internet.'); return 1; }
    if (ip !== h.ip) { c.print('', 'Certbot failed to authenticate some domains (authenticator: nginx). The Certificate Authority reported these problems:', `  Domain: ${d}`, '  Type:   unauthorized', `  Detail: ${ip}: Invalid response from http://${d}/.well-known/acme-challenge/x: 404`, '', 'Hint: The domain\'s DNS A record points somewhere else. Point it at this server first.'); return 1; }
    const internet = uni.internetHost || uni.addHost('acme-validator', { ip: '198.51.100.7', withWww: false });
    uni.internetHost = internet;
    const r = connect(uni, internet, d, 80);
    if (r.error) { c.print('', 'Certbot failed to authenticate some domains (authenticator: nginx). The Certificate Authority reported these problems:', `  Domain: ${d}`, '  Type:   connection', `  Detail: ${ip}: Fetching http://${d}/.well-known/acme-challenge/x: ${r.error === 'ETIMEDOUT' ? 'Timeout during connect (likely firewall problem)' : 'Connection refused'}`, '', 'Hint: The Certificate Authority failed to verify the temporary nginx configuration changes made by Certbot. Ensure the listed domains point to this nginx server and that it is accessible from the internet.'); return 1; }
  }
  if (o['--dry-run']) { c.print('The dry run was successful.'); return 0; }
  const name = domains[0];
  const cert = { cn: name, sans: domains, issuer: "Let's Encrypt R11", notBefore: uni.time, notAfter: uni.time + 90 * 86400 };
  h.certbotCerts = h.certbotCerts || {};
  h.certbotCerts[name] = cert;
  h.writeSys(`/etc/letsencrypt/live/${name}/fullchain.pem`, makeCertPem(cert));
  h.writeSys(`/etc/letsencrypt/live/${name}/privkey.pem`, '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
  c.print('', 'Successfully received certificate.', `Certificate is saved at: /etc/letsencrypt/live/${name}/fullchain.pem`, `Key is saved at:         /etc/letsencrypt/live/${name}/privkey.pem`, `This certificate expires on ${fmtDate(cert.notAfter, '%F')}.`, 'Certbot has set up a scheduled task to automatically renew this certificate in the background.');
  if (o['--nginx']) {
    // add an ssl server and a redirect to the site whose server_name matches
    let conf;
    try { conf = loadConfig(h); } catch (e) { c.eprint(e.message); return 1; }
    const srv = conf.servers.find(s => s.names.some(n => domains.includes(n)));
    if (!srv) { c.print('', `Could not install certificate`, `Could not automatically find a matching server block for ${name}. Set the \`server_name\` directive to use the Nginx installer.`); return 1; }
    let text = h.files.get(srv.file);
    const lines = text.split('\n');
    // insert listen 443 ssl + certs before the closing brace of that server block
    let depth = 0, start = -1, end = -1;
    for (let k = srv.line - 1; k < lines.length; k++) { depth += (lines[k].match(/\{/g) || []).length; depth -= (lines[k].match(/\}/g) || []).length; if (start < 0) start = k; if (depth === 0 && k >= start && /\}/.test(lines[k])) { end = k; break; } }
    const block = lines.slice(start, end + 1).join('\n');
    if (/ssl_certificate\s/.test(block)) {
      for (let k = start; k <= end; k++) {
        if (/^\s*ssl_certificate\s/.test(lines[k])) lines[k] = `    ssl_certificate /etc/letsencrypt/live/${name}/fullchain.pem; # managed by Certbot`;
        if (/^\s*ssl_certificate_key\s/.test(lines[k])) lines[k] = `    ssl_certificate_key /etc/letsencrypt/live/${name}/privkey.pem; # managed by Certbot`;
      }
    } else {
      lines.splice(end, 0, `    listen 443 ssl; # managed by Certbot`, `    ssl_certificate /etc/letsencrypt/live/${name}/fullchain.pem; # managed by Certbot`, `    ssl_certificate_key /etc/letsencrypt/live/${name}/privkey.pem; # managed by Certbot`);
    }
    text = lines.join('\n');
    const hasRedirect = /return 301 https:\/\/\$host\$request_uri/.test(text);
    if (!hasRedirect) {
      const otherPort80 = conf.servers.some(s2 => s2 !== srv && s2.listens.some(l => l.port === 80) && s2.names.some(n => domains.includes(n)));
      if (!otherPort80) {
        text = text.replace(/listen 80( default_server)?;/, '# listen 80$1; moved to the redirect block below by Certbot');
        text += `\nserver {\n    listen 80;\n    server_name ${domains.join(' ')};\n    return 301 https://$host$request_uri; # managed by Certbot\n}\n`;
      }
    }
    h.writeSys(srv.file, text);
    const master = [...h.procs.values()].find(p => p.program instanceof Nginx);
    try { master?.program.reload(); } catch (e) { c.eprint(e.message); return 1; }
    c.print('', 'Deploying certificate', `Successfully deployed certificate for ${name} to ${srv.file}`, `Congratulations! You have successfully enabled HTTPS on https://${domains.join(' and https://')}`);
  }
  uni.emit({ type: 'certbot', host: h.name, domains });
  return 0;
});

export { ipMatches };
