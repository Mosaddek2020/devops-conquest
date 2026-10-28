// Helm 3 on the simulated clusters: charts (local directories, or the chart repositories in
// helm-charts.js), values from values.yaml, -f files and --set, templates rendered by the
// Go-template engine, and releases stored in the cluster as Secrets
// (sh.helm.release.v1.<name>.v<revision>), so install, upgrade, history, rollback and
// uninstall behave like the real thing, including --wait, --atomic and --reuse-values.

import { def } from './registry.js';
import { parseYaml } from '../git/yaml.js';
import { C } from '../git/world.js';
import { normPath, dirname } from './host.js';
import { makeEngine, TemplateError } from './gotemplate.js';
import { clusterFor, toYaml, table, pluralOf, singularOf } from './kubectl.js';
import { CLUSTER_SCOPED, clone } from './k8s.js';
import { authorize, forbidden } from './rbac.js';
import { REPOS, CHART_HOOKS } from './helm-charts.js';

const VERSION = 'v3.16.2';
const when = t => { const d = new Date(t * 1000); return `${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, ' ')} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`; };
const updated = t => new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '.000000 +0000 UTC');

// ---------------------------------------------------------------- values
export function deepMerge(base, over) {
  const out = clone(base ?? {});
  for (const [k, v] of Object.entries(over || {})) {
    if (v === null) { delete out[k]; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}
// --set a.b=c,list[0]=x  (--set-string keeps everything a string)
export function parseSet(expr, { asString = false } = {}) {
  const out = {};
  const parts = [];
  let cur = '';
  for (let i = 0; i < expr.length; i++) { if (expr[i] === '\\' && expr[i + 1] === ',') { cur += ','; i++; continue; } if (expr[i] === ',') { parts.push(cur); cur = ''; continue; } cur += expr[i]; }
  if (cur) parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error(`failed parsing --set data: key "${part}" has no value`);
    const key = part.slice(0, eq), raw = part.slice(eq + 1);
    const val = asString ? raw : raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : /^-?\d+$/.test(raw) ? Number(raw) : raw;
    const segs = key.split(/\.(?![^[]*\])/);
    let o = out;
    segs.forEach((seg, k) => {
      const m = seg.match(/^([^[]+)\[(\d+)\]$/);
      const last = k === segs.length - 1;
      if (m) { o[m[1]] = o[m[1]] || []; if (last) o[m[1]][Number(m[2])] = val; else o = o[m[1]][Number(m[2])] = o[m[1]][Number(m[2])] || {}; }
      else if (last) o[seg] = val; else o = o[seg] = o[seg] && typeof o[seg] === 'object' ? o[seg] : {};
    });
  }
  return out;
}

// ---------------------------------------------------------------- charts
// a chart is { files: { 'Chart.yaml': …, 'values.yaml': …, 'templates/x.yaml': … }, meta, hook? }
export function loadChartFromHost(host, dir) {
  const files = {};
  const root = normPath(dir);
  for (const [p, t] of host.files) if (p.startsWith(root + '/')) files[p.slice(root.length + 1)] = t;
  if (files['Chart.yaml'] === undefined) return { error: `Error: Chart.yaml file is missing` };
  return chartFromFiles(files);
}
export function chartFromFiles(files) {
  let meta;
  try { meta = parseYaml(files['Chart.yaml']) || {}; } catch (e) { return { error: `Error: cannot load Chart.yaml: error converting YAML to JSON: yaml: ${e.message}` }; }
  if (!meta.name) return { error: 'Error: validation: chart.metadata.name is required' };
  if (!meta.version) return { error: 'Error: validation: chart.metadata.version is required' };
  return { files, meta };
}

function resolveChart(c, ref, { version } = {}) {
  if (/^oci:\/\//.test(ref)) return { error: `Error: the simulator has no OCI registry for charts; use a chart repository or a local directory` };
  const abs = c.resolve(ref);
  if (c.host.isDir(abs)) return loadChartFromHost(c.host, abs);
  if (ref.startsWith('.') || ref.startsWith('/')) return { error: `Error: path "${ref}" not found` };
  const [repoName, chartName] = ref.split('/');
  if (!chartName) return { error: `Error: non-absolute URLs should be in form of repo_name/path_to_chart, got: ${ref}` };
  const repos = readRepos(c);
  const entry = repos.find(r => r.name === repoName);
  if (!entry) return { error: `Error: repo ${repoName} not found` };
  const repo = Object.values(REPOS).find(r => r.url === entry.url);
  const ch = repo?.charts[chartName];
  if (!ch) return { error: `Error: chart "${chartName}" matching ${version || ''} not found in ${repoName} index. (try 'helm repo update'): no chart name found` };
  if (version && ch.meta.version !== version) return { error: `Error: chart "${chartName}" version "${version}" not found in ${repoName} index. (try 'helm repo update'): improper constraint: ${version}` };
  return { files: ch.files, meta: ch.meta, hook: CHART_HOOKS[`${repo.key}/${chartName}`] || null, hookKey: `${repo.key}/${chartName}`, repo: repoName };
}

function reposPath(c) { return `${c.host.users.get(c.user)?.home || '/root'}/.config/helm/repositories.yaml`; }
function readRepos(c) { try { return parseYaml(c.host.files.get(reposPath(c)) || '')?.repositories || []; } catch { return []; } }
function writeRepos(c, list) { const p = reposPath(c); c.host.ensureParents?.(p, c.user); c.host.writeFile(p, toYaml({ apiVersion: '', generated: '0001-01-01T00:00:00Z', repositories: list }) + '\n', c.user); }

// render every template: [{ file, docs, text }] or { error }
export function renderChart(chart, { name, namespace, values, revision = 1, isUpgrade = false, kubeVersion = 'v1.31.2' }) {
  const tfiles = {};
  for (const [p, t] of Object.entries(chart.files)) if (p.startsWith('templates/') && /\.(ya?ml|tpl|txt)$/.test(p)) tfiles[`${chart.meta.name}/${p}`] = t;
  let engine;
  try { engine = makeEngine({ files: tfiles }); } catch (e) { return { error: `Error: parse error in ${e.message}` }; }
  const base = { Values: values, Release: { Name: name, Namespace: namespace, Revision: revision, IsInstall: !isUpgrade, IsUpgrade: isUpgrade, Service: 'Helm' }, Chart: { Name: chart.meta.name, Version: chart.meta.version, AppVersion: chart.meta.appVersion || '', Description: chart.meta.description || '' }, Capabilities: { KubeVersion: { Version: kubeVersion, Major: '1', Minor: kubeVersion.split('.')[1] }, HelmVersion: { Version: VERSION } } };
  const out = [];
  let notes = '';
  for (const file of Object.keys(tfiles).sort()) {
    const short = file.slice(chart.meta.name.length + 1);
    if (/\/_[^/]*$/.test(file) || short.startsWith('templates/tests/')) continue;
    let text;
    try { text = engine.run(file, { ...base, Template: { Name: file, BasePath: `${chart.meta.name}/templates` } }); }
    catch (e) { if (e instanceof TemplateError) return { error: e.message.startsWith('execution error') || e.message.startsWith('parse error') ? e.message : `template: ${e.message}` }; throw e; }
    if (/NOTES\.txt$/.test(file)) { notes = text; continue; }
    const docs = [];
    for (const part of text.split(/^---\s*$/m)) {
      if (!part.trim() || /^\s*(#.*\n?)*\s*$/.test(part)) continue;
      let o;
      try { o = parseYaml(part); } catch (e) { return { error: `YAML parse error on ${file}: error converting YAML to JSON: yaml: ${e.message}` }; }
      if (o) docs.push(o);
    }
    out.push({ file, docs, text });
  }
  return { rendered: out, notes };
}

// ---------------------------------------------------------------- releases (Secrets in the cluster)
const u8enc = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const u8dec = s => new TextDecoder().decode(Uint8Array.from(atob(s), ch => ch.charCodeAt(0)));
const relKey = (name, rev) => `sh.helm.release.v1.${name}.v${rev}`;
export function releasesOf(cl, name, ns) {
  return cl.list('Secret', ns).filter(s => s.type === 'helm.sh/release.v1' && s.metadata.labels?.name === name).map(s => JSON.parse(u8dec(s.data.release))).sort((a, b) => a.version - b.version);
}
export function allReleases(cl, ns) {
  const by = new Map();
  for (const s of cl.list('Secret', ns)) if (s.type === 'helm.sh/release.v1') { const r = JSON.parse(u8dec(s.data.release)); const k = `${r.namespace}/${r.name}`; if (!by.has(k) || by.get(k).version < r.version) by.set(k, r); }
  return [...by.values()];
}
function saveRelease(cl, r) {
  const key = relKey(r.name, r.version);
  const existing = cl.get('Secret', r.namespace, key);
  const obj = { apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata: { name: key, namespace: r.namespace, labels: { name: r.name, owner: 'helm', status: r.info.status, version: String(r.version) } }, data: { release: u8enc(JSON.stringify(r)) } };
  if (existing) { existing.metadata.labels = obj.metadata.labels; existing.data = obj.data; return; }
  cl.put(obj);
}
const manifestOf = rendered => rendered.map(x => x.docs.map(d => `---\n# Source: ${x.file}\n${toYaml(d)}`).join('\n')).filter(Boolean).join('\n');
const docsOf = manifest => manifest.split(/^---\s*$/m).filter(x => x.trim()).map(x => parseYaml(x)).filter(Boolean);
const objKey = (d, ns) => `${d.kind}/${CLUSTER_SCOPED.has(d.kind) ? '' : d.metadata?.namespace || ns}/${d.metadata?.name}`;

// apply a release's documents; returns { error } on the first failure
function applyDocs(c, conn, cl, docs, rel, { adopt = false } = {}) {
  const prev = new Set();
  for (const d of docs) {
    d.metadata = d.metadata || {};
    if (!CLUSTER_SCOPED.has(d.kind)) d.metadata.namespace = d.metadata.namespace || rel.namespace;
    d.metadata.labels = { ...(d.metadata.labels || {}), 'app.kubernetes.io/managed-by': 'Helm' };
    d.metadata.annotations = { ...(d.metadata.annotations || {}), 'meta.helm.sh/release-name': rel.name, 'meta.helm.sh/release-namespace': rel.namespace };
    const live = cl.get(d.kind, d.metadata.namespace, d.metadata.name);
    if (live && !adopt && live.metadata.annotations?.['meta.helm.sh/release-name'] !== rel.name) return { error: `Unable to continue with install: ${d.kind} "${d.metadata.name}" in namespace "${d.metadata.namespace}" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"; annotation validation error: missing key "meta.helm.sh/release-name": must be set to "${rel.name}"; annotation validation error: missing key "meta.helm.sh/release-namespace": must be set to "${rel.namespace}"` };
    if (conn.role === 'rbac') {
      const rr = cl.resourceOf(d.kind);
      const req = { verb: live ? 'patch' : 'create', resource: rr.resource, group: rr.group, ns: CLUSTER_SCOPED.has(d.kind) ? null : d.metadata.namespace, name: d.metadata.name };
      if (!authorize(cl, conn.ident, req)) return { error: `failed to create resource: ${forbidden(conn.ident, req)}` };
    }
  }
  for (const d of docs) {
    if (d.metadata.namespace && !cl.get('Namespace', null, d.metadata.namespace)) return { error: `failed to create resource: namespaces "${d.metadata.namespace}" not found` };
    const r = cl.apply(d, { ns: rel.namespace, user: conn.ident?.user });
    if (r.error) return { error: r.error.replace(/^Error from server \(\w+\): (error when creating "[^"]*": )?/, '') };
    for (const w of r.warnings || []) c.eprint(`W1101 ${w.replace(/^Warning: /, '')}`);
    prev.add(objKey(d, rel.namespace));
  }
  return { keys: prev };
}

function workloadsReady(cl, docs, ns) {
  return docs.every(d => {
    if (!['Deployment', 'StatefulSet'].includes(d.kind)) return true;
    const o = cl.get(d.kind, d.metadata.namespace || ns, d.metadata.name);
    if (!o) return false;
    const want = o.spec.replicas ?? 1;
    if (d.kind === 'Deployment') return (o.status.updatedReplicas || 0) === want && (o.status.availableReplicas || 0) >= want && (o.status.replicas || 0) === want;
    return (o.status.readyReplicas || 0) >= want;
  });
}
const parseDuration = s => { if (!s) return 300; const m = String(s).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/); return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) || 300 : 300; };

// ---------------------------------------------------------------- the command
const VAL = new Set(['-n', '--namespace', '-f', '--values', '--set', '--set-string', '--version', '--timeout', '--kube-context', '--show-only', '-s', '--revision', '-o', '--output', '--description', '--max', '--repo', '--untardir', '-d', '--destination']);
function parse(args) {
  const o = { _: [], multi: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.includes('=')) { const k = a.slice(0, a.indexOf('=')); (o.multi[k] = o.multi[k] || []).push(a.slice(a.indexOf('=') + 1)); o[k] = a.slice(a.indexOf('=') + 1); continue; }
    if (VAL.has(a)) { const v = args[++i]; (o.multi[a] = o.multi[a] || []).push(v); o[a] = v; continue; }
    if (a.startsWith('-') && a.length > 1) { o[a] = true; continue; }
    o._.push(a);
  }
  o.get = (...ks) => { for (const k of ks) if (o[k] !== undefined) return o[k]; return undefined; };
  o.all = (...ks) => ks.flatMap(k => o.multi[k] || []);
  return o;
}

def('helm', c => {
  const o = parse(c.args);
  const [cmd, ...pos] = o._;
  const out = (...l) => c.print(...l);
  const fail = (m, code = 1) => c.fail(m, code);
  const uni = c.uni;
  const emit = extra => uni.emit({ type: 'helm', host: c.host.name, cmd, args: c.args.join(' '), ...extra });
  if (!cmd || cmd === 'help' || o['--help'] || o['-h']) {
    out('The Kubernetes package manager', '', 'Usage:', '  helm [command]', '', 'Available Commands:', '  create      create a new chart with the given name', '  get         download extended information of a named release', '  history     fetch release history', '  install     install a chart', '  lint        examine a chart for possible issues', '  list        list releases', '  pull        download a chart from a repository', '  repo        add, list, remove, update chart repositories', '  rollback    roll back a release to a previous revision', '  search      search for a keyword in charts', '  show        show information of a chart', '  status      display the status of the named release', '  template    locally render templates', '  uninstall   uninstall a release', '  upgrade     upgrade a release', '  version     print the client version information');
    return 0;
  }
  if (cmd === 'version') { out(`version.BuildInfo{Version:"${VERSION}", GitCommit:"13654a52f7c70a143b1dd51416d633e1071faffb", GitTreeState:"clean", GoVersion:"go1.22.7"}`); return 0; }

  // ---- repositories
  if (cmd === 'repo') {
    const [sub, name, url] = pos;
    const list = readRepos(c);
    if (sub === 'add') {
      if (!name || !url) return fail('Error: "helm repo add" requires 2 arguments\n\nUsage:  helm repo add [NAME] [URL] [flags]');
      const known = Object.values(REPOS).find(r => r.url === url.replace(/\/$/, ''));
      if (!known) return fail(`Error: looks like "${url}" is not a valid chart repository or cannot be reached: failed to fetch ${url.replace(/\/$/, '')}/index.yaml : 404 Not Found`);
      if (list.some(r => r.name === name)) { if (list.find(r => r.name === name).url === known.url) { out(`"${name}" already exists with the same configuration, skipping`); return 0; } return fail(`Error: repository name (${name}) already exists, please specify a different name`); }
      list.push({ name, url: known.url, caFile: '', certFile: '', keyFile: '', insecure_skip_tls_verify: false, pass_credentials_all: false, username: '', password: '' });
      writeRepos(c, list);
      out(`"${name}" has been added to your repositories`);
      emit({ sub, repo: name });
      return 0;
    }
    if (sub === 'list' || sub === 'ls') { if (!list.length) return fail('Error: no repositories to show'); out(...table(['NAME', 'URL'], list.map(r => [r.name, r.url]))); return 0; }
    if (sub === 'update' || sub === 'up') { if (!list.length) return fail('Error: no repositories found. You must add one before updating'); out('Hang tight while we grab the latest from your chart repositories...', ...list.map(r => `...Successfully got an update from the "${r.name}" chart repository`), 'Update Complete. ⎈Happy Helming!⎈'); emit({ sub }); return 0; }
    if (sub === 'remove' || sub === 'rm') { if (!list.some(r => r.name === name)) return fail(`Error: no repo named "${name}" found`); writeRepos(c, list.filter(r => r.name !== name)); out(`"${name}" has been removed from your repositories`); return 0; }
    return fail(`Error: unknown command "${sub}" for "helm repo"`);
  }
  if (cmd === 'search') {
    if (pos[0] !== 'repo') return fail('Error: the simulator searches added repositories only: helm search repo KEYWORD');
    const kw = (pos[1] || '').toLowerCase();
    const rowsS = [];
    for (const r of readRepos(c)) { const repo = Object.values(REPOS).find(x => x.url === r.url); for (const [n, ch] of Object.entries(repo?.charts || {})) if (!kw || `${r.name}/${n} ${ch.meta.description}`.toLowerCase().includes(kw)) rowsS.push([`${r.name}/${n}`, ch.meta.version, ch.meta.appVersion, ch.meta.description]); }
    if (!rowsS.length) { out('No results found'); return 0; }
    out(...table(['NAME', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], rowsS));
    emit({ keyword: kw });
    return 0;
  }
  if (cmd === 'show' || cmd === 'inspect') {
    const [what, ref] = pos;
    const ch = resolveChart(c, ref || '', { version: o.get('--version') });
    if (ch.error) return fail(ch.error);
    if (what === 'values') out(...String(ch.files['values.yaml'] || '').replace(/\n$/, '').split('\n'));
    else if (what === 'chart') out(...String(ch.files['Chart.yaml']).replace(/\n$/, '').split('\n'));
    else if (what === 'readme') out(...String(ch.files['README.md'] || `# ${ch.meta.name}\n\n${ch.meta.description || ''}`).split('\n'));
    else if (what === 'all') out(...String(ch.files['Chart.yaml']).split('\n'), '---', ...String(ch.files['values.yaml'] || '').split('\n'));
    else return fail(`Error: unknown command "${what}" for "helm show"`);
    emit({ what, chart: ref });
    return 0;
  }
  if (cmd === 'pull' || cmd === 'fetch') {
    const ch = resolveChart(c, pos[0] || '', { version: o.get('--version') });
    if (ch.error) return fail(ch.error);
    const dest = c.resolve(o.get('--untardir', '-d', '--destination') || '.');
    if (o['--untar']) { for (const [p, t] of Object.entries(ch.files)) { const f = `${dest}/${ch.meta.name}/${p}`; c.host.ensureParents?.(f, c.user); c.host.writeFile(f, t, c.user); } }
    else c.host.writeFile(`${dest}/${ch.meta.name}-${ch.meta.version}.tgz`, `(gzipped tar of the ${ch.meta.name} chart; use --untar to read it)\n`, c.user);
    emit({ chart: pos[0] });
    return 0;
  }
  if (cmd === 'create') {
    const name = pos[0];
    if (!name) return fail('Error: "helm create" requires 1 argument');
    const dir = c.resolve(name);
    for (const [p, t] of Object.entries(scaffold(name.split('/').pop()))) { c.host.ensureParents?.(`${dir}/${p}`, c.user); c.host.writeFile(`${dir}/${p}`, t, c.user); }
    out(`Creating ${name}`);
    emit({ name });
    return 0;
  }
  if (cmd === 'lint') {
    const ref = pos[0] || '.';
    const ch = resolveChart(c, ref);
    out(`==> Linting ${ref}`);
    if (ch.error) { out(`[ERROR] Chart.yaml: ${ch.error.replace(/^Error: /, '')}`, '', 'Error: 1 chart(s) linted, 1 chart(s) failed'); return 1; }
    const msgs = [];
    if (!ch.meta.icon) msgs.push('[INFO] Chart.yaml: icon is recommended');
    let values;
    try { values = buildValues(c, o, ch); } catch (e) { msgs.push(`[ERROR] values.yaml: ${e.message}`); }
    if (values) {
      const r = renderChart(ch, { name: 'release-name', namespace: 'default', values });
      if (r.error) msgs.push(`[ERROR] templates/: ${r.error}`);
      else for (const x of r.rendered) for (const d of x.docs) { if (!d.apiVersion) msgs.push(`[ERROR] ${x.file.replace(ch.meta.name + '/', '')}: apiVersion not set`); if (!d.metadata?.name) msgs.push(`[ERROR] ${x.file.replace(ch.meta.name + '/', '')}: object name does not conform to Kubernetes naming requirements: ""`); }
    }
    out(...msgs, '');
    const bad = msgs.some(m => m.startsWith('[ERROR]'));
    out(bad ? 'Error: 1 chart(s) linted, 1 chart(s) failed' : '1 chart(s) linted, 0 chart(s) failed');
    emit({ ok: !bad, chart: ref });
    return bad ? 1 : 0;
  }
  if (cmd === 'template') {
    const [a1, a2] = pos;
    const name = a2 ? a1 : (o['--generate-name'] ? `chart-${uni.time}` : 'release-name');
    const ref = a2 || a1;
    const ch = resolveChart(c, ref || '');
    if (ch.error) return fail(ch.error);
    let values;
    try { values = buildValues(c, o, ch); } catch (e) { return fail(`Error: ${e.message}`); }
    const r = renderChart(ch, { name, namespace: o.get('-n', '--namespace') || 'default', values });
    if (r.error) return fail(`Error: ${r.error}`);
    const only = o.all('--show-only', '-s');
    const lines = [];
    for (const x of r.rendered) {
      if (only.length && !only.some(s => x.file === `${ch.meta.name}/${s}`)) continue;
      for (const d of x.docs) lines.push('---', `# Source: ${x.file}`, ...toYaml(d).split('\n'));
    }
    if (only.length && !lines.length) return fail(`Error: could not find template ${only[0]} in chart`);
    out(...lines);
    emit({ chart: ref, values });
    return 0;
  }

  // ---- everything else talks to the cluster
  const conn = clusterFor(c, { namespace: o.get('-n', '--namespace'), context: o.get('--kube-context'), raw: {}, all: () => [] });
  if (conn.error) return fail(`Error: Kubernetes cluster unreachable: ${conn.error.replace(/^error: /, '').split('\n').pop()}`);
  const { cl } = conn;
  const ns = conn.ns;

  if (cmd === 'list' || cmd === 'ls') {
    let rels = allReleases(cl, o['-A'] || o['--all-namespaces'] ? null : ns);
    if (!o['-a'] && !o['--all']) rels = rels.filter(r => ['deployed', 'failed'].includes(r.info.status));
    out(...table(['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'], rels.map(r => [r.name, r.namespace, r.version, updated(r.info.last_deployed), r.info.status, `${r.chart.metadata.name}-${r.chart.metadata.version}`, r.chart.metadata.appVersion || ''])));
    emit({ ns });
    return 0;
  }
  if (cmd === 'status' || cmd === 'history' || cmd === 'get') {
    const name = cmd === 'get' ? pos[1] : pos[0];
    const hist = releasesOf(cl, name, ns);
    if (!hist.length) return fail(`Error: release: not found`);
    if (cmd === 'history' || cmd === 'hist') {
      out(...table(['REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], hist.slice(-Number(o.get('--max') || 256)).map(r => [r.version, when(r.info.last_deployed), r.info.status, `${r.chart.metadata.name}-${r.chart.metadata.version}`, r.chart.metadata.appVersion || '', r.info.description])));
      emit({ name });
      return 0;
    }
    const rev = o.get('--revision') ? hist.find(r => r.version === Number(o.get('--revision'))) : [...hist].reverse().find(r => r.info.status !== 'superseded') || hist[hist.length - 1];
    if (!rev) return fail('Error: release: not found');
    if (cmd === 'status') {
      out(`NAME: ${rev.name}`, `LAST DEPLOYED: ${when(rev.info.last_deployed)}`, `NAMESPACE: ${rev.namespace}`, `STATUS: ${rev.info.status}`, `REVISION: ${rev.version}`, 'TEST SUITE: None', ...(rev.info.notes ? ['NOTES:', ...rev.info.notes.replace(/\n$/, '').split('\n')] : []));
      emit({ name });
      return 0;
    }
    const what = pos[0];
    if (what === 'values') { const v = o['--all'] || o['-a'] ? rev.config_all : rev.config; out(o['--all'] || o['-a'] ? 'COMPUTED VALUES:' : 'USER-SUPPLIED VALUES:', ...(Object.keys(v || {}).length ? toYaml(v).split('\n') : ['null'])); emit({ name, what }); return 0; }
    if (what === 'manifest') { out(...rev.manifest.split('\n')); emit({ name, what }); return 0; }
    if (what === 'notes') { out('NOTES:', ...String(rev.info.notes || '').split('\n')); return 0; }
    if (what === 'all') { out(...rev.manifest.split('\n')); return 0; }
    return fail(`Error: unknown command "${what}" for "helm get"`);
  }

  if (cmd === 'install' || cmd === 'upgrade') {
    let [name, ref] = pos;
    if (cmd === 'install' && o['--generate-name']) { ref = name; name = `${(ref || '').split('/').pop()}-${uni.time}`; }
    if (!name || !ref) return fail(`Error: "helm ${cmd}" requires 2 arguments\n\nUsage:  helm ${cmd} [${cmd === 'install' ? 'NAME' : 'RELEASE'}] [CHART] [flags]`);
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 53) return fail(`Error: ${cmd === 'install' ? 'INSTALLATION' : 'UPGRADE'} FAILED: release name "${name}": invalid release name, must match regex ^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$ and the length must not be longer than 53`);
    const label = cmd === 'install' ? 'INSTALLATION FAILED' : 'UPGRADE FAILED';
    const hist = releasesOf(cl, name, ns);
    const last = [...hist].reverse().find(r => r.info.status === 'deployed') || hist[hist.length - 1];
    let mode = cmd;
    if (cmd === 'install' && hist.length && hist.some(r => r.info.status !== 'uninstalled')) return fail(`Error: INSTALLATION FAILED: cannot re-use a name that is still in use`);
    if (cmd === 'upgrade' && !hist.length) { if (!o['--install'] && !o['-i']) return fail(`Error: UPGRADE FAILED: "${name}" has no deployed releases`); mode = 'install'; }
    if (!cl.get('Namespace', null, ns)) { if (o['--create-namespace']) cl.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } }); else return fail(`Error: ${label}: create: failed to create: namespaces "${ns}" not found`); }
    const ch = resolveChart(c, ref, { version: o.get('--version') });
    if (ch.error) return fail(ch.error.replace(/^Error: /, `Error: ${label}: `));
    let userVals;
    try { userVals = userValues(c, o); } catch (e) { return fail(`Error: ${label}: ${e.message}`); }
    if (mode === 'upgrade' && (o['--reuse-values'])) userVals = deepMerge(last?.config || {}, userVals);
    let defaults; try { defaults = parseYaml(ch.files['values.yaml'] || '') || {}; } catch (e) { return fail(`Error: ${label}: cannot load values.yaml: ${e.message}`); }
    const values = deepMerge(defaults, userVals);
    const revision = (hist.length ? Math.max(...hist.map(r => r.version)) : 0) + 1;
    const r = renderChart(ch, { name, namespace: ns, values, revision, isUpgrade: mode === 'upgrade' });
    if (r.error) return fail(`Error: ${label}: ${r.error}`);
    const docs = r.rendered.flatMap(x => x.docs);
    const manifest = manifestOf(r.rendered);
    const rel = { name, namespace: ns, version: revision, chart: { metadata: ch.meta, ref, hook: ch.hookKey || null }, config: userVals, config_all: values, manifest, info: { first_deployed: hist[0]?.info.first_deployed ?? uni.time, last_deployed: uni.time, status: 'pending-' + mode, description: mode === 'install' ? 'Install complete' : 'Upgrade complete', notes: r.notes } };
    if (o['--dry-run']) {
      out(`NAME: ${name}`, `LAST DEPLOYED: ${when(uni.time)}`, `NAMESPACE: ${ns}`, 'STATUS: pending-' + mode, `REVISION: ${revision}`, 'TEST SUITE: None', 'HOOKS:', 'MANIFEST:', ...manifest.split('\n'));
      emit({ name, dry: true });
      return 0;
    }
    if (ch.hook?.before) { const hr = ch.hook.before(cl, rel); if (hr?.error) return fail(`Error: ${label}: ${hr.error}`); }
    const ap = applyDocs(c, conn, cl, docs.map(clone), rel, { adopt: mode === 'upgrade' });
    const finish = (status, desc) => { rel.info.status = status; rel.info.description = desc; saveRelease(cl, rel); };
    const rollbackOrDelete = reason => {
      if (mode === 'install') { removeDocs(cl, docs, ns); for (const s of cl.list('Secret', ns).filter(s => s.metadata.labels?.name === name && s.type === 'helm.sh/release.v1')) cl.remove(s); return fail(`Error: ${label}: release ${name} failed, and has been uninstalled due to atomic being set: ${reason}`); }
      finish('failed', `Upgrade "${name}" failed: ${reason}`);
      const rb = doRollback(c, conn, cl, name, ns, last.version, { description: `Rollback to ${last.version}`, wait: true, timeout: o.get('--timeout') }); if (rb.error) return fail(`Error: ${label}: release ${name} failed, and rolling back also failed: ${rb.error}`);
      return fail(`Error: ${label}: release ${name} failed, and has been rolled back due to atomic being set: ${reason}`);
    };
    if (ap.error) { if (o['--atomic']) return rollbackOrDelete(ap.error); finish('failed', `${mode === 'install' ? 'Release' : 'Upgrade'} "${name}" failed: ${ap.error}`); emit({ name, ok: false }); return fail(`Error: ${label}: ${ap.error}`); }
    // upgrades delete what the new manifest no longer has
    if (mode === 'upgrade' && last) { const keep = new Set(docs.map(d => objKey(d, ns))); removeDocs(cl, docsOf(last.manifest).filter(d => !keep.has(objKey(d, ns))), ns); }
    uni.advance(1);
    if (o['--wait'] || o['--atomic']) {
      const limit = parseDuration(o.get('--timeout'));
      let waited = 0;
      while (!workloadsReady(cl, docs, ns) && waited < limit) { uni.advance(5); waited += 5; }
      if (!workloadsReady(cl, docs, ns)) { if (o['--atomic']) return rollbackOrDelete('context deadline exceeded'); finish('failed', `${mode === 'install' ? 'Release' : 'Upgrade'} "${name}" failed: context deadline exceeded`); emit({ name, ok: false }); return fail(`Error: ${label}: context deadline exceeded`); }
    }
    if (ch.hook?.after) ch.hook.after(cl, rel);
    for (const prev of hist) if (prev.info.status === 'deployed') { prev.info.status = 'superseded'; saveRelease(cl, prev); }
    finish('deployed', mode === 'install' ? 'Install complete' : 'Upgrade complete');
    if (mode === 'upgrade') out(`Release "${name}" has been upgraded. Happy Helming!`);
    out(`NAME: ${name}`, `LAST DEPLOYED: ${when(uni.time)}`, `NAMESPACE: ${ns}`, 'STATUS: deployed', `REVISION: ${revision}`, 'TEST SUITE: None', ...(r.notes.trim() ? ['NOTES:', ...r.notes.replace(/\n+$/, '').split('\n')] : []));
    emit({ name, ok: true, revision, chart: ch.meta.name, values, mode });
    return 0;
  }
  if (cmd === 'rollback') {
    const [name, revArg] = pos;
    const hist = releasesOf(cl, name, ns);
    if (!hist.length) return fail(`Error: release: not found`);
    const cur = [...hist].reverse().find(r => r.info.status === 'deployed') || hist[hist.length - 1];
    const target = revArg && revArg !== '0' ? Number(revArg) : (hist.filter(r => r.version < cur.version).pop()?.version);
    if (!target || !hist.some(r => r.version === target)) return fail(`Error: release has no ${target || ''} version`);
    const res = doRollback(c, conn, cl, name, ns, target, { wait: o['--wait'], timeout: o.get('--timeout') });
    if (res.error) return fail(`Error: ${res.error}`);
    out('Rollback was a success! Happy Helming!');
    emit({ name, to: target, ok: true });
    return 0;
  }
  if (cmd === 'uninstall' || cmd === 'delete' || cmd === 'del' || cmd === 'un') {
    const name = pos[0];
    const hist = releasesOf(cl, name, ns);
    const cur = [...hist].reverse().find(r => r.info.status !== 'uninstalled');
    if (!cur) return fail(`Error: uninstall: Release not loaded: ${name}: release: not found`);
    removeDocs(cl, docsOf(cur.manifest), ns);
    if (CHART_HOOKS[cur.chart.hook]?.uninstall) CHART_HOOKS[cur.chart.hook].uninstall(cl, cur);
    if (o['--keep-history']) { cur.info.status = 'uninstalled'; cur.info.description = 'Uninstallation complete'; saveRelease(cl, cur); }
    else for (const r of hist) cl.remove(cl.get('Secret', ns, relKey(name, r.version)));
    uni.advance(2);
    out(`release "${name}" uninstalled`);
    emit({ name });
    return 0;
  }
  return fail(`Error: unknown command "${cmd}" for "helm"\nRun 'helm --help' for usage.`);
}, { pkg: 'helm' });

function removeDocs(cl, docs, ns) {
  for (const d of docs) { const o = cl.get(d.kind, CLUSTER_SCOPED.has(d.kind) ? null : d.metadata?.namespace || ns, d.metadata?.name); if (o) cl.delete(o, { now: true }); }
}

function doRollback(c, conn, cl, name, ns, target, { description, wait, timeout } = {}) {
  const hist = releasesOf(cl, name, ns);
  const from = hist.find(r => r.version === target);
  const cur = [...hist].reverse().find(r => r.info.status === 'deployed');
  const revision = Math.max(...hist.map(r => r.version)) + 1;
  const docs = docsOf(from.manifest);
  const rel = { ...clone(from), version: revision, info: { ...from.info, last_deployed: c.uni.time, status: 'pending-rollback', description: description || `Rollback to ${target}` } };
  const ap = applyDocs(c, conn, cl, docs.map(clone), rel, { adopt: true });
  if (ap.error) return { error: ap.error };
  if (cur) { const keep = new Set(docs.map(d => objKey(d, ns))); removeDocs(cl, docsOf(cur.manifest).filter(d => !keep.has(objKey(d, ns))), ns); }
  c.uni.advance(1);
  if (wait) { const limit = parseDuration(timeout); let w = 0; while (!workloadsReady(cl, docs, ns) && w < limit) { c.uni.advance(5); w += 5; } }
  for (const r of hist) if (r.info.status === 'deployed') { r.info.status = 'superseded'; saveRelease(cl, r); }
  rel.info.status = 'deployed';
  saveRelease(cl, rel);
  return { ok: true };
}

function userValues(c, o) {
  let v = {};
  for (const f of o.all('-f', '--values')) {
    const t = c.host.files.get(c.resolve(f));
    if (t === undefined) throw new Error(`open ${f}: no such file or directory`);
    let parsed; try { parsed = parseYaml(t) || {}; } catch (e) { throw new Error(`failed to parse ${f}: error converting YAML to JSON: yaml: ${e.message}`); }
    v = deepMerge(v, parsed);
  }
  for (const s of o.all('--set')) v = deepMerge(v, parseSet(s));
  for (const s of o.all('--set-string')) v = deepMerge(v, parseSet(s, { asString: true }));
  return v;
}
function buildValues(c, o, ch) { return deepMerge(parseYaml(ch.files['values.yaml'] || '') || {}, userValues(c, o)); }

// what `helm create` scaffolds (trimmed to the parts that matter)
export function scaffold(name) {
  return {
    'Chart.yaml': `apiVersion: v2\nname: ${name}\ndescription: A Helm chart for Kubernetes\ntype: application\nversion: 0.1.0\nappVersion: "1.16.0"\n`,
    'values.yaml': `replicaCount: 1\n\nimage:\n  repository: nginx\n  pullPolicy: IfNotPresent\n  # Overrides the image tag whose default is the chart appVersion.\n  tag: "1.27"\n\nservice:\n  type: ClusterIP\n  port: 80\n\ningress:\n  enabled: false\n  className: nginx\n  host: chart-example.local\n\nresources: {}\n  # limits:\n  #   cpu: 100m\n  #   memory: 128Mi\n`,
    '.helmignore': '.DS_Store\n.git/\n*.swp\n',
    'templates/_helpers.tpl': `{{/*\nExpand the name of the chart.\n*/}}\n{{- define "${name}.name" -}}\n{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}\n{{- end }}\n\n{{/*\nCreate a default fully qualified app name.\n*/}}\n{{- define "${name}.fullname" -}}\n{{- if contains .Chart.Name .Release.Name }}\n{{- .Release.Name | trunc 63 | trimSuffix "-" }}\n{{- else }}\n{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}\n{{- end }}\n{{- end }}\n\n{{- define "${name}.selectorLabels" -}}\napp.kubernetes.io/name: {{ include "${name}.name" . }}\napp.kubernetes.io/instance: {{ .Release.Name }}\n{{- end }}\n\n{{- define "${name}.labels" -}}\nhelm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}\n{{ include "${name}.selectorLabels" . }}\napp.kubernetes.io/version: {{ .Chart.AppVersion | quote }}\napp.kubernetes.io/managed-by: {{ .Release.Service }}\n{{- end }}\n`,
    'templates/deployment.yaml': `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include "${name}.fullname" . }}\n  labels:\n    {{- include "${name}.labels" . | nindent 4 }}\nspec:\n  replicas: {{ .Values.replicaCount }}\n  selector:\n    matchLabels:\n      {{- include "${name}.selectorLabels" . | nindent 6 }}\n  template:\n    metadata:\n      labels:\n        {{- include "${name}.selectorLabels" . | nindent 8 }}\n    spec:\n      containers:\n        - name: {{ .Chart.Name }}\n          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"\n          ports:\n            - name: http\n              containerPort: 80\n          {{- with .Values.resources }}\n          resources:\n            {{- toYaml . | nindent 12 }}\n          {{- end }}\n`,
    'templates/service.yaml': `apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ include "${name}.fullname" . }}\n  labels:\n    {{- include "${name}.labels" . | nindent 4 }}\nspec:\n  type: {{ .Values.service.type }}\n  ports:\n    - port: {{ .Values.service.port }}\n      targetPort: http\n      name: http\n  selector:\n    {{- include "${name}.selectorLabels" . | nindent 4 }}\n`,
    'templates/ingress.yaml': `{{- if .Values.ingress.enabled -}}\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: {{ include "${name}.fullname" . }}\nspec:\n  ingressClassName: {{ .Values.ingress.className }}\n  rules:\n    - host: {{ .Values.ingress.host | quote }}\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: {{ include "${name}.fullname" . }}\n                port:\n                  number: {{ .Values.service.port }}\n{{- end }}\n`,
    'templates/NOTES.txt': `1. Get the application URL by running these commands:\n  export POD_NAME=$(kubectl get pods --namespace {{ .Release.Namespace }} -l "app.kubernetes.io/name={{ include "${name}.name" . }},app.kubernetes.io/instance={{ .Release.Name }}" -o jsonpath="{.items[0].metadata.name}")\n  kubectl --namespace {{ .Release.Namespace }} port-forward $POD_NAME 8080:80\n`,
  };
}

export { pluralOf, singularOf, dirname };
