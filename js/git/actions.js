// The Actions runner: parses workflow files, matches triggers (branch/tag filters,
// pull_request, workflow_dispatch), runs jobs in `needs` order with `if:` conditions,
// pauses at protected environments until someone approves, and records deployments
// to environments whose URLs answer `curl`.

import { parseYaml, YamlError } from './yaml.js';

const KNOWN_EVENTS = ['push', 'pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule', 'release', 'issues', 'workflow_call', 'merge_group'];

export function parseWorkflow(text) {
  const wf = { name: null, on: [], triggers: {}, env: {}, jobs: [], errors: [] };
  let doc;
  try { doc = parseYaml(text); } catch (e) { wf.errors.push(e instanceof YamlError ? `YAML syntax error on ${e.message}` : e.message); return wf; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { wf.errors.push('a workflow must be a mapping (name:, on:, jobs:)'); return wf; }
  wf.name = doc.name != null ? String(doc.name) : null;
  const on = doc.on;
  if (typeof on === 'string') wf.triggers[on] = {};
  else if (Array.isArray(on)) for (const e of on) wf.triggers[String(e)] = {};
  else if (on && typeof on === 'object') for (const [k, v] of Object.entries(on)) wf.triggers[k] = v || {};
  wf.on = Object.keys(wf.triggers);
  if (!wf.on.length) wf.errors.push("missing 'on:' trigger");
  for (const e of wf.on) if (!KNOWN_EVENTS.includes(e)) wf.errors.push(`unknown event '${e}' in 'on:'`);
  wf.env = doc.env && typeof doc.env === 'object' ? doc.env : {};
  wf.permissions = doc.permissions ?? null;
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) { wf.errors.push("missing 'jobs:'"); return wf; }
  for (const [id, j] of Object.entries(jobs)) {
    if (!j || typeof j !== 'object') { wf.errors.push(`job '${id}' is empty`); continue; }
    const env = j.environment;
    const job = {
      id, name: j.name ? String(j.name) : id, runsOn: j['runs-on'] || null, permissions: j.permissions ?? null,
      needs: j.needs ? [].concat(j.needs).map(String) : [],
      if: j.if != null ? String(j.if) : null,
      environment: typeof env === 'string' ? { name: env } : env && typeof env === 'object' ? { name: env.name, url: env.url } : null,
      env: j.env && typeof j.env === 'object' ? j.env : {},
      steps: [],
    };
    if (j.steps != null && !Array.isArray(j.steps)) wf.errors.push(`job '${id}': 'steps' must be a list (each step starts with "- ")`);
    for (const s of Array.isArray(j.steps) ? j.steps : []) {
      if (!s || typeof s !== 'object') { wf.errors.push(`job '${id}': each step must be a mapping like "- run: npm test"`); continue; }
      if (s.run == null && s.uses == null) wf.errors.push(`job '${id}': a step needs either 'run:' or 'uses:'`);
      job.steps.push({ name: s.name != null ? String(s.name) : null, uses: s.uses != null ? String(s.uses) : null, run: s.run != null ? String(s.run) : null, env: s.env && typeof s.env === 'object' ? s.env : {}, if: s.if != null ? String(s.if) : null, with: s.with || {} });
    }
    wf.jobs.push(job);
  }
  if (!wf.jobs.length) wf.errors.push("missing 'jobs:'");
  for (const j of wf.jobs) {
    if (!j.runsOn) wf.errors.push(`job '${j.id}' is missing 'runs-on'`);
    if (!j.steps.length) wf.errors.push(`job '${j.id}' has no steps`);
    for (const n of j.needs) if (!wf.jobs.some(x => x.id === n)) wf.errors.push(`job '${j.id}' needs unknown job '${n}'`);
  }
  return wf;
}

// ---------- expressions: ${{ ... }} ----------

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") { let j = i + 1, s = ''; while (j < src.length) { if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; } if (src[j] === "'") break; s += src[j++]; } toks.push({ t: 'str', v: s }); i = j + 1; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '&&', '||', '<=', '>='].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('()!,<>'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    const m = src.slice(i).match(/^[A-Za-z_][\w.-]*|^\d+(\.\d+)?/);
    if (!m) throw new Error(`unexpected character '${c}' in expression`);
    toks.push({ t: /^\d/.test(m[0]) ? 'num' : 'id', v: m[0] });
    i += m[0].length;
  }
  return toks;
}

export function evalExpr(src, ctx) {
  const toks = tokenize(src.replace(/^\s*\$\{\{|\}\}\s*$/g, ''));
  let p = 0;
  const peek = () => toks[p];
  const eat = v => { if (toks[p]?.v !== v) throw new Error(`expected '${v}' in expression`); p++; };
  const lookup = name => {
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    let v = ctx;
    for (const part of name.split('.')) v = v == null ? undefined : v[part];
    return v ?? '';
  };
  const fns = {
    startsWith: (a, b) => String(a).toLowerCase().startsWith(String(b).toLowerCase()),
    endsWith: (a, b) => String(a).toLowerCase().endsWith(String(b).toLowerCase()),
    contains: (a, b) => Array.isArray(a) ? a.includes(b) : String(a).toLowerCase().includes(String(b).toLowerCase()),
    success: () => ctx.__status !== 'failure',
    failure: () => ctx.__status === 'failure',
    always: () => true,
    cancelled: () => false,
    format: (f, ...a) => String(f).replace(/\{(\d+)\}/g, (_, n) => a[n]),
  };
  function primary() {
    const t = toks[p++];
    if (!t) throw new Error('unexpected end of expression');
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return Number(t.v);
    if (t.v === '(') { const v = or(); eat(')'); return v; }
    if (t.v === '!') return !truthy(primary());
    if (t.t === 'id') {
      if (peek()?.v === '(') {
        p++;
        const args = [];
        if (peek()?.v !== ')') { args.push(or()); while (peek()?.v === ',') { p++; args.push(or()); } }
        eat(')');
        const fn = fns[t.v];
        if (!fn) throw new Error(`unknown function ${t.v}()`);
        return fn(...args);
      }
      return lookup(t.v);
    }
    throw new Error(`unexpected '${t.v}' in expression`);
  }
  function cmp() {
    let a = primary();
    while (['==', '!=', '<', '>', '<=', '>='].includes(peek()?.v)) {
      const op = toks[p++].v, b = primary();
      const x = typeof a === 'string' ? a.toLowerCase() : a, y = typeof b === 'string' ? b.toLowerCase() : b;
      a = op === '==' ? x == y : op === '!=' ? x != y : op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y; // eslint-disable-line eqeqeq
    }
    return a;
  }
  function and() { let a = cmp(); while (peek()?.v === '&&') { p++; const b = cmp(); a = truthy(a) ? b : a; } return a; }
  function or() { let a = and(); while (peek()?.v === '||') { p++; const b = and(); a = truthy(a) ? a : b; } return a; }
  const v = or();
  if (p < toks.length) throw new Error(`unexpected '${toks[p].v}' in expression`);
  return v;
}

const truthy = v => !(v === false || v === '' || v === 0 || v == null);

export function interpolate(str, ctx) {
  return String(str).replace(/\$\{\{([^}]*)\}\}/g, (_, e) => { const v = evalExpr(e, ctx); return v == null ? '' : String(v); });
}

// ---------- triggers ----------

function glob(pattern, name) {
  const re = '^' + String(pattern).replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(re).test(name);
}
const anyGlob = (list, name) => [].concat(list || []).some(p => glob(p, name));

export function triggerMatches(wf, event, { ref, refType, base }) {
  if (!(event in wf.triggers)) return false;
  const f = wf.triggers[event] || {};
  if (event === 'push') {
    const hasB = f.branches || f['branches-ignore'], hasT = f.tags || f['tags-ignore'];
    if (refType === 'tag') {
      if (!hasT) return !hasB;
      return f.tags ? anyGlob(f.tags, ref) : !anyGlob(f['tags-ignore'], ref);
    }
    if (!hasB) return !hasT;
    return f.branches ? anyGlob(f.branches, ref) : !anyGlob(f['branches-ignore'], ref);
  }
  if (event === 'pull_request' || event === 'pull_request_target') {
    if (f.branches) return anyGlob(f.branches, base);
    if (f['branches-ignore']) return !anyGlob(f['branches-ignore'], base);
  }
  return true;
}

// ---------- environments, deployments, the "internet" ----------

export function ensureEnvironment(bare, name, url) {
  bare.meta.environments = bare.meta.environments || {};
  const e = bare.meta.environments[name] || (bare.meta.environments[name] = { name, url: null, reviewers: [], current: null });
  if (url && !e.url) e.url = url;
  return e;
}

export function deployTo(world, bare, envName, { hash, ref, refType, runId = null, by }) {
  const env = ensureEnvironment(bare, envName);
  bare.meta.deployments = bare.meta.deployments || [];
  const version = refType === 'tag' ? ref : `${ref}@${hash.slice(0, 7)}`;
  const d = { id: bare.meta.deployments.length + 1, env: envName, hash, ref, refType, version, runId, time: world.time, by };
  bare.meta.deployments.unshift(d);
  env.current = d.id;
  world.emit({ type: 'deployment', url: bare.meta.url, env: envName, hash, ref, version });
  return d;
}

export function currentDeployment(bare, envName) {
  const env = bare.meta.environments?.[envName];
  if (!env || !env.current) return null;
  return bare.meta.deployments.find(d => d.id === env.current) || null;
}

const hostOf = url => (String(url).match(/^(?:https?:\/\/)?([^/:\s]+)/) || [])[1]?.toLowerCase();

// Resolve an HTTP GET against deployed environments. Returns null for unknown hosts.
export function httpGet(world, url) {
  const host = hostOf(url);
  const path = (String(url).match(/^(?:https?:\/\/)?[^/]+(\/[^\s?#]*)?/) || [])[1] || '/';
  if (!host) return null;
  if (world.httpHandler) { const r = world.httpHandler(host, path); if (r) return r; }
  for (const bare of world.remotes.values()) {
    for (const env of Object.values(bare.meta.environments || {})) {
      if (!env.url || hostOf(env.url) !== host) continue;
      const d = currentDeployment(bare, env.name);
      if (!d) return { status: 503, body: 'Service Unavailable: nothing has been deployed here yet' };
      const flat = world.readTreeFlat(world.commit(d.hash).tree);
      const files = Object.fromEntries([...flat].map(([p, h]) => [p, world.objects.get(h).content]));
      const custom = world.siteRule?.(files, { env: env.name, path, deployment: d });
      if (custom) return custom;
      if (path === '/health') return { status: 200, body: JSON.stringify({ status: 'ok', version: d.version, commit: d.hash.slice(0, 7) }) };
      if (path === '/' || path === '/index.html') return { status: 200, body: files['index.html'] || `<h1>${bare.meta.name}</h1>\n<p>version ${d.version}</p>` };
      if (files[path.slice(1)] != null) return { status: 200, body: files[path.slice(1)] };
      return { status: 404, body: 'Not Found' };
    }
  }
  return null;
}

// ---------- running ----------

// Simulated script outcomes. `npm test` fails when any source file contains "BUG"
// (or by the lab's world.testRule), `npm run lint` fails on a leftover console.log,
// deploy scripts deploy, and curl talks to deployed environments.
export function simulateRun(cmd, flat, world, ctx = {}) {
  const files = [...flat].map(([p, h]) => [p, world.objects.get(h).content]);
  const env = ctx.env || {};
  if (/npm (run )?test|npm t\b|pytest|go test|cargo test/.test(cmd) && world.testRule) {
    const r = world.testRule(Object.fromEntries(files));
    return r.ok ? { ok: true, log: r.log || ['PASS all suites'] } : { ok: false, log: r.log || ['FAIL'] };
  }
  if (/npm (run )?test|npm t\b|pytest|go test|cargo test/.test(cmd)) {
    const bad = files.filter(([p, c]) => !p.startsWith('.github/') && /\bBUG\b/.test(c));
    return bad.length ? { ok: false, log: [`FAIL ${bad[0][0]}`, `  ✕ found a BUG marker in ${bad[0][0]}`, `Tests: 1 failed, ${files.length} total`] } : { ok: true, log: [`PASS all suites`, `Tests: ${Math.max(1, files.length)} passed, ${Math.max(1, files.length)} total`] };
  }
  if (/lint/.test(cmd)) {
    const bad = files.filter(([p, c]) => /\.(js|ts|jsx|tsx)$/.test(p) && /console\.log/.test(c));
    return bad.length ? { ok: false, log: [`${bad[0][0]}`, `  error  Unexpected console statement  no-console`, `✖ 1 problem (1 error, 0 warnings)`] } : { ok: true, log: ['✔ no lint problems'] };
  }
  if (/(^|[\s/])deploy(\.sh)?(\s|$)|npm run deploy/.test(cmd)) return simulateDeploy(cmd, flat, world, ctx);
  if (/^curl\b/.test(cmd)) {
    const url = cmd.split(/\s+/).find(a => /^https?:\/\//.test(a) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(a));
    const fail = /\s-[a-zA-Z]*f/.test(cmd) || /--fail/.test(cmd);
    const r = url ? httpGet(world, url) : null;
    if (!r) return { ok: false, log: [`curl: (6) Could not resolve host: ${hostOf(url) || '?'}`] };
    if (fail && r.status >= 400) return { ok: false, log: [`curl: (22) The requested URL returned error: ${r.status}`] };
    return { ok: true, log: String(r.body).split('\n').slice(0, 6) };
  }
  if (/^npm (ci|install|i)\b/.test(cmd)) return { ok: true, log: ['added 142 packages, and audited 143 packages in 3s', 'found 0 vulnerabilities'] };
  if (/build/.test(cmd)) return { ok: true, log: ['Build complete: dist/ (12 files)'] };
  if (/^echo /.test(cmd)) return { ok: true, log: [interpolateEnv(cmd.slice(5), env).replace(/^["']|["']$/g, '')] };
  if (/^(exit 1|false)$/.test(cmd.trim())) return { ok: false, log: [`Error: Process completed with exit code 1.`] };
  return { ok: true, log: [`$ ${cmd}`, 'done'] };
}

const interpolateEnv = (s, env) => s.replace(/\$\{?(\w+)\}?/g, (m, k) => k in env ? env[k] : '');

function simulateDeploy(cmd, flat, world, ctx) {
  const toks = cmd.trim().split(/\s+/);
  const script = toks.find(t => /\.sh$/.test(t));
  if (script) {
    const p = script.replace(/^\.\//, '');
    if (!flat.has(p)) return { ok: false, log: [`/bin/bash: ${script}: No such file or directory`, 'Error: Process completed with exit code 127.'] };
  }
  const i = toks.findIndex(t => /deploy(\.sh)?$/.test(t));
  const flagEnv = toks.indexOf('--env');
  let target = flagEnv >= 0 ? toks[flagEnv + 1] : toks.slice(i + 1).find(t => !t.startsWith('-'));
  if (!target && ctx.job?.environment?.name) target = ctx.job.environment.name;
  if (!target) return { ok: false, log: ['deploy: which environment? usage: deploy.sh <environment>', 'Error: Process completed with exit code 2.'] };
  if (!ctx.bare) return { ok: true, log: [`Deploying to ${target}… done`] };
  const env = ctx.env || {};
  if (!env.DEPLOY_TOKEN) {
    return { ok: false, log: ['deploy: DEPLOY_TOKEN is not set.', '  The hosting provider rejected the request: 401 Unauthorized.', '  Hint: store the token as an Actions secret and pass it to this step:', '    env:', '      DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}', 'Error: Process completed with exit code 1.'] };
  }
  if (world.deployToken && env.DEPLOY_TOKEN !== world.deployToken && env.DEPLOY_TOKEN !== '***') {
    return { ok: false, log: ['deploy: the hosting provider rejected DEPLOY_TOKEN: 401 Unauthorized (invalid token).', '  Check the value stored in the DEPLOY_TOKEN secret.', 'Error: Process completed with exit code 1.'] };
  }
  const envCfg = ensureEnvironment(ctx.bare, target);
  if (ctx.job?.environment?.name !== target && envCfg.reviewers?.length) {
    return { ok: false, log: [`deploy: refusing to deploy to protected environment '${target}' from a job without 'environment: ${target}'.`, 'Error: Process completed with exit code 1.'] };
  }
  const d = deployTo(world, ctx.bare, target, { hash: ctx.run.hash, ref: ctx.run.branch, refType: ctx.run.refType, runId: ctx.run.id, by: ctx.run.actor });
  return { ok: true, log: [`Deploying ${ctx.bare.meta.name} ${d.version} to ${target}…`, `Uploaded build (commit ${ctx.run.hash.slice(0, 7)})`, `✓ ${target} is now serving ${d.version}${envCfg.url ? ` at ${envCfg.url}` : ''}`] };
}

function ctxFor(bare, run) {
  const secrets = Object.fromEntries(Object.entries(bare.meta.secrets || {}).map(([k, v]) => [k, v.value ?? '***']));
  return {
    github: { ref: (run.refType === 'tag' ? 'refs/tags/' : 'refs/heads/') + run.branch, ref_name: run.branch, ref_type: run.refType, event_name: run.event, sha: run.hash, repository: `${bare.meta.owner}/${bare.meta.name}`, actor: run.actor, run_number: run.id },
    secrets, inputs: run.inputs || {}, vars: bare.meta.vars || {},
  };
}

export function runWorkflows(world, bare, event, ref, hash, pr = null, { refType = 'branch', only = null, inputs = null, actor } = {}) {
  const flat = world.readTreeFlat(world.commit(hash).tree);
  const wfs = [...flat.keys()].filter(p => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) && (!only || p === only));
  const base = pr != null ? bare.meta.prs.find(x => x.number === pr)?.base : null;
  const started = [];
  for (const path of wfs) {
    const wf = parseWorkflow(world.objects.get(flat.get(path)).content);
    const triggered = !wf.errors.length && triggerMatches(wf, event, { ref, refType, base });
    if (!triggered && !(wf.errors.length && event === 'push')) continue;
    const run = {
      id: (bare.meta.runs.length + 1), workflow: wf.name || path.split('/').pop(), file: path.split('/').pop(), path, event, branch: ref, refType, hash, pr,
      actor: actor || world.github?.user || 'you', inputs, attempt: 1, jobs: [], status: 'queued', conclusion: null, time: world.time,
    };
    if (wf.errors.length) {
      run.status = 'completed'; run.conclusion = 'failure';
      run.jobs.push({ id: 'workflow', status: 'completed', conclusion: 'failure', ok: false, log: wf.errors.map(e => `Invalid workflow file: ${e}`) });
    } else {
      run.wf = wf;
      run.jobs = wf.jobs.map(j => ({ id: j.id, def: j, status: 'queued', conclusion: null, ok: false, log: [] }));
    }
    bare.meta.runs.unshift(run);
    if (run.status !== 'completed') executeRun(world, bare, run);
    else world.emit({ type: 'workflow-run', url: bare.meta.url, run });
    started.push(run);
  }
  return started;
}

export function executeRun(world, bare, run) {
  const flat = world.readTreeFlat(world.commit(run.hash).tree);
  const base = ctxFor(bare, run);
  let progress = true;
  while (progress) {
    progress = false;
    for (const job of run.jobs) {
      if (job.status !== 'queued') continue;
      const deps = job.def.needs.map(n => run.jobs.find(j => j.id === n));
      if (deps.some(d => d.status !== 'completed')) continue;
      const depsFailed = deps.some(d => d.conclusion === 'failure');
      const depsSkipped = deps.some(d => d.conclusion === 'skipped');
      let cond;
      try {
        cond = job.def.if ? truthy(evalExpr(job.def.if, { ...base, __status: depsFailed ? 'failure' : 'success', needs: Object.fromEntries(deps.map(d => [d.id, { result: d.conclusion }])) })) && (/always\(\)|failure\(\)/.test(job.def.if) || (!depsFailed && !depsSkipped)) : (!depsFailed && !depsSkipped);
      } catch (e) {
        job.status = 'completed'; job.conclusion = 'failure'; job.log = [`Error evaluating 'if': ${e.message}`]; progress = true; continue;
      }
      progress = true;
      if (!cond) {
        job.status = 'completed'; job.conclusion = 'skipped'; job.ok = true;
        job.log = [depsFailed ? `Skipped: a job it needs failed (${deps.filter(d => d.conclusion === 'failure').map(d => d.id).join(', ')})` : depsSkipped ? 'Skipped: a job it needs was skipped' : `Skipped: if: ${job.def.if} was false`];
        continue;
      }
      if (job.def.environment?.name) {
        let envName, url;
        try { envName = interpolate(job.def.environment.name, base); url = job.def.environment.url ? interpolate(job.def.environment.url, base) : null; } catch { envName = job.def.environment.name; }
        job.envName = envName;
        const envCfg = ensureEnvironment(bare, envName, url);
        if (envCfg.branches && !(run.refType === 'tag' ? anyGlob(envCfg.tags || [], run.branch) : anyGlob(envCfg.branches, run.branch))) {
          job.status = 'completed'; job.conclusion = 'failure';
          job.log = [`Branch "${run.branch}" is not allowed to deploy to ${envName} due to environment protection rules.`];
          continue;
        }
        if (envCfg.reviewers?.length && !job.approval) {
          job.status = 'waiting';
          job.log = [`Waiting for review: ${envName} needs approval to start deploying changes.`, `Required reviewers: ${envCfg.reviewers.join(', ')}`];
          world.emit({ type: 'deployment-waiting', url: bare.meta.url, run: run.id, env: envName });
          continue;
        }
      }
      runJob(world, bare, run, job, flat, base);
    }
  }
  const waiting = run.jobs.some(j => j.status === 'waiting');
  if (waiting) { run.status = 'waiting'; run.conclusion = null; }
  else if (run.jobs.every(j => j.status === 'completed')) {
    run.status = 'completed';
    run.conclusion = run.jobs.some(j => j.conclusion === 'failure') ? 'failure' : 'success';
  }
  delete run.wfCache;
  world.emit({ type: 'workflow-run', url: bare.meta.url, run });
}

function runJob(world, bare, run, job, flat, base) {
  // DevOps Conquest: jobs run on simulated runner machines when the universe provides one
  const U = world.uni || world;
  if (U.realRunner) { U.realRunner({ world, bare, run, job, flat, base, interpolate, evalExpr, truthy }); return; }
  const def = job.def;
  job.log = [`Runner: ${def.runsOn}`];
  if (job.approval) job.log.push(`Deployment to ${job.envName} approved by ${job.approval.by}`);
  let ok = true;
  for (const s of def.steps) {
    const label = s.name || (s.uses ? `Run ${s.uses}` : `Run ${s.run.split('\n')[0]}`);
    if (s.if) {
      let c;
      try { c = truthy(evalExpr(s.if, { ...base, __status: ok ? 'success' : 'failure' })); } catch (e) { job.log.push(`${label}: error in if: ${e.message}`); ok = false; break; }
      if (!c) { job.log.push(`${label} (skipped)`); continue; }
    } else if (!ok) break;
    if (s.uses) { job.log.push(`Run ${s.uses}`); continue; }
    let env;
    try {
      env = {};
      for (const src of [run.wf.env, def.env, s.env]) for (const [k, v] of Object.entries(src || {})) env[k] = interpolate(v ?? '', base);
    } catch (e) { job.log.push(`${label}: ${e.message}`); ok = false; break; }
    if (s.name) job.log.push(s.name);
    for (const line of s.run.split('\n').map(l => l.trim()).filter(Boolean)) {
      let cmd;
      try { cmd = interpolate(line, base); } catch (e) { job.log.push(`Error in expression: ${e.message}`); ok = false; break; }
      const r = simulateRun(cmd, flat, world, { env, bare, run, job: { ...def, environment: job.envName ? { name: job.envName } : null } });
      job.log.push(`$ ${line}`, ...r.log.map(l => '  ' + l));
      if (!r.ok) { ok = false; break; }
    }
  }
  job.status = 'completed';
  job.conclusion = ok ? 'success' : 'failure';
  job.ok = ok;
}

export function approveDeployment(world, bare, runId, { by, approve = true } = {}) {
  const run = bare.meta.runs.find(r => r.id === runId);
  if (!run || run.status !== 'waiting') return null;
  const env = n => bare.meta.environments?.[n];
  const waiting = run.jobs.filter(j => j.status === 'waiting');
  for (const j of waiting) {
    const reviewers = env(j.envName)?.reviewers || [];
    if (reviewers.length && !reviewers.includes(by)) throw new Error(`${by} is not a required reviewer for ${j.envName}`);
    if (approve) { j.approval = { by, time: world.time }; j.status = 'queued'; }
    else { j.status = 'completed'; j.conclusion = 'failure'; j.log = [`Deployment to ${j.envName} rejected by ${by}`]; }
  }
  world.emit({ type: 'deployment-review', url: bare.meta.url, run: run.id, approve, by, envs: waiting.map(j => j.envName) });
  executeRun(world, bare, run);
  return run;
}

export function rerun(world, bare, run, { failedOnly = false } = {}) {
  if (!run.wf) throw new Error('This run cannot be re-run because its workflow file is invalid. Fix the file and push again.');
  const reset = new Set();
  for (const j of run.jobs) if (!failedOnly || j.conclusion === 'failure' || j.conclusion === 'skipped') reset.add(j.id);
  let grew = true;
  while (grew) { grew = false; for (const j of run.jobs) if (!reset.has(j.id) && j.def.needs.some(n => reset.has(n))) { reset.add(j.id); grew = true; } }
  for (const j of run.jobs) if (reset.has(j.id)) Object.assign(j, { status: 'queued', conclusion: null, ok: false, log: [], approval: null });
  run.attempt++;
  run.time = world.time;
  run.status = 'queued';
  executeRun(world, bare, run);
  return run;
}

export function runIcon(r) {
  if (r.status === 'waiting') return 'waiting';
  if (r.status !== 'completed') return 'running';
  return r.conclusion;
}
