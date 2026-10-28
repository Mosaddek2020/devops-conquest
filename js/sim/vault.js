// HashiCorp Vault and the External Secrets Operator. A Vault server (a host on the
// network, port 8200) keeps a KV v2 store with versions, ACL policies, tokens and a
// Kubernetes auth method; the vault CLI talks to it through VAULT_ADDR and VAULT_TOKEN
// (or ~/.vault-token) and gets the same 403s a real one gives. In a cluster, ExternalSecrets
// read Vault through a SecretStore and write ordinary Kubernetes Secrets, refreshing them
// on an interval, so a rotation in Vault reaches the cluster without anyone touching it.

import { def } from './registry.js';
import { parseYaml } from '../git/yaml.js';
import { toYaml, table, PRINTERS, DESCRIBERS, age } from './kubectl.js';
import { clone, iso } from './k8s.js';
import { crdYaml, ESO_CRDS, CHART_HOOKS } from './helm-charts.js';
import { httpRequest, connect } from './net.js';
import { saUser } from './rbac.js';

const isoT = t => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, '.000000Z');
const rand = (seed, n, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') => { let x = (seed * 2654435761) >>> 0 || 1; let s = ''; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; s += alphabet[x % alphabet.length]; } return s; };

// ---------------------------------------------------------------- policies
export function parsePolicy(text) {
  const rules = [];
  const re = /path\s+"([^"]+)"\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const caps = (m[2].match(/capabilities\s*=\s*\[([^\]]*)\]/)?.[1] || '').split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    rules.push({ path: m[1], caps });
  }
  if (!rules.length && String(text).trim()) throw new Error('failed to parse policy: no path blocks found');
  return rules;
}
const pathMatches = (pattern, path) => {
  const re = '^' + pattern.split('').map(ch => ch === '+' ? '[^/]+' : /[.^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch).join('').replace(/\*$/, '.*') + '$';
  return new RegExp(re).test(path);
};
function allowed(vault, token, path, cap) {
  const t = vault.tokens.get(token);
  if (!t) return false;
  if (t.policies.includes('root')) return true;
  let best = null;
  for (const pn of t.policies) for (const r of vault.policies.get(pn)?.rules || []) if (pathMatches(r.path, path)) { const spec = r.path.replace(/\*$/, '').length + (r.path.endsWith('*') ? 0 : 1000); if (!best || spec > best.spec) best = { spec, caps: r.caps }; }
  if (!best || best.caps.includes('deny')) return false;
  return best.caps.includes(cap) || (cap === 'update' && best.caps.includes('create'));
}

// ---------------------------------------------------------------- the server
export function createVault(uni, { name = 'vault', hostname = 'vault.lumen.internal', rootToken = null } = {}) {
  const h = uni.addHost(name, { kind: 'vm' });
  uni.dns.set(hostname, h.ip);
  const root = rootToken || ['hvs', rand(uni.time + 11, 24)].join('.');
  const vault = { host: h, hostname, addr: `http://${hostname}:8200`, root, tokens: new Map([[root, { policies: ['root'], created: uni.time, ttl: 0, accessor: rand(5, 24), display: 'root' }]]), policies: new Map([['default', { text: '# default policy\npath "auth/token/lookup-self" {\n  capabilities = ["read"]\n}\n', rules: [{ path: 'auth/token/lookup-self', caps: ['read'] }] }]]), kv: { secret: new Map() }, auth: { token: true, kubernetes: null }, audit: [] };
  uni.vaults = uni.vaults || new Map();
  uni.vaults.set(hostname, vault);
  const prog = {
    kind: 'vault', vault,
    handle(req) {
      const tok = req.headers['x-vault-token'];
      const p = req.path.replace(/^\/v1\//, '');
      const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (p === 'sys/health') return json(200, { initialized: true, sealed: false, standby: false, version: '1.18.1', cluster_name: 'vault-cluster-lumen' });
      if (p.startsWith('secret/data/')) {
        const key = p.slice(12);
        if (req.method === 'GET') { if (!allowed(vault, tok, p, 'read')) return json(403, { errors: ['1 error occurred:\n\t* permission denied\n\n'] }); const e = vault.kv.secret.get(key); if (!e) return json(404, { errors: [] }); const v = e.versions[e.current - 1]; return json(200, { data: { data: v.data, metadata: { created_time: isoT(v.created), version: e.current } } }); }
        if (!allowed(vault, tok, p, 'update')) return json(403, { errors: ['1 error occurred:\n\t* permission denied\n\n'] });
        let body; try { body = JSON.parse(req.body || '{}'); } catch { return json(400, { errors: ['failed to parse JSON input'] }); }
        const r = kvPut(uni, vault, key, body.data || {});
        return json(200, { data: { version: r.version, created_time: isoT(uni.time) } });
      }
      return json(404, { errors: [] });
    },
  };
  const proc = h.addProc({ cmd: 'vault server -config=/etc/vault.d/vault.hcl', user: 'vault', mem: 180, program: prog });
  h.listen(8200, proc.pid, { addr: '0.0.0.0', program: prog });
  return vault;
}
function kvPut(uni, vault, key, data, { patch = false } = {}) {
  const e = vault.kv.secret.get(key) || { versions: [], current: 0, created: uni.time };
  const prev = e.current ? e.versions[e.current - 1].data : {};
  e.versions.push({ data: patch ? { ...prev, ...data } : { ...data }, created: uni.time });
  e.current = e.versions.length;
  e.updated = uni.time;
  vault.kv.secret.set(key, e);
  uni.emit({ type: 'vault-write', path: `secret/${key}`, version: e.current, time: uni.time });
  return { version: e.current };
}

// ---------------------------------------------------------------- the CLI
function vaultFor(c) {
  const addr = c.env.VAULT_ADDR || 'https://127.0.0.1:8200';
  const m = addr.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
  if (!m) return { error: `Error checking seal status: parse "${addr}": invalid URI for request` };
  const r = connect(c.uni, c.host, m[2], Number(m[3] || 8200));
  if (r.error) return { error: `Error checking seal status: Get "${addr}/v1/sys/seal-status": dial tcp ${r.ip || m[2]}:${m[3] || 8200}: ${r.error === 'ETIMEDOUT' ? 'i/o timeout' : r.error === 'ENOTFOUND' ? `lookup ${m[2]}: no such host` : 'connect: connection refused'}`, addr };
  if (r.listener?.program?.kind !== 'vault') return { error: `Error checking seal status: Error making API request.\n\nURL: GET ${addr}/v1/sys/seal-status\nCode: 404. Raw Message:\n\n404 page not found`, addr };
  if (m[1] === 'https') return { error: `Error checking seal status: Get "${addr}/v1/sys/seal-status": http: server gave HTTP response to HTTPS client`, addr };
  const home = c.host.users.get(c.user)?.home || '/root';
  const token = c.env.VAULT_TOKEN || (c.host.files.get(`${home}/.vault-token`) || '').trim();
  return { vault: r.listener.program.vault, addr, token, home };
}
const kvTable = (rows) => table(['Key', 'Value'], [['---', '-----'], ...rows]).map(l => l.replace(/^Key {3}/, 'Key   '));
const apiErr = (addr, method, path, code, msg) => `Error making API request.\n\nURL: ${method} ${addr}/v1/${path}\nCode: ${code}. Errors:\n\n* ${code === 403 ? '1 error occurred:\n\t* permission denied\n' : msg}\n`;

def('vault', c => {
  const args = c.args;
  const out = (...l) => c.print(...l);
  const fail = (m, code = 2) => c.fail(m, code);
  const flags = {}; const pos = [];
  for (const a of args) { const m = a.match(/^-{1,2}([\w-]+)(?:=(.*))?$/); if (m) flags[m[1]] = m[2] ?? true; else pos.push(a); }
  const [cmd, sub, ...rest] = pos;
  if (!cmd || cmd === 'help' || flags.help) { out('Usage: vault <command> [args]', '', 'Common commands:', '    read        Read data and retrieves secrets', '    write       Write data, configuration, and secrets', '    login       Authenticate locally', '    status      Print seal and HA status', '', 'Other commands:', '    auth        Interact with auth methods', '    kv          Interact with Vault\'s Key-Value storage', '    policy      Interact with policies', '    secrets     Interact with secrets engines', '    token       Interact with tokens'); return 0; }
  if (cmd === 'version') { out('Vault v1.18.1 (f479e5c85462477c9334564bc8f69531cdb03b65), built 2024-10-29T14:21:31Z'); return 0; }
  const V = vaultFor(c);
  if (V.error) return fail(V.error);
  const { vault, addr } = V;
  const uni = c.uni;
  let token = V.token;
  const emit = extra => uni.emit({ type: 'vault', host: c.host.name, cmd, sub, args: args.join(' '), ...extra });
  if (cmd === 'status') { out(...kvTable([['Seal Type', 'shamir'], ['Initialized', 'true'], ['Sealed', 'false'], ['Total Shares', '1'], ['Threshold', '1'], ['Version', '1.18.1'], ['Storage Type', 'raft'], ['Cluster Name', 'vault-cluster-lumen'], ['HA Enabled', 'false']])); emit({}); return 0; }
  if (cmd === 'login') {
    const t = sub || flags.token;
    if (!t || !vault.tokens.has(t)) return fail(`Error authenticating: error looking up token: ${apiErr(addr, 'GET', 'auth/token/lookup-self', 403)}`);
    c.host.writeFile(`${V.home}/.vault-token`, t, c.user); c.host.setMeta(`${V.home}/.vault-token`, { mode: 0o600 });
    const tk = vault.tokens.get(t);
    out('Success! You are now authenticated. The token information displayed below', 'is already stored in the token helper. You do NOT need to run "vault login"', 'again. Future Vault requests will automatically use this token.', '', ...kvTable([['token', t], ['token_accessor', tk.accessor], ['token_duration', tk.ttl ? `${tk.ttl / 3600}h` : '∞'], ['token_renewable', String(!!tk.ttl)], ['token_policies', `[${tk.policies.join(' ')}]`], ['identity_policies', '[]'], ['policies', `[${tk.policies.join(' ')}]`]]));
    emit({ root: tk.policies.includes('root') });
    return 0;
  }
  if (!token || !vault.tokens.has(token)) {
    if (!token) return fail(`Error: missing client token. Set VAULT_TOKEN or run "vault login".`);
    return fail(apiErr(addr, 'GET', 'sys/mounts', 403));
  }
  const can = (path, cap) => allowed(vault, token, path, cap);
  const parseKV = list => { const o = {}; for (const kv of list) { if (kv === '-') continue; const i = kv.indexOf('='); if (i < 0) throw new Error(`Failed to parse K=V data: invalid key/value pair "${kv}": format must be key=value`); let v = kv.slice(i + 1); if (v.startsWith('@')) { const t = c.host.files.get(c.resolve(v.slice(1))); if (t === undefined) throw new Error(`Failed to parse K=V data: error reading file: open ${v.slice(1)}: no such file or directory`); v = t.replace(/\n$/, ''); } o[kv.slice(0, i)] = v; } return o; };
  const kvPath = p => { const s = String(p || '').replace(/^\/|\/$/g, ''); const mount = flags.mount || s.split('/')[0]; const key = flags.mount ? s : s.split('/').slice(1).join('/'); return { mount, key }; };
  if (cmd === 'kv') {
    const target = sub === 'metadata' ? rest[1] : rest[0];
    const { mount, key } = kvPath(target);
    if (mount !== 'secret') return fail(`Error ${sub === 'put' ? 'writing' : 'reading'} ${mount}/${key}: no handler for route "${mount}/${key}". route entry not found.`);
    const dataPath = `secret/data/${key}`, metaPath = `secret/metadata/${key}`;
    if (sub === 'put' || sub === 'patch') {
      let data; try { data = parseKV(rest.slice(1)); } catch (e) { return fail(e.message, 1); }
      if (!Object.keys(data).length) return fail('Must supply data', 1);
      if (!can(dataPath, sub === 'put' ? 'create' : 'update')) { emit({ path: dataPath, denied: true }); return fail(`Error writing data to secret/data/${key}: ${apiErr(addr, 'PUT', dataPath, 403)}`); }
      const r = kvPut(uni, vault, key, data, { patch: sub === 'patch' });
      out(`== Secret Path ==`, dataPath, '', '======= Metadata =======', ...kvTable([['created_time', isoT(uni.time)], ['custom_metadata', '<nil>'], ['deletion_time', 'n/a'], ['destroyed', 'false'], ['version', String(r.version)]]));
      emit({ path: dataPath, version: r.version, keys: Object.keys(data) });
      return 0;
    }
    if (sub === 'get') {
      if (!can(dataPath, 'read')) { emit({ path: dataPath, denied: true }); return fail(`Error reading ${dataPath}: ${apiErr(addr, 'GET', dataPath, 403)}`); }
      const e = vault.kv.secret.get(key);
      if (!e) return fail(`No value found at ${dataPath}`);
      const ver = flags.version ? Number(flags.version) : e.current;
      const v = e.versions[ver - 1];
      if (!v) return fail(`No value found at ${dataPath}`);
      emit({ path: dataPath, version: ver, field: flags.field || null });
      if (flags.field) { if (!(flags.field in v.data)) return fail(`Field "${flags.field}" not present in secret`, 1); c.out(v.data[flags.field] + (c.inPipe ? '' : '\n')); return 0; }
      if (flags.format === 'json') { out(...JSON.stringify({ request_id: rand(ver + 3, 8, '0123456789abcdef') + '-1c2d-4e5f-8a9b-' + rand(ver, 12, '0123456789abcdef'), data: { data: v.data, metadata: { created_time: isoT(v.created), version: ver } } }, null, 2).split('\n')); return 0; }
      out(`== Secret Path ==`, dataPath, '', '======= Metadata =======', ...kvTable([['created_time', isoT(v.created)], ['custom_metadata', '<nil>'], ['deletion_time', 'n/a'], ['destroyed', 'false'], ['version', String(ver)]]), '', '====== Data ======', ...kvTable(Object.entries(v.data).sort()));
      return 0;
    }
    if (sub === 'list') {
      if (!can(metaPath, 'list') && !can(`secret/metadata/${key}/`, 'list')) return fail(`Error listing ${metaPath}: ${apiErr(addr, 'LIST', metaPath, 403)}`);
      const prefix = key ? key.replace(/\/$/, '') + '/' : '';
      const keys = [...new Set([...vault.kv.secret.keys()].filter(k => k.startsWith(prefix)).map(k => { const rest2 = k.slice(prefix.length); return rest2.includes('/') ? rest2.split('/')[0] + '/' : rest2; }))].sort();
      if (!keys.length) return fail(`No value found at ${metaPath}`);
      out('Keys', '----', ...keys);
      emit({ path: metaPath });
      return 0;
    }
    if (sub === 'metadata' && rest[0] === 'get') {
      const e = vault.kv.secret.get(key);
      if (!e) return fail(`No value found at ${metaPath}`);
      out(`=== Metadata Path ===`, metaPath, '', '========== Metadata ==========', ...kvTable([['cas_required', 'false'], ['created_time', isoT(e.created)], ['current_version', String(e.current)], ['max_versions', '0'], ['oldest_version', '0'], ['updated_time', isoT(e.updated)]]), ...e.versions.flatMap((v, i) => ['', `====== Version ${i + 1} ======`, ...kvTable([['created_time', isoT(v.created)], ['deletion_time', 'n/a'], ['destroyed', 'false']])]));
      return 0;
    }
    if (sub === 'rollback') {
      const e = vault.kv.secret.get(key);
      const to = Number(flags.version);
      if (!e || !e.versions[to - 1]) return fail(`Error rolling back: no version ${flags.version}`);
      if (!can(dataPath, 'update')) return fail(`Error writing data to ${dataPath}: ${apiErr(addr, 'PUT', dataPath, 403)}`);
      const r = kvPut(uni, vault, key, e.versions[to - 1].data);
      out(`Key              Value`, `---              -----`, `version          ${r.version}`);
      return 0;
    }
    if (sub === 'delete' || sub === 'destroy') { if (!can(dataPath, 'delete')) return fail(`Error deleting ${dataPath}: ${apiErr(addr, 'DELETE', dataPath, 403)}`); vault.kv.secret.delete(key); out(`Success! Data deleted (if it existed) at: ${dataPath}`); return 0; }
    return fail(`Usage: vault kv <subcommand> [options] [args]`, 1);
  }
  if (cmd === 'policy') {
    if (sub === 'write') {
      if (!can(`sys/policies/acl/${rest[0]}`, 'update')) return fail(`Error uploading policy: ${apiErr(addr, 'PUT', `sys/policies/acl/${rest[0]}`, 403)}`);
      const src = rest[1] === '-' ? String(c.stdin ?? '') : c.host.files.get(c.resolve(rest[1] || ''));
      if (src === undefined) return fail(`Error opening policy file: open ${rest[1]}: no such file or directory`);
      let rules; try { rules = parsePolicy(src); } catch (e) { return fail(`Error uploading policy: ${apiErr(addr, 'PUT', `sys/policies/acl/${rest[0]}`, 400, e.message)}`); }
      vault.policies.set(rest[0], { text: src, rules });
      out(`Success! Uploaded policy: ${rest[0]}`);
      emit({ name: rest[0], rules });
      return 0;
    }
    if (sub === 'list') { out(...[...vault.policies.keys(), 'root'].sort()); return 0; }
    if (sub === 'read') { const p = vault.policies.get(rest[0]); if (!p) return fail(`No policy named: ${rest[0]}`); out(...p.text.replace(/\n$/, '').split('\n')); return 0; }
    if (sub === 'delete') { vault.policies.delete(rest[0]); out(`Success! Deleted policy: ${rest[0]}`); return 0; }
  }
  if (cmd === 'token') {
    if (sub === 'create') {
      if (!can('auth/token/create', 'update')) return fail(`Error creating token: ${apiErr(addr, 'POST', 'auth/token/create', 403)}`);
      const policies = String(flags.policy || 'default').split(',');
      for (const p of policies) if (p !== 'default' && p !== 'root' && !vault.policies.has(p)) c.eprint(`WARNING! The following warnings were returned from Vault:\n\n  * Policy "${p}" does not exist`);
      if (!vault.tokens.get(token).policies.includes('root') && policies.some(p => !vault.tokens.get(token).policies.includes(p))) return fail(`Error creating token: ${apiErr(addr, 'POST', 'auth/token/create', 400, 'child policies must be subset of parent')}`);
      const ttl = flags.ttl ? parseInt(flags.ttl, 10) * ({ s: 1, m: 60, h: 3600 }[String(flags.ttl).slice(-1)] || 1) : 768 * 3600;
      const t = ['hvs', 'CAES' + rand(uni.time + vault.tokens.size * 31, 20)].join('.');
      const all = [...new Set(['default', ...policies])].sort();
      vault.tokens.set(t, { policies: all, created: uni.time, ttl, accessor: rand(vault.tokens.size + 99, 24), display: flags['display-name'] || 'token' });
      if (flags.field === 'token') { c.out(t + (c.inPipe ? '' : '\n')); emit({ policies: all, ttl }); return 0; }
      out(...kvTable([['token', t], ['token_accessor', vault.tokens.get(t).accessor], ['token_duration', `${ttl / 3600}h`], ['token_renewable', 'true'], ['token_policies', `[${all.join(' ')}]`], ['identity_policies', '[]'], ['policies', `[${all.join(' ')}]`]]));
      emit({ policies: all, ttl });
      return 0;
    }
    if (sub === 'lookup') { const t = rest[0] || token; const tk = vault.tokens.get(t); if (!tk) return fail(`Error looking up token: ${apiErr(addr, 'POST', 'auth/token/lookup', 403)}`); out(...kvTable([['accessor', tk.accessor], ['creation_time', String(tk.created)], ['display_name', tk.display], ['policies', `[${tk.policies.join(' ')}]`], ['ttl', tk.ttl ? `${Math.max(0, tk.ttl - (uni.time - tk.created)) / 3600}h` : '0s']])); return 0; }
    if (sub === 'revoke') { const t = rest[0]; if (!vault.tokens.has(t)) return fail('Error revoking token: token not found'); vault.tokens.delete(t); out('Success! Revoked token (if it existed)'); emit({ revoked: true }); return 0; }
  }
  if (cmd === 'auth') {
    if (sub === 'enable') { if (rest[0] !== 'kubernetes') return fail(`Error enabling ${rest[0]} auth: the simulator supports the kubernetes auth method`); if (vault.auth.kubernetes) return fail(`Error enabling kubernetes auth: ${apiErr(addr, 'POST', 'sys/auth/kubernetes', 400, 'path is already in use at kubernetes/')}`); vault.auth.kubernetes = { roles: new Map(), config: null }; out('Success! Enabled kubernetes auth method at: kubernetes/'); emit({ method: 'kubernetes' }); return 0; }
    if (sub === 'list') { out(...table(['Path', 'Type', 'Accessor', 'Description'], [['----', '----', '--------', '-----------'], ['token/', 'token', 'auth_token_8f1c2d3e', 'token based credentials'], ...(vault.auth.kubernetes ? [['kubernetes/', 'kubernetes', 'auth_kubernetes_4b5a6c7d', 'n/a']] : [])])); return 0; }
  }
  if (cmd === 'secrets' && sub === 'list') { out(...table(['Path', 'Type', 'Accessor', 'Description'], [['----', '----', '--------', '-----------'], ['cubbyhole/', 'cubbyhole', 'cubbyhole_1a2b3c4d', 'per-token private secret storage'], ['identity/', 'identity', 'identity_5e6f7a8b', 'identity store'], ['secret/', 'kv', 'kv_9c0d1e2f', 'key/value secret storage'], ['sys/', 'system', 'system_3a4b5c6d', 'system endpoints used for control, policy and debugging']])); return 0; }
  if (cmd === 'write' || cmd === 'read') {
    const path = sub;
    const m = String(path || '').match(/^auth\/kubernetes\/(config|role\/([\w-]+))$/);
    if (!m) return fail(`Error ${cmd === 'write' ? 'writing' : 'reading'} ${path}: the simulator supports auth/kubernetes/config and auth/kubernetes/role/<name> here; use "vault kv" for secrets`);
    if (!vault.auth.kubernetes) return fail(`Error ${cmd === 'write' ? 'writing data to' : 'reading'} ${path}: ${apiErr(addr, cmd === 'write' ? 'PUT' : 'GET', path, 404, `no handler for route "${path}". route entry not found.`)}`);
    if (!can(path, cmd === 'write' ? 'update' : 'read')) return fail(`Error ${cmd === 'write' ? 'writing data to' : 'reading'} ${path}: ${apiErr(addr, 'PUT', path, 403)}`);
    let data; try { data = parseKV(rest); } catch (e) { return fail(e.message, 1); }
    if (m[1] === 'config') { if (cmd === 'write') { vault.auth.kubernetes.config = data; out(`Success! Data written to: ${path}`); emit({ path }); } else out(...kvTable(Object.entries(vault.auth.kubernetes.config || {}))); return 0; }
    const name = m[2];
    if (cmd === 'write') {
      const role = { bound_service_account_names: String(data.bound_service_account_names || '').split(',').filter(Boolean), bound_service_account_namespaces: String(data.bound_service_account_namespaces || '').split(',').filter(Boolean), policies: String(data.policies || data.token_policies || '').split(',').filter(Boolean), ttl: data.ttl || '1h' };
      if (!role.bound_service_account_names.length || !role.bound_service_account_namespaces.length) return fail(`Error writing data to ${path}: ${apiErr(addr, 'PUT', path, 400, '"bound_service_account_names" can not be empty')}`);
      vault.auth.kubernetes.roles.set(name, role);
      out(`Success! Data written to: ${path}`);
      emit({ path, role });
      return 0;
    }
    const role = vault.auth.kubernetes.roles.get(name);
    if (!role) return fail(`No value found at ${path}`);
    out(...kvTable([['bound_service_account_names', `[${role.bound_service_account_names.join(' ')}]`], ['bound_service_account_namespaces', `[${role.bound_service_account_namespaces.join(' ')}]`], ['token_policies', `[${role.policies.join(' ')}]`], ['token_ttl', role.ttl]]));
    return 0;
  }
  return fail(`Unknown command or arguments: vault ${args.join(' ')}`, 127);
}, { pkg: 'vault' });

// ---------------------------------------------------------------- External Secrets Operator
export function installEso(cl, { ns = 'external-secrets' } = {}) {
  if (cl.eso) return cl.eso;
  for (const c of ESO_CRDS) if (!cl.crds.has(c.kind)) cl.apply(parseYaml(crdYaml(c)));
  if (!cl.get('Namespace', null, ns)) cl.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
  const p = cl.staticPod('external-secrets-7d6c9b8f5d-w2x4z', ns, cl.nodes[0], '10.244.1.235', 'oci.external-secrets.io/external-secrets/external-secrets:v0.10.5');
  p.metadata.labels = { 'app.kubernetes.io/name': 'external-secrets' };
  cl.eso = { ns };
  cl.controllers.push(reconcileEso);
  return cl.eso;
}
CHART_HOOKS['external-secrets/external-secrets'] = { after(cl, rel) { installEso(cl, { ns: rel.namespace }); } };

const dur = s => { const m = String(s || '1h').match(/^(\d+)(s|m|h)$/); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]] : 3600; };
const cond = (ok, reason, message, t) => [{ type: 'Ready', status: ok ? 'True' : 'False', reason, message, lastTransitionTime: iso(t) }];

// a store's view of Vault: { vault, token } or { error }
function storeLogin(cl, store, ns) {
  const v = store.spec?.provider?.vault;
  if (!v) return { error: 'only the vault provider is simulated' };
  const m = String(v.server || '').match(/^https?:\/\/([^:/]+)(?::(\d+))?/);
  if (!m) return { error: `invalid vault server "${v.server}"` };
  const node = cl.nodes[0].host;
  const r = connect(cl.uni, node, m[1], Number(m[2] || 8200));
  if (r.error || r.listener?.program?.kind !== 'vault') return { error: `unable to log in to auth method: Get "${v.server}/v1/sys/health": dial tcp ${m[1]}:${m[2] || 8200}: ${r.error === 'ENOTFOUND' ? 'no such host' : r.error === 'ETIMEDOUT' ? 'i/o timeout' : 'connect: connection refused'}` };
  const vault = r.listener.program.vault;
  if ((v.version || 'v2') !== 'v2' || (v.path || 'secret') !== 'secret') return { error: `cannot read secret data from Vault: the store path must be "secret" with version "v2" in this simulator` };
  const a = v.auth || {};
  if (a.tokenSecretRef) {
    const s = cl.get('Secret', a.tokenSecretRef.namespace || ns, a.tokenSecretRef.name);
    if (!s) return { error: `could not get secret ${a.tokenSecretRef.name}: secrets "${a.tokenSecretRef.name}" not found` };
    const t = atob(s.data?.[a.tokenSecretRef.key] || '');
    if (!vault.tokens.has(t)) return { error: 'cannot read secret data from Vault: Error making API request.\n\nCode: 403. Errors:\n\n* permission denied' };
    return { vault, token: t };
  }
  if (a.kubernetes) {
    const k = vault.auth.kubernetes;
    if (!k) return { error: 'unable to log in to auth method: unable to log in with Kubernetes auth: Error making API request.\n\nURL: PUT ' + v.server + '/v1/auth/kubernetes/login\nCode: 400. Errors:\n\n* no handler for route "auth/kubernetes/login". route entry not found.' };
    const role = k.roles.get(a.kubernetes.role);
    const sa = a.kubernetes.serviceAccountRef?.name || 'default';
    const saNs = a.kubernetes.serviceAccountRef?.namespace || ns;
    if (!cl.get('ServiceAccount', saNs, sa)) return { error: `unable to log in to auth method: serviceaccounts "${sa}" not found` };
    if (!role) return { error: `unable to log in to auth method: unable to log in with Kubernetes auth: Error making API request.\n\nURL: PUT ${v.server}/v1/auth/kubernetes/login\nCode: 400. Errors:\n\n* invalid role name "${a.kubernetes.role}"` };
    const okName = role.bound_service_account_names.some(n => n === '*' || n === sa), okNs = role.bound_service_account_namespaces.some(n => n === '*' || n === saNs);
    if (!okName || !okNs) return { error: `unable to log in to auth method: unable to log in with Kubernetes auth: Error making API request.\n\nURL: PUT ${v.server}/v1/auth/kubernetes/login\nCode: 403. Errors:\n\n* service account ${okName ? 'namespace' : 'name'} not authorized` };
    const key = `k8s:${saUser(saNs, sa)}:${role.policies.join(',')}`;
    if (!vault.tokens.has(key)) vault.tokens.set(key, { policies: ['default', ...role.policies], created: cl.uni.time, ttl: dur(role.ttl), accessor: 'k8s', display: `kubernetes-${saNs}-${sa}` });
    return { vault, token: key };
  }
  return { error: 'no auth method configured' };
}

function reconcileEso(cl) {
  if (!cl.eso) return;
  const uni = cl.uni;
  for (const st of [...cl.list('SecretStore', null), ...cl.list('ClusterSecretStore')]) {
    if (st.status?.__checked && uni.time - st.status.__checked < 30) continue;
    const r = storeLogin(cl, st, st.metadata.namespace);
    st.status = { __checked: uni.time, capabilities: 'ReadWrite', conditions: r.error ? cond(false, 'InvalidProviderConfig', r.error, uni.time) : cond(true, 'Valid', 'store validated', uni.time) };
  }
  for (const es of cl.list('ExternalSecret', null)) {
    const s = es.status = es.status || {};
    const specKey = JSON.stringify(es.spec);
    const force = es.metadata.annotations?.['force-sync'];
    if (s.__lastTry && s.__spec === specKey && !force && uni.time - s.__lastTry < (s.__ok ? dur(es.spec.refreshInterval) : 10)) continue;
    s.__lastTry = uni.time; s.__spec = specKey;
    if (force) delete es.metadata.annotations['force-sync'];
    const ref = es.spec.secretStoreRef || {};
    const store = ref.kind === 'ClusterSecretStore' ? cl.get('ClusterSecretStore', null, ref.name) : cl.get('SecretStore', es.metadata.namespace, ref.name);
    const failNow = msg => { s.__ok = false; s.conditions = cond(false, 'SecretSyncedError', msg, uni.time); cl.event(es, 'Warning', 'UpdateFailed', msg); uni.emit({ type: 'eso-sync', cluster: cl.name, ns: es.metadata.namespace, name: es.metadata.name, ok: false, message: msg }); };
    if (!store) { failNow(`could not get store: ${ref.kind === 'ClusterSecretStore' ? 'clustersecretstores' : 'secretstores'}.external-secrets.io "${ref.name}" not found`); continue; }
    const login = storeLogin(cl, store, es.metadata.namespace);
    if (login.error) { failNow(`error processing spec.data[0] (key: ${es.spec.data?.[0]?.remoteRef?.key}), err: ${login.error}`); continue; }
    const data = {};
    let err = null;
    const read = key => {
      if (!allowed(login.vault, login.token, `secret/data/${key}`, 'read')) return { error: `cannot read secret data from Vault: Error making API request.\n\nURL: GET ${store.spec.provider.vault.server}/v1/secret/data/${key}\nCode: 403. Errors:\n\n* 1 error occurred:\n\t* permission denied` };
      const e = login.vault.kv.secret.get(key);
      if (!e) return { error: 'Secret does not exist' };
      return { data: e.versions[e.current - 1].data };
    };
    for (const [i, d] of (es.spec.data || []).entries()) {
      const r = read(d.remoteRef.key);
      if (r.error) { err = `error processing spec.data[${i}] (key: ${d.remoteRef.key}), err: ${r.error}`; break; }
      if (d.remoteRef.property && !(d.remoteRef.property in r.data)) { err = `error processing spec.data[${i}] (key: ${d.remoteRef.key}), err: key ${d.remoteRef.property} does not exist in secret ${d.remoteRef.key}`; break; }
      data[d.secretKey] = d.remoteRef.property ? r.data[d.remoteRef.property] : JSON.stringify(r.data);
    }
    for (const [i, d] of (es.spec.dataFrom || []).entries()) {
      if (err) break;
      const r = read(d.extract?.key);
      if (r.error) { err = `error processing spec.dataFrom[${i}].extract, err: ${r.error}`; break; }
      Object.assign(data, r.data);
    }
    if (err) { failNow(err); continue; }
    const name = es.spec.target?.name || es.metadata.name;
    const encoded = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, btoa(String(v))]));
    const cur = cl.get('Secret', es.metadata.namespace, name);
    const changed = !cur || JSON.stringify(cur.data) !== JSON.stringify(encoded);
    if (!cur) cl.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: es.metadata.namespace, labels: { 'reconcile.external-secrets.io/managed': 'true' }, annotations: { 'reconcile.external-secrets.io/data-hash': String(JSON.stringify(encoded).length) }, ownerReferences: [{ apiVersion: 'external-secrets.io/v1beta1', kind: 'ExternalSecret', name: es.metadata.name, uid: es.metadata.uid, controller: true }] }, type: 'Opaque', data: encoded });
    else if (changed) { cur.data = encoded; cur.metadata.generation++; }
    s.__ok = true;
    s.refreshTime = iso(uni.time);
    s.syncedResourceVersion = `1-${String(uni.time).slice(-6)}`;
    s.conditions = cond(true, 'SecretSynced', 'Secret was synced', uni.time);
    if (changed) { cl.event(es, 'Normal', 'Updated', 'Updated Secret'); uni.emit({ type: 'eso-sync', cluster: cl.name, ns: es.metadata.namespace, name: es.metadata.name, secret: name, ok: true, changed: true }); }
  }
}

PRINTERS.ExternalSecret = (cl, items) => [['NAME', 'STORE', 'REFRESH INTERVAL', 'STATUS', 'READY'], items.map(e => [e.metadata.name, e.spec.secretStoreRef?.name, e.spec.refreshInterval || '1h', e.status?.conditions?.[0]?.reason || '', e.status?.conditions?.[0]?.status || 'Unknown'])];
PRINTERS.SecretStore = (cl, items) => [['NAME', 'AGE', 'STATUS', 'CAPABILITIES', 'READY'], items.map(s => [s.metadata.name, age(cl.uni, s.metadata.creationTimestamp), s.status?.conditions?.[0]?.reason || '', s.status?.capabilities || 'ReadWrite', s.status?.conditions?.[0]?.status || 'Unknown'])];
PRINTERS.ClusterSecretStore = PRINTERS.SecretStore;
const condBlock = o => ['Status:', '  Conditions:', ...(o.status?.conditions || []).flatMap(c => [`    Last Transition Time:  ${c.lastTransitionTime}`, `    Message:               ${c.message}`, `    Reason:                ${c.reason}`, `    Status:                ${c.status}`, `    Type:                  ${c.type}`])];
DESCRIBERS.ExternalSecret = (cl, o, { events }) => { const L = [`Name:         ${o.metadata.name}`, `Namespace:    ${o.metadata.namespace}`, 'Spec:', `  Refresh Interval:  ${o.spec.refreshInterval || '1h'}`, `  Secret Store Ref:`, `    Kind:  ${o.spec.secretStoreRef?.kind || 'SecretStore'}`, `    Name:  ${o.spec.secretStoreRef?.name}`, `  Target:`, `    Name:  ${o.spec.target?.name || o.metadata.name}`, ...condBlock(o), `  Refresh Time:  ${o.status?.refreshTime || '<none>'}`]; const ev = cl.eventsFor(o).slice(-5); L.push('Events:', ...(ev.length ? ev.map(e => `  ${e.type.padEnd(8)}${e.reason.padEnd(14)}${age(cl.uni, e.last).padEnd(6)}${e.message}`) : ['  <none>'])); void events; return L; };
DESCRIBERS.SecretStore = (cl, o) => [`Name:         ${o.metadata.name}`, `Namespace:    ${o.metadata.namespace}`, 'Spec:', '  Provider:', '    Vault:', `      Server:   ${o.spec.provider?.vault?.server}`, `      Path:     ${o.spec.provider?.vault?.path}`, `      Version:  ${o.spec.provider?.vault?.version}`, ...condBlock(o)];
DESCRIBERS.ClusterSecretStore = DESCRIBERS.SecretStore;

export { toYaml, clone, httpRequest };
