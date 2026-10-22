// Lab helpers and checks for the Observability realm.

import { registerLabExtension } from '../labext.js';
import { Obs } from './obs.js';
import { evalPromQL } from './promql.js';

registerLabExtension({
  helpers: (uni, sh, H) => ({
    observe() { return uni.obs || new Obs(uni); },
    // synthetic users hitting an app: routes = { '/checkout': { rps, p50, p99, err } }
    traffic(host, port, service, routes) { const o = uni.obs || new Obs(uni); return o.addProfile({ host, port, service, routes }); },
    // run fn once the clock passes `seconds` from now (an incident starting mid-lab)
    later(seconds, fn) { const at = uni.time + seconds; let done = false; uni.tickers.push(() => { if (!done && uni.time >= at) { done = true; fn(); } }); },
  }),
  checks: (uni, sh, api) => ({
    obs: () => uni.obs || null,
    prom: () => uni.obs?.proms.find(p => p.running) || null,
    promq: expr => { const p = uni.obs?.proms.find(x => x.running); if (!p) return null; try { return evalPromQL(p.tsdb, expr, uni.time); } catch { return null; } },
    firing: name => { const p = uni.obs?.proms.find(x => x.running); return p ? [...p.alerts.values()].filter(a => a.state === 'firing' && (!name || a.labels.alertname === name)) : []; },
    chat: () => uni.obs?.chat || [],
  }),
});
