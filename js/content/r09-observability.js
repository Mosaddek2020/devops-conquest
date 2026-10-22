// Realm 9 · Observability: instrumented apps with realistic traffic, node_exporter,
// Prometheus (scraping, PromQL, rules, alerts), Alertmanager into a team chat, logs with
// LogQL and traces, all simulated and queryable.

import { parseYaml } from '../git/yaml.js';

const SHOP_SRC = ["const express = require('express');", "const client = require('prom-client');", 'const app = express();', 'const PORT = process.env.PORT || 3000;', 'client.collectDefaultMetrics();', "app.get('/', (req, res) => res.send('Lumen shop'));", "app.get('/search', (req, res) => res.json({ results: [] }));", "app.get('/cart', (req, res) => res.json({ items: [] }));", "app.post('/checkout', (req, res) => res.json({ ok: true }));", 'app.listen(PORT, () => console.log(`shop listening on ${PORT}`));', ''].join('\n');
const SHOP_UNIT = '[Unit]\nDescription=Lumen shop\nAfter=network.target\n\n[Service]\nUser=ubuntu\nWorkingDirectory=/opt/shop\nEnvironmentFile=/etc/shop/shop.env\nExecStart=/usr/bin/node server.js\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n';
const CHECKOUT_SPANS = [['auth', 'verify session', 0.08], ['cart', 'load cart', 0.1], ['payments', 'POST /charge', 0.6, { fails: true, children: [['bank-api', 'authorize card', 0.85]], failChild: 'bank-api' }], ['db', 'INSERT order', 0.15]];
const ROUTES = (o = {}) => ({
  '/': { rps: 18, p50: 0.025, p99: 0.11, err: 0.001 },
  '/search': { rps: 9, p50: 0.08, p99: 0.42, err: 0.002, spans: [['search-index', 'query', 0.7]] },
  '/cart': { rps: 4, p50: 0.03, p99: 0.15, err: 0.003, errMsg: 'cart not found' },
  '/checkout': { rps: 2.5, p50: 0.18, p99: 0.9, err: 0.004, method: 'POST', spans: CHECKOUT_SPANS, errMsg: 'payment declined', ...o },
});
const PROM_CFG = ({ webs = ['web1'], shopPort = 3000, rules = false, am = false } = {}) => ['global:', '  scrape_interval: 15s', '  evaluation_interval: 15s', ...(rules ? ['', 'rule_files:', '  - rules.yml'] : []), ...(am ? ['', 'alerting:', '  alertmanagers:', '    - static_configs:', '        - targets: ["localhost:9093"]'] : []), '', 'scrape_configs:', '  - job_name: prometheus', '    static_configs:', '      - targets: ["localhost:9090"]', '  - job_name: node', '    static_configs:', `      - targets: [${webs.map(w => `"${w}:9100"`).join(', ')}]`, '  - job_name: shop', '    static_configs:', `      - targets: [${webs.map(w => `"${w}:${shopPort}"`).join(', ')}]`, ''].join('\n');
const AM_DEFAULT = ['route:', '  receiver: default', '  group_by: [alertname]', '  group_wait: 30s', '  repeat_interval: 4h', '', 'receivers:', '  - name: default', ''].join('\n');
const AM_CHAT = ['route:', '  receiver: team-chat', '  group_by: [alertname]', '  group_wait: 30s', '  repeat_interval: 4h', '  routes:', '    - matchers: [ \'severity="page"\' ]', '      receiver: oncall', '', 'receivers:', '  - name: team-chat', '    webhook_configs:', '      - url: http://chat.lumen.dev/hooks/team', '  - name: oncall', '    webhook_configs:', '      - url: http://chat.lumen.dev/hooks/oncall', ''].join('\n');
const ERR_RULE = ['groups:', '  - name: shop', '    rules:', '      - alert: ShopHighErrorRate', '        expr: sum(rate(http_requests_total{job="shop",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="shop"}[5m])) > 0.05', '        for: 5m', '        labels:', '          severity: page', '        annotations:', '          summary: "Shop error rate is {{ $value | humanizePercentage }}"', '          runbook: https://wiki.lumen.dev/runbooks/shop-errors', ''].join('\n');

// build the monitored world: shop on the web servers, Prometheus on mon, some history
function shopWorld(H, { webs = ['web1'], promCfg = null, am = false, amCfg = AM_DEFAULT, rules = null, history = 1800, routes = ROUTES(), exporters = webs, laptopTools = true, extraRoutes = {} } = {}) {
  H.observe();
  for (const w of webs) {
    H.server(w, { packages: ['nodejs', ...(exporters.includes(w) ? ['prometheus-node-exporter'] : [])] });
    H.authorize('laptop', 'dev', w, 'ubuntu');
    H.mkdir(w, '/opt/shop', { owner: 'ubuntu' });
    H.write(w, '/opt/shop/server.js', SHOP_SRC, { owner: 'ubuntu' });
    for (const m of ['express', 'prom-client']) H.mkdir(w, `/opt/shop/node_modules/${m}`, { owner: 'ubuntu' });
    H.write(w, '/etc/shop/shop.env', 'PORT=3000\nPAYMENTS_TIMEOUT_MS=3000\nLOG_FORMAT=json\n');
    H.service(w, 'shop', SHOP_UNIT);
    H.traffic(w, 3000, 'shop', JSON.parse(JSON.stringify({ ...routes, ...(extraRoutes[w] || {}) })));
  }
  H.server('mon', { packages: ['prometheus', ...(am ? ['prometheus-alertmanager'] : [])] });
  H.authorize('laptop', 'dev', 'mon', 'ubuntu');
  H.write('mon', '/etc/prometheus/prometheus.yml', promCfg || PROM_CFG({ webs, rules: !!rules, am }));
  if (rules) H.write('mon', '/etc/prometheus/rules.yml', rules);
  if (am) H.write('mon', '/etc/alertmanager/alertmanager.yml', amCfg);
  H.run(`sudo systemctl restart prometheus${am ? ' prometheus-alertmanager' : ''}`, { on: 'mon' });
  if (laptopTools) H.install('laptop', 'prometheus', 'logcli', 'traces');
  if (history) H.uni.advance(history);
}
const profile = (H, host) => H.uni.obs.profiles.find(p => p.host === host);
const promqlOk = (t, re, pred = () => true) => t.events('promql').some(e => e.ok && re.test(e.expr.replace(/\s+/g, ' ')) && pred(e));
const val = r => r && r.type !== 'string' ? (r.type === 'scalar' ? r.v : r.samples[0]?.v) : undefined;
const near = (a, b, tol = 0.2) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(Math.abs(b) * tol, 1e-4);
const logqlOk = (t, re, pred = () => true) => t.events('logql').some(e => re.test(e.query || '') && pred(e));
const chatHas = (t, channel, status, alert) => t.chat().some(m => (!channel || m.channel === channel) && m.payload.status === status && (!alert || (m.payload.alerts || []).some(a => a.labels?.alertname === alert)));
const promOn = t => t.prom();
const ruleNamed = (t, name) => (promOn(t)?.rules || []).flatMap(g => g.rules || []).find(r => r.alert === name || r.record === name);
const fileHas = (t, path, re) => re.test(t.file('laptop', path) || '');

export default {
  id: 'observability',
  n: 9,
  title: 'Observability',
  tagline: 'Metrics, PromQL, dashboards, alerting, logs, traces and SLOs: see what your systems are doing',
  badge: 'Signal Reader',
  intro: 'You cannot fix what you cannot see. Read the **golden signals** of a live shop, run **Prometheus** and its exporters, answer questions in **PromQL**, build dashboards people can read, **alert** on user pain through Alertmanager, search **structured logs**, follow **traces** across services, and set **SLOs** with error budgets. The traffic, metrics, logs and traces here are simulated and consistent with each other.',
  lessons: [
    {
      id: 'why-observability',
      title: 'Why observability',
      summary: 'Monitoring vs observability; metrics, logs and traces; the four golden signals; percentiles over averages; a first look at Prometheus.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['observe', 'system'],
        setup(H) { shopWorld(H); },
        suggestions: ['curl -s web1:3000/metrics | head -20', "promtool query instant http://mon:9090 'up'"],
        tasks: [
          { title: 'See what the shop exposes: fetch the first lines of `web1:3000/metrics`', solution: 'curl -s web1:3000/metrics | head -20', check: t => t.events('http').some(e => e.host === 'laptop' && /web1:3000\/metrics/.test(e.url) && e.status === 200) },
          { title: 'Ask Prometheus on `mon` which targets it scrapes and whether they are up', solution: "promtool query instant http://mon:9090 'up'", check: t => promqlOk(t, /^up\b/, e => e.results.length >= 3) },
          { title: 'Traffic: how many requests per second is the shop serving in total?', solution: "promtool query instant http://mon:9090 'sum(rate(http_requests_total{job=\"shop\"}[5m]))'", check: t => promqlOk(t, /rate\(\s*http_requests_total/, e => e.results.length >= 1) },
          { title: 'Errors: what fraction of shop requests fail (status 5xx)?', solution: "promtool query instant http://mon:9090 'sum(rate(http_requests_total{job=\"shop\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{job=\"shop\"}[5m]))'", check: t => promqlOk(t, /5\.\.|50\d/, e => e.results.length === 1 && e.results[0].v > 0 && e.results[0].v < 0.05) },
          { title: 'Latency: what is the 99th-percentile request duration, per route?', solution: "promtool query instant http://mon:9090 'histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))'", check: t => promqlOk(t, /histogram_quantile\(\s*0\.99/, e => e.results.length >= 3) },
          { title: 'Saturation: how much of web1\'s memory is in use (as a percentage)?', solution: "promtool query instant http://mon:9090 '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)'", check: t => promqlOk(t, /node_memory_MemAvailable_bytes/, e => e.results.length >= 1) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Which signal tells you WHERE in a multi-service request the time went?', choices: ['Metrics', 'Logs', 'Traces', 'Uptime checks'], answer: 2, explain: 'A trace shows every span of one request.' },
        { type: 'multi', q: 'The four golden signals:', choices: ['Latency', 'Traffic', 'Errors', 'Saturation', 'Lines of code'], answer: [0, 1, 2, 3], explain: 'Google SRE\'s four.' },
        { type: 'mc', q: 'Average latency is 120 ms. Why is that not enough?', choices: ['It is always wrong', 'It hides the slow tail: 1 in 100 users might wait seconds; look at p99', 'Averages are too expensive', 'Latency does not matter'], answer: 1, explain: 'Percentiles show what real users experience.' },
        { type: 'mc', q: 'Monitoring vs observability:', choices: ['The same thing', 'Monitoring watches known conditions; observability lets you ask new questions from the signals a system emits', 'Observability is only logs', 'Monitoring is only for hardware'], answer: 1, explain: 'Known-unknowns vs unknown-unknowns.' },
        { type: 'tf', q: 'An AI assistant can diagnose an outage reliably even if the service emits no metrics, logs or traces.', answer: false, explain: 'Without signals it can only guess.' },
        { type: 'mc', q: 'Prometheus gets metrics from an app by…', choices: ['The app pushing to it', 'Scraping (pulling) the app\'s /metrics endpoint on a schedule', 'Reading its log files', 'SSH'], answer: 1, explain: 'Pull-based, every scrape_interval.' },
      ],
    },
    {
      id: 'prometheus',
      title: 'Prometheus and exporters',
      summary: 'Scrape configs, jobs and instances, node_exporter, the exposition format, metric types, the up series, promtool and reloads.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['observe', 'system'],
        setup(H) { shopWorld(H, { webs: ['web1', 'web2'], exporters: ['web1'], promCfg: PROM_CFG({ webs: ['web1'], shopPort: 3001 }), history: 600 }); },
        suggestions: ["curl -s mon:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, instance: .labels.instance, health, lastError}'"],
        tasks: [
          { title: 'List Prometheus\'s targets with their health and last error', solution: "curl -s mon:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, instance: .labels.instance, health, lastError}'", check: t => t.events('http').some(e => e.host === 'laptop' && /mon:9090\/api\/v1\/targets/.test(e.url)) || promqlOk(t, /^up\b/) },
          { title: 'The `shop` job points at the wrong port. Fix `/etc/prometheus/prometheus.yml` on mon (the shop listens on 3000), check it with promtool and reload Prometheus', solution: 'ssh ubuntu@mon', test: ['ssh ubuntu@mon', 'sudo sed -i "s/web1:3001/web1:3000/" /etc/prometheus/prometheus.yml', 'promtool check config /etc/prometheus/prometheus.yml', 'sudo systemctl reload prometheus', 'sleep 30', 'exit'], check: t => t.events('promtool').some(e => e.sub === 'check-config' && e.ok) && val(t.promq('up{job="shop",instance="web1:3000"}')) === 1 },
          { title: '`web2` is not monitored at all. Install the node exporter on it and check it answers on port 9100', solution: 'ssh ubuntu@web2', test: ['ssh ubuntu@web2', 'sudo apt install -y prometheus-node-exporter', 'curl -s localhost:9100/metrics | grep node_load1', 'exit'], check: t => !!t.listening('web2', 9100) },
          { title: 'Add `web2:9100` to the node job and `web2:3000` to the shop job, check the config and reload', solution: 'ssh ubuntu@mon', test: ['ssh ubuntu@mon', 'sudo sed -i -e \'s/\\["web1:9100"\\]/["web1:9100", "web2:9100"]/\' -e \'s/\\["web1:3000"\\]/["web1:3000", "web2:3000"]/\' /etc/prometheus/prometheus.yml', 'promtool check config /etc/prometheus/prometheus.yml && sudo systemctl reload prometheus', 'sleep 30', 'exit'], check: t => val(t.promq('up{instance="web2:9100"}')) === 1 && val(t.promq('up{instance="web2:3000"}')) === 1 },
          { title: 'Prove nothing is down: query `up == 0` and get an empty result', solution: "promtool query instant http://mon:9090 'up == 0'", check: t => promqlOk(t, /up\s*==\s*0/, e => e.results.length === 0) && (t.promq('up') ? t.promq('up').samples.length >= 5 : false) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does `up{job="shop"} == 0` mean?', choices: ['No traffic', 'Prometheus could not scrape that target', 'The shop has 0 errors', 'The shop is idle'], answer: 1, explain: 'Wrong port, process down, firewall… lastError says which.' },
        { type: 'mc', q: 'Which metric type only ever increases (until a restart)?', choices: ['Gauge', 'Counter', 'Histogram bucket… only', 'Summary'], answer: 1, explain: 'Use rate() on counters.' },
        { type: 'mc', q: 'What does node_exporter do?', choices: ['Exports Node.js apps', 'Exposes Linux machine metrics (CPU, memory, disk, network) for Prometheus', 'Ships logs', 'Runs Prometheus'], answer: 1, explain: 'Port 9100 by convention.' },
        { type: 'multi', q: 'After editing prometheus.yml:', choices: ['promtool check config', 'Reload Prometheus', 'Check the targets page / up', 'Delete the TSDB'], answer: [0, 1, 2], explain: 'Never delete data to apply config.' },
        { type: 'tf', q: 'If a reload fails because of a config error, Prometheus keeps running with the previous config.', answer: true, explain: 'And prometheus_config_last_reload_successful becomes 0: alert on it.' },
        { type: 'mc', q: 'Labels `job` and `instance` on scraped series come from…', choices: ['The app', 'Prometheus, from the scrape config and target address', 'Grafana', 'node_exporter'], answer: 1, explain: 'Added at scrape time.' },
      ],
    },
    {
      id: 'promql',
      title: 'PromQL',
      summary: 'Selectors and matchers, rate and increase, sum by, error ratios, topk, histogram_quantile, and the classic mistakes.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['observe', 'files'],
        setup(H) { shopWorld(H, { webs: ['web1', 'web2'] }); },
        suggestions: ["promtool query instant http://mon:9090 'http_requests_total{route=\"/checkout\"}'"],
        tasks: [
          { title: 'Look at the raw counter for `/checkout` requests. Then turn it into requests per second, summed per route across both servers', solution: "promtool query instant http://mon:9090 'http_requests_total{route=\"/checkout\"}'; promtool query instant http://mon:9090 'sum by (route) (rate(http_requests_total[5m]))'", check: t => { const want = t.promq('sum by (route) (rate(http_requests_total[5m]))'); return promqlOk(t, /sum\s*by\s*\(\s*route\s*\)\s*\(\s*rate\(\s*http_requests_total(\{[^}]*\})?\[\d+m\]\)\s*\)/, e => e.results.length === 4 && e.results.every(r => near(r.v, want?.samples.find(s => s.labels.route === r.labels.route)?.v))); } },
          { title: 'Which single route gets the most traffic? Use `topk`', solution: "promtool query instant http://mon:9090 'topk(1, sum by (route) (rate(http_requests_total[5m])))'", check: t => promqlOk(t, /topk\(\s*1/, e => e.results.length === 1 && e.results[0].labels.route === '/') },
          { title: 'What is the error ratio of `/checkout` alone?', solution: "promtool query instant http://mon:9090 'sum(rate(http_requests_total{route=\"/checkout\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{route=\"/checkout\"}[5m]))'", check: t => { const want = val(t.promq('sum(rate(http_requests_total{route="/checkout",status=~"5.."}[5m])) / sum(rate(http_requests_total{route="/checkout"}[5m]))')); return promqlOk(t, /checkout/, e => e.results.length === 1 && near(e.results[0].v, want, 0.3)); } },
          { title: 'What is the 95th-percentile latency of `/search`, in seconds?', solution: "promtool query instant http://mon:9090 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route=\"/search\"}[5m])))'", check: t => { const want = val(t.promq('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route="/search"}[5m])))')); return promqlOk(t, /histogram_quantile\(\s*0\.95/, e => e.results.length === 1 && near(e.results[0].v, want, 0.15)); } },
          { title: 'How many successful checkouts (POST, status 200) happened in the last hour, across both servers?', solution: "promtool query instant http://mon:9090 'sum(increase(http_requests_total{route=\"/checkout\",status=\"200\"}[1h]))'", check: t => { const want = val(t.promq('sum(increase(http_requests_total{route="/checkout",status="200"}[1h]))')); return promqlOk(t, /increase\(/, e => e.results.length === 1 && near(e.results[0].v, want, 0.25)); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why `rate(x[5m])` and not just `x` for http_requests_total?', choices: ['rate is faster', 'x is a counter of everything since start; rate gives per-second speed', 'x is a gauge', 'rate rounds values'], answer: 1, explain: 'Counters only go up.' },
        { type: 'mc', q: 'Which is correct?', choices: ['rate(sum(http_requests_total)[5m])', 'sum(rate(http_requests_total[5m]))', 'sum(http_requests_total[5m])', 'rate(sum by (route) (http_requests_total))'], answer: 1, explain: 'Rate first (handles resets per series), then aggregate.' },
        { type: 'mc', q: 'In histogram_quantile, why keep `le` in the sum?', choices: ['Style', 'The function needs the bucket boundaries (le) to compute the quantile', 'It is optional', 'It removes NaN'], answer: 1, explain: 'sum by (le, …).' },
        { type: 'predict', q: 'What does this return?', code: 'up{job="node"} == 0', choices: ['Every node target, with 0 or 1', 'Only node targets that are down', 'A single number', 'An error'], answer: 1, explain: 'Comparison operators filter.' },
        { type: 'mc', q: 'increase(x[1h]) is roughly…', choices: ['rate(x[1h]) * 3600', 'x / 3600', 'max(x)', 'x[1h]'], answer: 0, explain: 'Total increase over the window.' },
        { type: 'tf', q: '`{status=~"5.."}` matches status 500, 502 and 503.', answer: true, explain: '=~ is a regex match (anchored).' },
      ],
    },
    {
      id: 'dashboards',
      title: 'Dashboards that answer questions',
      summary: 'RED for services, USE for resources, units and percentiles, dashboards as code, predict_linear for capacity.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['observe', 'files'],
        setup(H) {
          shopWorld(H, { webs: ['web1', 'web2'], history: 0 });
          const w2 = H.uni.host('web2');
          w2.baseDiskGB = 29;
          H.uni.tickers.push(dt => { w2.baseDiskGB = Math.min(39.6, w2.baseDiskGB + dt * 0.0012); });
          H.uni.advance(1800);
          H.mkdir('laptop', '/home/dev/dashboards', { owner: 'dev' });
        },
        suggestions: ['nano ~/dashboards/shop.yml'],
        tasks: [
          { title: 'Write `~/dashboards/shop.yml`: a RED dashboard with panels for requests per second (by route), error ratio (unit `percent`) and p99 latency by route (unit `s`). The Observe panel draws it', solution: 'nano ~/dashboards/shop.yml', test: [{ cmd: 'nano ~/dashboards/shop.yml', edit: ['title: Shop (RED)', 'panels:', '  - title: Requests per second', '    expr: sum by (route) (rate(http_requests_total{job="shop"}[5m]))', '  - title: Error ratio', '    expr: sum(rate(http_requests_total{job="shop",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="shop"}[5m]))', '    unit: percent', '  - title: p99 latency', '    expr: histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket{job="shop"}[5m])))', '    unit: s', ''].join('\n') }], check: t => { let d; try { d = parseYaml(t.file('laptop', '~/dashboards/shop.yml') || ''); } catch { return false; } const ps = d?.panels || []; const ok = re => ps.some(p => re.test(String(p.expr || '')) && t.promq(String(p.expr))?.samples?.length); return ok(/rate\(\s*http_requests_total/) && ok(/5\.\./) && ok(/histogram_quantile/) && ps.some(p => p.unit === 'percent') && ps.some(p => p.unit === 's'); } },
          { title: 'Write `~/dashboards/nodes.yml`: a USE dashboard with CPU utilisation, memory used (%), and free disk on `/` per instance', solution: 'nano ~/dashboards/nodes.yml', test: [{ cmd: 'nano ~/dashboards/nodes.yml', edit: ['title: Web servers (USE)', 'panels:', '  - title: CPU busy', '    expr: 1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))', '    unit: percent', '  - title: Memory used', '    expr: 1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes', '    unit: percent', '  - title: Free disk on /', '    expr: node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}', '    unit: percent', ''].join('\n') }], check: t => { let d; try { d = parseYaml(t.file('laptop', '~/dashboards/nodes.yml') || ''); } catch { return false; } const ps = d?.panels || []; const ok = re => ps.some(p => re.test(String(p.expr || '')) && t.promq(String(p.expr))?.samples?.length); return ok(/node_cpu_seconds_total/) && ok(/node_memory_MemAvailable_bytes/) && ok(/node_filesystem_avail_bytes/); } },
          { title: 'The disk panel shows one server filling up. Use `predict_linear` to estimate how many bytes will be free on each instance in 4 hours', solution: "promtool query instant http://mon:9090 'predict_linear(node_filesystem_avail_bytes{mountpoint=\"/\"}[1h], 4*3600)'", check: t => promqlOk(t, /predict_linear\(/, e => e.results.some(r => r.labels.instance === 'web2:9100' && r.v < 0)) },
          { title: 'Record your finding: write the instance that will run out of disk into `~/capacity.txt`', solution: 'echo web2 > ~/capacity.txt', check: t => fileHas(t, '~/capacity.txt', /web2/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'RED stands for…', choices: ['Read, Execute, Delete', 'Rate, Errors, Duration', 'Requests, Events, Dashboards', 'Reliability, Efficiency, Delivery'], answer: 1, explain: 'For request-driven services.' },
        { type: 'mc', q: 'USE is for…', choices: ['User journeys', 'Resources like CPU, memory and disks: Utilization, Saturation, Errors', 'Unit tests', 'Uptime'], answer: 1, explain: 'Brendan Gregg\'s method.' },
        { type: 'multi', q: 'Signs of a good on-call dashboard:', choices: ['Answers "is it healthy?" at a glance', 'Units on every panel', 'Percentiles for latency', '40 panels so nothing is missed'], answer: [0, 1, 2], explain: 'Less is more.' },
        { type: 'mc', q: 'What does predict_linear(x[1h], 4*3600) estimate?', choices: ['The average of x', 'The value of x four hours from now, extrapolating the last hour\'s trend', 'The max of x', 'The rate of x'], answer: 1, explain: 'Great for "disk full in N hours" alerts.' },
        { type: 'tf', q: 'Dashboards replace alerting.', answer: false, explain: 'Nobody watches a screen at 3 a.m.' },
      ],
    },
    {
      id: 'alerting',
      title: 'Alerting with Prometheus and Alertmanager',
      summary: 'Alerting rules with for, labels and annotations; Alertmanager routing, grouping and silences; symptoms over causes.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['observe', 'files'],
        setup(H) {
          shopWorld(H, { am: true, history: 900, promCfg: PROM_CFG({ am: true }) });
          // the incident starts once an alert rule and chat routing exist, and ends 15 minutes later
          const U = H.uni;
          U.tickers.push(() => {
            if (U.labData.incident) return;
            const p = U.obs.proms.find(x => x.running);
            const am = U.obs.ams[0];
            if (!(p?.rules || []).some(g => (g.rules || []).some(r => r.alert)) || !am?.cfg?.receivers?.some(r => (r.webhook_configs || []).length)) return;
            U.labData.incident = true;
            const pr = U.obs.profiles.find(x => x.host === 'web1');
            Object.assign(pr.routes['/checkout'], { err: 0.6, errMsg: 'payment provider unavailable' }); pr.routes['/'].err = 0.08;
            U.labData.say?.('📉 Something just went wrong with checkout. Keep an eye on the alerts (sleep a few minutes and check).');
            H.later(900, () => { pr.routes['/checkout'].err = 0.004; pr.routes['/'].err = 0.001; U.labData.say?.('🔧 The payments team fixed their side. Watch the alert resolve.'); });
          });
        },
        events(ev, t) { t.uni.labData.say = t.say; },
        suggestions: ['ssh ubuntu@mon', 'cat /etc/prometheus/prometheus.yml'],
        tasks: [
          { title: 'On mon, write `/etc/prometheus/rules.yml` with an alert `ShopHighErrorRate`: shop 5xx ratio above 5% for 5 minutes, label `severity: page`, a summary with the value and a runbook link. Add it to `rule_files`, check and reload', solution: 'ssh ubuntu@mon', test: ['ssh ubuntu@mon', { cmd: 'sudo nano /etc/prometheus/rules.yml', edit: ERR_RULE }, 'sudo sed -i "s/^scrape_configs:/rule_files:\\n  - rules.yml\\n\\nscrape_configs:/" /etc/prometheus/prometheus.yml', 'promtool check rules /etc/prometheus/rules.yml && promtool check config /etc/prometheus/prometheus.yml && sudo systemctl reload prometheus'], check: t => { const r = ruleNamed(t, 'ShopHighErrorRate'); return !!r && !!r.for && r.labels?.severity === 'page' && !!r.annotations?.summary && !!r.annotations?.runbook; } },
          { title: 'Route alerts in `/etc/alertmanager/alertmanager.yml`: everything to `team-chat` (webhook http://chat.lumen.dev/hooks/team), and `severity="page"` to `oncall` (http://chat.lumen.dev/hooks/oncall). Check and reload', solution: 'sudo nano /etc/alertmanager/alertmanager.yml && amtool check-config /etc/alertmanager/alertmanager.yml && sudo systemctl reload prometheus-alertmanager', test: [{ cmd: 'sudo nano /etc/alertmanager/alertmanager.yml', edit: AM_CHAT }, 'amtool check-config /etc/alertmanager/alertmanager.yml && sudo systemctl reload prometheus-alertmanager'], check: t => { const am = t.uni.obs?.ams[0]; return !!am && am.route({ severity: 'page', alertname: 'x' }).receiver === 'oncall' && (am.cfg.receivers || []).some(r => r.name === 'oncall' && (r.webhook_configs || []).some(w => /hooks\/oncall/.test(w.url))); } },
          { title: 'An incident has started. Watch the alert go from pending to firing (`sleep`, then check the alerts API) until the page reaches #oncall', solution: "sleep 240; curl -s localhost:9090/api/v1/alerts; sleep 240; amtool alert query", test: ['sleep 300', 'curl -s localhost:9090/api/v1/alerts', 'sleep 240', 'amtool alert query'], check: t => chatHas(t, 'oncall', 'firing', 'ShopHighErrorRate') },
          { title: 'The payments team is on it. Wait for the fix and see the alert resolve in chat', solution: 'sleep 600; amtool alert query', test: ['sleep 900', 'amtool alert query'], check: t => chatHas(t, 'oncall', 'resolved', 'ShopHighErrorRate') },
          { title: 'Payments maintenance is planned tonight. Silence `ShopHighErrorRate` for 2 hours with a meaningful comment', solution: 'amtool silence add alertname=ShopHighErrorRate --duration=2h --comment="payments maintenance window, ticket OPS-412"', check: t => t.events('amtool-silence').some(e => e.matchers.some(m => m.name === 'alertname' && m.value === 'ShopHighErrorRate') && e.duration >= 3600 && e.comment.length >= 10) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does `for: 5m` do in an alerting rule?', choices: ['Checks every 5 minutes', 'The condition must hold for 5 minutes before the alert fires (pending → firing)', 'Silences for 5 minutes', 'Repeats every 5 minutes'], answer: 1, explain: 'Filters blips.' },
        { type: 'mc', q: 'Twenty web servers lose their disk at once. With group_by: [alertname], how many notifications?', choices: ['20', '1 grouped notification', '0', '40'], answer: 1, explain: 'Grouping cuts noise.' },
        { type: 'multi', q: 'Good page-worthy alerts:', choices: ['Error ratio above SLO for 5m', 'p99 latency above target for 10m', 'CPU above 70% for 1 minute', 'Disk predicted full within 4 hours'], answer: [0, 1, 3], explain: 'CPU is a cause; page on symptoms and imminent failures.' },
        { type: 'mc', q: 'What belongs in annotations?', choices: ['Routing labels', 'Human context: summary, description, runbook link', 'PromQL', 'Receivers'], answer: 1, explain: 'Labels route; annotations explain.' },
        { type: 'tf', q: 'A silence should have a comment and an end time.', answer: true, explain: 'Otherwise nobody knows why the alert is quiet.' },
        { type: 'mc', q: 'Who decides which receiver gets an alert?', choices: ['Prometheus', 'Alertmanager\'s route tree, using the alert\'s labels', 'Grafana', 'The app'], answer: 1, explain: 'Prometheus only evaluates and sends.' },
      ],
    },
    {
      id: 'logs',
      title: 'Structured logs and LogQL',
      summary: 'Structured JSON logs, labels vs fields, centralised search, LogQL filters, json parsing and log-based metrics.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['observe', 'files'],
        setup(H) { shopWorld(H, { history: 600, routes: ROUTES({ err: 0.25, errMsg: 'payment provider timeout after 2000ms', errStatus: 502, p99: 2.4, slowFrac: 0.1 }) }); },
        suggestions: ["logcli query '{app=\"shop\", level=\"error\"}' --limit=10"],
        tasks: [
          { title: 'Show the latest error log lines from the shop', solution: "logcli query '{app=\"shop\", level=\"error\"}' --limit=10", check: t => logqlOk(t, /level\s*=\s*"error"|\|=\s*"error"/, e => e.results > 0) },
          { title: 'Count errors by route over the last 10 minutes. Which route fails most?', solution: "logcli query 'sum by (route) (count_over_time({app=\"shop\", level=\"error\"} | json [10m]))'", check: t => logqlOk(t, /count_over_time|rate\(/, e => e.kind === 'metric' && /route/.test(e.query)) },
          { title: 'Group the checkout errors by message: what is going wrong?', solution: "logcli query 'sum by (msg) (count_over_time({app=\"shop\", level=\"error\"} | json | route=\"/checkout\" [10m]))'", check: t => logqlOk(t, /msg/, e => e.kind === 'metric' && e.results > 0) },
          { title: 'Find checkout requests slower than 2 seconds and note one `trace_id`', solution: "logcli query '{app=\"shop\"} | json | route=\"/checkout\" | duration_ms > 2000' --limit=3", check: t => logqlOk(t, /duration_ms\s*>/, e => e.kind === 'logs' && e.results > 0) },
          { title: 'Write the main error message into `~/incident.txt` for the incident channel', solution: "echo 'payment provider timeout after 2000ms' > ~/incident.txt", check: t => fileHas(t, '~/incident.txt', /payment provider timeout/i) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why structured (JSON) logs?', choices: ['They are smaller', 'Fields can be filtered and aggregated reliably instead of regex-parsing text', 'They are encrypted', 'Required by Linux'], answer: 1, explain: '| json | status >= 500.' },
        { type: 'mc', q: 'user_id as a Loki label is…', choices: ['Ideal', 'A cardinality problem: one stream per user; keep it as a field', 'Required', 'Faster'], answer: 1, explain: 'Few, low-cardinality labels.' },
        { type: 'mc', q: 'What does `{app="shop"} |= "timeout"` return?', choices: ['A count', 'Shop log lines containing "timeout"', 'Metrics', 'Traces'], answer: 1, explain: 'Line filter.' },
        { type: 'multi', q: 'Never put in logs:', choices: ['Passwords and tokens', 'Full card numbers', 'trace_id', 'Personal data you do not need'], answer: [0, 1, 3], explain: 'trace_id is exactly what you want.' },
        { type: 'tf', q: 'count_over_time turns log lines into a metric you can graph or alert on.', answer: true, explain: 'Log-based metrics.' },
      ],
    },
    {
      id: 'traces',
      title: 'Distributed tracing',
      summary: 'Traces, spans and context propagation; reading waterfalls; finding the slow hop; linking logs and traces.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['observe', 'files'],
        setup(H) { shopWorld(H, { history: 600, routes: ROUTES({ p50: 0.9, p99: 3.4, slowSpan: 'bank-api', slowFrac: 0.3, err: 0.02, errMsg: 'bank api timeout', errStatus: 504 }) }); },
        suggestions: ['traces search --service shop --route /checkout --min-duration 1s'],
        tasks: [
          { title: 'Checkout p99 is over 3 seconds. Search for checkout traces slower than 1 second', solution: 'traces search --service shop --route /checkout --min-duration 1s --limit 5', check: t => t.events('traces').some(e => e.sub === 'search' && e.minDur >= 1 && e.results > 0) },
          { title: 'Open one of them and read the waterfall: which service is the time spent in?', solution: 'traces show $(traces search --service shop --route /checkout --min-duration 1s --limit 1 | tail -1 | cut -d" " -f1)', check: t => t.events('traces').some(e => e.sub === 'show') },
          { title: 'Start from the logs instead: find a slow checkout log line, take its `trace_id`, and open that trace', solution: "logcli query '{app=\"shop\"} | json | route=\"/checkout\" | duration_ms > 2000' --limit=1", test: [(t) => { const line = t.obs().logs.slice().reverse().find(l => /"route":"\/checkout"/.test(l.line) && JSON.parse(l.line).duration_ms > 2000 && t.obs().traces.some(x => x.id === JSON.parse(l.line).trace_id)); return `logcli query '{app="shop"} | json | route="/checkout" | duration_ms > 2000' --limit=1 && traces show ${JSON.parse(line.line).trace_id}`; }], check: t => logqlOk(t, /duration_ms/) && t.after(e => e.type === 'logql' && /duration_ms/.test(e.query), e => e.type === 'traces' && e.sub === 'show') },
          { title: 'Look at the failing ones too: search error traces and open one', solution: 'traces search --service shop --status error --limit 3', test: ['traces search --service shop --status error --limit 3', (t) => `traces show ${t.obs().traces.slice().reverse().find(x => x.status === 'error').id}`], check: t => t.events('traces').some(e => e.sub === 'search' && e.status === 'error' && e.results > 0) },
          { title: 'Write the service responsible for the slowness into `~/culprit.txt`', solution: 'echo bank-api > ~/culprit.txt', check: t => fileHas(t, '~/culprit.txt', /bank-api/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What links spans from different services into one trace?', choices: ['The hostname', 'A trace ID propagated in request headers (traceparent)', 'The timestamp', 'The log level'], answer: 1, explain: 'Context propagation.' },
        { type: 'mc', q: 'In a waterfall, where do you look for the cause of a slow request?', choices: ['The first span', 'The longest span on the critical path, as deep as it goes', 'The last span', 'Any span with attributes'], answer: 1, explain: 'Follow the widest bar down.' },
        { type: 'mc', q: 'OpenTelemetry is…', choices: ['A tracing database', 'A vendor-neutral standard and SDKs for producing traces, metrics and logs', 'A dashboard', 'A Prometheus exporter only'], answer: 1, explain: 'Backends: Jaeger, Tempo, vendors.' },
        { type: 'multi', q: 'Sensible trace sampling keeps:', choices: ['All errors', 'All slow requests', 'A fraction of normal requests', 'Nothing in production'], answer: [0, 1, 2], explain: 'Tail-based sampling keeps the interesting ones.' },
        { type: 'tf', q: 'Putting the trace_id in every log line lets you jump from a log to the full request picture.', answer: true, explain: 'Correlation is the point.' },
      ],
    },
    {
      id: 'slos',
      title: 'SLOs and error budgets',
      summary: 'SLIs from real requests, SLOs over a window, error budgets, recording rules, burn rate and multi-window alerts, budget policy.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['observe', 'files'],
        setup(H) {
          shopWorld(H, { am: false, history: 1800, routes: ROUTES({ err: 0.003 }) });
          const U = H.uni;
          U.tickers.push(() => {
            if (U.labData.burn) return;
            const p = U.obs.proms.find(x => x.running);
            if (!(p?.rules || []).some(g => (g.rules || []).some(r => r.alert === 'CheckoutBudgetBurn'))) return;
            U.labData.burn = true;
            U.obs.profiles.find(x => x.host === 'web1').routes['/checkout'].err = 0.12;
            U.labData.say?.('🚀 A risky release just went out (checkout v2.3). Watch the burn rate.');
          });
        },
        events(ev, t) { t.uni.labData.say = t.say; },
        suggestions: ['ssh ubuntu@mon'],
        tasks: [
          { title: 'Our checkout SLO: 99.5% of checkout requests succeed. On mon, add a recording rule `sli:checkout_errors:ratio_rate5m` (5xx ratio of /checkout over 5m) in `/etc/prometheus/rules.yml`, include it in the config and reload', solution: 'ssh ubuntu@mon', test: ['ssh ubuntu@mon', { cmd: 'sudo nano /etc/prometheus/rules.yml', edit: ['groups:', '  - name: slo', '    rules:', '      - record: sli:checkout_errors:ratio_rate5m', '        expr: sum(rate(http_requests_total{route="/checkout",status=~"5.."}[5m])) / sum(rate(http_requests_total{route="/checkout"}[5m]))', ''].join('\n') }, 'sudo sed -i "s/^scrape_configs:/rule_files:\\n  - rules.yml\\n\\nscrape_configs:/" /etc/prometheus/prometheus.yml', 'promtool check config /etc/prometheus/prometheus.yml && sudo systemctl reload prometheus', 'sleep 60', 'exit'], check: t => !!ruleNamed(t, 'sli:checkout_errors:ratio_rate5m') && (t.promq('sli:checkout_errors:ratio_rate5m')?.samples.length || 0) > 0 },
          { title: 'What is the current burn rate? (the error ratio divided by the error budget, 1 - 0.995)', solution: "promtool query instant http://mon:9090 'sli:checkout_errors:ratio_rate5m / (1 - 0.995)'", check: t => promqlOk(t, /sli:checkout_errors:ratio_rate5m\s*\/\s*\(\s*1\s*-\s*0\.995\s*\)|\/\s*0\.005/, e => e.results.length === 1 && e.results[0].v < 2) },
          { title: 'Add a page-worthy alert `CheckoutBudgetBurn`: burn rate above 14.4 for 2 minutes, `severity: page`. Reload', solution: 'ssh ubuntu@mon', test: ['ssh ubuntu@mon', { cmd: 'sudo nano /etc/prometheus/rules.yml', edit: ['groups:', '  - name: slo', '    rules:', '      - record: sli:checkout_errors:ratio_rate5m', '        expr: sum(rate(http_requests_total{route="/checkout",status=~"5.."}[5m])) / sum(rate(http_requests_total{route="/checkout"}[5m]))', '      - alert: CheckoutBudgetBurn', '        expr: sli:checkout_errors:ratio_rate5m / (1 - 0.995) > 14.4', '        for: 2m', '        labels:', '          severity: page', '        annotations:', '          summary: "Checkout is burning its error budget {{ $value }}x too fast"', ''].join('\n') }, 'promtool check rules /etc/prometheus/rules.yml && sudo systemctl reload prometheus', 'exit'], check: t => { const r = ruleNamed(t, 'CheckoutBudgetBurn'); return !!r && /14\.4/.test(String(r.expr)) && r.labels?.severity === 'page'; } },
          { title: 'A risky release just went out. Wait and confirm `CheckoutBudgetBurn` fires', solution: "sleep 420; promtool query instant http://mon:9090 'ALERTS{alertname=\"CheckoutBudgetBurn\"}'; curl -s mon:9090/api/v1/alerts", test: ['sleep 480', 'curl -s mon:9090/api/v1/alerts'], check: t => t.firing('CheckoutBudgetBurn').length > 0 },
          { title: 'How much of the last hour\'s error budget is left? Query it, and if it is gone, write `freeze` into `~/decision.txt` (no more risky releases this week)', solution: "promtool query instant http://mon:9090 '1 - (sum(increase(http_requests_total{route=\"/checkout\",status=~\"5..\"}[1h])) / sum(increase(http_requests_total{route=\"/checkout\"}[1h]))) / (1 - 0.995)' ; echo freeze > ~/decision.txt", check: t => promqlOk(t, /increase\(/, e => e.results.length === 1 && e.results[0].v < 0) && fileHas(t, '~/decision.txt', /freeze/i) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'SLO 99.5% over 30 days. The error budget is…', choices: ['99.5%', '0.5% of requests may fail in that window', '30 days', '5 errors'], answer: 1, explain: '1 - SLO.' },
        { type: 'mc', q: 'Burn rate 1 means…', choices: ['No errors', 'Spending the budget exactly as fast as the window allows', 'The budget is gone', 'One error per second'], answer: 1, explain: '>1 runs out early.' },
        { type: 'mc', q: 'Why burn-rate alerts instead of "error ratio > X"?', choices: ['They are prettier', 'They page on how fast you are losing reliability users feel, scaled to the SLO', 'They never fire', 'They need no PromQL'], answer: 1, explain: 'Fast burns page; slow burns ticket.' },
        { type: 'multi', q: 'A good SLI is…', choices: ['Measured on real user requests', 'A ratio of good to total events', 'A ping to a health endpoint', 'Tied to a user journey like checkout'], answer: [0, 1, 3], explain: 'Health pings miss real failures.' },
        { type: 'tf', q: 'A 100% SLO is a good goal.', answer: false, explain: 'Impossible, and it forbids change.' },
        { type: 'mc', q: 'What is a recording rule for?', choices: ['Recording audio', 'Precomputing an expression into a new series so dashboards and alerts are cheap and consistent', 'Logging alerts', 'Backups'], answer: 1, explain: 'level:metric:operations naming.' },
      ],
    },
    {
      id: 'observability-boss',
      title: 'Boss: Incident commander',
      summary: 'Wire the page, quantify impact with metrics, find the cause with logs and traces, mitigate and watch the alert resolve.',
      minutes: 45,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['observe', 'files'],
        setup(H) {
          const bad = { err: 0.35, errMsg: 'payment provider timeout after 200ms', errStatus: 502, slowSpan: null };
          shopWorld(H, { webs: ['web1', 'web2'], am: true, history: 0, promCfg: PROM_CFG({ webs: ['web1', 'web2'], rules: true, am: true }), rules: ['groups:', '  - name: shop', '    rules:', '      - alert: CheckoutErrors', '        expr: sum(rate(http_requests_total{route="/checkout",status=~"5.."}[5m])) / sum(rate(http_requests_total{route="/checkout"}[5m])) > 0.05', '        for: 3m', '        labels:', '          severity: page', '        annotations:', '          summary: "Checkout error ratio {{ $value | humanizePercentage }}"', '          runbook: https://wiki.lumen.dev/runbooks/checkout', ''].join('\n') });
          H.uni.advance(1200);
          for (const w of ['web1', 'web2']) { H.write(w, '/etc/shop/shop.env', 'PORT=3000\nPAYMENTS_TIMEOUT_MS=200\nLOG_FORMAT=json\n'); Object.assign(profile(H, w).routes['/checkout'], bad); }
          H.uni.advance(900);
        },
        events(ev, t) {
          if (ev.type !== 'proc-start' || ev.unit !== 'shop.service') return;
          const env = t.file(ev.host, '/etc/shop/shop.env') || '';
          const m = env.match(/PAYMENTS_TIMEOUT_MS=(\d+)/);
          if (m && Number(m[1]) >= 1000) { const pr = t.obs().profiles.find(p => p.host === ev.host); Object.assign(pr.routes['/checkout'], { err: 0.004, errMsg: 'payment declined', errStatus: 500 }); t.uni.labData.fixed = { ...(t.uni.labData.fixed || {}), [ev.host]: true }; }
        },
        suggestions: ['ssh ubuntu@mon', "curl -s mon:9090/api/v1/alerts"],
        tasks: [
          { title: 'The alert is firing but goes nowhere. Route Alertmanager on mon: everything to `team-chat`, `severity="page"` to `oncall` (webhooks on chat.lumen.dev/hooks/…). Reload and get the page into #oncall', solution: 'ssh ubuntu@mon', test: ['ssh ubuntu@mon', { cmd: 'sudo nano /etc/alertmanager/alertmanager.yml', edit: AM_CHAT }, 'sudo systemctl reload prometheus-alertmanager', 'sleep 60', 'exit'], check: t => chatHas(t, 'oncall', 'firing', 'CheckoutErrors') },
          { title: 'Quantify the impact: the checkout error ratio per server', solution: "promtool query instant http://mon:9090 'sum by (instance) (rate(http_requests_total{route=\"/checkout\",status=~\"5..\"}[5m])) / sum by (instance) (rate(http_requests_total{route=\"/checkout\"}[5m]))'", check: t => promqlOk(t, /instance/, e => e.results.length === 2 && e.results.every(r => r.v > 0.1)) },
          { title: 'Find what the errors say in the logs', solution: "logcli query 'sum by (msg) (count_over_time({app=\"shop\", level=\"error\"} | json [10m]))'", check: t => logqlOk(t, /error/, e => e.results > 0) },
          { title: 'Confirm with an error trace which hop fails', solution: 'traces search --service shop --route /checkout --status error --limit 3', test: ['traces search --service shop --route /checkout --status error --limit 3', (t) => `traces show ${t.obs().traces.slice().reverse().find(x => x.status === 'error' && x.route === '/checkout').id}`], check: t => t.events('traces').some(e => e.sub === 'show') && t.events('traces').some(e => e.sub === 'search' && e.status === 'error') },
          { title: 'Mitigate: an hour ago someone set `PAYMENTS_TIMEOUT_MS=200` in `/etc/shop/shop.env` on both web servers. Put it back to 3000 and restart the shop on each', solution: 'for h in web1 web2; do ssh ubuntu@$h "sudo sed -i s/PAYMENTS_TIMEOUT_MS=200/PAYMENTS_TIMEOUT_MS=3000/ /etc/shop/shop.env && sudo systemctl restart shop"; done', check: t => ['web1', 'web2'].every(h => /PAYMENTS_TIMEOUT_MS=3000/.test(t.file(h, '/etc/shop/shop.env') || '') && t.uni.labData.fixed?.[h]) },
          { title: 'Prove users are fine again: the error ratio is back under 1% and the alert resolves in #oncall', solution: "sleep 600; promtool query instant http://mon:9090 'sum(rate(http_requests_total{route=\"/checkout\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{route=\"/checkout\"}[5m]))'", test: ['sleep 900', "promtool query instant http://mon:9090 'sum(rate(http_requests_total{route=\"/checkout\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{route=\"/checkout\"}[5m]))'"], check: t => chatHas(t, 'oncall', 'resolved', 'CheckoutErrors') && promqlOk(t, /checkout/, e => e.results.length === 1 && e.results[0].v < 0.01) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the incident investigation.', items: ['Alert fires on a symptom', 'Metrics: which route and servers, how bad', 'Logs: what the errors say', 'Traces: which hop fails', 'Mitigate, then verify with the same metrics'], explain: 'Wide to narrow, then confirm.' },
        { type: 'mc', q: 'What should you do first when the cause is a recent config change?', choices: ['Debug the code in production', 'Mitigate: roll back the change, then investigate', 'Wait for it to recover', 'Restart every server'], answer: 1, explain: 'Restore service first.' },
        { type: 'mc', q: 'How do you know the mitigation worked?', choices: ['The chat went quiet', 'The same SLI that alerted is back within target and the alert resolved', 'You restarted the service', 'Nobody complains'], answer: 1, explain: 'Verify with data.' },
        { type: 'multi', q: 'Which made this incident short?', choices: ['A symptom-based alert with a runbook', 'Consistent labels across metrics, logs and traces', 'trace_id in logs', 'SSH-ing to every server first'], answer: [0, 1, 2], explain: 'Signals beat guessing.' },
        { type: 'tf', q: 'The alert resolving means the incident is over and no follow-up is needed.', answer: false, explain: 'Next: a blameless review and fixes so it cannot recur (Reliability realm).' },
      ],
    },
  ],
};
