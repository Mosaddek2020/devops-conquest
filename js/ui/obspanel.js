// The Observe panel: a small Grafana. It draws the dashboards in ~/dashboards/*.yml
// (panels with a PromQL `expr`) from the lab's Prometheus, and shows targets, alerts and
// the notifications that reached the team chat.

import { h, clear, svg } from './dom.js';
import { registerPanel } from './panelRegistry.js';
import { parseYaml } from '../git/yaml.js';
import { evalPromQL, seriesName, formatValue } from '../sim/promql.js';

const COLORS = ['var(--info)', 'var(--warn)', 'var(--ok)', 'var(--bad)', 'var(--accent)'];

function chart(prom, expr, now, { minutes = 30, unit = '' } = {}) {
  const step = Math.max(15, Math.round(minutes * 60 / 60));
  const series = new Map();
  let err = null;
  for (let t = now - minutes * 60; t <= now; t += step) {
    let r;
    try { r = evalPromQL(prom.tsdb, expr, t); } catch (e) { err = e.message; break; }
    const samples = r.type === 'scalar' ? [{ labels: {}, v: r.v }] : r.samples;
    for (const s of samples) { const k = seriesName(s.labels) || expr; if (!series.has(k)) series.set(k, { labels: s.labels, pts: [] }); series.get(k).pts.push([t, s.v]); }
  }
  if (err) return h('div', { class: 'obs-err mono' }, err);
  // legend: only the labels that differ between the series shown
  const all = [...series.values()].slice(0, 5);
  const keys = [...new Set(all.flatMap(x => Object.keys(x.labels)))].filter(k => k !== '__name__' && new Set(all.map(x => x.labels[k])).size > 1);
  const list = all.map(x => [keys.length ? keys.map(k => `${k}=${x.labels[k] ?? ''}`).join(' ') : (seriesName(x.labels) || expr), x.pts]);
  if (!list.length) return h('div', { class: 'gh-empty' }, 'No data (yet). Prometheus needs a few scrapes; try `sleep 120`.');
  const W = 320, H = 110, P = 4;
  const vals = list.flatMap(([, pts]) => pts.map(p => p[1])).filter(Number.isFinite);
  const max = Math.max(...vals, 0) * 1.1 || 1, min = Math.min(0, ...vals);
  const x = t => P + (t - (now - minutes * 60)) / (minutes * 60) * (W - 2 * P);
  const y = v => H - P - (v - min) / (max - min) * (H - 2 * P);
  const fmt = v => unit === 'percent' ? `${(v * 100).toFixed(1)}%` : unit === 's' ? (v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`) : unit === 'bytes' ? `${(v / 1048576).toFixed(0)}MiB` : formatValue(Number(v.toFixed(3)));
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'obs-chart', role: 'img', 'aria-label': `chart of ${expr}` });
  g.append(svg('line', { x1: P, x2: W - P, y1: y(min), y2: y(min), stroke: 'var(--line)', 'stroke-width': 1 }));
  g.append(svg('line', { x1: P, x2: W - P, y1: y(max / 1.1), y2: y(max / 1.1), stroke: 'var(--line)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
  g.append(svg('text', { x: W - P, y: y(max / 1.1) - 3, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--muted)', 'font-family': 'var(--font-mono)', text: fmt(max / 1.1) }));
  list.forEach(([, pts], i) => g.append(svg('polyline', { points: pts.filter(p => Number.isFinite(p[1])).map(p => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' '), fill: 'none', stroke: COLORS[i % COLORS.length], 'stroke-width': 2, 'stroke-linejoin': 'round' })));
  return h('div', {}, g, h('ul', { class: 'obs-legend' }, list.map(([k, pts], i) => h('li', {}, h('i', { style: { background: COLORS[i % COLORS.length] } }), h('span', { class: 'mono' }, k.length > 48 ? k.slice(0, 48) + '…' : k), h('strong', { class: 'mono' }, fmt(pts[pts.length - 1]?.[1] ?? NaN))))));
}

export class ObserveView {
  constructor() { this.el = h('div', { class: 'sys obsv' }); this.pick = null; }
  render(sh, uni) {
    clear(this.el);
    const prom = uni.obs?.proms.find(p => p.running);
    const laptop = uni.host('laptop');
    const dashFiles = laptop ? [...laptop.files.keys()].filter(p => /\/dashboards\/[^/]+\.ya?ml$/.test(p)).sort() : [];
    this.el.append(h('div', { class: 'sys-head' }, h('div', {}, h('div', { class: 'sys-name' }, 'Observe'), h('div', { class: 'meta' }, prom ? `Prometheus on ${prom.host.name} · ${prom.tsdb.series.size} series` : 'Prometheus is not running yet')),
      dashFiles.length > 1 ? h('select', { class: 'gh-select', 'aria-label': 'Dashboard', onchange: e => { this.pick = e.target.value; this.render(sh, uni); } }, dashFiles.map(f => h('option', { value: f, selected: f === this.pick }, f.split('/').pop()))) : null));
    if (prom) {
      const targets = prom.targets();
      this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `Targets (${targets.filter(t => t.health === 'up').length}/${targets.length} up)`), h('div', { class: 'dock-tags' }, targets.map(t => h('span', { class: 'pill ' + (t.health === 'up' ? 'pill-ok' : t.health === 'down' ? 'pill-bad' : ''), title: t.lastError }, `${t.labels.job} ${t.labels.instance} ${t.health}`)))));
      const file = this.pick && dashFiles.includes(this.pick) ? this.pick : dashFiles[0];
      if (file) {
        let dash;
        try { dash = parseYaml(laptop.files.get(file)); } catch (e) { this.el.append(h('div', { class: 'obs-err' }, `${file.split('/').pop()}: ${e.message}`)); }
        if (dash) {
          this.el.append(h('h5', { class: 'obs-dash-title' }, dash.title || file.split('/').pop()));
          this.el.append(h('div', { class: 'obs-grid' }, (dash.panels || []).map(p => h('section', { class: 'obs-panel' }, h('div', { class: 'obs-ptitle' }, p.title || p.expr), p.expr ? chart(prom, String(p.expr), uni.time, { minutes: Number(p.minutes) || 30, unit: p.unit }) : h('div', { class: 'gh-empty' }, 'panel has no expr')))));
        }
      } else this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Requests per second (all jobs)'), chart(prom, 'sum by (job) (rate(http_requests_total[5m]))', uni.time, {})));
      const alerts = [...prom.alerts.values()];
      if (alerts.length || prom.rules?.length) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Alerts'), alerts.length ? h('ul', { class: 'gh-list' }, alerts.map(a => h('li', {}, h('div', { class: 'row' }, h('span', {}, h('i', { class: 'dot dot-' + (a.state === 'firing' ? 'bad' : 'warn'), 'aria-hidden': 'true' }), h('strong', {}, a.labels.alertname), h('span', { class: 'meta' }, ` ${a.labels.severity || ''}`)), h('span', { class: 'pill ' + (a.state === 'firing' ? 'pill-bad' : 'pill-warn') }, a.state)), a.annotations?.summary ? h('div', { class: 'meta' }, a.annotations.summary) : null))) : h('div', { class: 'gh-empty' }, 'No alerts pending or firing.')));
    }
    const chat = uni.obs?.chat || [];
    if (chat.length) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, '#oncall chat'), h('ul', { class: 'gh-list' }, chat.slice(-4).reverse().map(m => h('li', {}, h('div', { class: 'row' }, h('strong', {}, `${m.payload.status === 'resolved' ? '✅ RESOLVED' : '🔥 FIRING'}: ${(m.payload.alerts || []).map(a => a.labels?.alertname).join(', ')}`), h('span', { class: 'meta' }, `#${m.channel}`)), h('div', { class: 'meta' }, (m.payload.alerts || [])[0]?.annotations?.summary || ''))))));
  }
}

registerPanel('observe', 'Observe', () => new ObserveView());
