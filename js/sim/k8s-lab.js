// Lab helpers and checks for the Kubernetes realm.

import { registerLabExtension } from '../labext.js';
import { createCluster, parseSelector } from './k8s.js';
import { kubeconfigText } from './kubectl.js';
import { installPkg } from './packages.js';
import { parseYaml } from '../git/yaml.js';

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
      kran: (re) => api.events('kubectl').some(e => re.test(`${e.verb} ${e.args || ''}`)),
    };
  },
});
