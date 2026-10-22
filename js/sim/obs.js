// Observability for the simulated world: instrumented apps with request metrics driven by
// traffic profiles, node_exporter, Prometheus (scraping, rules, alerts, HTTP API),
// Alertmanager (routing, grouping, silences, webhooks into a team chat), a Loki-like log
// store with LogQL (logcli), and a trace store (the `traces` CLI).

import { def } from './registry.js';
import { C } from '../git/world.js';
import { parseYaml } from '../git/yaml.js';
import { programFactories } from './runtime.js';
import { httpRequest, parseUrl } from './net.js';
import { CATALOG } from './packages.js';
import { TSDB, evalPromQL, parsePromQL, parseDuration, formatValue, seriesName, PromQLError } from './promql.js';
import { fakeHash } from './hcl.js';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const erf = x => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const lognCdf = (x, p50, p99) => { if (x <= 0) return 0; const mu = Math.log(p50), sigma = Math.max(0.05, (Math.log(p99) - Math.log(p50)) / 2.326); return 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2))); };
const lognMean = (p50, p99) => { const sigma = Math.max(0.05, (Math.log(p99) - Math.log(p50)) / 2.326); return p50 * Math.exp(sigma * sigma / 2); };

// ---------------------------------------------------------------- app stats
class AppStats {
  constructor() { this.req = new Map(); this.hist = new Map(); this.started = 0; }
  add(method, route, status, n, latency) {
    const k = `${method}|${route}|${status}`;
    this.req.set(k, (this.req.get(k) || 0) + n);
    const hk = `${method}|${route}`;
    let h = this.hist.get(hk);
    if (!h) { h = { buckets: BUCKETS.map(() => 0), inf: 0, sum: 0 }; this.hist.set(hk, h); }
    if (typeof latency === 'number') { BUCKETS.forEach((b, i) => { if (latency <= b) h.buckets[i] += n; }); h.inf += n; h.sum += latency * n; }
    else { BUCKETS.forEach((b, i) => { h.buckets[i] += n * lognCdf(b, latency.p50, latency.p99); }); h.inf += n; h.sum += n * lognMean(latency.p50, latency.p99); }
  }
  exposition(extra = []) {
    const L = ['# HELP http_requests_total Total HTTP requests.', '# TYPE http_requests_total counter'];
    for (const [k, v] of this.req) { const [m, r, s] = k.split('|'); L.push(`http_requests_total{method="${m}",route="${r}",status="${s}"} ${Math.round(v)}`); }
    L.push('# HELP http_request_duration_seconds Request duration in seconds.', '# TYPE http_request_duration_seconds histogram');
    for (const [k, h] of this.hist) { const [m, r] = k.split('|'); BUCKETS.forEach((b, i) => L.push(`http_request_duration_seconds_bucket{method="${m}",route="${r}",le="${b}"} ${Math.round(h.buckets[i])}`)); L.push(`http_request_duration_seconds_bucket{method="${m}",route="${r}",le="+Inf"} ${Math.round(h.inf)}`, `http_request_duration_seconds_sum{method="${m}",route="${r}"} ${h.sum.toFixed(3)}`, `http_request_duration_seconds_count{method="${m}",route="${r}"} ${Math.round(h.inf)}`); }
    L.push(...extra);
    return L.join('\n') + '\n';
  }
}

export function parseExposition(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{([^}]*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels = {};
    if (m[3]) for (const p of m[3].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[p[1]] = p[2];
    out.push({ name: m[1], labels, v: m[4] === '+Inf' ? Infinity : Number(m[4]) });
  }
  return out;
}

// ---------------------------------------------------------------- the observability world
export class Obs {
  constructor(uni) {
    this.uni = uni;
    this.profiles = [];        // traffic profiles
    this.stats = new Map();    // app key -> AppStats
    this.logs = [];            // { t, labels, line }
    this.traces = [];          // { id, ... }
    this.chat = [];            // notifications delivered to the team chat
    this.proms = [];           // running Prometheus programs
    this.ams = [];             // running Alertmanagers
    this.seq = 1;
    uni.obs = this;
    uni.tickers.push(dt => this.tick(dt));
    uni.httpHooks.push(({ url, method, body }) => {
      if (url.host !== 'chat.lumen.dev') return null;
      let payload = {}; try { payload = JSON.parse(body || '{}'); } catch { /* text */ }
      this.chat.push({ t: uni.time, channel: url.path.split('/').pop(), payload });
      uni.emit({ type: 'chat-message', channel: url.path.split('/').pop(), status: payload.status, alerts: (payload.alerts || []).map(a => a.labels?.alertname) });
      return { status: 200, body: 'ok' };
    });
  }
  appKey(host, port) { return `${host.name}:${port}`; }
  statsFor(host, port) { const k = this.appKey(host, port); if (!this.stats.has(k)) this.stats.set(k, new AppStats()); return this.stats.get(k); }
  // traffic: { host, port, service, routes: { '/x': { rps, p50, p99, err, method, slowSpan } } }
  addProfile(p) { this.profiles.push(p); return p; }
  profileFor(host, port) { return this.profiles.find(p => p.host === host.name && p.port === port); }
  log(labels, obj) { this.logs.push({ t: this.uni.time, labels, line: typeof obj === 'string' ? obj : JSON.stringify(obj) }); if (this.logs.length > 20000) this.logs.splice(0, 5000); }

  tick(dt) {
    const uni = this.uni;
    for (const p of this.profiles) {
      const host = uni.host(p.host);
      const l = host?.listening.get(p.port);
      if (!host || host.down || !l || !host.procs.has(l.pid)) continue;
      const st = this.statsFor(host, p.port);
      for (const [route, r] of Object.entries(p.routes)) {
        const n = r.rps * dt;
        if (n <= 0) continue;
        const errs = n * (r.err || 0);
        const lat = { p50: r.p50 || 0.03, p99: r.p99 || 0.12 };
        st.add(r.method || 'GET', route, '200', n - errs, lat);
        if (errs) st.add(r.method || 'GET', route, String(r.errStatus || 500), errs, { p50: lat.p50 * 1.5, p99: lat.p99 * 2 });
        // logs: every error, slow requests, and a sample of the rest
        const sample = Math.min(10, Math.max(1, Math.round(n / 20)));
        for (let k = 0; k < sample + Math.min(6, Math.round(errs)); k++) {
          const isErr = k >= sample;
          const slow = !isErr && r.slowFrac && (this.seq % Math.max(2, Math.round(1 / r.slowFrac))) === 0;
          const dur = Math.round(1000 * (isErr ? lat.p99 * 1.3 : slow ? lat.p99 : lat.p50 * (0.7 + (this.seq % 7) / 10)));
          const traceId = fakeHash(`${p.host}${route}${this.seq++}${uni.time}`, 32);
          const level = isErr ? 'error' : dur > 1000 ? 'warn' : 'info';
          this.log({ app: p.service, host: p.host, level }, { ts: new Date(uni.time * 1000).toISOString(), level, msg: isErr ? (r.errMsg || 'request failed') : 'request completed', method: r.method || 'GET', route, status: isErr ? (r.errStatus || 500) : 200, duration_ms: dur, trace_id: traceId });
          if (isErr || slow || k === 0) this.makeTrace(p, route, r, traceId, dur / 1000, isErr);
        }
      }
    }
    for (const prom of this.proms) prom.tick();
    for (const am of this.ams) am.tick();
  }

  makeTrace(p, route, r, id, total, isErr) {
    const spans = [];
    let sid = 0;
    const add = (parent, service, name, start, dur, status = 'ok', attrs = {}) => { const s = { id: fakeHash(id + sid++, 16), parent, service, name, start, dur, status, attrs }; spans.push(s); return s; };
    const root = add(null, p.service, `${r.method || 'GET'} ${route}`, 0, total, isErr ? 'error' : 'ok', { 'http.status_code': isErr ? (r.errStatus || 500) : 200 });
    let t0 = 0.002;
    const plan = r.spans || [['auth', 'verify session', 0.04], ['db', 'SELECT', 0.15]];
    const shares = plan.reduce((s, x) => s + x[2], 0);
    for (const [service, name, share, opts = {}] of plan) {
      const isSlow = r.slowSpan && service === r.slowSpan;
      const d = isSlow ? Math.max(0.001, total - 0.02 - (shares - share) * total * 0.5) : total * share * 0.5;
      const s = add(root.id, service, name, t0, d, isErr && opts.fails ? 'error' : 'ok', opts.attrs || {});
      if (opts.children) { let ct = t0 + 0.001; for (const [cs, cn, cshare] of opts.children) { const cd = (r.slowSpan === cs ? d * 0.9 : d * cshare); add(s.id, cs, cn, ct, cd, isErr && cs === opts.failChild ? 'error' : 'ok'); ct += cd; } }
      t0 += d + 0.001;
    }
    this.traces.push({ id, service: p.service, route, method: r.method || 'GET', start: this.uni.time, duration: total, status: isErr ? 'error' : 'ok', spans });
    if (this.traces.length > 3000) this.traces.splice(0, 500);
  }
}

// ---------------------------------------------------------------- exporters
function nodeMetrics(host, uni) {
  const memUsed = Math.min(host.memMB, host.memUsedMB?.() ?? host.memMB * 0.3) * 1048576;
  const memTotal = host.memMB * 1048576;
  const diskTotal = (host.diskGB || 40) * 1073741824, diskUsed = (host.diskUsedGB ?? 6) * 1073741824;
  const L = ['# HELP node_load1 1m load average.', '# TYPE node_load1 gauge', `node_load1 ${host.loadAvg[0]}`, `node_load5 ${host.loadAvg[1]}`, `node_load15 ${host.loadAvg[2]}`, `node_memory_MemTotal_bytes ${memTotal}`, `node_memory_MemAvailable_bytes ${Math.round(memTotal - memUsed)}`, `node_filesystem_size_bytes{device="/dev/root",fstype="ext4",mountpoint="/"} ${diskTotal}`, `node_filesystem_avail_bytes{device="/dev/root",fstype="ext4",mountpoint="/"} ${Math.max(0, Math.round(diskTotal - diskUsed))}`, `node_boot_time_seconds ${uni.time - 86400 * 12}`];
  const up = uni.time;
  for (let cpu = 0; cpu < host.cpus; cpu++) {
    const busy = Math.min(0.98, host.loadAvg[0] / host.cpus);
    L.push(`node_cpu_seconds_total{cpu="${cpu}",mode="idle"} ${(up * (1 - busy)).toFixed(2)}`, `node_cpu_seconds_total{cpu="${cpu}",mode="user"} ${(up * busy * 0.8).toFixed(2)}`, `node_cpu_seconds_total{cpu="${cpu}",mode="system"} ${(up * busy * 0.2).toFixed(2)}`);
  }
  L.push(`node_network_receive_bytes_total{device="eth0"} ${Math.round(up * 2.1e5)}`, `node_network_transmit_bytes_total{device="eth0"} ${Math.round(up * 3.4e5)}`);
  return L.join('\n') + '\n';
}

programFactories.set('prometheus-node-exporter', ({ host, uni }) => ({
  kind: 'node-exporter', memMB: 12,
  start: () => ({ ok: true, ports: [{ port: 9100, addr: '0.0.0.0' }], logs: ['ts=2026-01-01T09:00:00Z caller=node_exporter.go:193 level=info msg="Starting node_exporter" version="(version=1.7.0)"', 'level=info msg="Listening on" address=[::]:9100'] }),
  handle: req => req.path === '/metrics' ? { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4' }, body: nodeMetrics(host, uni) } : { status: 200, body: '<html><head><title>Node Exporter</title></head><body><h1>Node Exporter</h1><p><a href="/metrics">Metrics</a></p></body></html>' },
}));
programFactories.set('node_exporter', programFactories.get('prometheus-node-exporter'));

// ---------------------------------------------------------------- Prometheus
class Prometheus {
  constructor({ host, uni, argv }) {
    this.host = host; this.uni = uni; this.kind = 'prometheus'; this.memMB = 180;
    const cf = (argv.find(a => a.startsWith('--config.file=')) || '--config.file=/etc/prometheus/prometheus.yml').split('=')[1];
    this.configPath = cf;
    this.tsdb = new TSDB();
    this.alerts = new Map();  // key -> { labels, annotations, state, activeAt, value }
    this.lastScrape = new Map();
    this.lastEval = 0;
  }
  load() {
    const text = this.host.files.get(this.configPath);
    if (text === undefined) return { error: `Error loading config (--config.file=${this.configPath}) err="open ${this.configPath}: no such file or directory"` };
    let cfg;
    try { cfg = parseYaml(text) || {}; } catch (e) { return { error: `Error loading config (--config.file=${this.configPath}) err="parsing YAML file ${this.configPath}: ${e.message}"` }; }
    const r = validateConfig(cfg, this.host, this.configPath);
    if (r.error) return { error: `Error loading config (--config.file=${this.configPath}) err="${r.error}"` };
    this.cfg = cfg;
    this.rules = r.rules;
    this.amTargets = (cfg.alerting?.alertmanagers || []).flatMap(a => (a.static_configs || []).flatMap(s => s.targets || []));
    return { ok: true };
  }
  start() {
    const r = this.load();
    if (r.error) return { ok: false, code: 1, logs: [`ts=2026-01-01T09:00:00Z caller=main.go:530 level=error msg="${r.error.replace(/"/g, '\\"')}"`] };
    this.uni.obs = this.uni.obs || new Obs(this.uni);
    if (!this.uni.obs.proms.includes(this)) this.uni.obs.proms.push(this);
    return { ok: true, ports: [{ port: 9090, addr: '0.0.0.0' }], logs: ['level=info msg="Starting Prometheus Server" mode=server version="(version=2.53.2)"', `level=info msg="Loading configuration file" filename=${this.configPath}`, 'level=info msg="Server is ready to receive web requests."'] };
  }
  reload() {
    const prev = { cfg: this.cfg, rules: this.rules, amTargets: this.amTargets };
    const before = new Set(this.targets().map(x => `${x.labels.job}|${x.labels.instance}`));
    const r = this.load();
    this.reloadOk = !r.error;
    if (!r.error) {
      // targets that disappeared get staleness markers, so their series stop matching queries
      const now = new Set(this.targets().map(x => `${x.labels.job}|${x.labels.instance}`));
      for (const k of before) if (!now.has(k)) { const [job, instance] = k.split('|'); for (const sr of this.tsdb.series.values()) if (sr.labels.job === job && sr.labels.instance === instance) sr.samples.push({ t: this.uni.time, v: NaN }); }
    }
    if (r.error) { Object.assign(this, prev); this.host.log('prometheus.service', `level=error msg="Error reloading config" err="${r.error}"`, 'err'); }
    else this.host.log('prometheus.service', `level=info msg="Completed loading of configuration file" filename=${this.configPath}`);
  }
  get running() { const l = this.host.listening.get(9090); return !!(l && l.program === this && this.host.procs.has(l.pid)); }
  scrapeInterval(job) { return parseDuration(job?.scrape_interval || this.cfg?.global?.scrape_interval || '15s') || 15; }
  tick() {
    if (!this.running) { this.uni.obs.proms = this.uni.obs.proms.filter(p => p !== this); return; }
    const t = this.uni.time;
    for (const job of this.cfg.scrape_configs || []) {
      const iv = this.scrapeInterval(job);
      for (const target of (job.static_configs || []).flatMap(s => (s.targets || []).map(tg => ({ tg, labels: s.labels || {} })))) {
        const key = `${job.job_name}|${target.tg}`;
        if (t - (this.lastScrape.get(key) ?? -1e9) < iv) continue;
        this.lastScrape.set(key, t);
        const base = { job: job.job_name, instance: target.tg, ...target.labels };
        const r = httpRequest(this.uni, this.host, `${job.scheme || 'http'}://${target.tg}${job.metrics_path || '/metrics'}`);
        const ok = !r.error && r.status === 200;
        this.tsdb.add('up', base, t, ok ? 1 : 0);
        this.tsdb.add('scrape_duration_seconds', base, t, ok ? 0.004 : 10);
        if (!ok) { this.lastError = this.lastError || {}; this.lastError[key] = r.error ? (r.error === 'ECONNREFUSED' ? `Get "http://${target.tg}${job.metrics_path || '/metrics'}": dial tcp ${target.tg}: connect: connection refused` : r.error === 'ENOTFOUND' ? `Get "http://${target.tg}/metrics": dial tcp: lookup ${target.tg.split(':')[0]}: no such host` : `Get "http://${target.tg}/metrics": context deadline exceeded`) : `server returned HTTP status ${r.status} ${r.status === 404 ? 'Not Found' : ''}`; continue; }
        if (this.lastError) delete this.lastError[key];
        for (const s of parseExposition(r.body)) this.tsdb.add(s.name, { ...base, ...s.labels }, t, s.v);
      }
    }
    const ev = parseDuration(this.cfg.global?.evaluation_interval || '15s') || 15;
    if (t - this.lastEval >= ev) { this.lastEval = t; this.evalRules(t); }
  }
  evalRules(t) {
    for (const g of this.rules || []) for (const rule of g.rules || []) {
      let res;
      try { res = evalPromQL(this.tsdb, rule.expr, t); } catch { continue; }
      if (rule.record) { for (const s of res.samples || []) this.tsdb.add(rule.record, { ...Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== '__name__')), ...(rule.labels || {}) }, t, s.v); continue; }
      const seen = new Set();
      for (const s of res.type === 'vector' ? res.samples : []) {
        const labels = { alertname: rule.alert, ...Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== '__name__')), ...(rule.labels || {}) };
        const key = JSON.stringify(labels);
        seen.add(key);
        let a = this.alerts.get(key);
        if (!a) { a = { labels, state: 'pending', activeAt: t, rule: rule.alert }; this.alerts.set(key, a); }
        a.value = s.v;
        const tmpl = str => String(str || '').replace(/\{\{\s*\$labels\.(\w+)\s*\}\}/g, (_, k) => labels[k] ?? '').replace(/\{\{\s*\$value\s*(\|\s*humanize(Percentage)?)?\s*\}\}/g, (_, f, pct) => pct ? `${(s.v * 100).toFixed(2)}%` : formatValue(Number(s.v.toFixed(4))));
        a.annotations = Object.fromEntries(Object.entries(rule.annotations || {}).map(([k, v]) => [k, tmpl(v)]));
        if (a.state === 'pending' && t - a.activeAt >= parseDuration(rule.for || '0s')) { a.state = 'firing'; a.firedAt = t; this.uni.emit({ type: 'alert-firing', alert: rule.alert, labels }); }
      }
      for (const [k, a] of [...this.alerts]) if (a.rule === rule.alert && !seen.has(k)) { if (a.state === 'firing') { this.uni.emit({ type: 'alert-resolved', alert: a.rule, labels: a.labels }); this.notify([{ ...a, endsAt: t }], true); } this.alerts.delete(k); }
    }
    for (const a of this.alerts.values()) this.tsdb.add('ALERTS', { ...a.labels, alertstate: a.state }, t, 1);
    const firing = [...this.alerts.values()].filter(a => a.state === 'firing');
    if (firing.length) this.notify(firing, false);
  }
  notify(alerts, resolved) {
    for (const tg of this.amTargets || []) {
      const body = JSON.stringify(alerts.map(a => ({ labels: a.labels, annotations: a.annotations, startsAt: new Date(a.activeAt * 1000).toISOString(), ...(resolved ? { endsAt: new Date(this.uni.time * 1000).toISOString() } : {}) })));
      httpRequest(this.uni, this.host, `http://${tg}/api/v2/alerts`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    }
  }
  handle(req) {
    const q = new URLSearchParams((req.query || '').replace(/^\?/, '') + (req.method === 'POST' && req.body && !/^\s*[[{]/.test(req.body) ? '&' + req.body : ''));
    const json = o => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
    const t = q.get('time') ? Number(q.get('time')) : this.uni.time;
    if (req.path === '/-/healthy') return { status: 200, body: 'Prometheus Server is Healthy.\n' };
    if (req.path === '/-/ready') return { status: 200, body: 'Prometheus Server is Ready.\n' };
    if (req.path === '/-/reload') { const before = this.cfg; this.reload(); return this.reloadOk ? { status: 200, body: '' } : (this.cfg = before, { status: 500, body: `failed to reload config: couldn't load configuration (--config.file="${this.configPath}"): see the log\n` }); }
    if (req.path === '/api/v1/query') {
      try { const r = evalPromQL(this.tsdb, q.get('query') || '', t); this.uni.emit({ type: 'promql', host: req.fromHost || this.host.name, expr: q.get('query'), ok: true, results: r.type === 'scalar' ? [{ labels: {}, v: r.v }] : r.samples.map(s => ({ labels: s.labels, v: s.v })) }); return json({ status: 'success', data: r.type === 'scalar' ? { resultType: 'scalar', result: [t, formatValue(r.v)] } : { resultType: 'vector', result: r.samples.map(s => ({ metric: s.labels, value: [t, formatValue(s.v)] })) } }); }
      catch (e) { this.uni.emit({ type: 'promql', host: this.host.name, expr: q.get('query'), ok: false, error: e.message }); return { status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'error', errorType: 'bad_data', error: e.message }) }; }
    }
    if (req.path === '/api/v1/query_range') {
      const start = Number(q.get('start')), end = Number(q.get('end')), step = parseDuration(q.get('step')) || Number(q.get('step')) || 60;
      try {
        const map = new Map();
        for (let tt = start; tt <= end; tt += step) { const r = evalPromQL(this.tsdb, q.get('query'), tt); for (const s of r.samples || []) { const k = seriesName(s.labels); if (!map.has(k)) map.set(k, { metric: s.labels, values: [] }); map.get(k).values.push([tt, formatValue(s.v)]); } }
        return json({ status: 'success', data: { resultType: 'matrix', result: [...map.values()] } });
      } catch (e) { return { status: 400, body: JSON.stringify({ status: 'error', errorType: 'bad_data', error: e.message }) }; }
    }
    if (req.path === '/api/v1/targets') return json({ status: 'success', data: { activeTargets: this.targets() } });
    if (req.path === '/api/v1/alerts') return json({ status: 'success', data: { alerts: [...this.alerts.values()].map(a => ({ labels: a.labels, annotations: a.annotations, state: a.state, activeAt: new Date(a.activeAt * 1000).toISOString(), value: formatValue(a.value) })) } });
    if (req.path === '/api/v1/rules') return json({ status: 'success', data: { groups: (this.rules || []).map(g => ({ name: g.name, rules: g.rules.map(r => ({ name: r.alert || r.record, query: r.expr, type: r.alert ? 'alerting' : 'recording' })) })) } });
    if (req.path === '/api/v1/label/__name__/values') return json({ status: 'success', data: this.tsdb.names() });
    if (req.path === '/metrics') return { status: 200, body: `prometheus_build_info{version="2.53.2"} 1\nprometheus_tsdb_head_series ${this.tsdb.series.size}\nprometheus_config_last_reload_successful ${this.reloadOk === false ? 0 : 1}\nprometheus_rule_group_rules ${(this.rules || []).reduce((n, g) => n + (g.rules || []).length, 0)}\n` };
    return { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>Prometheus Time Series Collection and Processing Server</title>' };
  }
  targets() {
    return (this.cfg?.scrape_configs || []).flatMap(job => (job.static_configs || []).flatMap(s => (s.targets || []).map(tg => {
      const key = `${job.job_name}|${tg}`;
      const up = this.tsdb.select('up', [{ name: 'job', op: '=', value: job.job_name }, { name: 'instance', op: '=', value: tg }])[0]?.samples.at(-1);
      return { labels: { job: job.job_name, instance: tg }, scrapeUrl: `http://${tg}${job.metrics_path || '/metrics'}`, health: !up ? 'unknown' : up.v ? 'up' : 'down', lastError: this.lastError?.[key] || '', lastScrape: up ? new Date(up.t * 1000).toISOString() : null };
    })));
  }
}
function validateConfig(cfg, host, path) {
  if (typeof cfg !== 'object' || Array.isArray(cfg)) return { error: `parsing YAML file ${path}: yaml: unmarshal errors` };
  for (const k of Object.keys(cfg)) if (!['global', 'scrape_configs', 'rule_files', 'alerting', 'remote_write'].includes(k)) return { error: `parsing YAML file ${path}: yaml: unmarshal errors:\n  line 1: field ${k} not found in type config.plain` };
  const names = new Set();
  for (const j of cfg.scrape_configs || []) {
    if (!j.job_name) return { error: 'parsing YAML file: job_name is empty' };
    if (names.has(j.job_name)) return { error: `found multiple scrape configs with job name "${j.job_name}"` };
    names.add(j.job_name);
    for (const k of Object.keys(j)) if (!['job_name', 'static_configs', 'metrics_path', 'scrape_interval', 'scrape_timeout', 'scheme', 'honor_labels', 'relabel_configs'].includes(k)) return { error: `parsing YAML file ${path}: yaml: unmarshal errors:\n  field ${k} not found in type config.ScrapeConfig` };
    for (const s of j.static_configs || []) for (const tg of s.targets || []) if (!/^[\w.-]+:\d+$/.test(String(tg))) return { error: `"${tg}" is not a valid hostname` };
  }
  const rules = [];
  for (const rf of [].concat(cfg.rule_files || [])) {
    const p = rf.startsWith('/') ? rf : path.replace(/[^/]+$/, '') + rf;
    const t = host.files.get(p);
    if (t === undefined) continue;
    const r = checkRules(t, p);
    if (r.error) return { error: `error loading rules, previous rule set restored: ${r.error}` };
    rules.push(...r.groups);
  }
  return { ok: true, rules };
}
export function checkRules(text, path) {
  let doc;
  try { doc = parseYaml(text) || {}; } catch (e) { return { error: `${path}: yaml: ${e.message}` }; }
  if (!Array.isArray(doc.groups)) return { error: `${path}: yaml: unmarshal errors: groups must be a list` };
  for (const g of doc.groups) {
    if (!g.name) return { error: `${path}: groupname must not be empty` };
    for (const [i, r] of (g.rules || []).entries()) {
      if (!r.alert && !r.record) return { error: `${path}: group "${g.name}", rule ${i + 1}: one of 'record' or 'alert' must be set` };
      if (!r.expr) return { error: `${path}: group "${g.name}", rule ${i + 1}, "${r.alert || r.record}": field 'expr' must be set in rule` };
      try { parsePromQL(String(r.expr)); } catch (e) { return { error: `${path}: group "${g.name}", rule ${i + 1}, "${r.alert || r.record}": could not parse expression: ${e.message}` }; }
      if (r.for && !parseDuration(r.for)) return { error: `${path}: group "${g.name}", rule ${i + 1}: not a valid duration string: "${r.for}"` };
    }
  }
  return { groups: doc.groups, count: doc.groups.reduce((s, g) => s + (g.rules || []).length, 0) };
}
programFactories.set('prometheus', ctx => new Prometheus(ctx));

// ---------------------------------------------------------------- Alertmanager
class Alertmanager {
  constructor({ host, uni, argv }) {
    this.host = host; this.uni = uni; this.kind = 'alertmanager'; this.memMB = 40;
    this.configPath = (argv.find(a => a.startsWith('--config.file=')) || '--config.file=/etc/alertmanager/alertmanager.yml').split('=')[1];
    this.groups = new Map();   // groupKey -> { receiver, alerts: Map, firstAt, lastSent, sentHash }
    this.silences = [];
  }
  start() {
    const t = this.host.files.get(this.configPath);
    if (t === undefined) return { ok: false, code: 1, logs: [`level=error msg="Loading configuration file failed" file=${this.configPath} err="open ${this.configPath}: no such file or directory"`] };
    try { this.cfg = parseYaml(t); } catch (e) { return { ok: false, code: 1, logs: [`level=error msg="Loading configuration file failed" file=${this.configPath} err="yaml: ${e.message}"`] }; }
    const names = new Set((this.cfg.receivers || []).map(r => r.name));
    const missing = (function walk(r) { return [r?.receiver, ...(r?.routes || []).flatMap(walk)]; })(this.cfg.route).filter(x => x && !names.has(x));
    if (!this.cfg.route?.receiver) return { ok: false, code: 1, logs: [`level=error msg="Loading configuration file failed" file=${this.configPath} err="root route must specify a default receiver"`] };
    if (missing.length) return { ok: false, code: 1, logs: [`level=error msg="Loading configuration file failed" file=${this.configPath} err="undefined receiver \\"${missing[0]}\\" used in route"`] };
    this.uni.obs = this.uni.obs || new Obs(this.uni);
    if (!this.uni.obs.ams.includes(this)) this.uni.obs.ams.push(this);
    return { ok: true, ports: [{ port: 9093, addr: '0.0.0.0' }], logs: ['level=info msg="Starting Alertmanager" version="(version=0.27.0)"', `level=info msg="Loading configuration file" file=${this.configPath}`, 'level=info msg="Listening on" address=[::]:9093'] };
  }
  reload() {
    const t = this.host.files.get(this.configPath);
    try { const cfg = parseYaml(t); if (!cfg?.route?.receiver) throw new Error('root route must specify a default receiver'); this.cfg = cfg; this.host.log('prometheus-alertmanager.service', 'level=info msg="Completed loading of configuration file"'); }
    catch (e) { this.host.log('prometheus-alertmanager.service', `level=error msg="Loading configuration file failed" err="${e.message}"`, 'err'); }
  }
  route(labels) {
    const matches = (r) => (r.matchers || []).every(m => { const mm = String(m).match(/^\s*(\w+)\s*(=~|!=|=)\s*"?([^"]*)"?\s*$/); if (!mm) return true; const v = labels[mm[1]] ?? ''; return mm[2] === '=' ? v === mm[3] : mm[2] === '!=' ? v !== mm[3] : new RegExp(`^(?:${mm[3]})$`).test(v); }) && Object.entries(r.match || {}).every(([k, v]) => labels[k] === v);
    const walk = (r, inherited) => { for (const ch of r.routes || []) if (matches(ch)) return walk(ch, { ...inherited, ...ch }); return { ...inherited, receiver: r.receiver || inherited.receiver }; };
    return walk(this.cfg.route, this.cfg.route);
  }
  silenced(labels) { return this.silences.some(s => s.endsAt > this.uni.time && s.matchers.every(m => labels[m.name] === m.value)); }
  handle(req) {
    if (req.path === '/api/v2/alerts' && req.method === 'POST') {
      let alerts = [];
      try { alerts = JSON.parse(req.body || '[]'); } catch { return { status: 400, body: 'bad json' }; }
      for (const a of alerts) {
        const rt = this.route(a.labels);
        const gb = [].concat(rt.group_by || ['alertname']);
        const gk = rt.receiver + '|' + gb.map(k => `${k}=${a.labels[k] ?? ''}`).join(',');
        let g = this.groups.get(gk);
        if (!g) { g = { receiver: rt.receiver, alerts: new Map(), firstAt: this.uni.time, lastSent: null, sentHash: null, wait: parseDuration(rt.group_wait || '30s'), repeat: parseDuration(rt.repeat_interval || '4h') }; this.groups.set(gk, g); }
        const prevA = g.alerts.get(JSON.stringify(a.labels));
        g.alerts.set(JSON.stringify(a.labels), { ...a, resolved: !!a.endsAt, at: this.uni.time, notified: prevA?.notified && !prevA?.notifiedResolved, notifiedResolved: false });
      }
      return { status: 200, body: '' };
    }
    if (req.path === '/api/v2/alerts') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify([...this.groups.values()].flatMap(g => [...g.alerts.values()].filter(a => !a.resolved).map(a => ({ labels: a.labels, annotations: a.annotations, status: { state: this.silenced(a.labels) ? 'suppressed' : 'active' }, receivers: [{ name: g.receiver }] })))) };
    if (req.path === '/api/v2/silences' && req.method === 'POST') { const s = JSON.parse(req.body); s.id = fakeHash(String(this.uni.time + this.silences.length), 8) + '-' + fakeHash('s', 4); this.silences.push(s); return { status: 200, body: JSON.stringify({ silenceID: s.id }) }; }
    if (req.path === '/api/v2/silences') return { status: 200, body: JSON.stringify(this.silences) };
    if (req.path === '/-/healthy') return { status: 200, body: 'OK' };
    return { status: 200, body: '<!doctype html><title>Alertmanager</title>' };
  }
  tick() {
    const l = this.host.listening.get(9093);
    if (!l || l.program !== this || !this.host.procs.has(l.pid)) { this.uni.obs.ams = this.uni.obs.ams.filter(a => a !== this); return; }
    const t = this.uni.time;
    for (const [gk, g] of this.groups) {
      // alerts not refreshed for a while are considered resolved
      for (const [k, a] of g.alerts) if (!a.resolved && t - a.at > 300) a.resolved = true;
      const active = [...g.alerts.values()].filter(a => !a.resolved && !this.silenced(a.labels));
      const resolved = [...g.alerts.values()].filter(a => a.resolved && !a.notifiedResolved && a.notified);
      if (t - g.firstAt < g.wait) continue;
      const hash = active.map(a => JSON.stringify(a.labels)).sort().join('|');
      const due = active.length && (hash !== g.sentHash || t - (g.lastSent || 0) >= g.repeat);
      if (due || (resolved.length && !active.length)) {
        const status = active.length ? 'firing' : 'resolved';
        const list = active.length ? active : resolved;
        this.send(g.receiver, status, list, gk);
        g.lastSent = t; g.sentHash = hash;
        for (const a of list) { if (status === 'firing') a.notified = true; else a.notifiedResolved = true; }
      }
      if (![...g.alerts.values()].some(a => !a.resolved)) { if ([...g.alerts.values()].every(a => !a.notified || a.notifiedResolved)) this.groups.delete(gk); }
    }
  }
  send(receiverName, status, alerts, gk) {
    const rcv = (this.cfg.receivers || []).find(r => r.name === receiverName);
    for (const w of rcv?.webhook_configs || []) httpRequest(this.uni, this.host, w.url, { method: 'POST', body: JSON.stringify({ version: '4', status, receiver: receiverName, groupKey: gk, alerts: alerts.map(a => ({ status, labels: a.labels, annotations: a.annotations })) }), headers: { 'content-type': 'application/json' } });
    this.uni.emit({ type: 'alert-notification', receiver: receiverName, status, alerts: alerts.map(a => a.labels.alertname) });
  }
}
programFactories.set('alertmanager', ctx => new Alertmanager(ctx));
programFactories.set('prometheus-alertmanager', ctx => new Alertmanager(ctx));

// packages
const unit = (desc, exec, user) => `[Unit]\nDescription=${desc}\nAfter=network-online.target\n\n[Service]\nUser=${user}\nExecStart=${exec}\nExecReload=/bin/kill -HUP $MAINPID\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`;
CATALOG.prometheus = {
  version: '2.53.2+ds1-1', size: '28.4 MB', bins: ['prometheus', 'promtool'],
  install(h) {
    if (!h.users.has('prometheus')) h.addUser('prometheus', { shell: '/usr/sbin/nologin', noHome: true });
    h.writeSys('/etc/prometheus/prometheus.yml', ['# Sample config for Prometheus.', 'global:', '  scrape_interval: 15s', '  evaluation_interval: 15s', '', 'scrape_configs:', '  - job_name: prometheus', '    static_configs:', '      - targets: ["localhost:9090"]', ''].join('\n'));
    h.writeSys('/lib/systemd/system/prometheus.service', unit('Monitoring system and time series database', '/usr/bin/prometheus --config.file=/etc/prometheus/prometheus.yml', 'prometheus'));
    h.binPaths = h.binPaths || new Set(); h.binPaths.add('/usr/bin/prometheus');
    return ['prometheus.service'];
  },
};
CATALOG['prometheus-alertmanager'] = {
  version: '0.27.0+ds-1', size: '9.8 MB', bins: ['amtool'],
  install(h) {
    h.writeSys('/etc/alertmanager/alertmanager.yml', ['route:', '  receiver: default', '  group_by: [alertname]', '  group_wait: 30s', '  repeat_interval: 4h', '', 'receivers:', '  - name: default', ''].join('\n'));
    h.writeSys('/lib/systemd/system/prometheus-alertmanager.service', unit('Alertmanager for prometheus', '/usr/bin/prometheus-alertmanager --config.file=/etc/alertmanager/alertmanager.yml', 'prometheus'));
    h.binPaths = h.binPaths || new Set(); h.binPaths.add('/usr/bin/prometheus-alertmanager');
    return ['prometheus-alertmanager.service'];
  },
};
CATALOG.logcli = { version: '3.2.1', size: '24.1 MB', bins: ['logcli'] };
CATALOG.traces = { version: '1.0.0', size: '3.2 MB', bins: ['traces'] };

// ---------------------------------------------------------------- promtool
def('promtool', c => {
  const [sub, what, ...rest] = c.args;
  if (sub === 'check' && what === 'config') {
    const p = c.resolve(rest[0] || 'prometheus.yml');
    const t = c.host.files.get(p);
    c.print(`Checking ${rest[0]}`);
    if (t === undefined) return c.fail(`  FAILED: open ${rest[0]}: no such file or directory`, 1);
    let cfg; try { cfg = parseYaml(t) || {}; } catch (e) { return c.fail(`  FAILED: parsing YAML file ${rest[0]}: yaml: ${e.message}`, 1); }
    const r = validateConfig(cfg, c.host, p);
    if (r.error) return c.fail(`  FAILED: ${r.error}`, 1);
    const rf = [].concat(cfg.rule_files || []);
    if (rf.length) c.print(` SUCCESS: ${rf.length} rule files found`);
    c.print(` SUCCESS: ${rest[0]} is valid prometheus config file syntax`, '');
    for (const f of rf) { const fp = f.startsWith('/') ? f : p.replace(/[^/]+$/, '') + f; const ft = c.host.files.get(fp); c.print(`Checking ${fp}`); if (ft === undefined) return c.fail(`  FAILED:\n${fp}: no such file or directory`, 1); const cr = checkRules(ft, fp); if (cr.error) return c.fail(`  FAILED:\n${cr.error}`, 1); c.print(`  SUCCESS: ${cr.count} rules found`, ''); }
    c.uni.emit({ type: 'promtool', host: c.host.name, sub: 'check-config', ok: true });
    return 0;
  }
  if (sub === 'check' && what === 'rules') {
    let code = 0;
    for (const f of rest) { const p = c.resolve(f); const t = c.host.files.get(p); c.print(`Checking ${f}`); if (t === undefined) { c.print(`  FAILED:\n${f}: no such file or directory`); code = 1; continue; } const r = checkRules(t, f); if (r.error) { c.print(C.red(`  FAILED:\n${r.error}`), ''); code = 1; } else c.print(`  SUCCESS: ${r.count} rules found`, ''); }
    c.uni.emit({ type: 'promtool', host: c.host.name, sub: 'check-rules', ok: code === 0 });
    return code;
  }
  if (sub === 'query' && what === 'instant') {
    const [url, expr] = rest;
    const r = httpRequest(c.uni, c.host, `${url.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(expr)}`);
    if (r.error) return c.fail(`query error: Post "${url}/api/v1/query": dial tcp: connect: connection refused`, 1);
    const d = JSON.parse(r.body);
    if (d.status !== 'success') return c.fail(`query error: bad_data: ${d.error}`, 1);
    if (d.data.resultType === 'scalar') c.print(`scalar: ${d.data.result[1]} @[${d.data.result[0]}]`);
    else for (const s of d.data.result) c.print(`${seriesName(s.metric)} => ${s.value[1]} @[${s.value[0]}]`);
    return 0;
  }
  return c.fail('usage: promtool [<flags>] <command> [<args> ...]\n\nCommands:\n  check config <config-files>...\n  check rules <rule-files>...\n  query instant <server> <expr>', 1);
}, { pkg: 'prometheus' });

// ---------------------------------------------------------------- amtool
def('amtool', c => {
  const url = (c.args.find(a => a.startsWith('--alertmanager.url=')) || '--alertmanager.url=http://localhost:9093').split('=')[1];
  const args = c.args.filter(a => !a.startsWith('--alertmanager.url'));
  const [sub, op, ...rest] = args;
  if (sub === 'alert' && (!op || op === 'query')) {
    const r = httpRequest(c.uni, c.host, `${url}/api/v2/alerts`);
    if (r.error) return c.fail(`amtool: error: Get "${url}/api/v2/alerts": dial tcp: connect: connection refused`, 1);
    const list = JSON.parse(r.body);
    c.print('Alertname                Starts At                Summary                                     State');
    for (const a of list) c.print(`${a.labels.alertname.padEnd(24)} ${new Date(c.uni.time * 1000).toUTCString().slice(5, 25).padEnd(24)} ${(a.annotations?.summary || '').slice(0, 42).padEnd(43)} ${a.status.state}`);
    return 0;
  }
  if (sub === 'silence' && op === 'add') {
    const matchers = rest.filter(x => /=/.test(x) && !x.startsWith('--')).map(x => { const [k, v] = x.split('='); return { name: k, value: v.replace(/^"|"$/g, ''), isRegex: false }; });
    const dur = parseDuration((rest.find(x => x.startsWith('--duration=')) || '--duration=1h').split('=')[1]);
    const comment = (rest.find(x => x.startsWith('--comment=')) || '').split('=').slice(1).join('=').replace(/^"|"$/g, '');
    if (!comment) return c.fail('amtool: error: comment required by config', 1);
    const r = httpRequest(c.uni, c.host, `${url}/api/v2/silences`, { method: 'POST', body: JSON.stringify({ matchers, startsAt: c.uni.time, endsAt: c.uni.time + dur, comment, createdBy: c.user }) });
    if (r.error) return c.fail(`amtool: error: Post "${url}/api/v2/silences": connection refused`, 1);
    c.print(JSON.parse(r.body).silenceID);
    c.uni.emit({ type: 'amtool-silence', matchers, duration: dur, comment });
    return 0;
  }
  if (sub === 'silence' && (op === 'query' || !op)) { const r = httpRequest(c.uni, c.host, `${url}/api/v2/silences`); const list = JSON.parse(r.body || '[]'); c.print('ID                                    Matchers              Ends At                  Created By  Comment'); for (const s of list) c.print(`${s.id.padEnd(37)} ${s.matchers.map(m => `${m.name}="${m.value}"`).join(' ').padEnd(21)} ${new Date(s.endsAt * 1000).toISOString().padEnd(24)} ${s.createdBy.padEnd(11)} ${s.comment}`); return 0; }
  if (sub === 'check-config') { const t = c.host.files.get(c.resolve(op)); if (t === undefined) return c.fail(`Checking '${op}'  FAILED: open ${op}: no such file or directory`, 1); try { parseYaml(t); } catch (e) { return c.fail(`Checking '${op}'  FAILED: yaml: ${e.message}`, 1); } c.print(`Checking '${op}'  SUCCESS`, 'Found:', ' - global config', ' - route', ` - ${(parseYaml(t).receivers || []).length} receivers`); return 0; }
  return c.fail('usage: amtool [<flags>] <command> [<args> ...]\n\nCommands:\n  alert query\n  silence add <matcher>... --comment=… --duration=…\n  silence query\n  check-config <file>', 1);
}, { pkg: 'prometheus-alertmanager' });

// ---------------------------------------------------------------- logcli (LogQL subset)
export function runLogQL(obs, q, { since = 3600, limit = 100, now }) {
  const m = q.trim().match(/^(?:(sum|count|avg|max)\s*(?:by\s*\(([^)]*)\))?\s*\(\s*)?(?:(count_over_time|rate)\s*\(\s*)?(\{[^}]*\})(.*?)(?:\[(\w+)\]\s*\))?\s*\)?\s*(?:by\s*\(([^)]*)\))?$/s);
  if (!m) throw new Error(`parse error : syntax error: unexpected IDENTIFIER, expecting { or ( `);
  const [, aggOp, by1, rangeFn, sel, pipeline, range, by2] = m;
  const matchers = [...sel.matchAll(/(\w+)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)].map(x => ({ name: x[1], op: x[2], value: x[3] }));
  if (!matchers.length) throw new Error('parse error : queries require at least one regexp or equality matcher that does not have an empty-compatible value');
  const stages = [];
  let rest = pipeline.trim();
  while (rest) {
    let mm;
    if ((mm = rest.match(/^\|=\s*"([^"]*)"/))) stages.push({ t: 'contains', v: mm[1] });
    else if ((mm = rest.match(/^!=\s*"([^"]*)"/))) stages.push({ t: 'notcontains', v: mm[1] });
    else if ((mm = rest.match(/^\|~\s*"([^"]*)"/))) stages.push({ t: 'regex', v: new RegExp(mm[1]) });
    else if ((mm = rest.match(/^!~\s*"([^"]*)"/))) stages.push({ t: 'notregex', v: new RegExp(mm[1]) });
    else if ((mm = rest.match(/^\|\s*json/))) stages.push({ t: 'json' });
    else if ((mm = rest.match(/^\|\s*line_format\s*"([^"]*)"/))) stages.push({ t: 'format', v: mm[1] });
    else if ((mm = rest.match(/^\|\s*(\w+)\s*(>=|<=|!=|=~|==|=|>|<)\s*("([^"]*)"|[\d.]+(?:ms|s)?)/))) stages.push({ t: 'filter', k: mm[1], op: mm[2], v: mm[4] ?? mm[3] });
    else throw new Error(`parse error at "${rest.slice(0, 20)}": syntax error`);
    rest = rest.slice(mm[0].length).trim();
  }
  const from = now - (range ? parseDuration(range) : since);
  const lines = [];
  for (const e of obs.logs) {
    if (e.t < from || e.t > now) continue;
    if (!matchers.every(x => { const v = e.labels[x.name] ?? ''; return x.op === '=' ? v === x.value : x.op === '!=' ? v !== x.value : x.op === '=~' ? new RegExp(`^(?:${x.value})$`).test(v) : !new RegExp(`^(?:${x.value})$`).test(v); })) continue;
    let line = e.line, fields = null, ok = true;
    for (const s of stages) {
      if (s.t === 'contains') ok = line.includes(s.v); else if (s.t === 'notcontains') ok = !line.includes(s.v); else if (s.t === 'regex') ok = s.v.test(line); else if (s.t === 'notregex') ok = !s.v.test(line);
      else if (s.t === 'json') { try { fields = JSON.parse(line); } catch { fields = {}; } }
      else if (s.t === 'filter') { const v = (fields || {})[s.k] ?? e.labels[s.k]; const num = parseFloat(s.v) * (/ms$/.test(s.v) ? 1 : /s$/.test(s.v) ? 1000 : 1); ok = s.op === '=' || s.op === '==' ? String(v) === s.v : s.op === '!=' ? String(v) !== s.v : s.op === '=~' ? new RegExp(s.v).test(String(v)) : s.op === '>' ? Number(v) > num : s.op === '<' ? Number(v) < num : s.op === '>=' ? Number(v) >= num : Number(v) <= num; }
      else if (s.t === 'format') line = s.v.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, k) => (fields || {})[k] ?? e.labels[k] ?? '');
      if (!ok) break;
    }
    if (ok) lines.push({ ...e, line, fields });
  }
  if (!rangeFn) return { kind: 'logs', lines: lines.slice(-limit).reverse() };
  const by = (by1 || by2 || '').split(',').map(x => x.trim()).filter(Boolean);
  const groups = new Map();
  for (const e of lines) { const lbl = Object.fromEntries((aggOp ? by : Object.keys(e.labels)).map(k => [k, (e.fields || {})[k] ?? e.labels[k] ?? ''])); const k = JSON.stringify(lbl); groups.set(k, (groups.get(k) || 0) + 1); }
  const secs = parseDuration(range);
  return { kind: 'metric', series: [...groups].map(([k, n]) => ({ labels: JSON.parse(k), v: rangeFn === 'rate' ? n / secs : n })) };
}
def('logcli', c => {
  const [sub, ...rest] = c.args;
  if (sub !== 'query' && sub !== 'instant-query') return c.fail('usage: logcli query \'{app="shop"} |= "error"\' [--since=1h] [--limit=30]', 1);
  if (!c.uni.obs) return c.fail('Query failed: Get "http://localhost:3100/loki/api/v1/query_range": dial tcp 127.0.0.1:3100: connect: connection refused', 1);
  const q = rest.find(a => !a.startsWith('--'));
  const since = parseDuration((rest.find(a => a.startsWith('--since=')) || '--since=1h').split('=')[1]);
  const limit = Number((rest.find(a => a.startsWith('--limit=')) || '--limit=30').split('=')[1]);
  let r;
  try { r = runLogQL(c.uni.obs, q || '', { since, limit, now: c.uni.time }); } catch (e) { return c.fail(`Query failed: ${e.message}`, 1); }
  if (r.kind === 'logs') {
    for (const e of r.lines) c.print(`${C.dim(new Date(e.t * 1000).toISOString())} ${C.cyan(`{${Object.entries(e.labels).map(([k, v]) => `${k}="${v}"`).join(', ')}}`)} ${e.line}`);
    if (!r.lines.length) c.eprint(C.dim('(no log lines matched)'));
  } else for (const s of r.series) c.print(`${JSON.stringify(s.labels)} ${formatValue(Number(s.v.toFixed(4)))}`);
  c.uni.emit({ type: 'logql', host: c.host.name, query: q, kind: r.kind, results: r.kind === 'logs' ? r.lines.length : r.series.length });
  return 0;
}, { pkg: 'logcli' });

// ---------------------------------------------------------------- traces
def('traces', c => {
  const obs = c.uni.obs;
  const [sub, ...rest] = c.args;
  const flag = (n, d) => { const i = rest.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return d; return rest[i].includes('=') ? rest[i].split('=').slice(1).join('=') : rest[i + 1]; };
  if (!obs) return c.fail('traces: cannot reach the tracing backend (http://localhost:3200)', 1);
  if (sub === 'search') {
    const svc = flag('service'), route = flag('route'), minDur = parseDuration(flag('min-duration', '0s')), status = flag('status'), limit = Number(flag('limit', 10));
    const since = parseDuration(flag('since', '1h'));
    const list = obs.traces.filter(t => t.start >= c.uni.time - since && (!svc || t.service === svc || t.spans.some(s => s.service === svc)) && (!route || t.route === route) && t.duration >= minDur && (!status || t.status === status)).slice(-limit).reverse();
    c.print(`${'TRACE ID'.padEnd(34)}${'ROOT'.padEnd(26)}${'DURATION'.padEnd(10)}${'SPANS'.padEnd(7)}STATUS   AGE`);
    for (const t of list) c.print(`${t.id.padEnd(34)}${`${t.service} ${t.method} ${t.route}`.slice(0, 25).padEnd(26)}${`${Math.round(t.duration * 1000)}ms`.padEnd(10)}${String(t.spans.length).padEnd(7)}${t.status === 'error' ? C.red('error') + '    ' : 'ok       '}${Math.max(1, Math.round((c.uni.time - t.start) / 60))}m`);
    if (!list.length) c.eprint(C.dim('(no traces matched)'));
    c.uni.emit({ type: 'traces', host: c.host.name, sub: 'search', service: svc, route, status, minDur, results: list.length });
    return 0;
  }
  if (sub === 'show') {
    const id = rest[0];
    const t = obs.traces.find(x => x.id === id || x.id.startsWith(id || '-'));
    if (!t) return c.fail(`traces: trace ${id} not found`, 1);
    const W = 40;
    c.print(`Trace ${t.id}  ${t.service} ${t.method} ${t.route}  ${Math.round(t.duration * 1000)}ms  ${t.status}`, '');
    const depth = s => { let d = 0, p = s; while (p.parent) { p = t.spans.find(x => x.id === p.parent); d++; } return d; };
    for (const s of t.spans) {
      const a = Math.round(s.start / t.duration * W), b = Math.max(1, Math.round(s.dur / t.duration * W));
      const bar = ' '.repeat(Math.min(W, a)) + (s.status === 'error' ? C.red('█'.repeat(Math.min(b, W - a))) : C.cyan('█'.repeat(Math.min(b, Math.max(1, W - a)))));
      c.print(`${('  '.repeat(depth(s)) + `${s.service}: ${s.name}`).slice(0, 38).padEnd(38)} ${bar.padEnd(W)} ${String(Math.round(s.dur * 1000)).padStart(5)}ms${s.status === 'error' ? C.red(' ERROR') : ''}${Object.keys(s.attrs).length ? C.dim(' ' + Object.entries(s.attrs).map(([k, v]) => `${k}=${v}`).join(' ')) : ''}`);
    }
    c.uni.emit({ type: 'traces', host: c.host.name, sub: 'show', id: t.id, slowest: [...t.spans].filter(s => s.parent).sort((x, y) => y.dur - x.dur)[0]?.service });
    return 0;
  }
  return c.fail('usage: traces search [--service S] [--route R] [--min-duration 1s] [--status error] [--limit N]\n       traces show <trace-id>', 1);
}, { pkg: 'traces' });

export { Prometheus, Alertmanager };
