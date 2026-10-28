// NetworkPolicies: once any policy selects a pod, only the traffic some policy allows gets
// through, in each direction it isolates (Ingress, Egress). Denied packets are dropped, so
// a blocked connection times out, as with a real CNI. Rules match pods by labels (in the
// policy's namespace), namespaces by labels, plain IPs by CIDR, and pod ports by number or
// name. Traffic through a Service is judged against the pods behind it, on their ports.

import { ipMatches } from './net.js';

export function matchSelector(sel, labels = {}) {
  if (!sel) return true;
  for (const [k, v] of Object.entries(sel.matchLabels || {})) if (labels[k] !== v) return false;
  for (const e of sel.matchExpressions || []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    if (e.operator === 'In' && !(has && (e.values || []).includes(labels[e.key]))) return false;
    if (e.operator === 'NotIn' && has && (e.values || []).includes(labels[e.key])) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}

export const policyTypes = p => p.spec?.policyTypes || (p.spec?.egress ? ['Ingress', 'Egress'] : ['Ingress']);

// who is on the other end: a pod, the ingress controller, a cluster component, or the outside
function peerOf(h) {
  if (h.k8sPod) return { ns: h.k8sPod.metadata.namespace, labels: h.k8sPod.metadata.labels || {}, ip: h.ip, pod: h.k8sPod };
  if (h.k8sPeer) return { ...h.k8sPeer, ip: h.ip };
  if (h.cluster) return { trusted: true };   // kubelet probes, port-forward, service proxies
  return { ip: h.ip };
}

function peerMatches(cl, peers, who, policyNs) {
  if (!peers || !peers.length) return true;
  return peers.some(pe => {
    if (pe.ipBlock) return !who.ns && ipMatches(who.ip, pe.ipBlock.cidr) && !(pe.ipBlock.except || []).some(x => ipMatches(who.ip, x));
    if (!who.ns) return false;
    const nsOk = pe.namespaceSelector ? matchSelector(pe.namespaceSelector, cl.get('Namespace', null, who.ns)?.metadata.labels || {}) : who.ns === policyNs;
    const podOk = pe.podSelector ? matchSelector(pe.podSelector, who.labels) : true;
    return nsOk && podOk;
  });
}

function portMatches(ports, port, pod) {
  if (!ports || !ports.length) return true;
  return ports.some(p => {
    if (p.port === undefined) return true;
    const want = typeof p.port === 'number' || /^\d+$/.test(String(p.port)) ? Number(p.port) : Number(pod?.spec.containers.flatMap(c => c.ports || []).find(x => x.name === p.port)?.containerPort);
    return p.endPort ? port >= want && port <= p.endPort : port === want;
  });
}

// the pods a connection really lands on, with the port it reaches them on
function destinations(cl, target, port) {
  if (target.k8sPod) return [{ ns: target.k8sPod.metadata.namespace, labels: target.k8sPod.metadata.labels || {}, ip: target.ip, pod: target.k8sPod, port }];
  if (target.k8sSvc) {
    const s = cl.get('Service', target.k8sSvc.metadata.namespace, target.k8sSvc.metadata.name) || target.k8sSvc;
    const sp = s.spec.ports.find(p => p.port === port);
    return cl.endpoints(s).map(e => ({ ns: e.pod.metadata.namespace, labels: e.pod.metadata.labels || {}, ip: e.ip, pod: e.pod, port: e.target(sp ? sp.targetPort ?? sp.port : port) }));
  }
  return null;
}

export function allowsIngress(cl, who, dst) {
  const pols = cl.list('NetworkPolicy', dst.ns).filter(p => policyTypes(p).includes('Ingress') && matchSelector(p.spec.podSelector, dst.labels));
  if (!pols.length) return true;
  return pols.some(p => (p.spec.ingress || []).some(r => peerMatches(cl, r.from, who, p.metadata.namespace) && portMatches(r.ports, dst.port, dst.pod)));
}

export function allowsEgress(cl, src, dst) {
  if (!src.pod) return true;
  const pols = cl.list('NetworkPolicy', src.ns).filter(p => policyTypes(p).includes('Egress') && matchSelector(p.spec.podSelector, src.labels));
  if (!pols.length) return true;
  return pols.some(p => (p.spec.egress || []).some(r => peerMatches(cl, r.to, dst, p.metadata.namespace) && portMatches(r.ports, dst.port, dst.pod)));
}

export function installNetPolicy(uni) {
  if (uni.netPolicy) return;
  uni.netPolicy = (from, target, port) => {
    const src = peerOf(from);
    if (src.trusted) return true;
    const cl = uni.clusters.get(target.cluster || from.cluster);
    if (!cl) return true;
    const dsts = target.cluster ? destinations(cl, target, port) : [{ ip: target.ip, port }];
    if (!dsts) return true;
    if (!dsts.length) return true;          // no endpoints: the connection is refused anyway
    return dsts.some(d => (!d.pod || allowsIngress(cl, src, d)) && (!src.pod || allowsEgress(uni.clusters.get(from.cluster) || cl, src, d)));
  };
}
