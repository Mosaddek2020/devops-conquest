// Kubernetes on the simulator. A Cluster holds API objects (plain k8s-shaped JSON) and runs
// the controllers on every clock tick: Deployments own ReplicaSets, ReplicaSets own Pods,
// the scheduler places Pods on nodes by their resource requests, and a kubelet on each
// node pulls images and runs containers (through the Docker engine), restarts them with
// back-off, and runs liveness and readiness probes. Services get a virtual IP that
// load-balances to ready Pods, Ingress routes HTTP by host and path, HPAs scale on CPU.

import { Host } from './host.js';
import { engineOf, createContainer, startContainer, stopContainer } from './docker.js';
import { parseRef, baseFor, snapshotFiles } from './docker-images.js';
import { httpRequest, connect } from './net.js';
import { Session } from './session.js';
import { stripAnsi } from '../git/world.js';

export const API_VERSIONS = { Pod: 'v1', Service: 'v1', ConfigMap: 'v1', Secret: 'v1', Namespace: 'v1', Node: 'v1', PersistentVolumeClaim: 'v1', Endpoints: 'v1', Event: 'v1', Deployment: 'apps/v1', ReplicaSet: 'apps/v1', StatefulSet: 'apps/v1', DaemonSet: 'apps/v1', Ingress: 'networking.k8s.io/v1', HorizontalPodAutoscaler: 'autoscaling/v2', Job: 'batch/v1', CronJob: 'batch/v1' };
export const CLUSTER_SCOPED = new Set(['Namespace', 'Node']);
const ALPHA = 'bcdfghjklmnpqrstvwxz2456789';
let nameSeq = 7;
export const suffix = (n = 5) => { let s = ''; for (let i = 0; i < n; i++) { nameSeq = (nameSeq * 1103515245 + 12345) >>> 0; s += ALPHA[(nameSeq >>> 8) % ALPHA.length]; } return s; };
const hashOf = text => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let s = '';
  for (let i = 0; i < 10; i++) { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; s += ALPHA[h % ALPHA.length]; }
  return s;
};
export const clone = o => JSON.parse(JSON.stringify(o));

// quantities: CPU in millicores, memory in MiB
export function cpuMilli(q) { if (q === undefined || q === null || q === '') return 0; const s = String(q); return s.endsWith('m') ? Number(s.slice(0, -1)) : Math.round(Number(s) * 1000); }
export function memMi(q) {
  if (q === undefined || q === null || q === '') return 0;
  const m = String(q).match(/^([\d.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T|k)?$/);
  if (!m) return 0;
  const v = Number(m[1]);
  return { Ki: v / 1024, Mi: v, Gi: v * 1024, Ti: v * 1048576, K: v / 1048.576, k: v / 1048.576, M: v / 1.048576, G: v * 953.674, T: v * 953674 }[m[2]] ?? v / 1048576;
}
export const selects = (sel, labels = {}) => !!sel && Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels[k] === v);
export function parseSelector(text) {
  const out = {};
  for (const part of String(text || '').split(',').map(x => x.trim()).filter(Boolean)) { const [k, v] = part.split(/==?/); out[k.trim()] = (v ?? '').trim(); }
  return out;
}
const b64d = s => { try { return atob(String(s || '')); } catch { return null; } };

export class Cluster {
  constructor(uni, name, { nodes = 2, nodeCpu = 2000, nodeMemMi = 4096, version = 'v1.31.2', ingress = false, ip = null } = {}) {
    this.uni = uni; this.name = name; this.version = version;
    this.objs = new Map();
    this.events = [];
    this.rt = new Map();          // pod uid -> runtime
    this.svcRt = new Map();       // service uid -> { host, ports }
    this.volumes = new Map();     // 'ns/claim' -> files
    this.load = {};               // 'ns/deployment' -> total CPU demand in millicores (labs set it)
    this.created = uni.time - 86400 * 3;
    this.uidSeq = 1;
    this.svcSeq = 20; this.nodePortSeq = 30080; this.lbSeq = 200;
    // control plane: the API server kubectl talks to
    this.cp = uni.addHost(`${name}-control-plane`, { ip: ip || undefined, kind: 'vm' });
    this.cp.hidden = true; this.cp.cluster = name;
    const api = { kind: 'kube-apiserver', handle: () => ({ status: 403, body: '{"kind":"Status","status":"Failure","reason":"Forbidden","code":403}' }), certFor: () => null };
    const apiProc = this.cp.addProc({ cmd: 'kube-apiserver --secure-port=6443', user: 'root', mem: 300, program: api });
    this.cp.listen(6443, apiProc.pid, { addr: '0.0.0.0', program: api });
    this.put({ kind: 'Node', metadata: { name: this.cp.name, labels: { 'node-role.kubernetes.io/control-plane': '', 'kubernetes.io/hostname': this.cp.name } }, spec: { taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] }, status: { capacity: { cpu: '2', memory: '4Gi', pods: '110' }, allocatable: { cpu: '2', memory: '4Gi', pods: '110' }, nodeInfo: { kubeletVersion: version }, addresses: [{ type: 'InternalIP', address: this.cp.ip }] } }, { at: this.created });
    this.nodes = [];
    for (let i = 0; i < nodes; i++) this.addNode({ cpu: nodeCpu, memMi: nodeMemMi });
    for (const ns of ['default', 'kube-system', 'kube-public', 'kube-node-lease']) this.put({ kind: 'Namespace', metadata: { name: ns } }, { at: this.created });
    this.put({ kind: 'Service', metadata: { name: 'kubernetes', namespace: 'default', labels: { component: 'apiserver', provider: 'kubernetes' } }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.1', ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 6443 }] } }, { at: this.created });
    // the cluster's own components, shown by kubectl -n kube-system (not simulated in depth)
    const cpNode = { name: this.cp.name, host: this.cp, eng: null, cpu: 2000, memMi: 4096, system: true };
    const sys = (name, ns, node, ip, image) => this.staticPod(name, ns, node, ip, image);
    for (const [k, n] of ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler'].entries()) sys(`${n}-${this.cp.name}`, 'kube-system', cpNode, this.cp.ip, `registry.k8s.io/${n}:${n === 'etcd' ? '3.5.15-0' : version}`, k);
    sys(`coredns-7c65d6cfc9-${suffix()}`, 'kube-system', this.nodes[0], '10.244.1.250', 'registry.k8s.io/coredns/coredns:v1.11.3');
    sys(`coredns-7c65d6cfc9-${suffix()}`, 'kube-system', this.nodes[1] || this.nodes[0], '10.244.2.250', 'registry.k8s.io/coredns/coredns:v1.11.3');
    sys(`metrics-server-8549f598b8-${suffix()}`, 'kube-system', this.nodes[0], '10.244.1.251', 'registry.k8s.io/metrics-server/metrics-server:v0.7.2');
    for (const n of [cpNode, ...this.nodes]) { sys(`kube-proxy-${suffix()}`, 'kube-system', n, n.host.ip, `registry.k8s.io/kube-proxy:${version}`); sys(`kindnet-${suffix()}`, 'kube-system', n, n.host.ip, 'docker.io/kindest/kindnetd:v20240813-c6f155d6'); }
    if (ingress) this.installIngress();
  }

  staticPod(name, ns, node, ip, image) {
    const p = this.put({ kind: 'Pod', metadata: { name, namespace: ns, labels: { component: name.split('-').slice(0, -1).join('-') || name } }, spec: { nodeName: node.name, containers: [{ name: name.replace(/-[a-z0-9]{5}$/, '').replace(/-[a-z0-9]{10}$/, ''), image }] }, status: { phase: 'Running' } }, { at: this.created });
    this.rt.set(p.metadata.uid, { static: true, node, ip, containers: [{ name: p.spec.containers[0].name, image, state: 'running', ready: true, restartCount: 0, runs: [], startedAt: this.created }] });
    return p;
  }

  addNode({ cpu = 2000, memMi = 4096 } = {}) {
    const i = this.nodes.length;
    const host = this.uni.addHost(i === 0 ? `${this.name}-worker` : `${this.name}-worker${i + 1}`, { kind: 'vm' });
    host.hidden = true; host.cluster = this.name;
    const eng = engineOf(host, this.uni);
    eng.networks.set('k8s-pods', { name: 'k8s-pods', driver: 'bridge', subnet: `10.244.${i + 1}.0/24`, next: 2, dns: false });
    const node = { name: host.name, host, eng, cpu, memMi };
    this.nodes.push(node);
    this.put({ kind: 'Node', metadata: { name: host.name, labels: { 'kubernetes.io/hostname': host.name, 'kubernetes.io/os': 'linux' } }, spec: {}, status: { capacity: { cpu: String(cpu / 1000), memory: `${memMi}Mi`, pods: '110' }, allocatable: { cpu: `${cpu}m`, memory: `${memMi}Mi`, pods: '110' }, nodeInfo: { kubeletVersion: this.version, containerRuntimeVersion: 'containerd://1.7.22', osImage: 'Debian GNU/Linux 12 (bookworm)' }, addresses: [{ type: 'InternalIP', address: host.ip }] } }, { at: this.created });
    return node;
  }

  // ---------------------------------------------------------------- object store
  key(kind, ns, name) { return `${kind}/${CLUSTER_SCOPED.has(kind) ? '' : ns || 'default'}/${name}`; }
  get(kind, ns, name) { return this.objs.get(this.key(kind, ns, name)) || null; }
  list(kind, ns = null, selector = null) {
    const out = [];
    for (const o of this.objs.values()) if (o.kind === kind && (ns === null || CLUSTER_SCOPED.has(kind) || o.metadata.namespace === ns) && (!selector || selects(selector, o.metadata.labels))) out.push(o);
    return out.sort((a, b) => (a.metadata.namespace || '').localeCompare(b.metadata.namespace || '') || a.metadata.name.localeCompare(b.metadata.name));
  }
  put(obj, { at } = {}) {
    obj.apiVersion = obj.apiVersion || API_VERSIONS[obj.kind] || 'v1';
    const md = obj.metadata = obj.metadata || {};
    if (!CLUSTER_SCOPED.has(obj.kind)) md.namespace = md.namespace || 'default';
    md.uid = md.uid || `${(this.uidSeq++).toString(16).padStart(8, '0')}-${hashOf(obj.kind + md.name + this.uidSeq).slice(0, 4)}-4${hashOf(md.name).slice(0, 3)}-a${hashOf(obj.kind).slice(0, 3)}-${hashOf(md.name + obj.kind + this.uidSeq).padEnd(12, 'x').slice(0, 12)}`;
    md.creationTimestamp = md.creationTimestamp ?? (at ?? this.uni.time);
    md.generation = md.generation || 1;
    md.labels = md.labels || {};
    obj.status = obj.status || {};
    this.objs.set(this.key(obj.kind, md.namespace, md.name), obj);
    return obj;
  }
  remove(obj) { this.objs.delete(this.key(obj.kind, obj.metadata.namespace, obj.metadata.name)); }

  event(obj, type, reason, message) {
    const last = this.events.find(e => e.uid === obj.metadata.uid && e.reason === reason && e.message === message);
    if (last) { last.count++; last.last = this.uni.time; return; }
    this.events.push({ uid: obj.metadata.uid, kind: obj.kind, ns: obj.metadata.namespace || 'default', name: obj.metadata.name, type, reason, message, first: this.uni.time, last: this.uni.time, count: 1 });
    if (this.events.length > 600) this.events.splice(0, 100);
    this.uni.emit({ type: 'k8s-event', cluster: this.name, kind: obj.kind, ns: obj.metadata.namespace, name: obj.metadata.name, reason, message, warning: type === 'Warning' });
  }
  eventsFor(obj) { return this.events.filter(e => e.uid === obj.metadata.uid); }

  // ---------------------------------------------------------------- apply
  // returns { verb: created|configured|unchanged, obj } or { error }
  apply(input, { ns: defNs = 'default', manager = 'kubectl' } = {}) {
    const obj = clone(input);
    if (!obj || typeof obj !== 'object' || !obj.kind) return { error: 'error: error validating data: [apiVersion not set, kind not set]; if you choose to ignore these errors, turn validation off with --validate=false' };
    const want = API_VERSIONS[obj.kind];
    if (!want || obj.apiVersion !== want) return { error: `error: resource mapping not found for name: "${obj.metadata?.name || ''}" namespace: "${obj.metadata?.namespace || ''}" from "${input.__file || '-'}": no matches for kind "${obj.kind}" in version "${obj.apiVersion}"\nensure CRDs are installed first` };
    delete obj.__file;
    if (!obj.metadata?.name) return { error: `error: error validating "${input.__file || '-'}": error validating data: ValidationError(${obj.kind}.metadata): missing required field "name"` };
    if (!CLUSTER_SCOPED.has(obj.kind)) obj.metadata.namespace = obj.metadata.namespace || defNs;
    if (!CLUSTER_SCOPED.has(obj.kind) && !this.get('Namespace', null, obj.metadata.namespace)) return { error: `Error from server (NotFound): error when creating "${input.__file || '-'}": namespaces "${obj.metadata.namespace}" not found` };
    const invalid = this.validate(obj);
    if (invalid) return { error: invalid };
    // Pod Security Admission: pods are refused, workloads only warned about (their pods are refused later)
    const warnings = [];
    const tplSpec = obj.kind === 'Pod' ? obj.spec : ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(obj.kind) ? obj.spec?.template?.spec : null;
    if (tplSpec) {
      const psa = this.podSecurity(obj.metadata.namespace, tplSpec);
      if (psa && obj.kind === 'Pod' && psa.mode === 'enforce') return { error: `Error from server (Forbidden): error when creating "${input.__file || '-'}": pods "${obj.metadata.name}" is forbidden: ${psa.text}` };
      if (psa) warnings.push(`Warning: would violate ${psa.text.replace(/^violates /, '')}`);
    }
    const cur = this.get(obj.kind, obj.metadata.namespace, obj.metadata.name);
    if (!cur) {
      this.defaults(obj);
      this.put(obj);
      this.onCreate(obj);
      return { verb: 'created', obj, warnings };
    }
    // three-way merge, simplified: the applied fields replace the live ones
    if (obj.kind === 'Deployment' && JSON.stringify(cur.spec.selector) !== JSON.stringify(obj.spec.selector)) return { error: `The Deployment "${obj.metadata.name}" is invalid: spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string{${Object.entries(obj.spec.selector?.matchLabels || {}).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}}: field is immutable` };
    this.defaults(obj, cur);
    const before = JSON.stringify([cur.spec, cur.data, cur.stringData, cur.metadata.labels, cur.metadata.annotations]);
    for (const k of Object.keys(obj)) if (!['metadata', 'status'].includes(k)) cur[k] = obj[k];
    for (const k of Object.keys(cur)) if (!(k in obj) && !['metadata', 'status', 'apiVersion', 'kind'].includes(k)) delete cur[k];
    cur.metadata.labels = obj.metadata.labels || {};
    cur.metadata.annotations = { ...(obj.metadata.annotations || {}), ...Object.fromEntries(Object.entries(cur.metadata.annotations || {}).filter(([k]) => k.startsWith('deployment.kubernetes.io/'))) };
    const after = JSON.stringify([cur.spec, cur.data, cur.stringData, cur.metadata.labels, cur.metadata.annotations]);
    if (before === after) return { verb: 'unchanged', obj: cur, warnings };
    cur.metadata.generation++;
    if (cur.kind === 'Secret' && cur.stringData) { cur.data = { ...(cur.data || {}), ...Object.fromEntries(Object.entries(cur.stringData).map(([k, v]) => [k, btoa(String(v))])) }; delete cur.stringData; }
    this.onUpdate(cur);
    return { verb: 'configured', obj: cur, warnings };
  }

  // the Pod Security Standards a namespace enforces (or warns about), and how a pod spec breaks them
  podSecurity(ns, spec) {
    const labels = this.get('Namespace', null, ns)?.metadata.labels || {};
    const enforce = labels['pod-security.kubernetes.io/enforce'], warn = labels['pod-security.kubernetes.io/warn'];
    const level = enforce || warn;
    if (!level || level === 'privileged') return null;
    const v = [];
    const cs = [...(spec.initContainers || []), ...(spec.containers || [])];
    const psc = spec.securityContext || {};
    const priv = cs.filter(c => c.securityContext?.privileged);
    if (priv.length) v.push(`privileged (${priv.map(c => `container "${c.name}"`).join(', ')} must not set securityContext.privileged=true)`);
    const hp = (spec.volumes || []).filter(x => x.hostPath);
    if (hp.length) v.push(`restricted volume types (${hp.map(x => `volume "${x.name}"`).join(', ')} uses restricted volume type "hostPath")`);
    if (spec.hostNetwork) v.push('host namespaces (hostNetwork=true)');
    if (level === 'restricted') {
      const ape = cs.filter(c => c.securityContext?.allowPrivilegeEscalation !== false);
      if (ape.length) v.push(`allowPrivilegeEscalation != false (${ape.map(c => `container "${c.name}"`).join(', ')} must set securityContext.allowPrivilegeEscalation=false)`);
      const caps = cs.filter(c => !(c.securityContext?.capabilities?.drop || []).map(String).includes('ALL'));
      if (caps.length) v.push(`unrestricted capabilities (${caps.map(c => `container "${c.name}"`).join(', ')} must set securityContext.capabilities.drop=["ALL"])`);
      const root = psc.runAsNonRoot === true ? cs.filter(c => c.securityContext?.runAsNonRoot === false) : cs.filter(c => c.securityContext?.runAsNonRoot !== true);
      if (root.length) v.push(`runAsNonRoot != true (pod or ${root.map(c => `container "${c.name}"`).join(', ')} must set securityContext.runAsNonRoot=true)`);
      const sc = cs.filter(c => !['RuntimeDefault', 'Localhost'].includes(c.securityContext?.seccompProfile?.type || psc.seccompProfile?.type));
      if (sc.length) v.push(`seccompProfile (pod or ${sc.map(c => `container "${c.name}"`).join(', ')} must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")`);
    }
    if (!v.length) return null;
    return { mode: enforce && enforce !== 'privileged' ? 'enforce' : 'warn', level, text: `violates PodSecurity "${level}:latest": ${v.join(', ')}` };
  }

  validate(o) {
    const n = `${o.kind} "${o.metadata.name}"`;
    if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(o.metadata.name)) return `The ${n} is invalid: metadata.name: Invalid value: "${o.metadata.name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character`;
    const podSpecErr = (spec, path) => {
      if (!spec?.containers?.length) return `The ${n} is invalid: ${path}.containers: Required value`;
      for (const [i, c] of spec.containers.entries()) {
        if (!c.name) return `The ${n} is invalid: ${path}.containers[${i}].name: Required value`;
        if (!c.image) return `The ${n} is invalid: ${path}.containers[${i}].image: Required value`;
        for (const [j, p] of (c.ports || []).entries()) if (!(p.containerPort > 0)) return `The ${n} is invalid: ${path}.containers[${i}].ports[${j}].containerPort: Required value`;
        const lim = memMi(c.resources?.limits?.memory), req = memMi(c.resources?.requests?.memory);
        if (lim && req && req > lim) return `The ${n} is invalid: ${path}.containers[${i}].resources.requests: Invalid value: "${c.resources.requests.memory}": must be less than or equal to memory limit of ${c.resources.limits.memory}`;
      }
      return null;
    };
    if (o.kind === 'Pod') return podSpecErr(o.spec, 'spec');
    if (['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(o.kind)) {
      const sel = o.spec?.selector?.matchLabels;
      if (!sel) return `The ${n} is invalid: spec.selector: Required value`;
      const labels = o.spec?.template?.metadata?.labels || {};
      if (!selects(sel, labels)) return `The ${n} is invalid: spec.template.metadata.labels: Invalid value: map[string]string{${Object.entries(labels).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}: \`selector\` does not match template \`labels\``;
      return podSpecErr(o.spec.template.spec, 'spec.template.spec');
    }
    if (o.kind === 'Job') return podSpecErr(o.spec?.template?.spec, 'spec.template.spec');
    if (o.kind === 'Service') {
      if (!o.spec?.ports?.length && o.spec?.type !== 'ExternalName') return `The ${n} is invalid: spec.ports: Required value`;
      for (const [i, p] of o.spec.ports.entries()) if (!(p.port > 0)) return `The ${n} is invalid: spec.ports[${i}].port: Required value`;
      if (o.spec.type && !['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(o.spec.type)) return `The ${n} is invalid: spec.type: Unsupported value: "${o.spec.type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`;
    }
    if (o.kind === 'Ingress') {
      for (const r of o.spec?.rules || []) for (const p of r.http?.paths || []) {
        if (!p.pathType) return `The ${n} is invalid: spec.rules[0].http.paths[0].pathType: Required value: pathType must be specified`;
        if (!p.backend?.service?.name) return `The ${n} is invalid: spec.rules[0].http.paths[0].backend: Required value: one of \`service\` or \`resource\` must be specified`;
      }
    }
    if (o.kind === 'Secret' && o.data) for (const [k, v] of Object.entries(o.data)) if (b64d(v) === null) return `Error from server (BadRequest): error when creating: Secret in version "v1" cannot be handled as a Secret: illegal base64 data at input byte 0 (key ${k})`;
    if (o.kind === 'HorizontalPodAutoscaler' && !o.spec?.scaleTargetRef?.name) return `The ${n} is invalid: spec.scaleTargetRef.name: Required value`;
    return null;
  }

  defaults(o, cur = null) {
    if (o.kind === 'Deployment') {
      o.spec.replicas = o.spec.replicas ?? 1;
      o.spec.strategy = o.spec.strategy || { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } };
      o.spec.revisionHistoryLimit = o.spec.revisionHistoryLimit ?? 10;
      o.spec.progressDeadlineSeconds = o.spec.progressDeadlineSeconds ?? 600;
    }
    if (o.kind === 'StatefulSet') o.spec.replicas = o.spec.replicas ?? 1;
    if (o.kind === 'Service') {
      o.spec.type = o.spec.type || 'ClusterIP';
      o.spec.clusterIP = cur?.spec.clusterIP || o.spec.clusterIP || `10.96.${Math.floor(this.svcSeq / 250)}.${(this.svcSeq++ % 250) + 2}`;
      for (const p of o.spec.ports) {
        p.protocol = p.protocol || 'TCP';
        p.targetPort = p.targetPort ?? p.port;
        if (o.spec.type !== 'ClusterIP') p.nodePort = p.nodePort || cur?.spec.ports?.find(q => q.port === p.port)?.nodePort || this.nodePortSeq++;
      }
    }
    if (o.kind === 'Secret') {
      o.type = o.type || 'Opaque';
      if (o.stringData) { o.data = { ...(o.data || {}), ...Object.fromEntries(Object.entries(o.stringData).map(([k, v]) => [k, btoa(String(v))])) }; delete o.stringData; }
    }
    if (o.kind === 'PersistentVolumeClaim') { o.spec.storageClassName = o.spec.storageClassName || 'standard'; o.spec.volumeMode = 'Filesystem'; }
    if (o.kind === 'Pod') { o.spec.restartPolicy = o.spec.restartPolicy || 'Always'; o.spec.terminationGracePeriodSeconds = o.spec.terminationGracePeriodSeconds ?? 30; }
    if (o.kind === 'Job') { o.spec.backoffLimit = o.spec.backoffLimit ?? 6; o.spec.completions = o.spec.completions ?? 1; o.spec.template.spec.restartPolicy = o.spec.template.spec.restartPolicy || 'Never'; }
  }

  onCreate(o) {
    if (o.kind === 'Deployment') this.event(o, 'Normal', 'Created', `deployment ${o.metadata.name} created`);
    if (o.kind === 'PersistentVolumeClaim') { o.status = { phase: 'Bound', capacity: { storage: o.spec.resources?.requests?.storage || '1Gi' }, accessModes: o.spec.accessModes || ['ReadWriteOnce'] }; o.spec.volumeName = `pvc-${o.metadata.uid}`; if (!this.volumes.has(`${o.metadata.namespace}/${o.metadata.name}`)) this.volumes.set(`${o.metadata.namespace}/${o.metadata.name}`, null); }
    if (o.kind === 'Pod') this.rt.set(o.metadata.uid, newRuntime(o));
    if (o.kind === 'Namespace') o.status = { phase: 'Active' };
    this.uni.emit({ type: 'k8s-apply', cluster: this.name, kind: o.kind, ns: o.metadata.namespace, name: o.metadata.name, verb: 'created' });
  }
  onUpdate(o) {
    if (o.kind === 'Pod') { const rt = this.rt.get(o.metadata.uid); if (rt) for (const c of o.spec.containers) { const r = rt.containers.find(x => x.name === c.name); if (r && r.image !== c.image) { r.image = c.image; r.want = 'restart'; } } }
    this.uni.emit({ type: 'k8s-apply', cluster: this.name, kind: o.kind, ns: o.metadata.namespace, name: o.metadata.name, verb: 'configured' });
  }

  // delete with cascading: deployments take their replicasets and pods with them
  delete(o, { now = false } = {}) {
    if (o.kind === 'Namespace') { for (const x of [...this.objs.values()]) if (x.metadata.namespace === o.metadata.name) this.delete(x, { now: true }); this.remove(o); return; }
    if (o.kind === 'Pod') {
      const rt = this.rt.get(o.metadata.uid);
      if (!o.metadata.deletionTimestamp) { o.metadata.deletionTimestamp = this.uni.time; this.event(o, 'Normal', 'Killing', `Stopping container ${o.spec.containers[0].name}`); }
      if (now || !rt?.node) this.finishPod(o);
      return;
    }
    for (const x of this.owned(o)) this.delete(x, { now });
    if (o.kind === 'Service') this.dropService(o);
    if (o.kind === 'PersistentVolumeClaim') this.volumes.delete(`${o.metadata.namespace}/${o.metadata.name}`);
    this.remove(o);
    this.uni.emit({ type: 'k8s-delete', cluster: this.name, kind: o.kind, ns: o.metadata.namespace, name: o.metadata.name });
  }
  owned(o) { return [...this.objs.values()].filter(x => x.metadata.ownerReferences?.some(r => r.uid === o.metadata.uid)); }
  ownerOf(o) { const ref = o.metadata.ownerReferences?.[0]; if (!ref) return null; return [...this.objs.values()].find(x => x.metadata.uid === ref.uid) || null; }

  finishPod(o) {
    const rt = this.rt.get(o.metadata.uid);
    if (rt) {
      this.syncPodVolumes(o, rt);
      for (const c of rt.containers) if (c.ctr && rt.node) stopContainer(rt.node.eng, c.ctr, { remove: true });
      this.rt.delete(o.metadata.uid);
    }
    this.remove(o);
    this.uni.emit({ type: 'k8s-pod-gone', cluster: this.name, ns: o.metadata.namespace, name: o.metadata.name });
  }

  // ---------------------------------------------------------------- controllers
  reconcile() {
    for (const d of this.list('Deployment')) this.syncDeployment(d);
    for (const s of this.list('StatefulSet')) this.syncStatefulSet(s);
    for (const rs of this.list('ReplicaSet')) this.syncReplicaSet(rs);
    for (const j of this.list('Job')) this.syncJob(j);
    for (const p of this.list('Pod')) this.kubelet(p);
    for (const rs of this.list('ReplicaSet')) this.rsStatus(rs);
    for (const st of this.list('StatefulSet')) this.stsStatus(st);
    for (const d of this.list('Deployment')) this.deploymentStatus(d);
    for (const s of this.list('Service')) this.syncService(s);
    for (const h of this.list('HorizontalPodAutoscaler')) this.syncHPA(h);
    for (const i of this.list('Ingress')) if (this.ingressHost && !i.status.loadBalancer?.ingress) i.status.loadBalancer = { ingress: [{ ip: this.ingressHost.ip }] };
  }

  templateHash(tpl) { const t = clone(tpl); if (t.metadata?.labels) delete t.metadata.labels['pod-template-hash']; return hashOf(JSON.stringify(t)); }

  syncDeployment(d) {
    const ns = d.metadata.namespace;
    const rss = this.list('ReplicaSet', ns).filter(rs => rs.metadata.ownerReferences?.some(r => r.uid === d.metadata.uid));
    const hash = this.templateHash(d.spec.template);
    let cur = rss.find(rs => rs.metadata.labels['pod-template-hash'] === hash);
    const maxRev = Math.max(0, ...rss.map(rs => Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || 0)));
    if (!cur) {
      const tpl = clone(d.spec.template);
      tpl.metadata = tpl.metadata || {}; tpl.metadata.labels = { ...(tpl.metadata.labels || {}), 'pod-template-hash': hash };
      cur = this.put({ kind: 'ReplicaSet', metadata: { name: `${d.metadata.name}-${hash}`, namespace: ns, labels: { ...tpl.metadata.labels }, annotations: { 'deployment.kubernetes.io/revision': String(maxRev + 1), ...(d.metadata.annotations?.['kubernetes.io/change-cause'] ? { 'kubernetes.io/change-cause': d.metadata.annotations['kubernetes.io/change-cause'] } : {}) }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: d.metadata.name, uid: d.metadata.uid, controller: true }] }, spec: { replicas: 0, selector: { matchLabels: { ...d.spec.selector.matchLabels, 'pod-template-hash': hash } }, template: tpl } });
      d.metadata.annotations = { ...(d.metadata.annotations || {}), 'deployment.kubernetes.io/revision': String(maxRev + 1) };
      d.status.progressStart = this.uni.time;
      this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled up replica set ${cur.metadata.name} from 0 to ${rss.length ? 1 : d.spec.replicas}`);
      if (!rss.length) cur.spec.replicas = d.spec.replicas;
      rss.push(cur);
    } else if (Number(cur.metadata.annotations['deployment.kubernetes.io/revision']) !== maxRev && rss.some(rs => rs !== cur && rs.spec.replicas > 0)) {
      // rolled back to an older template: it becomes the newest revision
      cur.metadata.annotations['deployment.kubernetes.io/revision'] = String(maxRev + 1);
      d.metadata.annotations['deployment.kubernetes.io/revision'] = String(maxRev + 1);
      if (d.metadata.annotations?.['kubernetes.io/change-cause']) cur.metadata.annotations['kubernetes.io/change-cause'] = d.metadata.annotations['kubernetes.io/change-cause'];
      d.status.progressStart = this.uni.time;
    }
    const old = rss.filter(rs => rs !== cur);
    const want = d.spec.replicas;
    if (d.spec.paused) return;
    if (d.spec.strategy?.type === 'Recreate') {
      for (const rs of old) if (rs.spec.replicas) { this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled down replica set ${rs.metadata.name} from ${rs.spec.replicas} to 0`); rs.spec.replicas = 0; }
      const oldPods = old.reduce((s, rs) => s + this.podsOf(rs).length, 0);
      if (!oldPods && cur.spec.replicas !== want) { this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled up replica set ${cur.metadata.name} from ${cur.spec.replicas} to ${want}`); cur.spec.replicas = want; }
    } else {
      const ru = d.spec.strategy?.rollingUpdate || {};
      const pct = (v, def) => { const s = String(v ?? def); return s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : null; };
      const surge = pct(ru.maxSurge, '25%') !== null ? Math.ceil(want * pct(ru.maxSurge, '25%')) : Number(ru.maxSurge);
      let unavail = pct(ru.maxUnavailable, '25%') !== null ? Math.floor(want * pct(ru.maxUnavailable, '25%')) : Number(ru.maxUnavailable);
      if (!surge && !unavail) unavail = 1;
      const total = rss.reduce((s, rs) => s + rs.spec.replicas, 0);
      if (!old.some(rs => rs.spec.replicas > 0)) {
        if (cur.spec.replicas !== want) { this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled ${cur.spec.replicas < want ? 'up' : 'down'} replica set ${cur.metadata.name} from ${cur.spec.replicas} to ${want}`); cur.spec.replicas = want; }
      } else {
        // scale up the new set within the surge budget
        const room = want + surge - total;
        if (room > 0 && cur.spec.replicas < want) { const to = Math.min(want, cur.spec.replicas + room); this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled up replica set ${cur.metadata.name} from ${cur.spec.replicas} to ${to}`); cur.spec.replicas = to; }
        // old sets' unhealthy replicas (not ready, or never created, e.g. refused by admission)
        // go first: removing them costs no availability
        for (const rs of old) {
          const bad = rs.spec.replicas - this.podsOf(rs).filter(p => this.podReady(p)).length;
          if (bad > 0) { this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled down replica set ${rs.metadata.name} from ${rs.spec.replicas} to ${rs.spec.replicas - bad}`); rs.spec.replicas -= bad; }
        }
        // then scale down old sets as long as enough pods stay available
        const available = rss.reduce((s, rs) => s + this.podsOf(rs).filter(p => this.podReady(p)).length, 0);
        let canRemove = Math.max(available - (want - unavail), 0);
        for (const rs of old.sort((a, b) => Number(a.metadata.annotations['deployment.kubernetes.io/revision']) - Number(b.metadata.annotations['deployment.kubernetes.io/revision']))) {
          if (canRemove <= 0 || !rs.spec.replicas) continue;
          const by = Math.min(rs.spec.replicas, canRemove);
          this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled down replica set ${rs.metadata.name} from ${rs.spec.replicas} to ${rs.spec.replicas - by}`);
          rs.spec.replicas -= by; canRemove -= by;
        }
      }
    }
    // keep revisionHistoryLimit old sets
    const empty = old.filter(rs => !rs.spec.replicas && !this.podsOf(rs).length).sort((a, b) => Number(b.metadata.annotations['deployment.kubernetes.io/revision']) - Number(a.metadata.annotations['deployment.kubernetes.io/revision']));
    for (const rs of empty.slice(d.spec.revisionHistoryLimit)) this.remove(rs);
  }

  deploymentStatus(d) {
    const rss = this.list('ReplicaSet', d.metadata.namespace).filter(rs => rs.metadata.ownerReferences?.some(r => r.uid === d.metadata.uid));
    const hash = this.templateHash(d.spec.template);
    const cur = rss.find(rs => rs.metadata.labels['pod-template-hash'] === hash);
    const pods = rss.flatMap(rs => this.podsOf(rs)).filter(p => !p.metadata.deletionTimestamp);
    const ready = pods.filter(p => this.podReady(p)).length;
    const updated = cur ? this.podsOf(cur).filter(p => !p.metadata.deletionTimestamp).length : 0;
    const updatedReady = cur ? this.podsOf(cur).filter(p => this.podReady(p)).length : 0;
    const st = d.status;
    Object.assign(st, { observedGeneration: d.metadata.generation, replicas: pods.length, updatedReplicas: updated, readyReplicas: ready, availableReplicas: ready, unavailableReplicas: Math.max(0, d.spec.replicas - ready) });
    const complete = updatedReady === d.spec.replicas && pods.length === d.spec.replicas;
    const avail = ready >= d.spec.replicas - Math.floor(d.spec.replicas * 0.25);
    const conds = [{ type: 'Available', status: avail ? 'True' : 'False', reason: avail ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', message: avail ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.' }];
    if (complete) { conds.push({ type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', message: `ReplicaSet "${cur.metadata.name}" has successfully progressed.` }); st.progressStart = null; }
    else if (st.progressStart != null && this.uni.time - st.progressStart > d.spec.progressDeadlineSeconds) { conds.push({ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: `ReplicaSet "${cur?.metadata.name}" has timed out progressing.` }); if (!st.deadlineReported) { st.deadlineReported = true; this.event(d, 'Warning', 'ProgressDeadlineExceeded', `Deployment "${d.metadata.name}" exceeded its progress deadline`); } }
    else { if (st.progressStart == null) st.progressStart = this.uni.time; st.deadlineReported = false; conds.push({ type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated', message: `ReplicaSet "${cur?.metadata.name}" is progressing.` }); }
    st.conditions = conds;
  }

  podsOf(owner) { return this.list('Pod', owner.metadata.namespace).filter(p => p.metadata.ownerReferences?.some(r => r.uid === owner.metadata.uid)); }

  syncReplicaSet(rs) {
    const pods = this.podsOf(rs).filter(p => !p.metadata.deletionTimestamp);
    const want = rs.spec.replicas ?? 1;
    if (pods.length < want) {
      for (let i = pods.length; i < want; i++) {
        const tpl = clone(rs.spec.template);
        const name = `${rs.metadata.name}-${suffix()}`;
        const psa = this.podSecurity(rs.metadata.namespace, tpl.spec || {});
        if (psa?.mode === 'enforce') { if (!rs.__psaWarned || this.uni.time - rs.__psaWarned > 60) { rs.__psaWarned = this.uni.time; this.event(rs, 'Warning', 'FailedCreate', `Error creating: pods "${name}" is forbidden: ${psa.text}`); } break; }
        const pod = { kind: 'Pod', metadata: { name, namespace: rs.metadata.namespace, labels: tpl.metadata?.labels || {}, annotations: tpl.metadata?.annotations, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: rs.metadata.name, uid: rs.metadata.uid, controller: true }] }, spec: tpl.spec };
        this.defaults(pod); this.put(pod); this.onCreate(pod);
        this.event(rs, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`);
      }
    } else if (pods.length > want) {
      // remove the least useful first: not scheduled, not ready, then the youngest
      const rank = p => (this.rt.get(p.metadata.uid)?.node ? 0 : -100) + (this.podReady(p) ? 0 : -10) - p.metadata.creationTimestamp / 1e10;
      for (const p of pods.sort((a, b) => rank(a) - rank(b)).slice(0, pods.length - want)) { this.event(rs, 'Normal', 'SuccessfulDelete', `Deleted pod: ${p.metadata.name}`); this.delete(p); }
    }
    this.rsStatus(rs);
  }

  rsStatus(rs) {
    const live = this.podsOf(rs).filter(p => !p.metadata.deletionTimestamp);
    rs.status = { replicas: live.length, readyReplicas: live.filter(p => this.podReady(p)).length, availableReplicas: live.filter(p => this.podReady(p)).length, fullyLabeledReplicas: live.length, observedGeneration: rs.metadata.generation };
  }

  syncStatefulSet(s) {
    const ns = s.metadata.namespace;
    const want = s.spec.replicas;
    const hash = this.templateHash(s.spec.template);
    for (let i = 0; i < want; i++) {
      const name = `${s.metadata.name}-${i}`;
      const p = this.get('Pod', ns, name);
      for (const vt of s.spec.volumeClaimTemplates || []) { const claim = `${vt.metadata.name}-${name}`; if (!this.get('PersistentVolumeClaim', ns, claim)) { const pvc = { kind: 'PersistentVolumeClaim', metadata: { name: claim, namespace: ns, labels: { ...(s.spec.selector?.matchLabels || {}) } }, spec: clone(vt.spec) }; this.defaults(pvc); this.put(pvc); this.onCreate(pvc); } }
      if (p) {
        if (p.metadata.labels['controller-revision-hash'] !== hash && !p.metadata.deletionTimestamp && this.list('Pod', ns).filter(x => x.metadata.ownerReferences?.some(r => r.uid === s.metadata.uid)).every(x => this.podReady(x) || x === p)) this.delete(p);
        continue;
      }
      // ordered: pod i waits for pod i-1 to be ready
      if (i > 0 && !this.podReady(this.get('Pod', ns, `${s.metadata.name}-${i - 1}`) || {})) break;
      const tpl = clone(s.spec.template);
      const spec = tpl.spec;
      spec.hostname = name;
      spec.volumes = [...(spec.volumes || []), ...(s.spec.volumeClaimTemplates || []).map(vt => ({ name: vt.metadata.name, persistentVolumeClaim: { claimName: `${vt.metadata.name}-${name}` } }))];
      const pod = { kind: 'Pod', metadata: { name, namespace: ns, labels: { ...(tpl.metadata?.labels || {}), 'controller-revision-hash': hash, 'statefulset.kubernetes.io/pod-name': name }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'StatefulSet', name: s.metadata.name, uid: s.metadata.uid, controller: true }] }, spec };
      this.defaults(pod); this.put(pod); this.onCreate(pod);
      this.event(s, 'Normal', 'SuccessfulCreate', `create Pod ${name} in StatefulSet ${s.metadata.name} successful`);
      break;
    }
    const pods = this.list('Pod', ns).filter(x => x.metadata.ownerReferences?.some(r => r.uid === s.metadata.uid));
    for (const p of pods) if (Number(p.metadata.name.split('-').pop()) >= want && !p.metadata.deletionTimestamp) this.delete(p);
    this.stsStatus(s);
  }

  stsStatus(s) {
    const hash = this.templateHash(s.spec.template);
    const pods = this.list('Pod', s.metadata.namespace).filter(x => x.metadata.ownerReferences?.some(r => r.uid === s.metadata.uid) && !x.metadata.deletionTimestamp);
    s.status = { replicas: pods.length, readyReplicas: pods.filter(p => this.podReady(p)).length, currentReplicas: pods.length, updatedReplicas: pods.filter(p => p.metadata.labels['controller-revision-hash'] === hash).length };
  }

  syncJob(j) {
    const pods = this.podsOf(j);
    const succeeded = pods.filter(p => p.status.phase === 'Succeeded').length;
    const failed = pods.filter(p => p.status.phase === 'Failed').length;
    const active = pods.filter(p => !['Succeeded', 'Failed'].includes(p.status.phase) && !p.metadata.deletionTimestamp).length;
    if (succeeded >= j.spec.completions) { if (!j.status.completionTime) { j.status.completionTime = this.uni.time; this.event(j, 'Normal', 'Completed', 'Job completed'); } }
    else if (failed > j.spec.backoffLimit) { if (!j.status.failed) this.event(j, 'Warning', 'BackoffLimitExceeded', 'Job has reached the specified backoff limit'); }
    else if (!active) {
      const tpl = clone(j.spec.template);
      const name = `${j.metadata.name}-${suffix()}`;
      const pod = { kind: 'Pod', metadata: { name, namespace: j.metadata.namespace, labels: { ...(tpl.metadata?.labels || {}), 'job-name': j.metadata.name }, ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: j.metadata.name, uid: j.metadata.uid, controller: true }] }, spec: tpl.spec };
      this.defaults(pod); this.put(pod); this.onCreate(pod);
      this.event(j, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`);
    }
    j.status = { ...j.status, active, succeeded, failed, startTime: j.status.startTime ?? this.uni.time };
  }

  // ---------------------------------------------------------------- kubelet
  podReady(p) { const rt = this.rt.get(p?.metadata?.uid); return !!rt && !p.metadata.deletionTimestamp && rt.containers.length > 0 && rt.containers.every(c => c.state === 'running' && c.ready); }

  schedule(p, rt) {
    const req = podRequests(p);
    if (p.spec.nodeName) { rt.node = this.nodes.find(n => n.name === p.spec.nodeName) || null; return !!rt.node; }
    const fits = [];
    const reasons = { cpu: 0, memory: 0, selector: 0 };
    for (const n of this.nodes) {
      if (p.spec.nodeSelector && !selects(p.spec.nodeSelector, this.get('Node', null, n.name)?.metadata.labels)) { reasons.selector++; continue; }
      const used = this.list('Pod').filter(x => this.rt.get(x.metadata.uid)?.node === n && x !== p).reduce((s, x) => { const r = podRequests(x); return { cpu: s.cpu + r.cpu, mem: s.mem + r.mem }; }, { cpu: 0, mem: 0 });
      if (used.cpu + req.cpu > n.cpu) { reasons.cpu++; continue; }
      if (used.mem + req.mem > n.memMi) { reasons.memory++; continue; }
      const count = this.list('Pod').filter(x => this.rt.get(x.metadata.uid)?.node === n && x !== p && !x.metadata.deletionTimestamp).length;
      fits.push({ n, free: (n.memMi - used.mem - req.mem) / n.memMi + (n.cpu - used.cpu - req.cpu) / n.cpu - count * 0.15 });
    }
    if (!fits.length) {
      const parts = [];
      if (reasons.cpu) parts.push(`${reasons.cpu} Insufficient cpu`);
      if (reasons.memory) parts.push(`${reasons.memory} Insufficient memory`);
      if (reasons.selector) parts.push(`${reasons.selector} node(s) didn't match Pod's node affinity/selector`);
      const msg = `0/${this.nodes.length + 1} nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, ${parts.join(', ')}. preemption: 0/${this.nodes.length + 1} nodes are available: 1 Preemption is not helpful for scheduling, ${this.nodes.length} No preemption victims found for incoming pod.`;
      if (!rt.lastSchedMsg || this.uni.time - rt.lastSchedTry >= 30) { this.event(p, 'Warning', 'FailedScheduling', msg); rt.lastSchedTry = this.uni.time; }
      rt.lastSchedMsg = msg;
      return false;
    }
    fits.sort((a, b) => b.free - a.free);
    rt.node = fits[0].n;
    p.spec.nodeName = rt.node.name;
    this.event(p, 'Normal', 'Scheduled', `Successfully assigned ${p.metadata.namespace}/${p.metadata.name} to ${rt.node.name}`);
    return true;
  }

  // can this node get the image?
  pullable(p, ref) {
    const pr = parseRef(ref);
    const remote = this.uni.registry.lookup ? this.uni.registry.lookup(pr) : this.uni.registry.get(pr.short);
    if (remote) {
      if (!remote.private) return { ok: true };
      const auth = this.uni.registryAuth?.[pr.registry];
      for (const s of p.spec.imagePullSecrets || []) {
        const sec = this.get('Secret', p.metadata.namespace, s.name);
        if (!sec || sec.type !== 'kubernetes.io/dockerconfigjson') continue;
        try { const cfg = JSON.parse(b64d(sec.data['.dockerconfigjson'])); const a = cfg.auths?.[pr.registry]; if (a && (!auth || (a.username === auth.user && a.password === auth.password))) return { ok: true }; } catch { /* bad secret */ }
      }
      return { ok: false, msg: `failed to pull and unpack image "${pr.registry}/${pr.repo}:${pr.tag}": failed to resolve reference "${pr.registry}/${pr.repo}:${pr.tag}": pull access denied, repository does not exist or may require authorization: authorization failed: no basic auth credentials` };
    }
    if (baseFor(ref)) return { ok: true };
    return { ok: false, msg: `failed to pull and unpack image "docker.io/${pr.repo.includes('/') ? '' : 'library/'}${pr.repo}:${pr.tag}": failed to resolve reference "docker.io/${pr.repo.includes('/') ? '' : 'library/'}${pr.repo}:${pr.tag}": ${pr.registry === 'docker.io' ? 'pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed' : `${pr.registry}/${pr.repo}:${pr.tag}: not found`}` };
  }

  resolveEnv(p, c) {
    const env = {};
    const ns = p.metadata.namespace;
    const pull = (kind, name, key, optional) => {
      const o = this.get(kind, ns, name);
      if (!o) return optional ? { skip: true } : { err: `${kind === 'Secret' ? 'secret' : 'configmap'} "${name}" not found` };
      const data = kind === 'Secret' ? Object.fromEntries(Object.entries(o.data || {}).map(([k, v]) => [k, b64d(v)])) : (o.data || {});
      if (key === undefined) return { data };
      if (!(key in data)) return optional ? { skip: true } : { err: `couldn't find key ${key} in ${kind} ${ns}/${name}` };
      return { value: data[key] };
    };
    for (const ef of c.envFrom || []) {
      const r = ef.configMapRef ? pull('ConfigMap', ef.configMapRef.name, undefined, ef.configMapRef.optional) : ef.secretRef ? pull('Secret', ef.secretRef.name, undefined, ef.secretRef.optional) : { data: {} };
      if (r.err) return { error: r.err };
      for (const [k, v] of Object.entries(r.data || {})) env[(ef.prefix || '') + k] = v;
    }
    for (const e of c.env || []) {
      if ('value' in e) { env[e.name] = String(e.value ?? '').replace(/\$\((\w+)\)/g, (m, k) => env[k] ?? m); continue; }
      const vf = e.valueFrom || {};
      if (vf.secretKeyRef || vf.configMapKeyRef) {
        const ref = vf.secretKeyRef || vf.configMapKeyRef;
        const r = pull(vf.secretKeyRef ? 'Secret' : 'ConfigMap', ref.name, ref.key, ref.optional);
        if (r.err) return { error: r.err };
        if (!r.skip) env[e.name] = r.value;
      } else if (vf.fieldRef) {
        const f = vf.fieldRef.fieldPath;
        env[e.name] = f === 'metadata.name' ? p.metadata.name : f === 'metadata.namespace' ? ns : f === 'status.podIP' ? (this.rt.get(p.metadata.uid)?.ip || '') : f === 'spec.nodeName' ? p.spec.nodeName : '';
      }
    }
    return { env };
  }

  // files the pod's volumes put into a container
  mountFiles(p, c) {
    const files = {};
    const vols = Object.fromEntries((p.spec.volumes || []).map(v => [v.name, v]));
    for (const m of c.volumeMounts || []) {
      const v = vols[m.name];
      if (!v) return { error: `spec.containers[0].volumeMounts[0].name: Not found: "${m.name}"` };
      const src = v.configMap ? ['ConfigMap', v.configMap] : v.secret ? ['Secret', { name: v.secret.secretName, items: v.secret.items }] : null;
      if (src) {
        const o = this.get(src[0], p.metadata.namespace, src[1].name);
        if (!o) return { error: `${src[0] === 'Secret' ? 'secret' : 'configmap'} "${src[1].name}" not found`, mount: true };
        const data = src[0] === 'Secret' ? Object.fromEntries(Object.entries(o.data || {}).map(([k, val]) => [k, b64d(val)])) : (o.data || {});
        const items = src[1].items || Object.keys(data).map(k => ({ key: k, path: k }));
        if (m.subPath) { if (m.subPath in data) files[m.mountPath] = data[m.subPath]; }
        else for (const it of items) files[`${m.mountPath}/${it.path}`] = data[it.key] ?? '';
      } else if (v.persistentVolumeClaim) {
        const key = `${p.metadata.namespace}/${v.persistentVolumeClaim.claimName}`;
        if (!this.get('PersistentVolumeClaim', p.metadata.namespace, v.persistentVolumeClaim.claimName)) return { error: `persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" not found`, unschedulable: true };
        files[`${m.mountPath}/`] = { pvc: key };
      } else files[`${m.mountPath}/`] = { dir: true };
    }
    return { files };
  }

  syncPodVolumes(p, rt) {
    for (const c of rt.containers) {
      if (!c.ctr?.h || !c.pvcMounts) continue;
      for (const [mount, key] of c.pvcMounts) {
        if (!this.volumes.has(key)) continue;
        const out = {};
        for (const [path, f] of Object.entries(snapshotFiles(c.ctr.h))) if (path.startsWith(mount + '/')) out[path.slice(mount.length)] = f;
        this.volumes.set(key, out);
      }
    }
  }

  dnsFor(ns) {
    return name => {
      const parts = name.split('.');
      const svcName = parts[0];
      const svcNs = parts.length > 1 && parts[1] !== 'svc' ? parts[1] : ns;
      if (parts.length > 2 && !(parts[2] === 'svc')) return null;
      const s = this.get('Service', svcNs, svcName);
      if (s) return s.spec.clusterIP === 'None' ? (this.endpoints(s)[0]?.ip || null) : s.spec.clusterIP;
      // StatefulSet pods: db-0.db
      if (parts.length > 1) { const pod = this.get('Pod', parts.length > 2 && parts[2] !== 'svc' ? parts[2] : ns, svcName); if (pod) return this.rt.get(pod.metadata.uid)?.ip || null; }
      return null;
    };
  }

  startContainerFor(p, rt, c, spec) {
    const node = rt.node;
    const img = node.eng.findImage(spec.image);
    const envR = this.resolveEnv(p, spec);
    if (envR.error) { c.state = 'waiting'; c.reason = 'CreateContainerConfigError'; c.message = envR.error; this.event(p, 'Warning', 'Failed', `Error: ${envR.error}`); c.nextTry = this.uni.time + 10; return; }
    const mr = this.mountFiles(p, spec);
    if (mr.error) { c.state = 'waiting'; c.reason = 'ContainerCreating'; c.message = mr.error; this.event(p, 'Warning', 'FailedMount', `MountVolume.SetUp failed for volume: ${mr.error}`); c.nextTry = this.uni.time + 10; return; }
    const memLimit = memMi(spec.resources?.limits?.memory) || null;
    const clusterName = this.name;
    const self = this;
    const pvcMounts = [];
    const prepare = h => {
      h.cluster = clusterName; h.clusterOnly = clusterName;
      h.promptName = p.metadata.name;
      h.writeSys('/etc/hostname', p.metadata.name + '\n');
      h.writeSys('/etc/resolv.conf', `search ${p.metadata.namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`);
      h.containerNet = self.dnsFor(p.metadata.namespace);
      h.k8sPod = p;
      for (const [path, f] of Object.entries(mr.files)) {
        if (f && typeof f === 'object' && f.pvc) {
          const mount = path.replace(/\/$/, '');
          pvcMounts.push([mount, f.pvc]);
          h.mkdirMeta(mount, 'root', 0o777);
          const data = self.volumes.get(f.pvc);
          if (data) for (const [rel, file] of Object.entries(data)) { if (file.dir) h.mkdirMeta(mount + rel, file.owner || 'root'); else h.writeFile(mount + rel, file.content, file.owner || 'root'); }
        } else if (f && typeof f === 'object' && f.dir) h.mkdirMeta(path.replace(/\/$/, ''), 'root', 0o777);
        else { h.ensureParents?.(path, 'root'); h.writeFile(path, f, 'root'); }
      }
      if (h.labDbPassword === undefined && c.envFor?.POSTGRES_PASSWORD) h.labDbPassword = c.envFor.POSTGRES_PASSWORD;
    };
    c.envFor = envR.env;
    if (!c.ctr) {
      try {
        c.ctr = createContainer(node.eng, img, { name: `k8s_${spec.name}_${p.metadata.name}_${p.metadata.namespace}_${suffix(4)}`, env: { ...envR.env, KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' }, network: 'k8s-pods', entrypoint: spec.command || null, cmd: spec.args || null, memory: memLimit, user: spec.securityContext?.runAsUser !== undefined ? String(spec.securityContext.runAsUser) : null, workdir: spec.workingDir || null, healthcheck: null, prepare });
      } catch (e) { c.state = 'waiting'; c.reason = 'CreateContainerError'; c.message = e.message; return; }
    } else { c.ctr.prepare = prepare; c.ctr.env = { ...c.ctr.env, ...envR.env }; c.ctr.status = 'created'; }
    c.pvcMounts = pvcMounts;
    const sc = { ...(p.spec?.securityContext || {}), ...(spec.securityContext || {}) };
    if (sc.runAsNonRoot && (['root', '0'].includes(String(c.ctr.user)) ? sc.runAsUser === undefined || Number(sc.runAsUser) === 0 : Number(sc.runAsUser) === 0)) {
      c.state = 'waiting'; c.reason = 'CreateContainerConfigError'; c.message = 'container has runAsNonRoot and image will run as root';
      this.event(p, 'Warning', 'Failed', `Error: ${c.message}`); c.nextTry = this.uni.time + 10; return;
    }
    if (c.everStarted) c.restartCount++;
    c.everStarted = true;
    const logFrom = c.ctr.logs.length;
    const r = startContainer(node.eng, c.ctr);
    c.runs.push({ from: logFrom });
    if (!rt.ip) { rt.ip = c.ctr.ip; p.status.podIP = rt.ip; }
    if (r.ok) {
      c.state = 'running'; c.reason = null; c.message = null; c.startedAt = this.uni.time; c.ready = !spec.readinessProbe; c.probeAt = {}; c.liveFails = 0; c.readyFails = 0;
      this.event(p, 'Normal', 'Created', `Created container ${spec.name}`);
      this.event(p, 'Normal', 'Started', `Started container ${spec.name}`);
    } else this.terminated(p, rt, c, spec, r.code ?? c.ctr.exitCode ?? 1);
  }

  terminated(p, rt, c, spec, code) {
    const oom = !!c.ctr?.oom;
    c.lastState = { exitCode: code, reason: oom ? 'OOMKilled' : code === 0 ? 'Completed' : 'Error', startedAt: c.startedAt, finishedAt: this.uni.time };
    c.state = 'terminated'; c.ready = false; c.exitCode = code; c.reason = c.lastState.reason;
    if (c.runs.length) c.runs[c.runs.length - 1].to = c.ctr?.logs.length;
    const policy = p.spec.restartPolicy || 'Always';
    if (policy === 'Never' || (policy === 'OnFailure' && code === 0)) { c.final = true; return; }
    c.backoff = c.backoff ? Math.min(300, c.backoff * 2) : 10;
    c.nextTry = this.uni.time + c.backoff;
    if (c.restartCount > 0 || code !== 0) this.event(p, 'Warning', 'BackOff', `Back-off restarting failed container ${spec.name} in pod ${p.metadata.name}_${p.metadata.namespace}(${p.metadata.uid})`);
  }

  probe(p, rt, c, pr) {
    const h = c.ctr?.h;
    if (!h) return { ok: false, msg: 'no container' };
    const portOf = port => typeof port === 'number' ? port : Number((p.spec.containers.find(x => x.name === c.name)?.ports || []).find(x => x.name === port)?.containerPort || port);
    if (pr.httpGet) {
      const port = portOf(pr.httpGet.port);
      const res = httpRequest(this.uni, rt.node.host, `http://${rt.ip}:${port}${pr.httpGet.path || '/'}`, { headers: { 'user-agent': 'kube-probe/1.31' } });
      if (res.error) return { ok: false, msg: `Get "http://${rt.ip}:${port}${pr.httpGet.path || '/'}": dial tcp ${rt.ip}:${port}: connect: connection refused` };
      if (res.status >= 200 && res.status < 400) return { ok: true };
      return { ok: false, msg: `HTTP probe failed with statuscode: ${res.status}` };
    }
    if (pr.tcpSocket) { const port = portOf(pr.tcpSocket.port); const r = connect(this.uni, rt.node.host, rt.ip, port); return r.error ? { ok: false, msg: `dial tcp ${rt.ip}:${port}: connect: connection refused` } : { ok: true }; }
    if (pr.exec) {
      const sh = new Session(this.uni, h, { user: 'root', cwd: '/' });
      sh.advancePerCommand = 0;
      for (const [k, v] of Object.entries(c.ctr.env || {})) sh.setVar(sh.e, k, v, { exported: true });
      const cmd = pr.exec.command || [];
      const line = (cmd[0] === 'sh' || cmd[0] === '/bin/sh' || cmd[0] === 'bash') && cmd[1] === '-c' ? cmd.slice(2).join(' ') : cmd.map(x => /[\s'"]/.test(x) ? `'${x}'` : x).join(' ');
      const mark = this.uni.events.length;
      const r = sh.run(line, { record: false });
      this.uni.events.length = mark;
      return r.code === 0 ? { ok: true } : { ok: false, msg: `command ${JSON.stringify(cmd.join(' '))} exited with ${r.code}: ${stripAnsi(r.out.join(' ')).slice(0, 80)}` };
    }
    return { ok: true };
  }

  kubelet(p) {
    const rt = this.rt.get(p.metadata.uid) || (this.rt.set(p.metadata.uid, newRuntime(p)), this.rt.get(p.metadata.uid));
    if (rt.static) return;
    const now = this.uni.time;
    if (p.metadata.deletionTimestamp) {
      // graceful shutdown takes a moment
      if (now - p.metadata.deletionTimestamp >= 2 || !rt.node) this.finishPod(p);
      this.podStatus(p, rt);
      return;
    }
    if (!rt.node && !this.schedule(p, rt)) { this.podStatus(p, rt); return; }
    for (const spec of p.spec.containers) {
      let c = rt.containers.find(x => x.name === spec.name);
      if (!c) { c = newContainerRt(spec); rt.containers.push(c); }
      if (c.final) continue;
      if (c.want === 'restart' && c.ctr) { stopContainer(rt.node.eng, c.ctr, { remove: true }); this.uni.byIp.delete(c.ctr.ip); c.ctr = null; rt.ip = null; c.state = 'waiting'; c.reason = 'ContainerCreating'; c.want = null; c.image = spec.image; c.pulled = false; }
      if (c.state === 'running') {
        // did the process die?
        if (c.ctr.status !== 'running') { this.terminated(p, rt, c, spec, c.ctr.exitCode ?? 1); continue; }
        const due = (pr, key) => pr && now - c.startedAt >= (pr.initialDelaySeconds || 0) && now - (c.probeAt[key] ?? -1e9) >= (pr.periodSeconds || 10);
        if (due(spec.readinessProbe, 'r')) {
          c.probeAt.r = now;
          const r = this.probe(p, rt, c, spec.readinessProbe);
          if (r.ok) { c.readyFails = 0; c.ready = true; }
          else { c.readyFails++; if (c.readyFails >= (spec.readinessProbe.failureThreshold || 3) || !c.ready) { if (c.ready || c.readyFails === 1 || c.readyFails % 6 === 0) this.event(p, 'Warning', 'Unhealthy', `Readiness probe failed: ${r.msg}`); c.ready = false; } }
        }
        if (due(spec.livenessProbe, 'l')) {
          c.probeAt.l = now;
          const r = this.probe(p, rt, c, spec.livenessProbe);
          if (r.ok) c.liveFails = 0;
          else {
            c.liveFails++;
            this.event(p, 'Warning', 'Unhealthy', `Liveness probe failed: ${r.msg}`);
            if (c.liveFails >= (spec.livenessProbe.failureThreshold || 3)) {
              this.event(p, 'Normal', 'Killing', `Container ${spec.name} failed liveness probe, will be restarted`);
              stopContainer(rt.node.eng, c.ctr);
              this.terminated(p, rt, c, spec, 137);
              c.lastState.reason = 'Error';
              c.nextTry = now; // liveness restarts go straight back up
            }
          }
        }
        if (c.pvcMounts?.length) this.syncPodVolumes(p, rt);
        continue;
      }
      if (now < (c.nextTry || 0)) {
        if (c.state === 'terminated' && !c.final) { c.state = 'waiting'; c.reason = c.reason === 'ErrImagePull' ? 'ImagePullBackOff' : 'CrashLoopBackOff'; c.message = `back-off ${c.backoff}s restarting failed container=${spec.name} pod=${p.metadata.name}_${p.metadata.namespace}(${p.metadata.uid})`; }
        if (c.reason === 'ErrImagePull') c.reason = 'ImagePullBackOff';
        continue;
      }
      // pull
      if (!c.pulled) {
        if (!c.pullStarted) {
          const present = rt.node.eng.findImage(spec.image);
          const ok = present ? { ok: true } : this.pullable(p, spec.image);
          if (!ok.ok) {
            this.event(p, 'Normal', 'Pulling', `Pulling image "${spec.image}"`);
            this.event(p, 'Warning', 'Failed', `Failed to pull image "${spec.image}": ${ok.msg}`);
            this.event(p, 'Warning', 'Failed', 'Error: ErrImagePull');
            c.state = 'waiting'; c.reason = 'ErrImagePull'; c.message = ok.msg;
            c.pullBackoff = c.pullBackoff ? Math.min(300, c.pullBackoff * 2) : 10;
            c.nextTry = now + c.pullBackoff;
            continue;
          }
          const have = rt.node.eng.findImage(spec.image) && !/:latest$|^[^:]+$/.test(spec.image.split('/').pop());
          if (have) { this.event(p, 'Normal', 'Pulled', `Container image "${spec.image}" already present on machine`); c.pulled = true; }
          else { this.event(p, 'Normal', 'Pulling', `Pulling image "${spec.image}"`); c.pullStarted = now; c.state = 'waiting'; c.reason = 'ContainerCreating'; continue; }
        } else if (now - c.pullStarted < 2) continue;
        if (!c.pulled) {
          const eng = rt.node.eng;
          const pr = parseRef(spec.image);
          eng.loggedIn.add(pr.registry);
          const img = eng.pullImage(spec.image, { quiet: true });
          eng.loggedIn.delete(pr.registry);
          if (!img) { c.state = 'waiting'; c.reason = 'ErrImagePull'; c.nextTry = now + 10; c.pullStarted = null; continue; }
          this.event(p, 'Normal', 'Pulled', `Successfully pulled image "${spec.image}" in ${(1.2 + (img.sizeMB || 50) / 120).toFixed(3)}s (${(1.2 + (img.sizeMB || 50) / 120).toFixed(3)}s including waiting). Image size: ${Math.round((img.sizeMB || 50) * 1e6)} bytes.`);
          c.pulled = true;
        }
      }
      this.startContainerFor(p, rt, c, spec);
    }
    this.podStatus(p, rt);
  }

  podStatus(p, rt) {
    const st = p.status;
    st.hostIP = rt.node?.host.ip;
    st.podIP = rt.ip || undefined;
    st.startTime = st.startTime ?? (rt.node ? this.uni.time : undefined);
    st.containerStatuses = rt.containers.map(c => ({
      name: c.name, image: c.image, ready: !!c.ready && c.state === 'running', restartCount: c.restartCount, started: c.state === 'running',
      state: c.state === 'running' ? { running: { startedAt: iso(c.startedAt) } } : c.state === 'terminated' ? { terminated: { exitCode: c.exitCode, reason: c.reason, finishedAt: iso(this.uni.time) } } : { waiting: { reason: c.reason || 'ContainerCreating', ...(c.message ? { message: c.message } : {}) } },
      ...(c.lastState ? { lastState: { terminated: { exitCode: c.lastState.exitCode, reason: c.lastState.reason, startedAt: iso(c.lastState.startedAt), finishedAt: iso(c.lastState.finishedAt) } } } : {}),
    }));
    const allDone = rt.containers.length && rt.containers.every(c => c.final);
    st.phase = !rt.node ? 'Pending' : allDone ? (rt.containers.every(c => c.exitCode === 0) ? 'Succeeded' : 'Failed') : rt.containers.some(c => c.state === 'running' || c.everStarted) ? 'Running' : 'Pending';
    const ready = this.podReady(p);
    st.conditions = [{ type: 'PodScheduled', status: rt.node ? 'True' : 'False', ...(rt.node ? {} : { reason: 'Unschedulable', message: rt.lastSchedMsg }) }, { type: 'Initialized', status: 'True' }, { type: 'ContainersReady', status: ready ? 'True' : 'False' }, { type: 'Ready', status: ready ? 'True' : 'False' }];
    st.qosClass = qos(p);
  }

  // ---------------------------------------------------------------- services
  endpoints(s) {
    if (!s.spec.selector) return [];
    const out = [];
    for (const p of this.list('Pod', s.metadata.namespace, s.spec.selector)) {
      if (!this.podReady(p)) continue;
      const rt = this.rt.get(p.metadata.uid);
      out.push({ ip: rt.ip, pod: p, target: tp => typeof tp === 'number' ? tp : Number(p.spec.containers.flatMap(c => c.ports || []).find(x => x.name === tp)?.containerPort || tp) });
    }
    return out;
  }
  notReadyEndpoints(s) { return s.spec.selector ? this.list('Pod', s.metadata.namespace, s.spec.selector).filter(p => !this.podReady(p) && this.rt.get(p.metadata.uid)?.ip) : []; }

  proxyProgram(s, port) {
    const self = this;
    let rr = 0;
    const pick = () => { const eps = self.endpoints(s); if (!eps.length) return null; const e = eps[rr++ % eps.length]; return { ip: e.ip, port: e.target(port.targetPort ?? port.port), pod: e.pod }; };
    const backendProg = () => { const e = pick(); if (!e) return null; const h = self.uni.byIp.get(e.ip); return h?.listening.get(e.port)?.program || null; };
    return {
      kind: 'kube-proxy', svc: s,
      handle(req) {
        const e = pick();
        if (!e) return { error: 'ECONNREFUSED' };
        const via = self.svcRt.get(s.metadata.uid)?.host || self.cp;
        const r = httpRequest(self.uni, via, `http://${e.ip}:${e.port}${req.path}${req.query || ''}`, { method: req.method, headers: req.headers, body: req.body, depth: (req.depth || 0) + 1 });
        if (r.error === 'ECONNREFUSED') return { error: 'RESET', detail: 'Recv failure: Connection reset by peer' };
        if (r.error) return r;
        return { ...r, headers: { ...(r.headers || {}), 'x-served-by': e.pod.metadata.name } };
      },
      checkAuth(url) { return backendProg()?.checkAuth?.(url) ?? null; },
      get data() { return backendProg()?.data; },
      get host() { return backendProg()?.host; },
    };
  }

  syncService(s) {
    if (s.metadata.name === 'kubernetes' && s.metadata.namespace === 'default') return;
    let srt = this.svcRt.get(s.metadata.uid);
    if (!srt) {
      const host = new Host(this.uni, `svc-${s.metadata.name}.${s.metadata.namespace}`, { ip: s.spec.clusterIP, kind: 'service', withWww: false, user: 'root' });
      host.cluster = this.name; host.clusterOnly = this.name; host.hidden = true;
      host.procs.clear();
      const proc = host.addProc({ cmd: 'kube-proxy', user: 'root', mem: 1 });
      this.uni.byIp.set(s.spec.clusterIP, host);
      srt = { host, pid: proc.pid, nodePorts: new Map(), lb: null };
      this.svcRt.set(s.metadata.uid, srt);
    }
    const eps = this.endpoints(s);
    const host = srt.host;
    const wantPorts = new Set(s.spec.ports.map(p => p.port));
    for (const port of [...host.listening.keys()]) if (!wantPorts.has(port)) host.listening.delete(port);
    for (const port of s.spec.ports) {
      if (eps.length) { if (!host.listening.get(port.port) || host.listening.get(port.port).program.svc !== s) host.listening.set(port.port, { pid: srt.pid, addr: '0.0.0.0', proto: 'tcp', program: this.proxyProgram(s, port) }); }
      else host.listening.delete(port.port);
      // NodePort / LoadBalancer: open the port on every node
      if (port.nodePort) for (const n of this.nodes) {
        const forward = { kind: 'nodeport', svc: s, handle: req => httpRequest(this.uni, n.host, `http://${s.spec.clusterIP}:${port.port}${req.path}${req.query || ''}`, { method: req.method, headers: req.headers, body: req.body, depth: (req.depth || 0) + 1 }) };
        if (!n.host.listening.get(port.nodePort)) { const pr = n.host.addProc({ cmd: `kube-proxy nodeport ${port.nodePort}`, user: 'root', mem: 1, program: forward }); n.host.listen(port.nodePort, pr.pid, { addr: '0.0.0.0', program: forward }); }
      }
    }
    if (s.spec.type === 'LoadBalancer') {
      if (!srt.lb && this.uni.time - s.metadata.creationTimestamp >= 4) {
        const lb = this.uni.addHost(`lb-${s.metadata.name}-${s.metadata.namespace}`, { kind: 'vm', ip: `10.0.0.${this.lbSeq++}` });
        lb.hidden = true; lb.cluster = this.name;
        for (const pr0 of [...lb.procs.values()]) if (pr0.pid !== 1) lb.killProc(pr0.pid);
        lb.listening.clear();
        srt.lb = lb;
        s.status.loadBalancer = { ingress: [{ ip: lb.ip }] };
        this.event(s, 'Normal', 'EnsuredLoadBalancer', 'Ensured load balancer');
      }
      if (srt.lb) for (const port of s.spec.ports) if (!srt.lb.listening.get(port.port)) {
        const fwd = { kind: 'loadbalancer', svc: s, handle: req => { const n = this.nodes[0]; return httpRequest(this.uni, n.host, `http://${n.host.ip}:${port.nodePort}${req.path}${req.query || ''}`, { method: req.method, headers: req.headers, body: req.body, depth: (req.depth || 0) + 1 }); } };
        const pr = srt.lb.addProc({ cmd: 'cloud-lb', user: 'root', mem: 1, program: fwd });
        srt.lb.listen(port.port, pr.pid, { addr: '0.0.0.0', program: fwd });
      }
    }
    const subsets = eps.length || this.notReadyEndpoints(s).length ? [{ addresses: eps.map(e => ({ ip: e.ip, targetRef: { kind: 'Pod', name: e.pod.metadata.name } })), notReadyAddresses: this.notReadyEndpoints(s).map(p => ({ ip: this.rt.get(p.metadata.uid).ip, targetRef: { kind: 'Pod', name: p.metadata.name } })), ports: s.spec.ports.map(p => ({ name: p.name, port: typeof p.targetPort === 'number' ? p.targetPort : (eps[0]?.target(p.targetPort) ?? p.targetPort), protocol: 'TCP' })) }] : [];
    const ep = this.get('Endpoints', s.metadata.namespace, s.metadata.name) || this.put({ kind: 'Endpoints', metadata: { name: s.metadata.name, namespace: s.metadata.namespace, labels: { ...(s.metadata.labels || {}) } } });
    ep.subsets = subsets;
  }

  dropService(s) {
    const srt = this.svcRt.get(s.metadata.uid);
    if (srt) {
      this.uni.byIp.delete(s.spec.clusterIP);
      for (const n of this.nodes) for (const port of s.spec.ports) if (port.nodePort) { const l = n.host.listening.get(port.nodePort); if (l) { n.host.killProc(l.pid); n.host.listening.delete(port.nodePort); } }
      if (srt.lb) { this.uni.hosts.delete(srt.lb.name); this.uni.byIp.delete(srt.lb.ip); }
      this.svcRt.delete(s.metadata.uid);
    }
    const ep = this.get('Endpoints', s.metadata.namespace, s.metadata.name);
    if (ep) this.remove(ep);
  }

  // ---------------------------------------------------------------- ingress
  installIngress(ip) {
    if (this.ingressHost) return this.ingressHost;
    this.put({ kind: 'Namespace', metadata: { name: 'ingress-nginx' } }, { at: this.created });
    const h = this.uni.addHost('ingress-nginx', { kind: 'vm', ip: ip || undefined });
    h.hidden = true; h.cluster = this.name;
    for (const pr0 of [...h.procs.values()]) if (pr0.pid !== 1) h.killProc(pr0.pid);
    h.listening.clear();
    const self = this;
    const prog = {
      kind: 'ingress-nginx',
      handle(req) {
        const hostHdr = String(req.headers?.host || '').split(':')[0];
        let best = null;
        for (const ing of self.list('Ingress')) {
          if (ing.spec.ingressClassName && ing.spec.ingressClassName !== 'nginx') continue;
          for (const rule of ing.spec.rules || []) {
            if (rule.host && !(rule.host === hostHdr || (rule.host.startsWith('*.') && hostHdr.endsWith(rule.host.slice(1))))) continue;
            for (const pth of rule.http?.paths || []) {
              const pp = pth.path || '/';
              const hit = pth.pathType === 'Exact' ? req.path === pp : (req.path === pp || req.path.startsWith(pp.replace(/\/$/, '') + '/') || pp === '/');
              if (hit && (!best || pp.length > best.path.length || (rule.host && !best.host))) best = { ing, path: pp, host: rule.host, backend: pth.backend.service };
            }
          }
          if (!best && ing.spec.defaultBackend?.service) best = { ing, path: '', backend: ing.spec.defaultBackend.service };
        }
        if (!best) return { status: 404, headers: { 'content-type': 'text/html' }, body: '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n' };
        const s = self.get('Service', best.ing.metadata.namespace, best.backend.name);
        const port = best.backend.port?.number ?? s?.spec.ports.find(p => p.name === best.backend.port?.name)?.port;
        if (!s || !self.endpoints(s).length) return { status: 503, headers: { 'content-type': 'text/html' }, body: '<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n<body>\r\n<center><h1>503 Service Temporarily Unavailable</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n' };
        const r = httpRequest(self.uni, h, `http://${s.spec.clusterIP}:${port}${req.path}${req.query || ''}`, { method: req.method, headers: req.headers, body: req.body, depth: (req.depth || 0) + 1 });
        if (r.error) return { status: 502, headers: { 'content-type': 'text/html' }, body: '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n' };
        return r;
      },
    };
    const proc = h.addProc({ cmd: '/nginx-ingress-controller --ingress-class=nginx', user: 'root', mem: 90, program: prog });
    h.listen(80, proc.pid, { addr: '0.0.0.0', program: prog });
    this.ingressHost = h;
    this.staticPod(`ingress-nginx-controller-5d9f9f8b4c-${suffix()}`, 'ingress-nginx', this.nodes[0], h.ip, 'registry.k8s.io/ingress-nginx/controller:v1.11.3');
    return h;
  }

  // ---------------------------------------------------------------- autoscaling
  podCpu(p) {
    const owner = this.ownerOf(p);
    const d = owner?.kind === 'ReplicaSet' ? this.ownerOf(owner) : null;
    const key = `${p.metadata.namespace}/${d ? d.metadata.name : owner?.metadata.name || p.metadata.name}`;
    const demand = this.load[key];
    if (!this.podReady(p)) return 1;
    if (demand === undefined) return 2 + (p.metadata.name.charCodeAt(p.metadata.name.length - 1) % 3);
    const peers = d ? this.list('Pod', p.metadata.namespace).filter(x => this.ownerOf(x) && this.ownerOf(this.ownerOf(x) || {})?.metadata?.uid === d.metadata.uid && this.podReady(x)).length : 1;
    return Math.round(demand / Math.max(1, peers));
  }

  syncHPA(hpa) {
    const ref = hpa.spec.scaleTargetRef;
    const d = this.get(ref.kind || 'Deployment', hpa.metadata.namespace, ref.name);
    const st = hpa.status;
    if (!d) { st.currentReplicas = 0; return; }
    const target = hpa.spec.metrics?.find(m => m.resource?.name === 'cpu')?.resource?.target?.averageUtilization ?? hpa.spec.targetCPUUtilizationPercentage ?? 80;
    const pods = this.list('Pod', d.metadata.namespace).filter(p => this.ownerOf(p) && this.ownerOf(this.ownerOf(p))?.metadata.uid === d.metadata.uid && this.podReady(p));
    const req = cpuMilli(d.spec.template.spec.containers[0]?.resources?.requests?.cpu);
    st.currentReplicas = d.spec.replicas;
    if (!req) { st.currentUtilization = null; if (!st.warned) { st.warned = true; this.event(hpa, 'Warning', 'FailedGetResourceMetric', `failed to get cpu utilization: missing request for cpu in container ${d.spec.template.spec.containers[0]?.name} of Pod ${pods[0]?.metadata.name || d.metadata.name}`); } return; }
    if (!pods.length) return;
    const util = Math.round(pods.reduce((s, p) => s + this.podCpu(p), 0) / pods.length / req * 100);
    st.currentUtilization = util;
    const desired = Math.min(hpa.spec.maxReplicas, Math.max(hpa.spec.minReplicas || 1, Math.ceil(pods.length * util / target)));
    st.desiredReplicas = desired;
    const now = this.uni.time;
    if (desired > d.spec.replicas && now - (st.lastScale || 0) >= 15) {
      this.event(hpa, 'Normal', 'SuccessfulRescale', `New size: ${desired}; reason: cpu resource utilization (percentage of request) above target`);
      d.spec.replicas = desired; st.lastScale = now; st.lastScaleTime = iso(now);
      this.uni.emit({ type: 'k8s-scale', cluster: this.name, ns: d.metadata.namespace, name: d.metadata.name, replicas: desired, by: 'hpa' });
    } else if (desired < d.spec.replicas) {
      st.lowSince = st.lowSince ?? now;
      if (now - st.lowSince >= 300) { this.event(hpa, 'Normal', 'SuccessfulRescale', `New size: ${desired}; reason: All metrics below target`); d.spec.replicas = desired; st.lastScale = now; st.lowSince = null; }
    } else st.lowSince = null;
  }
}

function newRuntime(p) { return { node: null, ip: null, containers: [], created: p.metadata.creationTimestamp }; }
function newContainerRt(spec) { return { name: spec.name, image: spec.image, state: 'waiting', reason: 'ContainerCreating', restartCount: 0, ready: false, runs: [], probeAt: {} }; }
export const iso = t => (t === undefined || t === null) ? undefined : new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
export function podRequests(p) {
  let cpu = 0, mem = 0;
  for (const c of p.spec.containers) { cpu += cpuMilli(c.resources?.requests?.cpu ?? c.resources?.limits?.cpu); mem += memMi(c.resources?.requests?.memory ?? c.resources?.limits?.memory); }
  return { cpu, mem };
}
function qos(p) {
  const cs = p.spec.containers;
  if (cs.every(c => c.resources?.limits?.cpu && c.resources?.limits?.memory && (!c.resources.requests || (cpuMilli(c.resources.requests.cpu ?? c.resources.limits.cpu) === cpuMilli(c.resources.limits.cpu) && memMi(c.resources.requests.memory ?? c.resources.limits.memory) === memMi(c.resources.limits.memory))))) return 'Guaranteed';
  if (cs.some(c => c.resources?.requests || c.resources?.limits)) return 'Burstable';
  return 'BestEffort';
}

export function installK8sTicker(uni) {
  uni.tickers.push(() => { for (const c of uni.clusters.values()) { try { c.reconcile(); } catch (e) { console.error('k8s reconcile failed', e); } } });
}

export function createCluster(uni, name, opts = {}) {
  const c = new Cluster(uni, name, opts);
  uni.clusters.set(name, c);
  return c;
}
