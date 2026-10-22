// Reliability tools: `ab` load tests (through the real request path), an `incident` CLI
// (declare, roles, updates, timeline, status page) and `pg_dump` for backups.

import { def } from './registry.js';
import { C } from '../git/world.js';
import { httpRequest, connect } from './net.js';
import { fakeHash } from './hcl.js';

// ---------------------------------------------------------------- ab
def('ab', c => {
  const a = c.args;
  const n = Math.min(2000, Number(a[a.indexOf('-n') + 1] || 1)) || 1;
  const conc = Number(a.includes('-c') ? a[a.indexOf('-c') + 1] : 1) || 1;
  const url = a.filter(x => !x.startsWith('-')).find(x => /^https?:\/\//.test(x));
  if (!url) return c.fail('ab: wrong number of arguments\nUsage: ab [options] [http[s]://]hostname[:port]/path', 22);
  if (!/^https?:\/\/[^/]+\//.test(url)) return c.fail(`ab: invalid URL\nUsage: ab [options] [http[s]://]hostname[:port]/path`, 1);
  const codes = {};
  let failed = 0, bytes = 0, totalMs = 0;
  const lat = [];
  const prof = r => { const obs = c.uni.obs; const u = new URL(url); for (const p of obs?.profiles || []) { const rt = p.routes[u.pathname]; if (rt) return rt; } return null; };
  const base = prof();
  for (let i = 0; i < n; i++) {
    const r = httpRequest(c.uni, c.host, url, { headers: { 'user-agent': 'ApacheBench/2.3' } });
    if (r.error) { failed++; codes.fail = (codes.fail || 0) + 1; lat.push(1); continue; }
    codes[r.status] = (codes[r.status] || 0) + 1;
    bytes += String(r.body || '').length;
    const p50 = (base?.p50 || 0.004) * 1000, p99 = (base?.p99 || 0.02) * 1000;
    const ms = Math.max(1, p50 * (0.6 + ((i * 7919) % 100) / 120) + (i % 100 === 99 ? p99 - p50 : 0)) * (1 + Math.max(0, conc - 20) / 40);
    lat.push(ms); totalMs += ms;
  }
  const secs = Math.max(0.01, totalMs / 1000 / conc);
  const sorted = [...lat].sort((x, y) => x - y);
  const pct = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  const non2xx = Object.entries(codes).filter(([k]) => k !== 'fail' && !/^2/.test(k)).reduce((s, [, v]) => s + v, 0);
  const u = new URL(url);
  c.print('This is ApacheBench, Version 2.3 <$Revision: 1913912 $>', `Benchmarking ${u.hostname} (be patient).....done`, '', '', `Server Hostname:        ${u.hostname}`, `Server Port:            ${u.port || 80}`, '', `Document Path:          ${u.pathname}`, '', `Concurrency Level:      ${conc}`, `Time taken for tests:   ${secs.toFixed(3)} seconds`, `Complete requests:      ${n}`, `Failed requests:        ${failed}`, ...(non2xx ? [`Non-2xx responses:      ${non2xx}`] : []), `Total transferred:      ${bytes + n * 180} bytes`, `Requests per second:    ${(n / secs).toFixed(2)} [#/sec] (mean)`, `Time per request:       ${(totalMs / n).toFixed(3)} [ms] (mean)`, '', 'Percentage of the requests served within a certain time (ms)', `  50%  ${pct(0.5)}`, `  90%  ${pct(0.9)}`, `  99%  ${pct(0.99)}`, ` 100%  ${pct(1)} (longest request)`);
  if (failed === n) c.eprint(`apr_socket_recv: Connection refused (111)`);
  c.uni.emit({ type: 'loadtest', host: c.host.name, url, n, failed, non2xx, codes });
  c.uni.advance(Math.min(30, Math.ceil(secs)));
  return failed === n ? 1 : 0;
}, { pkg: 'apache2-utils' });

// ---------------------------------------------------------------- incidents
export function incidentStore(uni) { return store(uni); }
function store(uni) {
  if (!uni.incidents) {
    uni.incidents = { list: [], seq: 41 };
    uni.httpHooks.push(({ url }) => {
      if (url.host !== 'status.lumen.dev') return null;
      const open = uni.incidents.list.filter(i => i.public.length && i.status !== 'resolved');
      const recent = uni.incidents.list.filter(i => i.public.length).slice(-3).reverse();
      const body = `<h1>Lumen status</h1>\n<p>${open.length ? '⚠️ Some systems are affected' : '✅ All systems operational'}</p>\n${recent.map(i => `<h2>${i.title} (${i.status})</h2>\n${i.public.slice().reverse().map(p => `<p><b>${new Date(p.t * 1000).toISOString().slice(11, 16)} UTC</b> ${p.text}</p>`).join('\n')}`).join('\n')}\n`;
      return { status: 200, headers: { 'content-type': 'text/html' }, body };
    });
  }
  return uni.incidents;
}
const SEV = { 1: 'critical: customers broadly affected', 2: 'major: significant degradation', 3: 'minor: limited impact', 4: 'low: no customer impact' };
def('incident', c => {
  const uni = c.uni;
  const S = store(uni);
  const [sub, ...rest] = c.args;
  const flag = (n, d) => { const i = rest.findIndex(x => x === `--${n}` || x.startsWith(`--${n}=`)); if (i < 0) return d; return rest[i].includes('=') ? rest[i].split('=').slice(1).join('=') : rest[i + 1]; };
  const VALUED = ['--title', '--sev', '--severity'];
  const words = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && VALUED.includes(rest[i - 1]))).join(' ');
  const cur = () => S.list.filter(i => i.status !== 'resolved').pop() || null;
  const at = () => new Date(uni.time * 1000).toISOString().slice(11, 19);
  const log = (inc, kind, text) => { inc.timeline.push({ t: uni.time, kind, text, by: c.user }); uni.emit({ type: 'incident', id: inc.id, kind, text, status: inc.status, sev: inc.sev }); };
  switch (sub) {
    case 'declare': {
      const title = flag('title') || words;
      const sev = Number(flag('sev', flag('severity', 0)));
      if (!title) return c.fail('incident: a title is required: incident declare --sev 2 --title "Checkout failing"', 1);
      if (!SEV[sev]) return c.fail('incident: --sev must be 1 (critical) to 4 (low)', 1);
      const inc = { id: `INC-${S.seq++}`, title, sev, status: 'investigating', roles: {}, timeline: [], public: [], declared: uni.time };
      S.list.push(inc);
      log(inc, 'declared', `Declared SEV${sev}: ${title}`);
      c.print(C.red(`🚨 ${inc.id} declared: SEV${sev} (${SEV[sev]})`), `   ${title}`, `   Channel #${inc.id.toLowerCase()} created. Next: assign a commander, post an update.`);
      return 0;
    }
    case 'role': {
      const inc = cur(); if (!inc) return c.fail('incident: no open incident (incident declare …)', 1);
      const [role, who] = rest;
      if (!['commander', 'comms', 'ops', 'scribe'].includes(role)) return c.fail('incident: roles are commander, comms, ops, scribe', 1);
      inc.roles[role] = who || c.user;
      log(inc, 'role', `${who || c.user} is ${role}`);
      c.print(`${inc.id}: ${who || c.user} is now ${role}`);
      return 0;
    }
    case 'note': { const inc = cur(); if (!inc) return c.fail('incident: no open incident', 1); if (!words) return c.fail('incident note "what you saw or did"', 1); log(inc, 'note', words); c.print(`${inc.id} ${at()} noted`); return 0; }
    case 'update': {
      const inc = cur(); if (!inc) return c.fail('incident: no open incident', 1);
      if (!words) return c.fail('incident update [--public] "message for stakeholders"', 1);
      const pub = rest.includes('--public');
      if (pub) inc.public.push({ t: uni.time, text: words });
      log(inc, pub ? 'public-update' : 'update', words);
      c.print(`${inc.id} update posted${pub ? ' to status.lumen.dev' : ' to #incidents'}`);
      return 0;
    }
    case 'status': {
      const inc = cur(); if (!inc) return c.fail('incident: no open incident', 1);
      const st = rest[0];
      if (!['investigating', 'identified', 'mitigated', 'monitoring', 'resolved'].includes(st)) return c.fail('incident status investigating|identified|mitigated|monitoring|resolved', 1);
      if (st === 'resolved' && !inc.roles.commander) return c.fail('incident: assign a commander before resolving (incident role commander <name>)', 1);
      inc.status = st;
      if (st === 'resolved') inc.resolved = uni.time;
      log(inc, 'status', `Status → ${st}`);
      c.print(`${inc.id} is now ${st}${st === 'resolved' ? `. Duration ${Math.round((uni.time - inc.declared) / 60)} min. Schedule the postmortem.` : ''}`);
      return 0;
    }
    case 'timeline': case 'show': {
      const id = rest.find(x => /^INC-/.test(x));
      const inc = id ? S.list.find(i => i.id === id) : (cur() || S.list[S.list.length - 1]);
      if (!inc) return c.fail('incident: no incidents yet', 1);
      c.print(`${C.bold(inc.id)} SEV${inc.sev} ${inc.title}  [${inc.status}]`, `roles: ${Object.entries(inc.roles).map(([r, w]) => `${r}=${w}`).join(' ') || '(none)'}`, '');
      for (const e of inc.timeline) c.print(`${new Date(e.t * 1000).toISOString().slice(11, 16)}  ${e.kind.padEnd(13)} ${e.text}`);
      uni.emit({ type: 'incident-view', id: inc.id });
      return 0;
    }
    case 'list': { for (const i of S.list) c.print(`${i.id}  SEV${i.sev}  ${i.status.padEnd(13)} ${i.title}`); if (!S.list.length) c.print('(no incidents)'); return 0; }
  }
  return c.fail('usage: incident declare --sev N --title "…" | role <commander|comms|ops|scribe> [name] | update [--public] "…" | note "…" | status <state> | timeline | list', 1);
}, { always: true });

// ---------------------------------------------------------------- pg_dump
def('pg_dump', c => {
  const a = c.args;
  const out = a.includes('-f') ? a[a.indexOf('-f') + 1] : (a.find(x => x.startsWith('--file=')) || '').split('=')[1];
  const r = connect(c.uni, c.host, a.includes('-h') ? a[a.indexOf('-h') + 1] : '127.0.0.1', 5432);
  if (r.error) return c.fail('pg_dump: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory\n\tIs the server running locally and accepting connections on that socket?', 1);
  const server = r.listener.program?.host || c.host;
  const file = (server.container ? '/var/lib/postgresql/data' : '/var/lib/postgresql/16/main') + '/lumen_tables.json';
  let db; try { db = JSON.parse(server.files.get(file) || '{"tables":{}}'); } catch { db = { tables: {} }; }
  const L = ['--', '-- PostgreSQL database dump', '--', '', `-- Dumped from database version 16.4`, `-- Dumped at ${new Date(c.uni.time * 1000).toISOString()}`, ''];
  for (const [name, t] of Object.entries(db.tables)) {
    L.push(`CREATE TABLE ${name} (${t.cols.map(x => `${x} text`).join(', ')});`);
    if (t.rows.length) L.push(`INSERT INTO ${name} VALUES ${t.rows.map(row => `(${row.map(v => /^\d+$/.test(v) ? v : `'${String(v).replace(/'/g, "''")}'`).join(', ')})`).join(', ')};`);
    L.push('');
  }
  L.push('--', '-- PostgreSQL database dump complete', '--', '');
  const text = L.join('\n');
  if (out) c.host.writeFile(c.resolve(out), text, c.user); else c.out(text);
  c.uni.emit({ type: 'pg_dump', host: c.host.name, file: out ? c.resolve(out) : null, tables: Object.keys(db.tables), rows: Object.values(db.tables).reduce((s, t) => s + t.rows.length, 0) });
  return 0;
}, { pkg: 'postgresql-client' });
