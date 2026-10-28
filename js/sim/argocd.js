// Argo CD on the simulated clusters. Applications point at a path in a git repository on
// the simulated GitHub (plain YAML, a kustomization or a Helm chart); the controller
// renders that desired state, compares it with the live objects, and syncs: by hand
// (argocd app sync) or automatically, with self-heal (undo drift) and prune (delete what
// git no longer has). It polls git every 3 minutes unless a webhook is set up.
// ApplicationSets stamp out Applications from a list or from a repo's directories.
// The argocd CLI logs in through a port-forward (or --core, through the kubeconfig).

import { def } from './registry.js';
import { parseYaml } from '../git/yaml.js';
import { C } from '../git/world.js';
import { clusterFor, toYaml, table, PRINTERS, DESCRIBERS, age } from './kubectl.js';
import { CLUSTER_SCOPED, clone, iso } from './k8s.js';
import { kustomizeBuild, mapFiles, findKustomization } from './kustomize.js';
import { renderChart, chartFromFiles, deepMerge } from './helm.js';
import { crdYaml, ARGO_CRDS, CHART_HOOKS } from './helm-charts.js';
import { httpRequest } from './net.js';
import { Host } from './host.js';

const IN_CLUSTER = 'https://kubernetes.default.svc';
const KIND_ORDER = ['Namespace', 'CustomResourceDefinition', 'ServiceAccount', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'NetworkPolicy', 'ConfigMap', 'Secret', 'SecretStore', 'ExternalSecret', 'PersistentVolumeClaim', 'Service', 'Deployment', 'StatefulSet', 'Job', 'CronJob', 'HorizontalPodAutoscaler', 'Ingress'];
const kindRank = k => KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : 50;
const short = h => (h || '').slice(0, 7);

// ---------------------------------------------------------------- install
export function installArgo(cl, { ns = 'argocd', webhook = false, poll = 180 } = {}) {
  if (cl.argocd) return cl.argocd;
  const uni = cl.uni;
  for (const c of ARGO_CRDS) if (!cl.crds.has(c.kind)) cl.apply(parseYaml(crdYaml(c)));
  if (!cl.get('Namespace', null, ns)) cl.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
  const pw = 'adm-' + Array.from({ length: 12 }, (_, i) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[(cl.name.charCodeAt(i % cl.name.length) * 31 + i * 17 + 7) % 55]).join('');
  cl.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'argocd-initial-admin-secret', namespace: ns }, type: 'Opaque', stringData: { password: pw } });
  cl.apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'argocd-cm', namespace: ns, labels: { 'app.kubernetes.io/part-of': 'argocd' } }, data: { 'timeout.reconciliation': `${poll}s` } });
  // the API server/UI, reachable through its Service (port-forward) like the real one
  const h = uni.addHost(`argocd-server.${cl.name}`, { kind: 'vm' });
  h.hidden = true; h.cluster = cl.name; h.clusterOnly = cl.name;
  for (const p of [...h.procs.values()]) if (p.pid !== 1) h.killProc(p.pid);
  h.listening.clear();
  const prog = { kind: 'argocd-server', cluster: cl.name, handle(req) { if (req.path === '/api/version') return { status: 200, body: JSON.stringify({ Version: 'v2.13.0+347f221' }) }; return { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><head><title>Argo CD</title></head><body>Argo CD: log in as admin</body></html>' }; } };
  const proc = h.addProc({ cmd: 'argocd-server', user: 'root', mem: 120, program: prog });
  h.listen(8080, proc.pid, { addr: '0.0.0.0', program: prog });
  const node = cl.nodes[0];
  const sp = (name, ip, labels, image) => { const p = cl.staticPod(name, ns, node, ip, image); p.metadata.labels = labels; return p; };
  sp(`argocd-server-5d7c8b9f6d-${'q7k2m'}`, h.ip, { 'app.kubernetes.io/name': 'argocd-server', 'app.kubernetes.io/part-of': 'argocd' }, 'quay.io/argoproj/argocd:v2.13.0');
  sp('argocd-application-controller-0', '10.244.1.240', { 'app.kubernetes.io/name': 'argocd-application-controller', 'app.kubernetes.io/part-of': 'argocd' }, 'quay.io/argoproj/argocd:v2.13.0');
  sp('argocd-repo-server-6b8f9c7d5c-x2l4p', '10.244.1.241', { 'app.kubernetes.io/name': 'argocd-repo-server', 'app.kubernetes.io/part-of': 'argocd' }, 'quay.io/argoproj/argocd:v2.13.0');
  sp('argocd-redis-7d8f6c9b4d-m8n3k', '10.244.1.242', { 'app.kubernetes.io/name': 'argocd-redis', 'app.kubernetes.io/part-of': 'argocd' }, 'redis:7.4.1-alpine');
  sp('argocd-applicationset-controller-7c9f8d6b5-v5w9r', '10.244.1.243', { 'app.kubernetes.io/name': 'argocd-applicationset-controller', 'app.kubernetes.io/part-of': 'argocd' }, 'quay.io/argoproj/argocd:v2.13.0');
  cl.apply({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'argocd-server', namespace: ns, labels: { 'app.kubernetes.io/name': 'argocd-server' } }, spec: { selector: { 'app.kubernetes.io/name': 'argocd-server' }, ports: [{ name: 'http', port: 80, targetPort: 8080 }, { name: 'https', port: 443, targetPort: 8080 }] } });
  cl.apply({ apiVersion: 'argoproj.io/v1alpha1', kind: 'AppProject', metadata: { name: 'default', namespace: ns }, spec: { sourceRepos: ['*'], destinations: [{ namespace: '*', server: '*' }], clusterResourceWhitelist: [{ group: '*', kind: '*' }] } });
  cl.argocd = { ns, webhook, poll, password: pw, serverHost: h, cache: new Map(), heads: new Map() };
  cl.controllers.push(reconcileAppSets, reconcileApps);
  return cl.argocd;
}
CHART_HOOKS['argo/argo-cd'] = { after(cl, rel) { installArgo(cl, { ns: rel.namespace, poll: parseInt(rel.config_all?.controller?.['timeout.reconciliation'] || '180', 10) }); } };

// ---------------------------------------------------------------- sources
const repoOf = (uni, url) => uni.remotes.get(String(url || '').replace(/\/$/, '').replace(/(\.git)?$/, '.git')) || null;
function resolveRevision(uni, bare, rev) {
  if (!rev || rev === 'HEAD') { const ref = String(bare.HEAD || 'ref: refs/heads/main').replace(/^ref: /, ''); return bare.refs[ref] || null; }
  if (bare.refs[`refs/heads/${rev}`]) return bare.refs[`refs/heads/${rev}`];
  if (bare.refs[`refs/tags/${rev}`]) { let h = bare.refs[`refs/tags/${rev}`]; const o = uni.objects.get(h); if (o?.type === 'tag') h = o.object; return h; }
  for (const h of uni.objects.keys()) if (h.startsWith(rev) && uni.objects.get(h).type === 'commit') return h;
  return null;
}
function treeFiles(uni, sha) {
  const flat = uni.readTreeFlat(uni.commit(sha).tree);
  const out = {};
  for (const [p, h] of flat) out['/' + p] = uni.objects.get(h).content;
  return out;
}

// render an app's desired state: { docs, revision } or { error }
export function renderSource(cl, app) {
  const uni = cl.uni;
  const src = app.spec.source || {};
  const bare = repoOf(uni, src.repoURL);
  if (!bare) return { error: `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = failed to list refs: repository not found` };
  const sha = resolveRevision(uni, bare, src.targetRevision);
  if (!sha) return { error: `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = Unable to resolve '${src.targetRevision}' to a commit SHA` };
  const files = treeFiles(uni, sha);
  const dir = ('/' + String(src.path || '.').replace(/^\.?\/?/, '').replace(/\/$/, '')).replace(/\/\.$/, '') || '/';
  const fs = mapFiles(files);
  if (!fs.isDir(dir)) return { error: `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = ${src.path}: app path does not exist`, revision: sha };
  let docs;
  if (findKustomization(fs, dir)) {
    const r = kustomizeBuild(fs, dir);
    if (r.error) return { error: `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = \`kustomize build ${dir.slice(1)}\` failed exit status 1: ${r.error}`, revision: sha };
    docs = r.docs;
  } else if (files[dir + '/Chart.yaml'] !== undefined) {
    const cfiles = {};
    for (const [p, t] of Object.entries(files)) if (p.startsWith(dir + '/')) cfiles[p.slice(dir.length + 1)] = t;
    const ch = chartFromFiles(cfiles);
    if (ch.error) return { error: ch.error, revision: sha };
    let values = parseYaml(cfiles['values.yaml'] || '') || {};
    for (const vf of src.helm?.valueFiles || []) { const t = cfiles[vf.replace(/^\.\//, '')]; if (t === undefined) return { error: `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = open ${vf}: no such file or directory`, revision: sha }; values = deepMerge(values, parseYaml(t) || {}); }
    if (src.helm?.values) values = deepMerge(values, typeof src.helm.values === 'string' ? parseYaml(src.helm.values) || {} : src.helm.values);
    if (src.helm?.valuesObject) values = deepMerge(values, src.helm.valuesObject);
    for (const p of src.helm?.parameters || []) { const segs = p.name.split('.'); let o = values; segs.slice(0, -1).forEach(s => { o = o[s] = o[s] && typeof o[s] === 'object' ? o[s] : {}; }); o[segs[segs.length - 1]] = /^-?\d+$/.test(p.value) && !p.forceString ? Number(p.value) : p.value === 'true' ? true : p.value === 'false' ? false : p.value; }
    const r = renderChart(ch, { name: src.helm?.releaseName || app.metadata.name, namespace: app.spec.destination?.namespace || 'default', values });
    if (r.error) return { error: `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = \`helm template\` failed: ${r.error}`, revision: sha };
    docs = r.rendered.flatMap(x => x.docs);
  } else {
    docs = [];
    const recurse = !!src.directory?.recurse;
    for (const [p, t] of Object.entries(files).sort()) {
      if (!/\.(ya?ml|json)$/.test(p)) continue;
      const inDir = recurse ? p.startsWith(dir === '/' ? '/' : dir + '/') : p.slice(0, p.lastIndexOf('/')) === dir || (dir === '/' && p.lastIndexOf('/') === 0);
      if (!inDir) continue;
      try { for (const part of t.split(/^---\s*$/m)) { if (!part.trim() || /^\s*(#.*\n?)*\s*$/.test(part)) continue; const o = /^\s*[{[]/.test(part) ? JSON.parse(part) : parseYaml(part); if (o?.kind) docs.push(o); } }
      catch (e) { return { error: `Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = Failed to unmarshal "${p.slice(dir.length + 1)}": ${e.message}`, revision: sha }; }
    }
  }
  const destNs = app.spec.destination?.namespace;
  for (const d of docs) {
    d.metadata = d.metadata || {};
    if (!CLUSTER_SCOPED.has(d.kind) && !d.metadata.namespace) d.metadata.namespace = destNs || 'default';
    d.metadata.labels = { ...(d.metadata.labels || {}), 'app.kubernetes.io/instance': app.metadata.name };
    delete d.__file;
  }
  docs.sort((a, b) => (Number(a.metadata.annotations?.['argocd.argoproj.io/sync-wave'] || 0) - Number(b.metadata.annotations?.['argocd.argoproj.io/sync-wave'] || 0)) || kindRank(a.kind) - kindRank(b.kind));
  return { docs, revision: sha, commit: uni.commit(sha) };
}

// ---------------------------------------------------------------- compare
const ignored = (app, d) => (app.spec.ignoreDifferences || []).filter(x => x.kind === d.kind && (!x.name || x.name === d.metadata.name)).flatMap(x => x.jsonPointers || []);
function normDesired(d) { const x = clone(d); if (x.kind === 'Secret' && x.stringData) { x.data = { ...(x.data || {}), ...Object.fromEntries(Object.entries(x.stringData).map(([k, v]) => [k, btoa(String(v))])) }; delete x.stringData; } return x; }
function subset(want, live, path, skip) {
  if (skip.some(p => path === p || path.startsWith(p + '/'))) return true;
  if (want === null || want === undefined) return true;
  if (Array.isArray(want)) { if (!Array.isArray(live) || live.length !== want.length) return false; return want.every((w, i) => subset(w, live[i], `${path}/${i}`, skip)); }
  if (typeof want === 'object') { if (!live || typeof live !== 'object') return false; return Object.entries(want).every(([k, v]) => subset(v, live[k], `${path}/${k}`, skip)); }
  if (typeof want === 'number' || typeof live === 'number') return String(want) === String(live);
  return want === live;
}
export function resourceStatus(cl, app, d) {
  const live = cl.get(d.kind, CLUSTER_SCOPED.has(d.kind) ? null : d.metadata.namespace, d.metadata.name);
  if (!live) return { status: 'OutOfSync', live: null, missing: true };
  const want = normDesired(d);
  const skip = ignored(app, d);
  const fields = Object.keys(want).filter(k => !['apiVersion', 'kind', 'metadata', 'status'].includes(k));
  const same = fields.every(k => subset(want[k], live[k], `/${k}`, skip)) && subset(want.metadata.labels || {}, live.metadata.labels || {}, '/metadata/labels', skip);
  return { status: same ? 'Synced' : 'OutOfSync', live };
}
export function healthOf(cl, o) {
  if (!o) return { status: 'Missing' };
  if (o.kind === 'Deployment') {
    const st = o.status || {};
    if (st.conditions?.some(c => c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded')) return { status: 'Degraded', message: `Deployment "${o.metadata.name}" exceeded its progress deadline` };
    if ((st.updatedReplicas || 0) < o.spec.replicas) return { status: 'Progressing', message: `Waiting for rollout to finish: ${st.updatedReplicas || 0} out of ${o.spec.replicas} new replicas have been updated...` };
    if ((st.availableReplicas || 0) < o.spec.replicas) return { status: 'Progressing', message: `Waiting for rollout to finish: ${st.availableReplicas || 0} of ${o.spec.replicas} updated replicas are available...` };
    if ((st.replicas || 0) > o.spec.replicas) return { status: 'Progressing', message: `Waiting for rollout to finish: ${st.replicas - o.spec.replicas} old replicas are pending termination...` };
    return { status: 'Healthy' };
  }
  if (o.kind === 'StatefulSet') return (o.status?.readyReplicas || 0) >= o.spec.replicas ? { status: 'Healthy' } : { status: 'Progressing', message: `Waiting for ${o.spec.replicas - (o.status?.readyReplicas || 0)} pods to be ready...` };
  if (o.kind === 'Pod') return cl.podReady(o) ? { status: 'Healthy' } : { status: 'Progressing' };
  if (o.kind === 'Application') return { status: o.status?.health?.status || 'Unknown' };
  if (o.kind === 'ExternalSecret') return o.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ? { status: 'Healthy' } : { status: 'Degraded', message: o.status?.conditions?.[0]?.message };
  if (o.kind === 'PersistentVolumeClaim') return { status: 'Healthy' };
  return { status: 'Healthy' };
}
const WORST = ['Healthy', 'Suspended', 'Progressing', 'Missing', 'Degraded', 'Unknown'];

// what tracks to an app in the cluster right now
function trackedLive(cl, app) {
  const out = [];
  for (const o of cl.objs.values()) if (o.metadata?.labels?.['app.kubernetes.io/instance'] === app.metadata.name && !o.metadata.ownerReferences?.length && o.kind !== 'Application' && !(o.kind === 'Pod' || o.kind === 'ReplicaSet' || o.kind === 'Endpoints' || o.kind === 'Event')) out.push(o);
  return out;
}
const rid = o => `${o.kind}/${CLUSTER_SCOPED.has(o.kind) ? '' : o.metadata.namespace}/${o.metadata.name}`;

// ---------------------------------------------------------------- the controllers
function refreshApp(cl, app, { hard = false } = {}) {
  const st = app.status = app.status || {};
  const r = renderSource(cl, app);
  cl.argocd.cache.set(app.metadata.uid, r);
  st.reconciledAt = iso(cl.uni.time);
  st.__lastRefresh = cl.uni.time;
  void hard;
  return r;
}

function computeStatus(cl, app, r) {
  const st = app.status;
  if (r.error) {
    st.sync = { status: 'Unknown', revision: r.revision || st.sync?.revision, comparedTo: { source: app.spec.source, destination: app.spec.destination } };
    st.health = { status: st.health?.status || 'Healthy' };
    st.conditions = [{ type: 'ComparisonError', message: r.error, lastTransitionTime: iso(cl.uni.time) }];
    return;
  }
  st.conditions = (st.conditions || []).filter(c => c.type !== 'ComparisonError');
  const want = new Set(r.docs.map(rid));
  const resources = r.docs.map(d => { const s = resourceStatus(cl, app, d); const hh = healthOf(cl, s.live); return { group: (d.apiVersion || '').includes('/') ? d.apiVersion.split('/')[0] : '', version: (d.apiVersion || 'v1').split('/').pop(), kind: d.kind, namespace: CLUSTER_SCOPED.has(d.kind) ? '' : d.metadata.namespace, name: d.metadata.name, status: s.status, health: ['Deployment', 'StatefulSet', 'Pod', 'ExternalSecret', 'Application', 'PersistentVolumeClaim', 'Service'].includes(d.kind) || !s.live ? hh : undefined }; });
  const extra = trackedLive(cl, app).filter(o => !want.has(rid(o)));
  for (const o of extra) resources.push({ group: (o.apiVersion || '').includes('/') ? o.apiVersion.split('/')[0] : '', version: (o.apiVersion || 'v1').split('/').pop(), kind: o.kind, namespace: o.metadata.namespace || '', name: o.metadata.name, status: 'OutOfSync', requiresPruning: true });
  st.resources = resources;
  st.sync = { status: resources.every(x => x.status === 'Synced') ? 'Synced' : 'OutOfSync', revision: r.revision, comparedTo: { source: app.spec.source, destination: app.spec.destination } };
  const healths = resources.filter(x => x.health).map(x => x.health.status);
  const worst = healths.reduce((w, h) => WORST.indexOf(h) > WORST.indexOf(w) ? h : w, 'Healthy');
  const msg = resources.find(x => x.health?.status === worst && x.health.message)?.health.message;
  st.health = { status: worst, ...(msg ? { message: msg } : {}) };
  st.summary = { images: [...new Set(r.docs.flatMap(d => (d.spec?.template?.spec?.containers || d.spec?.containers || []).map(c => c.image)))] };
}

// apply the desired state; returns the operation result
export function syncApp(cl, app, { prune = false, dryRun = false, auto = false, revision = null, initiatedBy = 'admin' } = {}) {
  const uni = cl.uni;
  let r = cl.argocd.cache.get(app.metadata.uid);
  if (!r || revision) r = revision ? renderSource(cl, { ...app, spec: { ...app.spec, source: { ...app.spec.source, targetRevision: revision } } }) : refreshApp(cl, app);
  const st = app.status = app.status || {};
  const started = uni.time;
  if (r.error) {
    st.operationState = { phase: 'Error', message: r.error, startedAt: iso(started), finishedAt: iso(uni.time), operation: { sync: { revision: r.revision }, initiatedBy: auto ? { automated: true } : { username: initiatedBy } } };
    uni.emit({ type: 'argocd-sync', cluster: cl.name, app: app.metadata.name, ok: false, auto, message: r.error });
    return { ok: false, message: r.error, results: [] };
  }
  const opts = new Set(app.spec.syncPolicy?.syncOptions || []);
  const results = [];
  let ok = true;
  const destNs = app.spec.destination?.namespace;
  if (destNs && !cl.get('Namespace', null, destNs)) {
    if (opts.has('CreateNamespace=true')) { if (!dryRun) cl.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: destNs } }); results.push({ kind: 'Namespace', namespace: '', name: destNs, status: 'Synced', message: `namespace/${destNs} created` }); }
  }
  for (const d of r.docs) {
    const s = resourceStatus(cl, app, d);
    if (s.status === 'Synced') { results.push({ group: d.apiVersion?.includes('/') ? d.apiVersion.split('/')[0] : '', kind: d.kind, namespace: d.metadata.namespace || '', name: d.metadata.name, status: 'Synced', message: `${d.kind.toLowerCase()}/${d.metadata.name} unchanged` }); continue; }
    if (dryRun) { results.push({ group: '', kind: d.kind, namespace: d.metadata.namespace || '', name: d.metadata.name, status: 'Synced', message: `${d.kind.toLowerCase()}/${d.metadata.name} ${s.live ? 'configured' : 'created'} (dry run)` }); continue; }
    const res = cl.apply(clone(d), { ns: destNs || 'default', user: 'system:serviceaccount:argocd:argocd-application-controller' });
    if (res.error) { ok = false; results.push({ group: d.apiVersion?.includes('/') ? d.apiVersion.split('/')[0] : '', kind: d.kind, namespace: d.metadata.namespace || '', name: d.metadata.name, status: 'SyncFailed', message: res.error.replace(/^Error from server \(\w+\): (error when creating "[^"]*": )?/, '') }); continue; }
    results.push({ group: d.apiVersion?.includes('/') ? d.apiVersion.split('/')[0] : '', kind: d.kind, namespace: d.metadata.namespace || '', name: d.metadata.name, status: 'Synced', message: `${d.kind === 'Deployment' ? 'deployment.apps' : d.kind.toLowerCase()}/${d.metadata.name} ${res.verb}` });
  }
  const want = new Set(r.docs.map(rid));
  for (const o of trackedLive(cl, app).filter(x => !want.has(rid(x)))) {
    if (prune || app.spec.syncPolicy?.automated?.prune && auto) { if (!dryRun) cl.delete(o, { now: true }); results.push({ kind: o.kind, namespace: o.metadata.namespace || '', name: o.metadata.name, status: 'Pruned', message: 'pruned' }); }
    else results.push({ kind: o.kind, namespace: o.metadata.namespace || '', name: o.metadata.name, status: 'PruneSkipped', message: 'ignored (requires pruning)' });
  }
  const message = ok ? 'successfully synced (all tasks run)' : `one or more objects failed to apply, reason: ${results.find(x => x.status === 'SyncFailed').message}`;
  if (!dryRun) {
    st.operationState = { phase: ok ? 'Succeeded' : 'Failed', message, startedAt: iso(started), finishedAt: iso(uni.time), operation: { sync: { revision: r.revision, prune }, initiatedBy: auto ? { automated: true } : { username: initiatedBy } }, syncResult: { revision: r.revision, resources: results } };
    if (ok) {
      st.history = st.history || [];
      st.history.push({ id: st.history.length, revision: r.revision, deployedAt: iso(uni.time), source: clone(app.spec.source), at: uni.time, message: r.commit?.message?.split('\n')[0] || '' });
      if (st.history.length > 10) st.history.shift();
    }
    st.__lastSyncedRev = r.revision;
    st.__lastAttempt = uni.time;
    computeStatus(cl, app, r);
    uni.emit({ type: 'argocd-sync', cluster: cl.name, app: app.metadata.name, ok, auto, revision: r.revision, message, pruned: results.filter(x => x.status === 'Pruned').map(x => x.name) });
  }
  return { ok, message, results, revision: r.revision };
}

function reconcileApps(cl) {
  if (!cl.argocd) return;
  const uni = cl.uni;
  for (const app of cl.list('Application', cl.argocd.ns)) {
    const st = app.status = app.status || {};
    const src = app.spec.source || {};
    const bare = repoOf(uni, src.repoURL);
    const head = bare ? resolveRevision(uni, bare, src.targetRevision) : null;
    const key = app.metadata.uid;
    const pushed = head && cl.argocd.heads.get(key) !== head;
    const due = st.__lastRefresh === undefined || uni.time - st.__lastRefresh >= cl.argocd.poll || app.metadata.annotations?.['argocd.argoproj.io/refresh'] || (cl.argocd.webhook && pushed) || JSON.stringify(src) !== st.__srcKey;
    let r = cl.argocd.cache.get(key);
    if (due || !r) {
      r = refreshApp(cl, app);
      st.__srcKey = JSON.stringify(src);
      if (app.metadata.annotations?.['argocd.argoproj.io/refresh']) delete app.metadata.annotations['argocd.argoproj.io/refresh'];
      cl.argocd.heads.set(key, head);
    }
    computeStatus(cl, app, r);
    const auto = app.spec.syncPolicy?.automated;
    if (!auto || r.error) continue;
    const newRev = st.__lastSyncedRev !== r.revision;
    const drift = st.sync.status === 'OutOfSync' && !newRev;
    const needsPruneOnly = st.resources.every(x => x.status === 'Synced' || x.requiresPruning) && st.resources.some(x => x.requiresPruning);
    if (newRev && st.sync.status === 'Synced') { st.__lastSyncedRev = r.revision; continue; }
    if (newRev && st.__failedRev !== r.revision) { const res = syncApp(cl, app, { auto: true, prune: !!auto.prune }); if (!res.ok) st.__failedRev = r.revision; }
    else if (drift && needsPruneOnly && auto.prune) syncApp(cl, app, { auto: true, prune: true });
    else if (drift && auto.selfHeal && !needsPruneOnly && uni.time - (st.__lastAttempt || 0) >= 5) syncApp(cl, app, { auto: true, prune: !!auto.prune });
  }
}

// ApplicationSets: list and git-directory generators, {{param}} templates
function reconcileAppSets(cl) {
  if (!cl.argocd) return;
  const uni = cl.uni;
  for (const set of cl.list('ApplicationSet', cl.argocd.ns)) {
    const params = [];
    let err = null;
    for (const g of set.spec.generators || []) {
      if (g.list) params.push(...(g.list.elements || []));
      else if (g.git) {
        const bare = repoOf(uni, g.git.repoURL);
        const sha = bare && resolveRevision(uni, bare, g.git.revision);
        if (!sha) { err = `failed to get git directories: repository not found or revision unresolved`; continue; }
        const files = treeFiles(uni, sha);
        const dirs = new Set(Object.keys(files).map(p => p.slice(1, p.lastIndexOf('/'))));
        const include = (g.git.directories || []).filter(d => !d.exclude).map(d => globRe(d.path));
        const exclude = (g.git.directories || []).filter(d => d.exclude).map(d => globRe(d.path));
        for (const d of [...dirs].sort()) if (include.some(re => re.test(d)) && !exclude.some(re => re.test(d))) params.push({ path: d, 'path.basename': d.split('/').pop(), 'path.basenameNormalized': d.split('/').pop().replace(/[^a-z0-9-]/gi, '-').toLowerCase(), ...Object.fromEntries(d.split('/').map((s, i) => [`path[${i}]`, s])), __path: d });
      }
    }
    const want = new Map();
    for (const p of params) {
      const app = fill(clone(set.spec.template || {}), p);
      app.apiVersion = 'argoproj.io/v1alpha1'; app.kind = 'Application';
      app.metadata = { ...(app.metadata || {}), namespace: cl.argocd.ns, ownerReferences: [{ apiVersion: 'argoproj.io/v1alpha1', kind: 'ApplicationSet', name: set.metadata.name, uid: set.metadata.uid }] };
      want.set(app.metadata.name, app);
    }
    for (const [name, app] of want) {
      const cur = cl.get('Application', cl.argocd.ns, name);
      if (!cur) { cl.apply(app); uni.emit({ type: 'argocd-appset', cluster: cl.name, set: set.metadata.name, app: name, verb: 'created' }); }
      else if (JSON.stringify(cur.spec) !== JSON.stringify(app.spec)) { cur.spec = app.spec; }
    }
    for (const app of cl.list('Application', cl.argocd.ns)) if (app.metadata.ownerReferences?.some(r => r.uid === set.metadata.uid) && !want.has(app.metadata.name)) { deleteApp(cl, app, { cascade: true }); uni.emit({ type: 'argocd-appset', cluster: cl.name, set: set.metadata.name, app: app.metadata.name, verb: 'deleted' }); }
    set.status = { conditions: [{ type: err ? 'ErrorOccurred' : 'ResourcesUpToDate', status: 'True', message: err || 'All applications have been generated successfully', lastTransitionTime: iso(uni.time) }], applicationStatus: [...want.keys()].map(n => ({ application: n })) };
  }
}
const globRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]+').replace(/§/g, '.*') + '$');
function fill(v, p) {
  if (typeof v === 'string') return v.replace(/\{\{\s*\.?([\w.[\]-]+)\s*\}\}/g, (m, k) => p[k] ?? p[k.replace(/^path\./, 'path.')] ?? m);
  if (Array.isArray(v)) return v.map(x => fill(x, p));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, p)]));
  return v;
}

export function deleteApp(cl, app, { cascade = true } = {}) {
  if (cascade) for (const o of trackedLive(cl, app)) cl.delete(o, { now: true });
  cl.argocd.cache.delete(app.metadata.uid);
  cl.remove(app);
}

// ---------------------------------------------------------------- kubectl get/describe
PRINTERS.Application = (cl, items, { wide }) => [['NAME', 'SYNC STATUS', 'HEALTH STATUS', ...(wide ? ['REVISION', 'PROJECT'] : [])], items.map(a => [a.metadata.name, a.status?.sync?.status || 'Unknown', a.status?.health?.status || 'Unknown', ...(wide ? [short(a.status?.sync?.revision), a.spec.project || 'default'] : [])])];
PRINTERS.ApplicationSet = (cl, items) => [['NAME', 'AGE'], items.map(a => [a.metadata.name, age(cl.uni, a.metadata.creationTimestamp)])];
PRINTERS.AppProject = (cl, items) => [['NAME', 'AGE'], items.map(a => [a.metadata.name, age(cl.uni, a.metadata.creationTimestamp)])];
DESCRIBERS.Application = (cl, a) => [`Name:         ${a.metadata.name}`, `Namespace:    ${a.metadata.namespace}`, 'Spec:', `  Source:`, `    Repo URL:         ${a.spec.source?.repoURL}`, `    Path:             ${a.spec.source?.path}`, `    Target Revision:  ${a.spec.source?.targetRevision || 'HEAD'}`, `  Destination:`, `    Namespace:  ${a.spec.destination?.namespace}`, `    Server:     ${a.spec.destination?.server}`, `  Sync Policy:  ${a.spec.syncPolicy?.automated ? `automated (prune: ${!!a.spec.syncPolicy.automated.prune}, selfHeal: ${!!a.spec.syncPolicy.automated.selfHeal})` : '<none>'}`, 'Status:', `  Sync:    ${a.status?.sync?.status || 'Unknown'} (${short(a.status?.sync?.revision)})`, `  Health:  ${a.status?.health?.status || 'Unknown'}`, ...((a.status?.conditions || []).length ? ['  Conditions:', ...a.status.conditions.map(c => `    ${c.type}: ${c.message}`)] : [])];

// ---------------------------------------------------------------- the CLI
function cfgPath(c) { return `${c.host.users.get(c.user)?.home || '/root'}/.config/argocd/config`; }
function readCfg(c) { try { return parseYaml(c.host.files.get(cfgPath(c)) || '') || null; } catch { return null; } }

function connectArgo(c, o) {
  const cfg = readCfg(c);
  const cur = cfg?.contexts?.find(x => x.name === cfg['current-context']);
  if (o.core || cur?.core) {
    const conn = clusterFor(c, { raw: {}, all: () => [] });
    if (conn.error) return { error: `FATA[0000] ${conn.error.replace(/^error: /, '')}` };
    if (!conn.cl.argocd) return { error: 'FATA[0000] error getting server version: the server could not find the requested resource (get applications.argoproj.io)' };
    return { cl: conn.cl, server: 'kubernetes', core: true };
  }
  if (!cur) return { error: 'FATA[0000] Argo CD server address unspecified' };
  const r = httpRequest(c.uni, c.host, `http://${cur.server}/api/version`);
  if (r.error) return { error: `FATA[0000] rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial tcp ${cur.server.replace(/^localhost/, '127.0.0.1')}: connect: connection refused"` };
  const cl = [...c.uni.clusters.values()].find(x => x.argocd);
  if (!cl) return { error: 'FATA[0000] rpc error: code = Unavailable desc = no Argo CD here' };
  return { cl, server: cur.server };
}

const VALF = new Set(['--repo', '--path', '--revision', '--dest-server', '--dest-namespace', '--sync-policy', '--sync-option', '--project', '--helm-set', '--values', '--username', '--password', '-n', '--namespace', '--timeout', '-o', '--output', '--dest-name', '--label', '-l', '--release-name', '--kustomize-image', '--name']);
function parseArgs(args) {
  const o = { _: [], multi: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.includes('=')) { const k = a.slice(0, a.indexOf('=')); (o.multi[k] = o.multi[k] || []).push(a.slice(a.indexOf('=') + 1)); o[k] = a.slice(a.indexOf('=') + 1); continue; }
    if (VALF.has(a)) { const v = args[++i]; (o.multi[a] = o.multi[a] || []).push(v); o[a] = v; continue; }
    if (a.startsWith('-')) { o[a] = true; continue; }
    o._.push(a);
  }
  o.core = !!o['--core'];
  return o;
}

function appGetLines(cl, app, server) {
  const st = app.status || {};
  const L = [`Name:               ${cl.argocd.ns}/${app.metadata.name}`, `Project:            ${app.spec.project || 'default'}`, `Server:             ${app.spec.destination?.server || IN_CLUSTER}`, `Namespace:          ${app.spec.destination?.namespace || ''}`, `URL:                https://${server === 'kubernetes' ? 'argocd.example.com' : server}/applications/${app.metadata.name}`, 'Source:', `- Repo:             ${app.spec.source?.repoURL}`, `  Target:           ${app.spec.source?.targetRevision || 'HEAD'}`, `  Path:             ${app.spec.source?.path}`, 'SyncWindow:         Sync Allowed', `Sync Policy:        ${app.spec.syncPolicy?.automated ? `Automated${app.spec.syncPolicy.automated.prune ? ' (Prune)' : ''}` : 'Manual'}`, `Sync Status:        ${st.sync?.status || 'Unknown'} to ${app.spec.source?.targetRevision || 'HEAD'} (${short(st.sync?.revision)})`, `Health Status:      ${st.health?.status || 'Unknown'}`];
  for (const cnd of st.conditions || []) L.push('', 'CONDITION        MESSAGE', `${cnd.type.padEnd(17)}${cnd.message}`);
  if (st.operationState) {
    L.push('', `Operation:          Sync`, `Sync Revision:      ${st.operationState.syncResult?.revision || st.operationState.operation?.sync?.revision || ''}`, `Phase:              ${st.operationState.phase}`, `Start:              ${st.operationState.startedAt}`, `Finished:           ${st.operationState.finishedAt}`, `Duration:           1s`, `Message:            ${st.operationState.message}`);
  }
  const res = st.resources || [];
  if (res.length) {
    const last = new Map((st.operationState?.syncResult?.resources || []).map(x => [`${x.kind}/${x.namespace}/${x.name}`, x.message]));
    L.push('', ...table(['GROUP', 'KIND', 'NAMESPACE', 'NAME', 'STATUS', 'HEALTH', 'HOOK', 'MESSAGE'], res.map(x => [x.group || '', x.kind, x.namespace, x.name, x.status + (x.requiresPruning ? '' : ''), x.health?.status || '', '', x.requiresPruning ? 'ignored (requires pruning)' : last.get(`${x.kind}/${x.namespace}/${x.name}`) || ''])));
  }
  return L;
}

def('argocd', c => {
  const o = parseArgs(c.args);
  const [group, sub, ...rest] = o._;
  const out = (...l) => c.print(...l);
  const fail = (m, code = 20) => c.fail(m, code);
  const uni = c.uni;
  const emit = extra => uni.emit({ type: 'argocd', host: c.host.name, group, sub, args: c.args.join(' '), ...extra });
  if (!group || group === 'help' || o['--help']) { out('argocd controls an Argo CD server', '', 'Usage:', '  argocd [command]', '', 'Available Commands:', '  admin       Contains a set of commands useful for Argo CD administrators', '  app         Manage applications', '  appset      Manage ApplicationSets', '  cluster     Manage cluster credentials', '  login       Log in to Argo CD', '  logout      Log out from Argo CD', '  repo        Manage repository connection parameters', '  version     Print version information'); return 0; }
  if (group === 'version') {
    out('argocd: v2.13.0+347f221', '  BuildDate: 2024-11-04T12:09:06Z', '  GitCommit: 347f221adba5599ef4d5f12ee572b2c17d01db4d', '  GoVersion: go1.23.1', '  Platform: linux/amd64');
    if (!o['--client']) { const k = connectArgo(c, o); if (!k.error) out('argocd-server: v2.13.0+347f221'); }
    return 0;
  }
  if (group === 'login') {
    const server = sub;
    if (o['--core']) {
      const conn = clusterFor(c, { raw: {}, all: () => [] });
      if (conn.error) return fail(`FATA[0000] ${conn.error}`);
      writeCfg(c, { name: 'kubernetes', server: 'kubernetes', core: true });
      out("Context 'kubernetes' updated");
      emit({ core: true });
      return 0;
    }
    if (!server) return fail('FATA[0000] Argo CD server address unspecified');
    const r = httpRequest(uni, c.host, `http://${server}/api/version`);
    if (r.error) return fail(`FATA[0000] dial tcp ${server.replace(/^localhost/, '127.0.0.1')}: connect: connection refused`);
    let prog = null;
    try { prog = JSON.parse(r.body); } catch { prog = null; }
    if (!prog?.Version) return fail(`FATA[0000] rpc error: code = Unavailable desc = ${server} is not an Argo CD server`);
    const cl = [...uni.clusters.values()].find(x => x.argocd);
    const user = o['--username'] || 'admin';
    const pass = o['--password'];
    if (!pass) return fail('FATA[0000] --password is required in this simulator (the real CLI prompts for it)');
    if (user !== 'admin' || pass !== cl.argocd.password) { emit({ ok: false }); return fail('FATA[0001] rpc error: code = Unauthenticated desc = Invalid username or password'); }
    writeCfg(c, { name: server, server, user });
    out(`'admin:login' logged in successfully`, `Context '${server}' updated`);
    emit({ ok: true, server });
    return 0;
  }
  if (group === 'logout') { writeCfg(c, null); out(`Logged out from '${sub || 'argocd'}'`); return 0; }
  if (group === 'admin' && sub === 'initial-password') {
    const conn = clusterFor(c, { raw: {}, all: () => [] });
    if (conn.error) return fail(`FATA[0000] ${conn.error}`);
    const s = conn.cl.get('Secret', o['-n'] || o['--namespace'] || 'argocd', 'argocd-initial-admin-secret');
    if (!s) return fail('FATA[0000] secrets "argocd-initial-admin-secret" not found');
    out(atob(s.data.password), '', ' This password must be only used for first time login. We strongly recommend you update the password using `argocd account update-password`.');
    emit({});
    return 0;
  }
  const k = connectArgo(c, o);
  if (k.error) return fail(k.error);
  const cl = k.cl;
  const ns = cl.argocd.ns;
  const app = name => cl.get('Application', ns, String(name || '').replace(/^argocd\//, ''));

  if (group === 'repo') {
    if (sub === 'add') { const url = rest[0]; if (!repoOf(uni, url)) return fail(`FATA[0001] rpc error: code = Unknown desc = error testing repository connectivity: repository not found`); cl.argocd.repos = [...new Set([...(cl.argocd.repos || []), url])]; out(`Repository '${url}' added`); emit({ url }); return 0; }
    if (sub === 'list') { out(...table(['TYPE', 'NAME', 'REPO', 'INSECURE', 'OCI', 'LFS', 'CREDS', 'STATUS', 'MESSAGE', 'PROJECT'], (cl.argocd.repos || []).map(u => ['git', '', u, 'false', 'false', 'false', 'false', 'Successful', '', '']))); return 0; }
  }
  if (group === 'cluster' && sub === 'list') { out(...table(['SERVER', 'NAME', 'VERSION', 'STATUS', 'MESSAGE', 'PROJECT'], [[IN_CLUSTER, 'in-cluster', '1.31', 'Successful', '', '']])); return 0; }
  if (group === 'appset' && (sub === 'list' || sub === 'get')) {
    const sets = cl.list('ApplicationSet', ns).filter(s => sub === 'list' || s.metadata.name === rest[0]);
    out(...table(['NAME', 'PROJECT', 'SYNCPOLICY', 'CONDITIONS', 'REPO', 'PATH', 'TARGET'], sets.map(s => [`${ns}/${s.metadata.name}`, s.spec.template?.spec?.project || 'default', s.spec.syncPolicy?.preserveResourcesOnDeletion ? 'preserve' : 'nil', `[${(s.status?.conditions || []).map(x => `{${x.type} ${x.message} ${x.lastTransitionTime} True}`).join(' ')}]`, s.spec.template?.spec?.source?.repoURL || '', s.spec.template?.spec?.source?.path || '', s.spec.template?.spec?.source?.targetRevision || ''])));
    return 0;
  }
  if (group !== 'app') return fail(`Error: unknown command "${group}" for "argocd"`, 1);
  switch (sub) {
    case 'list': {
      const apps = cl.list('Application', ns);
      out(...table(['NAME', 'CLUSTER', 'NAMESPACE', 'PROJECT', 'STATUS', 'HEALTH', 'SYNCPOLICY', 'CONDITIONS', 'REPO', 'PATH', 'TARGET'], apps.map(a => [`${ns}/${a.metadata.name}`, a.spec.destination?.server || IN_CLUSTER, a.spec.destination?.namespace || '', a.spec.project || 'default', a.status?.sync?.status || 'Unknown', a.status?.health?.status || 'Unknown', a.spec.syncPolicy?.automated ? (a.spec.syncPolicy.automated.prune ? 'Auto-Prune' : 'Auto') : 'Manual', (a.status?.conditions || []).map(x => x.type).join(',') || '<none>', a.spec.source?.repoURL, a.spec.source?.path, a.spec.source?.targetRevision || 'HEAD'])));
      emit({});
      return 0;
    }
    case 'create': {
      const name = rest[0];
      if (!name) return fail('FATA[0000] app name or file is required', 1);
      if (app(name) && !o['--upsert']) return fail(`FATA[0000] rpc error: code = InvalidArgument desc = existing application spec is different, use upsert flag to force update`);
      const spec = { project: o['--project'] || 'default', source: { repoURL: o['--repo'], path: o['--path'] || '.', targetRevision: o['--revision'] || 'HEAD' }, destination: { server: o['--dest-server'] || IN_CLUSTER, namespace: o['--dest-namespace'] } };
      if (!spec.source.repoURL) return fail('FATA[0000] Argo CD needs --repo', 1);
      if (o['--helm-set'] || o['--values'] || o['--release-name']) spec.source.helm = { ...(o.multi['--values'] ? { valueFiles: o.multi['--values'] } : {}), ...(o.multi['--helm-set'] ? { parameters: o.multi['--helm-set'].map(kv => ({ name: kv.split('=')[0], value: kv.split('=').slice(1).join('=') })) } : {}), ...(o['--release-name'] ? { releaseName: o['--release-name'] } : {}) };
      if (o['--directory-recurse']) spec.source.directory = { recurse: true };
      if (o['--sync-policy'] === 'automated' || o['--sync-policy'] === 'auto') spec.syncPolicy = { automated: { prune: !!o['--auto-prune'], selfHeal: !!o['--self-heal'] } };
      if (o.multi['--sync-option']) spec.syncPolicy = { ...(spec.syncPolicy || {}), syncOptions: o.multi['--sync-option'] };
      const r = cl.apply({ apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name, namespace: ns }, spec });
      if (r.error) return fail(`FATA[0000] ${r.error}`);
      uni.advance(1);
      out(`application '${name}' created`);
      emit({ name, spec });
      return 0;
    }
    case 'get': case 'sync': case 'diff': case 'history': case 'rollback': case 'set': case 'delete': case 'wait': case 'manifests': case 'resources': case 'unset': case 'refresh': break;
    default: return fail(`Error: unknown command "${sub}" for "argocd app"`, 1);
  }
  const a = app(rest[0]);
  if (!a) return fail(`FATA[0000] rpc error: code = NotFound desc = applications.argoproj.io "${String(rest[0] || '').replace(/^argocd\//, '')}" not found`);
  switch (sub) {
    case 'get': {
      if (o['--refresh'] || o['--hard-refresh']) { a.metadata.annotations = { ...(a.metadata.annotations || {}), 'argocd.argoproj.io/refresh': o['--hard-refresh'] ? 'hard' : 'normal' }; uni.advance(1); }
      if (o['-o'] === 'yaml' || o['--output'] === 'yaml') out(...toYaml({ apiVersion: a.apiVersion, kind: a.kind, metadata: { name: a.metadata.name, namespace: a.metadata.namespace }, spec: a.spec, status: Object.fromEntries(Object.entries(a.status || {}).filter(([k2]) => !k2.startsWith('__'))) }).split('\n'));
      else out(...appGetLines(cl, a, k.server));
      emit({ name: a.metadata.name, refresh: !!(o['--refresh'] || o['--hard-refresh']) });
      return 0;
    }
    case 'sync': {
      const res = syncApp(cl, a, { prune: !!o['--prune'], dryRun: !!o['--dry-run'], revision: o['--revision'] || null });
      uni.advance(2);
      if (!res.ok) { out(...appGetLines(cl, a, k.server)); emit({ name: a.metadata.name, ok: false }); return fail(`FATA[0002] Operation has completed with phase: Failed`); }
      out(...(o['--dry-run'] ? res.results.map(x => `${x.kind}\t${x.namespace}\t${x.name}\t${x.message}`) : appGetLines(cl, a, k.server)));
      emit({ name: a.metadata.name, ok: true, prune: !!o['--prune'], dry: !!o['--dry-run'] });
      return 0;
    }
    case 'diff': {
      const r = o['--refresh'] ? refreshApp(cl, a) : cl.argocd.cache.get(a.metadata.uid) || refreshApp(cl, a);
      if (r.error) return fail(`FATA[0000] ${r.error}`);
      const lines = [];
      const want = new Set(r.docs.map(rid));
      for (const d of r.docs) {
        const s = resourceStatus(cl, a, d);
        if (s.status === 'Synced') continue;
        const live = s.live ? strip(cl, s.live) : null;
        const desired = live ? overlayDesired(live, normDesired(d)) : normDesired(d);
        lines.push(`===== ${d.apiVersion?.includes('/') ? d.apiVersion.split('/')[0] : ''}/${d.kind} ${d.metadata.namespace || ''}/${d.metadata.name} ======`, ...normalDiff(live ? toYaml(live).split('\n') : [], toYaml(desired).split('\n')));
      }
      for (const x of trackedLive(cl, a).filter(z => !want.has(rid(z)))) lines.push(`===== ${x.apiVersion?.includes('/') ? x.apiVersion.split('/')[0] : ''}/${x.kind} ${x.metadata.namespace || ''}/${x.metadata.name} ======`, ...normalDiff(toYaml(strip(cl, x)).split('\n'), []));
      if (lines.length) out(...lines);
      emit({ name: a.metadata.name, changed: lines.length > 0 });
      return lines.length ? 1 : 0;
    }
    case 'history': {
      const h = a.status?.history || [];
      out(`SOURCE  ${a.spec.source?.repoURL}`, ...table(['ID', 'DATE', 'REVISION'], h.map(x => [x.id, new Date(x.at * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000 UTC'), `${x.source?.targetRevision || 'HEAD'} (${short(x.revision)})`])));
      emit({ name: a.metadata.name });
      return 0;
    }
    case 'rollback': {
      if (a.spec.syncPolicy?.automated) return fail('FATA[0000] rpc error: code = FailedPrecondition desc = rollback cannot be initiated when auto-sync is enabled');
      const h = a.status?.history || [];
      const id = rest[1] !== undefined ? Number(rest[1]) : h.length >= 2 ? h[h.length - 2].id : null;
      const target = h.find(x => x.id === id);
      if (!target) return fail(`FATA[0000] Application '${a.metadata.name}' does not have deployment id '${rest[1]}' in history`);
      const res = syncApp(cl, a, { revision: target.revision, prune: !!o['--prune'] });
      uni.advance(2);
      out(...appGetLines(cl, a, k.server));
      emit({ name: a.metadata.name, to: target.revision, ok: res.ok });
      return res.ok ? 0 : 20;
    }
    case 'set': case 'unset': {
      if (sub === 'set') {
        if (o['--sync-policy'] === 'automated' || o['--sync-policy'] === 'auto') a.spec.syncPolicy = { ...(a.spec.syncPolicy || {}), automated: { prune: !!o['--auto-prune'] || !!a.spec.syncPolicy?.automated?.prune, selfHeal: !!o['--self-heal'] || !!a.spec.syncPolicy?.automated?.selfHeal } };
        else if (o['--sync-policy'] === 'none' || o['--sync-policy'] === 'manual') { if (a.spec.syncPolicy) delete a.spec.syncPolicy.automated; }
        else if (a.spec.syncPolicy?.automated) { if (o['--self-heal']) a.spec.syncPolicy.automated.selfHeal = true; if (o['--auto-prune']) a.spec.syncPolicy.automated.prune = true; }
        if (o['--revision']) a.spec.source.targetRevision = o['--revision'];
        if (o['--path']) a.spec.source.path = o['--path'];
        if (o.multi['--helm-set']) a.spec.source.helm = { ...(a.spec.source.helm || {}), parameters: [...(a.spec.source.helm?.parameters || []).filter(p => !o.multi['--helm-set'].some(kv => kv.split('=')[0] === p.name)), ...o.multi['--helm-set'].map(kv => ({ name: kv.split('=')[0], value: kv.split('=').slice(1).join('=') }))] };
        if (o.multi['--sync-option']) a.spec.syncPolicy = { ...(a.spec.syncPolicy || {}), syncOptions: [...new Set([...(a.spec.syncPolicy?.syncOptions || []), ...o.multi['--sync-option']])] };
      } else {
        if (o['--self-heal'] && a.spec.syncPolicy?.automated) a.spec.syncPolicy.automated.selfHeal = false;
        if (o['--auto-prune'] && a.spec.syncPolicy?.automated) a.spec.syncPolicy.automated.prune = false;
      }
      a.metadata.generation++;
      uni.advance(1);
      emit({ name: a.metadata.name, policy: clone(a.spec.syncPolicy || {}) });
      return 0;
    }
    case 'delete': {
      if (!o['-y'] && !o['--yes']) return fail('FATA[0000] the simulator cannot ask for confirmation: add --yes (-y) to delete the application', 1);
      const cascade = o['--cascade=false'] !== true && o['--cascade'] !== 'false';
      deleteApp(cl, a, { cascade });
      out(`application '${a.metadata.name}' deleted`);
      emit({ name: a.metadata.name, cascade });
      return 0;
    }
    case 'wait': {
      const limit = parseInt(o['--timeout'] || '120', 10);
      let w = 0;
      const okNow = () => (!o['--health'] || a.status?.health?.status === 'Healthy') && (!o['--sync'] || a.status?.sync?.status === 'Synced') && (o['--health'] || o['--sync'] || (a.status?.health?.status === 'Healthy' && a.status?.sync?.status === 'Synced'));
      while (!okNow() && w < limit) { uni.advance(5); w += 5; }
      if (!okNow()) return fail(`FATA[${String(limit).padStart(4, '0')}] timed out (${limit}s) waiting for app "${a.metadata.name}" match desired state`);
      out(...appGetLines(cl, a, k.server));
      return 0;
    }
    case 'manifests': {
      const r = cl.argocd.cache.get(a.metadata.uid) || refreshApp(cl, a);
      if (r.error) return fail(`FATA[0000] ${r.error}`);
      out(...r.docs.map(d => toYaml(d)).join('\n---\n').split('\n'));
      return 0;
    }
    case 'resources': {
      out(...table(['GROUP', 'KIND', 'NAMESPACE', 'NAME', 'ORPHANED'], (a.status?.resources || []).map(x => [x.group || '', x.kind, x.namespace, x.name, 'No'])));
      return 0;
    }
  }
  return 0;
}, { pkg: 'argocd' });

function writeCfg(c, ctx) {
  const p = cfgPath(c);
  c.host.ensureParents?.(p, c.user);
  if (!ctx) { c.host.writeFile(p, 'contexts: []\ncurrent-context: ""\n', c.user); return; }
  c.host.writeFile(p, toYaml({ contexts: [{ name: ctx.name, server: ctx.server, user: ctx.user || 'admin', ...(ctx.core ? { core: true } : {}) }], 'current-context': ctx.name, servers: [{ server: ctx.server, 'grpc-web-root-path': '', ...(ctx.core ? { core: true } : { insecure: true }) }], users: [{ name: ctx.user || 'admin', 'auth-token': 'redacted' }] }) + '\n', c.user);
  c.host.setMeta(p, { mode: 0o600 });
}

function strip(cl, o) {
  const x = clone(o);
  delete x.status;
  for (const k of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'ownerReferences', 'managedFields', 'deletionTimestamp']) delete x.metadata[k];
  if (x.metadata.annotations) { for (const k of Object.keys(x.metadata.annotations)) if (k.startsWith('deployment.kubernetes.io/') || k.startsWith('kubectl.kubernetes.io/')) delete x.metadata.annotations[k]; if (!Object.keys(x.metadata.annotations).length) delete x.metadata.annotations; }
  return x;
}
function overlayDesired(live, want) {
  const ov = (l, w) => { if (Array.isArray(w)) return Array.isArray(l) && l.length === w.length ? w.map((x, i) => ov(l[i], x)) : w; if (w && typeof w === 'object') { const res = l && typeof l === 'object' && !Array.isArray(l) ? { ...l } : {}; for (const [kk, v] of Object.entries(w)) res[kk] = ov(res[kk], v); return res; } return w; };
  const out = ov(live, Object.fromEntries(Object.entries(want).filter(([kk]) => kk !== 'metadata')));
  out.metadata = { ...live.metadata, labels: { ...(live.metadata.labels || {}), ...(want.metadata?.labels || {}) } };
  return out;
}
// "normal" diff output (what argocd app diff prints): 12c12 / < live / --- / > desired
function normalDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; continue; }
    const i0 = i, j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) { if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) i++; else j++; }
    const del = a.slice(i0, i), add = b.slice(j0, j);
    const ra = del.length > 1 ? `${i0 + 1},${i}` : `${del.length ? i0 + 1 : i0}`;
    const rb = add.length > 1 ? `${j0 + 1},${j}` : `${add.length ? j0 + 1 : j0}`;
    out.push(`${ra}${del.length && add.length ? 'c' : del.length ? 'd' : 'a'}${rb}`, ...del.map(l => `< ${l}`), ...(del.length && add.length ? ['---'] : []), ...add.map(l => `> ${l}`));
  }
  return out;
}

// what a lab needs: Argo CD in a cluster (optionally with the CLI on the laptop)
export function argoForLab(uni, clusterName, opts) { const cl = uni.clusters.get(clusterName); return installArgo(cl, opts); }
export { Host };
