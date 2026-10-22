// Realm 7 · Kubernetes: a simulated cluster (control plane + two workers) where the
// controllers really reconcile, the scheduler places pods by their requests, kubelets pull
// images, run probes and restart containers, Services load-balance to ready pods and an
// ingress controller routes by host and path.

import { parseYaml } from '../git/yaml.js';

const LOCK = deps => JSON.stringify({ name: 'app', lockfileVersion: 3, packages: Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }])) }, null, 2) + '\n';
const DF = 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER node\nCMD ["node", "server.js"]\n';
// a Node app image: routes are [path, js-handler-body]
const nodeApp = (name, { port = 3000, env = [], db = false, cacheMb = null, routes = [], ready = null } = {}) => ({
  'server.js': [
    "const express = require('express');",
    ...(db ? ["const { Pool } = require('pg');"] : []),
    'const app = express();',
    `const PORT = process.env.PORT || ${port};`,
    ...(cacheMb !== null ? [`const CACHE_SIZE_MB = Number(process.env.CACHE_SIZE_MB || ${cacheMb});`] : []),
    ...env.map(v => `if (!process.env.${v}) throw new Error('${v} is required');`),
    ...(db ? ['const pool = new Pool({ connectionString: process.env.DATABASE_URL });'] : []),
    "app.get('/health', (req, res) => res.json({ status: 'ok' }));",
    `app.get('/ready', (req, res) => ${ready || "res.json({ ready: true })"});`,
    ...routes.map(([p, body]) => `app.get('${p}', (req, res) => ${body});`),
    `app.listen(PORT, () => console.log(\`${name} listening on \${PORT}\`));`,
    '',
  ].join('\n'),
  'package.json': JSON.stringify({ name, version: '1.0.0', dependencies: { express: '^4.21.1', ...(db ? { pg: '^8.13.1' } : {}) } }, null, 2) + '\n',
  'package-lock.json': LOCK({ express: '4.21.1', ...(db ? { pg: '8.13.1' } : {}) }),
  Dockerfile: DF,
});
const y = obj => obj; // manifests are written as objects, applied as YAML by the learner
const toY = (text) => text;
const deploy = (name, image, { replicas = 2, labels = { app: name }, port = 3000, extra = {}, container = {} } = {}) => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, labels }, spec: { replicas, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { containers: [{ name, image, ports: [{ name: 'http', containerPort: port }], ...container }] } }, ...extra } });

const cl = t => t.cluster('lumen');
const dep = (t, ns, n) => cl(t)?.get('Deployment', ns, n) || null;
const readyN = (t, ns, sel) => t.kready('lumen', ns, sel).length;
const ranK = (t, re) => t.ran(re);
const httpBody = (t, url) => { const r = t.http('laptop', url); return r.status === 200 ? String(r.body) : null; };
const count = (t, ns, pod, table, user = 'postgres') => { const c = cl(t); const p = c?.get('Pod', ns, pod); const rt = p && c.rt.get(p.metadata.uid); const h = rt?.containers[0]?.ctr?.h; if (!h || !c.podReady(p)) return -1; const r = t.exec(h, `psql -U ${user} -c "SELECT count(*) FROM ${table}"`, { user: 'root' }); const m = r.out.match(/^\s+(\d+)\s*$/m); return m ? Number(m[1]) : -1; };
const fileYaml = (t, path) => { try { return String(t.file('laptop', path) || '').split(/^---\s*$/m).filter(x => x.trim()).map(x => parseYaml(x)); } catch { return []; } };
const tplOf = d => d?.spec?.template?.spec?.containers?.[0] || {};

// ---------- lesson 2: notes ----------
const NOTES_IMG = 'ghcr.io/lumen/notes:1.2.0';
const NOTES_BROKEN = ['apiVersion: extensions/v1beta1', 'kind: Deployment', 'metadata:', '  name: notes', 'spec:', '  replicas: 2', '  selector:', '    matchLabels:', '      app: notes', '  template:', '    metadata:', '      labels:', '        app: notes-api', '    spec:', '      containers:', '        - name: notes', '          image: ghcr.io/lumen/note:1.2.0', '          ports:', '            - containerPort: 3000', ''].join('\n');
const NOTES_V2 = NOTES_BROKEN.replace('extensions/v1beta1', 'apps/v1').replace('app: notes-api', 'app: notes');
const NOTES_V3 = NOTES_V2.replace('lumen/note:', 'lumen/notes:');
const NOTES_V4 = NOTES_V3.replace('            - containerPort: 3000\n', '            - containerPort: 3000\n          env:\n            - name: NOTES_DB\n              value: /data/notes.db\n');

// ---------- lesson 3: menu ----------
const MENU_IMG = 'ghcr.io/lumen/menu:1.0';
const MENU_SVC = ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: menu', 'spec:', '  selector:', '    app: menu', '  ports:', '    - port: 80', '      targetPort: http', ''].join('\n');
const MENU_ING = ['apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: menu', 'spec:', '  ingressClassName: nginx', '  rules:', '    - host: menu.lumen.dev', '      http:', '        paths:', '          - path: /', '            pathType: Prefix', '            backend:', '              service:', '                name: menu', '                port:', '                  number: 80', ''].join('\n');
const MENU_ING2 = MENU_ING.replace('          - path: /\n', '          - path: /api\n            pathType: Prefix\n            backend:\n              service:\n                name: menu-api\n                port:\n                  number: 80\n          - path: /\n');

// ---------- lesson 4: config ----------
const MENU2_IMG = 'ghcr.io/lumen/menu:2.0';
const MENU2_PLAIN = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: menu', 'spec:', '  replicas: 2', '  selector:', '    matchLabels:', '      app: menu', '  template:', '    metadata:', '      labels:', '        app: menu', '    spec:', '      containers:', '        - name: menu', `          image: ${MENU2_IMG}`, '          ports:', '            - name: http', '              containerPort: 8080', '          env:', '            - name: LOG_LEVEL', '              value: info', '            - name: FEATURE_SPECIALS', '              value: "false"', '            - name: DATABASE_URL', '              value: postgres://menu:Tr0ub4dor-menu@db:5432/menu', ''].join('\n');
const MENU2_GOOD = MENU2_PLAIN.replace(/          env:[\s\S]*$/, ['          envFrom:', '            - configMapRef:', '                name: menu-config', '          env:', '            - name: DATABASE_URL', '              valueFrom:', '                secretKeyRef:', '                  name: menu-db', '                  key: url', ''].join('\n'));

// ---------- lesson 5: health ----------
const SHOP2 = 'ghcr.io/lumen/shop:2.0', SHOP21 = 'ghcr.io/lumen/shop:2.1-rc', CACHE = 'ghcr.io/lumen/cache:1.0', REPORTS = 'ghcr.io/lumen/reports:1.0';
const probeBlock = ['          readinessProbe:', '            httpGet:', '              path: /ready', '              port: http', '            periodSeconds: 5', '          livenessProbe:', '            httpGet:', '              path: /health', '              port: http', '            initialDelaySeconds: 5', ''].join('\n');
const HEALTH_FILES = {
  'reports.yaml': ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: reports', 'spec:', '  replicas: 1', '  selector:', '    matchLabels:', '      app: reports', '  template:', '    metadata:', '      labels:', '        app: reports', '    spec:', '      containers:', '        - name: reports', `          image: ${REPORTS}`, '          resources:', '            requests:', '              cpu: 250m', '              memory: 6Gi     # the AI said: "give it plenty, to be safe"', '            limits:', '              memory: 6Gi', ''].join('\n'),
  'cache.yaml': ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: cache', 'spec:', '  replicas: 1', '  selector:', '    matchLabels:', '      app: cache', '  template:', '    metadata:', '      labels:', '        app: cache', '    spec:', '      containers:', '        - name: cache', `          image: ${CACHE}`, '          resources:', '            requests:', '              memory: 64Mi', '            limits:', '              memory: 128Mi', ''].join('\n'),
  'shop.yaml': ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: shop-canary', 'spec:', '  replicas: 1', '  strategy:', '    rollingUpdate:          # a one-pod canary is replaced in place', '      maxSurge: 0', '      maxUnavailable: 1', '  selector:', '    matchLabels:', '      app: shop', '      track: canary', '  template:', '    metadata:', '      labels:', '        app: shop', '        track: canary', '    spec:', '      containers:', '        - name: shop', `          image: ${SHOP21}`, '          ports:', '            - name: http', '              containerPort: 3000', ''].join('\n'),
};
const fix = (text, from, to) => text.replace(from, to);

// ---------- lesson 6: rollouts ----------
const shopV = v => `ghcr.io/lumen/shop:${v}`;
const ROLL_DEPLOY = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: shop', 'spec:', '  replicas: 4', '  progressDeadlineSeconds: 120', '  strategy:', '    rollingUpdate:', '      maxSurge: 1', '      maxUnavailable: 0', '  selector:', '    matchLabels:', '      app: shop', '  template:', '    metadata:', '      labels:', '        app: shop', '    spec:', '      containers:', '        - name: shop', `          image: ${shopV('3.0')}`, '          ports:', '            - name: http', '              containerPort: 3000', probeBlock].join('\n');

// ---------- lesson 7: scaling and state ----------
const DB_DEPLOY = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: db', 'spec:', '  replicas: 1', '  selector:', '    matchLabels:', '      app: db', '  template:', '    metadata:', '      labels:', '        app: db', '    spec:', '      containers:', '        - name: postgres', '          image: postgres:16', '          env:', '            - name: POSTGRES_PASSWORD', '              value: devpass', '          ports:', '            - containerPort: 5432', ''].join('\n');
const DB_STS = ['apiVersion: apps/v1', 'kind: StatefulSet', 'metadata:', '  name: db', 'spec:', '  serviceName: db', '  replicas: 1', '  selector:', '    matchLabels:', '      app: db', '  template:', '    metadata:', '      labels:', '        app: db', '    spec:', '      containers:', '        - name: postgres', '          image: postgres:16', '          env:', '            - name: POSTGRES_PASSWORD', '              value: devpass', '          ports:', '            - containerPort: 5432', '          volumeMounts:', '            - name: data', '              mountPath: /var/lib/postgresql/data', '  volumeClaimTemplates:', '    - metadata:', '        name: data', '      spec:', '        accessModes: ["ReadWriteOnce"]', '        resources:', '          requests:', '            storage: 1Gi', ''].join('\n');

// ---------- boss ----------
const REG = 'registry.lumen.dev', TOKEN = 'rlt_7f3k9q2m4x8v';
const T_IMG = v => `${REG}/team/tickets:${v}`;
const BOSS = {
  'namespace.yaml': ['apiVersion: v1', 'kind: Namespace', 'metadata:', '  name: tickets', ''].join('\n'),
  'config.yaml': ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: tickets-config', '  namespace: tickets', 'data:', '  LOG_LEVEL: info', '---', 'apiVersion: v1', 'kind: Secret', 'metadata:', '  name: tickets-db', '  namespace: tickets', 'stringData:', '  password: t1ckets-Pr0d-2026', '  url: postgres://tickets:t1ckets-Pr0d-2026@db:5432/tickets', ''].join('\n'),
  'db.yaml': ['apiVersion: apps/v1', 'kind: StatefulSet', 'metadata:', '  name: db', '  namespace: tickets', 'spec:', '  serviceName: db', '  replicas: 1', '  selector:', '    matchLabels:', '      app: db', '  template:', '    metadata:', '      labels:', '        app: db', '    spec:', '      containers:', '        - name: postgres', '          image: postgres:16', '          env:', '            - name: POSTGRES_USER', '              value: tickets', '            - name: POSTGRES_PASSWORD', '              valueFrom:', '                secretKeyRef:', '                  name: tickets-db', '                  key: password', '          ports:', '            - containerPort: 5432', '          readinessProbe:', '            exec:', '              command: ["pg_isready", "-U", "tickets"]', '            periodSeconds: 5', '          volumeMounts:', '            - name: data', '              mountPath: /var/lib/postgresql/data', '  volumeClaimTemplates:', '    - metadata:', '        name: data', '      spec:', '        accessModes: ["ReadWriteOnce"]', '        resources:', '          requests:', '            storage: 1Gi', '---', 'apiVersion: v1', 'kind: Service', 'metadata:', '  name: db', '  namespace: tickets', 'spec:', '  selector:', '    app: db', '  ports:', '    - port: 5432', ''].join('\n'),
  'api.yaml': ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: tickets', '  namespace: tickets', 'spec:', '  replicas: 2', '  progressDeadlineSeconds: 120', '  selector:', '    matchLabels:', '      app: tickets', '  template:', '    metadata:', '      labels:', '        app: tickets', '    spec:', '      imagePullSecrets:', '        - name: regcred', '      containers:', '        - name: tickets', `          image: ${T_IMG('1.0.0')}`, '          ports:', '            - name: http', '              containerPort: 3000', '          envFrom:', '            - configMapRef:', '                name: tickets-config', '          env:', '            - name: DATABASE_URL', '              valueFrom:', '                secretKeyRef:', '                  name: tickets-db', '                  key: url', '          resources:', '            requests:', '              cpu: 100m', '              memory: 128Mi', '            limits:', '              memory: 256Mi', probeBlock.replace(/\n$/, ''), '---', 'apiVersion: v1', 'kind: Service', 'metadata:', '  name: tickets', '  namespace: tickets', 'spec:', '  selector:', '    app: tickets', '  ports:', '    - port: 80', '      targetPort: http', '---', 'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: tickets', '  namespace: tickets', 'spec:', '  ingressClassName: nginx', '  rules:', '    - host: tickets.lumen.dev', '      http:', '        paths:', '          - path: /', '            pathType: Prefix', '            backend:', '              service:', '                name: tickets', '                port:', '                  number: 80', ''].join('\n'),
};

function shopImages(H) {
  H.publishImage(SHOP2, nodeApp('shop', { routes: [['/', "res.send('Lumen shop 2.0: checkout open')"]] }));
  H.publishImage(SHOP21, nodeApp('shop', { routes: [['/', "{ throw new Error('cart.total is undefined'); }"]], ready: "res.status(503).json({ ready: false, reason: 'payments client not initialised' })" }));
}

export default {
  id: 'kubernetes',
  n: 7,
  title: 'Kubernetes',
  tagline: 'Desired state, pods and deployments, services and ingress, config and secrets, probes and resources, rollouts, autoscaling and state',
  badge: 'Cluster Commander',
  intro: 'Run containers on a cluster that keeps them running for you. Declare **desired state** and watch controllers enforce it, debug pods from what the cluster tells you, connect them with **Services and Ingress**, inject **ConfigMaps and Secrets**, make apps honest with **probes and resources**, ship with **rolling updates and rollbacks**, and scale with **HPAs and StatefulSets**. The cluster here really schedules, pulls images, probes and restarts.',
  lessons: [
    {
      id: 'why-kubernetes',
      title: 'Why Kubernetes',
      summary: 'Desired state and the control loop; control plane, nodes, kubelet; pods and deployments; kubectl and kubeconfig; self-healing and scaling.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) { H.cluster('lumen'); },
        suggestions: ['kubectl cluster-info', 'kubectl get nodes'],
        tasks: [
          { title: 'Which cluster are you talking to? Show the cluster info, your kubeconfig\'s current context, and the nodes', solution: 'kubectl cluster-info && kubectl config current-context && kubectl get nodes', check: t => ranK(t, /kubectl\s+cluster-info/) && ranK(t, /kubectl\s+config\s+(current-context|get-contexts|view)/) && ranK(t, /kubectl\s+get\s+(nodes|node|no)\b/) },
          { title: 'Look at the cluster\'s own components in the `kube-system` namespace', solution: 'kubectl get pods -n kube-system', check: t => ranK(t, /kubectl\s+get\s+(pods|po|pod)\b.*(-n\s+kube-system|--namespace[ =]kube-system|-A\b|--all-namespaces)/) },
          { title: 'Create a deployment `web` running `nginx:1.27` with 3 replicas, and wait until all 3 pods are ready', solution: 'kubectl create deployment web --image=nginx:1.27 --replicas=3 && kubectl get pods', test: ['kubectl create deployment web --image=nginx:1.27 --replicas=3', 'sleep 5; kubectl get deploy,pods'], check: t => { const d = dep(t, 'default', 'web'); return !!d && d.spec.replicas === 3 && /nginx/.test(tplOf(d).image) && readyN(t, 'default', 'app=web') === 3; } },
          { title: 'See which node each pod landed on, and its IP', solution: 'kubectl get pods -o wide', check: t => ranK(t, /kubectl\s+get\s+(pods|po)\b.*-o\s*wide/) },
          { title: 'Delete one of the pods. Then list the pods again: what happened, and why?', solution: 'kubectl delete pod $(kubectl get pods -l app=web -o name | head -1 | cut -d/ -f2) && kubectl get pods', check: t => t.events('k8s-pod-gone').some(e => /^web-/.test(e.name)) && readyN(t, 'default', 'app=web') === 3 && t.after(e => e.type === 'k8s-pod-gone' && /^web-/.test(e.name), e => e.type === 'kubectl' && e.verb === 'get') },
          { title: 'Scale `web` to 5 replicas and watch the new pods spread over the nodes', solution: 'kubectl scale deployment web --replicas=5 && sleep 4 && kubectl get pods -o wide', check: t => dep(t, 'default', 'web')?.spec.replicas === 5 && readyN(t, 'default', 'app=web') === 5 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'You delete a pod that belongs to a Deployment with 3 replicas. What happens?', choices: ['It is gone; 2 pods remain', 'The ReplicaSet controller notices 2 of 3 and creates a replacement', 'The Deployment is deleted', 'The node restarts'], answer: 1, explain: 'Controllers reconcile actual state towards desired state.' },
        { type: 'mc', q: 'Which component decides which node a new pod runs on?', choices: ['kubelet', 'scheduler', 'etcd', 'kubectl'], answer: 1, explain: 'The kubelet on the chosen node then starts it.' },
        { type: 'mc', q: 'What does the kubelet do?', choices: ['Stores cluster state', 'Runs on each node, starts pods\' containers through the runtime and reports their status', 'Routes HTTP traffic', 'Builds images'], answer: 1, explain: 'One per node.' },
        { type: 'tf', q: 'A Pod keeps its name and IP forever, even when it is replaced.', answer: false, explain: 'Replacements get new names and IPs. That is why Services exist.' },
        { type: 'mc', q: 'Where does kubectl find out which cluster and namespace to use?', choices: ['/etc/hosts', '~/.kube/config (the current context)', 'Environment variable PATH', 'It asks every time'], answer: 1, explain: 'Check `kubectl config current-context` before changing anything.' },
        { type: 'multi', q: 'Good reasons to adopt Kubernetes:', choices: ['Many services that need scheduling, self-healing and rolling updates', 'A standard API across clouds', 'Running a single small website as cheaply and simply as possible', 'Teams sharing one platform with namespaces and quotas'], answer: [0, 1, 3], explain: 'For one small site, simpler options win.' },
        { type: 'type', q: 'Type the command that changes the deployment `web` to 5 replicas.', accept: ['kubectl scale deployment web --replicas=5', 'kubectl scale deploy web --replicas=5', 'kubectl scale deployment/web --replicas=5', 'kubectl scale deploy/web --replicas=5', 'kubectl scale --replicas=5 deployment web', 'kubectl scale --replicas=5 deployment/web', 'kubectl scale --replicas=5 deploy/web'], model: 'kubectl scale deployment web --replicas=5', explain: 'Or change replicas: in the manifest and apply it.' },
      ],
    },
    {
      id: 'pods-deployments',
      title: 'Pods, Deployments and debugging',
      summary: 'Manifests, labels and selectors, apply; reading pod states; describe, events and logs; ImagePullBackOff, CrashLoopBackOff, Pending.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          H.cluster('lumen');
          H.publishImage(NOTES_IMG, nodeApp('notes', { env: ['NOTES_DB'], routes: [['/', "res.json({ notes: 3 })"]] }));
          H.write('laptop', '~/notes.yaml', NOTES_BROKEN, { owner: 'dev' });
        },
        suggestions: ['cat notes.yaml', 'kubectl apply -f notes.yaml'],
        tasks: [
          { title: 'An AI assistant wrote `~/notes.yaml`. Apply it and read the error', solution: 'kubectl apply -f notes.yaml', check: t => t.events('kubectl').some(e => e.verb === 'apply' && e.ok === false) || ranK(t, /kubectl\s+apply\s+-f\s+notes\.yaml/) && !dep(t, 'default', 'notes') },
          { title: 'Fix what the API server complains about (apiVersion, then the label mismatch) until the Deployment is created', hint: 'Deployments live in `apps/v1`. The template\'s labels must match `selector.matchLabels`.', solution: 'nano notes.yaml && kubectl apply -f notes.yaml', test: [{ cmd: 'nano notes.yaml', edit: NOTES_V2 }, 'kubectl apply -f notes.yaml'], check: t => !!dep(t, 'default', 'notes') },
          { title: 'The pods are not running. Find out why with `kubectl describe`, fix the manifest and apply again', solution: 'kubectl get pods && kubectl describe pod -l app=notes | tail -8 && nano notes.yaml && kubectl apply -f notes.yaml', test: ['sleep 4; kubectl get pods', 'kubectl describe pods -l app=notes', { cmd: 'nano notes.yaml', edit: NOTES_V3 }, 'kubectl apply -f notes.yaml'], check: t => ranK(t, /kubectl\s+describe\s+(pod|pods|po)\b/) && tplOf(dep(t, 'default', 'notes')).image === NOTES_IMG },
          { title: 'Now they crash. Read the logs of the crashed container, then give the app what it needs (`NOTES_DB=/data/notes.db`) in the manifest and apply', solution: 'kubectl logs deploy/notes --previous; nano notes.yaml && kubectl apply -f notes.yaml', test: ['sleep 12; kubectl get pods', 'kubectl logs deploy/notes', { cmd: 'nano notes.yaml', edit: NOTES_V4 }, 'kubectl apply -f notes.yaml', 'sleep 6; kubectl get pods'], check: t => ranK(t, /kubectl\s+logs\b/) && readyN(t, 'default', 'app=notes') === 2 && (tplOf(dep(t, 'default', 'notes')).env || []).some(e => e.name === 'NOTES_DB') },
          { title: 'List just the notes pods by label, showing their labels, and read the recent events in the namespace', solution: 'kubectl get pods -l app=notes --show-labels && kubectl get events', check: t => ranK(t, /kubectl\s+get\s+(pods|po)\b.*-l\s+app=notes|--selector[ =]app=notes/) && ranK(t, /kubectl\s+get\s+(events|ev)\b/) },
        ],
      },
      quiz: [
        { type: 'mc', q: '`kubectl apply` printed `deployment.apps/notes created`. What does that guarantee?', choices: ['The app is running', 'The cluster accepted the desired state; whether it can run is shown by pod status', 'The image exists', 'The pods are ready'], answer: 1, explain: 'Check get pods / describe.' },
        { type: 'mc', q: 'A pod shows `ImagePullBackOff`. Most likely cause?', choices: ['Out of memory', 'Wrong image name or tag, or a private registry without credentials', 'The Service is missing', 'A failing readiness probe'], answer: 1, explain: 'describe shows the exact pull error.' },
        { type: 'mc', q: '`CrashLoopBackOff` means…', choices: ['The image cannot be pulled', 'The container keeps exiting and Kubernetes waits longer and longer before restarting it', 'The node is down', 'The pod is waiting for a volume'], answer: 1, explain: 'Read `kubectl logs --previous` for the crashed run.' },
        { type: 'mc', q: 'Where is the most useful information when a pod is stuck?', choices: ['kubectl version', 'The Events section of kubectl describe pod', 'kubectl get nodes', 'The image history'], answer: 1, explain: 'Scheduler, kubelet and image pull problems are all recorded as events.' },
        { type: 'predict', q: 'What happens when you apply this?', code: 'spec:\n  selector:\n    matchLabels: { app: notes }\n  template:\n    metadata:\n      labels: { app: notes-api }', choices: ['It works', 'The API rejects it: selector does not match template labels', 'Pods start but are orphaned', 'It creates two deployments'], answer: 1, explain: 'A Deployment must be able to select the pods it creates.' },
        { type: 'tf', q: 'Deleting a crash-looping pod fixes the problem.', answer: false, explain: 'The replacement runs the same image and config and crashes the same way.' },
        { type: 'type', q: 'Type the command that shows the logs of the previous (crashed) run of pod `notes-7d9f-abcde`.', accept: ['kubectl logs notes-7d9f-abcde --previous', 'kubectl logs --previous notes-7d9f-abcde', 'kubectl logs notes-7d9f-abcde -p', 'kubectl logs -p notes-7d9f-abcde'], model: 'kubectl logs notes-7d9f-abcde --previous', explain: '--previous (-p) shows the last terminated container.' },
      ],
    },
    {
      id: 'services-ingress',
      title: 'Services, DNS and Ingress',
      summary: 'ClusterIP, NodePort, LoadBalancer; port vs targetPort; endpoints and selectors; DNS names; port-forward; Ingress host and path routing.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          H.publishImage(MENU_IMG, nodeApp('menu', { port: 8080, routes: [['/', "res.send('Lumen menu: soup of the day is tomato')"]] }));
          H.k8s('lumen', [deploy('menu', MENU_IMG, { port: 8080, labels: { app: 'menu' } }), { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'menu-api' }, spec: { replicas: 1, selector: { matchLabels: { app: 'menu-api' } }, template: { metadata: { labels: { app: 'menu-api' } }, spec: { containers: [{ name: 'api', image: 'hashicorp/http-echo:1.0', args: ['-text=menu api v1: {"dishes": 12}'], ports: [{ containerPort: 5678 }] }] } } } }, { apiVersion: 'v1', kind: 'Service', metadata: { name: 'menu-old' }, spec: { selector: { app: 'menu-web' }, ports: [{ port: 80, targetPort: 8080 }] } }]);
          H.dns('menu.lumen.dev', c.ingressHost.ip);
        },
        suggestions: ['kubectl get deploy,svc', 'kubectl describe svc menu-old'],
        tasks: [
          { title: 'A teammate created the service `menu-old`, but nothing reaches the menu through it. Find out why', hint: 'Compare the Service\'s selector with the pods\' labels. Look at its Endpoints.', solution: 'kubectl describe svc menu-old && kubectl get pods --show-labels', check: t => ranK(t, /kubectl\s+(describe\s+(svc|service)\s+menu-old|get\s+(endpoints|ep)\b)/) },
          { title: 'Create a Service `menu` on port 80 that sends traffic to the menu pods\' port 8080 (named `http`), and check it has 2 endpoints', solution: 'kubectl expose deployment menu --port=80 --target-port=http && kubectl get endpoints menu', test: [{ cmd: 'nano menu-svc.yaml', edit: MENU_SVC }, 'kubectl apply -f menu-svc.yaml && kubectl get endpoints menu'], check: t => { const s = t.kobj('lumen', 'Service', 'default', 'menu'); return !!s && cl(t).endpoints(s).length === 2; } },
          { title: 'Test it from inside the cluster: run a throwaway curl pod that fetches `http://menu`', solution: 'kubectl run tmp --image=curlimages/curl --rm -it --restart=Never -- curl -s http://menu', check: t => t.events('kubectl').some(e => e.verb === 'run' && /curl/.test(e.args) && /http:\/\/menu(\.default)?(\.svc)?/.test(e.args)) },
          { title: 'From your laptop, the Service\'s IP is not reachable. Use `port-forward` to reach it on localhost:8080 and curl it', solution: 'kubectl port-forward svc/menu 8080:80 && curl -s localhost:8080', check: t => t.events('http').some(e => e.host === 'laptop' && /(localhost|127\.0\.0\.1):8080/.test(e.url) && e.status === 200) },
          { title: 'Publish it properly: an Ingress `menu` (class `nginx`) that routes `menu.lumen.dev/` to the `menu` Service, then curl `http://menu.lumen.dev`', solution: 'nano menu-ingress.yaml && kubectl apply -f menu-ingress.yaml && curl -s http://menu.lumen.dev', test: [{ cmd: 'nano menu-ingress.yaml', edit: MENU_ING }, 'kubectl apply -f menu-ingress.yaml && sleep 2 && curl -s http://menu.lumen.dev'], check: t => /tomato/.test(httpBody(t, 'http://menu.lumen.dev/') || '') && t.events('http').some(e => e.host === 'laptop' && /menu\.lumen\.dev/.test(e.url) && e.status === 200) },
          { title: 'Route `menu.lumen.dev/api` to the `menu-api` deployment (it listens on 5678): give it a Service on port 80 and add the path to the Ingress', solution: 'kubectl expose deployment menu-api --port=80 --target-port=5678 && nano menu-ingress.yaml && kubectl apply -f menu-ingress.yaml && curl -s http://menu.lumen.dev/api', test: ['kubectl expose deployment menu-api --port=80 --target-port=5678', { cmd: 'nano menu-ingress.yaml', edit: MENU_ING2 }, 'kubectl apply -f menu-ingress.yaml && curl -s http://menu.lumen.dev/api && curl -s http://menu.lumen.dev/'], check: t => /menu api v1/.test(httpBody(t, 'http://menu.lumen.dev/api') || '') && /tomato/.test(httpBody(t, 'http://menu.lumen.dev/') || '') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'A Service has no endpoints. Most likely cause?', choices: ['Wrong port', 'Its selector matches no ready pods (often a label typo)', 'DNS is down', 'The Ingress is missing'], answer: 1, explain: 'Endpoints are the ready pods matching the selector.' },
        { type: 'mc', q: 'From a pod in namespace `shop`, how do you reach Service `api` in namespace `payments`?', choices: ['http://api', 'http://api.payments', 'http://payments/api', 'Only by IP'], answer: 1, explain: 'name.namespace (or the full api.payments.svc.cluster.local).' },
        { type: 'mc', q: '`port: 80, targetPort: 3000` on a Service means…', choices: ['Pods listen on 80', 'Clients connect to the Service on 80; traffic goes to the pods\' port 3000', 'Nodes open port 3000', 'Nothing: they must be equal'], answer: 1, explain: 'targetPort can also be a named container port.' },
        { type: 'mc', q: 'Which Service type is reachable only from inside the cluster?', choices: ['ClusterIP', 'NodePort', 'LoadBalancer', 'Ingress'], answer: 0, explain: 'The default.' },
        { type: 'multi', q: 'What can an Ingress do?', choices: ['Route by hostname', 'Route by path', 'Terminate TLS', 'Run your app\'s containers'], answer: [0, 1, 2], explain: 'It routes to Services; Deployments run the pods.' },
        { type: 'tf', q: '`kubectl port-forward` is a good way to serve production traffic.', answer: false, explain: 'It is a debugging tunnel tied to your terminal session.' },
      ],
    },
    {
      id: 'config-secrets',
      title: 'ConfigMaps and Secrets',
      summary: 'Settings in ConfigMaps, credentials in Secrets; env vs files; base64 is not encryption; restarting to pick up changes.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          H.publishImage(MENU2_IMG, nodeApp('menu', { port: 8080, env: ['DATABASE_URL'], routes: [['/', "res.send('Lumen menu. Specials enabled: ' + process.env.FEATURE_SPECIALS)"]] }));
          H.write('laptop', '~/menu.yaml', MENU2_PLAIN, { owner: 'dev' });
          H.k8s('lumen', [...MENU2_PLAIN.split(/^---$/m).map(x => parseYaml(x)), parseYaml(MENU_SVC.replace('targetPort: http', 'targetPort: 8080')), parseYaml(MENU_ING)]);
          H.dns('menu.lumen.dev', c.ingressHost.ip);
        },
        suggestions: ['cat menu.yaml', 'curl -s http://menu.lumen.dev'],
        tasks: [
          { title: 'Check what the site says, then find the database password hard-coded in `menu.yaml` (which is in git)', solution: 'curl -s http://menu.lumen.dev; grep -n DATABASE_URL -A1 menu.yaml', check: t => t.events('http').some(e => e.host === 'laptop' && /menu\.lumen\.dev/.test(e.url)) && ranK(t, /(grep|cat|less)\b.*menu\.yaml/) },
          { title: 'Create a Secret `menu-db` with a key `url` holding that connection string', solution: "kubectl create secret generic menu-db --from-literal=url='postgres://menu:Tr0ub4dor-menu@db:5432/menu'", check: t => { const s = t.kobj('lumen', 'Secret', 'default', 'menu-db'); return !!s && /^postgres:\/\/menu:Tr0ub4dor-menu@db:5432\/menu$/.test(atob(s.data?.url || '')); } },
          { title: 'Create a ConfigMap `menu-config` with `LOG_LEVEL=info` and `FEATURE_SPECIALS=false`', solution: 'kubectl create configmap menu-config --from-literal=LOG_LEVEL=info --from-literal=FEATURE_SPECIALS=false', check: t => { const m = t.kobj('lumen', 'ConfigMap', 'default', 'menu-config'); return !!m && m.data?.LOG_LEVEL === 'info' && m.data?.FEATURE_SPECIALS === 'false'; } },
          { title: 'Change `menu.yaml` to take its settings from the ConfigMap (envFrom) and DATABASE_URL from the Secret, with no password left in the file. Apply it', solution: 'nano menu.yaml && kubectl apply -f menu.yaml && kubectl rollout status deploy/menu', test: [{ cmd: 'nano menu.yaml', edit: MENU2_GOOD }, 'kubectl apply -f menu.yaml && kubectl rollout status deploy/menu'], check: t => { const c0 = tplOf(dep(t, 'default', 'menu')); const f = t.file('laptop', '~/menu.yaml') || ''; return !/Tr0ub4dor/.test(f) && (c0.envFrom || []).some(e => e.configMapRef?.name === 'menu-config') && (c0.env || []).some(e => e.name === 'DATABASE_URL' && e.valueFrom?.secretKeyRef?.name === 'menu-db') && readyN(t, 'default', 'app=menu') === 2; } },
          { title: 'Prove to yourself that a Secret is not encrypted: read `url` back out of it and decode it', solution: "kubectl get secret menu-db -o jsonpath='{.data.url}' | base64 -d; echo", check: t => ranK(t, /kubectl\s+get\s+secrets?\s+menu-db.*(jsonpath|-o\s*(yaml|json))/) && ranK(t, /base64\s+(-d|--decode)/) },
          { title: 'Turn the specials on (`FEATURE_SPECIALS=true` in the ConfigMap). The site still says false: make the pods pick it up, then check the site', hint: 'Environment variables are read when a container starts. `kubectl rollout restart` replaces the pods gradually.', solution: 'kubectl create configmap menu-config --from-literal=LOG_LEVEL=info --from-literal=FEATURE_SPECIALS=true --dry-run=client -o yaml | kubectl apply -f - && kubectl rollout restart deploy/menu && kubectl rollout status deploy/menu && curl -s http://menu.lumen.dev', check: t => t.kobj('lumen', 'ConfigMap', 'default', 'menu-config')?.data?.FEATURE_SPECIALS === 'true' && t.events('kubectl').some(e => e.verb === 'rollout' && e.sub === 'restart') && /enabled: true/.test(httpBody(t, 'http://menu.lumen.dev/') || '') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What protects a Kubernetes Secret\'s value?', choices: ['base64 encryption', 'Access control (RBAC), encryption at rest, and keeping it out of git: base64 is only encoding', 'Nothing can read it', 'The container runtime'], answer: 1, explain: 'Anyone who can `get secret` can decode it.' },
        { type: 'mc', q: 'You change a ConfigMap used via envFrom. When do running pods see the new value?', choices: ['Immediately', 'After the containers restart (e.g. kubectl rollout restart)', 'Never', 'After a node reboot only'], answer: 1, explain: 'Env vars are fixed at container start.' },
        { type: 'mc', q: 'A pod references Secret key `pasword` (typo). What happens?', choices: ['It starts with an empty variable', 'CreateContainerConfigError: couldn\'t find key', 'CrashLoopBackOff', 'Pending'], answer: 1, explain: 'The kubelet refuses to start the container.' },
        { type: 'multi', q: 'Where should a production database password live?', choices: ['A Kubernetes Secret (or an external vault synced into one)', 'The Deployment YAML in git', 'The container image', 'A sealed/encrypted secret in git that only the cluster can decrypt'], answer: [0, 3], explain: 'Never plain text in git or images.' },
        { type: 'tf', q: 'The same image should run in every environment, with differences only in configuration.', answer: true, explain: 'Build once; configure per environment.' },
        { type: 'type', q: 'Type the command that creates a generic Secret `api-key` with key `token` set to `abc123`.', accept: ['kubectl create secret generic api-key --from-literal=token=abc123', "kubectl create secret generic api-key --from-literal='token=abc123'", 'kubectl create secret generic api-key --from-literal="token=abc123"'], model: 'kubectl create secret generic api-key --from-literal=token=abc123', explain: 'Avoid putting real secrets in shell history in real life: --from-file or a manifest from a vault.' },
      ],
    },
    {
      id: 'health-resources',
      title: 'Probes, requests and limits',
      summary: 'Readiness vs liveness probes; requests for scheduling, limits as ceilings; Pending, OOMKilled, unready pods taking traffic.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          shopImages(H);
          H.publishImage(CACHE, nodeApp('cache', { port: 6000, cacheMb: 300 }));
          H.publishImage(REPORTS, nodeApp('reports', { port: 3000 }));
          for (const [f, text] of Object.entries(HEALTH_FILES)) H.write('laptop', `~/${f}`, text, { owner: 'dev' });
          H.k8s('lumen', [deploy('shop', SHOP2, { replicas: 2, labels: { app: 'shop' } }), parseYaml(MENU_SVC.replace(/menu/g, 'shop').replace('targetPort: http', 'targetPort: 3000')), parseYaml(MENU_ING.replace(/menu/g, 'shop')), ...Object.values(HEALTH_FILES).map(x => parseYaml(x))], { settle: 40 });
          H.dns('shop.lumen.dev', c.ingressHost.ip);
        },
        suggestions: ['kubectl get pods', 'kubectl describe pod -l app=reports'],
        tasks: [
          { title: '`reports` never starts. Find out why', solution: 'kubectl get pods && kubectl describe pod -l app=reports | tail -5', check: t => ranK(t, /kubectl\s+describe\s+(pod|pods|po)\b.*(reports|app=reports)/) },
          { title: 'Its request is far bigger than any node. Set requests and limits to `memory: 256Mi` in `reports.yaml` and apply it', solution: 'sed -i "s/6Gi.*/256Mi/" reports.yaml && kubectl apply -f reports.yaml', check: t => readyN(t, 'default', 'app=reports') === 1 },
          { title: '`cache` keeps restarting. Find out why it dies (look at its Last State)', solution: 'kubectl get pods -l app=cache && kubectl describe pod -l app=cache | grep -A3 "Last State"', test: ['sleep 10; kubectl get pods -l app=cache', 'kubectl describe pod -l app=cache'], check: t => ranK(t, /kubectl\s+(describe\s+(pod|pods|po)\b.*(cache|app=cache)|get\s+(pod|pods|po)\b.*cache.*-o\s*(yaml|json))/) },
          { title: 'It holds a 300 MB cache in memory but its limit is 128Mi. Raise the limit to 512Mi in `cache.yaml` and apply; it must stay up', solution: 'sed -i "s/128Mi/512Mi/" cache.yaml && kubectl apply -f cache.yaml && sleep 6 && kubectl get pods -l app=cache', check: t => { const p = t.kready('lumen', 'default', 'app=cache')[0]; const d = dep(t, 'default', 'cache'); return !!p && /512Mi|1Gi/.test(tplOf(d).resources?.limits?.memory || ''); } },
          { title: 'Some checkout requests fail. Call the shop several times and look at the status codes', solution: 'for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code}\\n" http://shop.lumen.dev/; done', check: t => t.events('http').some(e => e.host === 'laptop' && /shop\.lumen\.dev/.test(e.url) && e.status === 500) },
          { title: 'A canary (`shop-canary`, also labelled `app: shop`) is broken but gets traffic. Add a readiness probe on `/ready` (port `http`) to it in `shop.yaml` and apply. Then all requests succeed', hint: 'An unready pod is removed from the Service endpoints but keeps running, so you can still debug it.', solution: 'nano shop.yaml && kubectl apply -f shop.yaml && sleep 15 && for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code}\\n" http://shop.lumen.dev/; done', test: [{ cmd: 'nano shop.yaml', edit: HEALTH_FILES['shop.yaml'] + probeBlock }, 'kubectl apply -f shop.yaml && sleep 15 && kubectl get pods -l app=shop && kubectl get endpoints shop'], check: t => { const d = dep(t, 'default', 'shop-canary'); const s = t.kobj('lumen', 'Service', 'default', 'shop'); if (!d || !tplOf(d).readinessProbe?.httpGet || !s) return false; const eps = cl(t).endpoints(s); if (eps.some(e => e.pod.metadata.labels.track === 'canary')) return false; for (let i = 0; i < 6; i++) if (t.http('laptop', 'http://shop.lumen.dev/').status !== 200) return false; return true; } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'A pod\'s readiness probe fails. What happens?', choices: ['It is restarted', 'It is removed from the Service endpoints and keeps running', 'It is deleted', 'The node is drained'], answer: 1, explain: 'Liveness restarts; readiness controls traffic.' },
        { type: 'mc', q: 'A pod is `Pending` with `0/3 nodes are available: Insufficient memory`. What do you change?', choices: ['The memory limit only', 'The memory request (or add capacity)', 'The readiness probe', 'The image'], answer: 1, explain: 'Scheduling uses requests.' },
        { type: 'mc', q: 'Last State: Terminated, Reason: OOMKilled, Exit Code: 137. Meaning?', choices: ['The app crashed on a bug', 'The container exceeded its memory limit and was killed', 'The image is too big', 'A liveness probe failed'], answer: 1, explain: 'Raise the limit or reduce memory use.' },
        { type: 'mc', q: 'What happens when a container exceeds its CPU limit?', choices: ['It is killed', 'It is throttled (slowed down)', 'It is moved to another node', 'Nothing'], answer: 1, explain: 'Memory over the limit kills; CPU over the limit slows.' },
        { type: 'tf', q: 'A liveness probe that checks the database is a good idea.', answer: false, explain: 'A database blip would restart every pod at once. Keep liveness local.' },
        { type: 'multi', q: 'Which belong in a production container spec?', choices: ['CPU and memory requests', 'A memory limit', 'A readiness probe', 'privileged: true'], answer: [0, 1, 2], explain: 'Privileged containers are almost never needed.' },
      ],
    },
    {
      id: 'rollouts',
      title: 'Rolling updates and rollbacks',
      summary: 'New ReplicaSets per template, maxSurge and maxUnavailable, readiness-gated progress, rollout status, history, change-cause and undo.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          for (const v of ['3.0', '3.1']) H.publishImage(shopV(v), nodeApp('shop', { routes: [['/', `res.send('Lumen shop ${v}')`]] }));
          H.publishImage(shopV('3.2'), nodeApp('shop', { routes: [['/', "res.send('Lumen shop 3.2')"]], ready: "res.status(503).json({ ready: false, reason: 'migration 0042_checkout_v2 has not been applied' })" }));
          H.write('laptop', '~/shop.yaml', ROLL_DEPLOY, { owner: 'dev' });
          H.k8s('lumen', [parseYaml(ROLL_DEPLOY), parseYaml(MENU_SVC.replace(/menu/g, 'shop')), parseYaml(MENU_ING.replace(/menu/g, 'shop'))], { settle: 40 });
          H.dns('shop.lumen.dev', c.ingressHost.ip);
        },
        suggestions: ['kubectl get deploy shop', 'kubectl rollout history deploy/shop'],
        tasks: [
          { title: 'Look at the shop: its pods, the version it serves, and its rollout history', solution: 'kubectl get pods -l app=shop && curl -s http://shop.lumen.dev/ && kubectl rollout history deploy/shop', check: t => ranK(t, /kubectl\s+rollout\s+history/) && t.events('http').some(e => e.host === 'laptop' && /shop\.lumen\.dev/.test(e.url)) },
          { title: 'Roll out version 3.1 (`ghcr.io/lumen/shop:3.1`), record why with a `kubernetes.io/change-cause` annotation, and wait for `rollout status` to succeed', solution: 'kubectl set image deploy/shop shop=ghcr.io/lumen/shop:3.1 && kubectl annotate deploy/shop kubernetes.io/change-cause="shop 3.1: faster search" --overwrite && kubectl rollout status deploy/shop', test: ['kubectl annotate deploy/shop kubernetes.io/change-cause="shop 3.1: faster search" --overwrite && kubectl set image deploy/shop shop=ghcr.io/lumen/shop:3.1 && kubectl rollout status deploy/shop'], check: t => tplOf(dep(t, 'default', 'shop')).image === shopV('3.1') && t.events('kubectl').some(e => e.verb === 'rollout' && e.sub === 'status' && e.ok) && readyN(t, 'default', 'app=shop') === 4 && cl(t).list('ReplicaSet', 'default').some(r => r.metadata.annotations?.['kubernetes.io/change-cause'] && r.spec.template.spec.containers[0].image === shopV('3.1')) },
          { title: 'Now roll out 3.2 the same way. `rollout status` will not succeed: while it waits, is the site still up?', solution: 'kubectl set image deploy/shop shop=ghcr.io/lumen/shop:3.2 && kubectl rollout status deploy/shop; curl -s http://shop.lumen.dev/', check: t => tplOf(dep(t, 'default', 'shop')).image === shopV('3.2') && t.events('kubectl').some(e => e.verb === 'rollout' && e.sub === 'status' && e.ok === false) && t.events('http').some(e => e.host === 'laptop' && /shop\.lumen\.dev/.test(e.url) && e.status === 200 && t.after(x => x.type === 'kubectl' && x.verb === 'set', y => y === e)) },
          { title: 'Find out why the new pod never becomes ready', solution: 'kubectl get pods -l app=shop && kubectl describe pod $(kubectl get pods -l app=shop --no-headers | grep 0/1 | head -1 | cut -d" " -f1) | tail -4', check: t => ranK(t, /kubectl\s+(describe\s+(pod|pods|po)|get\s+events|logs)\b/) && t.after(e => e.type === 'kubectl' && e.verb === 'set', e => e.type === 'kubectl' && (e.verb === 'describe' || (e.verb === 'get' && /event/.test(e.args)))) },
          { title: 'Roll back to 3.1 and confirm every pod is ready on 3.1, then read the history again', solution: 'kubectl rollout undo deploy/shop && kubectl rollout status deploy/shop && kubectl rollout history deploy/shop', check: t => { const d = dep(t, 'default', 'shop'); const pods = t.kpods('lumen', 'default', 'app=shop'); return tplOf(d).image === shopV('3.1') && readyN(t, 'default', 'app=shop') === 4 && pods.every(p => p.spec.containers[0].image === shopV('3.1')) && t.events('kubectl').some(e => e.verb === 'rollout' && e.sub === 'undo') && t.after(e => e.type === 'kubectl' && e.sub === 'undo', e => e.type === 'kubectl' && e.sub === 'history'); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'You change only the image in a Deployment. What does Kubernetes create?', choices: ['A new Deployment', 'A new ReplicaSet for the new template, scaled up while the old one scales down', 'New nodes', 'Nothing until you delete the pods'], answer: 1, explain: 'One ReplicaSet per template revision.' },
        { type: 'mc', q: 'New pods never pass readiness during a rollout with maxUnavailable: 0. What do users see?', choices: ['An outage', 'The old version, still serving; the rollout is stuck', 'A mix of errors', 'The new version'], answer: 1, explain: 'Readiness gating protects you.' },
        { type: 'mc', q: 'Does Kubernetes roll back a stuck Deployment automatically?', choices: ['Yes, always', 'No: it marks ProgressDeadlineExceeded; you or your pipeline run rollout undo', 'Only on Sundays', 'Only with Recreate'], answer: 1, explain: 'Pipelines should check `rollout status` and react.' },
        { type: 'order', q: 'Order a safe manual release.', items: ['kubectl set image (or apply the new manifest)', 'kubectl rollout status', 'Check the service and metrics', 'If it is bad: kubectl rollout undo', 'Fix the cause in git'], explain: 'Undo buys time; git must reflect the fix.' },
        { type: 'tf', q: 'Re-pushing a new image under the same tag (e.g. :latest) triggers a rolling update automatically.', answer: false, explain: 'The template did not change, so nothing rolls out, and you cannot roll back.' },
        { type: 'mc', q: '`strategy.type: Recreate` is right when…', choices: ['You want zero downtime', 'Two versions must never run at the same time (e.g. an exclusive database migration)', 'You have many replicas', 'Always'], answer: 1, explain: 'It accepts a short outage.' },
      ],
    },
    {
      id: 'scaling-state',
      title: 'Autoscaling and state',
      summary: 'HorizontalPodAutoscaler on CPU relative to requests; StatefulSets with stable names; PersistentVolumeClaims that survive restarts.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['cluster', 'files'],
        setup(H) {
          H.cluster('lumen');
          H.publishImage(SHOP2, nodeApp('shop', { routes: [['/', "res.send('Lumen shop 2.0')"]] }));
          H.write('laptop', '~/db.yaml', DB_DEPLOY, { owner: 'dev' });
          H.k8s('lumen', [deploy('shop', SHOP2, { replicas: 2, labels: { app: 'shop' } }), { apiVersion: 'v1', kind: 'Service', metadata: { name: 'db' }, spec: { selector: { app: 'db' }, ports: [{ port: 5432 }] } }], { settle: 30 });
        },
        events(ev, t) {
          const c = t.cluster('lumen');
          const hpa = c?.get('HorizontalPodAutoscaler', 'default', 'shop');
          if (hpa && hpa.status.currentUtilization != null && c.load['default/shop'] === undefined) { c.load['default/shop'] = 500; t.say('📈 The sale just started: traffic on the shop is climbing fast. Watch the autoscaler (kubectl get hpa, kubectl get pods).'); }
        },
        suggestions: ['cat db.yaml', 'kubectl get deploy,sts,pvc'],
        tasks: [
          { title: '`db.yaml` runs Postgres as a Deployment with no storage. Rewrite it as a StatefulSet `db` (serviceName `db`) with a volumeClaimTemplate `data` (1Gi) mounted at `/var/lib/postgresql/data`, and apply it', solution: 'nano db.yaml && kubectl apply -f db.yaml && sleep 6 && kubectl get sts,pvc,pods', test: [{ cmd: 'nano db.yaml', edit: DB_STS }, 'kubectl apply -f db.yaml && sleep 8 && kubectl get sts,pvc,pods'], check: t => { const s = t.kobj('lumen', 'StatefulSet', 'default', 'db'); return !!s && (s.spec.volumeClaimTemplates || []).some(v => v.metadata?.name === 'data') && !!t.kobj('lumen', 'PersistentVolumeClaim', 'default', 'data-db-0') && t.kready('lumen', 'default', 'app=db').some(p => p.metadata.name === 'db-0'); } },
          { title: 'Store an order: create table `orders` with one row, using `kubectl exec db-0 -- psql -U postgres -c "…"`', solution: 'kubectl exec db-0 -- psql -U postgres -c "CREATE TABLE orders (id int, item text); INSERT INTO orders VALUES (1, \'gift card\')"', check: t => count(t, 'default', 'db-0', 'orders') >= 1 },
          { title: 'Delete the pod `db-0`. It comes back with the same name: is the order still there?', solution: 'kubectl delete pod db-0 && sleep 8 && kubectl get pods && kubectl exec db-0 -- psql -U postgres -c "SELECT * FROM orders"', check: t => t.events('k8s-pod-gone').some(e => e.name === 'db-0') && count(t, 'default', 'db-0', 'orders') >= 1 },
          { title: 'Autoscale the shop between 2 and 10 pods at 60% CPU. Its TARGETS show `<unknown>`: find out why in `describe hpa`', solution: 'kubectl autoscale deployment shop --min=2 --max=10 --cpu-percent=60 && sleep 4 && kubectl get hpa && kubectl describe hpa shop', check: t => !!t.kobj('lumen', 'HorizontalPodAutoscaler', 'default', 'shop') && ranK(t, /kubectl\s+describe\s+(hpa|horizontalpodautoscaler)/) },
          { title: 'Give the shop container CPU and memory requests (`cpu=100m,memory=128Mi`) so the HPA can measure it', solution: 'kubectl set resources deployment shop --requests=cpu=100m,memory=128Mi && kubectl rollout status deploy/shop && sleep 20 && kubectl get hpa', check: t => !!tplOf(dep(t, 'default', 'shop')).resources?.requests?.cpu && t.kobj('lumen', 'HorizontalPodAutoscaler', 'default', 'shop')?.status.currentUtilization != null },
          { title: 'The sale starts. Watch the HPA scale the shop out (check `kubectl get hpa` and the pods over a minute)', allowEarly: true, solution: 'sleep 30; kubectl get hpa; sleep 30; kubectl get hpa; kubectl get pods -l app=shop', check: t => (dep(t, 'default', 'shop')?.spec.replicas || 0) >= 5 && readyN(t, 'default', 'app=shop') >= 5 && t.events('k8s-scale').some(e => e.by === 'hpa') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'An HPA shows `cpu: <unknown>/60%`. Most likely?', choices: ['The app is idle', 'The pods have no CPU request, so utilization cannot be computed', 'The HPA is broken', 'Max replicas reached'], answer: 1, explain: 'Utilization is relative to the request.' },
        { type: 'mc', q: 'What does a StatefulSet give pods that a Deployment does not?', choices: ['More CPU', 'Stable names (db-0), ordered startup and a PVC per pod', 'Automatic backups', 'A public IP'], answer: 1, explain: 'Stable identity plus storage.' },
        { type: 'mc', q: 'Pod `db-0` is deleted. What about its data on PVC `data-db-0`?', choices: ['Lost', 'Kept: the new db-0 mounts the same claim', 'Moved to db-1', 'Backed up automatically'], answer: 1, explain: 'The claim outlives the pod. It is not a backup, though.' },
        { type: 'tf', q: 'With an HPA managing a Deployment, keeping `replicas: 3` in the applied manifest is harmless.', answer: false, explain: 'Each apply resets the count the HPA chose.' },
        { type: 'multi', q: 'Before trusting an HPA in production:', choices: ['Set CPU requests', 'Load-test to choose target and max', 'Make sure pods start quickly', 'Remove readiness probes so pods get traffic faster'], answer: [0, 1, 2], explain: 'Readiness keeps cold pods out of rotation.' },
        { type: 'mc', q: 'Why do HPAs scale down more slowly than up?', choices: ['A bug', 'A stabilization window avoids flapping when load briefly dips', 'To save money', 'Kubernetes cannot remove pods quickly'], answer: 1, explain: 'Five minutes by default.' },
      ],
    },
    {
      id: 'kubernetes-boss',
      title: 'Boss: Tickets on Kubernetes',
      summary: 'Namespace, Secret and ConfigMap, a StatefulSet database, a probed and resourced Deployment from a private registry, Service and Ingress, a broken release and a rollback.',
      minutes: 50,
      boss: true,
      lab: {
        cwd: '~/k8s',
        panels: ['cluster', 'files'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          H.registryCreds(REG, 'ci', TOKEN);
          const app = (v, broken) => nodeApp('tickets', { env: ['DATABASE_URL'], db: true, routes: [['/', `res.send('Lumen tickets ${v}')`]], ready: broken ? "res.status(503).json({ ready: false, reason: 'schema version 7 expected, found 6' })" : null });
          H.publishImage(T_IMG('1.0.0'), app('1.0.0'), { private: true });
          H.publishImage(T_IMG('1.1.0'), app('1.1.0', true), { private: true });
          H.mkdir('laptop', '/home/dev/k8s', { owner: 'dev' });
          H.write('laptop', '~/registry-token.txt', TOKEN + '\n', { owner: 'dev', mode: 0o600 });
          H.dns('tickets.lumen.dev', c.ingressHost.ip);
        },
        suggestions: ['kubectl get ns', 'nano namespace.yaml'],
        tasks: [
          { title: 'Create the `tickets` namespace, a ConfigMap `tickets-config` (LOG_LEVEL=info) and a Secret `tickets-db` with keys `password` and `url` (postgres://tickets:<password>@db:5432/tickets), all in that namespace', solution: 'nano namespace.yaml config.yaml && kubectl apply -f namespace.yaml && kubectl apply -f config.yaml', test: [{ cmd: 'nano namespace.yaml', edit: BOSS['namespace.yaml'] }, { cmd: 'nano config.yaml', edit: BOSS['config.yaml'] }, 'kubectl apply -f namespace.yaml && kubectl apply -f config.yaml'], check: t => { const s = t.kobj('lumen', 'Secret', 'tickets', 'tickets-db'); if (!s || !t.kobj('lumen', 'ConfigMap', 'tickets', 'tickets-config')) return false; const pw = atob(s.data?.password || ''); const url = atob(s.data?.url || ''); return !!pw && url === `postgres://tickets:${pw}@db:5432/tickets`; } },
          { title: 'Run Postgres as a StatefulSet `db` in `tickets` (user `tickets`, password from the Secret, a 1Gi volumeClaimTemplate at /var/lib/postgresql/data, a `pg_isready` readiness probe) with a Service `db` on 5432', solution: 'nano db.yaml && kubectl apply -f db.yaml && kubectl get pods -n tickets', test: [{ cmd: 'nano db.yaml', edit: BOSS['db.yaml'] }, 'kubectl apply -f db.yaml && sleep 10 && kubectl get pods -n tickets'], check: t => { const s = t.kobj('lumen', 'StatefulSet', 'tickets', 'db'); const c0 = s?.spec.template.spec.containers[0] || {}; return !!s && (s.spec.volumeClaimTemplates || []).length > 0 && (c0.env || []).some(e => e.name === 'POSTGRES_PASSWORD' && e.valueFrom?.secretKeyRef?.name === 'tickets-db') && !!c0.readinessProbe && !!t.kobj('lumen', 'Service', 'tickets', 'db') && t.kready('lumen', 'tickets', 'app=db').length === 1; } },
          { title: `The images are private: create a docker-registry Secret \`regcred\` in \`tickets\` for ${REG} (user \`ci\`, the token)`, solution: `kubectl create secret docker-registry regcred -n tickets --docker-server=${REG} --docker-username=ci --docker-password=$(cat ~/registry-token.txt)`, check: t => t.kobj('lumen', 'Secret', 'tickets', 'regcred')?.type === 'kubernetes.io/dockerconfigjson' },
          { title: `Deploy the API: Deployment \`tickets\` (2 replicas, ${T_IMG('1.0.0')}, imagePullSecrets, DATABASE_URL from the Secret, envFrom the ConfigMap, requests and a memory limit, readiness on /ready and liveness on /health), a Service and an Ingress for tickets.lumen.dev`, solution: 'nano api.yaml && kubectl apply -f api.yaml && kubectl rollout status deploy/tickets -n tickets && curl -s http://tickets.lumen.dev/health', test: [{ cmd: 'nano api.yaml', edit: BOSS['api.yaml'] }, 'kubectl apply -f api.yaml && kubectl rollout status deploy/tickets -n tickets && curl -s http://tickets.lumen.dev/health'], check: t => { const d = dep(t, 'tickets', 'tickets'); const c0 = tplOf(d); return !!d && (d.spec.template.spec.imagePullSecrets || []).some(s => s.name === 'regcred') && !!c0.readinessProbe && !!c0.livenessProbe && !!c0.resources?.requests && !!c0.resources?.limits?.memory && (c0.env || []).some(e => e.valueFrom?.secretKeyRef?.name === 'tickets-db') && readyN(t, 'tickets', 'app=tickets') === 2 && httpBody(t, 'http://tickets.lumen.dev/health') !== null; } },
          { title: 'Put a ticket in the database: create table `tickets` with one row (exec into `db-0` in the `tickets` namespace)', solution: 'kubectl exec -n tickets db-0 -- psql -U tickets -c "CREATE TABLE tickets (id int, title text); INSERT INTO tickets VALUES (1, \'Projector flickers\')"', check: t => count(t, 'tickets', 'db-0', 'tickets', 'tickets') >= 1 },
          { title: `Release ${T_IMG('1.1.0')}. Watch the rollout, confirm the site stays up, and find why 1.1.0 is not ready`, solution: `kubectl set image deploy/tickets -n tickets tickets=${T_IMG('1.1.0')} && kubectl rollout status deploy/tickets -n tickets; curl -s http://tickets.lumen.dev/; kubectl describe pods -n tickets -l app=tickets | grep -i readiness`, check: t => t.events('kubectl').some(e => e.verb === 'rollout' && e.sub === 'status' && e.ok === false && e.ns === 'tickets') && t.events('http').some(e => e.host === 'laptop' && /tickets\.lumen\.dev/.test(e.url) && e.status === 200 && t.after(x => x.type === 'kubectl' && x.verb === 'set', y => y === e)) && t.after(e => e.type === 'kubectl' && e.verb === 'set', e => e.type === 'kubectl' && (e.verb === 'describe' || e.verb === 'logs' || /event/.test(e.args || ''))) },
          { title: 'Roll back, and prove the ticket survived the whole release', solution: 'kubectl rollout undo deploy/tickets -n tickets && kubectl rollout status deploy/tickets -n tickets && kubectl exec -n tickets db-0 -- psql -U tickets -c "SELECT * FROM tickets"', check: t => tplOf(dep(t, 'tickets', 'tickets')).image === T_IMG('1.0.0') && readyN(t, 'tickets', 'app=tickets') === 2 && t.kpods('lumen', 'tickets', 'app=tickets').every(p => p.spec.containers[0].image === T_IMG('1.0.0')) && count(t, 'tickets', 'db-0', 'tickets', 'tickets') >= 1 && t.after(e => e.type === 'kubectl' && e.sub === 'undo', e => e.type === 'psql' || (e.type === 'kubectl' && e.verb === 'exec')) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the objects so each one\'s dependencies exist first.', items: ['Namespace', 'Secret and ConfigMap', 'StatefulSet + Service for the database', 'Deployment for the API', 'Service and Ingress for the API'], explain: 'Pods referencing a missing Secret fail with CreateContainerConfigError.' },
        { type: 'mc', q: 'The API pods show ErrImagePull: "no basic auth credentials". Fix?', choices: ['Make the registry public', 'Create a docker-registry Secret and reference it in imagePullSecrets', 'Use :latest', 'Add a readiness probe'], answer: 1, explain: 'Private registries need pull credentials in the pod spec.' },
        { type: 'mc', q: 'During the 1.1.0 release, why did users keep getting answers?', choices: ['Luck', 'The new pods never became ready, so the rolling update kept the old ready pods serving', 'The Ingress cached responses', 'Kubernetes rolled back automatically'], answer: 1, explain: 'Readiness gating.' },
        { type: 'multi', q: 'Which made this deployment production-grade?', choices: ['Secrets for credentials', 'Probes', 'Requests and limits', 'Persistent storage for the database', 'kubectl exec to patch files in pods'], answer: [0, 1, 2, 3], explain: 'Patching live pods is lost on the next restart.' },
        { type: 'tf', q: 'After `rollout undo`, the cluster and git now disagree until you revert the manifest in git.', answer: true, explain: 'Otherwise the next pipeline run re-applies 1.1.0.' },
      ],
    },
  ],
};
