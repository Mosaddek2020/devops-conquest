// Security tools for the DevSecOps realm. Each one inspects the simulated world the way the
// real tool does, so a finding goes away only when the underlying problem is fixed:
//   gitleaks  secrets in git history, the working tree or the staged changes
//   semgrep   code patterns (SQL built from request input, shell commands, eval…), custom rules
//   trivy     image / filesystem / SBOM vulnerabilities, secrets, and IaC misconfigurations
//   syft      SBOMs (table, CycloneDX, SPDX) for a directory or an image
//   zap-baseline.py / zap-full-scan.py   DAST against a running site
//   lynis     host hardening audit
//   cosign    signing and verifying images in the registry
//   sshd -t   checks /etc/ssh/sshd_config

import { def, opts } from './registry.js';
import { C } from '../git/world.js';
import { normPath, dirname, basename } from './fsx.js';
import { httpRequest } from './net.js';
import { engineOf, vulnsOf, CVES } from './docker.js';
import { parseRef } from './docker-images.js';
import { auditDeps } from './cmd/system.js';
import { parseYaml } from '../git/yaml.js';
import { revList } from '../git/core.js';
import { sshdConfig } from './sshdconf.js';
import { ACTIONS } from './runner.js';
import { installPkg } from './packages.js';

const SEVS = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const sevColor = s => s === 'CRITICAL' ? C.red(s) : s === 'HIGH' ? C.red(s) : s === 'MEDIUM' ? C.yellow(s) : s;
const pad = (s, n) => String(s).padEnd(n);
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.terraform)(\/|$)/;

// every regular file under a directory (absolute paths), skipping dependency folders
function walk(host, dir) {
  const root = dir.replace(/\/$/, '') || '/';
  const out = [];
  for (const p of host.files.keys()) if ((p === root || p.startsWith(root + '/')) && !SKIP_DIRS.test(p.slice(root.length))) out.push(p);
  return out.sort();
}
const rel = (root, p) => p === root ? basename(p) : p.slice(root.replace(/\/$/, '').length + 1);

// ================================================================ secrets (shared by gitleaks and trivy)

export const LEAK_RULES = [
  { id: 'aws-access-token', title: 'AWS Access Key ID', sev: 'CRITICAL', desc: 'Identified a pattern that may indicate AWS credentials, risking unauthorized cloud resource access and data breaches on AWS platforms.', re: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/ },
  { id: 'github-pat', title: 'GitHub Personal Access Token', sev: 'CRITICAL', desc: 'Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access and sensitive content exposure.', re: /\b(ghp_[0-9a-zA-Z]{36})\b/ },
  { id: 'slack-bot-token', title: 'Slack Bot Token', sev: 'HIGH', desc: 'Identified a Slack Bot token, which may compromise bot integrations and communication channel security.', re: /\b(xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*)\b/ },
  { id: 'stripe-access-token', title: 'Stripe Secret Key', sev: 'CRITICAL', desc: 'Found a Stripe Access Token, posing a risk to payment processing services and sensitive financial data.', re: /\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})\b/ },
  { id: 'private-key', title: 'Asymmetric Private Key', sev: 'HIGH', desc: 'Identified a Private Key, which may compromise cryptographic security and sensitive data encryption.', re: /(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----)/ },
  { id: 'generic-api-key', title: 'Generic secret', sev: 'HIGH', desc: 'Detected a Generic API Key, potentially exposing access to various services and sensitive operations.', re: /(?:key|api|token|secret|client|passwd|password|auth|access)[\w.-]{0,40}[ \t]*(?:=|:|:=|=>)[ \t]*['"]?([\w.=\-/+~@]{10,150})['"]?/i, entropy: 3.5 },
];

function entropy(s) {
  const f = {};
  for (const ch of s) f[ch] = (f[ch] || 0) + 1;
  return -Object.values(f).reduce((e, n) => e + (n / s.length) * Math.log2(n / s.length), 0);
}

// findings in some lines of text: [{rule, line (1-based), match, secret, entropy}]
export function scanSecrets(text, { only = null } = {}) {
  const out = [];
  const lines = String(text).split('\n');
  lines.forEach((l, i) => {
    if ((only && !only.has(i + 1)) || /gitleaks:allow/.test(l)) return;
    const hit = [];
    for (const r of LEAK_RULES) {
      const m = l.match(r.re);
      if (!m) continue;
      const secret = m[1];
      if (hit.some(h => h.secret.includes(secret) || secret.includes(h.secret))) continue;
      if (r.entropy) {
        if (/^\$\{|^\$\(|^<|^\{\{/.test(secret) || /^(true|false|null|undefined|changeme|example|password|required|optional)$/i.test(secret) || entropy(secret) < r.entropy) continue;
        if (/^[a-z_.]+$/i.test(secret) && !/\d/.test(secret)) continue; // an identifier, not a secret
      }
      hit.push({ rule: r, line: i + 1, match: m[0].trim(), secret, entropy: entropy(secret) });
    }
    out.push(...hit);
  });
  return out;
}

// added lines between two versions of a file (by content, like a diff's + lines)
function addedLines(oldText, newText) {
  const old = new Map();
  for (const l of String(oldText ?? '').split('\n')) old.set(l, (old.get(l) || 0) + 1);
  const added = new Set();
  String(newText).split('\n').forEach((l, i) => { if (old.get(l)) old.set(l, old.get(l) - 1); else added.add(i + 1); });
  return added;
}

// secrets added by every commit reachable from `heads`
export function scanHistory(world, heads) {
  const commits = revList(world, heads.filter(Boolean));
  const findings = [];
  for (const h of commits) {
    const cm = world.commit(h);
    const now = world.readTreeFlat(cm.tree);
    const before = cm.parents[0] ? world.readTreeFlat(world.commit(cm.parents[0]).tree) : new Map();
    for (const [p, blob] of now) {
      if (before.get(p) === blob || SKIP_DIRS.test('/' + p)) continue;
      const text = world.objects.get(blob)?.content ?? '';
      const oldText = before.has(p) ? world.objects.get(before.get(p))?.content : '';
      for (const f of scanSecrets(text, { only: addedLines(oldText, text) })) findings.push({ ...f, file: p, commit: h, author: cm.author, message: cm.message });
    }
  }
  return { findings, commits: commits.length };
}

function leakFingerprint(f) { return `${f.commit ? f.commit + ':' : ''}${f.file}:${f.rule.id}:${f.line}`; }

function printLeak(c, f, redact) {
  const red = s => redact ? s.replace(f.secret, 'REDACTED') : s;
  c.print(`Finding:     ${red(f.match)}`, `Secret:      ${redact ? 'REDACTED' : f.secret}`, `RuleID:      ${f.rule.id}`, `Entropy:     ${f.entropy.toFixed(6)}`, `File:        ${f.file}`, `Line:        ${f.line}`);
  if (f.commit) c.print(`Commit:      ${f.commit}`, `Author:      ${f.author.name}`, `Email:       ${f.author.email}`, `Date:        ${new Date(f.author.time * 1000).toISOString().replace('.000', '')}`);
  c.print(`Fingerprint: ${leakFingerprint(f)}`, '');
}

const GITLEAKS_LOGO = ['', '    ○', '    │╲', '    │ ○', '    ○ ░', '    ░    gitleaks', ''];

def('gitleaks', c => {
  const [sub0, ...rest0] = c.args;
  if (!sub0 || sub0 === 'help' || sub0 === '--help' || sub0 === '-h') { c.print('Gitleaks scans code, past or present, for secrets', '', 'Usage:', '  gitleaks [command]', '', 'Available Commands:', '  git         scan git repositories for secrets', '  dir         scan directories or files for secrets', '  detect      detect secrets in code (git history by default; --no-git for files)', '  protect     protect secrets in code (scan staged changes with --staged)', '  version     display gitleaks version'); return 0; }
  if (sub0 === 'version' || sub0 === '--version') { c.print('8.21.2'); return 0; }
  const o = opts(rest0, { bool: ['-v', '--verbose', '--no-git', '--redact', '--staged', '--pre-commit', '--no-banner', '-q'], val: ['--source', '-s', '--report-path', '-r', '--report-format', '-f', '--exit-code', '--log-opts', '--gitleaks-ignore-path', '-i', '--log-level', '-l'] });
  const verbose = o['-v'] || o['--verbose'];
  const redact = !!o['--redact'];
  let mode = sub0 === 'dir' || (sub0 === 'detect' && o['--no-git']) ? 'dir' : sub0 === 'protect' || o['--staged'] ? 'staged' : sub0 === 'git' || sub0 === 'detect' ? 'git' : null;
  if (!mode) return c.fail(`Error: unknown command "${sub0}" for "gitleaks"\nRun 'gitleaks --help' for usage.`, 1);
  const src = c.resolve(o['--source'] || o['-s'] || o._[0] || '.');
  const t0 = c.uni.time;
  const ts = () => new Date(t0 * 1000).toISOString().slice(11, 16).replace(/^0/, '') + (new Date(t0 * 1000).getUTCHours() < 12 ? 'AM' : 'PM');
  if (!o['--no-banner'] && !o['-q']) c.eprint(...GITLEAKS_LOGO);
  let findings = [], scanned = '';
  if (mode === 'dir') {
    const st = c.host.stat(src);
    if (!st) return c.fail(`${ts()} FTL error="stat ${src}: no such file or directory"`, 1);
    const files = st.type === 'file' ? [src] : walk(c.host, src);
    for (const p of files) for (const f of scanSecrets(c.host.files.get(p))) findings.push({ ...f, file: st.type === 'file' ? basename(p) : rel(src, p) });
    scanned = `scanned ~${files.reduce((s, p) => s + (c.host.files.get(p) || '').length, 0)} bytes (${files.length} files)`;
  } else {
    const repo = c.host.findRepo(src);
    if (!repo) return c.fail(`${ts()} ERR [git] fatal: not a git repository (or any of the parent directories): .git\n${ts()} FTL failed to scan Git repository error="stderr is not empty"`, 1);
    const world = repo.world;
    if (mode === 'staged') {
      const head = repo.refs[repo.HEAD.replace(/^ref: /, '')] || (/^[0-9a-f]{40}$/.test(repo.HEAD) ? repo.HEAD : null);
      const before = head ? world.readTreeFlat(world.commit(head).tree) : new Map();
      for (const [p, blob] of repo.index) {
        if (before.get(p) === blob) continue;
        const text = world.objects.get(blob)?.content ?? '';
        for (const f of scanSecrets(text, { only: addedLines(before.has(p) ? world.objects.get(before.get(p))?.content : '', text) })) findings.push({ ...f, file: p });
      }
      scanned = `${[...repo.index].filter(([p, b]) => before.get(p) !== b).length} staged files scanned`;
    } else {
      const heads = Object.entries(repo.refs).filter(([r]) => r.startsWith('refs/heads/') || r.startsWith('refs/remotes/') || r.startsWith('refs/tags/')).map(([, h]) => world.peel ? world.peel(h) : h);
      const r = scanHistory(world, [...new Set(heads)]);
      findings = r.findings;
      scanned = `${r.commits} commits scanned.`;
    }
  }
  // .gitleaksignore: fingerprints of findings someone reviewed and accepted
  const root = c.host.findRepo(src)?.root || (c.host.stat(src)?.type === 'dir' ? src : dirname(src));
  const ignorePath = o['--gitleaks-ignore-path'] || o['-i'] ? c.resolve(o['--gitleaks-ignore-path'] || o['-i']) : root + '/.gitleaksignore';
  const ignored = new Set((c.host.files.get(ignorePath) || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  findings = findings.filter(f => !ignored.has(leakFingerprint(f)) && !ignored.has(`${f.file}:${f.rule.id}:${f.line}`));
  if (verbose) for (const f of findings) printLeak(c, f, redact);
  c.eprint(`${ts()} ${C.green('INF')} ${scanned}`, `${ts()} ${C.green('INF')} scan completed in ${12 + findings.length * 3}ms`);
  if (findings.length) c.eprint(`${ts()} ${C.yellow('WRN')} leaks found: ${findings.length}`);
  else c.eprint(`${ts()} ${C.green('INF')} no leaks found`);
  const rp = o['--report-path'] || o['-r'];
  if (rp) c.host.writeFile(c.resolve(rp), JSON.stringify(findings.map(f => ({ RuleID: f.rule.id, Description: f.rule.desc, StartLine: f.line, Match: redact ? 'REDACTED' : f.match, Secret: redact ? 'REDACTED' : f.secret, File: f.file, Commit: f.commit || '', Author: f.author?.name || '', Email: f.author?.email || '', Date: f.author ? new Date(f.author.time * 1000).toISOString() : '', Message: f.message || '', Entropy: f.entropy, Fingerprint: leakFingerprint(f) })), null, 1) + '\n', c.user);
  c.uni.emit({ type: 'gitleaks', host: c.host.name, mode, dir: src, findings: findings.map(f => ({ rule: f.rule.id, file: f.file, line: f.line, commit: f.commit || null, secret: f.secret })) });
  return findings.length ? Number(o['--exit-code'] ?? 1) : 0;
}, { pkg: 'gitleaks' });

// ================================================================ semgrep

const SQL = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
const JS = /\.(m?js|cjs|ts|jsx|tsx)$/, PY = /\.py$/;
const SEMGREP_RULES = [
  { id: 'javascript.express.security.injection.tainted-sql-string.tainted-sql-string', sev: 'ERROR', files: JS, url: 'https://sg.run/66ZL',
    msg: 'Detected user input used to manually construct a SQL string. This is usually bad practice because manual construction could accidentally result in a SQL injection. An attacker could use a SQL injection to steal or modify contents of the database. Instead, use a parameterized query which is available by default in most database engines.',
    test: (l, ctx) => SQL.test(l) && (/(['"`])\s*\+\s*req\.(query|params|body)/.test(l) || /\$\{\s*req\.(query|params|body)/.test(l) || ctx.tainted.some(v => new RegExp(`(['"\`])\\s*\\+\\s*${v}\\b|\\$\\{\\s*${v}\\s*\\}`).test(l))) },
  { id: 'javascript.lang.security.detect-child-process.detect-child-process', sev: 'ERROR', files: JS, url: 'https://sg.run/l2lo',
    msg: 'Detected calls to child_process from a function argument. This could lead to a command injection if the input is user controllable. Try to avoid calls to child_process, and if it is needed ensure user input is correctly sanitized or sandboxed.',
    test: (l, ctx) => /\b(exec|execSync)\s*\(/.test(l) && (/req\.(query|params|body)/.test(l) || ctx.tainted.some(v => new RegExp(`\\$\\{\\s*${v}\\s*\\}|\\+\\s*${v}\\b`).test(l))) },
  { id: 'javascript.browser.security.eval-detected.eval-detected', sev: 'WARNING', files: JS, url: 'https://sg.run/7ope',
    msg: 'Detected the use of eval(). eval() can be dangerous if used to evaluate dynamic content. If this content can be input from outside the program, this may be a code injection vulnerability. Ensure evaluated content is not definable by external sources.',
    test: l => /(^|[^\w.])eval\s*\(/.test(l) },
  { id: 'javascript.jsonwebtoken.security.jwt-hardcode.hardcoded-jwt-secret', sev: 'WARNING', files: JS, url: 'https://sg.run/4xN9',
    msg: 'A hard-coded credential was detected. It is not recommended to store credentials in source-code, as this risks secrets being leaked and used by either an internal or external malicious adversary. It is recommended to use environment variables to securely provide credentials or retrieve credentials from a secure vault or HSM (Hardware Security Module).',
    test: l => /jwt\.(sign|verify)\s*\([^,]+,\s*['"`][^'"`]+['"`]/.test(l) },
  { id: 'javascript.lang.security.audit.md5-used-as-password.md5-used-as-password', sev: 'WARNING', files: JS, url: 'https://sg.run/dKqd',
    msg: 'It looks like MD5 is used as a password hash. MD5 is not considered a secure password hash because it can be cracked by an attacker in a short amount of time. Use a suitable password hashing function such as bcrypt. You can use the `bcrypt` node.js package.',
    test: l => /createHash\(\s*['"]md5['"]\s*\)/.test(l) },
  { id: 'problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification', sev: 'WARNING', files: JS, url: 'https://sg.run/9oxr',
    msg: 'Checks for setting the environment variable NODE_TLS_REJECT_UNAUTHORIZED to 0 or rejectUnauthorized: false, which disables TLS verification. This should only be used for debugging purposes.',
    test: l => /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/.test(l) },
  { id: 'python.lang.security.audit.formatted-sql-query.formatted-sql-query', sev: 'WARNING', files: PY, url: 'https://sg.run/EkWw',
    msg: 'Detected possible formatted SQL query. Use parameterized queries instead.',
    test: l => /\.execute\(\s*(f["']|["'][^"']*["']\s*(%|\+|\.format))/.test(l) },
  { id: 'python.lang.security.audit.subprocess-shell-true.subprocess-shell-true', sev: 'ERROR', files: PY, url: 'https://sg.run/J92w',
    msg: "Found 'subprocess' function with 'shell=True'. This is dangerous because this call will spawn the command using a shell process. Doing so propagates current shell settings and variables, which makes it much easier for a malicious actor to execute commands. Use 'shell=False' instead.",
    test: l => /subprocess\.\w+\(.*shell\s*=\s*True/.test(l) },
];
const SEMGREP_PACKS = { auto: null, 'p/default': null, 'p/javascript': JS, 'p/nodejs': JS, 'p/express': JS, 'p/owasp-top-ten': null, 'p/security-audit': null, 'p/python': PY, 'p/ci': null };

function loadCustomRules(text, file) {
  let doc;
  try { doc = parseYaml(text); } catch (e) { throw new Error(`invalid configuration file found (1 configs were invalid)\n  ${file}: ${e.message}`); }
  if (!Array.isArray(doc?.rules)) throw new Error(`invalid configuration file found (1 configs were invalid)\n  ${file}: missing keys rules`);
  return doc.rules.map((r, i) => {
    for (const k of ['id', 'message', 'severity', 'languages']) if (r[k] === undefined) throw new Error(`invalid configuration file found (1 configs were invalid)\n  ${file}: rule ${r.id || i + 1} is missing required key '${k}'`);
    const pat = r['pattern-regex'];
    if (!pat) throw new Error(`invalid configuration file found (1 configs were invalid)\n  ${file}: rule ${r.id}: this simulator supports rules written with pattern-regex (and optional pattern-not-regex)`);
    let re, not = null;
    try { re = new RegExp(pat); not = r['pattern-not-regex'] ? new RegExp(r['pattern-not-regex']) : null; } catch (e) { throw new Error(`${file}: rule ${r.id}: invalid regex: ${e.message}`); }
    const langs = [].concat(r.languages).map(String);
    const files = langs.includes('generic') || langs.includes('regex') ? /.*/ : langs.some(x => /^(js|javascript|ts|typescript)$/.test(x)) ? JS : langs.includes('python') ? PY : langs.includes('yaml') ? /\.ya?ml$/ : langs.includes('dockerfile') ? /(^|\/)Dockerfile[^/]*$/ : /.*/;
    return { id: String(r.id), sev: String(r.severity).toUpperCase(), files, msg: String(r.message).trim(), test: l => re.test(l) && !(not && not.test(l)), custom: true };
  });
}

def('semgrep', c => {
  let args = [...c.args];
  if (args[0] === 'scan' || args[0] === 'ci') args = args.slice(1);
  if (args[0] === '--version') { c.print('1.95.0'); return 0; }
  const o = opts(args, { bool: ['--error', '--json', '-q', '--quiet', '--metrics=off'], val: ['--config', '-c', '--severity', '--exclude', '--output', '-o'] });
  const configs = [];
  args.forEach((a, i) => { if ((a === '--config' || a === '-c') && args[i + 1]) configs.push(args[i + 1]); else if (a.startsWith('--config=')) configs.push(a.slice(9)); });
  if (!configs.length && c.args[0] === 'ci') configs.push('p/ci');
  if (!configs.length) return c.fail('semgrep: error: no configuration given: use --config auto (registry rules) or --config <rules.yml>', 2);
  let rules = [];
  try {
    for (const cfg of configs) {
      if (cfg in SEMGREP_PACKS) { const only = SEMGREP_PACKS[cfg]; rules.push(...SEMGREP_RULES.filter(r => !only || r.files === only)); continue; }
      const p = c.resolve(cfg);
      const text = c.host.files.get(p);
      if (text === undefined) return c.fail(`[ERROR] Invalid configuration file found (1 configs were invalid)\n  ${cfg}: No such file or directory`, 7);
      rules.push(...loadCustomRules(text, cfg));
    }
  } catch (e) { return c.fail(`[ERROR] ${e.message}`, 7); }
  rules = [...new Map(rules.map(r => [r.id, r])).values()];
  const sevFilter = o['--severity'] ? new Set([].concat(o['--severity']).map(s => s.toUpperCase())) : null;
  const targets = o._.length ? o._ : ['.'];
  const files = [];
  for (const t of targets) { const p = c.resolve(t); const st = c.host.stat(p); if (!st) return c.fail(`[ERROR] Invalid scanning root: ${t}`, 2); files.push(...(st.type === 'file' ? [p] : walk(c.host, p))); }
  const root = c.resolve(targets[0]);
  const ignore = (c.host.files.get(normPath(c.cwd + '/.semgrepignore')) || '').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  const shown = p => p.startsWith(c.cwd + '/') ? p.slice(c.cwd.length + 1) : p;
  const scanned = files.filter(p => !ignore.some(g => shown(p).startsWith(g.replace(/^\//, '').replace(/\/$/, '')) || basename(p) === g) && rules.some(r => r.files.test(p)));
  const findings = [];
  for (const p of scanned) {
    const text = c.host.files.get(p) || '';
    const lines = text.split('\n');
    // taint: variables assigned from request input, or from other tainted variables (String(),
    // .trim() or a hand-written .replace() does not make input safe)
    const assigns = [...text.matchAll(/(?:const|let|var)\s+(?:\{\s*([\w\s,]+)\s*\}|(\w+))\s*=\s*([^;\n]*)/g)].map(m => ({ names: m[1] ? m[1].split(',').map(s => s.trim().split(/\s*:\s*/).pop()).filter(Boolean) : [m[2]], rhs: m[3] }));
    const tainted = [];
    const fromInput = rhs => /req\.(query|params|body)\b/.test(rhs) || tainted.some(v => new RegExp(`\\b${v}\\b`).test(rhs));
    for (let pass = 0; pass < 3; pass++) for (const a of assigns) if (fromInput(a.rhs)) for (const n of a.names) if (!tainted.includes(n)) tainted.push(n);
    lines.forEach((l, i) => {
      if (/nosemgrep/.test(l) || /nosemgrep/.test(lines[i - 1] || '')) return;
      for (const r of rules) if (r.files.test(p) && (!sevFilter || sevFilter.has(r.sev)) && r.test(l, { tainted })) findings.push({ rule: r, file: shown(p), line: i + 1, code: l.trim() });
    });
  }
  if (o['--json']) {
    c.print(JSON.stringify({ results: findings.map(f => ({ check_id: f.rule.id, path: f.file, start: { line: f.line }, extra: { message: f.rule.msg, severity: f.rule.sev, lines: f.code } })), errors: [], paths: { scanned: scanned.map(shown) } }));
  } else {
    if (!o['-q'] && !o['--quiet']) c.eprint('', '┌──── ○○○ ────┐', '│ Semgrep CLI │', '└─────────────┘', '', `Scanning ${scanned.length} file${scanned.length === 1 ? '' : 's'} (only git-tracked) with ${rules.length} Code rules:`, '');
    if (findings.length) {
      const box = `${findings.length} Code Finding${findings.length === 1 ? '' : 's'}`;
      c.print('', `┌${'─'.repeat(box.length + 2)}┐`, `│ ${box} │`, `└${'─'.repeat(box.length + 2)}┘`);
      let lastFile = null;
      for (const f of findings) {
        if (f.file !== lastFile) { c.print('', `    ${C.bold ? C.bold(f.file) : f.file}`); lastFile = f.file; }
        const mark = f.rule.sev === 'ERROR' ? C.red('❯❯❱') : f.rule.sev === 'WARNING' ? C.yellow(' ❯❱') : '  ❱';
        c.print(`   ${mark} ${f.rule.id}`);
        const words = f.rule.msg.split(' ');
        let line = '          ';
        for (const w of words) { if (line.length + w.length > 90) { c.print(line); line = '          '; } line += w + ' '; }
        c.print(line.trimEnd());
        if (f.rule.url) c.print(`          Details: ${f.rule.url}`);
        c.print('', `          ${String(f.line).padStart(3)}┆ ${f.code}`);
      }
    }
    if (!o['-q'] && !o['--quiet']) c.eprint('', '┌──────────────┐', '│ Scan Summary │', '└──────────────┘', '', `Ran ${rules.length} rules on ${scanned.length} file${scanned.length === 1 ? '' : 's'}: ${findings.length} finding${findings.length === 1 ? '' : 's'}.`);
  }
  c.uni.emit({ type: 'semgrep', host: c.host.name, dir: root, configs, custom: rules.filter(r => r.custom).map(r => r.id), findings: findings.map(f => ({ rule: f.rule.id, file: f.file, line: f.line, sev: f.rule.sev })) });
  return findings.length && (o['--error'] || c.args[0] === 'ci') ? 1 : 0;
}, { pkg: 'semgrep' });

// ================================================================ misconfiguration checks (trivy config)

const MISCONF = {
  'AVD-DS-0001': ['MEDIUM', "':latest' tag used", "When using a 'FROM' statement you should use a specific tag to avoid uncontrolled behavior when the image is updated."],
  'AVD-DS-0002': ['HIGH', "Image user should not be 'root'", "Running containers with 'root' user can lead to a container escape situation. It is a best practice to run containers as non-root users, which can be done by adding a 'USER' statement to the Dockerfile."],
  'AVD-DS-0005': ['LOW', "ADD instead of COPY", "You should use COPY instead of ADD unless you want to extract a tar file. Note that an ADD command will extract a tar file, which adds the risk of Zip-based vulnerabilities."],
  'AVD-DS-0026': ['LOW', 'No HEALTHCHECK defined', 'You should add HEALTHCHECK instruction in your docker container images to perform the health check on running containers.'],
  'AVD-DS-0031': ['CRITICAL', 'Secrets passed via build-args or envs or copied secret files', 'Passing secrets via `build-args` or envs or copying secret files can leak them out: they end up in the image layers and history.'],
  'AVD-KSV-0001': ['MEDIUM', 'Can elevate its own privileges', "A program inside the container can elevate its own privileges and run as root, which might give the program control over the container and node. Set 'securityContext.allowPrivilegeEscalation' to false."],
  'AVD-KSV-0003': ['LOW', 'Default capabilities not dropped', "The container should drop all default capabilities and add only those that are needed for its execution. Add 'ALL' to containers[].securityContext.capabilities.drop."],
  'AVD-KSV-0011': ['LOW', 'CPU not limited', "Enforcing CPU limits prevents DoS via resource exhaustion. Set a limit value under 'containers[].resources.limits.cpu'."],
  'AVD-KSV-0012': ['MEDIUM', 'Runs as root user', "Force the running image to run as a non-root user to ensure least privileges. Set 'containers[].securityContext.runAsNonRoot' to true."],
  'AVD-KSV-0013': ['MEDIUM', "Image tag ':latest' used", "It is best to avoid using the ':latest' image tag when deploying containers in production. Use a specific tag or a digest."],
  'AVD-KSV-0014': ['HIGH', 'Root file system is not read-only', "An immutable root file system prevents applications from writing to their local disk. Set 'containers[].securityContext.readOnlyRootFilesystem' to true."],
  'AVD-KSV-0017': ['HIGH', 'Privileged container', "Privileged containers share namespaces with the host system and do not offer any security. Change 'containers[].securityContext.privileged' to false."],
  'AVD-KSV-0018': ['LOW', 'Memory not limited', "Enforcing memory limits prevents DoS via resource exhaustion. Set a limit value under 'containers[].resources.limits.memory'."],
  'AVD-KSV-0023': ['MEDIUM', 'hostPath volumes mounted', "According to pod security standard 'HostPath Volumes', HostPath volumes must be forbidden. Do not set 'spec.volumes[*].hostPath'."],
  'AVD-KSV-0104': ['MEDIUM', 'Seccomp policies disabled', "A program inside the container can bypass Seccomp protection policies. Set 'securityContext.seccompProfile.type' to RuntimeDefault."],
  'AVD-AWS-0028': ['HIGH', 'aws_instance should activate session tokens for Instance Metadata Service.', 'IMDS v2 (Instance Metadata Service) introduced session authentication tokens which improve security when talking to IMDS. Set metadata_options { http_tokens = "required" }.'],
  'AVD-AWS-0088': ['HIGH', 'Unencrypted S3 bucket.', 'S3 Buckets should be encrypted to protect the data that is stored within them. Add an aws_s3_bucket_server_side_encryption_configuration for the bucket.'],
  'AVD-AWS-0090': ['MEDIUM', 'S3 Data should be versioned', 'Versioning in Amazon S3 is a means of keeping multiple variants of an object in the same bucket, so you can recover from unintended user actions and application failures. Add an aws_s3_bucket_versioning resource.'],
  'AVD-AWS-0094': ['LOW', 'S3 buckets should each define an aws_s3_bucket_public_access_block', 'The "block public access" settings in S3 override individual policies that apply to a given bucket, meaning that all public access can be controlled in one central location.'],
  'AVD-AWS-0107': ['CRITICAL', 'An ingress security group rule allows traffic from /0.', 'Opening up ports to the public internet is generally to be avoided. You should restrict access to IP addresses or ranges that explicitly require it where possible.'],
  'AVD-AWS-0131': ['HIGH', 'Instance with unencrypted block device.', 'Block devices should be encrypted to ensure sensitive data is held securely at rest. Set root_block_device { encrypted = true }.'],
};
const avdUrl = id => `https://avd.aquasec.com/misconfig/${id.replace(/^AVD-/, '').replace(/-0*(\d+)$/, (m, n) => String(n).padStart(4, '0')).toLowerCase().replace('-', '')}`;

// an inline `#trivy:ignore:ID` comment in the lines directly above (or on) a line suppresses ID there
function inlineIgnored(lines, lineNo, id) {
  for (let i = lineNo - 1; i >= 0 && i >= lineNo - 4; i--) {
    const l = lines[i] ?? '';
    if (new RegExp(`trivy:ignore:${id}\\b`).test(l)) return true;
    if (i < lineNo - 1 && !/^\s*(#|\/\/)/.test(l)) break;
  }
  return false;
}

function checkDockerfile(text) {
  const out = [];
  const lines = text.split('\n');
  const stages = new Set();
  let lastUser = null, healthcheck = false;
  lines.forEach((raw, i) => {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i))) {
      const img = m[1];
      if (m[2]) stages.add(m[2].toLowerCase());
      if (img !== 'scratch' && !stages.has(img.toLowerCase()) && !img.includes('@') && (/:latest$/.test(img) || !/:[^/]+$/.test(img))) out.push({ id: 'AVD-DS-0001', line: i + 1, detail: `Specify a tag in the 'FROM' statement for image '${img.split(':')[0]}'` });
      lastUser = null;
    }
    if ((m = l.match(/^USER\s+(\S+)/i))) lastUser = m[1];
    if (/^HEALTHCHECK\s/i.test(l)) healthcheck = true;
    if (/^ADD\s/i.test(l) && !/https?:\/\/|\.tar(\.gz)?\b|\.tgz\b/.test(l)) out.push({ id: 'AVD-DS-0005', line: i + 1, detail: `Consider using 'COPY ${l.replace(/^ADD\s+/i, '')}' command instead of '${l}'` });
    if ((m = l.match(/^(ENV|ARG)\s+(\w+)(?:\s*=\s*|\s+)(\S+)/i)) && /(PASS(WORD)?|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY)/i.test(m[2]) && !/^\$/.test(m[3])) out.push({ id: 'AVD-DS-0031', line: i + 1, detail: `Possible exposure of secret env "${m[2]}" in ${m[1].toUpperCase()}` });
    if (/^COPY\s.*(\.env|id_rsa|\.pem|credentials)\b/i.test(l) && !/\.env\.example/.test(l)) out.push({ id: 'AVD-DS-0031', line: i + 1, detail: 'Possible exposure of a secret file copied into the image' });
  });
  if (!lastUser || /^(root|0)(:|$)/.test(lastUser)) out.push({ id: 'AVD-DS-0002', line: 1, detail: lastUser ? `Last USER command in Dockerfile should not be '${lastUser}'` : "Specify at least 1 USER command in Dockerfile with non-root user as argument" });
  if (!healthcheck) out.push({ id: 'AVD-DS-0026', line: 1, detail: 'Add HEALTHCHECK instruction in your Dockerfile' });
  return { type: 'dockerfile', tests: 27, findings: out.filter(f => !inlineIgnored(lines, f.line, f.id)) };
}

function lineOfKey(lines, key, from = 0) { for (let i = from; i < lines.length; i++) if (new RegExp(`^\\s*-?\\s*${key}:`).test(lines[i])) return i + 1; return from + 1; }

function checkK8s(text) {
  const out = [];
  const docs = text.split(/^---\s*$/m);
  let offset = 0;
  for (const d of docs) {
    let o;
    try { o = parseYaml(d); } catch { offset += d.split('\n').length; continue; }
    const lines = d.split('\n');
    const kind = o?.kind;
    const podSpec = kind === 'Pod' ? o.spec : ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(kind) ? o.spec?.template?.spec : kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec : null;
    if (!podSpec) { offset += lines.length; continue; }
    const psc = podSpec.securityContext || {};
    for (const ct of [...(podSpec.initContainers || []), ...(podSpec.containers || [])]) {
      const sc = ct.securityContext || {};
      const at = lineOfKey(lines, 'name', lines.findIndex(l => new RegExp(`name:\\s*['"]?${ct.name}['"]?\\s*$`).test(l)) >= 0 ? lines.findIndex(l => new RegExp(`name:\\s*['"]?${ct.name}['"]?\\s*$`).test(l)) : 0) + offset;
      const where = `Container '${ct.name}' of ${kind} '${o.metadata?.name}'`;
      if (sc.allowPrivilegeEscalation !== false) out.push({ id: 'AVD-KSV-0001', line: at, detail: `${where} should set 'securityContext.allowPrivilegeEscalation' to false` });
      if (!(sc.capabilities?.drop || []).map(x => String(x).toUpperCase()).includes('ALL')) out.push({ id: 'AVD-KSV-0003', line: at, detail: `${where} should add 'ALL' to 'securityContext.capabilities.drop'` });
      if (!ct.resources?.limits?.cpu) out.push({ id: 'AVD-KSV-0011', line: at, detail: `${where} should set 'resources.limits.cpu'` });
      if (sc.runAsNonRoot !== true && psc.runAsNonRoot !== true) out.push({ id: 'AVD-KSV-0012', line: at, detail: `${where} should set 'securityContext.runAsNonRoot' to true` });
      if (/:latest$/.test(ct.image || '') || (ct.image && !/[:@]/.test(String(ct.image).split('/').pop()))) out.push({ id: 'AVD-KSV-0013', line: at, detail: `${where} should specify an image tag` });
      if (sc.readOnlyRootFilesystem !== true) out.push({ id: 'AVD-KSV-0014', line: at, detail: `${where} should set 'securityContext.readOnlyRootFilesystem' to true` });
      if (sc.privileged === true) out.push({ id: 'AVD-KSV-0017', line: at, detail: `${where} should set 'securityContext.privileged' to false` });
      if (!ct.resources?.limits?.memory) out.push({ id: 'AVD-KSV-0018', line: at, detail: `${where} should set 'resources.limits.memory'` });
      const seccomp = sc.seccompProfile?.type || psc.seccompProfile?.type;
      if (!['RuntimeDefault', 'Localhost'].includes(seccomp)) out.push({ id: 'AVD-KSV-0104', line: at, detail: `${where} should specify a seccomp profile` });
    }
    if ((podSpec.volumes || []).some(v => v.hostPath)) out.push({ id: 'AVD-KSV-0023', line: offset + lineOfKey(lines, 'hostPath'), detail: `${kind} '${o.metadata?.name}' should not set 'spec.template.volumes.hostPath'` });
    const all = text.split('\n');
    out.push(...out.splice(0).filter(f => !inlineIgnored(all, f.line, f.id)));
    offset += lines.length + 1;
  }
  return { type: 'kubernetes', tests: 99, findings: out };
}

// resource blocks of a .tf file: [{type, name, line, body, lines}] (brace matching, comments kept)
function tfBlocks(text) {
  const out = [];
  const re = /^\s*resource\s+"([\w-]+)"\s+"([\w-]+)"\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) break; }
    out.push({ type: m[1], name: m[2], line: text.slice(0, m.index).split('\n').length + (text[m.index] === '\n' ? 1 : 0), body: text.slice(m.index, i + 1) });
  }
  return out;
}
function nestedBlocks(body, name) {
  const out = [];
  const re = new RegExp(`^\\s*${name}\\s*\\{`, 'gm');
  let m;
  while ((m = re.exec(body))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < body.length; i++) { if (body[i] === '{') depth++; else if (body[i] === '}' && --depth === 0) break; }
    out.push({ at: body.slice(0, m.index).split('\n').length + (body[m.index] === '\n' ? 1 : 0), text: body.slice(m.index, i + 1) });
  }
  return out;
}

function checkTerraform(text) {
  const out = [];
  const lines = text.split('\n');
  const blocks = tfBlocks(text);
  const refs = type => blocks.filter(b => b.type === type).map(b => b.body);
  for (const b of blocks) {
    const at = n => b.line + n - 1;
    const add = (id, line, detail) => { if (!inlineIgnored(lines, line, id) && !inlineIgnored(lines, b.line, id)) out.push({ id, line, detail }); };
    if (b.type === 'aws_security_group') {
      for (const ing of nestedBlocks(b.body, 'ingress')) if (/0\.0\.0\.0\/0|::\/0/.test(ing.text)) {
        const port = ing.text.match(/from_port\s*=\s*(\d+)/)?.[1];
        add('AVD-AWS-0107', at(ing.at), `Security group rule allows ingress from public internet${port ? ` (port ${port})` : ''}`);
      }
    }
    if (['aws_security_group_rule', 'aws_vpc_security_group_ingress_rule'].includes(b.type) && /0\.0\.0\.0\/0|::\/0/.test(b.body) && !/type\s*=\s*"egress"/.test(b.body)) add('AVD-AWS-0107', b.line, 'Security group rule allows ingress from public internet');
    if (b.type === 'aws_instance') {
      if (!/metadata_options\s*\{[^}]*http_tokens\s*=\s*"required"/.test(b.body)) add('AVD-AWS-0028', b.line, 'Instance does not require IMDS access to require a token');
      if (!/root_block_device\s*\{[^}]*encrypted\s*=\s*true/.test(b.body)) add('AVD-AWS-0131', b.line, 'Root block device is not encrypted.');
    }
    if (b.type === 'aws_s3_bucket') {
      const mine = body => new RegExp(`aws_s3_bucket\\.${b.name}\\.(id|bucket)`).test(body);
      if (!refs('aws_s3_bucket_server_side_encryption_configuration').some(mine)) add('AVD-AWS-0088', b.line, 'Bucket does not have encryption enabled');
      if (!refs('aws_s3_bucket_versioning').some(body => mine(body) && /status\s*=\s*"Enabled"/.test(body))) add('AVD-AWS-0090', b.line, 'Bucket does not have versioning enabled');
      if (!refs('aws_s3_bucket_public_access_block').some(mine)) add('AVD-AWS-0094', b.line, 'Bucket does not have a corresponding public access block.');
    }
  }
  return { type: 'terraform', tests: 61, findings: out };
}

function configTargets(host, path) {
  const st = host.stat(path);
  if (!st) return [];
  const files = st.type === 'file' ? [path] : walk(host, path);
  const out = [];
  for (const p of files) {
    const text = host.files.get(p) || '';
    if (/(^|\/)(Dockerfile|Containerfile)[^/]*$/.test(p) && !/\.dockerignore$/.test(p)) out.push({ p, r: checkDockerfile(text) });
    else if (/\.tf$/.test(p)) out.push({ p, r: checkTerraform(text) });
    else if (/\.ya?ml$/.test(p) && /^\s*kind:\s*\w+/m.test(text) && /^\s*apiVersion:/m.test(text)) out.push({ p, r: checkK8s(text) });
  }
  return out;
}

// ================================================================ trivy

const OS_LABEL = { debian: 'debian 12.7', alpine: 'alpine 3.20.3', ubuntu: 'ubuntu 24.04' };
const OS_PKG_VERSION = { openssl: ['3.0.11-1~deb12u2', '3.0.15-1~deb12u1'], libexpat1: ['2.5.0-1', '2.5.0-1+deb12u1'], glibc: ['2.36-9+deb12u4', '2.36-9+deb12u9'], zlib1g: ['1:1.2.13.dfsg-1', '1:1.2.13.dfsg-1+deb12u1'], krb5: ['1.20.1-2+deb12u1', '1.20.1-2+deb12u2'], expat: ['2.5.0-1', '2.5.0-1+deb12u1'], nghttp2: ['1.52.0-1', '1.52.0-1+deb12u2'], ncurses: ['6.4-4', '6.4-4+deb12u1'], 'gcc-12': ['12.2.0-14', ''] };

// synthetic OS findings for an image, deterministic from its counts (language packages such
// as an old lodash are reported separately, under Node.js)
function osVulns(img) {
  const [cr, hi, me, lo] = vulnsOf({ ...img, files: {} });
  const rows = [];
  const want = { CRITICAL: cr, HIGH: hi, MEDIUM: me, LOW: lo };
  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    const pool = CVES.filter(x => x[2].toUpperCase() === sev);
    const base = pool.length ? pool : CVES;
    for (let i = 0; i < want[sev]; i++) {
      const [id, pkg] = base[i % base.length];
      const year = 2023 + (i % 2), num = 10000 + ((i * 7919 + id.length * 31) % 50000);
      const cve = i < base.length ? id : `CVE-${year}-${num}`;
      const [installed, fixed] = OS_PKG_VERSION[pkg] || ['1.0-1', '1.0-2'];
      rows.push({ id: cve, pkg, sev, installed, fixed: (i % 3 === 2 || !fixed) ? '' : fixed, title: `${pkg}: ${sev === 'CRITICAL' ? 'remote code execution' : sev === 'HIGH' ? 'denial of service' : 'information disclosure'} (${cve})` });
    }
  }
  return rows;
}
function npmVulns(deps) {
  return auditDeps(deps).map(v => ({ id: v.url.split('/').pop(), pkg: v.name, sev: v.severity === 'moderate' ? 'MEDIUM' : v.severity.toUpperCase(), installed: String(deps[v.name]).replace(/^[\^~]/, ''), fixed: v.fixed, title: v.title }));
}
function imageNodeDeps(img) {
  const deps = {};
  for (const [p, f] of Object.entries(img.files || {})) { const m = p.match(/\/node_modules\/([^/]+)\/package\.json$/); if (m) { try { deps[m[1]] = JSON.parse(f.content ?? f).version; } catch { /* ignore */ } } }
  return deps;
}
function lockDeps(host, dir) {
  const lock = host.files.get(dir + '/package-lock.json');
  const pkg = host.files.get(dir + '/package.json');
  try {
    if (lock) { const j = JSON.parse(lock); const out = {}; for (const [k, v] of Object.entries(j.packages || {})) if (k.startsWith('node_modules/')) out[k.slice(13)] = v.version; if (Object.keys(out).length) return { file: 'package-lock.json', deps: out }; }
    if (pkg) { const j = JSON.parse(pkg); return { file: 'package.json', deps: { ...(j.dependencies || {}), ...(j.devDependencies || {}) } }; }
  } catch { /* ignore */ }
  return null;
}

function findImage(c, ref) {
  const eng = c.host.docker || (c.host.packages.has('docker.io') ? engineOf(c.host, c.uni) : null);
  const local = eng?.findImage(ref);
  if (local) return { img: local, digest: null };
  const r = c.uni.registry?.get(parseRef(ref).short);
  return r ? { img: r.image, digest: r.digest } : null;
}

function trivyIgnores(c, o) {
  const p = c.resolve(o['--ignorefile'] || '.trivyignore');
  return new Set((c.host.files.get(p) || '').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean));
}

function printVulnTable(c, title, rows, showAll) {
  const counts = Object.fromEntries(SEVS.map(s => [s, rows.filter(r => r.sev === s).length]));
  c.print('', title, '='.repeat(title.length), `Total: ${rows.length} (${SEVS.map(s => `${s}: ${counts[s]}`).join(', ')})`, '');
  if (!rows.length) return;
  const show = showAll ? rows : rows.slice(0, 14);
  const w = [Math.max(7, ...show.map(r => r.pkg.length)), Math.max(13, ...show.map(r => r.id.length)), 8, Math.max(17, ...show.map(r => r.installed.length)), Math.max(13, ...show.map(r => r.fixed.length))];
  const line = (ch) => '├' + w.map(n => ch.repeat(n + 2)).join('┼') + '┤';
  c.print('┌' + w.map(n => '─'.repeat(n + 2)).join('┬') + '┐');
  c.print('│ ' + ['Library', 'Vulnerability', 'Severity', 'Installed Version', 'Fixed Version'].map((h, i) => pad(h, w[i])).join(' │ ') + ' │');
  for (const r of show) { c.print(line('─')); c.print('│ ' + [pad(r.pkg, w[0]), pad(r.id, w[1]), sevColor(r.sev) + ' '.repeat(Math.max(0, w[2] - r.sev.length)), pad(r.installed, w[3]), pad(r.fixed, w[4])].join(' │ ') + ' │'); }
  c.print('└' + w.map(n => '─'.repeat(n + 2)).join('┴') + '┘');
  if (show.length < rows.length) c.print(C.dim ? C.dim(`  … ${rows.length - show.length} more (use --severity HIGH,CRITICAL to focus, or --format json for everything)`) : `  … ${rows.length - show.length} more`);
}

function printSecrets(c, target, found) {
  const t = `${target} (secrets)`;
  c.print('', t, '='.repeat(t.length), `Total: ${found.length} (${SEVS.map(s => `${s}: ${found.filter(f => f.rule.sev === s).length}`).join(', ')})`, '');
  for (const f of found) c.print(`${sevColor(f.rule.sev)}: ${f.rule.title} (${f.rule.id})`, '════════════════════════════════════════', `${f.rule.desc}`, '────────────────────────────────────────', ` ${target}:${f.line}`, '────────────────────────────────────────', `  ${f.line} [ ${f.match.replace(f.secret, '*'.repeat(Math.min(20, f.secret.length)))}`, '────────────────────────────────────────', '');
}

function printMisconf(c, file, r, sevSet) {
  const fails = r.findings.filter(f => sevSet.has(MISCONF[f.id][0]));
  const t = `${file} (${r.type})`;
  c.print('', t, '='.repeat(t.length), `Tests: ${r.tests} (SUCCESSES: ${r.tests - fails.length}, FAILURES: ${fails.length})`, `Failures: ${fails.length} (${SEVS.map(s => `${s}: ${fails.filter(f => MISCONF[f.id][0] === s).length}`).join(', ')})`, '');
  for (const f of fails) {
    const [sev, title, desc] = MISCONF[f.id];
    c.print(`${f.id} (${sevColor(sev)}): ${f.detail}`, '════════════════════════════════════════', desc, '', `See ${avdUrl(f.id)}`, '────────────────────────────────────────', ` ${file}:${f.line}`, '────────────────────────────────────────', '');
  }
  return fails;
}

def('trivy', c => {
  const [sub, ...rest] = c.args;
  if (!sub || sub === '--help' || sub === '-h') { c.print('Scanner for vulnerabilities in container images, file systems, and Git repositories, as well as for configuration issues and hard-coded secrets', '', 'Usage:', '  trivy [command]', '', 'Scanning Commands', '  config      Scan for misconfigurations (Dockerfile, Kubernetes, Terraform)', '  filesystem  Scan local filesystem (alias: fs)', '  image       Scan a container image (alias: i)', '  sbom        Scan SBOM for vulnerabilities'); return 0; }
  if (sub === '--version' || sub === 'version') { c.print('Version: 0.56.2'); return 0; }
  const o = opts(rest, { bool: ['--ignore-unfixed', '-q', '--quiet', '--no-progress'], val: ['--severity', '-s', '--exit-code', '--scanners', '--format', '-f', '--ignorefile', '--output', '-o', '--skip-dirs'] });
  const sevSet = new Set(String(o['--severity'] || o['-s'] || SEVS.join(',')).toUpperCase().split(','));
  const ign = trivyIgnores(c, o);
  const target = o._[0];
  const t0 = new Date(c.uni.time * 1000).toISOString().replace('.000', '');
  const info = msg => { if (!o['-q'] && !o['--quiet']) c.eprint(`${t0}\t${C.cyan ? C.cyan('INFO') : 'INFO'}\t${msg}`); };
  const report = { vulns: [], secrets: [], misconf: [] };
  const keep = rows => rows.filter(r => sevSet.has(r.sev) && !ign.has(r.id) && !(o['--ignore-unfixed'] && !r.fixed));
  const json = (o['--format'] || o['-f']) === 'json';
  let mode = sub === 'i' ? 'image' : sub === 'filesystem' ? 'fs' : sub === 'rootfs' ? 'fs' : sub === 'conf' ? 'config' : sub;
  if (!['image', 'fs', 'config', 'sbom', 'repo'].includes(mode)) return c.fail(`Error: unknown command "${sub}" for "trivy"`, 1);
  if (!target) return c.fail(`${t0}\tFATAL\tFatal error\trun error: ${mode} scan error: target required`, 1);
  const scanners = new Set(String(o['--scanners'] || (mode === 'config' ? 'misconfig' : mode === 'image' ? 'vuln,secret' : 'vuln,secret')).split(','));
  if (mode === 'image') {
    const f = findImage(c, target);
    if (!f) return c.fail(`${t0}\tFATAL\tFatal error\trun error: image scan error: scan error: unable to initialize a scan service: unable to initialize an image scan service: unable to find the specified image "${target}" in ["docker" "containerd" "podman" "remote"]`, 1);
    info('Vulnerability scanning is enabled'); if (scanners.has('secret')) info('Secret scanning is enabled');
    info(`Detected OS\tfamily="${f.img.base?.os || 'debian'}" version="${(OS_LABEL[f.img.base?.os] || 'debian 12.7').split(' ')[1]}"`);
    info(`Number of language-specific files\tnum=${Object.keys(imageNodeDeps(f.img)).length ? 1 : 0}`);
    if (scanners.has('vuln')) {
      const os = keep(osVulns(f.img));
      report.vulns.push({ target: `${target} (${OS_LABEL[f.img.base?.os] || 'debian 12.7'})`, rows: os });
      const nd = imageNodeDeps(f.img);
      if (Object.keys(nd).length) report.vulns.push({ target: 'Node.js', rows: keep(npmVulns(nd)) });
    }
    if (scanners.has('secret')) {
      for (const [p, file] of Object.entries(f.img.files || {})) { if (SKIP_DIRS.test(p) || /^\/(usr|lib|bin|sbin|etc\/ssl)\//.test(p)) continue; const found = scanSecrets(file?.content ?? (typeof file === 'string' ? file : '')).filter(x => sevSet.has(x.rule.sev)); if (found.length) report.secrets.push({ target: p, found }); }
      const envText = Object.entries(f.img.config?.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
      const envFound = scanSecrets(envText).filter(x => sevSet.has(x.rule.sev));
      if (envFound.length) report.secrets.push({ target: '/ (image config: ENV)', found: envFound });
    }
  } else if (mode === 'fs' || mode === 'repo') {
    const dir = c.resolve(target);
    if (!c.host.stat(dir)) return c.fail(`${t0}\tFATAL\tFatal error\trun error: fs scan error: scan error: scan failed: failed analysis: lstat ${target}: no such file or directory`, 1);
    if (scanners.has('vuln')) {
      info('Vulnerability scanning is enabled');
      for (const p of walk(c.host, dir).filter(p => /(^|\/)package\.json$/.test(p))) {
        const d = dirname(p);
        const l = lockDeps(c.host, d);
        if (l) report.vulns.push({ target: rel(dir, d + '/' + l.file) || l.file, rows: keep(npmVulns(l.deps)) });
      }
    }
    if (scanners.has('secret')) { info('Secret scanning is enabled'); for (const p of walk(c.host, dir)) { const found = scanSecrets(c.host.files.get(p)).filter(x => sevSet.has(x.rule.sev)); if (found.length) report.secrets.push({ target: rel(dir, p), found }); } }
    if (scanners.has('misconfig')) { info('Misconfiguration scanning is enabled'); for (const { p, r } of configTargets(c.host, dir)) report.misconf.push({ target: rel(dir, p), r }); }
  } else if (mode === 'config') {
    const dir = c.resolve(target);
    if (!c.host.stat(dir)) return c.fail(`${t0}\tFATAL\tFatal error\trun error: config scan error: lstat ${target}: no such file or directory`, 1);
    info('Misconfiguration scanning is enabled');
    for (const { p, r } of configTargets(c.host, dir)) report.misconf.push({ target: c.host.stat(dir).type === 'file' ? basename(p) : rel(dir, p), r });
    info(`Detected config files\tnum=${report.misconf.length}`);
  } else if (mode === 'sbom') {
    const text = c.host.files.get(c.resolve(target));
    if (text === undefined) return c.fail(`${t0}\tFATAL\tFatal error\trun error: sbom scan error: open ${target}: no such file or directory`, 1);
    let doc; try { doc = JSON.parse(text); } catch { return c.fail(`${t0}\tFATAL\tFatal error\trun error: sbom scan error: failed to detect SBOM format`, 1); }
    const comps = doc.components || (doc.packages || []).map(p => ({ name: p.name, version: p.versionInfo, purl: p.externalRefs?.find(r => r.referenceType === 'purl')?.referenceLocator }));
    info(`Detected SBOM format\tformat="${doc.bomFormat ? 'cyclonedx-json' : 'spdx-json'}"`);
    const npm = {}, osRows = [];
    for (const k of comps) {
      if (/^pkg:npm\//.test(k.purl || '')) npm[k.name] = k.version;
      else if (/^pkg:(deb|apk)\//.test(k.purl || '')) { const pool = CVES.filter(x => x[1] === k.name); const fix = OS_PKG_VERSION[k.name]; if (pool.length && fix && k.version === fix[0]) for (const [id, pkg, s] of pool) osRows.push({ id, pkg, sev: s.toUpperCase(), installed: k.version, fixed: fix[1], title: `${pkg} (${id})` }); }
    }
    if (osRows.length) report.vulns.push({ target: `${target} (os packages)`, rows: keep(osRows) });
    report.vulns.push({ target: 'Node.js', rows: keep(npmVulns(npm)) });
  }
  const fails = [];
  if (json) {
    c.print(JSON.stringify({ SchemaVersion: 2, ArtifactName: target, Results: [...report.vulns.map(v => ({ Target: v.target, Class: 'lang-pkgs', Vulnerabilities: v.rows.map(r => ({ VulnerabilityID: r.id, PkgName: r.pkg, InstalledVersion: r.installed, FixedVersion: r.fixed, Severity: r.sev, Title: r.title })) })), ...report.secrets.map(s => ({ Target: s.target, Class: 'secret', Secrets: s.found.map(f => ({ RuleID: f.rule.id, Severity: f.rule.sev, Title: f.rule.title, StartLine: f.line })) })), ...report.misconf.map(m => ({ Target: m.target, Class: 'config', Misconfigurations: m.r.findings.filter(f => sevSet.has(MISCONF[f.id][0]) && !ign.has(f.id)).map(f => ({ ID: f.id, Title: MISCONF[f.id][1], Severity: MISCONF[f.id][0], Message: f.detail, StartLine: f.line })) }))] }, null, 2));
    for (const m of report.misconf) fails.push(...m.r.findings.filter(f => sevSet.has(MISCONF[f.id][0]) && !ign.has(f.id)));
  } else {
    for (const v of report.vulns) printVulnTable(c, v.target, v.rows, false);
    for (const s of report.secrets) printSecrets(c, s.target, s.found);
    for (const m of report.misconf) { m.r.findings = m.r.findings.filter(f => !ign.has(f.id)); fails.push(...printMisconf(c, m.target, m.r, sevSet)); }
  }
  const nV = report.vulns.reduce((s, v) => s + v.rows.length, 0), nS = report.secrets.reduce((s, x) => s + x.found.length, 0);
  const counts = Object.fromEntries(SEVS.map(s => [s, report.vulns.reduce((n, v) => n + v.rows.filter(r => r.sev === s).length, 0) + report.secrets.reduce((n, x) => n + x.found.filter(f => f.rule.sev === s).length, 0) + fails.filter(f => MISCONF[f.id][0] === s).length]));
  c.uni.emit({ type: 'trivy', host: c.host.name, mode, target, dir: mode === 'image' ? null : c.resolve(target), severity: [...sevSet], vulns: nV, secrets: nS, misconfigs: fails.map(f => f.id), counts, exitCode: o['--exit-code'] !== undefined ? Number(o['--exit-code']) : 0 });
  return (nV + nS + fails.length) && o['--exit-code'] !== undefined ? Number(o['--exit-code']) : 0;
}, { pkg: 'trivy' });

// ================================================================ syft (SBOMs)

const OS_BASE_PKGS = {
  debian: [['base-files', '12.4+deb12u7'], ['bash', '5.2.15-2+b7'], ['coreutils', '9.1-1'], ['libc6', '2.36-9+deb12u4'], ['libssl3', '3.0.11-1~deb12u2'], ['openssl', '3.0.11-1~deb12u2'], ['zlib1g', '1:1.2.13.dfsg-1'], ['libexpat1', '2.5.0-1'], ['ca-certificates', '20230311'], ['tzdata', '2024a-0+deb12u1']],
  alpine: [['alpine-baselayout', '3.6.5-r0'], ['busybox', '1.36.1-r29'], ['musl', '1.2.5-r0'], ['libssl3', '3.3.2-r0'], ['libcrypto3', '3.3.2-r0'], ['zlib', '1.3.1-r1'], ['ca-certificates-bundle', '20240705-r0']],
};
function sbomComponents(c, target) {
  const m = target.match(/^(dir|docker|registry|file):(.+)$/);
  const kind = m ? m[1] : null, ref = m ? m[2] : target;
  const p = c.resolve(ref);
  if ((kind === 'dir' || kind === 'file' || (!kind && c.host.stat(p))) && c.host.stat(p)) {
    const dir = c.host.stat(p).type === 'dir' ? p : dirname(p);
    const l = lockDeps(c.host, dir);
    return { name: basename(dir), type: 'directory', comps: Object.entries(l?.deps || {}).map(([n, v]) => ({ name: n, version: String(v).replace(/^[\^~]/, ''), type: 'npm', purl: `pkg:npm/${n}@${String(v).replace(/^[\^~]/, '')}` })) };
  }
  const f = findImage(c, ref);
  if (!f) return null;
  const os = f.img.base?.os || 'debian';
  const fam = os === 'alpine' ? 'apk' : 'deb';
  const base = (OS_BASE_PKGS[os] || OS_BASE_PKGS.debian).map(([n, v]) => ({ name: n, version: v, type: fam, purl: `pkg:${fam}/${os}/${n}@${v}` }));
  const [cr] = vulnsOf(f.img);
  if (fam === 'deb' && !cr) for (const b of base) { const fx = OS_PKG_VERSION[b.name]; if (fx?.[1]) { b.version = fx[1]; b.purl = `pkg:deb/${os}/${b.name}@${fx[1]}`; } }
  const added = (f.img.packages || []).map(x => Array.isArray(x) ? x[0] : x).filter(n => !base.some(b => b.name === n)).map(n => ({ name: n, version: '1.0', type: fam, purl: `pkg:${fam}/${os}/${n}@1.0` }));
  const npm = Object.entries(imageNodeDeps(f.img)).map(([n, v]) => ({ name: n, version: v, type: 'npm', purl: `pkg:npm/${n}@${v}` }));
  return { name: ref, type: 'container', digest: f.digest, comps: [...base, ...added, ...npm] };
}

def('syft', c => {
  let args = [...c.args];
  if (args[0] === 'scan' || args[0] === 'packages') args = args.slice(1);
  if (args[0] === 'version' || args[0] === '--version') { c.print('syft 1.16.0'); return 0; }
  const o = opts(args, { bool: ['-q', '--quiet'], val: ['-o', '--output', '--file'] });
  const target = o._[0];
  if (!target) return c.fail('an image/directory argument is required\n\nUsage:\n  syft [SOURCE] [flags]', 1);
  const sb = sbomComponents(c, target);
  if (!sb) return c.fail(`[0000] ERROR could not determine source: errors occurred attempting to resolve '${target}':\n  - docker: image not found\n  - registry: not found\n  - file: stat ${target}: no such file or directory`, 1);
  const spec = String(o['-o'] || o['--output'] || 'table');
  const [fmt, outFile0] = spec.split('=');
  const outFile = outFile0 || o['--file'];
  let text;
  if (fmt === 'cyclonedx-json') text = JSON.stringify({ $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json', bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { timestamp: new Date(c.uni.time * 1000).toISOString(), tools: { components: [{ type: 'application', author: 'anchore', name: 'syft', version: '1.16.0' }] }, component: { type: sb.type === 'container' ? 'container' : 'file', name: sb.name, version: sb.digest || undefined } }, components: sb.comps.map(k => ({ type: 'library', name: k.name, version: k.version, purl: k.purl })) }, null, 2);
  else if (fmt === 'spdx-json') text = JSON.stringify({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: sb.name, creationInfo: { created: new Date(c.uni.time * 1000).toISOString(), creators: ['Tool: syft-1.16.0'] }, packages: sb.comps.map((k, i) => ({ name: k.name, SPDXID: `SPDXRef-Package-${k.type}-${k.name}-${i}`, versionInfo: k.version, externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: k.purl }] })) }, null, 2);
  else if (fmt === 'json') text = JSON.stringify({ artifacts: sb.comps, source: { type: sb.type, target: sb.name } }, null, 2);
  else if (fmt === 'table') {
    const w = [Math.max(4, ...sb.comps.map(k => k.name.length)), Math.max(9, ...sb.comps.map(k => k.version.length))];
    text = [`${pad('NAME', w[0])}  ${pad('INSTALLED', w[1])}  TYPE`, ...sb.comps.map(k => `${pad(k.name, w[0])}  ${pad(k.version, w[1])}  ${k.type}`)].join('\n');
  } else return c.fail(`unsupported output format "${fmt}", supported formats are: [cyclonedx-json spdx-json json table]`, 1);
  if (!o['-q'] && !o['--quiet']) c.eprint(` ✔ ${sb.type === 'container' ? 'Loaded image' : 'Indexed file system'}   ${sb.name}`, ` ✔ Cataloged contents   ${C.dim ? C.dim(`${sb.comps.length} packages`) : sb.comps.length + ' packages'}`);
  if (outFile) c.host.writeFile(c.resolve(outFile), text + '\n', c.user); else c.print(...text.split('\n'));
  c.uni.emit({ type: 'syft', host: c.host.name, target, format: fmt, count: sb.comps.length, file: outFile ? c.resolve(outFile) : null });
  return 0;
}, { pkg: 'syft' });

// ================================================================ ZAP (DAST)

const ZAP_RULES = {
  10010: 'Cookie No HttpOnly Flag', 10011: 'Cookie Without Secure Flag', 10020: 'Missing Anti-clickjacking Header', 10021: 'X-Content-Type-Options Header Missing',
  10035: 'Strict-Transport-Security Header Not Set', 10036: 'Server Leaks Version Information via "Server" HTTP Response Header Field', 10037: 'Server Leaks Information via "X-Powered-By" HTTP Response Header Field(s)',
  10038: 'Content Security Policy (CSP) Header Not Set', 40035: 'Hidden File Found',
};
const ZAP_PASS = ['Vulnerable JS Library (Powered by Retire.js) [10003]', 'Cookie Poisoning [10029]', 'Incomplete or No Cache-control Header Set [10015]', 'Cross-Domain JavaScript Source File Inclusion [10017]', 'Content-Type Header Missing [10019]', 'Information Disclosure - Debug Error Messages [10023]', 'Information Disclosure - Sensitive Information in URL [10024]', 'Open Redirect [10028]', 'User Controllable HTML Element Attribute (Potential XSS) [10031]', 'Viewstate [10032]', 'Directory Browsing [10033]', 'Heartbleed OpenSSL Vulnerability (Indicative) [10034]', 'X-Backend-Server Header Information Leak [10039]', 'Secure Pages Include Mixed Content [10040]', 'HTTP to HTTPS Insecure Transition in Form Post [10041]', 'Absence of Anti-CSRF Tokens [10202]', 'Private IP Disclosure [2]', 'Session ID in URL Rewrite [3]'];
const HIDDEN = ['/.env', '/.git/config', '/.git/HEAD', '/backup.sql', '/.DS_Store', '/config.php.bak', '/.htpasswd'];

function zapScan(c, full) {
  const a = [...c.args];
  const o = opts(a, { bool: ['-I', '-j', '-s'], val: ['-t', '-r', '-w', '-c', '-m', '-l'] });
  const target = o['-t'];
  if (!target || !/^https?:\/\//.test(target)) { c.eprint(`Usage: ${full ? 'zap-full-scan.py' : 'zap-baseline.py'} -t <target> [options]`, '    -t target         target URL including the protocol, e.g. https://www.example.com', '    -c config_file    config file to use to INFO, IGNORE or FAIL warnings', '    -r report_html    file to write the full ZAP HTML report', '    -I                do not return failure on warning'); return 3; }
  const levels = {};
  for (const l of (o['-c'] ? (c.host.files.get(c.resolve(o['-c'])) || '') : '').split('\n')) { const m = l.match(/^(\d+)\s+(IGNORE|INFO|WARN|FAIL|OUTOFSCOPE)\b/); if (m) levels[m[1]] = m[2]; }
  const base = new URL(target);
  const urls = [target];
  const seen = new Map();
  const get = u => { if (!seen.has(u)) seen.set(u, httpRequest(c.uni, c.host, u, { headers: { 'user-agent': 'Mozilla/5.0 (ZAP)' } })); return seen.get(u); };
  const first = get(target);
  if (first.error) { c.eprint(`ERROR [Errno 111] Connection refused: could not access ${target}`); return 3; }
  // spider: follow same-site links
  for (let i = 0; i < urls.length && urls.length < 12; i++) {
    const r = get(urls[i]);
    for (const m of String(r.body || '').matchAll(/href=["']([^"'#]+)["']/g)) { try { const u = new URL(m[1], urls[i]); if (u.host === base.host && !urls.includes(u.href)) urls.push(u.href); } catch { /* ignore */ } }
  }
  const alerts = {};
  const hit = (id, url, status) => { (alerts[id] = alerts[id] || []).push(`${url} (${status})`); };
  for (const u of urls) {
    const r = get(u);
    if (r.error) continue;
    const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const st = `${r.status} ${r.status === 200 ? 'OK' : ''}`.trim();
    if (!h['x-content-type-options']) hit(10021, u, st);
    if (!h['x-frame-options'] && !/frame-ancestors/.test(h['content-security-policy'] || '')) hit(10020, u, st);
    if (!h['content-security-policy']) hit(10038, u, st);
    if (u.startsWith('https:') && !h['strict-transport-security']) hit(10035, u, st);
    if (/\d/.test(h.server || '')) hit(10036, u, st);
    if (h['x-powered-by']) hit(10037, u, st);
    for (const ck of [].concat(h['set-cookie'] || [])) { if (!/httponly/i.test(ck)) hit(10010, u, st); if (!/secure/i.test(ck)) hit(10011, u, st); }
  }
  if (full) {
    for (const p of HIDDEN) { const u = base.origin + p; const r = get(u); if (!r.error && r.status === 200 && String(r.body || '').length) hit(40035, u, '200 OK'); }
  }
  const failIds = new Set([40035]);
  const res = { FAIL: [], WARN: [], INFO: [], IGNORE: [] };
  for (const [id, list] of Object.entries(alerts)) {
    const lvl = levels[id] || (failIds.has(Number(id)) ? 'FAIL' : 'WARN');
    if (lvl === 'OUTOFSCOPE') continue;
    res[lvl === 'INFO' ? 'INFO' : lvl].push([id, list]);
  }
  c.print(`Using the Automation Framework`, `Total of ${urls.length} URLs`);
  const passed = ZAP_PASS.length + Object.keys(ZAP_RULES).filter(id => !alerts[id]).length;
  for (const p of ZAP_PASS) c.print(`PASS: ${p}`);
  for (const id of Object.keys(ZAP_RULES).filter(id => !alerts[id] && (full || Number(id) !== 40035))) c.print(`PASS: ${ZAP_RULES[id]} [${id}]`);
  for (const [lvl, label] of [['IGNORE', 'IGNORE'], ['INFO', 'INFO'], ['WARN', 'WARN-NEW'], ['FAIL', 'FAIL-NEW']]) for (const [id, list] of res[lvl]) {
    c.print(`${lvl === 'FAIL' ? C.red(label) : lvl === 'WARN' ? C.yellow(label) : label}: ${ZAP_RULES[id]} [${id}] x ${list.length} `);
    for (const l of list.slice(0, 5)) c.print(`\t${l}`);
  }
  c.print(`FAIL-NEW: ${res.FAIL.length}\tFAIL-INPROG: 0\tWARN-NEW: ${res.WARN.length}\tWARN-INPROG: 0\tINFO: ${res.INFO.length}\tIGNORE: ${res.IGNORE.length}\tPASS: ${passed}`);
  if (o['-r']) c.host.writeFile(c.resolve(o['-r']), `<html><head><title>ZAP Scanning Report</title></head><body><h1>ZAP Scanning Report</h1><p>Site: ${target}</p><ul>${[...res.FAIL, ...res.WARN].map(([id, l]) => `<li>${ZAP_RULES[id]} (${l.length})</li>`).join('')}</ul></body></html>\n`, c.user);
  c.uni.emit({ type: 'zap', host: c.host.name, full, target, urls: urls.length, warn: res.WARN.map(([id]) => Number(id)), fail: res.FAIL.map(([id]) => Number(id)) });
  return res.FAIL.length ? 1 : res.WARN.length && !o['-I'] ? 2 : 0;
}
def('zap-baseline.py', c => zapScan(c, false), { pkg: 'zaproxy' });
def('zap-full-scan.py', c => zapScan(c, true), { pkg: 'zaproxy' });

// ================================================================ sshd -t and the SSH server config

def('sshd', c => {
  if (c.args[0] !== '-t' && c.args[0] !== '-T') return c.fail('sshd: in the lab sshd is managed by systemd: use `sudo sshd -t` to check the config, `sudo systemctl reload ssh` to apply it', 1);
  if (c.user !== 'root') return c.fail('sshd: no hostkeys available -- exiting.', 1);
  const { cfg, errors } = sshdConfig(c.host);
  if (errors.length) { c.eprint(...errors, `/etc/ssh/sshd_config: terminating, ${errors.length} bad configuration options`); c.uni.emit({ type: 'sshd-test', host: c.host.name, ok: false }); return 255; }
  if (c.args[0] === '-T') c.print(...Object.entries(cfg).map(([k, v]) => `${k} ${v}`));
  c.uni.emit({ type: 'sshd-test', host: c.host.name, ok: true });
  return 0;
}, { always: true });

// ================================================================ lynis

const DATASTORE_PORTS = { 6379: 'Redis', 5432: 'PostgreSQL', 3306: 'MySQL', 27017: 'MongoDB', 11211: 'Memcached', 9200: 'Elasticsearch' };
function modeOf(host, p) { return host.stat(p)?.mode ?? 0; }

export function lynisAudit(host) {
  const warnings = [], suggestions = [];
  const { cfg } = sshdConfig(host);
  if (cfg.permitrootlogin === 'yes') warnings.push(['SSH-7412', 'Root can log in directly over SSH', 'PermitRootLogin (set YES to NO)']);
  if (cfg.passwordauthentication === 'yes') warnings.push(['SSH-7414', 'SSH accepts password logins (brute-force target)', 'PasswordAuthentication (set YES to NO)']);
  if (!host.firewall.enabled) warnings.push(['FIRE-4590', 'No firewall active', 'Enable ufw with only the ports you need (ssh, http, https)']);
  for (const [port, l] of host.listening) if (DATASTORE_PORTS[port] && l.addr !== '127.0.0.1' && l.addr !== '::1' && host.procs.has(l.pid)) warnings.push(['NETW-3200', `${DATASTORE_PORTS[port]} listening on all interfaces (port ${port})`, `bind it to 127.0.0.1 or protect it with the firewall`]);
  for (const p of [...host.files.keys()].filter(p => p.startsWith('/etc/sudoers.d/') || p === '/etc/sudoers')) for (const l of (host.files.get(p) || '').split('\n')) { const m = l.match(/^\s*([\w%-]+)\s+ALL\s*=\s*\(ALL(?::ALL)?\)\s*NOPASSWD:\s*ALL/); if (m && m[1] !== 'ubuntu') warnings.push(['AUTH-9252', `${p} gives ${m[1]} passwordless root for every command`, 'limit sudo to the commands needed, or require a password']); }
  const ww = [...host.files.keys()].filter(p => /^\/(etc|opt|srv|var\/www)\//.test(p) && (modeOf(host, p) & 0o002));
  if (ww.length) warnings.push(['FILE-7524', `World-writable files: ${ww.slice(0, 3).join(', ')}${ww.length > 3 ? ' …' : ''}`, 'remove write permission for others (chmod o-w)']);
  const sec = [...host.files.keys()].filter(p => /^\/(etc|opt|srv)\/.*\.(env|ini|conf|json)$/.test(p) && (modeOf(host, p) & 0o004) && /(PASSWORD|SECRET|TOKEN|_KEY)\s*=/.test(host.files.get(p) || ''));
  if (sec.length) warnings.push(['FILE-7590', `Secrets readable by every user: ${sec.slice(0, 3).join(', ')}`, 'make secret files readable only by the service user (chmod 600 or 640)']);
  for (const [name, u] of host.users) if (u.uid === 0 && name !== 'root') warnings.push(['AUTH-9204', `User ${name} has UID 0 (a second root)`, 'remove or renumber the account']);
  if (!host.packages.has('unattended-upgrades')) suggestions.push(['PKGS-7392', 'Install unattended-upgrades to get security updates automatically', 'apt install unattended-upgrades']);
  if (!host.packages.has('fail2ban')) suggestions.push(['DEB-0880', 'Install fail2ban to ban hosts that keep failing to log in', 'apt install fail2ban']);
  const index = Math.max(20, 100 - warnings.length * 8 - suggestions.length * 3);
  return { warnings, suggestions, index };
}

def('lynis', c => {
  const [sub, what] = c.args;
  if (sub === '--version' || sub === 'show' && what === 'version') { c.print('3.0.9'); return 0; }
  if (sub !== 'audit' || what !== 'system') { c.print('', '  Usage: lynis command [options]', '', '  Command:', '    audit system   Perform local security scan', '    show version   Show Lynis version'); return sub ? 1 : 0; }
  if (c.user !== 'root') return c.fail('\n  [!] Lynis needs root to audit the whole system: run it with sudo\n', 1);
  const r = lynisAudit(c.host);
  c.print('', `[ Lynis 3.0.9 ]`, '', '################################################################################', '  Lynis comes with ABSOLUTELY NO WARRANTY.', '################################################################################', '', '[+] Initializing program', '------------------------------------', `  - Detecting OS...                                           [ DONE ]`, `  - Checking profiles...                                      [ DONE ]`, '', `  Program version:           3.0.9`, `  Operating system:          Linux`, `  Operating system name:     Ubuntu`, `  Operating system version:  24.04`, `  Hostname:                  ${c.host.name}`, '');
  const ok = (label, good) => `  - ${pad(label, 58)}[ ${good ? C.green('OK') : C.yellow('WARNING')} ]`;
  const ids = new Set(r.warnings.map(w => w[0]));
  c.print('[+] SSH Support', '------------------------------------', ok('SSH option: PermitRootLogin', !ids.has('SSH-7412')), ok('SSH option: PasswordAuthentication', !ids.has('SSH-7414')), '', '[+] Firewalls', '------------------------------------', ok('Checking host based firewall', !ids.has('FIRE-4590')), '', '[+] Networking', '------------------------------------', ok('Checking for exposed data stores', !ids.has('NETW-3200')), '', '[+] Users, Groups and Authentication', '------------------------------------', ok('Sudoers file(s)', !ids.has('AUTH-9252')), ok('Accounts with UID 0', !ids.has('AUTH-9204')), '', '[+] File Permissions', '------------------------------------', ok('World-writable files', !ids.has('FILE-7524')), ok('Readable secret files', !ids.has('FILE-7590')), '');
  c.print('  -[ Lynis 3.0.9 Results ]-', '');
  if (r.warnings.length) { c.print(`  ${C.yellow('Warnings')} (${r.warnings.length}):`, '  ----------------------------'); for (const [id, t, d] of r.warnings) c.print(`  ${C.yellow('!')} ${t} [${id}]`, `      - Solution : ${d}`, ''); }
  else c.print(`  ${C.green('Great, no warnings')}`, '');
  if (r.suggestions.length) { c.print(`  Suggestions (${r.suggestions.length}):`, '  ----------------------------'); for (const [id, t, d] of r.suggestions) c.print(`  * ${t} [${id}]`, `      - Solution : ${d}`, ''); }
  const bar = '#'.repeat(Math.round(r.index / 5)).padEnd(20);
  c.print('', '  Lynis security scan details:', '', `  Hardening index : ${r.index} [${bar}]`, `  Tests performed : 262`, '', '  Files:', '  - Test and debug information      : /var/log/lynis.log', '  - Report data                     : /var/log/lynis-report.dat', '');
  c.host.writeFile('/var/log/lynis-report.dat', [`hostname=${c.host.name}`, `hardening_index=${r.index}`, ...r.warnings.map(w => `warning[]=${w[0]}|${w[1]}|`), ...r.suggestions.map(s => `suggestion[]=${s[0]}|${s[1]}|`)].join('\n') + '\n', 'root');
  c.uni.emit({ type: 'lynis', host: c.host.name, index: r.index, warnings: r.warnings.map(w => w[0]), suggestions: r.suggestions.map(s => s[0]) });
  return 0;
}, { pkg: 'lynis' });

// ================================================================ cosign

function signatures(uni) { uni.cosign = uni.cosign || new Map(); return uni.cosign; }
function withPassword(c, env, then) {
  if (env.COSIGN_PASSWORD !== undefined) return then(env.COSIGN_PASSWORD);
  c.result.ask = { prompt: 'Enter password for private key:', secret: true, onAnswer(ans, ctx) { return then(ans.trim(), ctx); } };
  return 0;
}

def('cosign', c => {
  const [sub, ...rest] = c.args;
  const o = opts(rest, { bool: ['-y', '--yes', '--insecure-ignore-tlog'], val: ['--key', '--output-key-prefix', '--tlog-upload'] });
  const out = (io, ...l) => io ? io.out(l.join('\n') + '\n') : c.print(...l);
  if (!sub || sub === '--help') { c.print('A tool for Container Signing, Verification and Storage in an OCI registry.', '', 'Usage:', '  cosign [command]', '', 'Available Commands:', '  generate-key-pair  Generates a key-pair.', '  sign               Sign the supplied container image.', '  verify             Verify a signature on the supplied container image', '  version            Prints the cosign version'); return 0; }
  if (sub === 'version') { c.print('GitVersion:    v2.4.1'); return 0; }
  if (sub === 'generate-key-pair') {
    const prefix = o['--output-key-prefix'] || 'cosign';
    if (c.host.files.has(c.resolve(prefix + '.key'))) return c.fail(`Error: ${prefix}.key already exists, refusing to overwrite`, 1);
    return withPassword(c, c.env, (pw, ctx) => {
      const n = (c.uni.cosignSeq = (c.uni.cosignSeq || 0) + 1);
      const id = btoa(`lumen-key-${n}-${c.host.name}-${c.uni.time}`).replace(/=/g, '').padEnd(24, 'A');
      c.host.writeFile(c.resolve(prefix + '.key'), `-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\neyJrZGYiOnsibmFtZSI6InNjcnlwdCJ9\n${id}${btoa(pw || 'x').replace(/=/g, '')}Qk9YU0VBTA\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----\n`, c.user);
      c.host.setMeta(c.resolve(prefix + '.key'), { mode: 0o600 });
      c.host.writeFile(c.resolve(prefix + '.pub'), `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n${id}\n-----END PUBLIC KEY-----\n`, c.user);
      (c.uni.cosignKeys = c.uni.cosignKeys || new Map()).set(id.slice(0, 24), pw);
      if (ctx) ctx.io.out(''); out(ctx?.io, `Private key written to ${prefix}.key`, `Public key written to ${prefix}.pub`);
      c.uni.emit({ type: 'cosign', host: c.host.name, op: 'keys' });
      return 0;
    });
  }
  const ref = o._[0];
  if (!['sign', 'verify'].includes(sub)) return c.fail(`Error: unknown command "${sub}" for "cosign"`, 1);
  if (!ref) return c.fail(`Error: accepts at least 1 arg(s), received 0`, 1);
  if (!o['--key']) return c.fail(sub === 'sign' ? 'Error: signing without --key uses keyless (OIDC) signing, which needs a browser: in the lab use --key cosign.key' : 'Error: --key or --certificate-identity is required for verification', 1);
  const p = parseRef(ref);
  // a digest reference finds whichever tag of that repository currently has the digest
  const hit = p.digest ? [...(c.uni.registry || new Map())].find(([k, v]) => v.digest === p.digest && parseRef(k).name === p.name) : null;
  if (hit) p.short = hit[0];
  const entry = hit ? hit[1] : c.uni.registry?.get(p.short);
  const keyText = c.host.files.get(c.resolve(o['--key']));
  if (keyText === undefined) return c.fail(`Error: reading key: open ${o['--key']}: no such file or directory`, 1);
  if (sub === 'sign') {
    if (!/PRIVATE KEY/.test(keyText)) return c.fail('Error: signing: reading key: decrypt: invalid private key (did you pass the .pub file?)', 1);
    if (!entry) return c.fail(`Error: signing [${ref}]: accessing entity: GET https://${p.registry}/v2/${p.repo}/manifests/${p.tag}: MANIFEST_UNKNOWN: manifest unknown`, 1);
    if (p.digest && p.digest !== entry.digest) return c.fail(`Error: signing [${ref}]: accessing entity: MANIFEST_UNKNOWN: manifest unknown`, 1);
    const eng = c.host.docker || (c.host.packages.has('docker.io') ? engineOf(c.host, c.uni) : null);
    if (p.registry !== 'docker.io' && !eng?.loggedIn?.has(p.registry)) return c.fail(`Error: signing [${ref}]: getting signer: UNAUTHORIZED: authentication required (run docker login ${p.registry} first)`, 1);
    const id = keyText.split('\n')[2]?.slice(0, 24);
    const finish = (io) => {
      const sigs = signatures(c.uni);
      if (!sigs.has(entry.digest)) sigs.set(entry.digest, new Set());
      sigs.get(entry.digest).add(id);
      out(io, `Pushing signature to: ${p.registry === 'docker.io' ? 'index.docker.io/' : p.registry + '/'}${p.repo}`);
      c.uni.emit({ type: 'cosign', host: c.host.name, op: 'sign', ref: p.short, digest: entry.digest, byDigest: !!p.digest });
      return 0;
    };
    return withPassword(c, c.env, (pw, ctx) => {
      const want = c.uni.cosignKeys?.get(id);
      if (want !== undefined && want !== pw) { out(ctx?.io, 'Error: signing: getting signer: reading key: decrypt: encrypted: decryption failed'); return 1; }
      if (!p.digest) out(ctx?.io, `WARNING: Image reference ${ref} uses a tag, not a digest, to identify the image to sign.`, '    This can lead you to sign a different image than the intended one. Please use a', '    digest (example.com/ubuntu@sha256:abc123...) rather than tag', '    (example.com/ubuntu:latest) for the input to cosign. The ability to refer to', '    images by tag will be removed in a future release.', '');
      if (o['-y'] || o['--yes'] || o['--tlog-upload'] === 'false') return finish(ctx?.io);
      const ask = { prompt: '\n\tNote that there may be personally identifiable information associated with this signed artifact.\n\tThis may include the email address associated with the account with which you authenticate.\n\tThis information will be used for signing this artifact and will be stored in public transparency logs and cannot be removed later.\n\nBy typing \'y\', you attest that you grant (or have permission to grant) and agree to have this information stored permanently in transparency logs.\nAre you sure you would like to continue? [y/N]', onAnswer(ans, ctx2) { if (!/^y(es)?$/i.test(ans.trim())) { ctx2.io.out('Error: signing: user declined\n'); return 1; } return finish(ctx2.io); } };
      if (ctx) { ctx.result.ask = ask; return 0; }
      c.result.ask = ask;
      return 0;
    });
  }
  // verify
  if (!/PUBLIC KEY/.test(keyText)) return c.fail('Error: loading public key: PEM decoding failed (did you pass the private key?)', 1);
  const pubId = keyText.split('\n')[2]?.slice(0, 24);
  const digest = p.digest || entry?.digest;
  if (!digest || (!entry && !p.digest)) return c.fail(`Error: GET https://${p.registry}/v2/${p.repo}/manifests/${p.tag}: MANIFEST_UNKNOWN: manifest unknown\nmain.go:69: error during command execution: GET https://${p.registry}/v2/${p.repo}/manifests/${p.tag}: MANIFEST_UNKNOWN: manifest unknown`, 1);
  const ok = signatures(c.uni).get(digest)?.has(pubId);
  c.uni.emit({ type: 'cosign', host: c.host.name, op: 'verify', ref: p.short, digest, ok: !!ok });
  if (!ok) return c.fail('Error: no matching signatures: \nmain.go:69: error during command execution: no matching signatures:', 1);
  c.eprint('', `Verification for ${ref} --`, 'The following checks were performed on each of these signatures:', '  - The cosign claims were validated', '  - Existence of the claims in the transparency log was verified offline', '  - The signatures were verified against the specified public key', '');
  c.print(JSON.stringify([{ critical: { identity: { 'docker-reference': `${p.registry}/${p.repo}` }, image: { 'docker-manifest-digest': digest }, type: 'cosign container image signature' }, optional: null }]));
  return 0;
}, { pkg: 'cosign' });

// ================================================================ GitHub Actions

// gitleaks/gitleaks-action: scans the history of the pushed commit
ACTIONS['gitleaks/gitleaks-action'] = ({ job, run, world, flat }) => {
  const r = scanHistory(world, [run.hash]);
  const ign = new Set((flat.has('.gitleaksignore') ? world.objects.get(flat.get('.gitleaksignore')).content : '').split('\n').map(l => l.trim()).filter(Boolean));
  const found = r.findings.filter(f => !ign.has(leakFingerprint(f)));
  job.log.push(`  ${r.commits} commits scanned.`);
  for (const f of found) job.log.push(`  Finding: ${f.rule.id} in ${f.file}:${f.line} (commit ${f.commit.slice(0, 7)})`);
  if (found.length) { job.log.push(`  WRN leaks found: ${found.length}`, '  Error: 🛑 Leaks detected, see job summary for details'); return false; }
  job.log.push('  ✅ No leaks detected');
  return true;
};

// aquasecurity/trivy-action: installs trivy and runs the requested scan
ACTIONS['aquasecurity/trivy-action'] = ({ h, uni, w, shell }) => {
  installPkg(h, uni, 'trivy', []);
  const type = w['scan-type'] || 'image';
  const target = type === 'image' ? w['image-ref'] : (w['scan-ref'] || '.');
  if (!target) { shell('echo "Error: image-ref is required for scan-type image" >&2; exit 1'); return false; }
  const args = [type, '--exit-code', w['exit-code'] || '0'];
  if (w.severity) args.push('--severity', w.severity);
  if (String(w['ignore-unfixed']) === 'true') args.push('--ignore-unfixed');
  if (w.scanners) args.push('--scanners', w.scanners);
  if (w.trivyignores) args.push('--ignorefile', w.trivyignores);
  return shell(`trivy ${args.join(' ')} ${target}`) === 0;
};
