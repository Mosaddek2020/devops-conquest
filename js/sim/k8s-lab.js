// Lab helpers and checks for the Kubernetes realm.

import { registerLabExtension } from '../labext.js';
import { createCluster, parseSelector } from './k8s.js';
import { kubeconfigText } from './kubectl.js';
import { installPkg } from './packages.js';
import { parseYaml } from '../git/yaml.js';
import { installArgo } from './argocd.js';
import { installKyverno } from './kyverno.js';
import { createVault, installEso } from './vault.js';
import { platformOf } from './platform.js';

registerLabExtension({
  helpers: (uni, sh, H) => ({
    // a cluster plus a kubeconfig for `dev` on the laptop (what kind / a cloud CLI gives you)
    cluster(name = 'lumen', opts = {}) {
      const cl = createCluster(uni, name, opts);
      const laptop = uni.host('laptop');
      installPkg(laptop, uni, 'kubectl', []);
      if (opts.kubeconfig !== false) H.write('laptop', '~/.kube/config', kubeconfigText(cl, { namespace: opts.namespace }), { owner: 'dev', mode: 0o600 });
      if (opts.viewerToken) cl.tokens = { 'admin-token': 'admin', [opts.viewerToken]: 'view' };
      uni.advance(1);
      return cl;
    },
    // apply manifests during setup (YAML text, possibly multi-document, or objects)
    k8s(name, manifests, { ns = 'default', settle = 30 } = {}) {
      const cl = uni.clusters.get(name);
      const docs = typeof manifests === 'string' ? manifests.split(/^---\s*$/m).filter(x => x.trim()).map(x => parseYaml(x)) : [].concat(manifests);
      for (const d of docs) { const r = cl.apply(d, { ns }); if (r.error) throw new Error(`setup apply failed: ${r.error}`); }
      if (settle) uni.advance(settle);
      return cl;
    },
    // Argo CD in the cluster, plus its CLI on the laptop
    argocd(name = 'lumen', opts = {}) { const a = installArgo(uni.clusters.get(name), opts); installPkg(uni.host('laptop'), uni, 'argocd', []); return a; },
    kyverno(name = 'lumen') { installPkg(uni.host('laptop'), uni, 'kyverno', []); return installKyverno(uni.clusters.get(name)); },
    // a Vault server on the network (dev mode: root token printed in the lab brief)
    vault(opts = {}) { const v = createVault(uni, opts); installPkg(uni.host('laptop'), uni, 'vault', []); return v; },
    eso(name = 'lumen') { return installEso(uni.clusters.get(name)); },
    // the developer platform: services in the catalog plus deploy/incident history for DORA
    platform({ services = {}, deploys = [], incidents = [] } = {}) { const P = platformOf(uni); P.created = uni.time; for (const [n, s] of Object.entries(services)) P.services.set(n, s); P.deploys.push(...deploys); P.incidents.push(...incidents); installPkg(uni.host('laptop'), uni, 'lumen-cli', []); return P; },
    kload(name, key, millicores) { uni.clusters.get(name).load[key] = millicores; },
    settle(seconds = 30) { uni.advance(seconds); },
  }),
  checks: (uni, sh, api) => {
    const cl = name => uni.clusters.get(name) || [...uni.clusters.values()][0] || null;
    return {
      cluster: cl,
      kobj: (name, kind, ns, n) => cl(name)?.get(kind, ns, n) || null,
      kpods: (name, ns, sel = null) => cl(name)?.list('Pod', ns, typeof sel === 'string' ? parseSelector(sel) : sel).filter(p => !p.metadata.deletionTimestamp) || [],
      kready: (name, ns, sel) => { const c = cl(name); return c ? c.list('Pod', ns, typeof sel === 'string' ? parseSelector(sel) : sel).filter(p => c.podReady(p)) : []; },
      kapp: (name, app) => cl(name)?.get('Application', cl(name)?.argocd?.ns || 'argocd', app) || null,
      kran: (re) => api.events('kubectl').some(e => re.test(`${e.verb} ${e.args || ''}`)),
    };
  },
});
