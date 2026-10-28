// Realm 13 · Platform & GitOps: Helm charts and releases, Kustomize overlays, GitOps with
// Argo CD, RBAC, NetworkPolicies, policy as code with Kyverno, secrets managers (Vault,
// External Secrets, SOPS) and golden paths with a service catalog and DORA metrics.
// Everything runs on the simulated cluster: charts render, Argo CD pulls from the
// simulated GitHub, policies are enforced at admission, packets are really dropped.

import { parseYaml } from '../git/yaml.js';
import { releasesOf } from '../sim/helm.js';
import { kustomizeBuild, hostFiles } from '../sim/kustomize.js';
import { authorize, saIdentity } from '../sim/rbac.js';
import { evaluate, policiesFor } from '../sim/kyverno.js';
import { scorecard } from '../sim/platform.js';

// ------------------------------------------------------------ shared helpers
const LOCK = deps => JSON.stringify({ name: 'app', lockfileVersion: 3, packages: Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }])) }, null, 2) + '\n';
const nodeApp = (name, { port = 3000, env = [], routes = [], ready = null } = {}) => ({
  'server.js': ["const express = require('express');", 'const app = express();', `const PORT = process.env.PORT || ${port};`, ...env.map(v => `if (!process.env.${v}) throw new Error('${v} is required');`), "app.get('/health', (req, res) => res.json({ status: 'ok' }));", `app.get('/ready', (req, res) => ${ready || 'res.json({ ready: true })'});`, ...routes.map(([p, body]) => `app.get('${p}', (req, res) => ${body});`), `app.listen(PORT, () => console.log(\`${name} listening on \${PORT}\`));`, ''].join('\n'),
  'package.json': JSON.stringify({ name, version: '1.0.0', dependencies: { express: '^4.21.1' } }, null, 2) + '\n',
  'package-lock.json': LOCK({ express: '4.21.1' }),
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER node\nCMD ["node", "server.js"]\n',
});
const SHOP = v => `ghcr.io/lumen/shop:${v}`;
function shopImages(H, versions = ['2.0', '2.1']) {
  for (const v of versions) {
    const bad = v === 'bad';
    H.publishImage(SHOP(v === 'bad' ? '2.2' : v), nodeApp('shop', { routes: [['/', `res.send('Lumen shop ${bad ? '2.2' : v}')`]], ...(bad || v === '2.1-rc' ? { ready: "res.status(503).json({ ready: false, reason: 'payments client not initialised' })" } : {}) }));
  }
}
const cl = t => t.cluster('lumen');
const dep = (t, ns, n) => cl(t)?.get('Deployment', ns, n) || null;
const img = d => d?.spec?.template?.spec?.containers?.[0]?.image || '';
const readyN = (t, ns, sel) => t.kready('lumen', ns, sel).length;
const depReady = (t, ns, n, want) => { const d = dep(t, ns, n); return !!d && d.spec.replicas === want && (d.status.readyReplicas || 0) === want && (d.status.updatedReplicas || 0) === want && (d.status.replicas || 0) === want; };
const helmEv = (t, pred) => t.events('helm').filter(pred);
const rels = (t, name, ns) => releasesOf(cl(t), name, ns);
const deployedRel = (t, name, ns) => [...rels(t, name, ns)].reverse().find(r => r.info.status === 'deployed') || null;
const remoteFile = (t, slug, path, branch = 'main') => { const h = t.remote(slug)?.refs['refs/heads/' + branch]; if (!h) return null; const blob = t.uni.readTreeFlat(t.uni.commit(h).tree).get(path); return blob ? t.uni.objects.get(blob)?.content ?? null : null; };
const remoteHead = (t, slug) => { const h = t.remote(slug)?.refs['refs/heads/main']; return h ? t.uni.commit(h) : null; };
const W = (path, text) => `cat > ${path} <<'EOF'\n${text.replace(/\n$/, '')}\nEOF`;
const podHost = (t, ns, sel) => { const c = cl(t); const p = t.kready('lumen', ns, sel)[0]; const rt = p && c.rt.get(p.metadata.uid); return rt?.containers[0]?.ctr?.h || null; };
const workflowsOn = (t, slug) => { const h = t.remote(slug)?.refs['refs/heads/main']; if (!h) return ''; return [...t.uni.readTreeFlat(t.uni.commit(h).tree)].filter(([p]) => p.startsWith('.github/workflows/')).map(([, b]) => t.uni.objects.get(b).content).join('\n'); };
const kev = (t, pred) => t.events('kubectl').filter(pred);
const prRuns = (t, slug, head) => { const b = t.remote(slug); if (!b) return []; const pr = b.meta.prs.filter(p => p.head === head); return b.meta.runs.filter(r => pr.some(p => r.pr === p.number) || (r.event === 'pull_request' && r.branch === head)); };

// ------------------------------------------------------------ lesson 1: Helm
const CHART = {
  'Chart.yaml': 'apiVersion: v2\nname: shop\ndescription: The Lumen shop\ntype: application\nversion: 1.3.0\nappVersion: "2.0"\n',
  'values.yaml': '# Defaults: a small, private install. Override per environment with -f values-<env>.yaml\nreplicaCount: 1\n\nimage:\n  repository: ghcr.io/lumen/shop\n  tag: "2.0"\n\nservice:\n  port: 80\n\ningress:\n  enabled: false\n  host: shop.local\n\nresources: {}\n',
  'templates/_helpers.tpl': '{{- define "shop.fullname" -}}\n{{- if contains .Chart.Name .Release.Name }}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{ else }}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{ end }}\n{{- end }}\n\n{{- define "shop.selectorLabels" -}}\napp.kubernetes.io/name: {{ .Chart.Name }}\napp.kubernetes.io/instance: {{ .Release.Name }}\n{{- end }}\n',
  'templates/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include "shop.fullname" . }}\n  labels:\n    {{- include "shop.selectorLabels" . | nindent 4 }}\nspec:\n  replicas: {{ .Values.replicaCount }}\n  progressDeadlineSeconds: 90\n  selector:\n    matchLabels:\n      {{- include "shop.selectorLabels" . | nindent 6 }}\n  template:\n    metadata:\n      labels:\n        {{- include "shop.selectorLabels" . | nindent 8 }}\n    spec:\n      containers:\n        - name: shop\n          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"\n          ports:\n            - name: http\n              containerPort: 3000\n          readinessProbe:\n            httpGet:\n              path: /ready\n              port: http\n            periodSeconds: 5\n          livenessProbe:\n            httpGet:\n              path: /health\n              port: http\n          {{- with .Values.resources }}\n          resources:\n            {{- toYaml . | nindent 12 }}\n          {{- end }}\n',
  'templates/service.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ include "shop.fullname" . }}\nspec:\n  selector:\n    {{- include "shop.selectorLabels" . | nindent 4 }}\n  ports:\n    - name: http\n      port: {{ .Values.service.port }}\n      targetPort: http\n',
  'templates/ingress.yaml': '{{- if .Values.ingress.enabled }}\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: {{ include "shop.fullname" . }}\nspec:\n  ingressClassName: nginx\n  rules:\n    - host: {{ required "ingress.host is required when the ingress is enabled" .Values.ingress.host | quote }}\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: {{ include "shop.fullname" . }}\n                port:\n                  number: {{ .Values.service.port }}\n{{- end }}\n',
  'templates/NOTES.txt': 'The shop is installed as {{ .Release.Name }} ({{ .Values.replicaCount }} replicas, image tag {{ .Values.image.tag }}).\n{{- if .Values.ingress.enabled }}\nVisit: http://{{ .Values.ingress.host }}/\n{{- else }}\nNo ingress: try kubectl port-forward -n {{ .Release.Namespace }} svc/{{ include "shop.fullname" . }} 8080:{{ .Values.service.port }}\n{{- end }}\n',
};
const VALUES_PROD = '# Production: three replicas behind the public hostname, with requests and limits\nreplicaCount: 3\n\ningress:\n  enabled: true\n  host: shop.lumen.dev\n\nresources:\n  requests:\n    cpu: 100m\n    memory: 128Mi\n  limits:\n    memory: 256Mi\n';
const site = (t, host, want) => { const r = t.http('laptop', `http://${host}/`); return r.status === 200 && (!want || String(r.body).includes(want)); };

// ------------------------------------------------------------ lesson 2: Kustomize
const K_BASE = {
  'base/kustomization.yaml': 'resources:\n  - deployment.yaml\n  - service.yaml\nlabels:\n  - pairs:\n      app.kubernetes.io/part-of: shop\nconfigMapGenerator:\n  - name: shop-config\n    literals:\n      - LOG_LEVEL=debug\n      - FEATURE_SPECIALS=false\n',
  'base/deployment.yaml': `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: shop\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: shop\n  template:\n    metadata:\n      labels:\n        app: shop\n    spec:\n      containers:\n        - name: shop\n          image: ${SHOP('2.0')}\n          ports:\n            - name: http\n              containerPort: 3000\n          envFrom:\n            - configMapRef:\n                name: shop-config\n          readinessProbe:\n            httpGet:\n              path: /ready\n              port: http\n            periodSeconds: 5\n`,
  'base/service.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: shop\nspec:\n  selector:\n    app: shop\n  ports:\n    - port: 80\n      targetPort: http\n',
  'overlays/staging/kustomization.yaml': 'namespace: shop-staging\nresources:\n  - ../../base\n',
};
const K_PROD = 'namespace: shop-prod\nresources:\n  - ../../base\nreplicas:\n  - name: shop\n    count: 3\nimages:\n  - name: ghcr.io/lumen/shop\n    newTag: "2.0"\nconfigMapGenerator:\n  - name: shop-config\n    behavior: merge\n    literals:\n      - LOG_LEVEL=warn\npatches:\n  - path: limits.yaml\n';
const K_LIMITS = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: shop\nspec:\n  template:\n    spec:\n      containers:\n        - name: shop\n          resources:\n            requests:\n              cpu: 100m\n              memory: 128Mi\n            limits:\n              memory: 256Mi\n';
const kbuild = (t, dir) => { const r = kustomizeBuild(hostFiles(t.host('laptop')), `/home/dev/shop-k8s/${dir}`); return r.error ? [] : r.docs; };
const cmOf = (t, ns, d) => { const name = d?.spec?.template?.spec?.containers?.[0]?.envFrom?.[0]?.configMapRef?.name; return name ? cl(t)?.get('ConfigMap', ns, name) : null; };

// ------------------------------------------------------------ lesson 3: Argo CD
const G_DEP = v => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: shop\nspec:\n  replicas: 2\n  progressDeadlineSeconds: 120\n  selector:\n    matchLabels:\n      app: shop\n  template:\n    metadata:\n      labels:\n        app: shop\n    spec:\n      containers:\n        - name: shop\n          image: ${SHOP(v)}\n          ports:\n            - name: http\n              containerPort: 3000\n          readinessProbe:\n            httpGet:\n              path: /ready\n              port: http\n            periodSeconds: 5\n          resources:\n            requests:\n              cpu: 50m\n              memory: 64Mi\n            limits:\n              memory: 128Mi\n`;
const G_FILES = {
  'README.md': '# lumen/gitops\n\nThe desired state of Lumen\'s Kubernetes workloads. Argo CD deploys `apps/<name>/` to the namespace `<name>`.\nChange production with a pull request, never with kubectl.\n',
  'apps/shop/kustomization.yaml': 'resources:\n  - deployment.yaml\n  - service.yaml\n  - ingress.yaml\n  - legacy-config.yaml\n',
  'apps/shop/deployment.yaml': G_DEP('2.0'),
  'apps/shop/service.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: shop\nspec:\n  selector:\n    app: shop\n  ports:\n    - port: 80\n      targetPort: http\n',
  'apps/shop/ingress.yaml': 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: shop\nspec:\n  ingressClassName: nginx\n  rules:\n    - host: shop.lumen.dev\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: shop\n                port:\n                  number: 80\n',
  'apps/shop/legacy-config.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shop-legacy\ndata:\n  # used by the old PHP checkout, retired in March\n  CHECKOUT_URL: http://checkout-v1.internal\n',
};
const app = (t, name) => t.kapp('lumen', name);
const appOk = (t, name) => { const a = app(t, name); return a?.status?.sync?.status === 'Synced' && a?.status?.health?.status === 'Healthy'; };
const commitsOf = (t, slug) => { const out = []; let h = t.remote(slug)?.refs['refs/heads/main']; while (h) { const c = t.uni.commit(h); out.push({ hash: h, ...c }); h = c.parents?.[0]; } return out; };
const gitopsDeployImg = (t, hash) => { const flat = t.uni.readTreeFlat(t.uni.commit(hash).tree); const b = flat.get('apps/shop/deployment.yaml'); return b ? (t.uni.objects.get(b).content.match(/image: (\S+)/) || [])[1] : null; };

// ------------------------------------------------------------ lesson 4: RBAC
const SA_DEP = saIdentity('shop', 'shop-deployer');
const can = (t, ident, verb, resource, group, ns, name) => authorize(cl(t), ident, { verb, resource, group, ns, name });
const SAMIR = { user: 'samir', groups: ['system:authenticated'] };
const SHOP_YAML = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: shop\n  namespace: shop\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: shop\n  template:\n    metadata:\n      labels:\n        app: shop\n    spec:\n      containers:\n        - name: shop\n          image: nginx:1.27\n          ports:\n            - containerPort: 80\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: shop\n  namespace: shop\nspec:\n  selector:\n    app: shop\n  ports:\n    - port: 80\n`;
const STRIPE = ['sk', 'test', '51Lumen', 'R7d9Qe2Lx'].join('_');


// ------------------------------------------------------------ lesson 5: network policies
const echo = (name, text, labels = { app: name }) => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: 'shop' }, spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name, image: 'hashicorp/http-echo:1.0', args: [`-text=${text}`], ports: [{ name: 'http', containerPort: 5678 }] }] } } } });
const nginxDep = (name, ns) => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns }, spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image: 'nginx:1.27', ports: [{ containerPort: 80 }] }] } } } });
const svc = (name, ns, port, target) => ({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns }, spec: { selector: { app: name }, ports: [{ port, targetPort: target }] } });
const curlFrom = (t, ns, app, url) => { const h = podHost(t, ns, `app=${app}`); if (!h) return null; return t.exec(h, `curl -s -m 2 ${url}`, { user: 'root' }); };
const denyAll = t => cl(t).list('NetworkPolicy', 'shop').find(p => !Object.keys(p.spec.podSelector?.matchLabels || {}).length && !(p.spec.podSelector?.matchExpressions || []).length && (p.spec.policyTypes || ['Ingress']).includes('Ingress') && !(p.spec.ingress || []).length);
const NP_DENY = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny-ingress\n  namespace: shop\nspec:\n  podSelector: {}\n  policyTypes:\n    - Ingress\n';
const NP_WEB = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: web-from-ingress\n  namespace: shop\nspec:\n  podSelector:\n    matchLabels:\n      app: web\n  ingress:\n    - from:\n        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: ingress-nginx\n      ports:\n        - port: 80\n';
const NP_API = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: api-from-web\n  namespace: shop\nspec:\n  podSelector:\n    matchLabels:\n      app: api\n  ingress:\n    - from:\n        - podSelector:\n            matchLabels:\n              app: web\n      ports:\n        - port: http\n';

// ------------------------------------------------------------ lesson 6: policy as code
const P_LIMITS = a => `apiVersion: kyverno.io/v1\nkind: ClusterPolicy\nmetadata:\n  name: require-limits\n  annotations:\n    policies.lumen.dev/why: "A pod without limits can starve its neighbours (incident 2026-03)."\nspec:\n  validationFailureAction: ${a}\n  background: true\n  rules:\n    - name: check-limits\n      match:\n        any:\n          - resources:\n              kinds:\n                - Pod\n      validate:\n        message: "CPU and memory limits are required (resources.limits.cpu and .memory)."\n        pattern:\n          spec:\n            containers:\n              - resources:\n                  limits:\n                    cpu: "?*"\n                    memory: "?*"\n`;
const P_LATEST = a => `apiVersion: kyverno.io/v1\nkind: ClusterPolicy\nmetadata:\n  name: disallow-latest-tag\nspec:\n  validationFailureAction: ${a}\n  background: true\n  rules:\n    - name: require-image-tag\n      match:\n        any:\n          - resources:\n              kinds:\n                - Pod\n      validate:\n        message: "Pin an image tag; :latest (or no tag) is not allowed."\n        pattern:\n          spec:\n            containers:\n              - image: "*:* & !*:latest"\n`;
const PK = (name, image, limits) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: ${name}\n  template:\n    metadata:\n      labels:\n        app: ${name}\n    spec:\n      containers:\n        - name: ${name}\n          image: ${image}\n${limits ? '          resources:\n            requests:\n              cpu: 50m\n              memory: 64Mi\n            limits:\n              cpu: 200m\n              memory: 128Mi\n' : ''}`;
const P_WF = 'name: policy\non:\n  pull_request:\njobs:\n  kyverno:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: kyverno/action-install-cli@v0.2.0\n      - run: kyverno apply policies/ --resource k8s/\n';
const liveFails = (t, ns) => { const c = cl(t); if (!c?.kyverno) return -1; return ['Deployment'].flatMap(k => c.list(k, ns)).flatMap(o => policiesFor(c, ns).flatMap(p => evaluate(p, o))).filter(r => r.result === 'fail').length; };

// ------------------------------------------------------------ lesson 7: secrets managers
const OLD_PW = ['Shop', 'Db', '2024', 'pl4intext'].join('-');
const ROOT = () => ['hvs', ['DevRoot', 'Lumen', '7Q2'].join('')].join('.');
const vaultOf = t => t.uni.vaults?.get('vault.lumen.internal') || null;
const kvNow = (t, key) => { const e = vaultOf(t)?.kv.secret.get(key); return e ? e.versions[e.current - 1].data : null; };
const secretVal = (t, ns, name, key) => { const s = cl(t)?.get('Secret', ns, name); try { return s?.data?.[key] !== undefined ? atob(s.data[key]) : null; } catch { return null; } };
const esReady = (t, ns, name) => cl(t)?.get('ExternalSecret', ns, name)?.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') || false;
const SHOP_SECRET_DEP = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'shop', namespace: 'shop' }, spec: { replicas: 2, selector: { matchLabels: { app: 'shop' } }, template: { metadata: { labels: { app: 'shop' } }, spec: { serviceAccountName: 'shop', containers: [{ name: 'shop', image: SHOP('2.0'), ports: [{ name: 'http', containerPort: 3000 }], env: [{ name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'shop-db', key: 'password' } } }] }] } } } };
const ESO_YAML = role => `apiVersion: external-secrets.io/v1beta1\nkind: SecretStore\nmetadata:\n  name: vault\n  namespace: shop\nspec:\n  provider:\n    vault:\n      server: http://vault.lumen.internal:8200\n      path: secret\n      version: v2\n      auth:\n        kubernetes:\n          mountPath: kubernetes\n          role: ${role}\n          serviceAccountRef:\n            name: shop\n---\napiVersion: external-secrets.io/v1beta1\nkind: ExternalSecret\nmetadata:\n  name: shop-db\n  namespace: shop\nspec:\n  refreshInterval: 1m\n  secretStoreRef:\n    name: vault\n    kind: SecretStore\n  target:\n    name: shop-db\n  data:\n    - secretKey: password\n      remoteRef:\n        key: shop/db\n        property: password\n`;
const SOPS_RULE = "printf 'creation_rules:\\n  - path_regex: secrets/.*\\\\.yaml$\\n    encrypted_regex: ^(data|stringData)$\\n    age: %s\\n' $(age-keygen -y ~/.config/sops/age/keys.txt) > .sops.yaml";

// ------------------------------------------------------------ lessons 8-9: golden paths
const APPSET = 'apiVersion: argoproj.io/v1alpha1\nkind: ApplicationSet\nmetadata:\n  name: apps\n  namespace: argocd\nspec:\n  generators:\n    - git:\n        repoURL: https://github.com/lumen/gitops.git\n        revision: HEAD\n        directories:\n          - path: apps/*\n  template:\n    metadata:\n      name: "{{path.basename}}"\n    spec:\n      project: default\n      source:\n        repoURL: https://github.com/lumen/gitops.git\n        targetRevision: HEAD\n        path: "{{path}}"\n      destination:\n        server: https://kubernetes.default.svc\n        namespace: "{{path.basename}}"\n      syncPolicy:\n        automated:\n          prune: true\n          selfHeal: true\n        syncOptions:\n          - CreateNamespace=true\n';
const BILLING_DEP = (probes = false) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: billing\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: billing\n  template:\n    metadata:\n      labels:\n        app: billing\n    spec:\n      containers:\n        - name: billing\n          image: nginx:1.27\n          ports:\n            - name: http\n              containerPort: 80\n${probes ? '          readinessProbe:\n            httpGet:\n              path: /\n              port: http\n          livenessProbe:\n            httpGet:\n              path: /\n              port: http\n          resources:\n            requests:\n              cpu: 50m\n              memory: 64Mi\n            limits:\n              cpu: 200m\n              memory: 128Mi\n' : ''}`;
const BILLING_NP = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: billing\nspec:\n  podSelector:\n    matchLabels:\n      app: billing\n  ingress:\n    - from:\n        - podSelector: {}\n      ports:\n        - port: http\n';
const BILLING_CAT = 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing\n  description: Invoices and payment runs\nspec:\n  type: service\n  lifecycle: production\n';
export function platformWorld(H, { kyverno = false, boss = false } = {}) {
  const c = H.cluster('lumen', { ingress: true });
  H.argocd('lumen', { webhook: true });
  const D = 86400, now = H.uni.time;
  const files = { 'README.md': '# lumen/gitops\n\nEvery folder under apps/ is deployed by the `apps` ApplicationSet to the namespace of the same name.\n', 'bootstrap/apps.yaml': APPSET };
  if (!boss) Object.assign(files, { 'apps/billing/kustomization.yaml': 'resources:\n  - deployment.yaml\n', 'apps/billing/deployment.yaml': BILLING_DEP() });
  else Object.assign(files, { 'apps/shop/kustomization.yaml': 'resources:\n  - deployment.yaml\nlabels:\n  - pairs:\n      lumen.dev/team: team-shop\n', 'apps/shop/deployment.yaml': PK('shop', 'nginx:1.27', true) });
  H.remote('lumen', 'gitops', [{ message: 'Bootstrap the platform', files }], { collaborators: ['you'] });
  if (!boss) H.remote('lumen', 'billing', [{ message: 'billing service', files: { 'catalog-info.yaml': BILLING_CAT, '.github/workflows/build.yml': 'name: build\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo build\n', 'README.md': '# billing\n' } }], { collaborators: ['you'] });
  if (kyverno) { H.kyverno('lumen'); H.k8s('lumen', [P_LIMITS('Enforce'), P_LATEST('Enforce'), P_TEAM].map(x => parseYaml(x)), { settle: 2 }); }
  H.k8s('lumen', [parseYaml(APPSET)], { settle: 40 });
  H.platform({
    services: boss ? { shop: { owner: 'team-shop', template: 'node-api' } } : { billing: { owner: null, template: null }, shop: { owner: 'team-shop', template: 'node-api' } },
    deploys: [...Array.from({ length: 4 }, (_, i) => ({ service: 'billing', at: now - (25 - i * 6) * D, commitAt: now - (25 - i * 6) * D - 9 * D, ok: i !== 2, note: i === 2 ? 'rolled back: invoice totals wrong' : 'monthly release window' })), ...Array.from({ length: 20 }, (_, i) => ({ service: 'shop', at: now - (29 - i * 1.4) * D, commitAt: now - (29 - i * 1.4) * D - 3 * 3600, ok: i !== 7, note: i === 7 ? 'canary caught a 500, auto-rollback' : '' }))],
    incidents: [{ service: 'billing', start: now - 13 * D, end: now - 13 * D + 30 * 3600, title: 'Invoices stuck after the release' }, { service: 'shop', start: now - 20 * D, end: now - 20 * D + 40 * 60, title: 'Checkout 500s (rolled back)' }],
  });
  return c;
}
const P_TEAM = 'apiVersion: kyverno.io/v1\nkind: ClusterPolicy\nmetadata:\n  name: require-team-label\nspec:\n  validationFailureAction: Enforce\n  rules:\n    - name: team-label\n      match:\n        any:\n          - resources:\n              kinds:\n                - Deployment\n      validate:\n        message: "Every Deployment needs a lumen.dev/team label (who owns it?)."\n        pattern:\n          metadata:\n            labels:\n              lumen.dev/team: "?*"\n';
const LOY = {
  sa: 'apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: loyalty\n',
  eso: 'apiVersion: external-secrets.io/v1beta1\nkind: SecretStore\nmetadata:\n  name: vault\nspec:\n  provider:\n    vault:\n      server: http://vault.lumen.internal:8200\n      path: secret\n      version: v2\n      auth:\n        kubernetes:\n          mountPath: kubernetes\n          role: loyalty\n          serviceAccountRef:\n            name: loyalty\n---\napiVersion: external-secrets.io/v1beta1\nkind: ExternalSecret\nmetadata:\n  name: loyalty-db\nspec:\n  refreshInterval: 1m\n  secretStoreRef:\n    name: vault\n    kind: SecretStore\n  target:\n    name: loyalty-db\n  data:\n    - secretKey: password\n      remoteRef:\n        key: loyalty/db\n        property: password\n',
  ingress: 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: loyalty\nspec:\n  ingressClassName: nginx\n  rules:\n    - host: loyalty.lumen.dev\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: loyalty\n                port:\n                  number: 80\n',
  deny: 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny-ingress\nspec:\n  podSelector: {}\n  policyTypes:\n    - Ingress\n',
  view: 'apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: team-growth-view\nroleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: view\nsubjects:\n  - apiGroup: rbac.authorization.k8s.io\n    kind: Group\n    name: team-growth\n',
};

export default {
  id: 'platform',
  n: 13,
  title: 'Platform & GitOps',
  tagline: 'Helm and Kustomize, GitOps with Argo CD, RBAC and network policies, policy as code, secrets managers, golden paths and DORA metrics',
  badge: 'Platform Builder',
  intro: 'Turn a cluster into a **platform**: package software with **Helm**, keep environments apart with **Kustomize**, deploy everything from git with **Argo CD**, give people and pipelines exactly the access they need with **RBAC**, wall pods off with **NetworkPolicies**, enforce the rules with **Kyverno**, keep secrets in **Vault** (and encrypted with **SOPS** when they must live in git), and offer **golden paths** whose results you measure with **DORA metrics**.',
  lessons: [
    {
      id: 'helm-charts',
      title: 'Packaging with Helm',
      summary: 'Charts, values layers, releases and revisions; chart repositories; helm template and lint; --wait and --atomic upgrades; history and rollback; the --set trap.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          H.install('laptop', 'helm');
          H.dns('shop.lumen.dev', c.ingressHost.ip);
          shopImages(H, ['2.0', '2.1-rc']);
          for (const [p, txt] of Object.entries(CHART)) H.write('laptop', `~/charts/shop/${p}`, txt, { owner: 'dev' });
          H.write('laptop', '~/values-prod.yaml', VALUES_PROD, { owner: 'dev' });
        },
        suggestions: ['helm repo add bitnami https://charts.bitnami.com/bitnami', 'cat charts/shop/values.yaml values-prod.yaml'],
        tasks: [
          { title: 'Add the Bitnami chart repository and read which values the `bitnami/redis` chart lets you set', hint: '`helm repo add NAME URL`, then `helm show values CHART`.', solution: 'helm repo add bitnami https://charts.bitnami.com/bitnami && helm show values bitnami/redis', check: t => helmEv(t, e => e.cmd === 'repo' && e.sub === 'add' && e.repo).length > 0 && helmEv(t, e => e.cmd === 'show' && e.what === 'values' && /redis/.test(e.chart)).length > 0 },
          { title: 'Install it as release `cache` in a new namespace `shop` with a 1Gi data volume (`master.persistence.size`), and wait until Redis is running', hint: '`--create-namespace`, `--set master.persistence.size=1Gi`, `--wait`.', solution: 'helm install cache bitnami/redis -n shop --create-namespace --set master.persistence.size=1Gi --wait', check: t => { const r = deployedRel(t, 'cache', 'shop'); return !!r && r.config_all?.master?.persistence?.size === '1Gi' && (cl(t).get('StatefulSet', 'shop', 'cache-redis-master')?.status?.readyReplicas || 0) === 1; } },
          { title: 'Render the shop chart in `~/charts/shop` with the production values, without installing anything. How many replicas, and is there an Ingress?', hint: '`helm template RELEASE CHART -f FILE` prints the manifests.', solution: 'helm template shop ./charts/shop -f values-prod.yaml', check: t => helmEv(t, e => e.cmd === 'template' && e.values?.replicaCount === 3 && e.values?.ingress?.enabled === true).length > 0 },
          { title: 'Install the chart as release `shop` in `shop` with the production values, waiting until it is ready, then load http://shop.lumen.dev', solution: 'helm install shop ./charts/shop -n shop -f values-prod.yaml --wait && curl -s http://shop.lumen.dev', check: t => { const r = deployedRel(t, 'shop', 'shop'); return !!r && r.config_all?.replicaCount === 3 && depReady(t, 'shop', 'shop', 3) && t.ran(/curl\b.*shop\.lumen\.dev/) && site(t, 'shop.lumen.dev', 'shop 2.0'); } },
          { title: 'Upgrade to image tag `2.1` so that a bad release rolls itself back: `--atomic` with a 2-minute timeout. What happened, and what does `helm history` show?', detail: 'Keep the production values: pass `-f values-prod.yaml` again and add `--set image.tag=2.1`.', hint: '`helm upgrade shop ./charts/shop -n shop -f values-prod.yaml --set image.tag=2.1 --atomic --timeout 2m`, then `helm history shop -n shop`.', solution: 'helm upgrade shop ./charts/shop -n shop -f values-prod.yaml --set image.tag=2.1 --atomic --timeout 2m; helm history shop -n shop', check: t => { const all = rels(t, 'shop', 'shop'); const cur = deployedRel(t, 'shop', 'shop'); return all.some(r => r.info.status === 'failed' && String(r.config_all?.image?.tag) === '2.1') && !!cur && String(cur.config_all?.image?.tag) === '2.0' && img(dep(t, 'shop', 'shop')) === SHOP('2.0') && depReady(t, 'shop', 'shop', 3) && helmEv(t, e => e.cmd === 'history').length > 0; } },
          { title: 'Scale to 4 replicas the quick way, `helm upgrade shop ./charts/shop -n shop --set replicaCount=4`, then compare `helm get values shop -n shop` with what you installed. What did the upgrade throw away?', solution: 'helm upgrade shop ./charts/shop -n shop --set replicaCount=4 && helm get values shop -n shop', check: t => t.after(e => e.type === 'helm' && e.cmd === 'upgrade' && e.ok && e.values?.replicaCount === 4 && !e.values?.ingress?.enabled, e => e.type === 'helm' && e.cmd === 'get') },
          { title: 'Put it right with one upgrade: the production values *and* 4 replicas. The site must answer again', hint: 'Pass `-f values-prod.yaml` again, with `--set replicaCount=4` after it (later layers win). Or `--reuse-values`, if the release still had them.', solution: 'helm upgrade shop ./charts/shop -n shop -f values-prod.yaml --set replicaCount=4 --wait && curl -s http://shop.lumen.dev', check: t => { const r = deployedRel(t, 'shop', 'shop'); return !!r && r.config_all?.ingress?.enabled === true && r.config_all?.replicaCount === 4 && !!r.config_all?.resources?.limits && depReady(t, 'shop', 'shop', 4) && site(t, 'shop.lumen.dev'); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What is a Helm release?', choices: ['A chart published to a repository', 'A named installation of a chart in a cluster, with numbered revisions', 'A git tag', 'A container image'], answer: 1, explain: 'Install = revision 1; each upgrade or rollback adds one.' },
        { type: 'order', q: 'Order the value layers from lowest to highest priority.', items: ["The chart's values.yaml", 'The first -f file', 'The second -f file', '--set on the command line'], explain: 'Later layers win.' },
        { type: 'mc', q: 'You installed with `-f values-prod.yaml`. Then you run `helm upgrade shop ./chart --set replicaCount=4`. What values does revision 2 use?', choices: ['values-prod.yaml plus replicaCount=4', "Only the chart's defaults plus replicaCount=4", 'The same as revision 1', 'Helm refuses the upgrade'], answer: 1, explain: 'Upgrades start from the chart defaults plus what you pass now. Pass the file again, or use --reuse-values deliberately.' },
        { type: 'mc', q: 'What does `--atomic` add to an upgrade?', choices: ['It makes the upgrade faster', 'It waits for readiness and rolls back automatically if the release does not become ready', 'It locks the namespace', 'It signs the chart'], answer: 1, explain: 'Without --wait/--atomic, "deployed" only means the manifests were accepted.' },
        { type: 'tf', q: '`helm template` changes nothing in the cluster.', answer: true, explain: 'It renders locally: ideal for review and CI.' },
        { type: 'mc', q: 'Where does Helm 3 keep a release\'s history?', choices: ['In ~/.helm on your laptop', 'In Secrets in the release\'s namespace', 'In the chart repository', 'Nowhere: it recomputes it'], answer: 1, explain: 'sh.helm.release.v1.<name>.v<n>: anyone with the right access sees the same history.' },
        { type: 'multi', q: 'Good Helm habits in a team:', choices: ['Values files per environment, in git', 'Pin third-party chart versions', 'Keep passwords in values.yaml', 'Use --atomic in pipelines'], answer: [0, 1, 3], explain: 'Values end up in release Secrets and in git; reference existing Secrets instead.' },
        { type: 'type', q: 'Type the command that rolls release `shop` in namespace `shop` back to revision 1.', accept: ['helm rollback shop 1 -n shop', 'helm rollback shop 1 --namespace shop', 'helm rollback -n shop shop 1', 'helm -n shop rollback shop 1'], model: 'helm rollback shop 1 -n shop', explain: 'The rollback itself becomes a new revision.' },
      ],
    },
    {
      id: 'kustomize-overlays',
      title: 'Environments with Kustomize',
      summary: 'Bases and overlays, namespace/replicas/images transformers, strategic-merge and JSON patches, configMapGenerator content hashes, kubectl kustomize/diff/apply -k, kustomize edit in CI.',
      minutes: 30,
      lab: {
        cwd: '~/shop-k8s',
        panels: ['cluster', 'files'],
        setup(H) {
          H.cluster('lumen');
          H.install('laptop', 'kustomize');
          shopImages(H, ['2.0', '2.1']);
          H.k8s('lumen', [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop-staging' } }, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop-prod' } }], { settle: 2 });
          for (const [p, txt] of Object.entries(K_BASE)) H.write('laptop', `~/shop-k8s/${p}`, txt, { owner: 'dev' });
          H.mkdir('laptop', '/home/dev/shop-k8s/overlays/prod', { owner: 'dev' });
        },
        suggestions: ['tree', 'kubectl kustomize base'],
        tasks: [
          { title: 'Build the base and read the result. What is the ConfigMap really called, and why?', solution: 'kubectl kustomize base', check: t => kev(t, e => e.verb === 'kustomize' && /base/.test(e.args)).length > 0 },
          { title: 'Deploy staging with `kubectl apply -k` and wait for its pod to be ready', solution: 'kubectl apply -k overlays/staging && sleep 15 && kubectl get pods -n shop-staging', check: t => depReady(t, 'shop-staging', 'shop', 1) },
          { title: 'Write the production overlay in `overlays/prod`: namespace `shop-prod`, 3 replicas, image tag pinned to `2.0`, `LOG_LEVEL=warn` merged into the ConfigMap, and a patch (`limits.yaml`) adding requests and a 256Mi memory limit', detail: 'Check your work with `kubectl kustomize overlays/prod`.', hint: '`resources: [../../base]`, then `namespace:`, `replicas:`, `images:` (name + newTag), `configMapGenerator:` with `behavior: merge`, and `patches: [{path: limits.yaml}]` where limits.yaml is a partial Deployment named shop.', solution: 'nano overlays/prod/kustomization.yaml overlays/prod/limits.yaml', test: [W('overlays/prod/kustomization.yaml', K_PROD), W('overlays/prod/limits.yaml', K_LIMITS), 'kubectl kustomize overlays/prod'], check: t => { const docs = kbuild(t, 'overlays/prod'); const d = docs.find(x => x.kind === 'Deployment'); const cm = docs.find(x => x.kind === 'ConfigMap'); return !!d && d.metadata.namespace === 'shop-prod' && d.spec.replicas === 3 && img(d) === SHOP('2.0') && d.spec.template.spec.containers[0].resources?.limits?.memory === '256Mi' && cm?.data?.LOG_LEVEL === 'warn' && cm.data.FEATURE_SPECIALS === 'false'; } },
          { title: 'Preview what production would get with `kubectl diff -k`, then apply it and wait for 3 ready pods', solution: 'kubectl diff -k overlays/prod; kubectl apply -k overlays/prod && sleep 15 && kubectl get pods -n shop-prod', check: t => kev(t, e => e.verb === 'diff' && /overlays\/prod/.test(e.args)).length > 0 && depReady(t, 'shop-prod', 'shop', 3) && cmOf(t, 'shop-prod', dep(t, 'shop-prod', 'shop'))?.data?.LOG_LEVEL === 'warn' },
          { title: 'Turn on `FEATURE_SPECIALS=true` in production only. Apply, and watch the pods roll without a restart command. Why did they?', hint: 'Add the literal to the prod overlay\'s configMapGenerator. The new content gets a new hashed name, so the pod template changes.', solution: 'nano overlays/prod/kustomization.yaml && kubectl apply -k overlays/prod', test: [W('overlays/prod/kustomization.yaml', K_PROD.replace('      - LOG_LEVEL=warn\n', '      - LOG_LEVEL=warn\n      - FEATURE_SPECIALS=true\n')), 'kubectl apply -k overlays/prod', 'kubectl rollout status deploy/shop -n shop-prod'], check: t => { const d = dep(t, 'shop-prod', 'shop'); return cmOf(t, 'shop-prod', d)?.data?.FEATURE_SPECIALS === 'true' && depReady(t, 'shop-prod', 'shop', 3) && cmOf(t, 'shop-staging', dep(t, 'shop-staging', 'shop'))?.data?.FEATURE_SPECIALS === 'false'; } },
          { title: 'Staging tests the new image: in `overlays/staging`, run `kustomize edit set image ghcr.io/lumen/shop:2.1` (the way CI bumps tags) and apply. Production stays on 2.0', solution: 'cd overlays/staging && kustomize edit set image ghcr.io/lumen/shop:2.1 && cat kustomization.yaml && cd ../.. && kubectl apply -k overlays/staging && kubectl rollout status deploy/shop -n shop-staging', check: t => t.events('kustomize').some(e => e.cmd === 'edit' && e.what === 'image') && img(dep(t, 'shop-staging', 'shop')) === SHOP('2.1') && depReady(t, 'shop-staging', 'shop', 1) && img(dep(t, 'shop-prod', 'shop')) === SHOP('2.0') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What is an overlay in Kustomize?', choices: ['A Helm chart', 'A kustomization that builds on a base and changes only what differs for one environment', 'A namespace', 'A CI job'], answer: 1, explain: 'Base = shared manifests; overlay = per-environment differences.' },
        { type: 'mc', q: 'Why does configMapGenerator add a hash to the ConfigMap name?', choices: ['To avoid name collisions between teams', 'So that changing the config changes the pod template, which rolls the pods to pick up the new values', 'Kubernetes requires it', 'For encryption'], answer: 1, explain: 'Pods only read env from a ConfigMap at start.' },
        { type: 'mc', q: 'Which command shows what `kubectl apply -k overlays/prod` would change in the cluster, without changing it?', choices: ['kubectl kustomize overlays/prod', 'kubectl diff -k overlays/prod', 'kubectl get -k overlays/prod', 'kustomize lint'], answer: 1, explain: '`kubectl kustomize` only renders; `diff` compares with live state.' },
        { type: 'tf', q: 'Kustomize needs a templating language such as {{ .Values.x }} in the base manifests.', answer: false, explain: 'The base is plain, valid YAML; overlays patch it.' },
        { type: 'predict', q: 'The base Deployment uses `image: ghcr.io/lumen/shop:2.0`. The overlay has this. What image is deployed?', code: 'images:\n  - name: ghcr.io/lumen/shop\n    newTag: "2.1"', choices: ['ghcr.io/lumen/shop:2.0', 'ghcr.io/lumen/shop:2.1', 'ghcr.io/lumen/shop:latest', 'An error: the tag is already set'], answer: 1, explain: 'The images transformer rewrites matching images.' },
        { type: 'multi', q: 'Good Kustomize practice:', choices: ['Keep the base deployable on its own', 'Overlays contain only the differences', 'Copy the whole Deployment into each overlay to be safe', 'Let CI bump image tags with kustomize edit set image'], answer: [0, 1, 3], explain: 'Copies drift; patches stay small and reviewable.' },
        { type: 'mc', q: 'When do you reach for Helm rather than Kustomize?', choices: ['Never: they do the same', 'To install third-party software that is published as a chart, or to package your own app for others to configure', 'For staging only', 'When you have no namespaces'], answer: 1, explain: 'Many teams use both; Argo CD renders either.' },
      ],
    },
    {
      id: 'gitops-argocd',
      title: 'GitOps with Argo CD',
      summary: 'Desired state in git, Applications and ApplicationSets, sync and health, automated sync with self-heal and prune, polling versus refresh and webhooks, history, rollback with git revert.',
      minutes: 40,
      lab: {
        cwd: '~',
        panels: ['cluster', 'github'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          H.argocd('lumen');
          H.dns('shop.lumen.dev', c.ingressHost.ip);
          shopImages(H, ['2.0', '2.1', 'bad']);
          H.remote('lumen', 'gitops', [{ message: 'shop: manifests', files: G_FILES }], { collaborators: ['you'] });
        },
        suggestions: ['kubectl get pods -n argocd', 'kubectl port-forward svc/argocd-server -n argocd 8080:443'],
        tasks: [
          { title: 'Log in to Argo CD: port-forward its server to localhost:8080 and log in as `admin` with the initial password', hint: '`argocd admin initial-password -n argocd` prints it (or read the Secret `argocd-initial-admin-secret`). Then `argocd login localhost:8080 --username admin --password … --insecure`.', solution: 'kubectl port-forward svc/argocd-server -n argocd 8080:443 && argocd login localhost:8080 --username admin --password $(argocd admin initial-password -n argocd | head -1) --insecure', check: t => t.events('argocd').some(e => e.group === 'login' && e.ok) },
          { title: 'Create the application `shop` from `lumen/gitops`, path `apps/shop`, into namespace `shop` (let Argo CD create it), with automated sync, self-heal and prune. Wait until it is Synced and Healthy', hint: '`argocd app create shop --repo https://github.com/lumen/gitops.git --path apps/shop --dest-server https://kubernetes.default.svc --dest-namespace shop --sync-policy automated --self-heal --auto-prune --sync-option CreateNamespace=true`', solution: 'argocd app create shop --repo https://github.com/lumen/gitops.git --path apps/shop --dest-server https://kubernetes.default.svc --dest-namespace shop --sync-policy automated --self-heal --auto-prune --sync-option CreateNamespace=true && sleep 20 && argocd app get shop', check: t => { const a = app(t, 'shop'); return !!a?.spec.syncPolicy?.automated?.selfHeal && !!a.spec.syncPolicy.automated.prune && appOk(t, 'shop') && depReady(t, 'shop', 'shop', 2); } },
          { title: 'Ship 2.1 the GitOps way: clone `lumen/gitops`, change the shop\'s image tag to 2.1, commit and push. Then make Argo CD look now instead of waiting for its 3-minute poll', hint: 'After `git push`, run `argocd app get shop --refresh`.', solution: 'git clone https://github.com/lumen/gitops.git && cd gitops && sed -i "s/shop:2.0/shop:2.1/" apps/shop/deployment.yaml && git commit -am "shop: release 2.1" && git push && argocd app get shop --refresh', test: ['git clone https://github.com/lumen/gitops.git', 'cd gitops && sed -i "s/shop:2.0/shop:2.1/" apps/shop/deployment.yaml && git commit -am "shop: release 2.1" && git push', 'argocd app get shop --refresh', 'kubectl rollout status deploy/shop -n shop', 'argocd app get shop'], check: t => img(dep(t, 'shop', 'shop')) === SHOP('2.1') && depReady(t, 'shop', 'shop', 2) && appOk(t, 'shop') && gitopsDeployImg(t, t.remote('lumen/gitops').refs['refs/heads/main']) === SHOP('2.1') },
          { title: 'An incident "hotfix": scale the shop to 6 replicas with kubectl. Watch the deployment for a moment. What did Argo CD do, and why?', solution: 'kubectl scale deploy shop -n shop --replicas=6 && sleep 10 && kubectl get deploy -n shop && argocd app history shop', check: t => t.after(e => e.type === 'kubectl' && e.verb === 'scale' && / shop|deploy\/shop|deployment\/shop/.test(' ' + e.args) && /replicas[= ]6/.test(e.args), e => e.type === 'argocd-sync' && e.auto && e.ok) && dep(t, 'shop', 'shop')?.spec.replicas === 2 },
          { title: 'Release 2.2 through git (same steps as 2.1). It never becomes ready. Roll back the GitOps way; `argocd app rollback` refuses while auto-sync is on', hint: '`git revert --no-edit HEAD && git push`, then refresh. The cluster follows git.', solution: 'cd ~/gitops && sed -i "s/shop:2.1/shop:2.2/" apps/shop/deployment.yaml && git commit -am "shop: release 2.2" && git push && argocd app get shop --refresh; git revert --no-edit HEAD && git push && argocd app get shop --refresh', test: ['cd ~/gitops && sed -i "s/shop:2.1/shop:2.2/" apps/shop/deployment.yaml && git commit -am "shop: release 2.2" && git push', 'argocd app get shop --refresh', 'sleep 30; argocd app get shop', 'argocd app rollback shop 1', 'git revert --no-edit HEAD && git push', 'argocd app get shop --refresh', 'kubectl rollout status deploy/shop -n shop', 'sleep 5; argocd app get shop'], check: t => { const cs = commitsOf(t, 'lumen/gitops'); return /^Revert/.test(cs[0]?.message || '') && cs.some(c => gitopsDeployImg(t, c.hash) === SHOP('2.2')) && img(dep(t, 'shop', 'shop')) === SHOP('2.1') && depReady(t, 'shop', 'shop', 2) && appOk(t, 'shop'); } },
          { title: 'The ConfigMap `shop-legacy` is dead. Delete it from git (the file and its line in the kustomization), push, refresh, and let prune remove it from the cluster', solution: 'cd ~/gitops && git rm apps/shop/legacy-config.yaml && sed -i "/legacy-config/d" apps/shop/kustomization.yaml && git commit -am "shop: drop legacy config" && git push && argocd app get shop --refresh', test: ['cd ~/gitops && git rm apps/shop/legacy-config.yaml && sed -i "/legacy-config/d" apps/shop/kustomization.yaml && git commit -am "shop: drop legacy config" && git push', 'argocd app get shop --refresh', 'sleep 10; kubectl get configmaps -n shop'], check: t => !cl(t).get('ConfigMap', 'shop', 'shop-legacy') && remoteFile(t, 'lumen/gitops', 'apps/shop/legacy-config.yaml') === null && appOk(t, 'shop') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'In GitOps, what is the source of truth for what should run in production?', choices: ['The cluster', 'A git repository, changed through commits and pull requests', 'The CI server', 'The on-call engineer'], answer: 1, explain: 'The agent makes the cluster match git.' },
        { type: 'mc', q: 'Why is a pull-based agent (Argo CD) safer than CI running `kubectl apply` with an admin token?', choices: ['It is faster', 'No credentials for the production cluster live outside it; CI only needs to write to git', 'It needs no git', 'It skips code review'], answer: 1, explain: 'A leaked CI secret no longer means a compromised cluster.' },
        { type: 'mc', q: 'Self-heal is on. Someone runs `kubectl scale deploy shop --replicas=6`. What happens?', choices: ['6 replicas until the next commit', 'Argo CD sees drift (OutOfSync) and restores git\'s replica count', 'Argo CD updates git to 6', 'The deployment is deleted'], answer: 1, explain: 'To change it for good, change git.' },
        { type: 'mc', q: 'You pushed a commit a minute ago and Argo CD still shows the old revision. Most likely?', choices: ['The commit failed', 'Argo CD polls every 3 minutes; refresh or set up a webhook', 'Self-heal is off', 'The cluster is down'], answer: 1, explain: '`argocd app get APP --refresh`, or a webhook from the git host.' },
        { type: 'mc', q: 'With automated sync, how do you roll back a bad release?', choices: ['argocd app rollback', 'kubectl rollout undo', 'Revert the commit in git and push', 'Delete the application'], answer: 2, explain: 'Rollback commands fight the automation; git is the source of truth.' },
        { type: 'tf', q: 'Without prune, deleting a manifest from git leaves the object running in the cluster.', answer: true, explain: 'It shows as OutOfSync (requires pruning) until you prune.' },
        { type: 'mc', q: 'What does an ApplicationSet with a git directory generator on `apps/*` do?', choices: ['Deletes apps', 'Creates one Application per folder under apps/, so a new folder becomes a new deployed app', 'Merges all apps into one', 'Builds images'], answer: 1, explain: 'Adding a service becomes a pull request that adds a folder.' },
        { type: 'multi', q: 'Signs of a healthy GitOps setup:', choices: ['Production changes go through pull requests', 'Humans have read-only access to production for routine work', 'Secrets committed in plain text so Argo CD can read them', 'Drift shows up as OutOfSync'], answer: [0, 1, 3], explain: 'Use a secrets manager or SOPS for secrets.' },
      ],
    },
    {
      id: 'k8s-rbac',
      title: 'Who can do what: RBAC',
      summary: 'Users, groups and service accounts; Roles and ClusterRoles; bindings; built-in view/edit/admin; auth can-i, --as and --list; short-lived tokens and kubeconfig contexts; removing cluster-admin.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          H.cluster('lumen');
          H.k8s('lumen', [
            { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } },
            { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'payments' } },
            { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'ci' } },
            { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'deployer', namespace: 'ci' } },
            { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'ci-admin' }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ kind: 'ServiceAccount', name: 'deployer', namespace: 'ci' }] },
            { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'stripe-key', namespace: 'payments' }, stringData: { key: STRIPE } },
            { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'shop-db', namespace: 'shop' }, stringData: { password: 'shop-db-pw-7781' } },
          ], { settle: 2 });
          H.write('laptop', '~/shop.yaml', SHOP_YAML, { owner: 'dev' });
        },
        suggestions: ['kubectl auth whoami', 'kubectl get clusterrolebindings -o wide'],
        tasks: [
          { title: 'Audit: list who is bound to `cluster-admin`, then ask the API whether the CI service account `ci/deployer` can do everything, everywhere', hint: '`kubectl get clusterrolebindings -o wide`, then `kubectl auth can-i \'*\' \'*\' --as system:serviceaccount:ci:deployer`.', solution: "kubectl get clusterrolebindings -o wide && kubectl auth can-i '*' '*' --as system:serviceaccount:ci:deployer", check: t => kev(t, e => e.verb === 'get' && (e.kinds || []).includes('ClusterRoleBinding')).length > 0 && kev(t, e => e.verb === 'auth' && e.user === 'system:serviceaccount:ci:deployer').length > 0 },
          { title: 'Build a least-privilege deployer: service account `shop-deployer` in `shop`, a Role `deployer` allowing get, list, watch, create, update and patch on deployments, services and configmaps, and a RoleBinding that grants it', hint: '`kubectl create serviceaccount`, `kubectl create role deployer -n shop --verb=… --resource=deployments.apps,services,configmaps`, `kubectl create rolebinding … --role=deployer --serviceaccount=shop:shop-deployer`.', solution: 'kubectl create serviceaccount shop-deployer -n shop && kubectl create role deployer -n shop --verb=get,list,watch,create,update,patch --resource=deployments.apps,services,configmaps && kubectl create rolebinding shop-deployer -n shop --role=deployer --serviceaccount=shop:shop-deployer', check: t => !!cl(t).get('ServiceAccount', 'shop', 'shop-deployer') && can(t, SA_DEP, 'patch', 'deployments', 'apps', 'shop') && can(t, SA_DEP, 'create', 'services', '', 'shop') && !can(t, SA_DEP, 'get', 'secrets', '', 'shop') && !can(t, SA_DEP, 'delete', 'deployments', 'apps', 'shop') && !can(t, SA_DEP, 'patch', 'deployments', 'apps', 'payments') },
          { title: 'Check it before you trust it: list everything `shop-deployer` may do in `shop`, and confirm it cannot read the Stripe key in `payments`', solution: 'kubectl auth can-i --list -n shop --as system:serviceaccount:shop:shop-deployer && kubectl auth can-i get secrets -n payments --as system:serviceaccount:shop:shop-deployer', check: t => kev(t, e => e.verb === 'auth' && e.list && e.user === SA_DEP.user).length > 0 && kev(t, e => e.verb === 'auth' && e.user === SA_DEP.user && e.check?.resource === 'secrets' && e.ns === 'payments' && e.allowed === false).length > 0 },
          { title: 'Give CI its own identity: a kubeconfig context `shop-ci` (namespace `shop`) using a one-hour token for `shop-deployer`. Deploy `~/shop.yaml` with that context', hint: '`TOKEN=$(kubectl create token shop-deployer -n shop --duration=1h)`, `kubectl config set-credentials shop-deployer --token=$TOKEN`, `kubectl config set-context shop-ci --cluster=kind-lumen --user=shop-deployer --namespace=shop`, then `kubectl --context shop-ci apply -f shop.yaml`.', solution: 'TOKEN=$(kubectl create token shop-deployer -n shop --duration=1h) && kubectl config set-credentials shop-deployer --token=$TOKEN && kubectl config set-context shop-ci --cluster=kind-lumen --user=shop-deployer --namespace=shop && kubectl --context shop-ci apply -f shop.yaml', check: t => { const cfg = (() => { try { return parseYaml(t.file('laptop', '~/.kube/config') || ''); } catch { return null; } })(); const ctx = cfg?.contexts?.find(x => x.name === 'shop-ci'); const u = cfg?.users?.find(x => x.name === ctx?.context?.user); return !!ctx && cl(t).saTokens.get(u?.user?.token)?.user === SA_DEP.user && !!dep(t, 'shop', 'shop') && t.ran(/--context[ =]shop-ci\b.*apply|apply.*--context[ =]shop-ci/); } },
          { title: 'Still as `shop-ci`, try to read the secrets in `shop` and to delete the namespace `payments`. Read the errors: who, what verb, which resource?', solution: 'kubectl --context shop-ci get secrets; kubectl --context shop-ci delete namespace payments', check: t => kev(t, e => e.forbidden && e.user === SA_DEP.user && e.verb === 'get').length > 0 && kev(t, e => e.forbidden && e.user === SA_DEP.user && e.verb === 'delete').length > 0 && !!cl(t).get('Namespace', null, 'payments') },
          { title: 'Close the hole: delete the `ci-admin` ClusterRoleBinding, and give Samir (user `samir`) read-only access to `shop` with the built-in `view` ClusterRole', hint: 'A RoleBinding can grant a ClusterRole within one namespace: `kubectl create rolebinding samir-view -n shop --clusterrole=view --user=samir`.', solution: 'kubectl delete clusterrolebinding ci-admin && kubectl create rolebinding samir-view -n shop --clusterrole=view --user=samir && kubectl auth can-i list pods -n shop --as samir', check: t => !cl(t).get('ClusterRoleBinding', null, 'ci-admin') && !can(t, saIdentity('ci', 'deployer'), 'get', 'secrets', '', 'payments') && can(t, SAMIR, 'list', 'pods', '', 'shop') && !can(t, SAMIR, 'delete', 'deployments', 'apps', 'shop') && !can(t, SAMIR, 'get', 'secrets', '', 'shop') && !can(t, SAMIR, 'list', 'pods', '', 'payments') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does a RoleBinding do?', choices: ['Defines which verbs are allowed', 'Grants a Role (or ClusterRole) to users, groups or service accounts within one namespace', 'Creates a user', 'Encrypts Secrets'], answer: 1, explain: 'The Role is the list of permissions; the binding hands it out.' },
        { type: 'tf', q: 'RBAC has explicit deny rules that override allows.', answer: false, explain: 'It is additive and deny-by-default: only grants exist.' },
        { type: 'mc', q: 'A rule has `apiGroups: [""]` and `resources: ["deployments"]`. Why does it not allow `kubectl get deployments`?', choices: ['Deployments live in the apps API group', 'Rules need resourceNames', 'get is not a verb', 'It does allow it'], answer: 0, explain: 'The error message names the API group it wanted.' },
        { type: 'mc', q: 'Which command answers "can the CI account delete pods in shop?" without trying it?', choices: ['kubectl get pods --as ci', 'kubectl auth can-i delete pods -n shop --as system:serviceaccount:ci:deployer', 'kubectl describe sa deployer', 'kubectl delete pods --dry-run'], answer: 1, explain: '--list shows everything it can do.' },
        { type: 'mc', q: 'Why is the built-in `view` role safe to give widely while `edit` is not?', choices: ['view cannot read Secrets or exec into pods; edit can change workloads and read Secrets', 'view is cluster-wide', 'edit is deprecated', 'There is no difference'], answer: 0, explain: 'Listing Secrets returns their values.' },
        { type: 'multi', q: 'Good access practice:', choices: ['One service account per workload or pipeline', 'Bind groups from SSO, not individual users', 'cluster-admin for CI so deploys never fail', 'Short-lived tokens'], answer: [0, 1, 3], explain: 'Grant what the error asks for, not everything.' },
        { type: 'type', q: 'Type the command that creates a RoleBinding `samir-view` in namespace `shop` granting the ClusterRole `view` to user `samir`.', accept: ['kubectl create rolebinding samir-view -n shop --clusterrole=view --user=samir', 'kubectl create rolebinding samir-view --clusterrole=view --user=samir -n shop', 'kubectl create rolebinding samir-view --namespace shop --clusterrole=view --user=samir', 'kubectl create rolebinding samir-view --clusterrole=view --user=samir --namespace=shop', 'kubectl -n shop create rolebinding samir-view --clusterrole=view --user=samir'], model: 'kubectl create rolebinding samir-view -n shop --clusterrole=view --user=samir', explain: 'A RoleBinding scopes a ClusterRole to one namespace.' },
      ],
    },

    {
      id: 'network-policies',
      title: 'Network policies',
      summary: 'Flat pod networks, default deny, ingress rules by pod and namespace labels, pod ports versus service ports, AND versus OR peers, egress, testing the matrix.',
      minutes: 30,
      lab: {
        cwd: '~/netpol',
        panels: ['cluster', 'files'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          H.k8s('lumen', [
            { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } },
            nginxDep('web', 'shop'), svc('web', 'shop', 80, 80),
            echo('api', 'api ok: 12 orders today'), svc('api', 'shop', 80, 'http'),
            nginxDep('reports', 'shop'),
            { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'web', namespace: 'shop' }, spec: { ingressClassName: 'nginx', rules: [{ host: 'shop.lumen.dev', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } },
            { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'tools' } },
            nginxDep('debug', 'tools'),
          ], { settle: 40 });
          H.dns('shop.lumen.dev', c.ingressHost.ip);
          H.mkdir('laptop', '/home/dev/netpol', { owner: 'dev' });
        },
        suggestions: ['kubectl get pods -n shop --show-labels', 'kubectl exec -n shop deploy/web -- curl -s -m 2 http://api'],
        tasks: [
          { title: 'Map today\'s traffic: curl the `api` service from `web`, from `reports`, and from `tools/debug` (as `api.shop`). All three work. Should they?', hint: '`kubectl exec -n shop deploy/web -- curl -s -m 2 http://api`, and the same from deploy/reports; from the tools namespace use `http://api.shop`.', solution: 'kubectl exec -n shop deploy/web -- curl -s -m 2 http://api; kubectl exec -n shop deploy/reports -- curl -s -m 2 http://api; kubectl exec -n tools deploy/debug -- curl -s -m 2 http://api.shop', check: t => ['web', 'reports'].every(n => kev(t, e => e.verb === 'exec' && e.ns === 'shop' && e.pod?.startsWith(n + '-') && /curl/.test(e.cmd)).length > 0) && kev(t, e => e.verb === 'exec' && e.ns === 'tools' && /curl/.test(e.cmd)).length > 0 },
          { title: 'Write `default-deny.yaml`: a policy that selects every pod in `shop` and allows no ingress. Apply it and load http://shop.lumen.dev. What happened?', hint: '`podSelector: {}` and `policyTypes: [Ingress]`, with no ingress rules.', solution: 'nano default-deny.yaml && kubectl apply -f default-deny.yaml && curl -s -m 3 http://shop.lumen.dev', test: [W('default-deny.yaml', NP_DENY), 'kubectl apply -f default-deny.yaml', 'curl -s -m 3 http://shop.lumen.dev'], check: t => !!denyAll(t) && t.ran(/curl\b.*shop\.lumen\.dev/) && !site(t, 'shop.lumen.dev') },
          { title: 'Bring the site back: allow the ingress controller\'s namespace (`ingress-nginx`) to reach `web` on port 80, and nothing else', hint: 'A policy selecting `app: web` with an ingress rule `from: - namespaceSelector: matchLabels: kubernetes.io/metadata.name: ingress-nginx` and `ports: - port: 80`.', solution: 'nano web-from-ingress.yaml && kubectl apply -f web-from-ingress.yaml && curl -s http://shop.lumen.dev', test: [W('web-from-ingress.yaml', NP_WEB), 'kubectl apply -f web-from-ingress.yaml', 'curl -s http://shop.lumen.dev'], check: t => !!denyAll(t) && site(t, 'shop.lumen.dev', 'nginx') },
          { title: 'Allow only `web` to call `api`, on the api pod\'s named port `http`. Check from web that it still works', detail: 'The Service listens on 80, but the pod listens on 5678 (named `http`). Policies match pod ports.', hint: 'Select `app: api`; ingress `from: - podSelector: matchLabels: app: web`, `ports: - port: http`.', solution: 'nano api-from-web.yaml && kubectl apply -f api-from-web.yaml && kubectl exec -n shop deploy/web -- curl -s -m 2 http://api', test: [W('api-from-web.yaml', NP_API), 'kubectl apply -f api-from-web.yaml', 'kubectl exec -n shop deploy/web -- curl -s -m 2 http://api'], check: t => /api ok/.test(curlFrom(t, 'shop', 'web', 'http://api')?.out || '') && !/api ok/.test(curlFrom(t, 'shop', 'reports', 'http://api')?.out || '') && !/api ok/.test(curlFrom(t, 'tools', 'debug', 'http://api.shop')?.out || '') && !!denyAll(t) },
          { title: 'Prove the matrix: rerun the curls from `reports` and `tools/debug` (they time out, rather than being refused) and read `kubectl describe netpol` for the api policy', solution: 'kubectl exec -n shop deploy/reports -- curl -s -m 2 http://api; kubectl exec -n tools deploy/debug -- curl -s -m 2 http://api.shop; kubectl describe netpol -n shop', check: t => kev(t, e => e.verb === 'describe' && (e.kinds || []).includes('NetworkPolicy')).length > 0 && t.after(e => e.type === 'k8s-apply' && e.kind === 'NetworkPolicy' && e.ns === 'shop', e => e.type === 'kubectl' && e.verb === 'exec' && (e.ns === 'tools' || e.pod?.startsWith('reports-'))) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'By default, with no NetworkPolicies, which pods can connect to a pod in namespace shop?', choices: ['Only pods in shop', 'Every pod in the cluster, in every namespace', 'None', 'Only the ingress controller'], answer: 1, explain: 'The pod network is flat until policies say otherwise.' },
        { type: 'mc', q: 'A policy selects pods with `app: api` and allows ingress from `app: web`. A pod `app: reports` in the same namespace connects to the api. What happens?', choices: ['It works: reports is in the same namespace', 'It is dropped (and times out): once selected, the api only accepts what a policy allows', 'It is refused with RST', 'It works on port 80 only'], answer: 1, explain: 'Selection turns on deny-by-default for that direction.' },
        { type: 'mc', q: 'The api Service maps port 80 to the pod\'s port 5678 (named http). Which port must the policy allow?', choices: ['80', '5678 (or the name http)', 'Both', 'Policies ignore ports'], answer: 1, explain: 'Policies see pod ports, after the Service.' },
        { type: 'predict', q: 'What does this `from` allow?', code: 'from:\n  - namespaceSelector:\n      matchLabels: { team: shop }\n    podSelector:\n      matchLabels: { app: web }', choices: ['Any pod in namespaces labelled team=shop, or any web pod anywhere', 'Only web pods in namespaces labelled team=shop', 'Nothing', 'Everything'], answer: 1, explain: 'One list item with both selectors = AND. Two items would be OR.' },
        { type: 'tf', q: 'NetworkPolicies work on every cluster, whatever network plugin it uses.', answer: false, explain: 'The CNI must enforce them (Calico, Cilium…). Test it.' },
        { type: 'multi', q: 'Sensible network policy practice:', choices: ['Default deny in every application namespace', 'Allow the ingress controller explicitly', 'Name policies after the flow they allow', 'Allow all egress to 0.0.0.0/0 for simplicity'], answer: [0, 1, 2], explain: 'Restricting egress stops exfiltration; allow DNS when you do.' },
        { type: 'mc', q: 'Why does a blocked connection time out instead of failing immediately?', choices: ['The pod is slow', 'Denied packets are dropped silently, so the client waits for a reply that never comes', 'DNS fails', 'The Service is missing'], answer: 1, explain: 'A timeout is a typical sign of a policy (or firewall) drop.' },
      ],
    },
    {
      id: 'policy-as-code',
      title: 'Policy as code with Kyverno',
      summary: 'Admission control, ClusterPolicies with validate patterns, autogen for controllers, Audit and PolicyReports, Enforce, the kyverno CLI in CI.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['cluster', 'github'],
        setup(H) {
          H.cluster('lumen');
          H.install('laptop', 'helm', 'kyverno');
          H.write('laptop', '~/policies/require-limits.yaml', P_LIMITS('Audit'), { owner: 'dev' });
          H.write('laptop', '~/policies/disallow-latest.yaml', P_LATEST('Audit'), { owner: 'dev' });
          const k8s = { 'shop.yaml': PK('shop', 'nginx:1.27', false), 'menu.yaml': PK('menu', 'nginx:latest', true), 'reports.yaml': PK('reports', 'nginx:1.27-alpine', true) };
          for (const [f, txt] of Object.entries(k8s)) H.write('laptop', `~/k8s/${f}`, txt, { owner: 'dev' });
          H.k8s('lumen', Object.values(k8s).map(x => parseYaml(x)), { settle: 20 });
          H.remote('lumen', 'shop-deploy', [{ message: 'Deployment manifests and policies', files: { 'README.md': '# shop-deploy\n\nManifests for the shop, and the policies they must pass.\n', 'policies/require-limits.yaml': P_LIMITS('Enforce'), 'policies/disallow-latest.yaml': P_LATEST('Enforce'), 'k8s/shop.yaml': PK('shop', 'nginx:1.27', true) } }], { collaborators: ['you'] });
          H.run('git clone -q https://github.com/lumen/shop-deploy.git', { on: 'laptop', user: 'dev' });
        },
        suggestions: ['helm repo add kyverno https://kyverno.github.io/kyverno', 'cat policies/require-limits.yaml'],
        tasks: [
          { title: 'Install Kyverno with Helm: chart `kyverno/kyverno` from https://kyverno.github.io/kyverno, release `kyverno` in namespace `kyverno`', solution: 'helm repo add kyverno https://kyverno.github.io/kyverno && helm install kyverno kyverno/kyverno -n kyverno --create-namespace', check: t => !!cl(t)?.kyverno },
          { title: 'Before touching the cluster, test the manifests in `~/k8s` against `~/policies` with the kyverno CLI. Which resources fail, and why?', solution: 'kyverno apply policies/ --resource k8s/', check: t => t.events('kyverno-cli').some(e => /k8s/.test(e.args) && e.fail > 0) },
          { title: 'Apply the policies (Audit mode) and, after the background scan, read the PolicyReport for the `default` namespace', hint: 'Reports appear within about 30 seconds: `kubectl get policyreport`, then `kubectl get policyreport -o yaml` for details.', solution: 'kubectl apply -f policies/ && sleep 35 && kubectl get policyreport', check: t => !!cl(t).get('ClusterPolicy', null, 'require-limits') && !!cl(t).get('ClusterPolicy', null, 'disallow-latest-tag') && kev(t, e => e.verb === 'get' && /polr|policyreport/i.test(e.args)).length > 0 },
          { title: 'Fix the manifests in `~/k8s` until `kyverno apply` passes, then apply them to the cluster', hint: 'Add `resources.limits` (cpu and memory) to the shop, and pin menu to `nginx:1.27`.', solution: 'nano k8s/shop.yaml k8s/menu.yaml && kyverno apply policies/ --resource k8s/ && kubectl apply -f k8s/', test: [W('k8s/shop.yaml', PK('shop', 'nginx:1.27', true)), W('k8s/menu.yaml', PK('menu', 'nginx:1.27', true)), 'kyverno apply policies/ --resource k8s/', 'kubectl apply -f k8s/', 'kubectl rollout status deploy/shop && kubectl rollout status deploy/menu'], check: t => { const last = t.events('kyverno-cli').filter(e => /k8s/.test(e.args)).slice(-1)[0]; return !!last && last.fail === 0 && liveFails(t, 'default') === 0; } },
          { title: 'Switch both policies to `Enforce` and apply them. Then try a quick `kubectl run debug --image=busybox:latest`. What stops it?', solution: 'sed -i "s/validationFailureAction: Audit/validationFailureAction: Enforce/" policies/*.yaml && kubectl apply -f policies/ && kubectl run debug --image=busybox:latest', check: t => ['require-limits', 'disallow-latest-tag'].every(n => String(cl(t).get('ClusterPolicy', null, n)?.spec?.validationFailureAction).toLowerCase() === 'enforce') && t.events('kyverno-deny').length > 0 },
          { title: 'Shift left: in `~/shop-deploy`, add a workflow that runs `kyverno apply policies/ --resource k8s/` on pull requests, and push it to main. Then open a pull request that adds a `busybox:latest` Deployment: its check must fail', hint: 'Steps: `actions/checkout@v4`, `kyverno/action-install-cli@v0.2.0`, then `run: kyverno apply policies/ --resource k8s/`.', solution: 'cd ~/shop-deploy && mkdir -p .github/workflows && nano .github/workflows/policy.yml && git add . && git commit -m "ci: policy check" && git push', test: ['cd ~/shop-deploy && mkdir -p .github/workflows', W('.github/workflows/policy.yml', P_WF), 'git add .github && git commit -m "ci: check manifests against policies" && git push', 'git switch -c debug-pod', W('k8s/debug.yaml', PK('debug', 'busybox:latest', true)), 'git add k8s/debug.yaml && git commit -m "Add a debug deployment" && git push -u origin debug-pod && gh pr create --fill'], check: t => /kyverno apply/.test(workflowsOn(t, 'lumen/shop-deploy')) && (t.remote('lumen/shop-deploy')?.meta.runs || []).some(r => r.event === 'pull_request' && r.conclusion === 'failure') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Where does Kyverno enforce policies inside the cluster?', choices: ['In the kubelet', 'As an admission webhook: every create/update request passes through it before being stored', 'In etcd', 'In the CNI'], answer: 1, explain: 'The API server asks it before accepting an object.' },
        { type: 'mc', q: 'What is the difference between Audit and Enforce?', choices: ['None', 'Audit lets the request through and records the result in a PolicyReport; Enforce denies it', 'Audit only runs in CI', 'Enforce only reports'], answer: 1, explain: 'Roll out in Audit, fix, then Enforce.' },
        { type: 'mc', q: 'A rule matches kind Pod. Why does it also block a Deployment whose pods would break it?', choices: ['It does not', 'Kyverno autogen applies Pod rules to the pod templates of Deployments, StatefulSets, Jobs…', 'Deployments are Pods', 'The scheduler checks it'], answer: 1, explain: 'Failing at the Deployment is better than a ReplicaSet that silently cannot create pods.' },
        { type: 'predict', q: 'Does this pattern accept `image: nginx`?', code: 'image: "*:* & !*:latest"', choices: ['Yes', 'No: there is no tag', 'Only on Sundays', 'Only in Audit mode'], answer: 1, explain: 'No tag means :latest in practice; the pattern requires an explicit, non-latest tag.' },
        { type: 'mc', q: 'Why run `kyverno apply` in CI as well as in the cluster?', choices: ['The cluster cannot run it', 'Feedback on the pull request before merge, with the same policy files', 'CI is more secure', 'It replaces admission control'], answer: 1, explain: 'Admission is the safety net; CI is the fast feedback.' },
        { type: 'tf', q: 'Switching a new policy straight to Enforce in production is the safest rollout.', answer: false, explain: 'It can block deploys and rollbacks; audit first.' },
        { type: 'multi', q: 'Good policy-as-code practice:', choices: ['Policies in git, reviewed like code', 'Messages that say how to fix the problem', 'Exceptions that are explicit and expire', 'Excluding all namespaces when a team complains'], answer: [0, 1, 2], explain: 'Exclusions need review too.' },
      ],
    },
    {
      id: 'secrets-managers',
      title: 'Secrets in git and in Vault',
      summary: 'SOPS and age for encrypted files in git; Vault KV v2, policies and Kubernetes auth; External Secrets SecretStore and ExternalSecret; rotation and restarting pods; least privilege.',
      minutes: 40,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          H.cluster('lumen');
          H.install('laptop', 'sops', 'age');
          const v = H.vault({ rootToken: ROOT() });
          v.kv.secret.set('payments/stripe', { versions: [{ data: { key: STRIPE }, created: H.uni.time - 86400 * 30 }], current: 1, created: H.uni.time - 86400 * 30, updated: H.uni.time - 86400 * 30 });
          H.write('laptop', '~/vault-admin-token', ROOT() + '\n', { owner: 'dev', mode: 0o600 });
          H.eso('lumen');
          H.publishImage(SHOP('2.0'), nodeApp('shop', { env: ['DB_PASSWORD'], routes: [['/', "res.send('Lumen shop 2.0')"]] }));
          H.k8s('lumen', [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } }, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'shop', namespace: 'shop' } }, SHOP_SECRET_DEP], { settle: 10 });
          H.remote('lumen', 'shop-config', [{ message: 'Shop config', files: { 'README.md': '# shop-config\n\nConfiguration for the shop. Secrets go in secrets/ (encrypted!).\n', 'app.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shop-config\ndata:\n  LOG_LEVEL: info\n', 'secrets/db.yaml': `apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-db\nstringData:\n  username: shop\n  password: ${OLD_PW}\n`, 'k8s/vault-secrets.yaml': ESO_YAML('shop-app') } }], { collaborators: ['you'] });
        },
        suggestions: ['git clone https://github.com/lumen/shop-config.git', 'kubectl get pods -n shop'],
        tasks: [
          { title: 'Encrypt the config repo\'s secret for git: clone `lumen/shop-config`, make an age key in `~/.config/sops/age/keys.txt`, add a `.sops.yaml` rule (encrypt `data`/`stringData` of `secrets/*.yaml` for your public key), encrypt `secrets/db.yaml` in place, check `sops -d` still reads it, then commit and push', hint: '`age-keygen -o ~/.config/sops/age/keys.txt`; `age-keygen -y FILE` prints the public key; `sops --encrypt --in-place secrets/db.yaml`.', solution: `git clone https://github.com/lumen/shop-config.git && cd shop-config && mkdir -p ~/.config/sops/age && age-keygen -o ~/.config/sops/age/keys.txt && ${SOPS_RULE} && sops --encrypt --in-place secrets/db.yaml && sops -d secrets/db.yaml && git add .sops.yaml secrets/db.yaml && git commit -m "Encrypt secrets with SOPS" && git push`, check: t => { const f = remoteFile(t, 'lumen/shop-config', 'secrets/db.yaml') || ''; return /ENC\[AES256_GCM/.test(f) && /\nsops:/.test(f) && !f.includes(OLD_PW) && !!t.file('laptop', '~/.config/sops/age/keys.txt') && t.events('sops').some(e => e.mode === 'decrypt' && e.ok); } },
          { title: 'That password sat in git history in plain text, so treat it as leaked. Put a **new** password into Vault at `secret/shop/db` (key `password`), logged in with the admin token in `~/vault-admin-token`', hint: '`export VAULT_ADDR=http://vault.lumen.internal:8200`, `vault login $(cat ~/vault-admin-token)`, `vault kv put secret/shop/db password=…`.', solution: 'export VAULT_ADDR=http://vault.lumen.internal:8200 && vault login $(cat ~/vault-admin-token) && vault kv put secret/shop/db password=N3w-shop-db-2026', check: t => { const d = kvNow(t, 'shop/db'); return !!d?.password && d.password !== OLD_PW && d.password.length >= 8; } },
          { title: 'Least privilege for the shop: a Vault policy `shop-read` (read on `secret/data/shop/*`), the Kubernetes auth method, and a role `shop` for service account `shop` in namespace `shop` with that policy', hint: 'Write the policy to a file (`path "secret/data/shop/*" { capabilities = ["read"] }`), `vault policy write shop-read FILE`, `vault auth enable kubernetes`, `vault write auth/kubernetes/role/shop bound_service_account_names=shop bound_service_account_namespaces=shop policies=shop-read ttl=1h`.', solution: "printf 'path \"secret/data/shop/*\" {\\n  capabilities = [\"read\"]\\n}\\n' > shop-read.hcl && vault policy write shop-read shop-read.hcl && vault auth enable kubernetes && vault write auth/kubernetes/role/shop bound_service_account_names=shop bound_service_account_namespaces=shop policies=shop-read ttl=1h", check: t => { const v = vaultOf(t); const p = v?.policies.get('shop-read'); const r = v?.auth.kubernetes?.roles.get('shop'); return !!p && p.rules.some(x => x.path === 'secret/data/shop/*' && x.caps.includes('read')) && !p.rules.some(x => x.path === '*' || x.path === 'secret/*' || x.path === 'secret/data/*') && !!r && r.bound_service_account_names.includes('shop') && r.bound_service_account_namespaces.includes('shop') && r.policies.includes('shop-read'); } },
          { title: 'Apply `k8s/vault-secrets.yaml` from the config repo (a SecretStore and an ExternalSecret). The ExternalSecret does not become ready: find out why with `kubectl describe`, fix the file, and apply again. The shop pods start once `shop-db` exists', hint: 'Look at the role the SecretStore logs in with.', solution: 'kubectl apply -f k8s/vault-secrets.yaml && sleep 5 && kubectl describe externalsecret shop-db -n shop', test: ['cd ~/shop-config && kubectl apply -f k8s/vault-secrets.yaml', 'sleep 5; kubectl describe externalsecret shop-db -n shop', 'sed -i "s/role: shop-app/role: shop/" k8s/vault-secrets.yaml && kubectl apply -f k8s/vault-secrets.yaml', 'kubectl annotate externalsecret shop-db -n shop force-sync=now --overwrite && sleep 15 && kubectl get externalsecret,pods -n shop', 'kubectl rollout status deploy/shop -n shop'], check: t => esReady(t, 'shop', 'shop-db') && secretVal(t, 'shop', 'shop-db', 'password') === kvNow(t, 'shop/db')?.password && depReady(t, 'shop', 'shop', 2) && kev(t, e => e.verb === 'describe' && (e.kinds || []).includes('ExternalSecret')).length > 0 },
          { title: 'Rotate: write a new password to Vault, wait for the ExternalSecret\'s refresh (one minute), then restart the deployment so the running pods use it', detail: 'Environment variables are read when a container starts; an updated Secret does not change a running pod.', solution: 'vault kv put secret/shop/db password=R0tated-shop-db-2026 && sleep 70 && kubectl rollout restart deploy/shop -n shop && kubectl rollout status deploy/shop -n shop', check: t => { const w = t.events('vault-write').filter(e => e.path === 'secret/shop/db').slice(-1)[0]; const c = cl(t); const pods = t.kready('lumen', 'shop', 'app=shop'); return !!w && w.version >= 2 && secretVal(t, 'shop', 'shop-db', 'password') === kvNow(t, 'shop/db')?.password && pods.length === 2 && pods.every(p => p.metadata.creationTimestamp > w.time && c.podReady(p)) && depReady(t, 'shop', 'shop', 2); } },
          { title: 'Prove the boundary: create a token with only the `shop-read` policy, and use it to try to read `secret/payments/stripe`', solution: 'VAULT_TOKEN=$(vault token create -policy=shop-read -field=token) vault kv get secret/payments/stripe', check: t => t.events('vault').some(e => e.denied && /payments/.test(e.path || '')) },
        ],
      },
      quiz: [
        { type: 'tf', q: 'A Kubernetes Secret manifest committed to git is safe because its values are base64-encoded.', answer: false, explain: 'base64 is an encoding, not encryption.' },
        { type: 'mc', q: 'What does SOPS encrypt in a YAML file?', choices: ['The whole file, as one blob', 'The values (or the keys matched by encrypted_regex), leaving keys and structure readable for review', 'Only comments', 'Nothing: it signs it'], answer: 1, explain: 'Diffs stay meaningful; values stay secret.' },
        { type: 'mc', q: 'How does the External Secrets Operator authenticate to Vault with Kubernetes auth?', choices: ['With the root token', 'As a service account; a Vault role trusts that account and namespace and grants its policies', 'With a password in a ConfigMap', 'It does not authenticate'], answer: 1, explain: 'No static Vault token in the cluster.' },
        { type: 'mc', q: 'You rotated a password in Vault and the Secret updated. The app still uses the old password. Why?', choices: ['ESO failed', 'Pods read environment variables at start; restart (roll) the deployment', 'Vault caches it', 'Kubernetes Secrets cannot change'], answer: 1, explain: 'Or mount it as a file, or use a reloader.' },
        { type: 'mc', q: 'Which Vault policy fits the shop?', choices: ['path "*" { capabilities = ["read"] }', 'path "secret/data/shop/*" { capabilities = ["read"] }', 'path "secret/*" { capabilities = ["sudo"] }', 'No policy, the root token'], answer: 1, explain: 'Only its own paths, read-only.' },
        { type: 'mc', q: 'A secret was committed to git in plain text last year. You now encrypt the file with SOPS. Is the secret safe?', choices: ['Yes', 'No: it is in history and every clone; rotate it', 'Only if the repo is private', 'Yes, if you force-push'], answer: 1, explain: 'Rotate first, then clean up.' },
        { type: 'multi', q: 'Good secrets practice:', choices: ['One source of truth per secret', 'Workload identity instead of shared tokens', 'Audit logs on secret reads', 'Copying secrets into CI variables for convenience'], answer: [0, 1, 2], explain: 'Every copy is another place to rotate and leak.' },
        { type: 'type', q: 'Type the command that stores `password=s3cret` at `secret/shop/db` in Vault\'s KV store.', accept: ['vault kv put secret/shop/db password=s3cret', 'vault kv put -mount=secret shop/db password=s3cret'], model: 'vault kv put secret/shop/db password=s3cret', explain: 'KV v2 keeps every version; `vault kv get` reads the latest.' },
      ],
    },
    {
      id: 'golden-paths',
      title: 'Golden paths and DORA metrics',
      summary: 'Platform engineering as a product, golden-path templates, service catalog and scorecards, ApplicationSets for self-service deploys, the four DORA metrics and how to use them.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['cluster', 'github'],
        setup(H) { platformWorld(H); },
        suggestions: ['lumen help', 'lumen templates'],
        tasks: [
          { title: 'See what the platform offers: list the golden paths, and the service catalog with each service\'s score', solution: 'lumen templates && lumen catalog', check: t => t.events('lumen').some(e => e.cmd === 'templates') && t.events('lumen').some(e => e.cmd === 'catalog') },
          { title: 'Create the `receipts` service on the `node-api` golden path, owned by `team-payments`', solution: 'lumen create receipts --template node-api --owner team-payments --description "Receipts for every order"', check: t => t.events('lumen').some(e => e.cmd === 'create' && e.name === 'receipts' && e.owner === 'team-payments') },
          { title: 'Review the GitOps pull request it opened (clone `lumen/gitops`, read the diff) and merge it. The ApplicationSet deploys receipts: wait until it is Synced and Healthy', solution: 'git clone https://github.com/lumen/gitops.git && cd gitops && gh pr list && gh pr diff 1 && gh pr merge 1 --squash', test: ['git clone https://github.com/lumen/gitops.git', 'cd gitops && gh pr list && gh pr diff 1', 'gh pr merge 1 --squash', 'sleep 40; kubectl get applications -n argocd'], check: t => appOk(t, 'receipts') && readyN(t, 'receipts', 'app=receipts') === 2 && t.ran(/gh pr (diff|view)/) },
          { title: '`billing` predates the platform. Bring its scorecard to 6/6: an owner (`team-billing`) and a runbook annotation in its catalog entry, CI on pull requests, and probes, limits and a NetworkPolicy in `apps/billing` of the gitops repo', hint: '`lumen scorecard billing` lists each failing check and the fix. The runbook annotation is `lumen.dev/runbook: https://runbooks.lumen.dev/billing`. Remember to list new files in `apps/billing/kustomization.yaml`.', solution: 'lumen scorecard billing', test: ['lumen scorecard billing', 'cd ~ && git clone https://github.com/lumen/billing.git && cd billing', W('catalog-info.yaml', BILLING_CAT.replace('  name: billing\n', '  name: billing\n  annotations:\n    lumen.dev/runbook: https://runbooks.lumen.dev/billing\n') + '  owner: team-billing\n'), W('.github/workflows/build.yml', 'name: build\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo build\n'), 'git commit -am "Owner, runbook and PR checks" && git push', 'cd ~/gitops && git pull -q', W('apps/billing/deployment.yaml', BILLING_DEP(true)), W('apps/billing/networkpolicy.yaml', BILLING_NP), W('apps/billing/kustomization.yaml', 'resources:\n  - deployment.yaml\n  - networkpolicy.yaml\n'), 'git add apps/billing && git commit -m "billing: probes, limits, network policy" && git push', 'sleep 20; lumen scorecard billing'], check: t => scorecard(t.uni, 'billing').every(x => x.ok) && appOk(t, 'billing') },
          { title: 'Compare how two teams deliver: DORA metrics for `shop`, and for `billing` with `--details`. What would you change first for billing?', solution: 'lumen dora shop && lumen dora billing --details', check: t => t.events('lumen').some(e => e.cmd === 'dora' && e.name === 'shop') && t.events('lumen').some(e => e.cmd === 'dora' && e.name === 'billing' && e.details) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What is a golden path?', choices: ['A mandatory process enforced by the platform team', 'A supported, self-service way to do a common task that is secure and observable by default', 'A Kubernetes namespace', 'A git branch for releases'], answer: 1, explain: 'Optional but attractive: the easy way is the right way.' },
        { type: 'order', q: 'Order the four DORA metrics as speed first, then stability.', items: ['Deployment frequency', 'Lead time for changes', 'Change failure rate', 'Time to restore service'], explain: 'Two throughput metrics, two stability metrics.' },
        { type: 'mc', q: 'Billing deploys once a month, waits 9 days from commit to production, and 1 in 4 deploys fails. What usually helps most?', choices: ['Deploying less often', 'Smaller, more frequent changes through an automated pipeline, so each is easier to check and undo', 'More manual approval steps', 'Blaming the team'], answer: 1, explain: 'Speed and stability improve together with small batches.' },
        { type: 'tf', q: 'DORA metrics are best used to rank teams against each other.', answer: false, explain: 'Use them to learn and improve; targets get gamed.' },
        { type: 'mc', q: 'What does a service scorecard do?', choices: ['Bills teams for cluster usage', 'Checks each service against the platform standards (owner, CI, probes, limits…) and shows what to fix', 'Counts lines of code', 'Replaces code review'], answer: 1, explain: 'It lets legacy services catch up without meetings.' },
        { type: 'mc', q: 'Why does an ApplicationSet with a directory generator make onboarding self-service?', choices: ['It creates clusters', 'A new folder in the GitOps repo becomes a deployed application after a normal pull request', 'It builds images', 'It skips review'], answer: 1, explain: 'No ticket, still reviewed.' },
        { type: 'multi', q: 'Signs of a platform run as a product:', choices: ['It measures developers\' pain (time to first deploy, tickets)', 'It starts with the most common journey', 'Every request still goes through a ticket queue', 'Teams can step off the path if they meet the same standards'], answer: [0, 1, 3], explain: 'A portal in front of a ticket queue is not self-service.' },
      ],
    },
    {
      id: 'platform-boss',
      title: 'Boss: launch loyalty',
      summary: 'Launch a new service end to end on the platform: golden path and GitOps, Vault and External Secrets, ingress and network policy, read-only RBAC for the team, enforced Kyverno policies, a 6/6 scorecard.',
      minutes: 50,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['cluster', 'github'],
        setup(H) {
          const c = platformWorld(H, { kyverno: true, boss: true });
          H.eso('lumen');
          const v = H.vault({ rootToken: ROOT() });
          v.auth.kubernetes = { roles: new Map([['shop', { bound_service_account_names: ['shop'], bound_service_account_namespaces: ['shop'], policies: ['shop-read'], ttl: '1h' }]]), config: { kubernetes_host: 'https://10.96.0.1:443' } };
          H.write('laptop', '~/vault-admin-token', ROOT() + '\n', { owner: 'dev', mode: 0o600 });
          H.dns('loyalty.lumen.dev', c.ingressHost.ip);
          H.k8s('lumen', [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'tools' } }, { ...parseYaml(PK('debug', 'nginx:1.27', true)), metadata: { name: 'debug', namespace: 'tools', labels: { 'lumen.dev/team': 'platform' } } }], { settle: 20 });
        },
        suggestions: ['lumen templates', 'kubectl get clusterpolicy'],
        tasks: [
          { title: 'Create `loyalty` on the `node-api` golden path for `team-growth`, merge its GitOps pull request, and wait until Argo CD reports it Synced and Healthy', solution: 'lumen create loyalty --template node-api --owner team-growth && git clone https://github.com/lumen/gitops.git && cd gitops && gh pr merge 1 --squash', test: ['lumen create loyalty --template node-api --owner team-growth --description "Loyalty points"', 'git clone https://github.com/lumen/gitops.git && cd gitops && gh pr diff 1 >/dev/null && gh pr merge 1 --squash', 'sleep 40; kubectl get applications -n argocd'], check: t => appOk(t, 'loyalty') && depReady(t, 'loyalty', 'loyalty', 2) },
          { title: 'In Vault (admin token in `~/vault-admin-token`): store the database password at `secret/loyalty/db`, write a `loyalty-read` policy for `secret/data/loyalty/*`, and a Kubernetes auth role `loyalty` for service account `loyalty` in namespace `loyalty`', solution: "export VAULT_ADDR=http://vault.lumen.internal:8200 && vault login $(cat ~/vault-admin-token) && vault kv put secret/loyalty/db password=Loy-db-2026-x && printf 'path \"secret/data/loyalty/*\" {\\n  capabilities = [\"read\"]\\n}\\n' | vault policy write loyalty-read - && vault write auth/kubernetes/role/loyalty bound_service_account_names=loyalty bound_service_account_namespaces=loyalty policies=loyalty-read ttl=1h", check: t => { const v = vaultOf(t); const r = v?.auth.kubernetes?.roles.get('loyalty'); return !!kvNow(t, 'loyalty/db')?.password && !!v.policies.get('loyalty-read')?.rules.some(x => x.path === 'secret/data/loyalty/*' && x.caps.includes('read')) && !!r && r.bound_service_account_names.includes('loyalty') && r.bound_service_account_namespaces.includes('loyalty') && r.policies.includes('loyalty-read'); } },
          { title: 'Through git: add to `apps/loyalty` a ServiceAccount `loyalty`, a SecretStore and an ExternalSecret `loyalty-db` (key `loyalty/db`, property `password`), and make the Deployment run as `loyalty` with `DB_PASSWORD` from the Secret. Push; the pods must be Ready', solution: 'cd ~/gitops && git pull && nano apps/loyalty/... && git push', test: ['cd ~/gitops && git pull -q', W('apps/loyalty/serviceaccount.yaml', LOY.sa), W('apps/loyalty/external-secret.yaml', LOY.eso), "sed -i 's#^      containers:#      serviceAccountName: loyalty\\n      containers:#' apps/loyalty/deployment.yaml && sed -i 's#^          ports:#          env:\\n            - name: DB_PASSWORD\\n              valueFrom:\\n                secretKeyRef:\\n                  name: loyalty-db\\n                  key: password\\n          ports:#' apps/loyalty/deployment.yaml", "sed -i 's#^  - networkpolicy.yaml#  - networkpolicy.yaml\\n  - serviceaccount.yaml\\n  - external-secret.yaml#' apps/loyalty/kustomization.yaml", 'git add apps/loyalty && git commit -m "loyalty: database password from Vault" && git push', 'sleep 30; kubectl get externalsecret,pods -n loyalty', 'kubectl rollout status deploy/loyalty -n loyalty'], check: t => { const d = dep(t, 'loyalty', 'loyalty'); const ps = d?.spec.template.spec; return esReady(t, 'loyalty', 'loyalty-db') && secretVal(t, 'loyalty', 'loyalty-db', 'password') === kvNow(t, 'loyalty/db')?.password && ps?.serviceAccountName === 'loyalty' && (ps.containers[0].env || []).some(e => e.valueFrom?.secretKeyRef?.name === 'loyalty-db') && depReady(t, 'loyalty', 'loyalty', 2) && cl(t).get('ExternalSecret', 'loyalty', 'loyalty-db')?.metadata.labels?.['app.kubernetes.io/instance'] === 'loyalty' && appOk(t, 'loyalty'); } },
          { title: 'Through git: an Ingress for `loyalty.lumen.dev`, and a default-deny ingress policy for the namespace. The site answers; a pod in `tools` cannot connect to loyalty', solution: 'cd ~/gitops && nano apps/loyalty/ingress.yaml apps/loyalty/default-deny.yaml && git push', test: ['cd ~/gitops', W('apps/loyalty/ingress.yaml', LOY.ingress), W('apps/loyalty/default-deny.yaml', LOY.deny), "sed -i 's#^  - external-secret.yaml#  - external-secret.yaml\\n  - ingress.yaml\\n  - default-deny.yaml#' apps/loyalty/kustomization.yaml", 'git add apps/loyalty && git commit -m "loyalty: ingress and default deny" && git push', 'sleep 20; curl -s http://loyalty.lumen.dev/'], check: t => site(t, 'loyalty.lumen.dev', 'loyalty') && cl(t).list('NetworkPolicy', 'loyalty').some(p => !Object.keys(p.spec.podSelector?.matchLabels || {}).length && !(p.spec.ingress || []).length) && !/loyalty/.test(curlFrom(t, 'tools', 'debug', 'http://loyalty.loyalty')?.out || '') && appOk(t, 'loyalty') },
          { title: 'Through git: let the group `team-growth` read the `loyalty` namespace with the built-in `view` role, and check with `kubectl auth can-i` (`--as someone --as-group team-growth`) that they can list pods but cannot read Secrets or change Deployments', solution: 'cd ~/gitops && nano apps/loyalty/team-view.yaml && git push && kubectl auth can-i list pods -n loyalty --as alex --as-group team-growth', test: ['cd ~/gitops', W('apps/loyalty/team-view.yaml', LOY.view), "sed -i 's#^  - default-deny.yaml#  - default-deny.yaml\\n  - team-view.yaml#' apps/loyalty/kustomization.yaml", 'git add apps/loyalty && git commit -m "loyalty: read-only access for team-growth" && git push', 'sleep 10; kubectl auth can-i list pods -n loyalty --as alex --as-group team-growth; kubectl auth can-i get secrets -n loyalty --as alex --as-group team-growth; kubectl auth can-i patch deployments -n loyalty --as alex --as-group team-growth'], check: t => { const g = { user: 'alex', groups: ['team-growth', 'system:authenticated'] }; return can(t, g, 'list', 'pods', '', 'loyalty') && !can(t, g, 'get', 'secrets', '', 'loyalty') && !can(t, g, 'patch', 'deployments', 'apps', 'loyalty') && cl(t).list('RoleBinding', 'loyalty').some(b => b.metadata.labels?.['app.kubernetes.io/instance'] === 'loyalty' && (b.subjects || []).some(x => x.kind === 'Group' && x.name === 'team-growth')) && kev(t, e => e.verb === 'auth' && e.args.includes('--as-group')).length > 0; } },
          { title: 'Final check: the scorecard is 6/6, the loyalty workloads pass every policy, and Argo CD shows loyalty Synced and Healthy', solution: 'lumen scorecard loyalty && kubectl get policyreport -n loyalty && argocd app get loyalty --core 2>/dev/null || kubectl get application loyalty -n argocd', test: ['lumen scorecard loyalty', 'sleep 35; kubectl get policyreport -n loyalty', 'kubectl get application loyalty -n argocd'], check: t => scorecard(t.uni, 'loyalty').every(x => x.ok) && liveFails(t, 'loyalty') === 0 && appOk(t, 'loyalty') && t.events('lumen').some(e => e.cmd === 'scorecard' && e.name === 'loyalty') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'loyalty\'s ExternalSecret shows "invalid role name". Where do you look first?', choices: ['The pod logs', 'The SecretStore\'s auth role, and whether that role exists in Vault', 'The Ingress', 'The ApplicationSet'], answer: 1, explain: 'The error names the Vault login step.' },
        { type: 'mc', q: 'Why add the Ingress and network policy through git rather than with kubectl?', choices: ['kubectl cannot create them', 'Argo CD would revert manual changes (self-heal), and git keeps the review and history', 'It is faster', 'Policies require git'], answer: 1, explain: 'One source of truth.' },
        { type: 'mc', q: 'Kyverno denies a Deployment that Argo CD tries to sync. What does Argo CD show?', choices: ['Synced', 'A failed sync operation with the policy\'s message; the app stays OutOfSync', 'Nothing', 'It deletes the policy'], answer: 1, explain: 'Fix the manifest in git; the next sync succeeds.' },
        { type: 'tf', q: 'Giving team-growth the `view` ClusterRole through a RoleBinding in `loyalty` lets them read Secrets in that namespace.', answer: false, explain: 'view excludes Secrets.' },
        { type: 'mc', q: 'Which part of this setup holds the database password in plain text?', choices: ['The gitops repo', 'Vault (encrypted at rest) and, at run time, the Kubernetes Secret in the namespace', 'The golden-path template', 'The PolicyReport'], answer: 1, explain: 'Git only has the ExternalSecret reference.' },
      ],
    },
  ],
};
