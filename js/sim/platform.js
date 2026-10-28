// Lumen's internal developer platform: the `lumen` CLI does what a developer portal
// (Backstage and friends) does. `lumen create` follows a golden path: a new repository
// from a template (CI, Dockerfile, catalog entry), a first image in the registry, and a
// pull request to the GitOps repo that an ApplicationSet turns into a running service.
// `lumen scorecard` grades a service against the platform's standards by reading its
// repositories, and `lumen dora` measures delivery from deploy and incident history.

import { def } from './registry.js';
import { parseYaml } from '../git/yaml.js';
import { C } from '../git/world.js';
import { table } from './kubectl.js';
import { teammateCommit, createPR } from '../git/github.js';
import { engineOf } from './docker.js';
import { parseRef, dockerBuild, shortId } from './docker-images.js';

const BOT = { name: 'lumen-platform-bot', email: 'platform-bot@lumen.dev' };

// ---------------------------------------------------------------- golden paths
const nodeApiFiles = (name, owner, desc) => ({
  'catalog-info.yaml': `apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: ${name}\n  description: ${desc}\n  annotations:\n    lumen.dev/runbook: https://runbooks.lumen.dev/${name}\n    github.com/project-slug: lumen/${name}\nspec:\n  type: service\n  lifecycle: production\n  owner: ${owner}\n`,
  'src/server.js': `const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || 3000;\napp.get('/health', (req, res) => res.json({ status: 'ok' }));\napp.get('/ready', (req, res) => res.json({ ready: true }));\napp.get('/', (req, res) => res.json({ service: '${name}', version: process.env.VERSION || '0.1.0' }));\napp.listen(PORT, () => console.log('${name} listening on ' + PORT));\n`,
  'package.json': JSON.stringify({ name, version: '0.1.0', main: 'src/server.js', scripts: { start: 'node src/server.js', test: 'node --test' }, dependencies: { express: '^4.21.1' } }, null, 2) + '\n',
  'package-lock.json': JSON.stringify({ name, lockfileVersion: 3, packages: { 'node_modules/express': { version: '4.21.1' } } }, null, 2) + '\n',
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY src ./src\nUSER node\nCMD ["node", "src/server.js"]\n',
  '.github/workflows/ci.yml': `name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test --if-present\n`,
  'README.md': `# ${name}\n\n${desc}\n\nCreated from the Lumen **node-api** golden path. It ships with CI, a container image,\nhealth endpoints, a catalog entry and deployment manifests in lumen/gitops.\n`,
});
const gitopsFiles = (name, image, team) => ({
  [`apps/${name}/kustomization.yaml`]: `resources:\n  - deployment.yaml\n  - service.yaml\n  - networkpolicy.yaml\nlabels:\n  - pairs:\n      app.kubernetes.io/part-of: ${name}\n      lumen.dev/team: ${team}\n`,
  [`apps/${name}/deployment.yaml`]: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: ${name}\n  template:\n    metadata:\n      labels:\n        app: ${name}\n    spec:\n      containers:\n        - name: ${name}\n          image: ${image}\n          ports:\n            - name: http\n              containerPort: 3000\n          readinessProbe:\n            httpGet:\n              path: /ready\n              port: http\n          livenessProbe:\n            httpGet:\n              path: /health\n              port: http\n          resources:\n            requests:\n              cpu: 50m\n              memory: 64Mi\n            limits:\n              cpu: 250m\n              memory: 128Mi\n`,
  [`apps/${name}/service.yaml`]: `apiVersion: v1\nkind: Service\nmetadata:\n  name: ${name}\nspec:\n  selector:\n    app: ${name}\n  ports:\n    - port: 80\n      targetPort: http\n`,
  [`apps/${name}/networkpolicy.yaml`]: `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: ${name}\nspec:\n  podSelector:\n    matchLabels:\n      app: ${name}\n  ingress:\n    - from:\n        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: ingress-nginx\n        - podSelector: {}\n      ports:\n        - port: http\n`,
});
export const TEMPLATES = {
  'node-api': { description: 'Node.js HTTP API: CI, container image, health checks, Kubernetes manifests, catalog entry', files: nodeApiFiles },
  'static-site': { description: 'Static website served by nginx, with CI and a CDN-friendly cache policy', files: null },
  worker: { description: 'Background worker consuming a queue, with retries and metrics', files: null },
};

export function platformOf(uni) {
  if (!uni.platform) uni.platform = { gitops: 'https://github.com/lumen/gitops.git', registry: 'ghcr.io/lumen', services: new Map(), deploys: [], incidents: [] };
  return uni.platform;
}

function publish(uni, ref, files) {
  let b = uni.host('image-builder');
  if (!b) { b = uni.addHost('image-builder', { kind: 'vm' }); b.hidden = true; }
  const eng = engineOf(b, uni);
  const dir = '/build/' + parseRef(ref).repo.replace(/\W/g, '_') + '_' + parseRef(ref).tag.replace(/\W/g, '_');
  for (const [p, t] of Object.entries(files)) { b.mkdirMeta(dir + '/' + p.split('/').slice(0, -1).join('/'), 'root'); b.writeFile(dir + '/' + p, t, 'root'); }
  const r = dockerBuild(eng, { contextDir: dir, tags: [ref] });
  if (!r.ok) return false;
  uni.registry.set(parseRef(ref).short, { image: { ...r.image, tags: undefined }, digest: 'sha256:' + shortId(), private: false, pushed: uni.time });
  return true;
}

// ---------------------------------------------------------------- scorecards
const fileAt = (uni, slug, path, branch = 'main') => {
  const bare = uni.remotes.get(`https://github.com/${slug}.git`);
  const h = bare?.refs[`refs/heads/${branch}`];
  if (!h) return undefined;
  const flat = uni.readTreeFlat(uni.commit(h).tree);
  const hash = flat.get(path);
  return hash ? uni.objects.get(hash).content : undefined;
};
const filesUnder = (uni, slug, prefix) => {
  const bare = uni.remotes.get(`https://github.com/${slug}.git`);
  const h = bare?.refs['refs/heads/main'];
  if (!h) return {};
  const out = {};
  for (const [p, hash] of uni.readTreeFlat(uni.commit(h).tree)) if (p.startsWith(prefix)) out[p] = uni.objects.get(hash).content;
  return out;
};
const docsOf = files => Object.values(files).flatMap(t => String(t).split(/^---\s*$/m).filter(x => x.trim()).map(x => { try { return parseYaml(x); } catch { return null; } }).filter(Boolean));

export function scorecard(uni, name) {
  const P = platformOf(uni);
  let cat = null;
  try { cat = parseYaml(fileAt(uni, `lumen/${name}`, 'catalog-info.yaml') || '') || null; } catch { cat = null; }
  const wfs = Object.values(filesUnder(uni, `lumen/${name}`, '.github/workflows/'));
  const docs = docsOf(filesUnder(uni, P.gitops.replace('https://github.com/', '').replace(/\.git$/, ''), `apps/${name}/`));
  const dep = docs.find(d => d.kind === 'Deployment');
  const cs = dep?.spec?.template?.spec?.containers || [];
  return [
    { id: 'owner', title: 'Has an owning team in catalog-info.yaml', ok: !!cat?.spec?.owner, fix: 'set spec.owner in catalog-info.yaml' },
    { id: 'runbook', title: 'Links a runbook', ok: !!cat?.metadata?.annotations?.['lumen.dev/runbook'], fix: 'add the lumen.dev/runbook annotation to catalog-info.yaml' },
    { id: 'ci', title: 'Runs CI on pull requests', ok: wfs.some(t => /pull_request/.test(t)), fix: 'add a workflow triggered on pull_request' },
    { id: 'probes', title: 'Has readiness and liveness probes', ok: cs.length > 0 && cs.every(c => c.readinessProbe && c.livenessProbe), fix: `add readinessProbe and livenessProbe in apps/${name}/deployment.yaml` },
    { id: 'limits', title: 'Sets resource requests and limits', ok: cs.length > 0 && cs.every(c => c.resources?.requests && c.resources?.limits?.memory), fix: `add resources.requests and resources.limits in apps/${name}/deployment.yaml` },
    { id: 'netpol', title: 'Restricts traffic with a NetworkPolicy', ok: docs.some(d => d.kind === 'NetworkPolicy'), fix: `add a NetworkPolicy to apps/${name}/` },
  ];
}

// ---------------------------------------------------------------- DORA
const BANDS = {
  freq: [[7, 'Elite'], [1, 'High'], [0.25, 'Medium'], [0, 'Low']],          // deploys per week
  lead: [[1, 'Elite'], [7, 'High'], [30, 'Medium'], [Infinity, 'Low']],      // days
  cfr: [[5, 'Elite'], [10, 'High'], [15, 'Medium'], [Infinity, 'Low']],      // percent
  mttr: [[1, 'Elite'], [24, 'High'], [168, 'Medium'], [Infinity, 'Low']],    // hours
};
const band = (kind, v) => kind === 'freq' ? BANDS.freq.find(([t]) => v >= t)[1] : BANDS[kind].find(([t]) => v <= t)[1];
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const human = h => h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m` : `${(h / 24).toFixed(1)} days`;

export function dora(uni, name, days = 30) {
  const P = platformOf(uni);
  const since = uni.time - days * 86400;
  const deploys = P.deploys.filter(d => d.service === name && d.at >= since);
  // live deploys from Argo CD history count too
  for (const cl of uni.clusters?.values() || []) for (const app of cl.list('Application', null)) if (app.metadata.name === name) for (const h of app.status?.history || []) if (h.at >= since && h.at >= (P.created || 0) && !deploys.some(d => d.rev === h.revision)) { const commit = uni.objects.get(h.revision); deploys.push({ service: name, at: h.at, commitAt: commit?.author?.time ?? h.at, ok: true, rev: h.revision }); }
  const incidents = P.incidents.filter(i => i.service === name && i.start >= since);
  const failed = deploys.filter(d => !d.ok);
  const perWeek = deploys.length / (days / 7);
  const leadDays = median(deploys.map(d => (d.at - d.commitAt) / 86400));
  const cfr = deploys.length ? Math.round(failed.length / deploys.length * 100) : 0;
  const mttrH = median(incidents.filter(i => i.end).map(i => (i.end - i.start) / 3600));
  return { deploys, failed, incidents, perWeek, leadDays, cfr, mttrH, bands: { freq: band('freq', perWeek), lead: band('lead', leadDays), cfr: band('cfr', cfr), mttr: incidents.length ? band('mttr', mttrH) : 'Elite' } };
}

// ---------------------------------------------------------------- the CLI
def('lumen', c => {
  const args = c.args;
  const out = (...l) => c.print(...l);
  const fail = (m, code = 1) => c.fail(m, code);
  const uni = c.uni;
  const P = platformOf(uni);
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) flags[k] = v; else if (args[i + 1] && !args[i + 1].startsWith('--') && ['template', 'owner', 'description', 'days', 'team'].includes(k)) flags[k] = args[++i]; else flags[k] = true; continue; } pos.push(a); }
  const [cmd, ...rest] = pos;
  const emit = extra => uni.emit({ type: 'lumen', host: c.host.name, cmd, args: args.join(' '), ...extra });
  if (!cmd || cmd === 'help' || flags.help) { out('lumen: the Lumen developer platform', '', 'Usage: lumen <command>', '', 'Commands:', '  templates                       list the golden paths', '  create <name> --template <t> --owner <team> [--description "…"]', '                                  new service: repo, first image, GitOps pull request', '  catalog                         every service, its owner and its scorecard', '  scorecard <name>                how a service meets the platform standards', '  dora <name> [--days 30]         delivery metrics for a service'); return 0; }
  if (cmd === 'templates') { out(...table(['TEMPLATE', 'DESCRIPTION'], Object.entries(TEMPLATES).map(([k, t]) => [k, t.description]))); emit({}); return 0; }
  if (cmd === 'create') {
    const name = rest[0];
    const tpl = flags.template;
    if (!name || !/^[a-z][a-z0-9-]{1,30}$/.test(name)) return fail('error: give the service a lowercase name, e.g. lumen create receipts --template node-api --owner team-payments');
    if (!tpl) return fail(`error: --template is required (one of: ${Object.keys(TEMPLATES).join(', ')})`);
    if (!TEMPLATES[tpl]) return fail(`error: unknown template "${tpl}" (run: lumen templates)`);
    if (!TEMPLATES[tpl].files) return fail(`error: the ${tpl} template is not available in this lab; use node-api`);
    if (!flags.owner) return fail('error: --owner is required: every service needs an owning team (who gets paged?)');
    if (uni.remotes.get(`https://github.com/lumen/${name}.git`)) return fail(`error: lumen/${name} already exists`);
    const gitops = uni.remotes.get(P.gitops);
    if (!gitops) return fail('error: the GitOps repository lumen/gitops is not reachable');
    const desc = flags.description || `The ${name} service`;
    const files = TEMPLATES[tpl].files(name, flags.owner, desc);
    const bare = uni.createRemoteRepo('lumen', name, { description: desc, collaborators: [uni.github.user] });
    teammateCommit(uni, bare.meta.url, { branch: 'main', files, message: `Create ${name} from the ${tpl} golden path`, author: BOT });
    out(`${C.green('✓')} Created repository lumen/${name} from template ${tpl}`);
    const image = `${P.registry}/${name}:0.1.0`;
    if (!publish(uni, image, { 'package.json': files['package.json'], 'package-lock.json': files['package-lock.json'], 'src/server.js': files['src/server.js'], Dockerfile: files.Dockerfile })) return fail(`error: the first build of ${image} failed`);
    out(`${C.green('✓')} First CI build pushed ${image}`);
    const branch = `add-${name}`;
    gitops.refs[`refs/heads/${branch}`] = gitops.refs['refs/heads/main'];
    teammateCommit(uni, P.gitops, { branch, files: gitopsFiles(name, image, flags.owner), message: `Add ${name} (${tpl} golden path)`, author: BOT });
    const pr = createPR(uni, gitops, { title: `Add ${name}`, body: `New service **${name}** owned by ${flags.owner}, created from the ${tpl} golden path.\n\nMerging this deploys it: the \`apps\` ApplicationSet creates an Argo CD application for every folder in \`apps/\`.`, head: branch, headRepo: P.gitops, base: 'main', author: BOT.name });
    P.services.set(name, { owner: flags.owner, template: tpl, created: uni.time, tier: 'standard' });
    out(`${C.green('✓')} Registered ${name} in the service catalog (owner: ${flags.owner})`, `${C.green('✓')} Opened lumen/gitops#${pr.number}: "Add ${name}". Review and merge it to deploy.`, '', `  Next: clone lumen/gitops, review the pull request (gh pr diff ${pr.number}) and merge it.`);
    emit({ name, template: tpl, owner: flags.owner, pr: pr.number });
    return 0;
  }
  if (cmd === 'catalog') {
    out(...table(['SERVICE', 'OWNER', 'TEMPLATE', 'SCORE'], [...P.services].map(([n, s]) => { const sc = scorecard(uni, n); return [n, s.owner || '<none>', s.template || '(legacy)', `${sc.filter(x => x.ok).length}/${sc.length}`]; })));
    emit({});
    return 0;
  }
  if (cmd === 'scorecard') {
    const name = rest[0];
    if (!P.services.has(name)) return fail(`error: no service "${name}" in the catalog (run: lumen catalog)`);
    const sc = scorecard(uni, name);
    out(`Scorecard for ${name}: ${sc.filter(x => x.ok).length}/${sc.length}`, '', ...sc.map(x => `  ${x.ok ? C.green('✓') : C.red('✗')} ${x.title}${x.ok ? '' : C.dim(`   (${x.fix})`)}`));
    emit({ name, score: sc.filter(x => x.ok).length, total: sc.length, failing: sc.filter(x => !x.ok).map(x => x.id) });
    return 0;
  }
  if (cmd === 'dora') {
    const name = rest[0];
    if (!P.services.has(name)) return fail(`error: no service "${name}" in the catalog (run: lumen catalog)`);
    const days = Number(flags.days || 30);
    const d = dora(uni, name, days);
    const row = (label, value, b) => `  ${label.padEnd(24)}${value.padEnd(34)}${b === 'Elite' ? C.green(b) : b === 'High' ? C.green(b) : b === 'Medium' ? C.yellow(b) : C.red(b)}`;
    out(`DORA metrics for ${name} (last ${days} days)`, '', row('Deployment frequency', `${d.perWeek.toFixed(1)} per week (${d.deploys.length} deploys)`, d.bands.freq), row('Lead time for changes', `${human(d.leadDays * 24)} (median)`, d.bands.lead), row('Change failure rate', `${d.cfr}% (${d.failed.length} of ${d.deploys.length})`, d.bands.cfr), row('Time to restore', d.incidents.length ? `${human(d.mttrH)} (median of ${d.incidents.length})` : 'no incidents', d.bands.mttr));
    if (flags.details) { out('', 'Deploys:', ...d.deploys.sort((a, b) => a.at - b.at).map(x => `  ${new Date(x.at * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${x.ok ? 'ok      ' : C.red('FAILED  ')}  waited ${human((x.at - x.commitAt) / 3600)} after the commit${x.note ? `  · ${x.note}` : ''}`)); if (d.incidents.length) out('', 'Incidents:', ...d.incidents.map(i => `  ${new Date(i.start * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${human((i.end - i.start) / 3600)} to restore  · ${i.title}`)); }
    emit({ name, days, details: !!flags.details, ...d.bands });
    return 0;
  }
  return fail(`error: unknown command "${cmd}" (run: lumen help)`);
}, { pkg: 'lumen-cli' });
