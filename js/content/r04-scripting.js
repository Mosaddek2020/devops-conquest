// Realm 4 · Scripting & Automation: scripts, conditions and loops, robustness, a deploy script.
// Labs grade scripts by running them (t.exec) in throwaway shells.

import { parseMakefile } from '../sim/cmd/make.js';

const hist = (t, re) => { let k = -1; t.history.forEach((l, i) => { if (re.test(l)) k = i; }); return k; };
const strict = f => /^#!\s*\/(usr\/)?(bin\/)?(env\s+)?bash/.test(f || '') && /set\s+-[a-z]*e[a-z]*u[a-z]*o?\s*(pipefail)?|set\s+-euo\s+pipefail/.test(f || '');
const exe = (t, on, p) => t.exists(on, p) && (t.mode(on, p) & 0o100);


// ---------- make ----------
const MK_BROKEN = `# notify: one command per task. Start with \`make help\`.
VERSION ?= 1.0.0

help:
    @echo "make lint      check the code"
    @echo "make test      run the tests"
    @echo "make build     package dist/notify-VERSION.tar.gz"
    @echo "make deploy    test, build and ship"

lint:
\t@grep -rn "debugger" src && exit 1 || echo "lint ok"

test:
\t@bash tests/run.sh

clean:
\trm -rf dist
`;
const MK_GOOD = MK_BROKEN.replace(/^    @/gm, '\t@').replace('VERSION ?= 1.0.0\n', 'VERSION ?= 1.0.0\nSRC := $(wildcard src/*.js)\n\n.PHONY: help lint test clean deploy build\n') + '\nbuild: dist/notify-$(VERSION).tar.gz\n\ndist/notify-$(VERSION).tar.gz: $(SRC) package.json\n\tmkdir -p dist\n\ttar czf $@ src package.json\n\ndeploy: test build\n\t@echo "deploying notify $(VERSION)"\n';
const nexec = (t, cmd) => t.exec('laptop', `cd ~/notify && ${cmd}`);
const mkRules = t => { try { return parseMakefile(t.file('laptop', '~/notify/Makefile') || ''); } catch { return null; } };

// ---------- APIs ----------
const API_TOKEN = ['lmn', 'pat', 'r8Qw2Lx9Vt4K'].join('_');
const INCIDENTS = [
  ['Checkout returns 500 for PayPal', 'sev1', 'open', 'shop'], ['Search slow for 2% of users', 'sev3', 'open', 'search'], ['Emails delayed 20 minutes', 'sev2', 'resolved', 'notify'], ['Login loop on Safari', 'sev2', 'open', 'auth'], ['Invoices missing VAT line', 'sev1', 'resolved', 'billing'],
  ['Card payments declined (Visa)', 'sev1', 'open', 'payments'], ['Images not loading in EU', 'sev2', 'open', 'cdn'], ['Stock counts negative', 'sev3', 'resolved', 'inventory'], ['Order export stuck', 'sev2', 'open', 'reports'], ['API 503 during deploy', 'sev1', 'open', 'shop'],
  ['Push notifications duplicated', 'sev3', 'open', 'notify'], ['Refunds not issued', 'sev1', 'resolved', 'payments'], ['Kafka consumer lag', 'sev2', 'open', 'events'], ['Database failover slow', 'sev1', 'open', 'db'],
].map(([title, severity, state, service], i) => ({ id: 101 + i, title, severity, state, service, opened: `2026-01-0${1 + (i % 9)}T0${i % 10}:15:00Z` }));
const SEV1_OPEN = INCIDENTS.filter(x => x.severity === 'sev1' && x.state === 'open').length;
function incidentApi(H) {
  const st = H.uni.labData.api = { created: [], health: 0 };
  const auth = req => req.headers.authorization === `Bearer ${API_TOKEN}`;
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, null, 2) });
  H.site('api.lumen.dev', {
    '/v1/incidents': req => {
      if (!auth(req)) return json(401, { error: 'missing or invalid token', hint: 'Authorization: Bearer <token>' });
      if (req.method === 'POST') {
        let b; try { b = JSON.parse(req.body || ''); } catch { return json(400, { error: 'body is not valid JSON' }); }
        const missing = ['title', 'severity', 'service'].filter(k => !b[k]);
        if (missing.length || !/^sev[123]$/.test(b.severity || '')) return json(422, { error: 'validation failed', fields: missing.length ? missing : ['severity must be sev1, sev2 or sev3'] });
        const inc = { id: 101 + INCIDENTS.length + st.created.length, title: b.title, severity: b.severity, state: 'open', service: b.service, opened: '2026-01-10T09:00:00Z' };
        st.created.push(inc);
        return json(201, inc);
      }
      const page = Number((req.query.match(/page=(\d+)/) || [])[1] || 1), per = 5;
      const all = [...INCIDENTS, ...st.created];
      const data = all.slice((page - 1) * per, page * per);
      return json(200, { data, page, per_page: per, total: all.length, next: page * per < all.length ? `/v1/incidents?page=${page + 1}` : null });
    },
    '/v1/health': () => (++st.health % 3 === 0 ? json(200, { status: 'ok' }) : json(503, { status: 'unavailable', reason: 'leader election in progress' })),
    '*': req => auth(req) ? json(404, { error: 'not found' }) : json(401, { error: 'missing or invalid token' }),
  });
}

// ---------- testing scripts ----------
const ROTATE_V1 = `#!/usr/bin/env bash
# rotate-backups.sh DIR [KEEP]: keep the newest KEEP backups (default 7), delete the older ones
set -euo pipefail
dir=$1
keep=\${2:-7}
cd $dir
for f in $(ls -1 | sort -r | tail -n +$keep); do
  rm $f
done
echo "kept $keep backups in $dir"
`;
const ROTATE_LINTED = `#!/usr/bin/env bash
# rotate-backups.sh DIR [KEEP]: keep the newest KEEP backups (default 7), delete the older ones
set -euo pipefail
dir="$1"
keep="\${2:-7}"
cd "$dir" || exit 1
printf '%s\\n' backup-*.tar.gz | sort -r | tail -n +"$keep" | while read -r f; do
  rm -- "$f"
done
echo "kept $keep backups in $dir"
`;
const ROTATE_FIXED = ROTATE_LINTED.replace('tail -n +"$keep"', 'tail -n +"$((keep + 1))"');
const BATS_V1 = `setup() {
  dir="$(mktemp -d)"
  for d in 01 02 03 04 05 06 07 08 09 10; do touch "$dir/backup-2026-01-$d.tar.gz"; done
}

@test "keeps the newest 7 by default" {
  run bash rotate-backups.sh "$dir"
  [ "$status" -eq 0 ]
  [ "$(ls "$dir" | wc -l)" -eq 7 ]
  [ -e "$dir/backup-2026-01-10.tar.gz" ]
}

@test "keeps 3 when asked" {
  run bash rotate-backups.sh "$dir" 3
  [ "$status" -eq 0 ]
  [ "$(ls "$dir" | wc -l)" -eq 3 ]
}
`;
const BATS_EXTRA = `
@test "never deletes files that are not backups" {
  touch "$dir/README.txt"
  run bash rotate-backups.sh "$dir" 3
  [ "$status" -eq 0 ]
  [ -e "$dir/README.txt" ]
}
`;
const SCRIPTS_WF = 'name: scripts\non:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: sudo apt-get install -y shellcheck bats\n      - run: shellcheck *.sh\n      - run: bats test/\n';
const batsRun = t => { const r = t.exec('laptop', 'cd ~/ops-scripts && bats test/'); const m = r.out.match(/(\d+) tests?, (\d+) failures?/); return m ? { total: Number(m[1]), failures: Number(m[2]), out: r.out } : { total: 0, failures: -1, out: r.out }; };
const wfOn = (t, slug) => { const h = t.remote(slug)?.refs['refs/heads/main']; if (!h) return ''; return [...t.uni.readTreeFlat(t.uni.commit(h).tree)].filter(([p]) => p.startsWith('.github/workflows/')).map(([, b]) => t.uni.objects.get(b).content).join('\n'); };

const CHECK_DISK = `#!/usr/bin/env bash
# check-disk.sh [threshold-percent]: exit 1 when / is fuller than the threshold
set -euo pipefail
threshold="\${1:-80}"
if ! [[ "$threshold" =~ ^[0-9]+$ ]]; then
  echo "usage: check-disk.sh [threshold-percent]" >&2
  exit 2
fi
used=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
if (( used > threshold )); then
  echo "WARNING: / is at \${used}% (threshold \${threshold}%)"
  exit 1
fi
echo "OK: / is at \${used}% (threshold \${threshold}%)"
`;

const SITE_CHECK = `#!/usr/bin/env bash
# site-check.sh [url-file]: check every URL, report, exit 1 if any failed
set -euo pipefail
file="\${1:-$HOME/urls.txt}"
checked=0
failed=0

check_url() {
  local url="$1" code
  code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" "$url" || true)
  if [[ "$code" == 200 ]]; then
    echo "OK   $code $url"
  else
    echo "FAIL $code $url"
    return 1
  fi
}

while read -r url; do
  [[ -z "$url" || "$url" == \\#* ]] && continue
  checked=$((checked + 1))
  check_url "$url" || failed=$((failed + 1))
done < "$file"

echo "$checked checked, $failed failed"
(( failed == 0 ))
`;

const AI_CLEANUP = `#!/bin/bash
# Generated by the AI assistant from the prompt:
#   "write a script that cleans the build directory and sets up the build user"
BUILD_DIR=$1
rm -rf $BUILD_DIR/*
mkdir $BUILD_DIR/cache
useradd builder
echo "export BUILD_CACHE=$BUILD_DIR/cache" >> /etc/profile.d/build.sh
echo "done"
`;

const FIXED_CLEANUP = `#!/usr/bin/env bash
# cleanup-build.sh [--dry-run] <build-dir>
set -euo pipefail
DRY_RUN=false
if [[ "\${1:-}" == "--dry-run" ]]; then DRY_RUN=true; shift; fi
BUILD_DIR="\${1:?usage: cleanup-build.sh [--dry-run] <build-dir>}"
if [[ "$BUILD_DIR" == "/" || ! -d "$BUILD_DIR" ]]; then
  echo "refusing: '$BUILD_DIR' is not a safe build directory" >&2
  exit 1
fi

run() { echo "+ $*"; if [[ "$DRY_RUN" == false ]]; then "$@"; fi; }

run rm -rf "\${BUILD_DIR:?}"/*
run mkdir -p "$BUILD_DIR/cache"
id builder >/dev/null 2>&1 || run useradd builder
grep -qs "BUILD_CACHE=" /etc/profile.d/build.sh || run sh -c "echo 'export BUILD_CACHE=$BUILD_DIR/cache' >> /etc/profile.d/build.sh"
echo "done"
`;

const DEPLOY = `#!/usr/bin/env bash
# deploy.sh <version>: release notes <version> to web1, roll back if the health check fails
set -euo pipefail
VERSION="\${1:?usage: deploy.sh <version>}"
HOST=ubuntu@web1
TARBALL="$HOME/releases/notes-$VERSION.tar.gz"
[[ -f "$TARBALL" ]] || { echo "no such release: $TARBALL" >&2; exit 2; }
log() { echo "[deploy] $*"; }

PREVIOUS=$(ssh "$HOST" "readlink /opt/notes/current")
log "current: $PREVIOUS, deploying $VERSION"
scp "$TARBALL" "$HOST:/tmp/"
ssh "$HOST" "sudo -u notes mkdir -p /opt/notes/releases/$VERSION && sudo -u notes tar -xzf /tmp/notes-$VERSION.tar.gz -C /opt/notes/releases/$VERSION"
ssh "$HOST" "cd /opt/notes && sudo -u notes ln -sfn releases/$VERSION current && sudo systemctl restart notes"

if ssh "$HOST" "curl -sf localhost:4000/health" | grep -q "\\"version\\":\\"$VERSION\\""; then
  log "$VERSION is live"
else
  log "health check failed: rolling back to $PREVIOUS"
  ssh "$HOST" "cd /opt/notes && sudo -u notes ln -sfn $PREVIOUS current && sudo systemctl restart notes"
  exit 1
fi
`;

// --- graders -------------------------------------------------------------
function prepBuildbox(t) {
  const h = t.host('buildbox');
  // an unguarded script may have wiped the box on an earlier run (rm -rf /*): rebuild the basics
  for (const d of ['/etc', '/etc/profile.d', '/srv', '/opt', '/tmp', '/var', '/var/log', '/home', '/root', '/usr', '/usr/bin']) h.mkdirMeta(d);
  h.meta.get('/tmp').mode = 0o1777;
  h.syncPasswd();
  for (const p of [...h.files.keys()].filter(p => p.startsWith('/srv/build/'))) h.removeFile(p);
  h.mkdirMeta('/srv/build');
  h.writeFile('/srv/build/out/app.o', 'old object file\n', 'root');
  h.writeFile('/opt/important/data.txt', 'do not delete\n', 'root');
  h.writeFile('/etc/hostname', 'buildbox\n', 'root');
  if (h.users.has('builder')) { h.users.delete('builder'); h.groups.delete('builder'); }
  h.removeFile('/etc/profile.d/build.sh');
  h.writeFile('/tmp/cleanup-build.sh', t.file('laptop', '/home/dev/scripts/cleanup-build.sh') || '', 'root');
}
const intact = h => h.files.has('/opt/important/data.txt') && h.files.has('/etc/hostname');

function resetNotes(t) { t.exec('web1', 'cd /opt/notes && sudo -u notes ln -sfn releases/2.0.0 current && sudo systemctl restart notes', { user: 'ubuntu' }); }
const health = t => t.http('web1', 'http://localhost:4000/health');

const tarball = files => 'TAR1' + JSON.stringify(files);
const notesApp = (version, extra = '') => `const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || 4000;\nconst VERSION = '${version}';\n${extra}\napp.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION }));\napp.listen(PORT, '127.0.0.1', () => console.log(\`notes \${VERSION} listening on \${PORT}\`));\n`;
const release = (v, extra) => tarball({ 'server.js': notesApp(v, extra), 'node_modules/express/package.json': '{"name":"express"}\n' });

export default {
  id: 'scripting',
  n: 4,
  title: 'Scripting & Automation',
  tagline: 'Bash scripts, decisions and loops, robust and idempotent automation',
  badge: 'Automator',
  intro: 'If you did it twice, script it. Write **bash scripts** with arguments and exit codes, make decisions with **conditions and loops**, build **robust, idempotent** automation (and review AI-written scripts like a pro), then turn a whole deploy into **one command**. Your scripts are graded by running them.',
  lessons: [
    {
      id: 'bash-scripts',
      title: 'Your first real script',
      summary: 'Shebang, chmod +x, variables, arguments and defaults, $(…), exit codes, set -euo pipefail.',
      minutes: 22,
      lab: {
        cwd: '~',
        panels: ['files', 'system'],
        setup(H) { H.laptop.diskGB = 100; H.laptop.baseDiskGB = 62; },
        suggestions: ['mkdir -p ~/bin', 'nano ~/bin/check-disk.sh'],
        tasks: [
          { title: 'Create `~/bin/check-disk.sh` starting with a bash shebang and `set -euo pipefail`', solution: 'mkdir -p ~/bin && nano ~/bin/check-disk.sh', test: ['mkdir -p ~/bin', { cmd: 'nano ~/bin/check-disk.sh', edit: CHECK_DISK }], check: t => strict(t.file('laptop', '/home/dev/bin/check-disk.sh')) },
          { title: 'Make it executable', solution: 'chmod +x ~/bin/check-disk.sh', check: t => exe(t, 'laptop', '/home/dev/bin/check-disk.sh') },
          { allowEarly: true, title: 'With no argument it prints the usage of / and the default threshold 80, and exits 0 (the disk is at 62%)', detail: 'For example: `OK: / is at 62% (threshold 80%)`. Tip: `df / | awk \'NR==2 {print $5}\' | tr -d \'%\'` gives the number.', solution: '~/bin/check-disk.sh; echo "exit $?"', check: t => { const r = t.exec('laptop', '~/bin/check-disk.sh'); return r.code === 0 && /62%/.test(r.out) && /80%?/.test(r.out); } },
          { allowEarly: true, title: 'With a threshold argument below the usage (e.g. 50) it prints a WARNING and exits 1', solution: '~/bin/check-disk.sh 50; echo "exit $?"', check: t => { const a = t.exec('laptop', '~/bin/check-disk.sh 50'), b = t.exec('laptop', '~/bin/check-disk.sh 90'); return a.code === 1 && /warn/i.test(a.out) && b.code === 0; } },
          { allowEarly: true, title: 'A non-numeric argument prints a usage message and exits 2', hint: "`[[ \"$threshold\" =~ ^[0-9]+$ ]]` tests for digits only.", solution: '~/bin/check-disk.sh abc; echo "exit $?"', check: t => { const r = t.exec('laptop', '~/bin/check-disk.sh abc'); return r.code === 2 && /usage/i.test(r.out); } },
          { title: 'Watch it run step by step with `bash -x`', solution: 'bash -x ~/bin/check-disk.sh 50', check: t => t.ran(/bash\s+-x\b.*check-disk/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does `set -euo pipefail` do?', choices: ['Makes the script faster', 'Stops on errors, on unset variables, and when any command in a pipeline fails', 'Enables colours', 'Runs the script as root'], answer: 1, explain: 'It turns silent mistakes into loud failures.' },
        { type: 'predict', q: 'What is printed?', code: '#!/usr/bin/env bash\nport="${1:-8080}"\necho "port=$port"\n\n$ ./s.sh', choices: ['port=', 'port=8080', 'an error', 'port=$1'], answer: 1, explain: '${1:-8080} uses 8080 when $1 is empty or unset.' },
        { type: 'mc', q: 'Why should a check script exit with a non-zero code on failure?', choices: ['To save memory', 'So cron, CI, monitoring and `&&` can react to the failure', 'Bash requires it', 'To print colours'], answer: 1, explain: 'Exit codes are the API between programs.' },
        { type: 'mc', q: 'What is wrong with `name = "Ada"` in bash?', choices: ['Nothing', 'Spaces around = make bash run a command called name', 'Quotes are not allowed', 'It must be uppercase'], answer: 1, explain: 'Assignments have no spaces: name="Ada".' },
        { type: 'multi', q: 'Which are needed to run a script as `./deploy.sh`?', choices: ['A shebang line like #!/usr/bin/env bash', 'The executable bit (chmod +x)', 'Being root', 'The .sh extension'], answer: [0, 1], explain: 'The extension is only a convention.' },
        { type: 'type', q: 'Type the bash expression that captures the output of `date +%F` into a variable called today.', accept: ['today=$(date +%F)', 'today="$(date +%F)"', 'today=`date +%F`'], model: 'today=$(date +%F)', explain: 'Command substitution.' },
      ],
    },
    {
      id: 'conditionals-loops',
      title: 'Conditions, loops and functions',
      summary: '[[ ]] and (( )), if/case, for and while-read loops, functions with local variables, collecting failures.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['files', 'network'],
        setup(H) {
          H.site('status.lumen.example.com', { '*': { body: '{"status":"operational"}\n' } });
          H.site('api.lumen.example.com', { '/v1/health': { body: '{"status":"ok"}\n' } });
          H.site('shop.lumen.example.com', { '*': { body: '<h1>shop</h1>\n' } });
          H.site('admin.lumen.example.com', { '*': { status: 503, body: 'maintenance\n' } });
          H.write('laptop', '~/urls.txt', '# Lumen public endpoints\nhttps://status.lumen.example.com/\nhttps://api.lumen.example.com/v1/health\n\nhttps://shop.lumen.example.com/\nhttps://admin.lumen.example.com/\n', { owner: 'dev' });
        },
        suggestions: ['cat ~/urls.txt', 'nano ~/bin/site-check.sh'],
        tasks: [
          { title: 'Look at `~/urls.txt`: note the comment and the blank line', solution: 'cat ~/urls.txt', check: t => t.ran(/\bcat\b.*urls\.txt/) },
          { allowEarly: true, title: 'Write `~/bin/site-check.sh` (strict mode, executable): for each URL in the file given as `$1` (default `~/urls.txt`), print `OK <code> <url>` or `FAIL <code> <url>`', hint: 'Use `while read -r url; do … done < "$file"` and `curl -s -o /dev/null -m 5 -w "%{http_code}" "$url"`. Add `|| true` so a failed curl does not end the script.', solution: 'mkdir -p ~/bin && nano ~/bin/site-check.sh && chmod +x ~/bin/site-check.sh', test: ['mkdir -p ~/bin', { cmd: 'nano ~/bin/site-check.sh', edit: SITE_CHECK }, 'chmod +x ~/bin/site-check.sh'], check: t => { if (!exe(t, 'laptop', '/home/dev/bin/site-check.sh') || !strict(t.file('laptop', '/home/dev/bin/site-check.sh'))) return false; const r = t.exec('laptop', '~/bin/site-check.sh'); return (r.out.match(/^OK\s+200\s+https:/gm) || []).length === 3 && /^FAIL\s+503\s+https:\/\/admin/m.test(r.out); } },
          { allowEarly: true, title: 'Skip blank lines and lines starting with `#`', solution: 'nano ~/bin/site-check.sh', check: t => { const r = t.exec('laptop', 'printf "# only one\\n\\nhttps://shop.lumen.example.com/\\n" > /tmp/one.txt; ~/bin/site-check.sh /tmp/one.txt'); return (r.out.match(/^(OK|FAIL)\b/gm) || []).length === 1 && /^OK/m.test(r.out); } },
          { allowEarly: true, title: 'Exit 0 when every URL is OK and 1 when any failed', solution: 'nano ~/bin/site-check.sh', check: t => { const good = t.exec('laptop', 'printf "https://shop.lumen.example.com/\\nhttps://api.lumen.example.com/v1/health\\n" > /tmp/good.txt; ~/bin/site-check.sh /tmp/good.txt'); const bad = t.exec('laptop', '~/bin/site-check.sh'); return good.code === 0 && bad.code === 1; } },
          { allowEarly: true, title: 'An unreachable host counts as a failure too (code 000), and does not crash the script', solution: 'nano ~/bin/site-check.sh', check: t => { const r = t.exec('laptop', 'printf "https://nope.lumen.example.com/\\nhttps://shop.lumen.example.com/\\n" > /tmp/mixed.txt; ~/bin/site-check.sh /tmp/mixed.txt'); return r.code === 1 && /^FAIL\s+0*\s*https:\/\/nope/m.test(r.out) && /^OK\s+200\s+https:\/\/shop/m.test(r.out); } },
          { allowEarly: true, title: 'End with a summary line `<N> checked, <M> failed`', solution: 'nano ~/bin/site-check.sh', check: t => /^4 checked, 1 failed$/m.test(t.exec('laptop', '~/bin/site-check.sh').out) },
          { allowEarly: true, title: 'Put the check for one URL into a function called `check_url`', solution: 'nano ~/bin/site-check.sh', check: t => /check_url\s*\(\)\s*\{|function\s+check_url\b/.test(t.file('laptop', '/home/dev/bin/site-check.sh') || '') && /^4 checked, 1 failed$/m.test(t.exec('laptop', '~/bin/site-check.sh').out) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Which loop correctly reads a file line by line, keeping spaces?', choices: ['for line in $(cat file); do …', 'while read -r line; do …; done < file', 'for line in file; do …', 'cat file | for line; do …'], answer: 1, explain: '$(cat file) splits on every space.' },
        { type: 'predict', q: 'What does this print?', code: 'x=7\nif (( x > 5 )); then echo big; else echo small; fi', choices: ['big', 'small', 'an error', '7'], answer: 0, explain: '(( )) is arithmetic.' },
        { type: 'mc', q: 'Your loop checks 50 hosts with `set -e`. One curl fails and the script stops. You wanted to record failures and continue. Fix?', choices: ['Remove set -e entirely', 'Append `|| true` (or handle the result in an if) on the command that may fail', 'Use kill -9', 'Add sleep'], answer: 1, explain: 'Handle the expected failure explicitly.' },
        { type: 'multi', q: 'Which tests are written correctly in bash?', choices: ['[[ -f "$file" ]]', '[[ "$a" == "$b" ]]', '[ $x == y ] with x possibly empty', '[[ -z "$name" ]]'], answer: [0, 1, 3], explain: 'Unquoted empty variables break [ ].' },
        { type: 'mc', q: 'What does `local` do inside a function?', choices: ['Makes the variable exported', 'Limits the variable to the function, so it does not leak into the rest of the script', 'Makes it read-only', 'Stores it on disk'], answer: 1, explain: 'Avoids surprising global side effects.' },
        { type: 'type', q: 'Type a for loop header that iterates over web1 web2 web3 with the variable host (just the first line, up to and including do).', accept: ['for host in web1 web2 web3; do'], model: 'for host in web1 web2 web3; do', explain: 'Then the body, then done.' },
      ],
    },
    {
      id: 'robust-scripts',
      title: 'Robust, idempotent automation',
      summary: 'Guards against empty variables, idempotency, dry runs, trap cleanup, and reviewing an AI-written script.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['files'],
        setup(H) {
          H.server('buildbox', { ip: '10.0.0.70' });
          H.write('laptop', '~/scripts/cleanup-build.sh', AI_CLEANUP, { owner: 'dev', mode: 0o755 });
          H.uni.ai = { rules: [{ id: 'review', when: /review|safe|check/i, reply: ['Looks good to me! The script cleans the build directory with', '    rm -rf $BUILD_DIR/*', 'and sets up the builder user. It is ready to run.'] }] };
        },
        suggestions: ['cat ~/scripts/cleanup-build.sh'],
        tasks: [
          { title: 'Read the AI-generated `~/scripts/cleanup-build.sh`. It will run as root on buildbox', solution: 'cat ~/scripts/cleanup-build.sh', check: t => t.ran(/\b(cat|less|head)\b.*cleanup-build\.sh/) },
          { title: 'Have its riskiest line explained: `ai explain "rm -rf $BUILD_DIR/*"`. What happens when BUILD_DIR is empty?', solution: "ai explain 'rm -rf $BUILD_DIR/*'", check: t => t.events('ai-explain').some(e => /rm\s+-rf/.test(e.cmd) && e.risk === 'HIGH') },
          { allowEarly: true, title: 'Fix it: strict mode, and refuse to run (non-zero exit, nothing deleted) when the directory argument is missing or `/`', hint: '`set -euo pipefail`, `BUILD_DIR="${1:?usage: …}"`, and reject "/" explicitly. Quote every variable.', solution: 'nano ~/scripts/cleanup-build.sh', test: [{ cmd: 'nano ~/scripts/cleanup-build.sh', edit: FIXED_CLEANUP }], check: t => { prepBuildbox(t); const h = t.host('buildbox'); const a = t.exec('buildbox', 'sudo bash /tmp/cleanup-build.sh'); const b = t.exec('buildbox', 'sudo bash /tmp/cleanup-build.sh /'); return a.code !== 0 && b.code !== 0 && intact(h) && h.files.has('/srv/build/out/app.o'); } },
          { allowEarly: true, title: 'Make it idempotent: running it twice on `/srv/build` succeeds both times, with one builder user and one BUILD_CACHE line', hint: '`mkdir -p`, `id builder || useradd builder`, `grep -qs … || echo … >>`.', solution: 'nano ~/scripts/cleanup-build.sh', check: t => { prepBuildbox(t); const h = t.host('buildbox'); const a = t.exec('buildbox', 'sudo bash /tmp/cleanup-build.sh /srv/build'); const b = t.exec('buildbox', 'sudo bash /tmp/cleanup-build.sh /srv/build'); const prof = h.files.get('/etc/profile.d/build.sh') || ''; return a.code === 0 && b.code === 0 && h.users.has('builder') && (prof.match(/BUILD_CACHE=/g) || []).length === 1 && h.isDir('/srv/build/cache') && !h.files.has('/srv/build/out/app.o') && intact(h); } },
          { allowEarly: true, title: 'Add `--dry-run`: print what it would do, change nothing', hint: 'A `run()` helper that echoes the command and only executes it when not in dry-run mode.', solution: 'nano ~/scripts/cleanup-build.sh', check: t => { prepBuildbox(t); const h = t.host('buildbox'); const r = t.exec('buildbox', 'sudo bash /tmp/cleanup-build.sh --dry-run /srv/build'); return r.code === 0 && /rm\b/.test(r.out) && h.files.has('/srv/build/out/app.o') && !h.users.has('builder') && !h.files.has('/etc/profile.d/build.sh'); } },
          { title: 'Ask the assistant to review your fixed version, and notice it is no substitute for testing', solution: 'ai "review cleanup-build.sh, is it safe?"', check: t => t.events('ai-ask').length > 0 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does `rm -rf "${DIR:?}"/*` do when DIR is unset or empty?', choices: ['Deletes everything under /', 'Stops with an error before rm runs', 'Deletes the current folder', 'Nothing, silently'], answer: 1, explain: '${VAR:?} aborts with a message when VAR is empty.' },
        { type: 'mc', q: 'What does idempotent mean for a script?', choices: ['It runs fast', 'Running it twice leaves the system in the same state as running it once', 'It never fails', 'It needs no root'], answer: 1, explain: 'The foundation of Ansible, Terraform and Kubernetes.' },
        { type: 'multi', q: 'Which lines are idempotent?', choices: ['mkdir -p /srv/app', 'id deploy || useradd deploy', 'echo "x=1" >> app.conf', 'grep -q "^x=" app.conf || echo "x=1" >> app.conf'], answer: [0, 1, 3], explain: 'A plain >> appends again every run.' },
        { type: 'mc', q: 'An AI assistant says its script is "safe and ready to run". What do you do?', choices: ['Run it in production', 'Read every line, ask what happens with empty or odd inputs, dry-run it, test it on a scratch machine', 'Ask it again until it says yes', 'Add sudo and run it'], answer: 1, explain: 'A claim is not a test.' },
        { type: 'mc', q: 'What is `trap cleanup EXIT` for?', choices: ['Catching bugs', 'Running cleanup whenever the script exits, success or failure', 'Exiting early', 'Logging'], answer: 1, explain: 'Temp files never linger.' },
        { type: 'tf', q: 'With `set -e`, a failing command inside an `if` condition stops the script.', answer: false, explain: 'Conditions and the left side of && / || are exempt.' },
      ],
    },
    {
      id: 'makefiles',
      title: 'Make: one command per task',
      summary: 'Targets, prerequisites and tab-indented recipes, .PHONY, variables and overrides, $@ and $^, incremental builds by timestamp, make -n, one entry point for people and CI.',
      minutes: 25,
      lab: {
        cwd: '~/notify',
        panels: ['files', 'system'],
        setup(H) {
          H.install('laptop', 'make');
          const f = { 'src/server.js': "const queue = require('./queue');\nqueue.start();\n", 'src/queue.js': 'module.exports = { start() { return true; } };\n', 'package.json': JSON.stringify({ name: 'notify', version: '1.0.0' }, null, 2) + '\n', 'tests/run.sh': '#!/usr/bin/env bash\nset -euo pipefail\ngrep -q "module.exports" src/queue.js\ngrep -q "queue.start" src/server.js\necho "2 tests passed"\n', 'test/fixtures/order.json': '{"id": 1}\n', Makefile: MK_BROKEN };
          for (const [p, txt] of Object.entries(f)) H.write('laptop', `~/notify/${p}`, txt, { owner: 'dev' });
        },
        suggestions: ['make', 'cat -A Makefile | head -8'],
        tasks: [
          { title: 'Run `make` in `~/notify`. It refuses to read the Makefile: find out why (`cat -A` shows tabs as `^I`) and fix it so `make help` works', hint: 'Recipe lines must start with a tab, not spaces.', solution: 'make; cat -A Makefile | head -8; sed -i "s/^    @/\\t@/" Makefile && make help', test: ['make', "sed -i 's/^    @/\\t@/' Makefile", 'make help'], check: t => nexec(t, 'make help').code === 0 && /make test/.test(nexec(t, 'make help').out) },
          { title: '`make test` says there is nothing to do, and the tests never run. Why? Fix the Makefile so `make test` always runs them', hint: 'There is a directory called `test/`. Declare the task targets `.PHONY`.', solution: "sed -i 's/^VERSION ?= 1.0.0$/VERSION ?= 1.0.0\\n\\n.PHONY: help lint test clean/' Makefile && make test", test: ['make test', "sed -i 's/^VERSION ?= 1.0.0$/VERSION ?= 1.0.0\\n\\n.PHONY: help lint test clean/' Makefile", 'make test'], check: t => mkRules(t)?.phony.has('test') && /2 tests passed/.test(nexec(t, 'make test').out) },
          { title: 'Add `build`: package `src/` and `package.json` into `dist/notify-$(VERSION).tar.gz` (VERSION defaults to 1.0.0 and can be overridden), rebuilt only when a source file changes', hint: 'A phony `build` target depends on the file target `dist/notify-$(VERSION).tar.gz`, whose prerequisites are `$(wildcard src/*.js) package.json`; its recipe: `mkdir -p dist` and `tar czf $@ src package.json`.', solution: 'nano Makefile && make build && make build', test: [{ cmd: 'nano Makefile', edit: MK_GOOD }, 'make build', 'make build', 'make build VERSION=1.1.0 && ls dist'], check: t => { const a = nexec(t, 'rm -rf dist && make build'); const b = nexec(t, 'make build'); const v = nexec(t, 'make build VERSION=2.0.0 && ls dist'); return a.code === 0 && /tar /.test(a.out) && !/tar /.test(b.out) && /(up to date|Nothing to be done)/.test(b.out) && /notify-1\.0\.0\.tar\.gz/.test(v.out) && /notify-2\.0\.0\.tar\.gz/.test(v.out); } },
          { title: 'Add `deploy`, which needs `test` and `build` first. Preview it with a dry run before running it', solution: 'make -n deploy && make deploy', check: t => { const r = mkRules(t)?.rules.get('deploy'); return !!r && r.deps.includes('test') && r.deps.includes('build') && t.events('make').some(e => e.dry && e.goals.includes('deploy')) && t.events('make').some(e => !e.dry && e.ok && e.goals.includes('deploy')); } },
          { title: 'See the incremental build at work: `touch` one source file and `make build` again. Only now is the archive rebuilt', solution: 'make build; touch src/queue.js && make build', check: t => { const i = hist(t, /touch\s+.*src\//); const j = hist(t, /make\s+build\b/); const last = t.events('make').filter(e => e.goals.includes('build') && !e.dry).slice(-1)[0]; return i >= 0 && j >= i && !!last?.ran; } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'make prints `Makefile:5: *** missing separator.  Stop.` What is the usual cause?', choices: ['A missing semicolon', 'A recipe line indented with spaces instead of a tab', 'A typo in the target name', 'Missing .PHONY'], answer: 1, explain: 'Recipes must start with a tab.' },
        { type: 'mc', q: 'There is a directory named `test` and `make test` says "\'test\' is up to date". Fix?', choices: ['Rename the directory', 'Declare `.PHONY: test`', 'Use make -B', 'Delete the Makefile'], answer: 1, explain: 'Phony targets are always run; they are not files.' },
        { type: 'mc', q: 'When does make re-run the recipe of a file target?', choices: ['Always', 'When the file is missing or older than one of its prerequisites', 'Only with -f', 'Once a day'], answer: 1, explain: 'That is the incremental build.' },
        { type: 'predict', q: 'What does this print with `make greet NAME=Ada`?', code: 'NAME ?= World\ngreet:\n\t@echo "Hello, $(NAME)"', choices: ['Hello, World', 'Hello, Ada', 'Hello, $(NAME)', 'An error'], answer: 1, explain: 'Command-line variables override ?= defaults.' },
        { type: 'mc', q: 'In a recipe, line 1 is `cd dist` and line 2 is `ls`. What does ls list?', choices: ['dist/', 'The directory make was started in: each recipe line runs in its own shell', 'Nothing', 'An error'], answer: 1, explain: 'Use `cd dist && ls`.' },
        { type: 'mc', q: 'What does `make -n deploy` do?', choices: ['Deploys without tests', 'Prints the commands deploy would run, without running them', 'Runs deploy n times', 'Deletes dist/'], answer: 1, explain: 'A dry run.' },
        { type: 'multi', q: 'Good Makefile habits:', choices: ['A help target first', 'CI runs the same make targets as people do', 'Long logic in recipes instead of scripts', 'Mark non-file targets .PHONY'], answer: [0, 1, 3], explain: 'Keep recipes short; call scripts for anything long.' },
      ],
    },
    {
      id: 'json-apis',
      title: 'APIs with curl and jq',
      summary: 'Bearer tokens, status codes, curl -f -s -S -w, POSTing JSON from a file, jq select/@tsv/--arg/length, following pagination links in a script, retries for flaky endpoints.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['files', 'network'],
        setup(H) {
          H.install('laptop', 'jq');
          incidentApi(H);
          H.write('laptop', '~/.config/lumen/token', API_TOKEN + '\n', { owner: 'dev', mode: 0o600 });
          H.mkdir('laptop', '/home/dev/bin', { owner: 'dev' });
        },
        suggestions: ['curl -s https://api.lumen.dev/v1/incidents', 'TOKEN=$(cat ~/.config/lumen/token)'],
        tasks: [
          { title: 'Call `https://api.lumen.dev/v1/incidents` without a token, then with the bearer token from `~/.config/lumen/token`, and pretty-print the answer with jq', hint: '`TOKEN=$(cat ~/.config/lumen/token)` then `curl -s -H "Authorization: Bearer $TOKEN" https://api.lumen.dev/v1/incidents | jq .`', solution: 'curl -s https://api.lumen.dev/v1/incidents; TOKEN=$(cat ~/.config/lumen/token) && curl -s -H "Authorization: Bearer $TOKEN" https://api.lumen.dev/v1/incidents | jq .', check: t => t.events('http').some(e => /api\.lumen\.dev\/v1\/incidents/.test(e.url) && e.status === 401) && t.events('http').some(e => /api\.lumen\.dev\/v1\/incidents/.test(e.url) && e.status === 200) && t.ran(/\|\s*jq\b/) },
          { title: 'From the first page, print the open incidents as id, severity and title, tab-separated', hint: '`jq -r \'.data[] | select(.state == "open") | [.id, .severity, .title] | @tsv\'`', solution: 'curl -s -H "Authorization: Bearer $TOKEN" https://api.lumen.dev/v1/incidents | jq -r \'.data[] | select(.state == "open") | [.id, .severity, .title] | @tsv\'', test: ['TOKEN=$(cat ~/.config/lumen/token)', 'curl -s -H "Authorization: Bearer $TOKEN" https://api.lumen.dev/v1/incidents | jq -r \'.data[] | select(.state == "open") | [.id, .severity, .title] | @tsv\''], check: t => t.ran(/jq\b.*select\(.*open.*\).*(@tsv|\\t)/) },
          { title: 'Write `~/bin/sev1-count.sh`: it reads the token, follows the `next` links through every page, and prints only the number of **open sev1** incidents', detail: 'The first page alone gives the wrong answer. Make it executable.', hint: 'Loop while `next` is not null: fetch the page, collect `.data[]`, then `url=$(echo "$page" | jq -r .next)`. Count with `jq -s \'map(select(.severity == "sev1" and .state == "open")) | length\'`.', solution: 'nano ~/bin/sev1-count.sh && chmod +x ~/bin/sev1-count.sh && ~/bin/sev1-count.sh', test: [{ cmd: 'nano ~/bin/sev1-count.sh', edit: '#!/usr/bin/env bash\nset -euo pipefail\nTOKEN=$(cat ~/.config/lumen/token)\nurl="/v1/incidents"\nall=""\nwhile [ "$url" != "null" ]; do\n  page=$(curl -fsS -H "Authorization: Bearer $TOKEN" "https://api.lumen.dev$url")\n  all="$all$(echo "$page" | jq -c \'.data[]\')\n"\n  url=$(echo "$page" | jq -r \'.next\')\ndone\necho "$all" | jq -s \'map(select(.severity == "sev1" and .state == "open")) | length\'\n' }, 'chmod +x ~/bin/sev1-count.sh', '~/bin/sev1-count.sh'], check: t => { const r = t.exec('laptop', '~/bin/sev1-count.sh'); return r.code === 0 && r.out.trim() === String(SEV1_OPEN + (t.uni.labData.api?.created || []).filter(x => x.severity === 'sev1').length); } },
          { title: 'Open a new incident: write `incident.json` (title, severity, service), POST it with `-d @incident.json` and a JSON content type, and print only the HTTP status. What does the API answer if a field is missing?', solution: "printf '{\"title\": \"Queue backlog on notify\", \"severity\": \"sev2\", \"service\": \"notify\"}\\n' > incident.json && curl -s -o /dev/null -w '%{http_code}\\n' -X POST -H \"Authorization: Bearer $TOKEN\" -H 'Content-Type: application/json' -d @incident.json https://api.lumen.dev/v1/incidents", test: ["printf '{\"title\": \"Queue backlog on notify\", \"severity\": \"sev2\", \"service\": \"notify\"}\\n' > incident.json", "TOKEN=$(cat ~/.config/lumen/token) && curl -s -o /dev/null -w '%{http_code}\\n' -X POST -H \"Authorization: Bearer $TOKEN\" -H 'Content-Type: application/json' -d @incident.json https://api.lumen.dev/v1/incidents"], check: t => (t.uni.labData.api?.created || []).length > 0 && t.ran(/-d\s+@\S+/) && t.ran(/-w\s+.*http_code/) },
          { title: '`/v1/health` fails now and then (503). Write the check you would put in a script: fail on HTTP errors, but retry up to 3 times first', solution: 'curl -fsS --retry 3 https://api.lumen.dev/v1/health', check: t => t.ran(/curl\b.*(-[a-zA-Z]*f[a-zA-Z]*\b|--fail).*--retry\s+[1-9]|curl\b.*--retry\s+[1-9].*(-[a-zA-Z]*f|--fail)/) && t.events('http').some(e => /\/v1\/health/.test(e.url) && e.status === 200) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'An API answers 401. What is most likely wrong?', choices: ['The server is down', 'The token is missing, expired or in the wrong header', 'The JSON is invalid', 'You need to retry'], answer: 1, explain: '403 would mean authenticated but not allowed.' },
        { type: 'mc', q: 'Why use `curl -f` in scripts?', choices: ['It is faster', 'HTTP errors (4xx/5xx) make curl exit non-zero, so set -e and && stop the script', 'It follows redirects', 'It pretty-prints JSON'], answer: 1, explain: 'Without it, an error page looks like success.' },
        { type: 'predict', q: 'What does this print for `{"data":[{"id":1,"state":"open"},{"id":2,"state":"done"}]}`?', code: "jq -r '.data[] | select(.state == \"open\") | .id'", choices: ['1', '1 2', '[1]', 'open'], answer: 0, explain: 'select keeps matching items; -r prints raw values.' },
        { type: 'mc', q: 'A report counts incidents from `curl …/v1/incidents | jq \'.data | length\'` and always gets 5. Why?', choices: ['jq bug', 'Only the first page is fetched; follow the next links', 'The token is wrong', 'length counts pages'], answer: 1, explain: 'Pagination.' },
        { type: 'mc', q: 'Which is the safest way to send JSON with a user-supplied title?', choices: ['Concatenate strings in bash', 'Build it with jq -n --arg title "$title" \'{title: $title}\' or write a file', 'Put it in the URL', 'Use single quotes around everything'], answer: 1, explain: 'jq escapes quotes and special characters correctly.' },
        { type: 'tf', q: 'Retrying a request on 503 is reasonable; retrying on 400 usually is not.', answer: true, explain: '5xx and 429 are often transient; 4xx means fix the request.' },
        { type: 'type', q: 'Type the jq filter that turns each item of `.data` into a tab-separated line of `.id` and `.title` (use -r).', accept: [".data[] | [.id, .title] | @tsv", ".data[]|[.id,.title]|@tsv", '.data[] | "\\(.id)\\t\\(.title)"'], model: '.data[] | [.id, .title] | @tsv', explain: '@csv works the same way for CSV.' },
      ],
    },
    {
      id: 'testing-scripts',
      title: 'Testing scripts: ShellCheck and bats',
      summary: 'ShellCheck warnings and what they prevent (quoting, cd without a check, parsing ls), bats tests with setup, run, $status and $output, temporary fixtures, a regression test per bug, both in CI.',
      minutes: 30,
      lab: {
        cwd: '~/ops-scripts',
        panels: ['files', 'github'],
        setup(H) {
          H.install('laptop', 'shellcheck', 'bats');
          H.remote('lumen', 'ops-scripts', [{ message: 'Backup rotation script and first tests', files: { 'rotate-backups.sh': ROTATE_V1, 'test/rotate.bats': BATS_V1, 'README.md': '# ops-scripts\n\nScripts the platform team runs from cron. Tests: `bats test/`.\n' } }], { collaborators: ['you'] });
          H.run('git clone -q https://github.com/lumen/ops-scripts.git', { on: 'laptop' });
        },
        suggestions: ['shellcheck rotate-backups.sh', 'bats test/'],
        tasks: [
          { title: 'Run ShellCheck on `rotate-backups.sh` and fix what it reports (quote the variables, check the `cd`, stop parsing `ls`)', hint: 'Quote `"$dir"`, use `cd "$dir" || exit 1`, and instead of `for f in $(ls …)` pipe a glob into a loop: `printf \'%s\\n\' backup-*.tar.gz | sort -r | tail -n +"$keep" | while read -r f; do rm -- "$f"; done`.', solution: 'shellcheck rotate-backups.sh && nano rotate-backups.sh && shellcheck rotate-backups.sh', test: ['shellcheck rotate-backups.sh', { cmd: 'nano rotate-backups.sh', edit: ROTATE_LINTED }, 'shellcheck rotate-backups.sh'], check: t => { const r = t.exec('laptop', 'shellcheck ~/ops-scripts/rotate-backups.sh'); return r.code === 0 && t.events('shellcheck').length > 1; } },
          { title: 'Run the bats tests. One fails: read it, find the off-by-one in the script, and fix it until every test passes', hint: '`tail -n +N` starts printing at line N. To keep KEEP files, delete from line KEEP+1.', solution: 'bats test/ && nano rotate-backups.sh && bats test/', test: ['bats test/', { cmd: 'nano rotate-backups.sh', edit: ROTATE_FIXED }, 'bats test/'], check: t => { const b = batsRun(t); return b.total >= 2 && b.failures === 0; } },
          { title: 'Add the test that would have caught the incident: a file that is not a backup (say `README.txt`) must never be deleted. Run the suite', solution: 'nano test/rotate.bats && bats test/', test: [{ cmd: 'nano test/rotate.bats', edit: BATS_V1 + BATS_EXTRA }, 'bats test/'], check: t => { const b = batsRun(t); return b.total >= 3 && b.failures === 0 && /README|not backups|not a backup/i.test(t.file('laptop', '~/ops-scripts/test/rotate.bats') || ''); } },
          { title: 'Make CI enforce it: a workflow that runs `shellcheck` and `bats` on pull requests. Push your work on a branch, open a pull request, and see the checks pass', hint: 'Install the tools on the runner with `sudo apt-get install -y shellcheck bats`, then run `shellcheck *.sh` and `bats test/`.', solution: 'git switch -c tests && mkdir -p .github/workflows && nano .github/workflows/scripts.yml && git add -A && git commit -m "Fix rotation, tests and CI" && git push -u origin tests && gh pr create --fill', test: ['git switch -c tests', 'mkdir -p .github/workflows', { cmd: 'nano .github/workflows/scripts.yml', edit: SCRIPTS_WF }, 'git add -A && git commit -m "Fix rotation, add tests and CI" && git push -u origin tests && gh pr create --fill'], check: t => (t.remote('lumen/ops-scripts')?.meta.runs || []).some(r => r.event === 'pull_request' && r.conclusion === 'success' && r.jobs.some(j => (j.log || []).some(l => /tests?, 0 failures/.test(l)))) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'ShellCheck warns SC2086 on `rm $file`. What can go wrong?', choices: ['Nothing serious', 'A name with spaces or wildcards splits into several arguments or expands, and rm deletes the wrong files', 'rm becomes slower', 'It is only style'], answer: 1, explain: 'Quote variables: rm -- "$file".' },
        { type: 'mc', q: 'In bats, what does `run cmd` do?', choices: ['Runs cmd in the background', 'Runs cmd, storing its exit code in $status and its output in $output, without failing the test', 'Skips the test', 'Runs cmd as root'], answer: 1, explain: 'Then assert on $status and $output.' },
        { type: 'predict', q: 'There are 10 backup files. How many does this delete?', code: 'ls -1 | sort -r | tail -n +7 | xargs rm', choices: ['3', '4', '6', '7'], answer: 1, explain: 'tail -n +7 starts at line 7: lines 7 to 10, four files. Keeping 7 needs +8.' },
        { type: 'mc', q: 'Where should a test for a backup-rotation script create its files?', choices: ['In the real backup directory', 'In a temporary directory made by mktemp -d in setup', 'In /', 'Nowhere: tests should not create files'], answer: 1, explain: 'Tests must never touch real data.' },
        { type: 'tf', q: 'A bug fix should come with a test that fails before the fix and passes after it.', answer: true, explain: 'That test stops the bug coming back.' },
        { type: 'multi', q: 'What belongs in CI for a repository of shell scripts?', choices: ['shellcheck on every script', 'The bats test suite', 'Running the scripts against production', 'Both on every pull request'], answer: [0, 1, 3], explain: 'CI must not touch production data.' },
      ],
    },
    {
      id: 'scripting-boss',
      title: 'Boss: One command to deploy',
      summary: 'Write deploy.sh: copy, unpack, switch, restart, health-check, and roll back automatically on failure.',
      minutes: 35,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['system', 'files'],
        setup(H) {
          H.server('web1', { ip: '10.0.0.11' });
          H.install('web1', 'nodejs');
          H.user('web1', 'notes', { shell: '/usr/sbin/nologin', noHome: true });
          H.authorize('laptop', 'dev', 'web1', 'ubuntu');
          for (const d of ['/opt/notes', '/opt/notes/releases', '/opt/notes/shared']) H.mkdir('web1', d, { owner: 'notes' });
          for (const [p, c] of Object.entries(JSON.parse(release('2.0.0').slice(4)))) H.write('web1', `/opt/notes/releases/2.0.0/${p}`, c, { owner: 'notes' });
          H.write('web1', '/opt/notes/shared/notes.env', 'PORT=4000\n', { owner: 'notes', mode: 0o600 });
          H.run('cd /opt/notes && sudo -u notes ln -sfn releases/2.0.0 current', { on: 'web1' });
          H.service('web1', 'notes', '[Unit]\nDescription=Lumen notes API\n\n[Service]\nUser=notes\nWorkingDirectory=/opt/notes/current\nEnvironmentFile=/opt/notes/shared/notes.env\nExecStart=/usr/bin/node /opt/notes/current/server.js\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n');
          H.write('laptop', '~/releases/notes-2.1.0.tar.gz', release('2.1.0'), { owner: 'dev' });
          H.write('laptop', '~/releases/notes-2.2.0.tar.gz', release('2.2.0', "if (!process.env.PAYMENTS_KEY) throw new Error('PAYMENTS_KEY is required');"), { owner: 'dev' });
        },
        suggestions: ['ls ~/releases', 'nano ~/deploy.sh'],
        tasks: [
          { allowEarly: true, title: 'Create `~/deploy.sh`: strict mode, executable, and a usage error (non-zero exit) when no version is given', solution: 'nano ~/deploy.sh && chmod +x ~/deploy.sh', test: [{ cmd: 'nano ~/deploy.sh', edit: DEPLOY }, 'chmod +x ~/deploy.sh'], check: t => { if (!exe(t, 'laptop', '/home/dev/deploy.sh') || !strict(t.file('laptop', '/home/dev/deploy.sh'))) return false; const r = t.exec('laptop', '~/deploy.sh'); return r.code !== 0 && /usage/i.test(r.out); } },
          { allowEarly: true, title: 'An unknown version (no tarball) fails early, before touching web1', solution: 'nano ~/deploy.sh', check: t => { resetNotes(t); const r = t.exec('laptop', '~/deploy.sh 9.9.9'); return r.code !== 0 && /releases\/2\.0\.0$/.test(t.linkTarget('web1', '/opt/notes/current') || '') && !t.exists('web1', '/opt/notes/releases/9.9.9'); } },
          { allowEarly: true, title: 'A good release (`./deploy.sh 2.1.0`) goes live: exit 0, `current` → 2.1.0, health reports 2.1.0', solution: 'nano ~/deploy.sh', check: t => { resetNotes(t); const r = t.exec('laptop', '~/deploy.sh 2.1.0'); return r.code === 0 && /releases\/2\.1\.0$/.test(t.linkTarget('web1', '/opt/notes/current') || '') && /"version":"2\.1\.0"/.test(health(t).body || ''); } },
          { allowEarly: true, title: 'A broken release (`./deploy.sh 2.2.0`) is rolled back automatically: non-zero exit, the previous version serves again', hint: 'Remember the previous target with `readlink /opt/notes/current` before switching; after the restart, check `/health` for the new version; if it fails, switch back and restart.', solution: 'nano ~/deploy.sh', check: t => { resetNotes(t); t.exec('laptop', '~/deploy.sh 2.1.0'); const r = t.exec('laptop', '~/deploy.sh 2.2.0'); return r.code !== 0 && /releases\/2\.1\.0$/.test(t.linkTarget('web1', '/opt/notes/current') || '') && t.active('web1', 'notes') && /"version":"2\.1\.0"/.test(health(t).body || ''); } },
          { title: 'Run it yourself for 2.1.0 and read its output', solution: '~/deploy.sh 2.1.0', check: t => t.ran(/(\.\/|~\/|bash\s+~?\/?.*)deploy\.sh\s+2\.1\.0/) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the steps a deploy script should take.', items: ['Validate inputs (version given, artifact exists)', 'Record the current release', 'Copy and unpack the new release', 'Switch the symlink and restart', 'Health-check, and roll back + exit non-zero on failure'], explain: 'Fail early, keep a way back.' },
        { type: 'mc', q: 'Why must a deploy script exit non-zero after an automatic rollback?', choices: ['It does not matter', 'So whoever ran it (a person, a pipeline) knows the deploy failed even though the service is fine again', 'To restart the server', 'To delete the release'], answer: 1, explain: 'A rollback is not a success.' },
        { type: 'mc', q: '`systemctl restart` succeeded, but the app crashes a second later. How should a script detect it?', choices: ['It cannot', 'By checking a health endpoint (and/or `systemctl is-active` after a short wait)', 'By the restart exit code', 'By the tarball size'], answer: 1, explain: 'Starting is not the same as working.' },
        { type: 'tf', q: 'Running your deploy script twice with the same version should be safe.', answer: true, explain: 'Idempotency again: mkdir -p, ln -sfn, restart.' },
        { type: 'mc', q: 'Your deploy script grows to 300 lines with retries, inventories and per-host settings. What next?', choices: ['Keep adding bash', 'Move to purpose-built tools: a CI/CD pipeline, Ansible, containers and an orchestrator', 'Rewrite it in one line', 'Stop deploying'], answer: 1, explain: 'That is where the next realms go.' },
      ],
    },
  ],
};
