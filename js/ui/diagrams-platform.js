// Diagrams for the Platform & GitOps realm (Helm, Kustomize, Argo CD, RBAC, network
// policies, admission policies, secrets managers, golden paths).

import { D, mk, figure } from './diagrams.js';

D['helm-release'] = () => {
  const d = mk(720, 250, 'Helm renders a chart\'s templates with values into manifests, applies them, and records each install or upgrade as a numbered release revision in the cluster');
  d.box(14, 20, 170, 110, '', { color: 'feat' });
  d.text(30, 42, 'chart', { anchor: 'start', weight: 700, color: 'feat' });
  d.text(30, 64, 'Chart.yaml', { anchor: 'start', size: 12, font: 'mono' });
  d.text(30, 84, 'templates/*.yaml', { anchor: 'start', size: 12, font: 'mono' });
  d.text(30, 104, 'values.yaml', { anchor: 'start', size: 12, font: 'mono' });
  d.box(14, 150, 170, 80, '', { color: 'accent' });
  d.text(30, 172, 'your values', { anchor: 'start', weight: 700, color: 'accent' });
  d.text(30, 194, '-f values-prod.yaml', { anchor: 'start', size: 12, font: 'mono' });
  d.text(30, 214, '--set replicaCount=3', { anchor: 'start', size: 12, font: 'mono' });
  d.box(240, 90, 130, 70, 'render', { sub: 'Go templates', color: 'text' });
  d.arrow(186, 76, 238, 112, { color: 'feat' });
  d.arrow(186, 190, 238, 140, { color: 'accent' });
  d.box(420, 90, 120, 70, 'apply', { sub: 'manifests', color: 'info' });
  d.arrow(372, 125, 418, 125, { color: 'text' });
  d.box(590, 20, 116, 210, '', { color: 'main' });
  d.text(648, 42, 'release "shop"', { weight: 700, color: 'main', size: 12.5 });
  [['rev 1', 'superseded'], ['rev 2', 'failed'], ['rev 3', 'deployed']].forEach(([r, s], i) => { d.box(602, 56 + i * 56, 92, 44, r, { sub: s, color: s === 'deployed' ? 'ok' : s === 'failed' ? 'bad' : 'muted', titleSize: 12.5, subSize: 11 }); });
  d.arrow(542, 125, 588, 125, { color: 'info', label: 'records', size: 11 });
  return figure(d, 'Every install, upgrade and rollback becomes a new revision stored in the cluster, so `helm history` and `helm rollback` always know what was deployed with which values.');
};

D['kustomize-overlays'] = () => {
  const d = mk(720, 240, 'Kustomize: one base of plain manifests, and an overlay per environment that patches it: namespace, replicas, image tag and config');
  d.box(270, 16, 180, 76, 'base/', { sub: 'deployment · service\nconfigMapGenerator', color: 'main' });
  const envs = [['overlays/dev', 'replicas 1 · debug logs', 'feat'], ['overlays/staging', 'image :2.1 (testing)', 'info'], ['overlays/prod', 'replicas 3 · limits\nimage :2.0 · warn logs', 'accent']];
  envs.forEach(([n, s, c], i) => { const x = 20 + i * 240; d.box(x, 146, 200, 76, n, { sub: s, color: c, titleSize: 13.5 }); d.arrow(360, 94, x + 100, 142, { color: c }); });
  d.text(360, 122, 'each overlay = resources: [../../base] + small patches', { size: 12, color: 'muted' });
  return figure(d, 'Plain YAML stays plain: no templating language. `kubectl kustomize overlays/prod` shows exactly what will be applied; `kubectl apply -k` applies it.');
};

D['gitops-loop'] = () => {
  const d = mk(720, 260, 'GitOps: changes go into git through pull requests; Argo CD pulls the desired state from git, compares it with the cluster, and syncs or reverts drift');
  d.box(14, 90, 120, 70, 'you', { sub: 'commit + PR', color: 'accent' });
  d.box(190, 90, 150, 70, 'git repo', { sub: 'desired state\n(reviewed, audited)', color: 'main' });
  d.box(400, 90, 140, 70, 'Argo CD', { sub: 'compare + sync', color: 'feat' });
  d.box(596, 90, 110, 70, 'cluster', { sub: 'live state', color: 'info' });
  d.arrow(136, 125, 186, 125, { color: 'accent', label: 'push', size: 11 });
  d.arrow(398, 115, 342, 115, { color: 'feat', label: 'pull (poll / webhook)', size: 11, dy: -10 });
  d.arrow(542, 115, 592, 115, { color: 'feat', label: 'apply', size: 11 });
  d.arrow(594, 142, 544, 142, { color: 'info', label: 'watch', size: 11, dy: 16 });
  d.path('M651 162 Q651 230 470 230 Q330 230 330 196', { color: 'bad', dash: '6 5' });
  d.text(560, 222, 'kubectl edit in prod = drift → self-heal reverts it', { size: 12, color: 'bad' });
  d.text(265, 40, 'rollback = git revert', { size: 12.5, color: 'main', weight: 700 });
  d.text(470, 40, 'nobody needs cluster-admin to deploy', { size: 12.5, color: 'feat', weight: 700 });
  return figure(d, 'Git is the single source of truth. Argo CD pulls from it (nothing outside the cluster holds deploy credentials), and anything changed by hand shows up as OutOfSync.');
};

D['rbac-model'] = () => {
  const d = mk(720, 230, 'RBAC: a Role lists allowed verbs on resources in a namespace; a RoleBinding grants that Role to subjects: users, groups or service accounts');
  d.box(14, 30, 190, 170, '', { color: 'accent' });
  d.text(30, 54, 'subjects (who)', { anchor: 'start', weight: 700, color: 'accent' });
  ['User samir', 'Group team-shop', 'ServiceAccount', '  shop/shop-deployer'].forEach((s, i) => d.text(30, 82 + i * 24, s, { anchor: 'start', size: 12.5, font: 'mono' }));
  d.box(264, 70, 180, 90, 'RoleBinding', { sub: 'in namespace shop', color: 'text' });
  d.box(504, 30, 202, 170, '', { color: 'main' });
  d.text(520, 54, 'Role (what)', { anchor: 'start', weight: 700, color: 'main' });
  ['deployments: get list', '  update patch', 'services: get list', 'pods: get list', 'secrets: —'].forEach((s, i) => d.text(520, 82 + i * 22, s, { anchor: 'start', size: 12.5, font: 'mono', color: s.includes('—') ? 'bad' : 'text' }));
  d.arrow(206, 115, 260, 115, { color: 'accent' });
  d.arrow(446, 115, 500, 115, { color: 'main' });
  d.text(354, 196, 'ClusterRole + ClusterRoleBinding = the same, cluster-wide', { size: 12, color: 'muted' });
  return figure(d, 'Everything is denied unless a binding allows it. Check with `kubectl auth can-i VERB RESOURCE --as SUBJECT`.');
};

D['netpol-model'] = () => {
  const d = mk(720, 250, 'Network policies in namespace shop: a default deny blocks all ingress; allow rules let the ingress controller reach web, and web reach api on its http port; a debug pod in another namespace is blocked');
  d.box(150, 14, 556, 222, '', { color: 'info', dash: '6 4' });
  d.text(166, 36, 'namespace shop · default-deny ingress', { anchor: 'start', size: 12.5, weight: 700, color: 'info' });
  d.box(14, 60, 110, 56, 'ingress-nginx', { color: 'muted', titleSize: 12 });
  d.box(14, 160, 110, 56, 'tools/debug', { color: 'muted', titleSize: 12 });
  d.box(200, 60, 130, 56, 'web', { sub: 'app=web', color: 'ok' });
  d.box(410, 60, 130, 56, 'api', { sub: 'app=api :http', color: 'ok' });
  d.box(410, 160, 130, 56, 'reports', { sub: 'app=reports', color: 'muted' });
  d.arrow(126, 88, 196, 88, { color: 'ok', label: '80 ✓', size: 11 });
  d.arrow(332, 88, 406, 88, { color: 'ok', label: 'http ✓', size: 11 });
  d.arrow(126, 188, 404, 104, { color: 'bad', dash: '5 4' });
  d.text(250, 168, '✗ dropped (times out)', { size: 12, color: 'bad' });
  d.arrow(475, 156, 475, 120, { color: 'bad', dash: '5 4' });
  d.text(600, 140, '✗ not allowed', { size: 12, color: 'bad' });
  return figure(d, 'Policies are additive allow-lists. Once a pod is selected by any policy, only what some policy allows gets through; everything else is silently dropped.');
};

D['admission-flow'] = () => {
  const d = mk(720, 230, 'Policy as code: the kyverno CLI checks manifests in CI before merge; in the cluster, Kyverno\'s admission webhook enforces the same policies on every request, and background scans write PolicyReports');
  d.box(14, 30, 150, 64, 'pull request', { sub: 'k8s/*.yaml', color: 'accent' });
  d.box(214, 30, 170, 64, 'CI: kyverno apply', { sub: 'fail = red check', color: 'feat', titleSize: 13.5 });
  d.arrow(166, 62, 210, 62, { color: 'accent' });
  d.box(14, 140, 150, 64, 'kubectl / Argo CD', { sub: 'create or update', color: 'muted', titleSize: 13 });
  d.box(214, 140, 130, 64, 'API server', { color: 'info' });
  d.box(394, 140, 150, 64, 'Kyverno webhook', { sub: 'Enforce → deny\nAudit → report', color: 'feat', titleSize: 13 });
  d.box(594, 140, 112, 64, 'stored', { sub: 'and runs', color: 'ok' });
  d.arrow(166, 172, 210, 172, { color: 'text' });
  d.arrow(346, 172, 390, 172, { color: 'info', label: 'admission', size: 11 });
  d.arrow(546, 172, 590, 172, { color: 'ok', label: 'allowed', size: 11 });
  d.box(430, 30, 276, 64, 'policies/*.yaml in git', { sub: 'one source for CI and cluster', color: 'main', titleSize: 13.5 });
  d.arrow(568, 96, 470, 136, { color: 'main', dash: '5 4' });
  d.arrow(430, 62, 386, 62, { color: 'main', dash: '5 4' });
  return figure(d, 'The same policy file runs twice: early in CI (fast feedback on the pull request) and at the API server (nothing slips past, whoever applies it).');
};

D['secrets-flow'] = () => {
  const d = mk(720, 250, 'Secrets with a manager: the value lives in Vault; the External Secrets Operator logs in with the pod\'s service account, reads only what its Vault policy allows, and writes a Kubernetes Secret that the pod uses; git only holds references');
  d.box(14, 20, 150, 90, 'Vault', { sub: 'secret/shop/db\nversions · audit log', color: 'main' });
  d.box(14, 140, 150, 90, 'git', { sub: 'ExternalSecret\n(a reference, no value)', color: 'accent' });
  d.box(240, 70, 190, 110, 'External Secrets', { sub: 'logs in as SA shop\npolicy: read shop/*\nrefresh every 1m', color: 'feat', titleSize: 14 });
  d.box(500, 70, 100, 50, 'Secret', { sub: 'shop-db', color: 'info', titleSize: 13 });
  d.box(500, 150, 100, 50, 'pod', { sub: 'env / file', color: 'ok', titleSize: 13 });
  d.arrow(166, 70, 236, 100, { color: 'main', label: 'read', size: 11 });
  d.arrow(166, 180, 236, 150, { color: 'accent', label: 'applied by Argo CD', size: 11, dy: 18 });
  d.arrow(432, 100, 496, 96, { color: 'feat', label: 'writes', size: 11 });
  d.arrow(550, 122, 550, 146, { color: 'info' });
  d.text(660, 100, 'rotate in Vault →', { size: 11.5, color: 'muted' });
  d.text(660, 116, 'Secret updates', { size: 11.5, color: 'muted' });
  d.text(660, 132, 'by itself', { size: 11.5, color: 'muted' });
  return figure(d, 'For files that must live in git (bootstrap secrets, config repos), SOPS encrypts the values with age keys instead.');
};

D['golden-path'] = () => {
  const d = mk(720, 240, 'A golden path: one platform command creates a repository from a template, builds the first image, and opens a GitOps pull request; merging it lets an ApplicationSet deploy the service, and the catalog tracks owner, scorecard and DORA metrics');
  d.box(14, 90, 130, 64, 'lumen create', { sub: 'receipts', color: 'accent', titleSize: 13.5 });
  d.box(200, 14, 170, 60, 'repo from template', { sub: 'CI · Dockerfile · catalog', color: 'main', titleSize: 13 });
  d.box(200, 92, 170, 60, 'first image', { sub: 'ghcr.io/lumen/receipts', color: 'feat', titleSize: 13 });
  d.box(200, 170, 170, 60, 'GitOps PR', { sub: 'apps/receipts/', color: 'info', titleSize: 13 });
  d.arrow(146, 110, 196, 50, { color: 'accent' });
  d.arrow(146, 122, 196, 122, { color: 'accent' });
  d.arrow(146, 134, 196, 196, { color: 'accent' });
  d.box(430, 170, 140, 60, 'ApplicationSet', { sub: 'one app per folder', color: 'feat', titleSize: 13 });
  d.arrow(372, 200, 426, 200, { color: 'info', label: 'merge', size: 11 });
  d.box(600, 170, 106, 60, 'running', { sub: 'probes · limits\nnetpol', color: 'ok', titleSize: 13 });
  d.arrow(572, 200, 596, 200, { color: 'feat' });
  d.box(430, 30, 276, 100, 'service catalog', { sub: 'owner · runbook · scorecard\nDORA: deploys/week, lead time,\nfailure rate, time to restore', color: 'muted', titleSize: 13.5 });
  return figure(d, 'The easy way is the right way: a new service starts with CI, health checks, limits, a network policy and an owner, without a ticket to the platform team.');
};
