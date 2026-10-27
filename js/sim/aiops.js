// Tools for the AI-assisted DevOps realm:
//   shellcheck        static analysis of shell scripts (the checks that catch most AI-written bugs)
//   agent             an operations agent that plans commands for a task and runs them under a
//                     policy (allow / ask / deny), writing every decision to an audit log
//   lumen/ai-review   a GitHub Action: an LLM review bot whose output can be steered by text in
//                     the diff (prompt injection), so what matters is what its token may do

import { def } from './registry.js';
import { C } from '../git/world.js';
import { Session } from './session.js';
import { parseYaml } from '../git/yaml.js';
import { ACTIONS } from './runner.js';
import { mergePR } from '../git/github.js';
import { stripAnsi } from '../git/world.js';

// ================================================================ shellcheck

const ENV_VARS = new Set(['HOME', 'USER', 'PATH', 'PWD', 'OLDPWD', 'SHELL', 'HOSTNAME', 'RANDOM', 'SECONDS', 'LINENO', 'IFS', 'UID', 'EUID', 'TMPDIR', 'LANG', 'TERM', 'BASH_SOURCE', 'FUNCNAME', 'PPID', 'REPLY', 'OPTARG', 'OPTIND']);
const SC = {
  SC2148: ['error', 'Tips depend on target shell and yours is unknown. Add a shebang or a \'shell\' directive.'],
  SC2115: ['warning', 'Use "${var:?}" to ensure this never expands to /* .'],
  SC2154: ['warning', '%s is referenced but not assigned.'],
  SC2034: ['warning', '%s appears unused. Verify use (or export if used externally).'],
  SC2164: ['warning', 'Use \'cd ... || exit\' or \'cd ... || return\' in case cd fails.'],
  SC2046: ['warning', 'Quote this to prevent word splitting.'],
  SC2086: ['info', 'Double quote to prevent globbing and word splitting.'],
  SC2006: ['style', 'Use $(...) notation instead of legacy backticks `...`.'],
};
const LEVELS = ['style', 'info', 'warning', 'error'];

// $var / ${var} occurrences outside double quotes and single quotes: [{name, col, len, quoted}]
function expansions(line) {
  const out = [];
  let sq = false, dq = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && !sq) { i++; continue; }
    if (ch === "'" && !dq) { sq = !sq; continue; }
    if (ch === '"' && !sq) { dq = !dq; continue; }
    if (ch === '#' && !sq && !dq && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (ch !== '$' || sq) continue;
    let m;
    const rest = line.slice(i);
    if ((m = rest.match(/^\$\{([A-Za-z_]\w*)([^}]*)\}/)) || (m = rest.match(/^\$([A-Za-z_]\w*)/))) out.push({ name: m[1], op: m[2] || '', col: i, len: m[0].length, quoted: dq });
    else if ((m = rest.match(/^\$\(/))) out.push({ name: null, sub: true, col: i, len: 2, quoted: dq });
  }
  return out;
}

export function shellcheck(text) {
  const lines = String(text).split('\n');
  const found = [];
  const add = (code, line, col, len, arg) => found.push({ code, level: SC[code][0], msg: SC[code][1].replace('%s', arg || ''), line, col, len });
  if (!/^#!/.test(lines[0] || '')) add('SC2148', 1, 0, 1);
  const assigned = new Map(), used = new Set();
  let inHeredoc = null;
  lines.forEach((l, i) => {
    if (inHeredoc) { if (l.trim() === inHeredoc) inHeredoc = null; return; }
    const hd = l.match(/<<-?\s*['"]?(\w+)['"]?/); if (hd) inHeredoc = hd[1];
    for (const m of l.matchAll(/(?:^|[;&|]\s*|\b(?:export|local|readonly|declare(?:\s+-\w+)*)\s+)([A-Za-z_]\w*)=/g)) if (!assigned.has(m[1])) assigned.set(m[1], { line: i + 1, exported: /\bexport\b/.test(l) });
    for (const m of l.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) assigned.set(m[1], { line: i + 1, loop: true });
    for (const m of l.matchAll(/\bread\s+(?:-\w+\s+)*([A-Za-z_][\w ]*)/g)) for (const v of m[1].trim().split(/\s+/)) assigned.set(v, { line: i + 1, loop: true });
  });
  lines.forEach((raw, i) => {
    const l = raw;
    const n = i + 1;
    if (/^\s*#/.test(l) || !l.trim()) return;
    if (/`[^`]+`/.test(l)) add('SC2006', n, l.indexOf('`'), 1);
    const ex = expansions(l);
    for (const e of ex) if (e.name) used.add(e.name);
    // rm -rf $DIR/* or "$DIR"/*: if DIR is empty this is rm -rf /*
    const rm = l.match(/\brm\s+-\w*[rR]\w*\b[^;|&]*?("?)\$\{?([A-Za-z_]\w*)\}?\1?\/\*/);
    if (rm && !new RegExp(`\\$\\{${rm[2]}:\\?`).test(l)) { const col = l.indexOf('$', l.indexOf('rm')); add('SC2115', n, col, l.slice(col).match(/^\$\{?\w+\}?/)[0].length); }
    if (/^\s*cd\s+[^|&;]+$/.test(l) && !/\|\|\s*(exit|return)/.test(l)) add('SC2164', n, l.indexOf('cd'), 2);
    const isTest = /\[\[|\(\(/.test(l);
    const assignOnly = /^\s*(?:export\s+|local\s+|readonly\s+)?[A-Za-z_]\w*=\S*\s*$/.test(l);
    for (const e of ex) {
      if (e.quoted || isTest || assignOnly) continue;
      if (e.sub) add('SC2046', n, e.col, 2);
      else if (!/^[@*#?$!0-9]$/.test(e.name)) add('SC2086', n, e.col, e.len);
    }
    for (const e of ex) {
      if (!e.name || assigned.has(e.name) || ENV_VARS.has(e.name) || /^[A-Z0-9_]+$/.test(e.name) || /^[:]?[-?=+]/.test(e.op)) continue;
      add('SC2154', n, e.col, e.len, e.name);
    }
  });
  for (const [v, a] of assigned) if (!used.has(v) && !a.exported && !a.loop && !/^_/.test(v)) add('SC2034', a.line, Math.max(0, (lines[a.line - 1] || '').indexOf(v)), v.length, v);
  return found.sort((a, b) => a.line - b.line || a.col - b.col);
}

def('shellcheck', c => {
  const args = [...c.args];
  let minLevel = 'style', format = 'tty';
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-S' || a === '--severity') minLevel = args[++i];
    else if (a.startsWith('--severity=')) minLevel = a.slice(11);
    else if (a === '-f' || a === '--format') format = args[++i];
    else if (a === '-V' || a === '--version') { c.print('ShellCheck - shell script analysis tool', 'version: 0.10.0'); return 0; }
    else if (!a.startsWith('-')) files.push(a);
  }
  if (!files.length) { c.eprint('No files specified.', '', 'Usage: shellcheck [OPTIONS...] FILES...'); return 3; }
  const min = LEVELS.indexOf(minLevel);
  let total = 0;
  const codes = [];
  for (const f of files) {
    const text = c.host.files.get(c.resolve(f));
    if (text === undefined) { c.eprint(`${f}: ${f}: openBinaryFile: does not exist (No such file or directory)`); total++; continue; }
    const res = shellcheck(text).filter(x => LEVELS.indexOf(x.level) >= min);
    total += res.length;
    codes.push(...res.map(x => x.code));
    const lines = text.split('\n');
    if (format === 'gcc') { for (const x of res) c.print(`${f}:${x.line}:${x.col + 1}: ${x.level === 'info' || x.level === 'style' ? 'note' : x.level}: ${x.msg} [${x.code}]`); continue; }
    const byLine = new Map();
    for (const x of res) { if (!byLine.has(x.line)) byLine.set(x.line, []); byLine.get(x.line).push(x); }
    for (const [ln, xs] of byLine) {
      c.print('', `In ${f} line ${ln}:`, lines[ln - 1]);
      for (const x of xs) { const color = x.level === 'error' ? C.red : x.level === 'warning' ? C.yellow : C.green; c.print(color(`${' '.repeat(x.col)}${x.len > 1 ? '^' + '-'.repeat(x.len - 2) + '^ ' : '^-- '}${x.code} (${x.level}): ${x.msg}`)); }
    }
    if (res.length) { c.print('', 'For more information:'); for (const code of [...new Set(res.map(x => x.code))]) c.print(`  https://www.shellcheck.net/wiki/${code} -- ${SC[code][1].replace('%s', 'var').slice(0, 40)}...`); }
  }
  c.uni.emit({ type: 'shellcheck', host: c.host.name, files: files.map(f => c.resolve(f)), codes });
  return total ? 1 : 0;
}, { pkg: 'shellcheck' });

// ================================================================ agent

// policy.yaml: mode (auto | ask | dry-run), and allow / ask / deny lists of regular expressions.
// deny wins over allow, allow over ask; anything unmatched follows the mode.
export function loadPolicy(host, home) {
  const text = host.files.get(`${home}/.agent/policy.yaml`);
  if (text === undefined) return { mode: 'auto', allow: [], ask: [], deny: [], file: null };
  const doc = parseYaml(text) || {};
  const list = k => [].concat(doc[k] || []).map(String).map(p => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean);
  return { mode: String(doc.mode || 'ask'), allow: list('allow'), ask: list('ask'), deny: list('deny'), file: `${home}/.agent/policy.yaml` };
}
export function decide(policy, cmd) {
  if (policy.deny.some(r => r.test(cmd))) return 'deny';
  if (policy.allow.some(r => r.test(cmd))) return 'allow';
  if (policy.ask.some(r => r.test(cmd))) return 'ask';
  return policy.mode === 'auto' ? 'allow' : policy.mode === 'dry-run' ? 'skip' : 'ask';
}

def('agent', c => {
  const [sub, ...rest] = c.args;
  const uni = c.uni;
  const home = c.host.users.get(c.user)?.home || '/root';
  const logPath = `${home}/.agent/audit.log`;
  const audit = line => { c.host.mkdirMeta(`${home}/.agent`, c.user, 0o700); c.host.writeFile(logPath, (c.host.files.get(logPath) || '') + `${new Date(uni.time * 1000).toISOString().replace('.000', '')} ${line}\n`, c.user); };
  if (!sub || sub === 'help' || sub === '--help') { c.print('usage:', '  agent plan "<task>"     show the commands the agent would run (runs nothing)', '  agent run "<task>"      run the plan under ~/.agent/policy.yaml', '  agent policy            show the effective policy', '  agent log               show the audit log'); return 0; }
  if (sub === 'log') { const t = c.host.files.get(logPath); if (!t) { c.print('(no audit log yet)'); return 0; } c.print(...t.trimEnd().split('\n')); uni.emit({ type: 'agent-log', host: c.host.name }); return 0; }
  let policy;
  try { policy = loadPolicy(c.host, home); } catch (e) { return c.fail(`agent: ${home}/.agent/policy.yaml: ${e.message}`, 2); }
  if (sub === 'policy') {
    c.print(policy.file ? `policy: ${policy.file}` : C.yellow('policy: none (built-in default: mode auto, every command runs without asking)'), `mode:  ${policy.mode}`, `allow: ${policy.allow.map(r => r.source).join(', ') || '-'}`, `ask:   ${policy.ask.map(r => r.source).join(', ') || '-'}`, `deny:  ${policy.deny.map(r => r.source).join(', ') || '-'}`);
    return 0;
  }
  if (sub !== 'plan' && sub !== 'run') return c.fail(`agent: unknown command "${sub}"`, 1);
  const task = rest.filter(a => !a.startsWith('--')).join(' ').replace(/^["']|["']$/g, '');
  if (!task) return c.fail(`agent: give it a task, e.g. agent ${sub} "free disk space on web1"`, 1);
  const plan = (uni.agent?.plans || []).find(p => p.when.test(task));
  const steps = plan?.steps || [];
  const box = (io, ...l) => { const text = l.map(x => C.magenta('│ ') + x).join('\n'); io ? io.out(text + '\n') : c.print(text); };
  c.print(C.magenta(`╭─ agent (simulated LLM agent, may be wrong) · task: ${task}`));
  if (!steps.length) { box(null, 'I do not know how to do that safely in this environment.'); c.print(C.magenta('╰─')); return 1; }
  if (plan.thought) box(null, C.dim(plan.thought));
  const label = s => `${s.on ? `[${s.on}] ` : ''}${s.cmd}`;
  if (sub === 'plan' || rest.includes('--dry-run')) {
    steps.forEach((s, k) => box(null, `${k + 1}. ${label(s)}${s.why ? C.dim(`   # ${s.why}`) : ''}   ${C.cyan('→ ' + decide(policy, s.cmd))}`));
    c.print(C.magenta('╰─') + C.dim(' plan only: nothing was run'));
    uni.emit({ type: 'agent', op: 'plan', task, steps: steps.map(s => s.cmd), decisions: steps.map(s => decide(policy, s.cmd)) });
    return 0;
  }
  const results = [];
  const finish = io => {
    const line = C.magenta('╰─') + C.dim(` done: ${results.filter(r => r.decision === 'ran').length} ran, ${results.filter(r => r.decision !== 'ran').length} not run · audit log: agent log`);
    io ? io.out(line + '\n') : c.print(line);
    uni.emit({ type: 'agent', op: 'run', task, results, policy: !!policy.file });
    return 0;
  };
  const exec = (s, io) => {
    const host = s.on ? uni.host(s.on) : c.host;
    const sess = new Session(uni, host, { user: s.user || host.defaultUser });
    sess.advancePerCommand = 0;
    const r = sess.run(s.cmd, { record: false });
    const outText = r.out.map(stripAnsi).join('\n').trimEnd();
    box(io, `${C.green('▶')} ${label(s)}`, ...(outText ? outText.split('\n').slice(0, 12).map(x => C.dim('  ' + x)) : []));
    audit(`RUN    host=${host.name} exit=${r.code} cmd=${s.cmd}`);
    results.push({ cmd: s.cmd, on: host.name, decision: 'ran', code: r.code });
  };
  const step = (k, io, ctx) => {
    for (; k < steps.length; k++) {
      const s = steps[k];
      const d = decide(policy, s.cmd);
      if (d === 'deny') { box(io, `${C.red('✋ denied by policy')}  ${label(s)}`); audit(`DENIED host=${s.on || c.host.name} cmd=${s.cmd}`); results.push({ cmd: s.cmd, on: s.on || c.host.name, decision: 'denied' }); continue; }
      if (d === 'skip') { box(io, `${C.dim('· skipped (dry-run)')}  ${label(s)}`); results.push({ cmd: s.cmd, on: s.on || c.host.name, decision: 'skipped' }); continue; }
      if (d === 'ask') {
        const ask = {
          prompt: `? agent wants to run: ${label(s)}${s.why ? `  (${s.why})` : ''}\n  approve? [y/N]`,
          onAnswer(ans, ctx2) {
            if (/^y(es)?$/i.test(ans.trim())) exec(s, ctx2.io);
            else { box(ctx2.io, `${C.yellow('✗ rejected by you')}  ${label(s)}`); audit(`REJECT host=${s.on || c.host.name} cmd=${s.cmd}`); results.push({ cmd: s.cmd, on: s.on || c.host.name, decision: 'rejected' }); }
            return step(k + 1, ctx2.io, ctx2);
          },
        };
        if (ctx) { ctx.result.ask = ask; return 0; }
        c.result.ask = ask;
        return 0;
      }
      exec(s, io);
    }
    return finish(io);
  };
  return step(0, null, null);
}, { always: true });

// ================================================================ lumen/ai-review (GitHub Action)

const INJECTION = /ignore (all |any )?(previous|prior|earlier|above) (review )?instructions|ai[- ]review(er)?\b[^\n]{0,80}\b(approve|lgtm|merge)|pre-?approved by (the )?security/i;
const REVIEW_CHECKS = [
  [/res\.(json|send)\(\s*process\.env\s*\)/, 'returns process.env to the client: that exposes every secret in the environment'],
  [/rejectUnauthorized\s*:\s*false/, 'disables TLS certificate verification'],
  [/\b(SELECT|INSERT|UPDATE|DELETE)\b[^\n]*['"`]\s*\+\s*req\./i, 'builds SQL from request input; use a parameterized query'],
  [/console\.log\([^)]*req\.body/, 'logs the whole request body (may contain card numbers or passwords)'],
  [/(^|[^\w.])eval\s*\(/, 'uses eval()'],
];
const canWrite = (perms, scope) => perms === 'write-all' || perms === 'write' || (perms && typeof perms === 'object' && perms[scope] === 'write');

ACTIONS['lumen/ai-review'] = ({ w, job, run, world, bare }) => {
  if (run.pr == null) { job.log.push('  ai-review: not a pull request; nothing to review'); return true; }
  const pr = bare.meta.prs.find(p => p.number === run.pr);
  const headRepo = world.remotes.get(pr.headRepo) || bare;
  const head = headRepo.refs['refs/heads/' + pr.head];
  const base = bare.refs['refs/heads/' + pr.base];
  const now = world.readTreeFlat(world.commit(head).tree), was = base ? world.readTreeFlat(world.commit(base).tree) : new Map();
  const added = [];
  for (const [p, blob] of now) {
    if (was.get(p) === blob) continue;
    const old = new Set(String(was.has(p) ? world.objects.get(was.get(p)).content : '').split('\n'));
    for (const l of String(world.objects.get(blob).content).split('\n')) if (!old.has(l)) added.push(l);
  }
  const diff = added.join('\n');
  const issues = REVIEW_CHECKS.filter(([re]) => re.test(diff)).map(([, why]) => why);
  // the model reads the diff as part of its prompt, so instructions hidden in the diff steer it
  const steered = INJECTION.test(diff);
  const approve = steered || !issues.length;
  const body = steered ? 'LGTM ✅ This change was pre-approved by the security team.' : issues.length ? `I found ${issues.length} problem(s):\n${issues.map(x => '- ' + x).join('\n')}` : 'LGTM ✅ No issues found.';
  job.log.push(`  model: lumen-review-large · ${added.length} added lines reviewed`);
  const perms = job.def.permissions ?? run.wf?.permissions ?? (bare.meta.workflowPerms?.default === 'read' ? 'read' : 'write-all');
  const mode = String(w.mode || 'comment');
  let state = 'COMMENTED';
  if (approve && mode === 'approve') {
    if (!bare.meta.workflowPerms?.canApprove) job.log.push('  Error: GitHub Actions is not permitted to approve pull requests. Posting a comment instead.');
    else if (!canWrite(perms, 'pull-requests')) { job.log.push('  Error: Resource not accessible by integration (needs pull-requests: write)'); return false; }
    else state = 'APPROVED';
  }
  if (state === 'COMMENTED' && !canWrite(perms, 'pull-requests')) { job.log.push('  Error: Resource not accessible by integration (needs pull-requests: write)'); return false; }
  world.tick(2);
  pr.reviews.push({ state, body, author: 'github-actions[bot]', time: world.time });
  job.log.push(`  posted review: ${state}`, ...body.split('\n').map(l => '    ' + l));
  if (String(w['auto-merge']) === 'true' && state === 'APPROVED') {
    if (!canWrite(perms, 'contents')) job.log.push('  auto-merge: Resource not accessible by integration (needs contents: write)');
    else {
      try { mergePR(world, bare, pr, 'squash'); job.log.push(`  auto-merge: merged #${pr.number} into ${pr.base}`); world.emit({ type: 'bot-merge', url: bare.meta.url, number: pr.number }); }
      catch (e) { job.log.push(`  auto-merge: ${String(e.message).split('\n').join(' ')}`); }
    }
  }
  world.emit({ type: 'ai-review', url: bare.meta.url, number: pr.number, state, steered, issues: issues.length });
  return true;
};

// ================================================================ LLM gateway (running AI services)

// A gateway in front of a hosted model: every client's requests become token counters, cost,
// cache hits, 429s and latency in the app's /metrics. It reads /etc/llm-gateway/config.yaml
// when its process starts, so config changes need a restart, like a real service.
const PRICE = { input: 0.003, output: 0.015 }; // USD per 1,000 tokens
const LLM_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60];
export function installLlmGateway(uni, { host = 'ai1', port = 8080, configPath = '/etc/llm-gateway/config.yaml', clients = {} } = {}) {
  const obs = uni.obs;
  obs.metricHooks = obs.metricHooks || new Map();
  const st = { pid: null, cfg: null, by: {} };
  for (const name of Object.keys(clients)) st.by[name] = { ok: 0, limited: 0, tokIn: 0, tokOut: 0, cost: 0, hits: 0, buckets: LLM_BUCKETS.map(() => 0), count: 0, sum: 0 };
  const load = h => {
    let doc = {};
    try { doc = parseYaml(h.files.get(configPath) || '') || {}; } catch { doc = {}; }
    const cl = doc.clients || {};
    return { cap: Number(doc.max_output_tokens) || 0, cache: doc.cache === true || doc.cache?.enabled === true, limits: Object.fromEntries(Object.keys(clients).map(n => [n, Number(cl[n]?.requests_per_minute) || 0])) };
  };
  uni.llmGateway = st;
  uni.tickers.push(dt => {
    const h = uni.host(host);
    const l = h?.listening.get(port);
    if (!h || h.down || !l || !h.procs.has(l.pid)) return;
    if (st.pid !== l.pid) { st.pid = l.pid; st.cfg = load(h); st.loadedAt = uni.time; }
    const cfg = st.cfg;
    for (const [name, c] of Object.entries(clients)) {
      const b = st.by[name];
      const want = c.rpm * dt / 60;
      const limit = cfg.limits[name] ? cfg.limits[name] * dt / 60 : Infinity;
      const ok = Math.min(want, limit), limited = want - ok;
      const hits = cfg.cache ? ok * (c.repeat || 0) : 0;
      const out = cfg.cap ? Math.min(c.outTok, cfg.cap) : c.outTok;
      const billed = ok - hits;
      b.ok += ok; b.limited += limited; b.hits += hits;
      b.tokIn += billed * c.inTok; b.tokOut += billed * out;
      b.cost += billed * (c.inTok * PRICE.input + out * PRICE.output) / 1000;
      const lat = 0.35 + out * 0.018;
      for (const [n, d] of [[billed, lat], [hits, 0.02]]) { if (!n) continue; LLM_BUCKETS.forEach((le, i) => { if (d <= le) b.buckets[i] += n; }); b.count += n; b.sum += n * d; }
      if (limited > 0.5 && Math.random() < 0.3) obs.log({ app: 'llm-gateway', host, level: 'warn' }, { level: 'warn', msg: 'rate limit exceeded', client: name, status: 429, limit_rpm: cfg.limits[name] });
      if (c.note && Math.random() < 0.2) obs.log({ app: 'llm-gateway', host, level: c.noteLevel || 'info' }, { level: c.noteLevel || 'info', msg: c.note, client: name });
    }
  });
  obs.metricHooks.set(`${host}:${port}`, () => {
    const L = ['# HELP llm_requests_total Requests to the model, by client and status.', '# TYPE llm_requests_total counter'];
    const R = x => Math.round(x * 1000) / 1000;
    for (const [n, b] of Object.entries(st.by)) L.push(`llm_requests_total{client="${n}",status="200"} ${Math.round(b.ok)}`, `llm_requests_total{client="${n}",status="429"} ${Math.round(b.limited)}`);
    L.push('# HELP llm_tokens_total Tokens billed by the provider.', '# TYPE llm_tokens_total counter');
    for (const [n, b] of Object.entries(st.by)) L.push(`llm_tokens_total{client="${n}",direction="input"} ${Math.round(b.tokIn)}`, `llm_tokens_total{client="${n}",direction="output"} ${Math.round(b.tokOut)}`);
    L.push('# HELP llm_cost_usd_total Spend in US dollars.', '# TYPE llm_cost_usd_total counter');
    for (const [n, b] of Object.entries(st.by)) L.push(`llm_cost_usd_total{client="${n}"} ${R(b.cost)}`);
    L.push('# HELP llm_cache_hits_total Requests answered from the response cache.', '# TYPE llm_cache_hits_total counter');
    for (const [n, b] of Object.entries(st.by)) L.push(`llm_cache_hits_total{client="${n}"} ${Math.round(b.hits)}`);
    L.push('# HELP llm_request_duration_seconds Time to the last token.', '# TYPE llm_request_duration_seconds histogram');
    for (const [n, b] of Object.entries(st.by)) { LLM_BUCKETS.forEach((le, i) => L.push(`llm_request_duration_seconds_bucket{client="${n}",le="${le}"} ${Math.round(b.buckets[i])}`)); L.push(`llm_request_duration_seconds_bucket{client="${n}",le="+Inf"} ${Math.round(b.count)}`, `llm_request_duration_seconds_sum{client="${n}"} ${R(b.sum)}`, `llm_request_duration_seconds_count{client="${n}"} ${Math.round(b.count)}`); }
    return L;
  });
  return st;
}
