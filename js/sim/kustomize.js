// Kustomize: build a set of manifests from a kustomization.yaml (resources, other
// kustomizations as bases, namespace, name prefixes, labels, image and replica overrides,
// strategic-merge and JSON patches, ConfigMap/Secret generators with content-hash names).
// Works on any file source, so `kubectl apply -k` reads the host's disk and Argo CD reads
// a git tree.

import { parseYaml } from '../git/yaml.js';
import { normPath, dirname } from './host.js';

const KFILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];
const clone = o => JSON.parse(JSON.stringify(o));
// kustomize's legacy output order
const ORDER = ['Namespace', 'ResourceQuota', 'StorageClass', 'CustomResourceDefinition', 'ServiceAccount', 'PodSecurityPolicy', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'ConfigMap', 'Secret', 'Endpoints', 'Service', 'LimitRange', 'PriorityClass', 'PersistentVolume', 'PersistentVolumeClaim', 'Deployment', 'StatefulSet', 'CronJob', 'PodDisruptionBudget'];
const LAST = ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'];
const rank = k => ORDER.includes(k) ? ORDER.indexOf(k) : LAST.includes(k) ? 1000 + LAST.indexOf(k) : 500;

// files: { read(path) -> text|undefined, isDir(path), list(dir) -> [paths] }
export function hostFiles(host) {
  return {
    read: p => host.files.get(p),
    isDir: p => host.isDir(p),
    list: d => [...host.files.keys()].filter(p => dirname(p) === d),
  };
}
// a flat {path: content} map (a git tree) as a file source
export function mapFiles(map) {
  const dirs = new Set();
  for (const p of Object.keys(map)) { let d = dirname(p); while (d && d !== '/' && d !== '.' && !dirs.has(d)) { dirs.add(d); d = dirname(d); } }
  return { read: p => map[p], isDir: p => dirs.has(p) || p === '/', list: d => Object.keys(map).filter(p => dirname(p) === d) };
}

export function findKustomization(fs, dir) { for (const f of KFILES) { const p = normPath(dir + '/' + f); if (fs.read(p) !== undefined) return p; } return null; }

const parseDocs = (text, name) => {
  const out = [];
  for (const part of String(text).split(/^---\s*$/m)) {
    if (!part.trim() || /^\s*(#.*\n?)*\s*$/.test(part)) continue;
    const o = parseYaml(part);
    if (o && o.kind === 'List' && Array.isArray(o.items)) out.push(...o.items); else if (o) out.push(o);
  }
  return out.map(o => Object.assign(o, { __file: name }));
};

const fnv = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } const A = 'bcdfghkmt2456789'; let s = ''; for (let i = 0; i < 10; i++) { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; s += A[h % A.length]; } return s; };

// strategic merge: maps merge, lists of named things (containers, env, ports, volumes) merge by name
function smp(dst, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === '$patch') continue;
    if (v === null) { delete dst[k]; continue; }
    if (Array.isArray(v) && Array.isArray(dst[k]) && v.every(x => x && typeof x === 'object' && ('name' in x || 'containerPort' in x || 'mountPath' in x))) {
      const key = v[0] && 'name' in v[0] ? 'name' : v[0] && 'containerPort' in v[0] ? 'containerPort' : 'mountPath';
      for (const item of v) {
        const i = dst[k].findIndex(x => x?.[key] === item[key]);
        if (item.$patch === 'delete') { if (i >= 0) dst[k].splice(i, 1); continue; }
        if (i >= 0) smp(dst[k][i], item); else dst[k].push(clone(item));
      }
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) { smp(dst[k], v); continue; }
    dst[k] = clone(v);
  }
  return dst;
}

// JSON 6902 patches: [{op, path, value}]
function json6902(doc, ops) {
  for (const op of ops) {
    const parts = String(op.path).split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop();
    let cur = doc;
    for (const p of parts) { if (cur[Array.isArray(cur) ? Number(p) : p] === undefined) { if (op.op === 'add') cur[p] = {}; else throw new Error(`doc is missing path: ${op.path}`); } cur = cur[Array.isArray(cur) ? Number(p) : p]; }
    const key = Array.isArray(cur) ? (last === '-' ? cur.length : Number(last)) : last;
    if (op.op === 'remove') { if (Array.isArray(cur)) cur.splice(key, 1); else delete cur[key]; }
    else if (op.op === 'add' && Array.isArray(cur)) cur.splice(key, 0, clone(op.value));
    else if (op.op === 'add' || op.op === 'replace') { if (op.op === 'replace' && !(key in cur)) throw new Error(`replace operation does not apply: doc is missing path: ${op.path}`); cur[key] = clone(op.value); }
    else throw new Error(`unsupported operation: ${op.op}`);
  }
  return doc;
}

const podSpecs = d => {
  const t = d.kind === 'Pod' ? d.spec : d.kind === 'CronJob' ? d.spec?.jobTemplate?.spec?.template?.spec : d.spec?.template?.spec;
  return t ? [t] : [];
};

function targetMatches(t, d) {
  if (!t) return true;
  if (t.kind && t.kind !== d.kind) return false;
  if (t.name && !new RegExp(`^${t.name}$`).test(d.metadata?.__orig || d.metadata?.name)) return false;
  if (t.namespace && t.namespace !== d.metadata?.namespace) return false;
  if (t.labelSelector) for (const part of t.labelSelector.split(',')) { const [k, v] = part.split('='); if (d.metadata?.labels?.[k.trim()] !== (v ?? '').trim()) return false; }
  return true;
}

// build(fs, dir) -> { docs } | { error }
export function kustomizeBuild(fs, dir, depth = 0) {
  dir = normPath(dir);
  if (depth > 10) return { error: `Error: cycle detected in ${dir}` };
  if (!fs.isDir(dir)) return { error: fs.read(dir) === undefined ? `Error: must build at directory: not a valid directory: evalsymlink failure on '${dir}' : lstat ${dir}: no such file or directory` : `Error: must build at directory: '${dir}': file is not directory` };
  const kpath = findKustomization(fs, dir);
  if (!kpath) return { error: `Error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${dir}'` };
  let k;
  try { k = parseYaml(fs.read(kpath)) || {}; } catch (e) { return { error: `Error: invalid Kustomization: ${e.message}` }; }
  const rel = p => normPath(dir + '/' + p);
  let docs = [];
  for (const r of [...(k.resources || []), ...(k.bases || [])]) {
    if (/^(https?|git)[:@]/.test(r)) return { error: `Error: accumulating resources: accumulation err='accumulating resources from '${r}': the simulator cannot fetch remote bases; vendor the files instead'` };
    const p = rel(r);
    if (fs.isDir(p)) { const sub = kustomizeBuild(fs, p, depth + 1); if (sub.error) return { error: sub.error.startsWith('Error: accumulating') ? sub.error : `Error: accumulating resources: accumulation err='accumulating resources from '${r}': ${sub.error.replace(/^Error: /, '')}'` }; docs.push(...sub.docs); continue; }
    const text = fs.read(p);
    if (text === undefined) return { error: `Error: accumulating resources: accumulation err='accumulating resources from '${r}': open ${p}: no such file or directory': must build at directory: not a valid directory: evalsymlink failure on '${p}' : lstat ${p}: no such file or directory` };
    try { docs.push(...parseDocs(text, r)); } catch (e) { return { error: `Error: map[string]interface {}(nil): yaml: ${e.message} in ${r}` }; }
  }
  docs = docs.map(clone);
  // generators
  const opts = k.generatorOptions || {};
  const generated = [];
  for (const [kind, list] of [['ConfigMap', k.configMapGenerator || []], ['Secret', k.secretGenerator || []]]) {
    for (const g of list) {
      const data = {};
      for (const lit of g.literals || []) { const i = lit.indexOf('='); data[lit.slice(0, i)] = lit.slice(i + 1).replace(/^"(.*)"$/, '$1'); }
      for (const f of g.files || []) { const [key, path] = f.includes('=') ? f.split('=') : [f.split('/').pop(), f]; const t = fs.read(rel(path)); if (t === undefined) return { error: `Error: loading KV pairs: file sources: [${f}]: evalsymlink failure on '${rel(path)}' : lstat ${rel(path)}: no such file or directory` }; data[key] = t; }
      for (const f of g.envs || (g.env ? [g.env] : [])) { const t = fs.read(rel(f)); if (t === undefined) return { error: `Error: loading KV pairs: env source files: [${f}]: no such file or directory` }; for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Za-z_][\w.-]*)=(.*)$/); if (m) data[m[1]] = m[2]; } }
      const existing = docs.find(d => d.kind === kind && d.metadata?.name === g.name);
      if ((g.behavior === 'merge' || g.behavior === 'replace') && existing) {
        const cur = kind === 'Secret' ? Object.fromEntries(Object.entries(existing.data || {}).map(([a, b]) => [a, atob(b)])) : (existing.data || {});
        const merged = g.behavior === 'merge' ? { ...cur, ...data } : data;
        if (kind === 'Secret') existing.data = Object.fromEntries(Object.entries(merged).map(([a, b]) => [a, btoa(b)])); else existing.data = merged;
        existing.metadata.__base = existing.metadata.__base || existing.metadata.name.replace(/-[a-z0-9]{10}$/, '');
        continue;
      }
      const o = { apiVersion: 'v1', kind, metadata: { name: g.name, ...(g.namespace ? { namespace: g.namespace } : {}), ...(g.options?.labels ? { labels: g.options.labels } : {}) }, ...(kind === 'Secret' ? { type: g.type || 'Opaque', data: Object.fromEntries(Object.entries(data).map(([a, b]) => [a, btoa(b)])) } : { data }), __file: kpath };
      o.metadata.__gen = !(opts.disableNameSuffixHash || g.options?.disableNameSuffixHash);
      generated.push(o);
      docs.push(o);
    }
  }
  // patches
  const patchList = [...(k.patches || []), ...(k.patchesStrategicMerge || []).map(p => typeof p === 'string' && !p.includes('\n') ? { path: p } : { patch: p }), ...(k.patchesJson6902 || [])];
  for (const pt of patchList) {
    let text = pt.patch;
    if (pt.path) { text = fs.read(rel(pt.path)); if (text === undefined) return { error: `Error: trouble configuring builtin PatchTransformer with config: \`\npath: ${pt.path}\n\`: failed to get the patch file from path(${pt.path}): evalsymlink failure on '${rel(pt.path)}' : lstat ${rel(pt.path)}: no such file or directory` }; }
    let body;
    try { body = typeof text === 'string' ? parseYaml(text) : text; } catch (e) { return { error: `Error: trouble configuring builtin PatchTransformer: ${e.message}` }; }
    if (Array.isArray(body)) {
      const hits = docs.filter(d => targetMatches(pt.target, d));
      if (!hits.length) return { error: `Error: no resource matches target: ${JSON.stringify(pt.target || {})}` };
      try { for (const d of hits) json6902(d, body); } catch (e) { return { error: `Error: ${e.message}` }; }
    } else if (body) {
      const target = pt.target || { kind: body.kind, name: body.metadata?.name };
      const hits = docs.filter(d => targetMatches(target, d));
      if (!hits.length) return { error: `Error: no matches for Id ${body.kind}.${(body.apiVersion || 'v1').split('/').pop()}.${(body.apiVersion || '').includes('/') ? body.apiVersion.split('/')[0] : '[noGrp]'}/${body.metadata?.name}.[noNs]; failed to find unique target for patch ${body.kind}.${(body.apiVersion || 'v1').split('/').pop()}.${(body.apiVersion || '').includes('/') ? body.apiVersion.split('/')[0] : '[noGrp]'}/${body.metadata?.name}.[noNs]` };
      for (const d of hits) { const { metadata, ...rest } = clone(body); smp(d, rest); if (metadata?.labels) d.metadata.labels = { ...(d.metadata.labels || {}), ...metadata.labels }; if (metadata?.annotations) d.metadata.annotations = { ...(d.metadata.annotations || {}), ...metadata.annotations }; }
    }
  }
  // replicas
  for (const r of k.replicas || []) for (const d of docs) if (d.metadata?.name === r.name && ['Deployment', 'StatefulSet', 'ReplicaSet'].includes(d.kind)) d.spec.replicas = Number(r.count);
  // images
  for (const im of k.images || []) {
    for (const d of docs) for (const ps of podSpecs(d)) for (const c of [...(ps.initContainers || []), ...(ps.containers || [])]) {
      const [repo] = splitImage(c.image);
      if (repo !== im.name) continue;
      const [, tag] = splitImage(c.image);
      c.image = (im.newName || repo) + (im.digest ? '@' + im.digest : im.newTag !== undefined ? ':' + im.newTag : tag ? ':' + tag : '');
    }
  }
  // labels and annotations
  const addLabels = (labels, { selectors = true, templates = true } = {}) => {
    for (const d of docs) {
      d.metadata.labels = { ...(d.metadata.labels || {}), ...labels };
      if (templates && d.spec?.template) { d.spec.template.metadata = d.spec.template.metadata || {}; d.spec.template.metadata.labels = { ...(d.spec.template.metadata.labels || {}), ...labels }; }
      if (selectors) {
        if (d.spec?.selector?.matchLabels) d.spec.selector.matchLabels = { ...d.spec.selector.matchLabels, ...labels };
        else if (d.kind === 'Service' && d.spec?.selector) d.spec.selector = { ...d.spec.selector, ...labels };
      }
    }
  };
  if (k.commonLabels) addLabels(k.commonLabels);
  for (const l of k.labels || []) addLabels(l.pairs || {}, { selectors: !!l.includeSelectors, templates: !!(l.includeTemplates || l.includeSelectors) });
  if (k.commonAnnotations) for (const d of docs) d.metadata.annotations = { ...(d.metadata.annotations || {}), ...k.commonAnnotations };
  // namespace
  if (k.namespace) for (const d of docs) { if (!['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'ClusterPolicy', 'ClusterSecretStore'].includes(d.kind)) d.metadata.namespace = k.namespace; if (['RoleBinding', 'ClusterRoleBinding'].includes(d.kind)) for (const s of d.subjects || []) if (s.kind === 'ServiceAccount' && (!s.namespace || s.namespace === 'default')) s.namespace = k.namespace; }
  // names: prefix/suffix, then generator hashes, and every reference follows
  const rename = new Map(); // `${kind}/${old}` -> new
  for (const d of docs) {
    if (d.kind === 'Namespace' || d.kind === 'CustomResourceDefinition') continue;
    const old = d.metadata.name;
    const base = d.metadata.__base || old;
    let nm = (k.namePrefix || '') + base + (k.nameSuffix || '');
    if (d.metadata.__gen) { const content = JSON.stringify({ kind: d.kind, name: nm, data: d.data }); nm = `${nm}-${fnv(content)}`; }
    if (nm !== old) { rename.set(`${d.kind}/${old}`, nm); rename.set(`${d.kind}/${base}`, nm); d.metadata.name = nm; }
  }
  const ref = (kind, name) => rename.get(`${kind}/${name}`) || name;
  for (const d of docs) {
    for (const ps of podSpecs(d)) {
      if (ps.serviceAccountName) ps.serviceAccountName = ref('ServiceAccount', ps.serviceAccountName);
      for (const v of ps.volumes || []) { if (v.configMap) v.configMap.name = ref('ConfigMap', v.configMap.name); if (v.secret) v.secret.secretName = ref('Secret', v.secret.secretName); if (v.persistentVolumeClaim) v.persistentVolumeClaim.claimName = ref('PersistentVolumeClaim', v.persistentVolumeClaim.claimName); }
      for (const s of ps.imagePullSecrets || []) s.name = ref('Secret', s.name);
      for (const c of [...(ps.initContainers || []), ...(ps.containers || [])]) {
        for (const ef of c.envFrom || []) { if (ef.configMapRef) ef.configMapRef.name = ref('ConfigMap', ef.configMapRef.name); if (ef.secretRef) ef.secretRef.name = ref('Secret', ef.secretRef.name); }
        for (const e of c.env || []) { const vf = e.valueFrom || {}; if (vf.configMapKeyRef) vf.configMapKeyRef.name = ref('ConfigMap', vf.configMapKeyRef.name); if (vf.secretKeyRef) vf.secretKeyRef.name = ref('Secret', vf.secretKeyRef.name); }
      }
    }
    if (d.kind === 'Ingress') for (const r of d.spec?.rules || []) for (const p of r.http?.paths || []) if (p.backend?.service) p.backend.service.name = ref('Service', p.backend.service.name);
    if (d.kind === 'HorizontalPodAutoscaler' && d.spec?.scaleTargetRef) d.spec.scaleTargetRef.name = ref(d.spec.scaleTargetRef.kind || 'Deployment', d.spec.scaleTargetRef.name);
    if (['RoleBinding', 'ClusterRoleBinding'].includes(d.kind)) { if (d.roleRef) d.roleRef.name = ref(d.roleRef.kind, d.roleRef.name); for (const s of d.subjects || []) if (s.kind === 'ServiceAccount') s.name = ref('ServiceAccount', s.name); }
    if (d.kind === 'StatefulSet' && d.spec?.serviceName) d.spec.serviceName = ref('Service', d.spec.serviceName);
  }
  for (const d of docs) { delete d.metadata.__gen; delete d.metadata.__base; }
  docs.sort((a, b) => rank(a.kind) - rank(b.kind));
  return { docs };
}

function splitImage(img) {
  const at = img.indexOf('@');
  if (at >= 0) return [img.slice(0, at), null];
  const slash = img.lastIndexOf('/');
  const colon = img.lastIndexOf(':');
  return colon > slash ? [img.slice(0, colon), img.slice(colon + 1)] : [img, null];
}

// kustomize's own YAML output (stable key order, documents separated by ---)
export function docsToYaml(docs, toYaml) {
  return docs.map(d => { const { __file, ...rest } = d; return toYaml(orderTop(rest)); }).join('\n---\n') + '\n';
}
const orderTop = o => { const out = {}; for (const k of ['apiVersion', 'kind', 'metadata']) if (k in o) out[k] = o[k]; for (const [k, v] of Object.entries(o)) if (!(k in out)) out[k] = v; return out; };
