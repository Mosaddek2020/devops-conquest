// Kyverno policy as code. ClusterPolicies (and namespaced Policies) with validate rules
// check objects as the API server admits them: Enforce denies, Audit records a result in
// a PolicyReport. Rules written for Pods also apply to the pod templates of Deployments,
// StatefulSets, Jobs… (Kyverno's autogen). Patterns support Kyverno's anchors (=(),
// X(), conditional ()), wildcards, negation and alternatives. The kyverno CLI runs the
// same checks against files, which is how CI blocks a pull request before it merges.

import { def } from './registry.js';
import { parseYaml } from '../git/yaml.js';
import { toYaml, table, PRINTERS, age } from './kubectl.js';
import { CLUSTER_SCOPED, clone, iso } from './k8s.js';
import { crdYaml, KYVERNO_CRDS, CHART_HOOKS } from './helm-charts.js';
import { dirname } from './host.js';

const CONTROLLERS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'];
const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease', 'kyverno']);

// ---------------------------------------------------------------- patterns
const wild = (p, v) => new RegExp('^' + String(p).split('*').map(x => x.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('.*') + '$').test(String(v));
function scalarMatch(p, v) {
  if (p === null) return v === null || v === undefined;
  if (typeof p !== 'string') return v !== undefined && String(p) === String(v);
  if (p.includes(' | ')) return p.split(' | ').some(x => scalarMatch(x.trim(), v));
  if (p.includes(' & ')) return p.split(' & ').every(x => scalarMatch(x.trim(), v));
  if (v === undefined || v === null) return false;
  if (p === '?*') return String(v).length > 0;
  if (p.startsWith('!')) return !scalarMatch(p.slice(1), v);
  const cmp = p.match(/^(>=|<=|>|<)\s*(-?[\d.]+)([a-zA-Z]*)$/);
  if (cmp) { const q = s => { const m = String(s).match(/^(-?[\d.]+)([a-zA-Z]*)$/); if (!m) return NaN; const unit = { m: 0.001, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, k: 1000, M: 1e6, G: 1e9 }[m[2]] ?? 1; return Number(m[1]) * unit; }; const a = q(v), b = q(cmp[2] + cmp[3]); return { '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b }[cmp[1]]; }
  if (typeof v === 'boolean' || typeof v === 'number') return p === String(v);
  return wild(p, v);
}
// returns null when value matches pattern, else the JSON path where it failed
export function matchPattern(p, v, path = '/') {
  if (Array.isArray(p)) {
    if (!Array.isArray(v)) return path;
    for (const [i, x] of v.entries()) { for (const pe of p) { const r = matchPattern(pe, x, `${path}${i}/`); if (r !== null && !r.startsWith('~skip')) return r; } }
    return null;
  }
  if (p && typeof p === 'object') {
    if (!v || typeof v !== 'object') return path;
    // conditional anchors first: if one does not match, the whole object is skipped
    for (const [k, pv] of Object.entries(p)) {
      const m = k.match(/^\((.+)\)$/);
      if (m && matchPattern(pv, v[m[1]], `${path}${m[1]}/`) !== null) return null;
    }
    for (const [k, pv] of Object.entries(p)) {
      let m;
      if ((m = k.match(/^\((.+)\)$/))) continue;
      if ((m = k.match(/^=\((.+)\)$/))) { if (v[m[1]] === undefined) continue; const r = matchPattern(pv, v[m[1]], `${path}${m[1]}/`); if (r !== null) return r; continue; }
      if ((m = k.match(/^X\((.+)\)$/))) { if (v[m[1]] !== undefined) return `${path}${m[1]}/`; continue; }
      if ((m = k.match(/^\^\((.+)\)$/))) { const arr = v[m[1]]; if (!Array.isArray(arr) || !arr.some(x => matchPattern(pv[0], x) === null)) return `${path}${m[1]}/`; continue; }
      if ((m = k.match(/^\+\((.+)\)$/))) continue;
      if (pv && typeof pv === 'object') { if (v[k] === undefined) return `${path}${k}/`; const r = matchPattern(pv, v[k], `${path}${k}/`); if (r !== null) return r; continue; }
      if (!scalarMatch(pv, v[k])) return `${path}${k}/`;
    }
    return null;
  }
  return scalarMatch(p, v) ? null : path;
}

// ---------------------------------------------------------------- rules
const actionOf = (pol, rule) => String(rule.validate?.failureAction || pol.spec?.validationFailureAction || 'Audit').toLowerCase() === 'enforce' ? 'Enforce' : 'Audit';
function kindsOf(rule) { const m = rule.match || {}; return [...(m.any || []), ...(m.all || []), ...(m.resources ? [{ resources: m.resources }] : [])].flatMap(x => x.resources?.kinds || []); }
function resourceFilterMatches(f, obj) {
  const r = f.resources || {};
  if (r.kinds && !r.kinds.some(k => k.split('/').pop() === obj.kind)) return false;
  if (r.namespaces && !r.namespaces.some(n => wild(n, obj.metadata?.namespace || ''))) return false;
  if (r.names && !r.names.some(n => wild(n, obj.metadata?.name || ''))) return false;
  if (r.selector?.matchLabels && !Object.entries(r.selector.matchLabels).every(([k, v]) => obj.metadata?.labels?.[k] === v)) return false;
  return true;
}
function blockMatches(block, obj) {
  if (!block) return false;
  if (block.any) return block.any.some(f => resourceFilterMatches(f, obj));
  if (block.all) return block.all.every(f => resourceFilterMatches(f, obj));
  if (block.resources) return resourceFilterMatches(block, obj);
  return false;
}
const subst = (msg, obj) => String(msg || '').replace(/\{\{\s*request\.object\.([\w.]+)\s*\}\}/g, (m, p) => p.split('.').reduce((o, k) => o?.[k], obj) ?? m);

// evaluate one policy against one object: [{ rule, result: pass|fail|skip, message, action }]
export function evaluate(pol, obj) {
  const out = [];
  for (const rule of pol.spec?.rules || []) {
    if (!rule.validate) continue;
    const kinds = kindsOf(rule);
    let target = obj, name = rule.name, prefix = '/';
    const autogen = kinds.includes('Pod') && CONTROLLERS.includes(obj.kind) && pol.metadata?.annotations?.['pod-policies.kyverno.io/autogen-controllers'] !== 'none';
    if (autogen) { target = { apiVersion: 'v1', kind: 'Pod', metadata: { ...(obj.spec?.template?.metadata || {}), namespace: obj.metadata?.namespace }, spec: obj.spec?.template?.spec || {} }; name = `autogen-${rule.name}`; prefix = '/spec/template/'; }
    if (!blockMatches(rule.match, autogen ? { ...target, metadata: { ...target.metadata, name: obj.metadata.name } } : obj)) continue;
    if (rule.exclude && blockMatches(rule.exclude, obj)) { out.push({ rule: name, result: 'skip', message: 'rule excluded' }); continue; }
    const v = rule.validate;
    let failPath = null;
    if (v.pattern) failPath = matchPattern(v.pattern, target);
    else if (v.anyPattern) { const paths = v.anyPattern.map(pp => matchPattern(pp, target)); failPath = paths.every(x => x !== null) ? paths[0] : null; }
    else if (v.deny) failPath = null;
    const action = actionOf(pol, rule);
    if (failPath === null) out.push({ rule: name, result: 'pass', message: `validation rule '${name}' passed.`, action });
    else out.push({ rule: name, result: 'fail', message: `validation error: ${subst(v.message, obj)} rule ${name} failed at path ${failPath === '/' ? '/' : (prefix === '/' ? failPath : prefix + failPath.slice(1))}`, action });
  }
  return out;
}

export function policiesFor(cl, ns) {
  return [...cl.list('ClusterPolicy'), ...(ns ? cl.list('Policy', ns) : [])].filter(p => p.spec?.rules?.length);
}

// ---------------------------------------------------------------- in the cluster
export function installKyverno(cl, { ns = 'kyverno' } = {}) {
  if (cl.kyverno) return cl.kyverno;
  for (const c of KYVERNO_CRDS) if (!cl.crds.has(c.kind)) cl.apply(parseYaml(crdYaml(c)));
  if (!cl.get('Namespace', null, ns)) cl.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
  const node = cl.nodes[0];
  for (const [n, ip] of [['kyverno-admission-controller-6d8f7b9c5d-k2p8s', '10.244.1.230'], ['kyverno-background-controller-7c6b8d9f4-r5t7w', '10.244.1.231'], ['kyverno-reports-controller-5f9c8b7d6-h3j6q', '10.244.1.232'], ['kyverno-cleanup-controller-6b7d8c9f5-n4m2x', '10.244.1.233']]) { const p = cl.staticPod(n, ns, node, ip, 'ghcr.io/kyverno/kyverno:v1.13.0'); p.metadata.labels = { 'app.kubernetes.io/part-of': 'kyverno', 'app.kubernetes.io/component': n.split('-')[1] }; }
  cl.kyverno = { ns, lastScan: 0 };
  cl.admission.push((obj, { op, file }) => {
    if (SYSTEM_NS.has(obj.metadata?.namespace) || ['ClusterPolicy', 'Policy', 'PolicyReport', 'ClusterPolicyReport', 'CustomResourceDefinition', 'Namespace', 'Event'].includes(obj.kind)) return null;
    const blocked = [], warnings = [];
    for (const pol of policiesFor(cl, obj.metadata?.namespace)) {
      const res = evaluate(pol, obj).filter(r => r.result === 'fail');
      const enf = res.filter(r => r.action === 'Enforce');
      if (enf.length) blocked.push(`${pol.metadata.name}:\n${enf.map(r => `  ${r.rule}: '${r.message}'`).join('\n')}`);
      for (const r of res.filter(x => x.action === 'Audit')) if (pol.spec?.emitWarning) warnings.push(`Warning: policy ${pol.metadata.name}.${r.rule}: ${r.message}`);
    }
    if (blocked.length) {
      cl.uni.emit({ type: 'kyverno-deny', cluster: cl.name, kind: obj.kind, ns: obj.metadata?.namespace, name: obj.metadata?.name, policies: blocked.map(b => b.split(':')[0]) });
      return { error: `Error from server: error when ${op === 'CREATE' ? 'creating' : 'applying patch'} "${file}": admission webhook "validate.kyverno.svc-fail" denied the request: \n\nresource ${obj.kind}/${obj.metadata?.namespace || ''}/${obj.metadata?.name} was blocked due to the following policies \n\n${blocked.join('\n')}` };
    }
    return warnings.length ? { warnings } : null;
  });
  cl.controllers.push(scanReports);
  return cl.kyverno;
}
CHART_HOOKS['kyverno/kyverno'] = { after(cl, rel) { installKyverno(cl, { ns: rel.namespace }); } };

// background scans: one PolicyReport per namespace, refreshed every 30 seconds of sim time
function scanReports(cl) {
  if (!cl.kyverno || cl.uni.time - cl.kyverno.lastScan < 30) return;
  cl.kyverno.lastScan = cl.uni.time;
  const byNs = new Map();
  for (const o of [...cl.objs.values()]) {
    if (!o.metadata?.namespace || SYSTEM_NS.has(o.metadata.namespace) || !['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod', 'Service', 'ConfigMap', 'Ingress', 'Secret'].includes(o.kind)) continue;
    if (o.kind === 'Pod' && o.metadata.ownerReferences?.length) continue;
    if (o.metadata.ownerReferences?.length && o.kind !== 'Pod') continue;
    for (const pol of policiesFor(cl, o.metadata.namespace)) {
      if (pol.spec?.background === false) continue;
      for (const r of evaluate(pol, o)) {
        if (!byNs.has(o.metadata.namespace)) byNs.set(o.metadata.namespace, []);
        byNs.get(o.metadata.namespace).push({ policy: pol.metadata.name, rule: r.rule, result: r.result === 'fail' ? (r.action === 'Enforce' ? 'fail' : 'fail') : r.result, message: r.message, resources: [{ apiVersion: o.apiVersion, kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace }], scored: true, source: 'kyverno', timestamp: { seconds: cl.uni.time } });
      }
    }
  }
  for (const r of cl.list('PolicyReport', null)) if (r.metadata.labels?.['app.kubernetes.io/managed-by'] === 'kyverno' && !byNs.has(r.metadata.namespace)) cl.remove(r);
  for (const [ns, results] of byNs) {
    const summary = { pass: results.filter(r => r.result === 'pass').length, fail: results.filter(r => r.result === 'fail').length, warn: 0, error: 0, skip: results.filter(r => r.result === 'skip').length };
    const name = `polr-ns-${ns}`;
    const cur = cl.get('PolicyReport', ns, name);
    if (cur) { cur.results = results; cur.summary = summary; }
    else cl.put({ apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'PolicyReport', metadata: { name, namespace: ns, labels: { 'app.kubernetes.io/managed-by': 'kyverno' } }, results, summary });
  }
}

PRINTERS.ClusterPolicy = (cl, items) => [['NAME', 'ADMISSION', 'BACKGROUND', 'READY', 'AGE', 'MESSAGE'], items.map(p => [p.metadata.name, 'true', String(p.spec?.background !== false), 'True', age(cl.uni, p.metadata.creationTimestamp), 'Ready'])];
PRINTERS.Policy = PRINTERS.ClusterPolicy;
PRINTERS.PolicyReport = (cl, items) => [['NAME', 'PASS', 'FAIL', 'WARN', 'ERROR', 'SKIP', 'AGE'], items.map(r => [r.metadata.name, r.summary?.pass || 0, r.summary?.fail || 0, r.summary?.warn || 0, r.summary?.error || 0, r.summary?.skip || 0, age(cl.uni, r.metadata.creationTimestamp)])];

// ---------------------------------------------------------------- the CLI
function readDocs(c, paths) {
  const docs = [];
  for (const p of paths) {
    const abs = c.resolve(p);
    const files = c.host.isDir(abs) ? [...c.host.files.keys()].filter(f => f.startsWith(abs + '/') && /\.ya?ml$/.test(f)).sort() : [abs];
    if (!c.host.isDir(abs) && c.host.files.get(abs) === undefined) return { error: `Error: failed to load resources: open ${p}: no such file or directory` };
    for (const f of files) {
      for (const part of String(c.host.files.get(f)).split(/^---\s*$/m)) {
        if (!part.trim() || /^\s*(#.*\n?)*\s*$/.test(part)) continue;
        try { const o = parseYaml(part); if (o?.kind) docs.push(Object.assign(o, { __file: f })); } catch (e) { return { error: `Error: failed to decode ${f}: ${e.message}` }; }
      }
    }
  }
  return { docs };
}

def('kyverno', c => {
  const args = c.args;
  const out = (...l) => c.print(...l);
  if (!args.length || args[0] === 'help' || args.includes('--help')) { out('Kubernetes Native Policy Management', '', 'Usage:', '  kyverno [command]', '', 'Available Commands:', '  apply       Applies policies on resources.', '  version     Shows current version of kyverno.'); return 0; }
  if (args[0] === 'version') { out('Version: 1.13.0', 'Time: 2024-10-29T10:14:31Z', 'Git commit ID: 3f39bdc3ff5bb5b03c8a0d4c4edab9d28b1f9a6d'); return 0; }
  if (args[0] !== 'apply') return c.fail(`Error: unknown command "${args[0]}" for "kyverno"`, 1);
  const pols = [], res = [];
  let mode = 'pol';
  let auditWarn = false, detailed = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--resource' || a === '-r') { mode = 'res'; res.push(args[++i]); continue; }
    if (a.startsWith('--resource=')) { res.push(a.slice(11)); continue; }
    if (a === '--audit-warn') { auditWarn = true; continue; }
    if (a === '--detailed-results') { detailed = true; continue; }
    if (a.startsWith('-')) continue;
    (mode === 'res' ? res : pols).push(a);
  }
  if (!pols.length) return c.fail('Error: require policy', 1);
  if (!res.length) return c.fail('Error: no resources passed (use --resource, or --cluster in a real setup)', 1);
  const P = readDocs(c, pols); if (P.error) return c.fail(P.error, 1);
  const R = readDocs(c, res); if (R.error) return c.fail(R.error, 1);
  const policies = P.docs.filter(d => d.kind === 'ClusterPolicy' || d.kind === 'Policy');
  if (!policies.length) return c.fail('Error: failed to load policies: no policies found', 1);
  const resources = R.docs.filter(d => d.kind !== 'ClusterPolicy' && d.kind !== 'Policy');
  const ruleCount = policies.reduce((s, p) => s + (p.spec?.rules || []).filter(r => r.validate).length, 0);
  out(`\nApplying ${ruleCount} policy rule(s) to ${resources.length} resource(s)...`);
  const tally = { pass: 0, fail: 0, warn: 0, error: 0, skip: 0 };
  const lines = [];
  for (const pol of policies) for (const r of resources) {
    const results = evaluate(pol, { ...r, metadata: { namespace: r.metadata?.namespace || 'default', ...r.metadata } });
    const fails = [];
    for (const x of results) {
      if (x.result === 'fail' && x.action === 'Audit' && auditWarn) { tally.warn++; fails.push({ ...x, warn: true }); continue; }
      tally[x.result]++;
      if (x.result === 'fail') fails.push(x);
    }
    if (fails.length) {
      const id = `${r.metadata?.namespace || 'default'}/${r.kind}/${r.metadata?.name}`;
      lines.push('', `policy ${pol.metadata.name} -> resource ${id} ${fails.every(f => f.warn) ? 'failed (audit warning)' : 'failed'}:`, ...fails.map((f, i) => `${i + 1}. ${f.rule}: ${f.message}`));
    }
  }
  if (lines.length) out(...lines);
  out('', `pass: ${tally.pass}, fail: ${tally.fail}, warn: ${tally.warn}, error: ${tally.error}, skip: ${tally.skip} `);
  if (detailed) out(...table(['POLICY', 'RULE', 'RESOURCE', 'RESULT'], []));
  c.uni.emit({ type: 'kyverno-cli', host: c.host.name, args: args.join(' '), ...tally });
  return tally.fail ? 1 : 0;
}, { pkg: 'kyverno' });

export { toYaml, CLUSTER_SCOPED, clone, iso, dirname };
