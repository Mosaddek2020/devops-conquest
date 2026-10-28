// Platform scenario: RBAC, NetworkPolicies, Kustomize, Helm, Argo CD, Kyverno, Vault,
// External Secrets and SOPS on a simulated cluster.
import '../js/sim/index.js';
import { Session } from '../js/sim/session.js';
import { buildLabWorld } from '../js/lab.js';
import { stripAnsi } from '../js/git/world.js';

let fails = 0;
const only = process.argv.slice(2).find(a => !a.startsWith('-'));
const verbose = process.argv.includes('-v');
function scenario(name, setup, steps) {
  if (only && !name.includes(only)) return;
  console.log(`\n# ${name}`);
  const { uni, sh, H } = buildLabWorld({ setup, cwd: '~' });
  const run = (cmd, expect, not, { edit } = {}) => {
    let r = sh.run(cmd);
    if (r.editor && edit !== undefined) r = sh.resolveEditor(r.editor, typeof edit === 'function' ? edit(r.editor.content) : edit);
    const out = r.out.map(stripAnsi).join('\n');
    const ok = (!expect || (expect instanceof RegExp ? expect.test(out) : out.includes(expect))) && (!not || !(not instanceof RegExp ? not.test(out) : out.includes(not)));
    if (!ok) { fails++; console.log(`✗ ${cmd}\n${out.split('\n').map(l => '    ' + l).join('\n')}`); }
    else console.log(`✓ ${cmd.split('\n')[0]}`);
    if (verbose) console.log(out.split('\n').map(l => '    ' + l).join('\n'));
    return out;
  };
  steps({ run, uni, sh, H, as: (host, user) => new Session(uni, uni.host(host), { user }) });
}

const W = (path, text) => `cat > ${path} <<'EOF'\n${text}\nEOF`;

scenario('rbac', H => { H.cluster('lumen'); }, ({ run }) => {
  run('kubectl auth whoami', /kubernetes-admin[\s\S]*system:masters/);
  run('kubectl create namespace shop', 'namespace/shop created');
  run('kubectl get sa -n shop', /default\s+0/);
  run('kubectl create serviceaccount ci-deployer -n shop', 'serviceaccount/ci-deployer created');
  run('kubectl auth can-i create deployments -n shop --as system:serviceaccount:shop:ci-deployer', /^no$/m);
  run('kubectl create role deployer -n shop --verb=get,list,watch,create,update,patch --resource=deployments.apps,services,configmaps', 'role.rbac.authorization.k8s.io/deployer created');
  run('kubectl describe role deployer -n shop', /deployments\.apps\s+\[\]\s+\[\]\s+\[get list watch create update patch\]/);
  run('kubectl create rolebinding ci-deployer -n shop --role=deployer --serviceaccount=shop:ci-deployer', 'rolebinding.rbac.authorization.k8s.io/ci-deployer created');
  run('kubectl auth can-i create deployments -n shop --as system:serviceaccount:shop:ci-deployer', /^yes$/m);
  run('kubectl auth can-i delete deployments -n shop --as system:serviceaccount:shop:ci-deployer', /^no$/m);
  run('kubectl auth can-i get secrets -n shop --as system:serviceaccount:shop:ci-deployer', /^no$/m);
  run('kubectl auth can-i create deployments -n default --as system:serviceaccount:shop:ci-deployer', /^no$/m);
  run('kubectl auth can-i --list -n shop --as system:serviceaccount:shop:ci-deployer', /deployments\.apps/);
  run('TOKEN=$(kubectl create token ci-deployer -n shop) && kubectl config set-credentials ci --token=$TOKEN && kubectl config set-context ci --cluster=kind-lumen --user=ci --namespace=shop', /Context "ci" created/);
  run('kubectl --context ci get pods', /pods is forbidden: User "system:serviceaccount:shop:ci-deployer" cannot list resource "pods" in API group "" in the namespace "shop"/);
  run('kubectl --context ci create deployment web --image=nginx:1.27', 'deployment.apps/web created');
  run('kubectl --context ci delete deployment web', /cannot delete resource "deployments" in API group "apps"/);
  run('kubectl --context ci get deploy -n default', /in the namespace "default"/);
  run(W('dep.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 1\n  selector:\n    matchLabels: {app: api}\n  template:\n    metadata:\n      labels: {app: api}\n    spec:\n      containers:\n        - name: api\n          image: nginx:1.27') + '\nkubectl --context ci apply -f dep.yaml', 'deployment.apps/api created');
  run(W('sec.yaml', 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\nstringData:\n  a: b') + '\nkubectl --context ci apply -f sec.yaml', /error when creating "sec.yaml": secrets "x" is forbidden/);
  run('kubectl create clusterrolebinding oops --clusterrole=cluster-admin --serviceaccount=shop:ci-deployer', 'created');
  run('kubectl --context ci delete deployment web', 'deleted');
  run('kubectl get clusterrolebindings -o wide', /oops\s+ClusterRole\/cluster-admin[\s\S]*shop\/ci-deployer/);
  run('kubectl delete clusterrolebinding oops', 'deleted');
  run('kubectl --context ci delete deployment api', /forbidden/);
  run('kubectl --as=system:serviceaccount:shop:ci-deployer auth whoami', /system:serviceaccount:shop:ci-deployer/);
});

scenario('netpol', H => {
  H.cluster('lumen', { ingress: true });
  H.k8s('lumen', [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'api', namespace: 'shop' }, spec: { replicas: 1, selector: { matchLabels: { app: 'api' } }, template: { metadata: { labels: { app: 'api', tier: 'backend' } }, spec: { containers: [{ name: 'api', image: 'hashicorp/http-echo:1.0', args: ['-text=api ok'], ports: [{ name: 'http', containerPort: 5678 }] }] } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'api', namespace: 'shop' }, spec: { selector: { app: 'api' }, ports: [{ port: 80, targetPort: 'http' }] } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'shop' }, spec: { replicas: 1, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'nginx:1.27', ports: [{ containerPort: 80 }] }] } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'shop' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'web', namespace: 'shop' }, spec: { ingressClassName: 'nginx', rules: [{ host: 'shop.lumen.dev', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } },
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'tools' } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'debug', namespace: 'tools' }, spec: { replicas: 1, selector: { matchLabels: { app: 'debug' } }, template: { metadata: { labels: { app: 'debug' } }, spec: { containers: [{ name: 'debug', image: 'nginx:1.27' }] } } } },
  ], { settle: 40 });
  H.dns('shop.lumen.dev', H.uni.clusters.get('lumen').ingressHost.ip);
}, ({ run }) => {
  run('kubectl exec -n shop deploy/web -- curl -s -m 2 api', 'api ok');
  run('kubectl exec -n tools deploy/debug -- curl -s -m 2 api.shop', 'api ok');
  run(W('deny.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny-ingress\n  namespace: shop\nspec:\n  podSelector: {}\n  policyTypes: ["Ingress"]') + '\nkubectl apply -f deny.yaml', 'networkpolicy.networking.k8s.io/default-deny-ingress created');
  run('kubectl exec -n shop deploy/web -- curl -s -m 2 api', /timed out|exit code 28/);
  run('curl -s -m 2 http://shop.lumen.dev/', /timed out|504|502/);
  run(W('allow.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: api-from-web\n  namespace: shop\nspec:\n  podSelector:\n    matchLabels:\n      app: api\n  ingress:\n    - from:\n        - podSelector:\n            matchLabels:\n              app: web\n      ports:\n        - port: http\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: web-from-ingress\n  namespace: shop\nspec:\n  podSelector:\n    matchLabels:\n      app: web\n  ingress:\n    - from:\n        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: ingress-nginx\n      ports:\n        - port: 80') + '\nkubectl apply -f allow.yaml', 'created');
  run('kubectl exec -n shop deploy/web -- curl -s -m 2 api', 'api ok');
  run('kubectl exec -n tools deploy/debug -- curl -s -m 2 api.shop', /timed out|exit code 28/);
  run('curl -s -m 2 http://shop.lumen.dev/', 'Welcome to nginx');
  run('kubectl get netpol -n shop', /api-from-web\s+app=api/);
  run('kubectl describe netpol api-from-web -n shop', /PodSelector: app=web/);
  run('kubectl get pods -n shop', /Running/);
});

scenario('kustomize', H => { H.cluster('lumen'); }, ({ run }) => {
  run('mkdir -p app/base app/overlays/prod');
  run(W('app/base/deployment.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27\n          envFrom:\n            - configMapRef:\n                name: web-config'));
  run(W('app/base/service.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector:\n    app: web\n  ports:\n    - port: 80'));
  run(W('app/base/kustomization.yaml', 'resources:\n  - deployment.yaml\n  - service.yaml\nconfigMapGenerator:\n  - name: web-config\n    literals:\n      - LOG_LEVEL=debug'));
  run(W('app/overlays/prod/kustomization.yaml', 'namespace: shop-prod\nnamePrefix: prod-\nresources:\n  - ../../base\nreplicas:\n  - name: web\n    count: 3\nimages:\n  - name: nginx\n    newTag: 1.27-alpine\nlabels:\n  - pairs:\n      env: prod\nconfigMapGenerator:\n  - name: web-config\n    behavior: merge\n    literals:\n      - LOG_LEVEL=warn\npatches:\n  - target:\n      kind: Deployment\n      name: web\n    patch: |-\n      - op: add\n        path: /spec/template/spec/containers/0/resources\n        value:\n          limits:\n            memory: 256Mi'));
  run('kubectl kustomize app/base', /name: web-config-[a-z0-9]{10}[\s\S]*name: web-config-/);
  const out = run('kubectl kustomize app/overlays/prod', /namespace: shop-prod/);
  if (!/name: prod-web-config-/.test(out) || !/image: nginx:1.27-alpine/.test(out) || !/replicas: 3/.test(out) || !/LOG_LEVEL: warn/.test(out) || !/memory: 256Mi/.test(out) || !/env: prod/.test(out)) { fails++; console.log('✗ overlay content wrong'); }
  run('kubectl create namespace shop-prod && kubectl apply -k app/overlays/prod', /deployment.apps\/prod-web created/);
  run('sleep 20; kubectl get pods -n shop-prod', /prod-web-.*Running/);
  run('kubectl diff -k app/overlays/prod; echo "exit=$?"', 'exit=0');
  run('sed -i "s/count: 3/count: 4/" app/overlays/prod/kustomization.yaml && kubectl diff -k app/overlays/prod', /-  replicas: 3\n\+  replicas: 4/);
  run('kubectl kustomize app/nope', /must build at directory: not a valid directory/);
  run('kubectl kustomize app', /unable to find one of 'kustomization.yaml'/);
});


scenario('helm', H => { H.cluster('lumen'); H.install('laptop', 'helm'); }, ({ run }) => {
  run('helm version', /v3\.16\.2/);
  run('helm install cache bitnami/redis', /Error: INSTALLATION FAILED: repo bitnami not found/);
  run('helm repo add bitnami https://charts.bitnami.com/bitnami', '"bitnami" has been added');
  run('helm repo update', 'Update Complete');
  run('helm search repo redis', /bitnami\/redis\s+20\.2\.1\s+7\.4\.1/);
  run('helm show values bitnami/redis', /architecture: standalone/);
  run('helm template cache bitnami/redis --set architecture=replication --show-only templates/replicas.yaml', /name: cache-redis-replicas[\s\S]*replicas: 3/);
  run('helm install cache bitnami/redis -n data --create-namespace --set master.persistence.size=1Gi --wait', /STATUS: deployed[\s\S]*REVISION: 1[\s\S]*export REDIS_PASSWORD/);
  run('helm list -n data', /cache\s+data\s+1\s+.*deployed\s+redis-20\.2\.1\s+7\.4\.1/);
  run('kubectl get pods -n data', /cache-redis-master-0\s+1\/1\s+Running/);
  run('kubectl get secret -n data', /sh\.helm\.release\.v1\.cache\.v1\s+helm\.sh\/release\.v1/);
  run('helm get values cache -n data', /USER-SUPPLIED VALUES:[\s\S]*size: 1Gi/);
  run('helm upgrade cache bitnami/redis -n data --set architecture=replication --set replica.replicaCount=2', /has been upgraded[\s\S]*REVISION: 2/);
  run('helm get values cache -n data', /architecture: replication/, /size: 1Gi/);
  run('sleep 30; kubectl get sts -n data', /cache-redis-replicas\s+2\/2/);
  run('helm history cache -n data', /1\s+.*superseded[\s\S]*2\s+.*deployed/);
  run('helm rollback cache 1 -n data', 'Rollback was a success');
  run('helm history cache -n data', /3\s+.*deployed\s+redis-20\.2\.1\s+7\.4\.1\s+Rollback to 1/);
  run('sleep 10; kubectl get sts -n data', /cache-redis-master/, /replicas/);
  run('helm create shop', 'Creating shop');
  run('helm lint shop', '1 chart(s) linted, 0 chart(s) failed');
  run('helm template prod ./shop --set ingress.enabled=true --set ingress.host=shop.lumen.dev', /kind: Ingress[\s\S]*host: shop.lumen.dev/);
  run('helm install web ./shop --set image.tag=1.27 --wait --timeout 2m', /STATUS: deployed/);
  run('helm upgrade web ./shop --set image.tag=9.9-missing --atomic --timeout 60s', /rolled back due to atomic being set: context deadline exceeded/);
  run('helm history web', /2\s+.*failed[\s\S]*3\s+.*deployed.*Rollback to 1/);
  run('kubectl create deployment taken --image=nginx:1.27 && helm install taken ./shop --set nameOverride=x --set fullnameOverride=taken', /exists and cannot be imported into the current release|deployed/);
  run('helm uninstall web', 'release "web" uninstalled');
  run('kubectl get deploy web-shop', /NotFound/);
});

const DEP = (img, replicas = 2) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: ${replicas}\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n        - name: web\n          image: ${img}\n          ports:\n            - containerPort: 80\n`;
const SVC = 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector:\n    app: web\n  ports:\n    - port: 80\n';
scenario('argocd', H => {
  H.cluster('lumen');
  H.argocd('lumen');
  H.remote('lumen', 'gitops', [{ message: 'shop: initial manifests', files: { 'apps/shop/deployment.yaml': DEP('nginx:1.27'), 'apps/shop/service.yaml': SVC, 'apps/shop/kustomization.yaml': 'resources:\n  - deployment.yaml\n  - service.yaml\n', 'apps/blog/deployment.yaml': DEP('nginx:1.27-alpine', 1).replace(/web/g, 'blog'), 'README.md': '# Lumen GitOps\n' } }], { collaborators: ['you'] });
}, ({ run }) => {
  run('argocd app list', /Argo CD server address unspecified/);
  run('kubectl get pods -n argocd', /argocd-server-.*Running/);
  run('PW=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d) && echo got-$PW', /got-adm-/);
  run('kubectl port-forward svc/argocd-server -n argocd 8080:443', /Forwarding from 127.0.0.1:8080 -> 8080/);
  run('argocd login localhost:8080 --username admin --password wrong --insecure', /Invalid username or password/);
  run('argocd login localhost:8080 --username admin --password $(argocd admin initial-password -n argocd | head -1) --insecure', /logged in successfully/);
  run('argocd app create shop --repo https://github.com/lumen/gitops.git --path apps/shop --dest-server https://kubernetes.default.svc --dest-namespace shop --sync-option CreateNamespace=true', "application 'shop' created");
  run('argocd app get shop', /Sync Status:\s+OutOfSync[\s\S]*Deployment\s+shop\s+web\s+OutOfSync\s+Missing/);
  run('argocd app sync shop', /Phase:\s+Succeeded[\s\S]*deployment.apps\/web created/);
  run('sleep 20; argocd app get shop', /Sync Status:\s+Synced[\s\S]*Health Status:\s+Healthy/);
  run('kubectl get deploy -n shop web --show-labels', /app.kubernetes.io\/instance=shop/);
  run('kubectl scale deploy web -n shop --replicas=5 && sleep 2 && argocd app get shop', /Sync Status:\s+OutOfSync/);
  run('argocd app diff shop', /<\s+replicas: 5\n---\n>\s+replicas: 2/);
  run('argocd app set shop --sync-policy automated --self-heal --auto-prune && sleep 10 && kubectl get deploy -n shop web', /web\s+2\/2/);
  run('argocd app get shop --refresh > /dev/null && git clone -q https://github.com/lumen/gitops.git && cd gitops && sed -i "s#nginx:1.27\\$#nginx:1.27-alpine#" apps/shop/deployment.yaml && git commit -qam "shop: alpine image" && git push -q && cd ..');
  run('sleep 180; kubectl get deploy -n shop web -o jsonpath="{.spec.template.spec.containers[0].image}"', 'nginx:1.27-alpine');
  run('argocd app history shop', /0\s+.*HEAD \([0-9a-f]{7}\)\n1\s+/);
  run('argocd app rollback shop 0', /rollback cannot be initiated when auto-sync is enabled/);
  run('cd gitops && git rm -q apps/shop/service.yaml && sed -i "/service.yaml/d" apps/shop/kustomization.yaml && git commit -qam "shop: drop service" && git push -q && cd .. && argocd app get shop --refresh >/dev/null && sleep 4 && kubectl get svc -n shop', /No resources found/);
  run(W('set.yaml', 'apiVersion: argoproj.io/v1alpha1\nkind: ApplicationSet\nmetadata:\n  name: apps\n  namespace: argocd\nspec:\n  generators:\n    - git:\n        repoURL: https://github.com/lumen/gitops.git\n        revision: HEAD\n        directories:\n          - path: apps/*\n          - path: apps/shop\n            exclude: true\n  template:\n    metadata:\n      name: "{{path.basename}}"\n    spec:\n      project: default\n      source:\n        repoURL: https://github.com/lumen/gitops.git\n        targetRevision: HEAD\n        path: "{{path}}"\n      destination:\n        server: https://kubernetes.default.svc\n        namespace: "{{path.basename}}"\n      syncPolicy:\n        automated:\n          prune: true\n          selfHeal: true\n        syncOptions:\n          - CreateNamespace=true') + '\nkubectl apply -f set.yaml', 'applicationset.argoproj.io/apps created');
  run('sleep 20; kubectl get applications -n argocd', /blog\s+Synced\s+Healthy[\s\S]*shop\s+Synced\s+Healthy/);
  run('kubectl get pods -n blog', /blog-.*Running/);
  run('argocd app delete shop -y && kubectl get deploy -n shop', /No resources found/);
});

const POL = action => `apiVersion: kyverno.io/v1\nkind: ClusterPolicy\nmetadata:\n  name: require-limits\nspec:\n  validationFailureAction: ${action}\n  background: true\n  rules:\n    - name: check-limits\n      match:\n        any:\n          - resources:\n              kinds:\n                - Pod\n      validate:\n        message: "CPU and memory limits are required."\n        pattern:\n          spec:\n            containers:\n              - resources:\n                  limits:\n                    memory: "?*"\n                    cpu: "?*"\n---\napiVersion: kyverno.io/v1\nkind: ClusterPolicy\nmetadata:\n  name: disallow-latest-tag\nspec:\n  validationFailureAction: ${action}\n  rules:\n    - name: require-image-tag\n      match:\n        any:\n          - resources:\n              kinds:\n                - Pod\n      validate:\n        message: "An image tag is required and it must not be latest."\n        pattern:\n          spec:\n            containers:\n              - image: "*:* & !*:latest"\n`;
scenario('kyverno', H => { H.cluster('lumen'); H.install('laptop', 'helm', 'kyverno'); }, ({ run }) => {
  run('mkdir -p policies k8s');
  run(W('policies/policies.yaml', POL('Audit')));
  run(W('k8s/web.yaml', DEP('nginx:latest', 1)));
  run(W('k8s/api.yaml', DEP('nginx:1.27', 1).replace(/web/g, 'api').replace('          ports:', '          resources:\n            limits:\n              cpu: 200m\n              memory: 128Mi\n          ports:')));
  run('kubectl apply -f policies/policies.yaml', /no matches for kind "ClusterPolicy"/);
  run('helm repo add kyverno https://kyverno.github.io/kyverno && helm install kyverno kyverno/kyverno -n kyverno --create-namespace', /STATUS: deployed[\s\S]*Kyverno version: v1.13.0/);
  run('kyverno apply policies/ --resource k8s/', /policy require-limits -> resource default\/Deployment\/web failed:\n1\. autogen-check-limits: validation error: CPU and memory limits are required\. rule autogen-check-limits failed at path \/spec\/template\/spec\/containers\/0\/resources\/[\s\S]*pass: 2, fail: 2/);
  run('kubectl apply -f policies/policies.yaml', /clusterpolicy.kyverno.io\/require-limits created/);
  run('kubectl apply -f k8s/', /deployment.apps\/web created/);
  run('sleep 35; kubectl get policyreport', /polr-ns-default\s+2\s+2/);
  run(W('policies/policies.yaml', POL('Enforce')) + '\nkubectl apply -f policies/policies.yaml', 'configured');
  run('kubectl delete deploy web && kubectl apply -f k8s/web.yaml', /admission webhook "validate.kyverno.svc-fail" denied the request[\s\S]*require-limits:\n  autogen-check-limits: 'validation error: CPU and memory limits are required/);
  run('kubectl run test --image=nginx:latest', /disallow-latest-tag/);
  run('kubectl get clusterpolicy', /require-limits\s+true\s+true\s+True/);
});

scenario('vault-eso', H => {
  H.cluster('lumen'); H.install('laptop', 'helm');
  H.vault({ rootToken: 'root-dev-token' });
  H.k8s('lumen', [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } }, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'shop', namespace: 'shop' } }]);
}, ({ run }) => {
  run('vault status', /server gave HTTP response to HTTPS client|connection refused/);
  run('export VAULT_ADDR=http://vault.lumen.internal:8200 && vault status', /Sealed\s+false/);
  run('vault kv put secret/shop/db password=s3cret-1', /Error: missing client token|permission denied/);
  run('vault login root-dev-token', /Success! You are now authenticated/);
  run('vault kv put secret/shop/db password=s3cret-1 username=shop', /version\s+1/);
  run('vault kv get -field=password secret/shop/db', /^s3cret-1$/m);
  run(W('shop-read.hcl', 'path "secret/data/shop/*" {\n  capabilities = ["read"]\n}') + '\nvault policy write shop-read shop-read.hcl', 'Success! Uploaded policy: shop-read');
  run('T=$(vault token create -policy=shop-read -field=token 2>/dev/null || vault token create -policy=shop-read | awk \'/^token /{print $2}\') && VAULT_TOKEN=$T vault kv get -field=username secret/shop/db && VAULT_TOKEN=$T vault kv put secret/shop/db password=hack', /shop[\s\S]*permission denied/);
  run('vault auth enable kubernetes && vault write auth/kubernetes/role/shop bound_service_account_names=shop bound_service_account_namespaces=shop policies=shop-read ttl=1h', /Data written to: auth\/kubernetes\/role\/shop/);
  run('helm repo add external-secrets https://charts.external-secrets.io && helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace', /STATUS: deployed/);
  run(W('store.yaml', 'apiVersion: external-secrets.io/v1beta1\nkind: SecretStore\nmetadata:\n  name: vault\n  namespace: shop\nspec:\n  provider:\n    vault:\n      server: http://vault.lumen.internal:8200\n      path: secret\n      version: v2\n      auth:\n        kubernetes:\n          mountPath: kubernetes\n          role: shop\n          serviceAccountRef:\n            name: shop\n---\napiVersion: external-secrets.io/v1beta1\nkind: ExternalSecret\nmetadata:\n  name: db\n  namespace: shop\nspec:\n  refreshInterval: 1m\n  secretStoreRef:\n    name: vault\n    kind: SecretStore\n  target:\n    name: db-credentials\n  data:\n    - secretKey: password\n      remoteRef:\n        key: shop/db\n        property: password') + '\nkubectl apply -f store.yaml', 'externalsecret.external-secrets.io/db created');
  run('sleep 5; kubectl get externalsecret -n shop', /db\s+vault\s+1m\s+SecretSynced\s+True/);
  run('kubectl get secret db-credentials -n shop -o jsonpath="{.data.password}" | base64 -d', 's3cret-1');
  run('vault kv put secret/shop/db password=s3cret-2 username=shop && sleep 70 && kubectl get secret db-credentials -n shop -o jsonpath="{.data.password}" | base64 -d', 's3cret-2');
  run('kubectl get secretstore -n shop', /vault\s+\S+\s+Valid\s+ReadWrite\s+True/);
  run(W('es2.yaml', 'apiVersion: external-secrets.io/v1beta1\nkind: ExternalSecret\nmetadata:\n  name: payments\n  namespace: shop\nspec:\n  refreshInterval: 1m\n  secretStoreRef:\n    name: vault\n  target:\n    name: payments\n  data:\n    - secretKey: key\n      remoteRef:\n        key: payments/stripe\n        property: key') + '\nvault kv put secret/payments/stripe key=abc >/dev/null && kubectl apply -f es2.yaml && sleep 5 && kubectl describe externalsecret payments -n shop', /SecretSyncedError[\s\S]*permission denied/);
});

scenario('sops', H => { H.install('laptop', 'sops', 'age'); }, ({ run }) => {
  run('age-keygen -o key.txt', /Public key: age1[0-9a-z]{58}/);
  run(W('secret.yaml', 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\nstringData:\n  password: hunter2-prod\n  port: 5432'));
  run('sops --encrypt --age $(age-keygen -y key.txt) --encrypted-regex "^(data|stringData)$" secret.yaml > secret.enc.yaml && cat secret.enc.yaml', /name: db[\s\S]*password: ENC\[AES256_GCM,data:/, 'hunter2-prod');
  run('sops -d secret.enc.yaml', /failed to load age identities/);
  run('mkdir -p ~/.config/sops/age && cp key.txt ~/.config/sops/age/keys.txt && sops -d secret.enc.yaml', /password: hunter2-prod\n\s*port: 5432/);
  run('sed -i "s/name: db/name: db2/" secret.enc.yaml && sops -d secret.enc.yaml', /MAC mismatch/);
  run(W('.sops.yaml', 'creation_rules:\n  - path_regex: .*\\.enc\\.yaml$\n    encrypted_regex: ^(data|stringData)$\n    age: ' + 'PUB') + '\nsed -i "s/PUB/$(age-keygen -y key.txt)/" .sops.yaml && cp secret.yaml s2.enc.yaml && sops -e -i s2.enc.yaml && grep -c "ENC\\[" s2.enc.yaml', /^3$/m);
  run('sops s2.enc.yaml', null, null);
});

process.on('exit', () => { console.log(fails ? `\n${fails} failures` : '\nall platform scenarios passed'); });
process.exitCode = 0;
setTimeout(() => { process.exitCode = fails ? 1 : 0; }, 0);
