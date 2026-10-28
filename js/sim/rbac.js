// Kubernetes RBAC for the simulated clusters: who a request comes from (a kubeconfig token,
// a service-account token, or --as impersonation) and whether any Role or ClusterRole bound
// to that identity allows the verb on the resource. Denials read like the API server's.

const masters = { user: 'kubernetes-admin', groups: ['system:masters', 'system:authenticated'] };

export const saUser = (ns, name) => `system:serviceaccount:${ns}:${name}`;
export function saIdentity(ns, name) { return { user: saUser(ns, name), groups: ['system:serviceaccounts', `system:serviceaccounts:${ns}`, 'system:authenticated'] }; }

// token -> identity. Clusters without a token table trust everyone as admin (a lab default).
// Legacy labs map tokens to 'admin' or 'view'; newer ones map them to { user, groups }.
export function identityFor(cl, token) {
  if (cl.saTokens.has(token)) return cl.saTokens.get(token);
  if (!cl.tokens) return masters;
  const t = cl.tokens[token];
  if (!t) return null;
  if (t === 'admin') return masters;
  if (t === 'view') return { user: null, groups: ['system:authenticated'], legacyView: true };
  return { user: t.user, groups: [...(t.groups || []), 'system:authenticated'] };
}

// a fresh JWT-shaped service-account token (built at run time; nothing secret-shaped in source)
export function issueToken(cl, ns, sa, { seconds = 3600 } = {}) {
  const enc = o => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const n = cl.saTokens.size + 1;
  const token = ['eyJhbGciOiJSUzI1NiIsImtpZCI6Im', enc({ aud: ['https://kubernetes.default.svc'], exp: cl.uni.time + seconds, iss: 'https://kubernetes.default.svc', sub: saUser(ns, sa), n })].join('') + '.' + enc({ sig: cl.name + n }).slice(0, 43);
  cl.saTokens.set(token, saIdentity(ns, sa));
  return token;
}

const subjectMatches = (s, ident, bindingNs) => {
  if (s.kind === 'User') return s.name === ident.user;
  if (s.kind === 'Group') return ident.groups.includes(s.name);
  if (s.kind === 'ServiceAccount') return ident.user === saUser(s.namespace || bindingNs, s.name);
  return false;
};

// the rules that apply to an identity in a namespace (cluster-wide bindings always count)
export function rulesFor(cl, ident, ns) {
  const out = [];
  const roleRules = (ref, bindingNs) => {
    const r = ref.kind === 'ClusterRole' ? cl.get('ClusterRole', null, ref.name) : cl.get('Role', bindingNs, ref.name);
    return r?.rules || [];
  };
  for (const b of cl.list('ClusterRoleBinding')) if ((b.subjects || []).some(s => subjectMatches(s, ident, null))) out.push(...roleRules(b.roleRef, null).map(r => ({ ...r, via: `ClusterRoleBinding/${b.metadata.name}` })));
  if (ns) for (const b of cl.list('RoleBinding', ns)) if ((b.subjects || []).some(s => subjectMatches(s, ident, ns))) out.push(...roleRules(b.roleRef, ns).map(r => ({ ...r, via: `RoleBinding/${b.metadata.name}` })));
  return out;
}

const has = (list, v) => (list || []).includes('*') || (list || []).includes(v);
export function ruleAllows(r, { verb, resource, group, name }) {
  if (!has(r.verbs, verb)) return false;
  if (!(r.apiGroups || []).includes('*') && !(r.apiGroups || []).includes(group || '')) return false;
  const base = resource.split('/')[0];
  if (!has(r.resources, resource) && !(resource.includes('/') ? false : has(r.resources, base)) && !(r.resources || []).includes(`${base}/*`) && !(r.resources || []).includes(`*/${resource.split('/')[1]}`)) return false;
  if (r.resourceNames?.length && !(name && r.resourceNames.includes(name))) return false;
  return true;
}

export function authorize(cl, ident, req) {
  if (!ident) return false;
  if (ident.groups.includes('system:masters')) return true;
  return rulesFor(cl, ident, req.ns).some(r => ruleAllows(r, req));
}

export function forbidden(ident, { verb, resource, group, ns, name }) {
  const [res, sub] = resource.split('/');
  const what = group ? `${res}.${group}` : res;
  const target = name ? `${what} "${name}"` : what;
  return `${sub ? `${target}` : target} is forbidden: User "${ident.user}" cannot ${verb} resource "${resource}" in API group "${group || ''}"${ns ? ` in the namespace "${ns}"` : ' at the cluster scope'}`;
}
