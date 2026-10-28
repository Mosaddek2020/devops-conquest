// kubectl for the simulated clusters: reads ~/.kube/config, talks to the cluster's API
// server, and prints what real kubectl prints (tables, describe, YAML/JSON, jsonpath).

import { def } from './registry.js';
import { parseYaml } from '../git/yaml.js';
import { C } from '../git/world.js';
import { connect, httpRequest } from './net.js';
import { Session } from './session.js';
import { normPath, dirname, basename } from './host.js';
import { API_VERSIONS, CLUSTER_SCOPED, clone, cpuMilli, memMi, parseSelector, selects, suffix, iso, podRequests } from './k8s.js';
import { syncVolumes } from './docker.js';
import { identityFor, saIdentity, authorize, forbidden, rulesFor, issueToken } from './rbac.js';
import { kustomizeBuild, hostFiles } from './kustomize.js';

const KINDS = {
  po: 'Pod', pod: 'Pod', pods: 'Pod',
  deploy: 'Deployment', deployment: 'Deployment', deployments: 'Deployment', 'deployment.apps': 'Deployment', 'deployments.apps': 'Deployment',
  rs: 'ReplicaSet', replicaset: 'ReplicaSet', replicasets: 'ReplicaSet',
  sts: 'StatefulSet', statefulset: 'StatefulSet', statefulsets: 'StatefulSet',
  svc: 'Service', service: 'Service', services: 'Service',
  cm: 'ConfigMap', configmap: 'ConfigMap', configmaps: 'ConfigMap',
  secret: 'Secret', secrets: 'Secret',
  ns: 'Namespace', namespace: 'Namespace', namespaces: 'Namespace',
  no: 'Node', node: 'Node', nodes: 'Node',
  ing: 'Ingress', ingress: 'Ingress', ingresses: 'Ingress',
  hpa: 'HorizontalPodAutoscaler', horizontalpodautoscaler: 'HorizontalPodAutoscaler', horizontalpodautoscalers: 'HorizontalPodAutoscaler',
  ep: 'Endpoints', endpoints: 'Endpoints',
  ev: 'Event', event: 'Event', events: 'Event',
  pvc: 'PersistentVolumeClaim', persistentvolumeclaim: 'PersistentVolumeClaim', persistentvolumeclaims: 'PersistentVolumeClaim',
  job: 'Job', jobs: 'Job',
  cj: 'CronJob', cronjob: 'CronJob', cronjobs: 'CronJob',
  sa: 'ServiceAccount', serviceaccount: 'ServiceAccount', serviceaccounts: 'ServiceAccount',
  role: 'Role', roles: 'Role', 'roles.rbac.authorization.k8s.io': 'Role',
  clusterrole: 'ClusterRole', clusterroles: 'ClusterRole',
  rolebinding: 'RoleBinding', rolebindings: 'RoleBinding',
  clusterrolebinding: 'ClusterRoleBinding', clusterrolebindings: 'ClusterRoleBinding',
  netpol: 'NetworkPolicy', networkpolicy: 'NetworkPolicy', networkpolicies: 'NetworkPolicy',
  crd: 'CustomResourceDefinition', crds: 'CustomResourceDefinition', customresourcedefinition: 'CustomResourceDefinition', customresourcedefinitions: 'CustomResourceDefinition',
  quota: 'ResourceQuota', resourcequota: 'ResourceQuota', resourcequotas: 'ResourceQuota',
};
const PLURAL = { ServiceAccount: 'serviceaccounts', Role: 'roles.rbac.authorization.k8s.io', ClusterRole: 'clusterroles.rbac.authorization.k8s.io', RoleBinding: 'rolebindings.rbac.authorization.k8s.io', ClusterRoleBinding: 'clusterrolebindings.rbac.authorization.k8s.io', NetworkPolicy: 'networkpolicies.networking.k8s.io', CustomResourceDefinition: 'customresourcedefinitions.apiextensions.k8s.io', ResourceQuota: 'resourcequotas', CronJob: 'cronjobs.batch', Pod: 'pods', Deployment: 'deployments.apps', ReplicaSet: 'replicasets.apps', StatefulSet: 'statefulsets.apps', Service: 'services', ConfigMap: 'configmaps', Secret: 'secrets', Namespace: 'namespaces', Node: 'nodes', Ingress: 'ingresses.networking.k8s.io', HorizontalPodAutoscaler: 'horizontalpodautoscalers.autoscaling', Endpoints: 'endpoints', PersistentVolumeClaim: 'persistentvolumeclaims', Job: 'jobs.batch', Event: 'events' };
const SINGULAR = { ServiceAccount: 'serviceaccount', Role: 'role.rbac.authorization.k8s.io', ClusterRole: 'clusterrole.rbac.authorization.k8s.io', RoleBinding: 'rolebinding.rbac.authorization.k8s.io', ClusterRoleBinding: 'clusterrolebinding.rbac.authorization.k8s.io', NetworkPolicy: 'networkpolicy.networking.k8s.io', CustomResourceDefinition: 'customresourcedefinition.apiextensions.k8s.io', ResourceQuota: 'resourcequota', CronJob: 'cronjob.batch', Pod: 'pod', Deployment: 'deployment.apps', ReplicaSet: 'replicaset.apps', StatefulSet: 'statefulset.apps', Service: 'service', ConfigMap: 'configmap', Secret: 'secret', Namespace: 'namespace', Node: 'node', Ingress: 'ingress.networking.k8s.io', HorizontalPodAutoscaler: 'horizontalpodautoscaler.autoscaling', Endpoints: 'endpoints', PersistentVolumeClaim: 'persistentvolumeclaim', Job: 'job.batch' };

// kinds a CRD added (Application, ClusterPolicy, ExternalSecret…) resolve per cluster
export function kindOf(cl, t) {
  const k = String(t || '').toLowerCase();
  if (KINDS[k]) return KINDS[k];
  for (const [kind, c] of cl?.crds || []) if ([c.plural, c.singular, kind.toLowerCase(), ...c.shortNames, `${c.plural}.${c.group}`, `${c.singular}.${c.group}`].includes(k)) return kind;
  return null;
}
export const pluralOf = (cl, kind) => !kind ? undefined : PLURAL[kind] || (cl?.crds.get(kind) ? `${cl.crds.get(kind).plural}.${cl.crds.get(kind).group}` : kind.toLowerCase() + 's');
export const singularOf = (cl, kind) => !kind ? undefined : SINGULAR[kind] || (cl?.crds.get(kind) ? `${cl.crds.get(kind).singular}.${cl.crds.get(kind).group}` : kind.toLowerCase());
// other modules teach `kubectl get` and `describe` their kinds: PRINTERS[kind] = (cl, items) => [head, rows]
export const PRINTERS = {};
export const DESCRIBERS = {};

// ---------------------------------------------------------------- output helpers
export function age(uni, t) {
  const s = Math.max(0, Math.round(uni.time - t));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (s < 600) return `${m}m${s % 60 ? (s % 60) + 's' : ''}`;
  if (s < 3 * 3600) return `${m}m`;
  const hh = Math.floor(s / 3600);
  if (s < 8 * 3600) return `${hh}h${m % 60 ? (m % 60) + 'm' : ''}`;
  if (s < 2 * 86400) return `${hh}h`;
  const d = Math.floor(s / 86400);
  if (s < 8 * 86400) return `${d}d${hh % 24 ? (hh % 24) + 'h' : ''}`;
  return `${d}d`;
}
export function table(head, rows) {
  const w = head.map((hd, k) => Math.max(hd.length, ...rows.map(r => String(r[k] ?? '').length)));
  return [head.map((hd, k) => hd.padEnd(w[k])).join('   ').trimEnd(), ...rows.map(r => r.map((v, k) => String(v ?? '').padEnd(w[k])).join('   ').trimEnd())];
}

const needsQuote = s => s === '' || /^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|yes|no|null|~|on|off)$|^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s);
export function toYaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map(x => {
      if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length) {
        const body = toYaml(x, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      }
      return `${pad}- ${scalarYaml(x, indent + 2)}`;
    }).join('\n');
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    if (!keys.length) return '{}';
    return keys.map(k => {
      const x = v[k];
      const key = needsQuote(k) || /[:]/.test(k) ? JSON.stringify(k) : k;
      if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).filter(q => x[q] !== undefined).length)) return `${pad}${key}:\n${toYaml(x, Array.isArray(x) ? indent : indent + 2)}`;
      return `${pad}${key}: ${Array.isArray(x) ? '[]' : x && typeof x === 'object' ? '{}' : scalarYaml(x, indent + 2)}`;
    }).join('\n');
  }
  return scalarYaml(v, indent);
}
function scalarYaml(x, indent) {
  if (typeof x === 'string') {
    if (x.includes('\n')) return '|' + (x.endsWith('\n') ? '' : '-') + '\n' + x.replace(/\n$/, '').split('\n').map(l => ' '.repeat(indent) + l).join('\n');
    return needsQuote(x) ? `"${x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : x;
  }
  return String(x);
}

function jsonpath(obj, expr) {
  const e = expr.replace(/^\{|\}$/g, '').trim();
  if (e.startsWith('range')) return '';
  const path = e.replace(/^\.?/, '').split(/\.(?![^[]*\])/).filter(Boolean);
  let vals = [obj];
  for (const seg of path) {
    const m = seg.match(/^([^[]*)(?:\[(\*|\d+)\])?$/);
    if (!m) return '';
    vals = vals.flatMap(v => { let x = m[1] ? v?.[m[1]] : v; if (m[2] === '*') return Array.isArray(x) ? x : []; if (m[2] !== undefined) return [x?.[Number(m[2])]]; return [x]; });
  }
  return vals.filter(v => v !== undefined).map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ');
}

// what the API returns (status included, runtime fields stripped)
function view(cl, o) {
  const x = clone(o);
  if (x.status) for (const k of Object.keys(x.status)) if (['progressStart', 'deadlineReported', 'warned', 'lastScale', 'lowSince'].includes(k) || k.startsWith('__')) delete x.status[k];
  if (x.metadata?.creationTimestamp !== undefined) x.metadata.creationTimestamp = iso(x.metadata.creationTimestamp);
  if (x.metadata?.deletionTimestamp !== undefined) x.metadata.deletionTimestamp = iso(x.metadata.deletionTimestamp);
  x.metadata.resourceVersion = String(1000 + (x.metadata.generation || 1) * 7 + (o.metadata.name.length * 13));
  return { apiVersion: x.apiVersion, kind: x.kind, metadata: x.metadata, ...Object.fromEntries(Object.entries(x).filter(([k]) => !['apiVersion', 'kind', 'metadata'].includes(k))) };
}

// ---------------------------------------------------------------- status text
export function podStatusText(cl, p) {
  const rt = cl.rt.get(p.metadata.uid);
  if (p.metadata.deletionTimestamp) return 'Terminating';
  if (!rt || !rt.node) return 'Pending';
  for (const c of rt.containers) {
    if (c.state === 'waiting') return c.reason || 'ContainerCreating';
    if (c.state === 'terminated') return c.reason || 'Error';
  }
  if (!rt.containers.length) return 'ContainerCreating';
  if (p.status.phase === 'Succeeded') return 'Completed';
  return 'Running';
}
function podRow(cl, p, wide) {
  const rt = cl.rt.get(p.metadata.uid);
  const cs = rt?.containers || [];
  const ready = `${cs.filter(c => c.ready && c.state === 'running').length}/${p.spec.containers.length}`;
  const restarts = cs.reduce((s, c) => s + c.restartCount, 0);
  const lastRestart = Math.max(0, ...cs.map(c => c.restartCount ? (c.startedAt || c.lastState?.finishedAt || 0) : 0));
  const row = [p.metadata.name, ready, podStatusText(cl, p), restarts ? `${restarts} (${age(cl.uni, lastRestart)} ago)` : '0', age(cl.uni, p.metadata.creationTimestamp)];
  if (wide) row.push(rt?.ip || '<none>', rt?.node?.name || '<none>', '<none>', '<none>');
  return row;
}

function rows(cl, kind, items, { wide = false, showLabels = false, allNs = false, prefix = '' } = {}) {
  const uni = cl.uni;
  let head, data;
  if (prefix) items = items.map(o => new Proxy(o, { get: (t, k) => k === 'metadata' ? { ...t.metadata, name: prefix + t.metadata.name, __real: t.metadata.name } : t[k] }));
  switch (kind) {
    case 'Pod': head = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : [])]; data = items.map(p => podRow(cl, p, wide)); break;
    case 'Deployment': head = ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])]; data = items.map(d => [d.metadata.name, `${d.status.readyReplicas || 0}/${d.spec.replicas}`, d.status.updatedReplicas || 0, d.status.availableReplicas || 0, age(uni, d.metadata.creationTimestamp), ...(wide ? [d.spec.template.spec.containers.map(c => c.name).join(','), d.spec.template.spec.containers.map(c => c.image).join(','), Object.entries(d.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',')] : [])]); break;
    case 'ReplicaSet': head = ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES'] : [])]; data = items.map(r => [r.metadata.name, r.spec.replicas, r.status.replicas || 0, r.status.readyReplicas || 0, age(uni, r.metadata.creationTimestamp), ...(wide ? [r.spec.template.spec.containers.map(c => c.name).join(','), r.spec.template.spec.containers.map(c => c.image).join(',')] : [])]); break;
    case 'StatefulSet': head = ['NAME', 'READY', 'AGE']; data = items.map(s => [s.metadata.name, `${s.status.readyReplicas || 0}/${s.spec.replicas}`, age(uni, s.metadata.creationTimestamp)]); break;
    case 'Service': head = ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE', ...(wide ? ['SELECTOR'] : [])]; data = items.map(s => [s.metadata.name, s.spec.type, s.spec.clusterIP, s.spec.type === 'LoadBalancer' ? (s.status.loadBalancer?.ingress?.[0]?.ip || '<pending>') : '<none>', s.spec.ports.map(p => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol || 'TCP'}`).join(','), age(uni, s.metadata.creationTimestamp), ...(wide ? [s.spec.selector ? Object.entries(s.spec.selector).map(([k, v]) => `${k}=${v}`).join(',') : '<none>'] : [])]); break;
    case 'ConfigMap': head = ['NAME', 'DATA', 'AGE']; data = items.map(o => [o.metadata.name, Object.keys(o.data || {}).length, age(uni, o.metadata.creationTimestamp)]); break;
    case 'Secret': head = ['NAME', 'TYPE', 'DATA', 'AGE']; data = items.map(o => [o.metadata.name, o.type, Object.keys(o.data || {}).length, age(uni, o.metadata.creationTimestamp)]); break;
    case 'Namespace': head = ['NAME', 'STATUS', 'AGE']; data = items.map(o => [o.metadata.name, 'Active', age(uni, o.metadata.creationTimestamp)]); break;
    case 'Node': head = ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(wide ? ['INTERNAL-IP', 'OS-IMAGE', 'CONTAINER-RUNTIME'] : [])]; data = items.map(o => [o.metadata.name, o.spec.unschedulable ? 'Ready,SchedulingDisabled' : 'Ready', 'node-role.kubernetes.io/control-plane' in o.metadata.labels ? 'control-plane' : '<none>', age(uni, o.metadata.creationTimestamp), o.status.nodeInfo?.kubeletVersion, ...(wide ? [o.status.addresses?.[0]?.address, o.status.nodeInfo?.osImage || 'Debian GNU/Linux 12 (bookworm)', o.status.nodeInfo?.containerRuntimeVersion || 'containerd://1.7.22'] : [])]); break;
    case 'Ingress': head = ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE']; data = items.map(o => [o.metadata.name, o.spec.ingressClassName || '<none>', (o.spec.rules || []).map(r => r.host || '*').join(',') || '*', o.status.loadBalancer?.ingress?.[0]?.ip || '', '80', age(uni, o.metadata.creationTimestamp)]); break;
    case 'HorizontalPodAutoscaler': head = ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE']; data = items.map(o => { const tgt = o.spec.metrics?.find(m => m.resource?.name === 'cpu')?.resource?.target?.averageUtilization ?? 80; return [o.metadata.name, `${o.spec.scaleTargetRef.kind || 'Deployment'}/${o.spec.scaleTargetRef.name}`, `cpu: ${o.status.currentUtilization == null ? '<unknown>' : o.status.currentUtilization + '%'}/${tgt}%`, o.spec.minReplicas || 1, o.spec.maxReplicas, o.status.currentReplicas ?? 0, age(uni, o.metadata.creationTimestamp)]; }); break;
    case 'Endpoints': head = ['NAME', 'ENDPOINTS', 'AGE']; data = items.map(o => { const eps = (o.subsets || []).flatMap(s => s.addresses.flatMap(a => s.ports.map(p => `${a.ip}:${p.port}`))); return [o.metadata.name, eps.length ? eps.slice(0, 3).join(',') + (eps.length > 3 ? ` + ${eps.length - 3} more...` : '') : '<none>', age(uni, o.metadata.creationTimestamp)]; }); break;
    case 'PersistentVolumeClaim': head = ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE']; data = items.map(o => [o.metadata.name, o.status.phase, o.spec.volumeName, o.status.capacity?.storage, 'RWO', o.spec.storageClassName, '<unset>', age(uni, o.metadata.creationTimestamp)]); break;
    case 'Job': head = ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE']; data = items.map(o => [o.metadata.name, o.status.completionTime ? 'Complete' : o.status.failed > o.spec.backoffLimit ? 'Failed' : 'Running', `${o.status.succeeded || 0}/${o.spec.completions}`, age(uni, o.status.startTime ?? o.metadata.creationTimestamp).replace(/^(\d+s)$/, '$1'), age(uni, o.metadata.creationTimestamp)]); break;
    case 'ServiceAccount': head = ['NAME', 'SECRETS', 'AGE']; data = items.map(o => [o.metadata.name, 0, age(uni, o.metadata.creationTimestamp)]); break;
    case 'Role': case 'ClusterRole': head = ['NAME', 'CREATED AT']; data = items.map(o => [o.metadata.name, iso(o.metadata.creationTimestamp)]); break;
    case 'RoleBinding': case 'ClusterRoleBinding': head = ['NAME', 'ROLE', 'AGE', ...(wide ? ['USERS', 'GROUPS', 'SERVICEACCOUNTS'] : [])]; data = items.map(o => [o.metadata.name, `${o.roleRef.kind}/${o.roleRef.name}`, age(uni, o.metadata.creationTimestamp), ...(wide ? ['User', 'Group'].map(k => (o.subjects || []).filter(x => x.kind === k).map(x => x.name).join(', ')).concat([(o.subjects || []).filter(x => x.kind === 'ServiceAccount').map(x => `${x.namespace || o.metadata.namespace}/${x.name}`).join(', ')]) : [])]); break;
    case 'NetworkPolicy': head = ['NAME', 'POD-SELECTOR', 'AGE']; data = items.map(o => [o.metadata.name, Object.entries(o.spec.podSelector?.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>', age(uni, o.metadata.creationTimestamp)]); break;
    case 'CustomResourceDefinition': head = ['NAME', 'CREATED AT']; data = items.map(o => [o.metadata.name, iso(o.metadata.creationTimestamp)]); break;
    default:
      if (PRINTERS[kind]) [head, data] = PRINTERS[kind](cl, items, { wide });
      else { head = ['NAME', 'AGE']; data = items.map(o => [o.metadata.name, age(uni, o.metadata.creationTimestamp)]); }
  }
  if (allNs && !CLUSTER_SCOPED.has(kind)) { head = ['NAMESPACE', ...head]; data = data.map((r, k) => [items[k].metadata.namespace, ...r]); }
  if (showLabels) { head = [...head, 'LABELS']; data = data.map((r, k) => [...r, Object.entries(items[k].metadata.labels || {}).map(([a, b]) => `${a}=${b}`).join(',') || '<none>']); }
  return table(head, data);
}

// ---------------------------------------------------------------- describe
function describe(cl, o) {
  const uni = cl.uni;
  const L = [];
  const kv = (k, v) => L.push(`${(k + ':').padEnd(Math.max(16, k.length + 3))}${v ?? '<none>'}`);
  const labels = (k, m) => { const e = Object.entries(m || {}); if (!e.length) return kv(k, '<none>'); kv(k, `${e[0][0]}=${e[0][1]}`); for (const [a, b] of e.slice(1)) L.push(`${''.padEnd(16)}${a}=${b}`); };
  const events = () => {
    const ev = cl.eventsFor(o).slice(-12);
    if (!ev.length) { L.push('Events:          <none>'); return; }
    const rowsE = [['Type', 'Reason', 'Age', 'From', 'Message'], ['----', '------', '----', '----', '-------'], ...ev.map(e => [e.type, e.reason, e.count > 1 ? `${age(uni, e.last)} (x${e.count} over ${age(uni, e.first)})` : age(uni, e.first), { Pod: ['Scheduled', 'FailedScheduling'].includes(e.reason) ? 'default-scheduler' : 'kubelet', Deployment: 'deployment-controller', ReplicaSet: 'replicaset-controller', HorizontalPodAutoscaler: 'horizontal-pod-autoscaler', Service: 'service-controller', Job: 'job-controller', StatefulSet: 'statefulset-controller' }[o.kind] || 'kubelet', e.message])];
    const w = [0, 1, 2, 3].map(k => Math.max(...rowsE.map(r => r[k].length)));
    L.push('Events:', ...rowsE.map(r => '  ' + r.map((v, k) => k < 4 ? v.padEnd(w[k] + 2) : v).join('').trimEnd()));
  };
  const containerBlock = (spec, rtc, indent = '  ') => {
    L.push(`${indent}${spec.name}:`);
    const p = (k, v) => L.push(`${indent}  ${(k + ':').padEnd(Math.max(16, k.length + 3))}${v}`);
    p('Image', spec.image);
    if (spec.ports?.length) p('Port', spec.ports.map(x => `${x.containerPort}/TCP`).join(', '));
    if (spec.command) p('Command', spec.command.join(' '));
    if (spec.args) p('Args', spec.args.join(' '));
    if (rtc) {
      if (rtc.state === 'running') { p('State', 'Running'); p('  Started', new Date(rtc.startedAt * 1000).toUTCString()); }
      else if (rtc.state === 'waiting') { p('State', 'Waiting'); p('  Reason', rtc.reason || 'ContainerCreating'); if (rtc.message) p('  Message', rtc.message); }
      else { p('State', 'Terminated'); p('  Reason', rtc.reason); p('  Exit Code', rtc.exitCode); }
      if (rtc.lastState) { p('Last State', 'Terminated'); p('  Reason', rtc.lastState.reason); p('  Exit Code', rtc.lastState.exitCode); }
      p('Ready', rtc.ready && rtc.state === 'running' ? 'True' : 'False');
      p('Restart Count', rtc.restartCount);
    }
    if (spec.resources?.limits) { L.push(`${indent}  Limits:`); for (const [k, v] of Object.entries(spec.resources.limits)) L.push(`${indent}    ${k}:  ${v}`); }
    if (spec.resources?.requests) { L.push(`${indent}  Requests:`); for (const [k, v] of Object.entries(spec.resources.requests)) L.push(`${indent}    ${k}:  ${v}`); }
    const probe = (name, pr) => { if (!pr) return; const how = pr.httpGet ? `http-get http://:${pr.httpGet.port}${pr.httpGet.path || '/'}` : pr.tcpSocket ? `tcp-socket :${pr.tcpSocket.port}` : `exec [${(pr.exec?.command || []).join(' ')}]`; p(name, `${how} delay=${pr.initialDelaySeconds || 0}s timeout=${pr.timeoutSeconds || 1}s period=${pr.periodSeconds || 10}s #success=1 #failure=${pr.failureThreshold || 3}`); };
    probe('Liveness', spec.livenessProbe); probe('Readiness', spec.readinessProbe);
    const env = spec.env || [];
    if (env.length || spec.envFrom) {
      L.push(`${indent}  Environment:`);
      for (const e of env) L.push(`${indent}    ${e.name}:  ${'value' in e ? e.value : e.valueFrom?.secretKeyRef ? `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>  Optional: false` : e.valueFrom?.configMapKeyRef ? `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>  Optional: false` : '(v1:metadata.name)'}`);
      for (const ef of spec.envFrom || []) L.push(`${indent}    ${ef.configMapRef ? `${ef.configMapRef.name}  ConfigMap` : `${ef.secretRef?.name}  Secret`}  Optional: false`);
    } else L.push(`${indent}  Environment:  <none>`);
    if (spec.volumeMounts?.length) { L.push(`${indent}  Mounts:`); for (const m of spec.volumeMounts) L.push(`${indent}    ${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'})`); }
  };
  if (o.kind !== 'Node' && o.kind !== 'Namespace') { kv('Name', o.metadata.name); kv('Namespace', o.metadata.namespace); }
  else kv('Name', o.metadata.name);
  switch (o.kind) {
    case 'Pod': {
      const rt = cl.rt.get(o.metadata.uid);
      L.push('Priority:         0', `Service Account:  ${o.spec.serviceAccountName || 'default'}`);
      kv('Node', rt?.node ? `${rt.node.name}/${rt.node.host.ip}` : '<none>');
      kv('Start Time', rt?.node ? new Date(o.metadata.creationTimestamp * 1000).toUTCString() : '<none>');
      labels('Labels', o.metadata.labels);
      kv('Annotations', '<none>');
      kv('Status', podStatusText(cl, o) === 'Terminating' ? 'Terminating' : o.status.phase);
      kv('IP', rt?.ip || '');
      const owner = cl.ownerOf(o);
      kv('Controlled By', owner ? `${owner.kind}/${owner.metadata.name}` : undefined);
      L.push('Containers:');
      for (const spec of o.spec.containers) containerBlock(spec, rt?.containers.find(c => c.name === spec.name));
      L.push('Conditions:', '  Type              Status', ...(o.status.conditions || []).map(c => `  ${c.type.padEnd(18)}${c.status}`));
      if (o.spec.volumes?.length) { L.push('Volumes:'); for (const v of o.spec.volumes) L.push(`  ${v.name}:`, `    Type:       ${v.configMap ? 'ConfigMap (a volume populated by a ConfigMap)' : v.secret ? 'Secret (a volume populated by a Secret)' : v.persistentVolumeClaim ? 'PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)' : 'EmptyDir (a temporary directory that shares a pod\'s lifetime)'}`, `    ${v.configMap ? `Name:       ${v.configMap.name}` : v.secret ? `SecretName: ${v.secret.secretName}` : v.persistentVolumeClaim ? `ClaimName:  ${v.persistentVolumeClaim.claimName}` : 'Medium:'}`); }
      L.push(`QoS Class:        ${o.status.qosClass || 'BestEffort'}`, 'Node-Selectors:   <none>', 'Tolerations:      node.kubernetes.io/not-ready:NoExecute op=Exists for 300s');
      events();
      break;
    }
    case 'Deployment': {
      kv('CreationTimestamp', new Date(o.metadata.creationTimestamp * 1000).toUTCString());
      labels('Labels', o.metadata.labels);
      kv('Annotations', `deployment.kubernetes.io/revision: ${o.metadata.annotations?.['deployment.kubernetes.io/revision'] || 1}`);
      kv('Selector', Object.entries(o.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(','));
      kv('Replicas', `${o.spec.replicas} desired | ${o.status.updatedReplicas || 0} updated | ${o.status.replicas || 0} total | ${o.status.availableReplicas || 0} available | ${o.status.unavailableReplicas || 0} unavailable`);
      kv('StrategyType', o.spec.strategy.type || 'RollingUpdate');
      kv('MinReadySeconds', 0);
      if ((o.spec.strategy.type || 'RollingUpdate') === 'RollingUpdate') kv('RollingUpdateStrategy', `${o.spec.strategy.rollingUpdate?.maxUnavailable ?? '25%'} max unavailable, ${o.spec.strategy.rollingUpdate?.maxSurge ?? '25%'} max surge`);
      L.push('Pod Template:');
      labels('  Labels', o.spec.template.metadata?.labels);
      L.push('  Containers:');
      for (const spec of o.spec.template.spec.containers) containerBlock(spec, null, '   ');
      L.push('Conditions:', '  Type           Status  Reason', '  ----           ------  ------', ...(o.status.conditions || []).map(c => `  ${c.type.padEnd(15)}${c.status.padEnd(8)}${c.reason}`));
      const rss = cl.list('ReplicaSet', o.metadata.namespace).filter(r => r.metadata.ownerReferences?.some(x => x.uid === o.metadata.uid));
      const cur = rss.find(r => r.metadata.annotations['deployment.kubernetes.io/revision'] === o.metadata.annotations?.['deployment.kubernetes.io/revision']);
      const olds = rss.filter(r => r !== cur && r.spec.replicas > 0);
      kv('OldReplicaSets', olds.length ? olds.map(r => `${r.metadata.name} (${r.status.replicas || 0}/${r.spec.replicas} replicas created)`).join(', ') : '<none>');
      kv('NewReplicaSet', cur ? `${cur.metadata.name} (${cur.status.replicas || 0}/${cur.spec.replicas} replicas created)` : '<none>');
      events();
      break;
    }
    case 'Service': {
      labels('Labels', o.metadata.labels);
      kv('Annotations', '<none>');
      kv('Selector', o.spec.selector ? Object.entries(o.spec.selector).map(([k, v]) => `${k}=${v}`).join(',') : '<none>');
      kv('Type', o.spec.type);
      kv('IP Family Policy', 'SingleStack');
      kv('IP', o.spec.clusterIP);
      if (o.status.loadBalancer?.ingress) kv('LoadBalancer Ingress', o.status.loadBalancer.ingress[0].ip);
      const ep = cl.get('Endpoints', o.metadata.namespace, o.metadata.name);
      for (const p of o.spec.ports) {
        kv('Port', `${p.name || '<unset>'}  ${p.port}/TCP`);
        kv('TargetPort', `${p.targetPort}/TCP`);
        if (p.nodePort) kv('NodePort', `${p.name || '<unset>'}  ${p.nodePort}/TCP`);
        const eps = (ep?.subsets || []).flatMap(s => s.addresses.map(a => `${a.ip}:${s.ports.find(q => q.name === p.name)?.port ?? s.ports[0]?.port}`));
        kv('Endpoints', eps.length ? eps.join(',') : '');
      }
      kv('Session Affinity', 'None');
      events();
      break;
    }
    case 'Node': {
      const n = cl.nodes.find(x => x.name === o.metadata.name);
      labels('Labels', o.metadata.labels);
      kv('CreationTimestamp', new Date(o.metadata.creationTimestamp * 1000).toUTCString());
      kv('Taints', o.spec.taints?.map(t => `${t.key}:${t.effect}`).join(', ') || '<none>');
      kv('Unschedulable', o.spec.unschedulable ? 'true' : 'false');
      L.push('Capacity:', `  cpu:     ${o.status.capacity.cpu}`, `  memory:  ${o.status.capacity.memory}`, `  pods:    110`, 'Allocatable:', `  cpu:     ${o.status.allocatable.cpu}`, `  memory:  ${o.status.allocatable.memory}`, `  pods:    110`);
      if (n) {
        const pods = cl.list('Pod').filter(p => cl.rt.get(p.metadata.uid)?.node === n);
        L.push(`Non-terminated Pods:          (${pods.length} in total)`, ...table(['  Namespace', 'Name', 'CPU Requests', 'Memory Requests', 'Age'], pods.map(p => { const r = podRequests(p); return [`  ${p.metadata.namespace}`, p.metadata.name, `${r.cpu}m (${Math.round(r.cpu / n.cpu * 100)}%)`, `${Math.round(r.mem)}Mi (${Math.round(r.mem / n.memMi * 100)}%)`, age(uni, p.metadata.creationTimestamp)]; })));
        const tot = pods.reduce((s, p) => { const r = podRequests(p); return { cpu: s.cpu + r.cpu, mem: s.mem + r.mem }; }, { cpu: 0, mem: 0 });
        L.push('Allocated resources:', '  (Total limits may be over 100 percent, i.e., overcommitted.)', '  Resource           Requests', '  --------           --------', `  cpu                ${tot.cpu}m (${Math.round(tot.cpu / n.cpu * 100)}%)`, `  memory             ${Math.round(tot.mem)}Mi (${Math.round(tot.mem / n.memMi * 100)}%)`);
      }
      events();
      break;
    }
    case 'ConfigMap': case 'Secret': {
      labels('Labels', o.metadata.labels);
      kv('Annotations', '<none>');
      if (o.kind === 'Secret') { L.push('', `Type:  ${o.type}`, '', 'Data', '===='); for (const [k, v] of Object.entries(o.data || {})) L.push(`${k}:  ${atob(v).length} bytes`); }
      else { L.push('', 'Data', '===='); for (const [k, v] of Object.entries(o.data || {})) L.push(`${k}:`, '----', String(v), ''); L.push('', 'BinaryData', '====', ''); }
      L.push('Events:  <none>');
      break;
    }
    case 'Ingress': {
      labels('Labels', o.metadata.labels);
      kv('Address', o.status.loadBalancer?.ingress?.[0]?.ip || '');
      kv('Ingress Class', o.spec.ingressClassName || '<none>');
      L.push('Default backend:  <default>', 'Rules:', '  Host        Path  Backends', '  ----        ----  --------');
      for (const r of o.spec.rules || []) for (const p of r.http?.paths || []) { const s = cl.get('Service', o.metadata.namespace, p.backend.service.name); const eps = s ? cl.endpoints(s).map(e => `${e.ip}:${e.target(s.spec.ports.find(q => q.port === p.backend.service.port?.number)?.targetPort ?? p.backend.service.port?.number)}`) : []; L.push(`  ${(r.host || '*').padEnd(12)}`, `              ${p.path || '/'}   ${p.backend.service.name}:${p.backend.service.port?.number ?? p.backend.service.port?.name} (${s ? (eps.join(',') || '<none>') : `<error: services "${p.backend.service.name}" not found>`})`); }
      events();
      break;
    }
    case 'HorizontalPodAutoscaler': {
      kv('Reference', `${o.spec.scaleTargetRef.kind || 'Deployment'}/${o.spec.scaleTargetRef.name}`);
      const tgt = o.spec.metrics?.find(m => m.resource?.name === 'cpu')?.resource?.target?.averageUtilization ?? 80;
      L.push('Metrics:                                               ( current / target )', `  resource cpu on pods  (as a percentage of request):  ${o.status.currentUtilization == null ? '<unknown>' : o.status.currentUtilization + '%'} / ${tgt}%`);
      kv('Min replicas', o.spec.minReplicas || 1); kv('Max replicas', o.spec.maxReplicas);
      kv('Deployment pods', `${o.status.currentReplicas ?? 0} current / ${o.status.desiredReplicas ?? o.status.currentReplicas ?? 0} desired`);
      events();
      break;
    }
    case 'Role': case 'ClusterRole': {
      labels('Labels', o.metadata.labels);
      kv('Annotations', '<none>');
      L.push('PolicyRule:', ...table(['  Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], [['  ---------', '-----------------', '--------------', '-----'], ...(o.rules || []).flatMap(r => (r.resources || []).map(res => [`  ${res}${(r.apiGroups || []).filter(Boolean).length && res !== '*' ? '.' + r.apiGroups.filter(Boolean).join(',') : ''}`, '[]', `[${(r.resourceNames || []).join(' ')}]`, `[${(r.verbs || []).join(' ')}]`]))]).slice(0));
      break;
    }
    case 'RoleBinding': case 'ClusterRoleBinding': {
      labels('Labels', o.metadata.labels);
      kv('Annotations', '<none>');
      L.push('Role:', `  Kind:  ${o.roleRef.kind}`, `  Name:  ${o.roleRef.name}`, 'Subjects:', ...table(['  Kind', 'Name', 'Namespace'], [['  ----', '----', '---------'], ...(o.subjects || []).map(x => [`  ${x.kind}`, x.name, x.namespace || ''])]));
      break;
    }
    case 'NetworkPolicy': {
      kv('Created on', new Date(o.metadata.creationTimestamp * 1000).toUTCString());
      labels('Labels', o.metadata.labels);
      kv('Annotations', '<none>');
      L.push('Spec:', `  PodSelector:     ${Object.entries(o.spec.podSelector?.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none> (Allowing the specific traffic to all pods in this namespace)'}`);
      const peer = pe => pe.ipBlock ? [`      IPBlock:`, `        CIDR: ${pe.ipBlock.cidr}`, `        Except: ${(pe.ipBlock.except || []).join(', ')}`] : [...(pe.namespaceSelector ? [`      NamespaceSelector: ${Object.entries(pe.namespaceSelector.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>'}`] : []), ...(pe.podSelector ? [`      PodSelector: ${Object.entries(pe.podSelector.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>'}`] : [])];
      const ports = r => (r.ports || []).length ? r.ports.map(p => `    To Port: ${p.port ?? '<any> (traffic allowed to all ports)'}/${p.protocol || 'TCP'}`) : ['    To Port: <any> (traffic allowed to all ports)'];
      const types = o.spec.policyTypes || (o.spec.egress ? ['Ingress', 'Egress'] : ['Ingress']);
      if (types.includes('Ingress')) { L.push('  Allowing ingress traffic:'); if (!(o.spec.ingress || []).length) L.push('    <none> (Selected pods are isolated for ingress connectivity)'); for (const r of o.spec.ingress || []) { L.push(...ports(r), '    From:'); if (!(r.from || []).length) L.push('      <any> (traffic not restricted by source)'); for (const pe of r.from || []) L.push(...peer(pe)); } }
      else L.push('  Not affecting ingress traffic');
      if (types.includes('Egress')) { L.push('  Allowing egress traffic:'); if (!(o.spec.egress || []).length) L.push('    <none> (Selected pods are isolated for egress connectivity)'); for (const r of o.spec.egress || []) { L.push(...ports(r).map(x => x.replace('To Port', 'To Port')), '    To:'); if (!(r.to || []).length) L.push('      <any> (traffic not restricted by destination)'); for (const pe of r.to || []) L.push(...peer(pe)); } }
      else L.push('  Not affecting egress traffic');
      L.push(`  Policy Types: ${types.join(', ')}`);
      break;
    }
    default:
      if (DESCRIBERS[o.kind]) { L.push(...DESCRIBERS[o.kind](cl, o, { kv, labels, events })); break; }
      labels('Labels', o.metadata.labels); L.push(...toYaml({ spec: o.spec }).split('\n')); events();
  }
  return L;
}

// ---------------------------------------------------------------- kubeconfig & connection
function kubeconfig(c) {
  const path = c.env.KUBECONFIG ? c.resolve(c.env.KUBECONFIG) : `${c.host.users.get(c.user)?.home || '/root'}/.kube/config`;
  const text = c.host.files.get(path);
  if (text === undefined) return { path, cfg: null };
  try { return { path, cfg: parseYaml(text) }; } catch (e) { return { path, cfg: null, error: `error: error loading config file "${path}": yaml: ${e.message}` }; }
}
function saveKubeconfig(c, path, cfg) { c.host.writeFile(path, toYaml(cfg) + '\n', c.user); }

export function clusterFor(c, flags) {
  const { path, cfg, error } = kubeconfig(c);
  if (error) return { error };
  if (!cfg) return { error: 'E1023 09:12:01.482100    4021 memcache.go:265] couldn\'t get current server API group list: Get "http://localhost:8080/api?timeout=32s": dial tcp 127.0.0.1:8080: connect: connection refused\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?' };
  const ctxName = flags.context || cfg['current-context'];
  const ctx = (cfg.contexts || []).find(x => x.name === ctxName);
  if (!ctx) return { error: `error: context "${ctxName}" does not exist` };
  const clEntry = (cfg.clusters || []).find(x => x.name === ctx.context?.cluster);
  if (!clEntry) return { error: `error: cluster "${ctx.context?.cluster}" does not exist` };
  const server = clEntry.cluster?.server || '';
  const m = server.match(/^https?:\/\/([^:/]+)(?::(\d+))?/);
  const ip = m ? c.uni.resolveName(m[1], c.host) : null;
  const cl = [...c.uni.clusters.values()].find(x => x.cp.ip === ip || x.cp.name === m?.[1]);
  const conn = m ? connect(c.uni, c.host, m[1], Number(m[2] || 443)) : { error: 'ENOTFOUND' };
  if (!cl || conn.error) return { error: `Unable to connect to the server: dial tcp ${ip || m?.[1]}:${m?.[2] || 443}: ${conn.error === 'ETIMEDOUT' ? 'i/o timeout' : conn.error === 'ENOTFOUND' ? `lookup ${m?.[1]}: no such host` : 'connect: connection refused'}` };
  const userName = flags.raw?.user ?? ctx.context?.user;
  const userEntry = (cfg.users || []).find(x => x.name === userName);
  const token = flags.raw?.token ?? userEntry?.user?.token ?? '';
  let ident = identityFor(cl, token);
  if (!ident) return { error: 'error: You must be logged in to the server (Unauthorized)' };
  const as = flags.raw?.as;
  if (as) {
    if (!ident.groups.includes('system:masters')) return { error: `Error from server (Forbidden): users "${as}" is forbidden: User "${ident.user || userName}" cannot impersonate resource "users" in API group "" at the cluster scope` };
    const m = as.match(/^system:serviceaccount:([^:]+):(.+)$/);
    ident = m ? saIdentity(m[1], m[2]) : { user: as, groups: [...(flags.all?.('--as-group') || []), 'system:authenticated'] };
  }
  const role = ident.legacyView ? 'view' : ident.groups.includes('system:masters') ? 'admin' : 'rbac';
  return { cl, ns: flags.namespace || ctx.context?.namespace || 'default', role, ident, user: ctx.context?.user, path, cfg };
}

// ---------------------------------------------------------------- argument parsing
const VALUE_FLAGS = new Set(['-n', '--namespace', '-o', '--output', '-l', '--selector', '-f', '--filename', '--context', '-c', '--container', '--tail', '--replicas', '--image', '--port', '--target-port', '--type', '--name', '--to-revision', '--from-literal', '--from-file', '--docker-server', '--docker-username', '--docker-password', '--docker-email', '--min', '--max', '--cpu-percent', '--timeout', '--for', '--restart', '--grace-period', '--field-selector', '--sort-by', '--since', '-p', '--patch', '--rule', '--class', '--env', '-e', '--overrides', '--revision', '--protocol', '--tcp', '--from-env-file', '--dry-run', '--cluster', '--user', '--server', '--token', '--as', '--subresource', '--as-group', '--verb', '--resource', '--resource-name', '--role', '--clusterrole', '--serviceaccount', '--group', '--duration', '-k', '--kustomize', '--certificate-authority', '--insecure-skip-tls-verify']);
const BOOL_FLAGS = new Set(['-A', '--all-namespaces', '-w', '--watch', '--show-labels', '-i', '-t', '-it', '-ti', '--stdin', '--tty', '--rm', '--all', '--force', '--previous', '--follow', '-F', '--now', '--wait', '--overwrite', '--current', '--record', '--no-headers', '-q', '--quiet', '--ignore-not-found', '--prefix', '--raw', '--recursive', '-R', '--minify', '--flatten', '--list', '--embed-certs']);

function parseArgs(args) {
  const f = { _: [], multi: {} };
  let rest = null;
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (a === '--') { rest = args.slice(i + 1); break; }
    if (a.startsWith('--') && a.includes('=')) { const k = a.slice(0, a.indexOf('=')); const v = a.slice(a.indexOf('=') + 1); f[k.replace(/^--/, '')] = v; (f.multi[k] = f.multi[k] || []).push(v); continue; }
    if (/^-[a-zA-Z]=/.test(a)) { const k = a.slice(0, 2); const v = a.slice(3); f[k] = v; (f.multi[k] = f.multi[k] || []).push(v); continue; }
    if (VALUE_FLAGS.has(a)) { const v = args[++i]; f[a.replace(/^--?/, '')] = v; f[a] = v; (f.multi[a] = f.multi[a] || []).push(v); continue; }
    if (BOOL_FLAGS.has(a) || /^-[a-zA-Z]{2,}$/.test(a)) { if (/^-[a-zA-Z]{2,}$/.test(a) && !BOOL_FLAGS.has(a)) for (const ch of a.slice(1)) f['-' + ch] = true; else f[a] = true; continue; }
    if (a.startsWith('-') && a.length > 1) { f[a] = true; continue; }
    f._.push(a);
  }
  const g = k => f[k];
  return {
    pos: f._, rest, raw: f,
    namespace: g('-n') ?? g('namespace'), allNs: !!(g('-A') || g('--all-namespaces')), output: g('-o') ?? g('output'), selector: g('-l') ?? g('selector'),
    files: [...(f.multi['-f'] || []), ...(f.multi['--filename'] || [])], context: g('context'), container: g('-c') ?? g('container'),
    has: k => !!f[k], val: k => f[k] ?? f[k.replace(/^--?/, '')], all: k => [...(f.multi[k] || [])],
  };
}

// "pod/web-1", "deploy web", "pods" → [{kind, name}]
function targets(pos, cl, ns) {
  if (!pos.length) return { error: 'error: you must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.' };
  if (pos[0].includes('/')) return { list: pos.map(x => { const [t, n] = x.split('/'); return { kind: kindOf(cl, t), type: t, name: n }; }) };
  const types = pos[0].split(',');
  const out = [];
  for (const t of types) {
    if (t === 'all') { for (const k of ['Pod', 'Service', 'Deployment', 'ReplicaSet', 'StatefulSet', 'HorizontalPodAutoscaler', 'Job']) out.push({ kind: k, all: true, type: 'all' }); continue; }
    const kind = kindOf(cl, t);
    if (!kind) return { error: `error: the server doesn't have a resource type "${t}"` };
    if (pos.length > 1) for (const n of pos.slice(1)) out.push({ kind, name: n, type: t }); else out.push({ kind, type: t });
  }
  for (const x of out) if (!x.kind) return { error: `error: the server doesn't have a resource type "${x.type}"` };
  return { list: out };
}

// -k DIR: build the kustomization; otherwise read -f files
function readInput(c, a) {
  const k = a.val('-k') ?? a.val('--kustomize');
  if (k) {
    const r = kustomizeBuild(hostFiles(c.host), c.resolve(k));
    return r.error ? { error: r.error } : { docs: r.docs.map(d => Object.assign(d, { __file: k })) };
  }
  return readManifests(c, a.files);
}

function readManifests(c, files) {
  const docs = [];
  for (const f of files) {
    let texts = [];
    if (f === '-') texts.push([String(c.stdin ?? ''), '-']);
    else if (/^https?:\/\//.test(f)) {
      const r = httpRequest(c.uni, c.host, f);
      if (r.error || r.status !== 200) return { error: `error: unable to read URL "${f}", server reported ${r.status ? r.status + ' ' : ''}${r.error || 'Not Found'}, status code=${r.status || 0}` };
      texts.push([r.body, f]);
    } else {
      const abs = c.resolve(f);
      if (c.host.isDir(abs)) { for (const [p, t] of c.host.files) if (dirname(p) === abs && /\.(ya?ml|json)$/.test(p)) texts.push([t, normPath(f + '/' + basename(p))]); }
      else if (c.host.files.has(abs)) texts.push([c.host.files.get(abs), f]);
      else return { error: `error: the path "${f}" does not exist` };
    }
    for (const [text, name] of texts) {
      for (const part of text.split(/^---\s*$/m)) {
        if (!part.trim() || /^\s*(#.*\n?)*\s*$/.test(part)) continue;
        let o;
        try { o = /^\s*[{[]/.test(part) ? JSON.parse(part) : parseYaml(part); } catch (e) { return { error: `error: error parsing ${name}: error converting YAML to JSON: yaml: ${e.message}` }; }
        if (o && o.kind === 'List' && Array.isArray(o.items)) for (const it of o.items) docs.push(Object.assign(it, { __file: name }));
        else if (o) docs.push(Object.assign(o, { __file: name }));
      }
    }
  }
  return { docs };
}

// advance the clock until a condition holds (rollout status, wait, delete)
function waitFor(c, cl, pred, timeout = 120, step = 2) {
  let waited = 0;
  while (!pred() && waited < timeout) { c.uni.advance(step); waited += step; }
  return pred();
}

let CUR = null; // the cluster the running kubectl command talks to
const resName = o => `${singularOf(CUR, o.kind)}/${o.metadata.name}`;

function findPodsFor(cl, ns, ref) {
  // ref: pod name, or deploy/x, svc/x
  if (ref.includes('/')) {
    const [t, n] = ref.split('/');
    const kind = kindOf(cl, t);
    if (kind === 'Pod') return [cl.get('Pod', ns, n)].filter(Boolean);
    const o = cl.get(kind, ns, n);
    if (!o) return null;
    const sel = o.spec.selector?.matchLabels || o.spec.selector;
    return cl.list('Pod', ns, sel).filter(p => !p.metadata.deletionTimestamp).sort((a, b) => (cl.podReady(b) ? 1 : 0) - (cl.podReady(a) ? 1 : 0));
  }
  return [cl.get('Pod', ns, ref)].filter(Boolean);
}

// the API requests a kubectl command makes, for RBAC: [{ verb, resource, group, ns, name }]
function requestsFor(cl, verb, pos, a, ns) {
  const R = (kind, v, name, sub) => { const r = cl.resourceOf(kind); return { verb: v, resource: r.resource + (sub ? '/' + sub : ''), group: r.group, ns: CLUSTER_SCOPED.has(kind) ? null : ns, name }; };
  const tgs = p => { const tg = targets(p, cl, ns); return tg.error ? [] : tg.list.filter(t => t.kind); };
  switch (verb) {
    case 'get': if (['events', 'ev', 'event'].includes(pos[0])) return [R('Event', 'list')]; return tgs(pos).map(t => R(t.kind, t.name ? 'get' : 'list', t.name)).filter((x, i, arr) => arr.findIndex(y => y.resource === x.resource && y.verb === x.verb) === i);
    case 'describe': return tgs(pos).map(t => R(t.kind, t.name ? 'get' : 'list', t.name));
    case 'delete': return a.files.length || a.val('-k') ? [] : tgs(pos).map(t => R(t.kind, 'delete', t.name));
    case 'logs': return [R('Pod', 'get', pos[0] && !pos[0].includes('/') ? pos[0] : undefined, 'log')];
    case 'exec': return [R('Pod', 'create', pos[0] && !pos[0].includes('/') ? pos[0] : undefined, 'exec')];
    case 'port-forward': return [R('Pod', 'create', undefined, 'portforward')];
    case 'scale': return tgs(pos).map(t => R(t.kind, 'patch', t.name, 'scale'));
    case 'set': return tgs(pos[1]?.includes('/') ? pos.slice(1, 2) : pos.slice(1, 3)).map(t => R(t.kind, 'patch', t.name));
    case 'label': case 'annotate': case 'patch': return tgs(pos[0]?.includes('/') ? pos.slice(0, 1) : pos.slice(0, 2)).map(t => R(t.kind, 'patch', t.name));
    case 'edit': return tgs(pos[0]?.includes('/') ? pos.slice(0, 1) : pos.slice(0, 2)).flatMap(t => [R(t.kind, 'get', t.name), R(t.kind, 'update', t.name)]);
    case 'rollout': return tgs(pos.slice(1)).map(t => R(t.kind, ['status', 'history'].includes(pos[0]) ? 'get' : 'patch', t.name));
    case 'expose': return [R('Service', 'create')];
    case 'run': return [R('Pod', 'create')];
    case 'autoscale': return [R('HorizontalPodAutoscaler', 'create')];
    case 'top': return [R('Pod', 'list')];
    case 'cordon': case 'uncordon': case 'drain': return [R('Node', 'patch', pos[0])];
    case 'create': {
      if (a.files.length || a.val('-k')) return [];
      const kind = { ns: 'Namespace', namespace: 'Namespace', deploy: 'Deployment', deployment: 'Deployment', cm: 'ConfigMap', configmap: 'ConfigMap', secret: 'Secret', job: 'Job', svc: 'Service', service: 'Service', ingress: 'Ingress', sa: 'ServiceAccount', serviceaccount: 'ServiceAccount', role: 'Role', clusterrole: 'ClusterRole', rolebinding: 'RoleBinding', clusterrolebinding: 'ClusterRoleBinding' }[pos[0]];
      if (pos[0] === 'token') return [R('ServiceAccount', 'create', pos[1], 'token')];
      return kind ? [R(kind, 'create')] : [];
    }
  }
  return [];
}

// "deployments.apps", "deploy", "pods/log", "*" -> { resource, group }
function parseResource(cl, text) {
  if (text === '*') return { resource: '*', group: '*' };
  const [base, sub] = String(text).split('/');
  const dot = base.indexOf('.');
  if (dot > 0) { const k = kindOf(cl, base); if (k) { const r = cl.resourceOf(k); return { resource: r.resource + (sub ? '/' + sub : ''), group: r.group }; } return { resource: base.slice(0, dot) + (sub ? '/' + sub : ''), group: base.slice(dot + 1) }; }
  const k = kindOf(cl, base);
  if (!k) return null;
  const r = cl.resourceOf(k);
  return { resource: r.resource + (sub ? '/' + sub : ''), group: r.group };
}

// ---------------------------------------------------------------- the command
def('kubectl', c => {
  const a = parseArgs(c.args);
  const [verb, ...pos] = a.pos;
  const out = (...l) => c.print(...l);
  if (!verb || verb === 'help' || a.has('--help') || a.has('-h')) {
    out('kubectl controls the Kubernetes cluster manager.', '', 'Basic Commands:', '  create        Create a resource from a file or from stdin', '  expose        Expose a deployment as a new Kubernetes service', '  run           Run a particular image on the cluster', '  set           Set specific features on objects (set image)', '  get           Display one or many resources', '  edit          Edit a resource on the server', '  delete        Delete resources by file names, resource names, or label selector', '', 'Deploy Commands:', '  rollout       Manage the rollout of a resource (status, history, undo, restart)', '  scale         Set a new size for a deployment', '  autoscale     Auto-scale a deployment', '', 'Troubleshooting and Debugging Commands:', '  describe      Show details of a specific resource', '  logs          Print the logs for a container in a pod', '  exec          Execute a command in a container', '  port-forward  Forward one or more local ports to a pod', '  top           Display resource (CPU/memory) usage', '', 'Advanced Commands:', '  apply         Apply a configuration to a resource by file name or stdin', '  wait          Wait for a specific condition', '', 'Settings Commands:', '  label / annotate', '  config        Modify kubeconfig files (get-contexts, use-context, set-context)');
    return 0;
  }
  if (verb === 'version') { if (a.has('--client') || a.raw['--client'] !== undefined) { out('Client Version: v1.31.2', 'Kustomize Version: v5.4.2'); return 0; } }
  if (verb === 'config') return configCmd(c, a, pos);
  if (verb === 'kustomize') {
    const r = kustomizeBuild(hostFiles(c.host), c.resolve(pos[0] || '.'));
    if (r.error) return c.fail(r.error, 1);
    out(...r.docs.map(d => { const { __file, ...rest } = d; return toYaml(rest); }).join('\n---\n').split('\n'));
    c.uni.emit({ type: 'kubectl', host: c.host.name, verb, args: c.args.join(' '), ok: true });
    return 0;
  }
  const conn = clusterFor(c, a);
  if (conn.error) return c.fail(conn.error, 1);
  const { cl } = conn;
  CUR = cl;
  const ns = a.namespace || conn.ns;
  const uni = c.uni;
  if (conn.role === 'rbac') {
    for (const req of requestsFor(cl, verb, pos, a, ns)) if (!authorize(cl, conn.ident, req)) { uni.emit({ type: 'kubectl', host: c.host.name, cluster: cl.name, verb, ns, args: c.args.join(' '), forbidden: true, user: conn.ident.user }); return c.fail(`Error from server (Forbidden): ${forbidden(conn.ident, req)}`, 1); }
  }
  const write = ['apply', 'create', 'delete', 'edit', 'scale', 'set', 'rollout', 'expose', 'run', 'label', 'annotate', 'autoscale', 'exec', 'port-forward', 'patch', 'cordon', 'drain', 'uncordon'];
  if (conn.role === 'view' && write.includes(verb) && !(verb === 'rollout' && ['status', 'history'].includes(pos[0]))) {
    const t = pos[0] || 'resource';
    return c.fail(`Error from server (Forbidden): ${verb === 'exec' ? 'pods "' + t + '" is forbidden' : `${pluralOf(cl, kindOf(cl, t.split('/')[0])) || t} is forbidden`}: User "${conn.user}" cannot ${verb === 'exec' ? 'create resource "pods/exec"' : `${verb === 'delete' ? 'delete' : verb === 'apply' || verb === 'create' ? 'create' : 'patch'} resource "${pluralOf(cl, kindOf(cl, t.split('/')[0] || ''))?.split('.')[0] || 'pods'}"`} in API group "${['Deployment', 'ReplicaSet', 'StatefulSet'].includes(kindOf(cl, t.split('/')[0] || '')) ? 'apps' : ''}" in the namespace "${ns}"`, 1);
  }
  const ensureNs = () => cl.get('Namespace', null, ns) ? null : c.fail(`Error from server (NotFound): namespaces "${ns}" not found`, 1);
  const emit = (extra) => uni.emit({ type: 'kubectl', host: c.host.name, cluster: cl.name, verb, ns, args: c.args.join(' '), ...extra });

  switch (verb) {
    case 'cluster-info': out(`${C.green('Kubernetes control plane')} is running at ${C.yellow(`https://${cl.cp.ip}:6443`)}`, `${C.green('CoreDNS')} is running at ${C.yellow(`https://${cl.cp.ip}:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy`)}`, '', "To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'."); return 0;
    case 'version': out('Client Version: v1.31.2', 'Kustomize Version: v5.4.2', `Server Version: ${cl.version}`); return 0;
    case 'api-resources': out(...table(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], Object.entries(API_VERSIONS).map(([k, v]) => [PLURAL[k]?.split('.')[0] || k.toLowerCase() + 's', Object.entries(KINDS).filter(([s, kk]) => kk === k && s.length <= 4 && !s.endsWith('s')).map(([s]) => s).join(','), v, CLUSTER_SCOPED.has(k) ? 'false' : 'true', k]))); return 0;
    case 'get': {
      if (ensureNs() !== null && !a.allNs && !['ns', 'namespace', 'namespaces', 'nodes', 'node', 'no'].includes(pos[0])) return 1;
      if (pos[0] === 'events' || pos[0] === 'ev' || pos[0] === 'event') {
        const ev = cl.events.filter(e => a.allNs || e.ns === ns).slice(-40);
        if (!ev.length) { c.eprint(`No events found in ${ns} namespace.`); return 0; }
        out(...table([...(a.allNs ? ['NAMESPACE'] : []), 'LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], ev.map(e => [...(a.allNs ? [e.ns] : []), age(uni, e.last), e.type, e.reason, `${singularOf(cl, e.kind).split('.')[0]}/${e.name}`, e.message])));
        return 0;
      }
      const tg = targets(pos, cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      const sel = a.selector ? parseSelector(a.selector) : null;
      const outs = [];
      const found = [];
      for (const t of tg.list) {
        if (t.name) {
          const o = cl.get(t.kind, ns, t.name);
          if (!o) { if (!a.has('--ignore-not-found')) c.eprint(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`); continue; }
          found.push(o);
        } else {
          let items = cl.list(t.kind, a.allNs ? null : ns, sel);
          if (t.kind === 'Node') items = items.filter(n => !n.spec.taints || true);
          if (t.kind === 'Service' && t.all) items = items.filter(Boolean);
          if (t.kind === 'Endpoints' && !items.length) items = [];
          if (items.length || !t.all) found.push(...items.map(o => Object.assign(o, { __type: t.all ? 'all' : null })));
        }
      }
      const fmt = a.output;
      if (fmt === 'yaml' || fmt === 'json') {
        const objs = found.map(o => view(cl, o));
        const doc = objs.length === 1 && tg.list.every(t => t.name) ? objs[0] : { apiVersion: 'v1', items: objs, kind: 'List', metadata: { resourceVersion: '' } };
        out(...(fmt === 'yaml' ? toYaml(doc) : JSON.stringify(doc, null, 4)).split('\n'));
      } else if (fmt === 'name') out(...found.map(resName));
      else if (fmt && fmt.startsWith('jsonpath')) {
        const expr = fmt.slice(fmt.indexOf('=') + 1).replace(/^['"]|['"]$/g, '');
        const objs = found.map(o => view(cl, o));
        const doc = objs.length === 1 && tg.list.every(t => t.name) ? objs[0] : { items: objs };
        c.print(expr.replace(/\{[^}]*\}/g, m => m === '{"\\n"}' || m === '{"\\t"}' ? (m.includes('n') ? '\n' : '\t') : jsonpath(doc, m)).replace(/\\n/g, '\n'));
      } else if (fmt && fmt.startsWith('custom-columns')) {
        const spec = fmt.slice(fmt.indexOf('=') + 1).split(',').map(x => x.split(':'));
        out(...table(spec.map(s => s[0]), found.map(o => spec.map(s => jsonpath(view(cl, o), s[1]) || '<none>'))));
      } else {
        const byKind = new Map();
        for (const o of found) { if (!byKind.has(o.kind)) byKind.set(o.kind, []); byKind.get(o.kind).push(o); }
        if (!found.length) { if (!tg.list.some(t => t.name)) c.eprint(a.allNs ? 'No resources found' : `No resources found in ${ns} namespace.`); return tg.list.some(t => t.name) ? 1 : 0; }
        const multi = byKind.size > 1 || tg.list.some(t => t.all);
        let first = true;
        for (const [kind, items] of byKind) {
          if (!first) outs.push('');
          first = false;
          let lines = rows(cl, kind, items, { wide: fmt === 'wide', showLabels: a.has('--show-labels'), allNs: a.allNs, prefix: multi ? `${singularOf(cl, kind)}/` : '' });
          if (a.has('--no-headers')) lines = lines.slice(1);
          outs.push(...lines);
        }
        out(...outs);
        if (a.has('-w') || a.has('--watch')) c.eprint(C.dim('(kubectl get -w keeps streaming changes in a real terminal; the simulator shows one snapshot. Run it again to see what changed.)'));
      }
      emit({ kinds: [...new Set(found.map(o => o.kind))] });
      return found.length || !tg.list.some(t => t.name) ? 0 : 1;
    }
    case 'describe': {
      if (ensureNs() !== null && !['nodes', 'node', 'no'].includes(pos[0]?.split('/')[0])) return 1;
      const tg = targets(pos, cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      let code = 0;
      const blocks = [];
      for (const t of tg.list) {
        const items = t.name ? [cl.get(t.kind, ns, t.name) || cl.list(t.kind, ns).find(o => o.metadata.name.startsWith(t.name))].filter(Boolean) : cl.list(t.kind, ns, a.selector ? parseSelector(a.selector) : null);
        if (!items.length) { c.eprint(t.name ? `Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found` : `No resources found in ${ns} namespace.`); code = 1; continue; }
        for (const o of items) { if (blocks.length) blocks.push('', ''); blocks.push(...describe(cl, o)); }
      }
      out(...blocks);
      emit({ kinds: tg.list.map(t => t.kind), names: tg.list.map(t => t.name) });
      return code;
    }
    case 'apply': case 'create': {
      const kdir = a.val('-k') ?? a.val('--kustomize');
      if (verb === 'create' && !a.files.length && !kdir) return createCmd(c, a, pos, cl, ns, emit, conn);
      if (!a.files.length && !kdir) return c.fail('error: must specify one of -f and -k', 1);
      const r = readInput(c, a);
      if (r.error) return c.fail(r.error, 1);
      if (!r.docs.length) return c.fail('error: no objects passed to apply', 1);
      const dry = a.val('--dry-run');
      let code = 0;
      for (const d of r.docs) {
        if (verb === 'create' && cl.get(d.kind, d.metadata?.namespace || ns, d.metadata?.name)) { c.eprint(`Error from server (AlreadyExists): error when creating "${d.__file}": ${pluralOf(cl, d.kind)} "${d.metadata.name}" already exists`); code = 1; continue; }
        if (dry) { const v = cl.validate({ ...clone(d), metadata: { namespace: ns, ...d.metadata } }); if (v) { c.eprint(v); code = 1; } else out(`${resName(d)} ${cl.get(d.kind, d.metadata.namespace || ns, d.metadata.name) ? 'configured' : 'created'} (dry run)`); continue; }
        if (conn.role === 'rbac') {
          const rr = cl.resourceOf(d.kind);
          const dns = CLUSTER_SCOPED.has(d.kind) ? null : (d.metadata?.namespace || ns);
          const exists = !!cl.get(d.kind, dns, d.metadata?.name);
          const req = { verb: exists ? 'patch' : 'create', resource: rr.resource, group: rr.group, ns: dns, name: d.metadata?.name };
          if (!authorize(cl, conn.ident, { ...req, verb: 'get' }) || !authorize(cl, conn.ident, req)) { c.eprint(`Error from server (Forbidden): error when ${exists ? 'applying patch' : 'creating'} "${d.__file}": ${forbidden(conn.ident, authorize(cl, conn.ident, { ...req, verb: 'get' }) ? req : { ...req, verb: 'get' })}`); code = 1; uni.emit({ type: 'kubectl', host: c.host.name, cluster: cl.name, verb, ns, args: c.args.join(' '), forbidden: true, user: conn.ident.user }); continue; }
        }
        const res = cl.apply(d, { ns, user: conn.ident?.user });
        if (res.error) { c.eprint(res.error); code = 1; continue; }
        for (const w of res.warnings || []) c.eprint(w);
        out(`${resName(res.obj)} ${res.verb}`);
      }
      uni.advance(1);
      emit({ kinds: r.docs.map(d => d.kind), names: r.docs.map(d => d.metadata?.name), files: kdir ? [kdir] : a.files, kustomize: kdir || null, ok: code === 0 });
      return code;
    }
    case 'delete': {
      let objs = [];
      if (a.files.length || a.val('-k')) {
        const r = readInput(c, a);
        if (r.error) return c.fail(r.error, 1);
        for (const d of r.docs) { const o = cl.get(d.kind, d.metadata?.namespace || ns, d.metadata?.name); if (o) objs.push(o); else c.eprint(`Error from server (NotFound): error when deleting "${d.__file}": ${pluralOf(cl, d.kind)} "${d.metadata?.name}" not found`); }
      } else {
        const tg = targets(pos, cl, ns);
        if (tg.error) return c.fail(tg.error === 'error: you must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.' ? 'error: You must provide one or more resources by argument or filename.' : tg.error, 1);
        for (const t of tg.list) {
          if (t.name) { const o = cl.get(t.kind, ns, t.name); if (o) objs.push(o); else { c.eprint(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`); } }
          else if (a.has('--all') || a.selector) objs.push(...cl.list(t.kind, ns, a.selector ? parseSelector(a.selector) : null));
          else return c.fail('error: resource(s) were provided, but no name was specified', 1);
        }
      }
      for (const o of objs) {
        out(`${resName(o)} deleted${o.kind === 'Namespace' ? '' : ''}`);
        cl.delete(o, { now: a.has('--force') && a.val('--grace-period') === '0' });
        emit({ kind: o.kind, name: o.metadata.name });
      }
      if (objs.some(o => o.kind === 'Pod' || o.kind === 'Namespace')) waitFor(c, cl, () => objs.filter(o => o.kind === 'Pod').every(o => !cl.get('Pod', o.metadata.namespace, o.metadata.name)), 40, 2);
      return objs.length ? 0 : 1;
    }
    case 'logs': {
      const ref = pos[0];
      let pods;
      if (a.selector) pods = cl.list('Pod', ns, parseSelector(a.selector));
      else if (!ref) return c.fail('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command', 1);
      else pods = findPodsFor(cl, ns, ref);
      if (!pods || !pods.length) return c.fail(ref ? `Error from server (NotFound): ${ref.includes('/') ? pluralOf(cl, kindOf(cl, ref.split('/')[0])) || 'pods' : 'pods'} "${ref.split('/').pop()}" not found` : 'No resources found', 1);
      if (!a.selector) pods = pods.slice(0, 1);
      if (pods.length > 1 || (ref && ref.includes('/') && !ref.startsWith('pod'))) { const total = findPodsFor(cl, ns, ref || '')?.length; if (!a.selector && total > 1) c.eprint(`Found ${total} pods, using pod/${pods[0].metadata.name}`); }
      const tail = a.val('--tail') !== undefined ? Number(a.val('--tail')) : -1;
      for (const p of pods) {
        const rt = cl.rt.get(p.metadata.uid);
        const cname = a.container || p.spec.containers[0].name;
        const cr = rt?.containers.find(x => x.name === cname);
        if (!cr || !cr.ctr) { c.eprint(`Error from server (BadRequest): container "${cname}" in pod "${p.metadata.name}" is waiting to start: ${cr?.reason === 'ErrImagePull' || cr?.reason === 'ImagePullBackOff' ? 'trying and failing to pull image' : 'ContainerCreating'}`); if (!a.selector) return 1; continue; }
        const runs = cr.runs;
        let seg;
        if (a.has('--previous') || a.has('-p')) {
          if (runs.length < 2 && cr.state === 'running') { c.eprint(`Error from server (BadRequest): previous terminated container "${cname}" in pod "${p.metadata.name}" not found`); return 1; }
          const r = cr.state === 'running' ? runs[runs.length - 2] : runs[runs.length - 1];
          seg = cr.ctr.logs.slice(r.from, r.to);
        } else { const r = runs[runs.length - 1]; seg = cr.ctr.logs.slice(r?.from || 0, r?.to); }
        let lines = seg.map(l => l.line);
        if (tail >= 0) lines = lines.slice(-tail);
        out(...lines.map(l => a.selector || a.has('--prefix') ? `[pod/${p.metadata.name}/${cname}] ${l}` : l));
      }
      if (a.has('-f') || a.has('--follow')) c.eprint(C.dim('(kubectl logs -f keeps following in a real terminal; this is what is there now)'));
      emit({ pods: pods.map(p => p.metadata.name), previous: a.has('--previous') || a.has('-p') });
      return 0;
    }
    case 'exec': {
      const ref = pos[0];
      if (!ref) return c.fail('error: expected \'exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]\'', 1);
      const pods = findPodsFor(cl, ns, ref);
      if (!pods?.length) return c.fail(`Error from server (NotFound): pods "${ref.split('/').pop()}" not found`, 1);
      const p = pods[0];
      const rt = cl.rt.get(p.metadata.uid);
      const cname = a.container || p.spec.containers[0].name;
      const cr = rt?.containers.find(x => x.name === cname);
      if (!cr || cr.state !== 'running') return c.fail(`error: unable to upgrade connection: container not found ("${cname}")`, 1);
      const cmd = a.rest || pos.slice(1);
      if (!cmd.length) return c.fail('error: you must specify at least one command for the container', 1);
      const h = cr.ctr.h;
      const bin = cmd[0].split('/').pop();
      if (!h.binaries.has(bin) && !['echo', 'cd', 'pwd', 'export', 'true', 'false', 'test', '['].includes(bin)) return c.fail(`error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${cr.ctr.id.slice(0, 12)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd[0]}": executable file not found in $PATH: unknown`, 1);
      const interactive = (a.has('-it') || a.has('-ti') || (a.has('-i') && a.has('-t')) || (a.raw['-i'] && a.raw['-t'])) && ['sh', 'bash', 'ash'].includes(bin) && cmd.length === 1;
      const asUser = h.users.has(cr.ctr.user) ? cr.ctr.user : 'root';
      emit({ pod: p.metadata.name, cmd: cmd.join(' '), interactive });
      if (interactive) {
        c.sh.enter(h, asUser, { kind: 'exec', cwd: cr.ctr.workdir, env: cr.ctr.env });
        c.sh.e.onExit = () => cl.syncPodVolumes(p, rt);
        return 0;
      }
      const sh = new Session(uni, h, { user: asUser, cwd: cr.ctr.workdir });
      sh.advancePerCommand = 0;
      for (const [k, v] of Object.entries(cr.ctr.env || {})) sh.setVar(sh.e, k, v, { exported: true });
      const line = (bin === 'sh' || bin === 'bash') && cmd[1] === '-c' ? cmd.slice(2).join(' ') : cmd.map(x => /[\s'"$|;&<>]/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : x).join(' ');
      const r = sh.run(line, { record: false });
      if (r.out.length) out(...r.out);
      cl.syncPodVolumes(p, rt);
      if (r.code) c.eprint(`command terminated with exit code ${r.code}`);
      return r.code;
    }
    case 'port-forward': {
      const ref = pos[0];
      const spec = pos[1];
      if (!ref || !spec) return c.fail('error: TYPE/NAME and list of ports are required for port-forward', 1);
      const [lp, rp] = spec.includes(':') ? spec.split(':').map(Number) : [Number(spec), Number(spec)];
      const pods = findPodsFor(cl, ns, ref);
      if (!pods?.length) return c.fail(`Error from server (NotFound): ${ref.includes('/') ? pluralOf(cl, kindOf(cl, ref.split('/')[0])) : 'pods'} "${ref.split('/').pop()}" not found`, 1);
      const p = pods.find(x => cl.podReady(x)) || pods[0];
      if (!cl.podReady(p)) return c.fail(`error: unable to forward port because pod is not running. Current status=${p.status.phase}`, 1);
      let target = rp;
      if (ref.startsWith('svc/') || ref.startsWith('service/')) { const s = cl.get('Service', ns, ref.split('/')[1]); const sp = s.spec.ports.find(x => x.port === rp); if (!sp) return c.fail(`error: Service ${s.metadata.name} does not have a service port ${rp}`, 1); const tp = sp.targetPort; target = typeof tp === 'number' ? tp : Number(p.spec.containers.flatMap(x => x.ports || []).find(x => x.name === tp)?.containerPort || tp); }
      if (c.host.listening.get(lp) && c.host.procs.has(c.host.listening.get(lp).pid)) return c.fail(`Unable to listen on port ${lp}: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:${lp}: bind: address already in use]\nerror: unable to listen on any of the requested ports: [{${lp} ${rp}}]`, 1);
      const ip = cl.rt.get(p.metadata.uid).ip;
      const prog = { kind: 'port-forward', handle: req => { const live = cl.rt.get(p.metadata.uid); if (!live || !cl.get('Pod', ns, p.metadata.name)) return { error: 'EMPTY', detail: 'Empty reply from server' }; return httpRequest(uni, cl.cp, `http://${ip}:${target}${req.path}${req.query || ''}`, { method: req.method, headers: req.headers, body: req.body, depth: (req.depth || 0) + 1 }); }, checkAuth: url => { const h = uni.byIp.get(ip); return h?.listening.get(target)?.program?.checkAuth?.(url) ?? null; }, get data() { return uni.byIp.get(ip)?.listening.get(target)?.program?.data; }, get host() { return uni.byIp.get(ip)?.listening.get(target)?.program?.host; } };
      const proc = c.host.addProc({ cmd: `kubectl port-forward ${ref} ${spec}`, user: c.user, mem: 30, program: prog });
      c.host.listen(lp, proc.pid, { addr: '127.0.0.1', program: prog });
      out(`Forwarding from 127.0.0.1:${lp} -> ${target}`, `Forwarding from [::1]:${lp} -> ${target}`);
      c.eprint(C.dim(`(in a real terminal port-forward keeps running in the foreground; the simulator runs it in the background as pid ${proc.pid}. Stop it with: kill ${proc.pid})`));
      emit({ ref, local: lp, remote: rp });
      return 0;
    }
    case 'scale': {
      const reps = a.val('--replicas');
      if (reps === undefined) return c.fail('error: required flag(s) "replicas" not set', 1);
      const tg = targets(pos, cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      for (const t of tg.list) {
        const o = cl.get(t.kind, ns, t.name);
        if (!o) return c.fail(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`, 1);
        o.spec.replicas = Number(reps);
        out(`${resName(o)} scaled`);
        emit({ kind: o.kind, name: o.metadata.name, replicas: Number(reps) });
        uni.emit({ type: 'k8s-scale', cluster: cl.name, ns, name: o.metadata.name, replicas: Number(reps), by: 'kubectl' });
      }
      uni.advance(1);
      return 0;
    }
    case 'set': {
      if (pos[0] !== 'image' && pos[0] !== 'env' && pos[0] !== 'resources') return c.fail(`error: unknown command "${pos[0]}" for "kubectl set"`, 1);
      // `set image deploy/web …` or `set image deployment web …`
      const typed = pos[1]?.includes('/');
      const tg = targets(typed ? pos.slice(1, 2) : pos.slice(1, 3), cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      const t = tg.list[0];
      if (!t.name) return c.fail(`error: resource(s) were provided, but no name was specified`, 1);
      const o = cl.get(t.kind, ns, t.name);
      if (!o) return c.fail(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`, 1);
      const tpl = o.kind === 'Pod' ? o.spec : o.spec.template.spec;
      const pairs = pos.slice(typed ? 2 : 3);
      if (pos[0] === 'image') {
        for (const kv of pairs) {
          const [cn, img] = kv.split('=');
          const ct = cn === '*' ? tpl.containers : tpl.containers.filter(x => x.name === cn);
          if (!ct.length) return c.fail(`error: unable to find container named "${cn}"`, 1);
          for (const x of ct) x.image = img;
        }
      } else if (pos[0] === 'env') {
        for (const kv of pairs) { const [k, ...v] = kv.split('='); for (const x of tpl.containers) { x.env = (x.env || []).filter(e => e.name !== k.replace(/-$/, '')); if (!k.endsWith('-')) x.env.push({ name: k, value: v.join('=') }); } }
      } else {
        const lim = a.val('--limits'), req = a.val('--requests');
        for (const x of tpl.containers) { x.resources = x.resources || {}; if (lim) x.resources.limits = Object.fromEntries(lim.split(',').map(s => s.split('='))); if (req) x.resources.requests = Object.fromEntries(req.split(',').map(s => s.split('='))); }
      }
      o.metadata.generation++;
      if (o.kind === 'Pod') cl.onUpdate(o);
      out(`${resName(o)} ${pos[0] === 'image' ? 'image' : pos[0] === 'env' ? 'env' : 'resource requirements'} updated`);
      emit({ kind: o.kind, name: o.metadata.name, sub: pos[0], images: tpl.containers.map(x => x.image) });
      uni.advance(1);
      return 0;
    }
    case 'rollout': return rolloutCmd(c, a, pos, cl, ns, emit);
    case 'expose': {
      const tg = targets(pos, cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      const t = tg.list[0];
      const o = cl.get(t.kind, ns, t.name);
      if (!o) return c.fail(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`, 1);
      const sel = o.spec.selector?.matchLabels || o.metadata.labels;
      const port = Number(a.val('--port') || o.spec.template?.spec.containers[0].ports?.[0]?.containerPort || o.spec.containers?.[0]?.ports?.[0]?.containerPort);
      if (!port) return c.fail(`error: couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples`, 1);
      const tp = a.val('--target-port') ? (isNaN(Number(a.val('--target-port'))) ? a.val('--target-port') : Number(a.val('--target-port'))) : port;
      const svc = { apiVersion: 'v1', kind: 'Service', metadata: { name: a.val('--name') || o.metadata.name, namespace: ns, labels: { ...(o.metadata.labels || {}) } }, spec: { type: a.val('--type') || 'ClusterIP', selector: { ...sel }, ports: [{ port, targetPort: tp, protocol: 'TCP' }] } };
      if (a.val('--dry-run')) { out(...toYaml(svc).split('\n')); return 0; }
      const res = cl.apply(svc, { ns });
      if (res.error) return c.fail(res.error, 1);
      if (res.verb !== 'created') return c.fail(`Error from server (AlreadyExists): services "${svc.metadata.name}" already exists`, 1);
      out(`service/${svc.metadata.name} exposed`);
      emit({ kind: 'Service', name: svc.metadata.name });
      uni.advance(1);
      return 0;
    }
    case 'run': {
      const name = pos[0];
      const image = a.val('--image');
      if (!name || !image) return c.fail('error: NAME and --image are required for run', 1);
      if (cl.get('Pod', ns, name)) return c.fail(`Error from server (AlreadyExists): pods "${name}" already exists`, 1);
      const cmd = a.rest || [];
      const env = a.all('--env').concat(a.all('-e')).map(kv => ({ name: kv.split('=')[0], value: kv.split('=').slice(1).join('=') }));
      const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: ns, labels: { run: name } }, spec: { containers: [{ name, image, ...(cmd.length ? { args: cmd } : {}), ...(env.length ? { env } : {}), ...(a.val('--port') ? { ports: [{ containerPort: Number(a.val('--port')) }] } : {}) }], restartPolicy: a.val('--restart') || 'Always' } };
      if (a.val('--dry-run')) { out(...toYaml(pod).split('\n')); return 0; }
      const res = cl.apply(pod, { ns });
      if (res.error) return c.fail(res.error, 1);
      emit({ kind: 'Pod', name, image, rm: a.has('--rm') });
      const p = res.obj;
      const interactive = a.has('-it') || a.has('-ti') || (a.raw['-i'] && a.raw['-t']);
      if (!interactive && !a.has('--rm')) { out(`pod/${name} created`); uni.advance(1); return 0; }
      waitFor(c, cl, () => { const rt = cl.rt.get(p.metadata.uid); return rt?.containers[0] && (rt.containers[0].state === 'running' || rt.containers[0].final || ['ErrImagePull', 'ImagePullBackOff', 'CreateContainerConfigError'].includes(rt.containers[0].reason)); }, 30, 1);
      const rt = cl.rt.get(p.metadata.uid);
      const cr = rt?.containers[0];
      if (!cr || (cr.state !== 'running' && !cr.final)) { c.eprint(`error: timed out waiting for the condition`); return 1; }
      if (cr.state === 'running' && interactive && (!cmd.length || ['sh', 'bash', 'ash'].includes(cmd[0]) && cmd.length === 1)) {
        out("If you don't see a command prompt, try pressing enter.");
        c.sh.enter(cr.ctr.h, 'root', { kind: 'exec', cwd: cr.ctr.workdir, env: cr.ctr.env });
        c.sh.e.onExit = () => { if (a.has('--rm')) { cl.delete(p, { now: true }); c.print(`pod "${name}" deleted from ${ns} namespace`); } };
        return 0;
      }
      const r0 = cr.runs[cr.runs.length - 1];
      out(...cr.ctr.logs.slice(r0?.from || 0).map(l => l.line));
      if (a.has('--rm')) { cl.delete(p, { now: true }); out(`pod "${name}" deleted from ${ns} namespace`); }
      return cr.exitCode || 0;
    }
    case 'edit': {
      const tg = targets(pos, cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      const t = tg.list[0];
      const o = cl.get(t.kind, ns, t.name);
      if (!o) return c.fail(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`, 1);
      const v = view(cl, o);
      delete v.status; delete v.metadata.uid; delete v.metadata.resourceVersion; delete v.metadata.generation; delete v.metadata.creationTimestamp; delete v.metadata.ownerReferences;
      const before = toYaml(v) + '\n';
      c.result.editor = {
        title: `/tmp/kubectl-edit-${suffix(6)}.yaml`, content: `# Please edit the object below. Lines beginning with a '#' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n${before}`,
        onSave(text, { io }) {
          const body = text.split('\n').filter(l => !l.startsWith('#')).join('\n');
          if (!body.trim()) { io.out('Edit cancelled, no changes made.\n'); return 0; }
          if (body.trim() === before.trim()) { io.out('Edit cancelled, no changes made.\n'); return 0; }
          let obj; try { obj = parseYaml(body); } catch (e) { io.err(`error: error parsing edited object: ${e.message}\n`); return 1; }
          const r = cl.apply(obj, { ns });
          if (r.error) { io.err(r.error + '\n'); return 1; }
          io.out(`${resName(r.obj)} edited\n`);
          uni.emit({ type: 'kubectl', host: c.host.name, cluster: cl.name, verb: 'edit', ns, kind: o.kind, name: o.metadata.name });
          uni.advance(1);
          return 0;
        },
      };
      return 0;
    }
    case 'label': case 'annotate': {
      const tg = targets(pos.slice(0, pos[0]?.includes('/') ? 1 : 2), cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      const t = tg.list[0];
      const o = cl.get(t.kind, ns, t.name);
      if (!o) return c.fail(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`, 1);
      const field = verb === 'label' ? 'labels' : 'annotations';
      o.metadata[field] = o.metadata[field] || {};
      for (const kv of pos.slice(pos[0].includes('/') ? 1 : 2)) {
        if (kv.endsWith('-')) { delete o.metadata[field][kv.slice(0, -1)]; continue; }
        const [k, ...v] = kv.split('=');
        if (k in o.metadata[field] && !a.has('--overwrite') && o.metadata[field][k] !== v.join('=')) return c.fail(`error: '${k}' already has a value (${o.metadata[field][k]}), and --overwrite is false`, 1);
        o.metadata[field][k] = v.join('=').replace(/^["']|["']$/g, '');
      }
      out(`${resName(o)} ${verb === 'label' ? 'labeled' : 'annotated'}`);
      emit({ kind: o.kind, name: o.metadata.name });
      return 0;
    }
    case 'top': {
      if (pos[0] === 'node' || pos[0] === 'nodes') {
        out(...table(['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], cl.nodes.map(n => { const pods = cl.list('Pod').filter(p => cl.rt.get(p.metadata.uid)?.node === n); const cpu = 80 + pods.reduce((s, p) => s + cl.podCpu(p), 0); const mem = 700 + pods.reduce((s, p) => s + podMem(cl, p), 0); return [n.name, `${cpu}m`, `${Math.round(cpu / n.cpu * 100)}%`, `${Math.round(mem)}Mi`, `${Math.round(mem / n.memMi * 100)}%`]; })));
        return 0;
      }
      const pods = cl.list('Pod', a.allNs ? null : ns, a.selector ? parseSelector(a.selector) : null).filter(p => cl.podReady(p));
      if (!pods.length) { c.eprint(`No resources found in ${ns} namespace.`); return 0; }
      out(...table([...(a.allNs ? ['NAMESPACE'] : []), 'NAME', 'CPU(cores)', 'MEMORY(bytes)'], pods.map(p => [...(a.allNs ? [p.metadata.namespace] : []), p.metadata.name, `${cl.podCpu(p)}m`, `${Math.round(podMem(cl, p))}Mi`])));
      emit({});
      return 0;
    }
    case 'autoscale': {
      const tg = targets(pos, cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      const t = tg.list[0];
      const o = cl.get(t.kind, ns, t.name);
      if (!o) return c.fail(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`, 1);
      const hpa = { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name: o.metadata.name, namespace: ns }, spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: o.kind, name: o.metadata.name }, minReplicas: Number(a.val('--min') || 1), maxReplicas: Number(a.val('--max')), metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: Number(a.val('--cpu-percent') || 80) } } }] } };
      if (!a.val('--max')) return c.fail('error: --max=MAXPODS is required and must be at least 1, max replicas must be >= min replicas', 1);
      const res = cl.apply(hpa, { ns });
      if (res.error) return c.fail(res.error, 1);
      out(`horizontalpodautoscaler.autoscaling/${o.metadata.name} autoscaled`);
      emit({ kind: 'HorizontalPodAutoscaler', name: o.metadata.name });
      uni.advance(1);
      return 0;
    }
    case 'wait': {
      const cond = a.val('--for') || '';
      const timeout = parseInt(a.val('--timeout') || '30', 10) * (/m$/.test(a.val('--timeout') || '') ? 60 : 1);
      const tg = targets(pos, cl, ns);
      if (tg.error && !a.selector) return c.fail(tg.error, 1);
      const getObjs = () => tg.list?.flatMap(t => t.name ? [cl.get(t.kind, ns, t.name)].filter(Boolean) : cl.list(t.kind, ns, a.selector ? parseSelector(a.selector) : null)) || [];
      const ok = o => /ready/i.test(cond) ? (o.kind === 'Pod' ? cl.podReady(o) : false) : /available/i.test(cond) ? (o.status.availableReplicas >= o.spec.replicas) : /complete/i.test(cond) ? !!o.status.completionTime : cond === 'delete' ? false : false;
      const done = waitFor(c, cl, () => cond === 'delete' ? !getObjs().length : getObjs().length && getObjs().every(ok), timeout, 2);
      if (!done) { c.eprint(`error: timed out waiting for the condition on ${getObjs().map(resName).join(', ') || 'resources'}`); return 1; }
      out(...getObjs().map(o => `${resName(o)} condition met`));
      return 0;
    }
    case 'patch': {
      const tg = targets(pos, cl, ns);
      if (tg.error) return c.fail(tg.error, 1);
      const t = tg.list[0];
      const o = cl.get(t.kind, ns, t.name);
      if (!o) return c.fail(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`, 1);
      let patch;
      try { patch = JSON.parse(a.val('-p') || a.val('--patch') || '{}'); } catch { try { patch = parseYaml(a.val('-p') || a.val('--patch')); } catch (e) { return c.fail(`error: unable to parse "${a.val('-p')}": ${e.message}`, 1); } }
      const merge = (dst, src) => { for (const [k, v] of Object.entries(src)) { if (v === null) delete dst[k]; else if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v); else dst[k] = v; } };
      merge(o, patch);
      o.metadata.generation++;
      out(`${resName(o)} patched`);
      emit({ kind: o.kind, name: o.metadata.name });
      uni.advance(1);
      return 0;
    }
    case 'cordon': case 'uncordon': case 'drain': {
      const n = cl.get('Node', null, pos[0]);
      if (!n) return c.fail(`Error from server (NotFound): nodes "${pos[0]}" not found`, 1);
      n.spec.unschedulable = verb !== 'uncordon';
      out(`node/${pos[0]} ${verb === 'uncordon' ? 'uncordoned' : 'cordoned'}`);
      if (verb === 'drain') { const node = cl.nodes.find(x => x.name === pos[0]); for (const p of cl.list('Pod').filter(p => cl.rt.get(p.metadata.uid)?.node === node)) { out(`evicting pod ${p.metadata.namespace}/${p.metadata.name}`); cl.delete(p); } waitFor(c, cl, () => !cl.list('Pod').some(p => cl.rt.get(p.metadata.uid)?.node === node && p.metadata.deletionTimestamp), 30); out(`node/${pos[0]} drained`); }
      return 0;
    }
    case 'explain': {
      const docs = { pod: 'Pod is a collection of containers that can run on a host.', deployment: 'Deployment enables declarative updates for Pods and ReplicaSets.', service: 'Service is a named abstraction of software service (for example, mysql) consisting of local port (for example 3306) that the proxy listens on, and the selector that determines which pods will answer requests sent through the proxy.', 'deployment.spec.strategy': 'The deployment strategy to use to replace existing pods with new ones. type: Recreate | RollingUpdate; rollingUpdate.maxSurge, rollingUpdate.maxUnavailable', 'pod.spec.containers.readinessprobe': 'Periodic probe of container service readiness. Container will be removed from service endpoints if the probe fails.', 'pod.spec.containers.livenessprobe': 'Periodic probe of container liveness. Container will be restarted if the probe fails.', 'pod.spec.containers.resources': 'Compute Resources required by this container. limits: maximum allowed; requests: minimum required, used for scheduling.' };
      const k = (pos[0] || '').toLowerCase().replace(/^deploy\b/, 'deployment').replace(/^svc\b/, 'service').replace(/^po\b/, 'pod');
      const d = docs[k] || docs[k.split('.')[0]];
      if (!d) return c.fail(`error: couldn't find resource for "${pos[0]}"`, 1);
      out(`KIND:       ${k.split('.')[0][0].toUpperCase() + k.split('.')[0].slice(1)}`, '', 'DESCRIPTION:', `    ${d}`);
      return 0;
    }
    case 'auth': {
      if (pos[0] === 'whoami') {
        const id = conn.ident;
        out(...table(['ATTRIBUTE', 'VALUE'], [['Username', id.user || conn.user], ['Groups', `[${id.groups.join(' ')}]`]]));
        return 0;
      }
      if (pos[0] !== 'can-i') return c.fail(`error: unknown command "${pos[0] || ''}" for "kubectl auth"`, 1);
      const scopeNs = a.allNs ? null : ns;
      if (a.has('--list')) {
        if (conn.role === 'view') { out(...table(['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], [['*.*', '[]', '[]', '[get list watch]']])); return 0; }
        const rules = conn.role === 'admin' ? [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] : rulesFor(cl, conn.ident, scopeNs);
        const rowsL = [['selfsubjectreviews.authentication.k8s.io', '[]', '[]', '[create]'], ['selfsubjectaccessreviews.authorization.k8s.io', '[]', '[]', '[create]'], ...rules.flatMap(r => (r.resources || []).map(res => [res === '*' && (r.apiGroups || []).includes('*') ? '*.*' : `${res}${(r.apiGroups || []).filter(Boolean).length ? '.' + r.apiGroups.filter(Boolean).join(',') : ''}`, '[]', `[${(r.resourceNames || []).join(' ')}]`, `[${(r.verbs || []).join(' ')}]`]))];
        out(...table(['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], rowsL));
        uni.emit({ type: 'kubectl', host: c.host.name, cluster: cl.name, verb: 'auth', sub: 'can-i', list: true, ns: scopeNs, user: conn.ident.user, args: c.args.join(' ') });
        return 0;
      }
      const v = pos[1];
      const [resText, name] = (pos[2] || '').includes('/') && !/\/(log|exec|scale|status|portforward|token)$/.test(pos[2]) ? pos[2].split('/') : [pos[2] || '', pos[3]];
      if (!v || !resText) return c.fail('error: you must specify two arguments: verb resource or verb resource/resourceName.', 1);
      const pr = parseResource(cl, resText);
      if (!pr) { c.eprint(`Warning: the server doesn't have a resource type '${resText}'`); out('no'); return 1; }
      let allowed;
      if (conn.role === 'admin') allowed = true;
      else if (conn.role === 'view') allowed = ['get', 'list', 'watch'].includes(v);
      else allowed = authorize(cl, conn.ident, { verb: v, resource: pr.resource, group: pr.group, ns: scopeNs, name });
      out(allowed ? 'yes' : 'no');
      uni.emit({ type: 'kubectl', host: c.host.name, cluster: cl.name, verb: 'auth', sub: 'can-i', ns: scopeNs, user: conn.ident.user, check: { verb: v, resource: pr.resource, group: pr.group }, allowed, args: c.args.join(' ') });
      return allowed ? 0 : 1;
    }
    case 'diff': {
      const r = readInput(c, a);
      if (r.error) return c.fail(r.error, 1);
      const lines = [];
      for (const d of r.docs) {
        const dns = CLUSTER_SCOPED.has(d.kind) ? null : (d.metadata?.namespace || ns);
        const live = cl.get(d.kind, dns, d.metadata?.name);
        const strip = o => { const x = view(cl, o); delete x.status; for (const k of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'ownerReferences', 'managedFields']) delete x.metadata[k]; if (x.metadata.annotations) { for (const k of Object.keys(x.metadata.annotations)) if (k.startsWith('deployment.kubernetes.io/')) delete x.metadata.annotations[k]; if (!Object.keys(x.metadata.annotations).length) delete x.metadata.annotations; } return x; };
        const want = clone(d); delete want.__file; want.metadata = { ...(want.metadata || {}), namespace: dns || undefined };
        if (!CLUSTER_SCOPED.has(want.kind)) want.metadata.namespace = dns;
        const overlay = (l, w) => { if (Array.isArray(w)) return Array.isArray(l) && l.length === w.length ? w.map((x, i) => overlay(l[i], x)) : w; if (w && typeof w === 'object') { const o = l && typeof l === 'object' && !Array.isArray(l) ? { ...l } : {}; for (const [k, v] of Object.entries(w)) o[k] = overlay(o[k], v); return o; } return w; };
        const merged = live ? { ...overlay(strip(live), Object.fromEntries(Object.entries(want).filter(([k]) => !['metadata', 'status', 'apiVersion', 'kind'].includes(k)))), metadata: { ...strip(live).metadata, labels: { ...(want.kind === 'Namespace' ? { 'kubernetes.io/metadata.name': want.metadata.name } : {}), ...(want.metadata.labels || {}) }, ...(want.metadata.annotations ? { annotations: want.metadata.annotations } : {}) } } : want;
        const before = live ? toYaml(strip(live)).split('\n') : [];
        const after = toYaml(live ? merged : { ...want, metadata: { ...want.metadata } }).split('\n');
        if (before.join('\n') === after.join('\n')) continue;
        const file = `${d.apiVersion.replace('/', '.')}.${d.kind}.${dns || ''}.${d.metadata.name}`.replace('..', '.');
        lines.push(`diff -u -N /tmp/LIVE-${suffix(9)}/${file} /tmp/MERGED-${suffix(9)}/${file}`, `--- /tmp/LIVE/${file}\t${new Date(uni.time * 1000).toISOString()}`, `+++ /tmp/MERGED/${file}\t${new Date(uni.time * 1000).toISOString()}`);
        lines.push(...lineDiff(before, after));
      }
      if (lines.length) out(...lines.map(l => l.startsWith('+') && !l.startsWith('+++') ? C.green(l) : l.startsWith('-') && !l.startsWith('---') ? C.red(l) : l));
      emit({ diff: true, changed: lines.length > 0 });
      return lines.length ? 1 : 0;
    }
  }
  return c.fail(`error: unknown command "${verb}" for "kubectl"\n\nDid you mean this?\n\t${['get', 'apply', 'describe', 'logs', 'exec'].find(x => x[0] === verb[0]) || 'get'}`, 1);
}, { pkg: 'kubectl' });

// a minimal unified diff: one hunk with three lines of context around each change
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  const keep = ops.map((o, k) => o[0] !== ' ' || ops.slice(Math.max(0, k - 3), k + 4).some(x => x[0] !== ' '));
  const out = [`@@ -1,${n} +1,${m} @@`];
  let gap = false;
  ops.forEach((o, k) => { if (keep[k]) { if (gap && out.length > 1) out.push(' ...'); gap = false; out.push(o[0] + o[1]); } else gap = true; });
  return out;
}

function podMem(cl, p) {
  const rt = cl.rt.get(p.metadata.uid);
  return (rt?.containers || []).reduce((s, c) => s + (c.ctr?.h ? [...c.ctr.h.procs.values()].reduce((q, pr) => q + (pr.mem || 0), 0) : 0), 0);
}

function createCmd(c, a, pos, cl, ns, emit, conn) {
  const [what, ...rest] = pos;
  const out = (...l) => c.print(...l);
  const dry = a.val('--dry-run');
  const finish = obj => {
    if (dry) { if (a.output === 'json') out(...JSON.stringify(obj, null, 2).split('\n')); else out(...toYaml(obj).split('\n')); return 0; }
    if (cl.get(obj.kind, obj.metadata.namespace || ns, obj.metadata.name)) return c.fail(`error: failed to create ${obj.kind.toLowerCase()}: ${pluralOf(cl, obj.kind)} "${obj.metadata.name}" already exists`, 1);
    const r = cl.apply(obj, { ns });
    if (r.error) return c.fail(r.error, 1);
    out(`${resName(r.obj)} created`);
    emit({ kind: obj.kind, name: obj.metadata.name });
    c.uni.advance(1);
    return 0;
  };
  const fromData = () => {
    const data = {};
    for (const kv of a.all('--from-literal')) { const i = kv.indexOf('='); data[kv.slice(0, i)] = kv.slice(i + 1); }
    for (const f of a.all('--from-file')) { const [k, p] = f.includes('=') ? f.split('=') : [basename(f), f]; const t = c.host.files.get(c.resolve(p)); if (t === undefined) return { error: `error: error reading ${p}: no such file or directory` }; data[k] = t; }
    for (const f of a.all('--from-env-file')) { const t = c.host.files.get(c.resolve(f)); if (t === undefined) return { error: `error: open ${f}: no such file or directory` }; for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Za-z_][\w.-]*)=(.*)$/); if (m) data[m[1]] = m[2]; } }
    return { data };
  };
  switch (what) {
    case 'namespace': case 'ns': return finish({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: rest[0] } });
    case 'deployment': case 'deploy': {
      const name = rest[0], image = a.val('--image');
      if (!name || !image) return c.fail('error: required flag(s) "image" not set', 1);
      return finish({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: dry ? undefined : ns, labels: { app: name } }, spec: { replicas: Number(a.val('--replicas') || 1), selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: image.split('/').pop().split(':')[0].replace(/[^a-z0-9-]/g, '-'), image, ...(a.val('--port') ? { ports: [{ containerPort: Number(a.val('--port')) }] } : {}), ...(a.rest?.length ? { command: a.rest } : {}) }] } } } });
    }
    case 'configmap': case 'cm': { const d = fromData(); if (d.error) return c.fail(d.error, 1); return finish({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: rest[0], namespace: dry ? undefined : ns }, data: d.data }); }
    case 'secret': {
      const [type, name] = rest;
      if (type === 'generic') { const d = fromData(); if (d.error) return c.fail(d.error, 1); return finish({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: dry ? undefined : ns }, type: 'Opaque', data: Object.fromEntries(Object.entries(d.data).map(([k, v]) => [k, btoa(v)])) }); }
      if (type === 'docker-registry') {
        const server = a.val('--docker-server') || 'https://index.docker.io/v1/';
        const cfg = { auths: { [server.replace(/^https?:\/\//, '').replace(/\/.*$/, '')]: { username: a.val('--docker-username'), password: a.val('--docker-password'), email: a.val('--docker-email'), auth: btoa(`${a.val('--docker-username')}:${a.val('--docker-password')}`) } } };
        return finish({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: dry ? undefined : ns }, type: 'kubernetes.io/dockerconfigjson', data: { '.dockerconfigjson': btoa(JSON.stringify(cfg)) } });
      }
      if (type === 'tls') return c.fail('error: the simulator does not issue TLS secrets in this lab', 1);
      return c.fail(`error: unknown secret type "${type}": use generic, docker-registry or tls`, 1);
    }
    case 'job': { const name = rest[0], image = a.val('--image'); return finish({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: dry ? undefined : ns }, spec: { template: { spec: { containers: [{ name, image, ...(a.rest?.length ? { command: a.rest } : {}) }], restartPolicy: 'Never' } } } }); }
    case 'service': case 'svc': {
      const [type, name] = rest;
      const tcp = (a.val('--tcp') || '').split(':');
      return finish({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: dry ? undefined : ns, labels: { app: name } }, spec: { type: { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer' }[type] || 'ClusterIP', selector: { app: name }, ports: [{ name: `${tcp[0]}-${tcp[1] || tcp[0]}`, port: Number(tcp[0]), targetPort: Number(tcp[1] || tcp[0]), protocol: 'TCP' }] } });
    }
    case 'ingress': {
      const name = rest[0];
      const rules = a.all('--rule').map(r => { const m = r.match(/^([^/]*)(\/[^=]*)=([^:]+):(\d+|\w+)$/); if (!m) return null; return { host: m[1] || undefined, http: { paths: [{ path: m[2].replace(/\*$/, '') || '/', pathType: m[2].endsWith('*') ? 'Prefix' : 'Exact', backend: { service: { name: m[3], port: /^\d+$/.test(m[4]) ? { number: Number(m[4]) } : { name: m[4] } } } }] } }; });
      if (rules.some(r => !r)) return c.fail('error: rule format is host/path=service:port[,tls=secretname]', 1);
      return finish({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, namespace: dry ? undefined : ns }, spec: { ingressClassName: a.val('--class') || 'nginx', rules } });
    }
    case 'serviceaccount': case 'sa': return finish({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: rest[0], namespace: dry ? undefined : ns } });
    case 'role': case 'clusterrole': {
      const name = rest[0];
      const verbs = a.all('--verb').flatMap(v => v.split(',')).filter(Boolean);
      const res = a.all('--resource').flatMap(v => v.split(',')).filter(Boolean);
      if (!name) return c.fail('error: exactly one NAME is required, got 0', 1);
      if (!verbs.length) return c.fail('error: at least one verb must be specified', 1);
      if (!res.length) return c.fail('error: at least one resource must be specified', 1);
      const groups = new Map();
      for (const r of res) {
        const pr = parseResource(cl, r);
        if (!pr) return c.fail(`error: the server doesn't have a resource type "${r.split('/')[0]}"`, 1);
        const g = pr.group === '*' ? '*' : pr.group;
        groups.set(g, [...(groups.get(g) || []), pr.resource]);
      }
      const names = a.all('--resource-name').flatMap(v => v.split(',')).filter(Boolean);
      const rules = [...groups].map(([g, rs]) => ({ apiGroups: [g], resources: rs, verbs, ...(names.length ? { resourceNames: names } : {}) }));
      return finish({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: what === 'role' ? 'Role' : 'ClusterRole', metadata: { name, ...(what === 'role' && !dry ? { namespace: ns } : {}) }, rules });
    }
    case 'rolebinding': case 'clusterrolebinding': {
      const name = rest[0];
      const role = a.val('--role'), crole = a.val('--clusterrole');
      if (!name) return c.fail('error: exactly one NAME is required, got 0', 1);
      if (!role && !crole) return c.fail('error: exactly one of clusterrole or role must be specified', 1);
      if (what === 'clusterrolebinding' && role) return c.fail('error: unknown flag: --role', 1);
      const subjects = [
        ...a.all('--user').map(u => ({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u })),
        ...a.all('--group').map(g => ({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g })),
        ...a.all('--serviceaccount').map(x => { const [sns, sn] = x.split(':'); return { kind: 'ServiceAccount', name: sn, namespace: sns }; }),
      ];
      if (a.all('--serviceaccount').some(x => !x.includes(':'))) return c.fail('error: serviceaccount must be <namespace>:<name>', 1);
      return finish({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: what === 'rolebinding' ? 'RoleBinding' : 'ClusterRoleBinding', metadata: { name, ...(what === 'rolebinding' && !dry ? { namespace: ns } : {}) }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: role ? 'Role' : 'ClusterRole', name: role || crole }, subjects });
    }
    case 'token': {
      const sa = rest[0];
      if (!sa) return c.fail('error: requires a service account name', 1);
      if (!cl.get('ServiceAccount', ns, sa)) return c.fail(`error: failed to create token: serviceaccounts "${sa}" not found`, 1);
      const dur = a.val('--duration') || '1h';
      const secs = parseInt(dur, 10) * ({ s: 1, m: 60, h: 3600 }[dur.slice(-1)] || 1);
      out(issueToken(cl, ns, sa, { seconds: secs }));
      emit({ kind: 'ServiceAccount', name: sa, token: true });
      return 0;
    }
  }
  return c.fail(`error: unknown command "${what}" for "kubectl create"\n\nAvailable Commands:\n  clusterrole  clusterrolebinding  configmap  deployment  ingress  job  namespace  role  rolebinding  secret  service  serviceaccount  token`, 1);
}

function rolloutCmd(c, a, pos, cl, ns, emit) {
  const [sub, ...rest] = pos;
  const tg = targets(rest, cl, ns);
  if (tg.error) return c.fail(tg.error, 1);
  const t = tg.list[0];
  const o = cl.get(t.kind, ns, t.name);
  if (!o) return c.fail(`Error from server (NotFound): ${pluralOf(cl, t.kind)} "${t.name}" not found`, 1);
  const out = (...l) => c.print(...l);
  const rss = () => cl.list('ReplicaSet', ns).filter(r => r.metadata.ownerReferences?.some(x => x.uid === o.metadata.uid)).sort((x, y) => Number(x.metadata.annotations['deployment.kubernetes.io/revision']) - Number(y.metadata.annotations['deployment.kubernetes.io/revision']));
  switch (sub) {
    case 'status': {
      const seen = new Set();
      const timeout = a.val('--timeout') ? parseInt(a.val('--timeout'), 10) * (/m$/.test(a.val('--timeout')) ? 60 : 1) : o.spec.progressDeadlineSeconds + 30;
      let waited = 0;
      while (true) {
        const s = o.status;
        const cond = s.conditions?.find(x => x.type === 'Progressing');
        if (cond?.reason === 'ProgressDeadlineExceeded') { c.eprint(`error: deployment "${o.metadata.name}" exceeded its progress deadline`); emit({ sub, name: o.metadata.name, ok: false }); return 1; }
        if (s.observedGeneration >= o.metadata.generation && s.updatedReplicas === o.spec.replicas && s.availableReplicas >= o.spec.replicas && s.replicas === o.spec.replicas) { out(`deployment "${o.metadata.name}" successfully rolled out`); emit({ sub, name: o.metadata.name, ok: true }); return 0; }
        const msg = s.updatedReplicas < o.spec.replicas ? `Waiting for deployment "${o.metadata.name}" rollout to finish: ${s.updatedReplicas || 0} out of ${o.spec.replicas} new replicas have been updated...` : s.replicas > s.updatedReplicas ? `Waiting for deployment "${o.metadata.name}" rollout to finish: ${s.replicas - s.updatedReplicas} old replicas are pending termination...` : `Waiting for deployment "${o.metadata.name}" rollout to finish: ${s.availableReplicas || 0} of ${o.spec.replicas} updated replicas are available...`;
        if (!seen.has(msg)) { seen.add(msg); out(msg); }
        if (waited >= timeout) { c.eprint('error: timed out waiting for the condition'); emit({ sub, name: o.metadata.name, ok: false }); return 1; }
        c.uni.advance(waited > 60 ? 10 : 2); waited += waited > 60 ? 10 : 2;
      }
    }
    case 'history': {
      const list = rss();
      if (a.val('--revision')) { const r = list.find(x => x.metadata.annotations['deployment.kubernetes.io/revision'] === a.val('--revision')); if (!r) return c.fail(`error: unable to find the specified revision`, 1); out(`deployment.apps/${o.metadata.name} with revision #${a.val('--revision')}`, 'Pod Template:', ...toYaml(r.spec.template).split('\n').map(l => '  ' + l)); return 0; }
      out(`deployment.apps/${o.metadata.name} `, ...table(['REVISION', 'CHANGE-CAUSE'], list.map(r => [r.metadata.annotations['deployment.kubernetes.io/revision'], r.metadata.annotations['kubernetes.io/change-cause'] || '<none>'])), '');
      emit({ sub, name: o.metadata.name });
      return 0;
    }
    case 'undo': {
      const list = rss();
      const curRev = Number(o.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0);
      const to = a.val('--to-revision') ? list.find(x => x.metadata.annotations['deployment.kubernetes.io/revision'] === String(a.val('--to-revision'))) : [...list].reverse().find(x => Number(x.metadata.annotations['deployment.kubernetes.io/revision']) < curRev);
      if (!to) return c.fail(a.val('--to-revision') ? `error: unable to find specified revision ${a.val('--to-revision')} in history` : `error: no rollout history found for deployment "${o.metadata.name}"`, 1);
      const tpl = clone(to.spec.template);
      delete tpl.metadata.labels['pod-template-hash'];
      o.spec.template = tpl;
      o.metadata.generation++;
      if (o.metadata.annotations) delete o.metadata.annotations['kubernetes.io/change-cause'];
      out(`deployment.apps/${o.metadata.name} rolled back`);
      emit({ sub, name: o.metadata.name, to: to.metadata.annotations['deployment.kubernetes.io/revision'] });
      c.uni.advance(1);
      return 0;
    }
    case 'restart': {
      o.spec.template.metadata = o.spec.template.metadata || {};
      o.spec.template.metadata.annotations = { ...(o.spec.template.metadata.annotations || {}), 'kubectl.kubernetes.io/restartedAt': iso(c.uni.time) };
      o.metadata.generation++;
      out(`${resName(o)} restarted`);
      emit({ sub, name: o.metadata.name });
      c.uni.advance(1);
      return 0;
    }
    case 'pause': case 'resume': o.spec.paused = sub === 'pause'; out(`${resName(o)} ${sub}d`); emit({ sub, name: o.metadata.name }); return 0;
  }
  return c.fail(`error: unknown command "${sub}" for "kubectl rollout"`, 1);
}

function configCmd(c, a, pos) {
  const [sub, ...rest] = pos;
  const { path, cfg, error } = kubeconfig(c);
  if (error) return c.fail(error, 1);
  const out = (...l) => c.print(...l);
  if (!cfg && sub !== 'view' && !String(sub).startsWith('set-')) return c.fail(`error: current-context is not set`, 1);
  const cfgOr = cfg || { apiVersion: 'v1', kind: 'Config', clusters: [], contexts: [], users: [], 'current-context': '' };
  if (!cfg && String(sub).startsWith('set-')) { c.host.ensureParents?.(path, c.user); }
  return configSub(c, a, sub, rest, path, cfgOr);
}

function configSub(c, a, sub, rest, path, cfg) {
  const out = (...l) => c.print(...l);
  switch (sub) {
    case 'current-context': out(cfg['current-context']); return 0;
    case 'get-contexts': out(...table(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], (cfg.contexts || []).map(x => [x.name === cfg['current-context'] ? '*' : '', x.name, x.context?.cluster, x.context?.user, x.context?.namespace || '']))); return 0;
    case 'use-context': case 'use': {
      if (!(cfg.contexts || []).some(x => x.name === rest[0])) return c.fail(`error: no context exists with the name: "${rest[0]}"`, 1);
      cfg['current-context'] = rest[0]; saveKubeconfig(c, path, cfg); out(`Switched to context "${rest[0]}".`);
      c.uni.emit({ type: 'kubectl', host: c.host.name, verb: 'config', sub: 'use-context', context: rest[0] });
      return 0;
    }
    case 'set-credentials': {
      const name = rest[0];
      if (!name) return c.fail('error: you must specify a non-empty user name', 1);
      cfg.users = cfg.users || [];
      let u = cfg.users.find(x => x.name === name);
      if (!u) { u = { name, user: {} }; cfg.users.push(u); }
      if (a.raw.token !== undefined) u.user = { token: a.raw.token };
      saveKubeconfig(c, path, cfg);
      out(`User "${name}" set.`);
      c.uni.emit({ type: 'kubectl', host: c.host.name, verb: 'config', sub: 'set-credentials', user: name });
      return 0;
    }
    case 'set-cluster': {
      const name = rest[0];
      cfg.clusters = cfg.clusters || [];
      let cc = cfg.clusters.find(x => x.name === name);
      if (!cc) { cc = { name, cluster: {} }; cfg.clusters.push(cc); }
      if (a.raw.server) cc.cluster.server = a.raw.server;
      saveKubeconfig(c, path, cfg);
      out(`Cluster "${name}" set.`);
      return 0;
    }
    case 'set-context': {
      const name = a.has('--current') ? cfg['current-context'] : rest[0];
      let ctx = (cfg.contexts || []).find(x => x.name === name);
      if (!ctx && !a.has('--current') && name) { ctx = { name, context: {} }; cfg.contexts = [...(cfg.contexts || []), ctx]; }
      if (!ctx) return c.fail(`error: no context exists with the name: "${name}"`, 1);
      if (a.raw.cluster) ctx.context.cluster = a.raw.cluster;
      if (a.raw.user) ctx.context.user = a.raw.user;
      const nsv = a.raw['--namespace'] ?? a.raw.namespace ?? a.val('--namespace');
      if (nsv) ctx.context.namespace = nsv;
      saveKubeconfig(c, path, cfg);
      out(`Context "${name}" ${a.raw.cluster || a.raw.user ? 'created' : 'modified'}.`);
      c.uni.emit({ type: 'kubectl', host: c.host.name, verb: 'config', sub: 'set-context', namespace: nsv });
      return 0;
    }
    case 'view': {
      if (!cfg) { out('apiVersion: v1', 'clusters: null', 'contexts: null', 'current-context: ""', 'kind: Config', 'users: null'); return 0; }
      const red = clone(cfg);
      for (const u of red.users || []) if (u.user?.token) u.user.token = a.has('--raw') ? u.user.token : 'REDACTED';
      out(...toYaml(red).split('\n'));
      return 0;
    }
  }
  return c.fail(`error: unknown command "${sub}" for "kubectl config"`, 1);
}

// a ready-made kubeconfig (what `kind` or a cloud CLI writes for you)
export function kubeconfigText(cl, { user = 'admin', token = 'admin-token', namespace = null, contextName = null } = {}) {
  const ctx = contextName || `kind-${cl.name}`;
  return toYaml({ apiVersion: 'v1', kind: 'Config', clusters: [{ name: ctx, cluster: { server: `https://${cl.cp.ip}:6443`, 'certificate-authority-data': 'LS0tLS1CRUdJTi...' } }], contexts: [{ name: ctx, context: { cluster: ctx, user: `${ctx}-${user}`, ...(namespace ? { namespace } : {}) } }], 'current-context': ctx, users: [{ name: `${ctx}-${user}`, user: { token } }] }) + '\n';
}

export { syncVolumes };
