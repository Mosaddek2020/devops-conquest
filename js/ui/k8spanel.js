// The Cluster panel: nodes with the pods running on them, deployments and their
// rollout state, services with their endpoints, ingress routes, autoscalers and the
// latest warnings. Rendered from the live simulated cluster.

import { h, clear } from './dom.js';
import { registerPanel } from './panelRegistry.js';
import { podStatusText, age } from '../sim/kubectl.js';

const tone = (cl, p) => {
  const s = podStatusText(cl, p);
  if (s === 'Terminating') return 'term';
  if (s === 'Running') return cl.podReady(p) ? 'ok' : 'warn';
  if (s === 'Completed') return 'done';
  if (s === 'Pending' || s === 'ContainerCreating') return 'wait';
  return 'bad';
};
const shortName = n => n.replace(/-([a-z0-9]{8,10})-([a-z0-9]{5})$/, (m, a, b) => `-${a.slice(0, 4)}…-${b}`);

export class ClusterView {
  constructor() { this.el = h('div', { class: 'sys k8s' }); this.ns = null; }
  render(sh, uni) {
    clear(this.el);
    const cl = [...(uni.clusters?.values() || [])][0];
    if (!cl) { this.el.append(h('div', { class: 'gh-empty' }, 'No Kubernetes cluster in this lab.')); return; }
    const namespaces = cl.list('Namespace').map(n => n.metadata.name).filter(n => !n.startsWith('kube-') && n !== 'ingress-nginx');
    if (this.ns === null) this.ns = namespaces.includes('default') && cl.list('Pod', 'default').length ? 'default' : namespaces.find(n => cl.list('Pod', n).length) || 'default';
    const ns = this.ns === '*' ? null : this.ns;
    this.el.append(h('div', { class: 'sys-head' },
      h('div', {}, h('div', { class: 'sys-name' }, `Cluster ${cl.name}`), h('div', { class: 'meta' }, `${cl.version} · ${cl.nodes.length} worker nodes`)),
      h('select', { class: 'gh-select', 'aria-label': 'Namespace', onchange: e => { this.ns = e.target.value; this.render(sh, uni); } },
        h('option', { value: '*', selected: this.ns === '*' }, 'all namespaces'), namespaces.map(n => h('option', { value: n, selected: n === this.ns }, `ns: ${n}`)))));

    // nodes and pods
    const pods = cl.list('Pod', ns);
    const pending = pods.filter(p => !cl.rt.get(p.metadata.uid)?.node);
    const chip = p => {
      const rt = cl.rt.get(p.metadata.uid);
      const restarts = (rt?.containers || []).reduce((s, c) => s + c.restartCount, 0);
      const st = podStatusText(cl, p);
      return h('li', { class: `k8s-pod k8s-${tone(cl, p)}`, title: `${p.metadata.namespace}/${p.metadata.name}: ${st}${rt?.ip ? ' · ' + rt.ip : ''}` },
        h('span', { class: 'mono k8s-pod-name' }, shortName(p.metadata.name)),
        h('span', { class: 'k8s-pod-st' }, st === 'Running' && !cl.podReady(p) ? 'not ready' : st, restarts ? ` ↻${restarts}` : ''));
    };
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `Nodes and pods (${pods.length})`),
      h('div', { class: 'k8s-nodes' }, cl.nodes.map(n => {
        const mine = pods.filter(p => cl.rt.get(p.metadata.uid)?.node === n);
        return h('div', { class: 'k8s-node' }, h('div', { class: 'k8s-node-head' }, h('strong', { class: 'mono' }, n.name.replace(`${cl.name}-`, '')), h('span', { class: 'meta mono' }, n.host.ip)),
          mine.length ? h('ul', { class: 'k8s-pods' }, mine.map(chip)) : h('div', { class: 'meta' }, 'no pods'));
      })),
      pending.length ? h('div', { class: 'k8s-pending' }, h('span', { class: 'meta' }, 'Not scheduled: '), h('ul', { class: 'k8s-pods' }, pending.map(chip))) : null));

    // deployments
    const deps = [...cl.list('Deployment', ns), ...cl.list('StatefulSet', ns)];
    if (deps.length) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Workloads'),
      h('ul', { class: 'gh-list' }, deps.map(d => {
        const want = d.spec.replicas, ready = d.status.readyReplicas || 0;
        const cond = d.status.conditions?.find(x => x.type === 'Progressing');
        const rolling = d.kind === 'Deployment' && cond?.reason === 'ReplicaSetUpdated';
        const stuck = cond?.reason === 'ProgressDeadlineExceeded';
        return h('li', {}, h('div', { class: 'row' },
          h('span', {}, h('i', { class: 'dot dot-' + (stuck ? 'bad' : ready >= want ? 'ok' : 'warn'), 'aria-hidden': 'true' }), h('strong', {}, d.metadata.name), h('span', { class: 'meta' }, ` ${d.kind === 'StatefulSet' ? 'statefulset' : 'rev ' + (d.metadata.annotations?.['deployment.kubernetes.io/revision'] || 1)}`)),
          h('span', { class: 'meta mono' }, `${ready}/${want} ready${rolling ? ' · rolling out' : ''}${stuck ? ' · STUCK' : ''}`)),
          h('div', { class: 'sys-track', role: 'meter', 'aria-label': `${d.metadata.name} ready replicas`, 'aria-valuenow': ready, 'aria-valuemin': 0, 'aria-valuemax': want }, h('span', { class: ready >= want ? 'ok' : stuck ? 'bad' : 'warn', style: { width: `${want ? Math.max(3, Math.min(100, ready / want * 100)) : 0}%` } })),
          h('div', { class: 'meta mono k8s-img' }, d.spec.template.spec.containers.map(c => c.image).join(', ')));
      }))));

    // services and ingress
    const svcs = cl.list('Service', ns).filter(s => !(s.metadata.name === 'kubernetes' && s.metadata.namespace === 'default'));
    if (svcs.length) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Services'),
      h('ul', { class: 'gh-list' }, svcs.map(s => {
        const eps = cl.endpoints(s).length;
        return h('li', {}, h('div', { class: 'row' },
          h('span', {}, h('strong', { class: 'mono' }, s.metadata.name), h('span', { class: 'pill', style: { marginLeft: '8px' } }, s.spec.type)),
          h('span', { class: 'meta mono' }, `${s.spec.clusterIP}:${s.spec.ports.map(p => p.port + (p.nodePort ? '→' + p.nodePort : '')).join(',')}`)),
          h('div', { class: 'dock-tags' }, h('span', { class: 'pill ' + (eps ? 'pill-ok' : 'pill-warn') }, eps ? `${eps} endpoint${eps > 1 ? 's' : ''}` : 'no endpoints'),
            h('span', { class: 'pill' }, `selector ${Object.entries(s.spec.selector || {}).map(([k, v]) => `${k}=${v}`).join(',') || 'none'}`),
            s.status.loadBalancer?.ingress ? h('span', { class: 'pill pill-accent' }, `external ${s.status.loadBalancer.ingress[0].ip}`) : null));
      }))));
    const ings = cl.list('Ingress', ns);
    if (ings.length) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Ingress routes'),
      h('ul', { class: 'gh-list' }, ings.flatMap(i => (i.spec.rules || []).flatMap(r => (r.http?.paths || []).map(p => h('li', {}, h('div', { class: 'row' }, h('span', { class: 'mono' }, `${r.host || '*'}${p.path || '/'}`), h('span', { class: 'meta mono' }, `→ ${p.backend.service.name}:${p.backend.service.port?.number ?? p.backend.service.port?.name}`)))))))));
    const hpas = cl.list('HorizontalPodAutoscaler', ns);
    if (hpas.length) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Autoscalers'),
      h('ul', { class: 'gh-list' }, hpas.map(x => h('li', {}, h('div', { class: 'row' }, h('strong', {}, x.metadata.name), h('span', { class: 'meta mono' }, `cpu ${x.status.currentUtilization ?? '?'}% / ${x.spec.metrics?.[0]?.resource?.target?.averageUtilization ?? 80}% · ${x.status.currentReplicas ?? 0} pods (${x.spec.minReplicas || 1}–${x.spec.maxReplicas})`)))))));

    // warnings
    const warns = cl.events.filter(e => e.type === 'Warning' && (!ns || e.ns === ns)).slice(-4).reverse();
    if (warns.length) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Latest warnings'),
      h('ul', { class: 'gh-list' }, warns.map(e => h('li', {}, h('div', { class: 'k8s-warn' }, h('strong', {}, e.reason), h('span', { class: 'meta' }, ` ${e.kind.toLowerCase()}/${e.name} · ${age(uni, e.last)} ago${e.count > 1 ? ` · ×${e.count}` : ''}`), h('div', { class: 'meta k8s-warn-msg' }, e.message.length > 160 ? e.message.slice(0, 160) + '…' : e.message)))))));
  }
}

registerPanel('cluster', 'Cluster', () => new ClusterView());
