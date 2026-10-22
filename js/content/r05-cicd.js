// Realm 5 · CI/CD Pipelines: GitHub Actions on simulated runners that really build,
// pass artifacts, deploy over SSH and smoke-test the lab's servers.

import { parseWorkflow } from '../git/actions.js';

const S = name => '${{ secrets.' + name + ' }}';
const runsOf = (t, owner, file) => (t.remote(owner)?.meta.runs || []).filter(r => !file || r.file === file);
const lastRun = (t, owner, file) => runsOf(t, owner, file)[0] || null;
const wfText = (t, path) => t.file('laptop', path) || '';
const parsed = (t, path) => { const w = parseWorkflow(wfText(t, path)); return w.errors.length ? null : w; };
const remoteFile = (t, owner, path, ref = 'main') => { const b = t.remote(owner); const h = b?.refs['refs/heads/' + ref]; if (!h) return null; const flat = t.world.readTreeFlat(t.world.commit(h).tree); const o = flat.get(path); return o ? t.world.objects.get(o).content : null; };
const mainSha = (t, owner) => t.remote(owner)?.refs['refs/heads/main'];

const LOCK = deps => JSON.stringify({ name: 'app', lockfileVersion: 3, packages: Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v.replace(/^\^/, '') }])) }, null, 2) + '\n';

// ---------- lesson 1: CI ----------
const API_FILES = {
  'package.json': JSON.stringify({ name: 'lumen-api', version: '1.0.0', scripts: { lint: 'eslint src', test: 'jest' }, dependencies: { express: '^4.21.1' } }, null, 2) + '\n',
  'package-lock.json': LOCK({ express: '4.21.1' }),
  'src/index.js': "export const greet = name => `Hello, ${name}`;\n",
  'README.md': '# lumen-api\n',
};
const CI_YML = ['name: CI', 'on:', '  push:', '    branches: [main]', '  pull_request:', 'jobs:', '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', '      - uses: actions/setup-node@v4', '        with:', '          node-version: 20', '      - run: npm ci', '      - run: npm run lint', '      - run: npm test', ''].join('\n');
const ciOk = text => { const w = parseWorkflow(text || ''); if (w.errors.length) return false; const runs = w.jobs.flatMap(j => j.steps.map(s => s.run || '')); const uses = w.jobs.flatMap(j => j.steps.map(s => s.uses || '')); return 'pull_request' in w.triggers && uses.some(u => /^actions\/checkout/.test(u)) && runs.some(r => /npm ci/.test(r)) && runs.some(r => /npm run lint/.test(r)) && runs.some(r => /npm (run )?test/.test(r)); };
const prRuns = (t, owner, head) => { const b = t.remote(owner); const pr = b?.meta.prs.find(p => p.head === head); return pr ? b.meta.runs.filter(r => r.pr === pr.number) : []; };

// ---------- lessons 2-3: build & deliver the events site ----------
const SITE_FILES = {
  'package.json': JSON.stringify({ name: 'events-site', version: '1.0.0', scripts: { build: 'mkdir -p dist && cp -r src/* dist/ && echo "$GITHUB_SHA" > dist/VERSION', test: 'jest' } }, null, 2) + '\n',
  'package-lock.json': LOCK({}),
  'src/index.html': '<h1>Lumen events</h1>\n<p>Tonight: Jazz at the Docks</p>\n',
};
const deployJob = (id, host, { needs = 'build', env = null, smoke } = {}) => [
  `  ${id}:`, `    needs: ${needs}`, ...(env ? [`    environment: ${env}`] : []), '    runs-on: ubuntu-latest', '    steps:',
  '      - uses: actions/download-artifact@v4', '        with:', '          name: site', '          path: dist',
  '      - name: Deploy over SSH', '        env:', `          SSH_KEY: ${S('DEPLOY_KEY')}`, '        run: |',
  '          mkdir -p ~/.ssh', '          echo "$SSH_KEY" > ~/.ssh/id_ed25519', '          chmod 600 ~/.ssh/id_ed25519', `          scp -r dist/* deploy@${host}:/var/www/html/`,
  ...(smoke ? ['      - name: Smoke test', `        run: curl -sf ${smoke}/VERSION | grep -q "$GITHUB_SHA"`] : []),
];
const buildJob = ['  build:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', '      - run: npm ci', '      - run: npm run build', '      - uses: actions/upload-artifact@v4', '        with:', '          name: site', '          path: dist'];
const DELIVER_BUILD = ['name: Deliver', 'on:', '  push:', '    branches: [main]', 'jobs:', ...buildJob, ''].join('\n');
const DELIVER = ['name: Deliver', 'on:', '  push:', '    branches: [main]', 'jobs:', ...buildJob, ...deployJob('deploy-staging', 'staging1'), ''].join('\n');
const DELIVER_SMOKE = ['name: Deliver', 'on:', '  push:', '    branches: [main]', 'jobs:', ...buildJob, ...deployJob('deploy-staging', 'staging1', { smoke: 'http://staging.lumen.example.com' }), ''].join('\n');
const RELEASE = ['name: Release', 'on:', '  push:', "    tags: ['v*']", 'jobs:', ...buildJob, ...deployJob('deploy-production', 'prod1', { env: 'production', smoke: 'http://lumen.example.com' }), ''].join('\n');

function siteServers(H) {
  for (const [n, ip, dns] of [['staging1', '10.0.0.51', 'staging.lumen.example.com'], ['prod1', '10.0.0.52', 'lumen.example.com']]) {
    H.server(n, { ip });
    H.install(n, 'nginx');
    H.dns(dns, n);
  }
  const key = H.deployKey(['staging1', 'prod1']);
  for (const n of ['staging1', 'prod1']) H.run('sudo chown -R deploy:deploy /var/www/html', { on: n });
  return key;
}
const servedVersion = (t, host) => (t.file(host, '/var/www/html/VERSION') || '').trim();

// ---------- lesson 4: blue-green ----------
const apiApp = (version, broken = false) => `const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || 3001;\nconst VERSION = '${version}';\napp.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION }));\napp.get('/checkout', (req, res) => ${broken ? "{ throw new Error('cart.total is undefined'); }" : "res.json({ ok: true })"});\napp.listen(PORT, '127.0.0.1', () => console.log(\`api \${VERSION} on \${PORT}\`));\n`;
const tarball = files => 'TAR1' + JSON.stringify(files);
const apiUnit = (color, port) => `[Unit]\nDescription=Lumen API (${color})\n\n[Service]\nUser=api\nWorkingDirectory=/opt/api/${color}\nEnvironment=PORT=${port}\nExecStart=/usr/bin/node /opt/api/${color}/server.js\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n`;

// ---------- lesson 5: security ----------
const INSECURE = ['name: Deploy', 'on:', '  push:', '    branches: [main]', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', '      - uses: lumen-tools/slack-notify@main', '      - run: npm ci', '      - run: npm test', '      - name: Debug token', '        run: echo "token is $DEPLOY_TOKEN"', '        env:', `          DEPLOY_TOKEN: ${S('DEPLOY_TOKEN')}`, '      - run: echo "deploying"', ''].join('\n');
const SECURE = ['name: Deploy', 'on:', '  push:', '    branches: [main]', 'permissions:', '  contents: read', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683', '      - uses: lumen-tools/slack-notify@8f4b7f84864484a7bf31766abe9204da3cbe65b3', '      - run: npm ci', '      - run: npm audit --audit-level=high', '      - run: npm test', '      - run: echo "deploying"', ''].join('\n');
const SECURE_NO_AUDIT = SECURE.replace('      - run: npm audit --audit-level=high\n', '');

// ---------- boss ----------
const TICKETS_FILES = {
  'package.json': JSON.stringify({ name: 'tickets', version: '1.0.0', scripts: { lint: 'eslint src', test: 'jest', build: 'mkdir -p dist && cp -r src/* dist/ && echo "$GITHUB_SHA" > dist/VERSION' } }, null, 2) + '\n',
  'package-lock.json': LOCK({}),
  'src/index.html': '<h1>Lumen tickets</h1>\n',
};
const BOSS_CI = CI_YML;
const BOSS_DELIVER = DELIVER_SMOKE;
const BOSS_RELEASE = RELEASE;

export default {
  id: 'cicd',
  n: 5,
  title: 'CI/CD Pipelines',
  tagline: 'Continuous integration, artifacts, delivery, release strategies and pipeline security',
  badge: 'Pipeline Builder',
  intro: 'Let machines do the integrating, building and shipping. Build **CI** that gates every pull request, **build once** and promote the same artifact, deliver to **staging and production** with approvals and smoke tests, release with **blue-green** switches and rollbacks, and **secure** the pipeline that holds your keys. The pipelines here run on real simulated runners that SSH into the lab\'s servers.',
  lessons: [
    {
      id: 'ci-pipelines',
      title: 'Continuous integration with GitHub Actions',
      summary: 'Workflows, events, jobs, steps and runners; npm ci; lint and test on every PR; required checks.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['github', 'files'],
        setup(H) {
          H.remote('lumen', 'api', [{ message: 'Create lumen-api', files: API_FILES }], { collaborators: ['you'] });
          H.protect('lumen/api', 'main', { requirePR: true, requiredReviews: 0, requireChecks: true });
        },
        suggestions: ['git clone https://github.com/lumen/api.git && cd api'],
        tasks: [
          { title: 'Clone `lumen/api` and look at its scripts in package.json', solution: 'git clone https://github.com/lumen/api.git && cd api && cat package.json', check: t => !!t.host('laptop').findRepo('/home/dev/api') && t.ran(/cat\b.*package\.json|jq\b.*package\.json/) },
          { title: 'On a branch `ci/setup`, write `.github/workflows/ci.yml`: on pull_request (and push to main), check out, set up Node 20, `npm ci`, `npm run lint`, `npm test`', solution: 'git switch -c ci/setup && mkdir -p .github/workflows && nano .github/workflows/ci.yml', test: ['git switch -c ci/setup && mkdir -p .github/workflows', { cmd: 'nano .github/workflows/ci.yml', edit: CI_YML }], check: t => ciOk(wfText(t, '/home/dev/api/.github/workflows/ci.yml')) },
          { title: 'Commit, push the branch and open a pull request; watch the check run', solution: 'git add .github && git commit -m "ci: lint and test on every PR" && git push -u origin ci/setup && gh pr create --fill', check: t => prRuns(t, 'lumen/api', 'ci/setup').some(r => r.conclusion === 'success') },
          { title: 'Read the run: which steps ran, on what machine?', solution: 'gh run view', check: t => t.ran(/gh\s+(run\s+view|pr\s+checks)/) },
          { title: 'Merge the green PR', solution: 'gh pr merge --squash --delete-branch', check: t => t.remote('lumen/api').meta.prs.some(p => p.head === 'ci/setup' && p.state === 'merged') },
          { title: 'Now break lint: on branch `feat/debug`, add a `console.log` to `src/index.js`, push and open a PR. The check fails', solution: 'git switch main && git pull -q && git switch -c feat/debug && echo \'console.log("debug");\' >> src/index.js && git commit -am "feat: debug output" && git push -u origin feat/debug && gh pr create --fill', check: t => prRuns(t, 'lumen/api', 'feat/debug').some(r => r.conclusion === 'failure') },
          { title: 'Try to merge it, read why GitHub refuses, then fix the code, push, and merge once green', solution: 'gh pr merge --squash', test: ['gh pr merge --squash', 'echo "export const greet = name => `Hello, ${name}`;" > src/index.js && git commit -am "fix: remove debug output" && git push && gh pr merge --squash --delete-branch'], check: t => t.ran(/gh pr merge/) && t.remote('lumen/api').meta.prs.some(p => p.head === 'feat/debug' && p.state === 'merged') && prRuns(t, 'lumen/api', 'feat/debug').some(r => r.conclusion === 'failure') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Two jobs in one workflow have no `needs:`. How do they run?', choices: ['One after the other in file order', 'In parallel, on separate fresh runners', 'On the same runner, sharing files', 'Only the first runs'], answer: 1, explain: 'needs: orders them; artifacts move files between them.' },
        { type: 'mc', q: 'Why use `npm ci` in CI instead of `npm install`?', choices: ['It is shorter', 'It installs exactly the versions in package-lock.json, failing if they disagree with package.json', 'It skips tests', 'It installs globally'], answer: 1, explain: 'Reproducible installs.' },
        { type: 'mc', q: 'What does `actions/checkout` do?', choices: ['Merges the PR', 'Copies the repository at the triggering commit onto the runner', 'Installs Node.js', 'Creates a branch'], answer: 1, explain: 'A runner starts empty.' },
        { type: 'multi', q: 'What makes CI trustworthy?', choices: ['Fast feedback', 'Reliable, non-flaky tests', 'The same commands developers run locally', 'Admins bypassing failed checks when busy'], answer: [0, 1, 2], explain: 'Bypasses teach everyone to ignore red.' },
        { type: 'tf', q: 'Each run: step runs with `bash -e`, so the step fails at the first failing command.', answer: true, explain: 'Just like `set -e` in your scripts.' },
        { type: 'mc', q: 'A required check is red on your PR. What is the right move?', choices: ['Ask an admin to force-merge', 'Read the failing step\'s log, reproduce locally, fix, push', 'Re-run until it passes', 'Delete the workflow'], answer: 1, explain: 'Re-running a real failure wastes time; re-running flakes hides problems.' },
      ],
    },
    {
      id: 'build-artifacts',
      title: 'Build once: artifacts and versions',
      summary: 'One build job, a version stamp, upload/download artifacts between jobs, deploy the same bytes over SSH.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['github', 'network'],
        laptopPackages: ['nodejs', 'npm'],
        setup(H) {
          H.remote('lumen', 'events-site', [{ message: 'Create the events site', files: SITE_FILES }], { collaborators: ['you'] });
          const key = siteServers(H);
          H.secret('lumen/events-site', 'DEPLOY_KEY', key);
        },
        suggestions: ['git clone https://github.com/lumen/events-site.git && cd events-site'],
        tasks: [
          { title: 'Clone `lumen/events-site`, read the build script in package.json, and run `npm run build` locally', solution: 'git clone https://github.com/lumen/events-site.git && cd events-site && cat package.json && npm run build && ls dist', check: t => t.exists('laptop', '/home/dev/events-site/dist/index.html') },
          { title: 'Write `.github/workflows/deliver.yml`: on push to main, a `build` job that checks out, runs `npm ci` and `npm run build`, and uploads `dist` as an artifact named `site`', solution: 'mkdir -p .github/workflows && nano .github/workflows/deliver.yml', test: ['mkdir -p .github/workflows', { cmd: 'nano .github/workflows/deliver.yml', edit: DELIVER_BUILD }], check: t => { const w = parsed(t, '/home/dev/events-site/.github/workflows/deliver.yml'); return !!w && w.jobs.some(j => j.steps.some(s => /upload-artifact/.test(s.uses || '') && s.with?.name === 'site') && j.steps.some(s => /npm run build/.test(s.run || ''))); } },
          { title: 'Add a `deploy-staging` job: `needs: build`, download the `site` artifact, write the `DEPLOY_KEY` secret to `~/.ssh/id_ed25519` and `scp -r dist/* deploy@staging1:/var/www/html/`', hint: 'See the Mental Model lens. The key must be mode 600 or ssh refuses it.', solution: 'nano .github/workflows/deliver.yml', test: [{ cmd: 'nano .github/workflows/deliver.yml', edit: DELIVER }], check: t => { const w = parsed(t, '/home/dev/events-site/.github/workflows/deliver.yml'); const d = w?.jobs.find(j => j.needs.includes('build')); return !!d && d.steps.some(s => /download-artifact/.test(s.uses || '')) && d.steps.some(s => /scp\b.*staging1/.test(s.run || '')); } },
          { title: 'Commit and push to main. When the run is green, staging serves the build, stamped with your commit', solution: 'git add .github && git commit -m "ci: build once and deploy to staging" && git push', check: t => lastRun(t, 'lumen/events-site', 'deliver.yml')?.conclusion === 'success' && servedVersion(t, 'staging1') === mainSha(t, 'lumen/events-site') },
          { title: 'From your laptop, compare what staging serves with your latest commit', solution: 'curl -s http://staging.lumen.example.com/VERSION; git rev-parse HEAD', check: t => t.events('http').some(e => /staging\.lumen\.example\.com\/VERSION/.test(e.url) && e.status === 200) && t.ran(/git\s+(rev-parse|log)/) },
          { title: 'Change the site (edit `src/index.html`), push, and watch staging update to the new commit on its own', solution: 'echo "<p>New: Stand-up Night</p>" >> src/index.html && git commit -am "content: add stand-up night" && git push', check: t => runsOf(t, 'lumen/events-site', 'deliver.yml').filter(r => r.conclusion === 'success').length >= 2 && servedVersion(t, 'staging1') === mainSha(t, 'lumen/events-site') && /Stand-up|stand-up/.test(t.file('staging1', '/var/www/html/index.html') || '') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does "build once, deploy many" mean?', choices: ['Build a new copy for each server', 'Build one artifact in CI and promote those exact bytes through every environment', 'Never rebuild after a bug fix', 'Build on the production server'], answer: 1, explain: 'Staging and production then run the same thing.' },
        { type: 'mc', q: 'A deploy job needs the build job\'s `dist/`. How does it get it?', choices: ['It is already there: jobs share disks', 'The build job uploads it as an artifact; the deploy job (with needs: build) downloads it', 'Through the cache', 'It rebuilds it'], answer: 1, explain: 'Each job starts on a fresh runner.' },
        { type: 'mc', q: 'Why stamp the build with the commit SHA?', choices: ['Decoration', 'So you can tell exactly which commit any environment runs', 'Git requires it', 'To make the build slower'], answer: 1, explain: 'curl /VERSION answers "what is live?".' },
        { type: 'mc', q: 'Cache vs artifact:', choices: ['Same thing', 'A cache speeds up repeated work (dependencies); an artifact is the product you deploy', 'Artifacts are faster caches', 'Caches are deployed'], answer: 1, explain: 'Do not deploy from a cache.' },
        { type: 'tf', q: 'Running `npm run build` on the production server during deploy is a good way to ensure the latest dependencies.', answer: false, explain: 'That is exactly how staging and production drift apart.' },
        { type: 'type', q: 'In a workflow step, which environment variable holds the commit SHA being built?', accept: ['GITHUB_SHA', '$GITHUB_SHA'], model: 'GITHUB_SHA', explain: 'Also available as ${{ github.sha }}.' },
      ],
    },
    {
      id: 'cd-environments',
      title: 'Continuous delivery: staging, production, approvals',
      summary: 'Smoke tests, tag-triggered production releases, protected environments and approvals.',
      minutes: 28,
      lab: {
        cwd: '~',
        panels: ['github', 'network'],
        setup(H) {
          H.remote('lumen', 'events-site', [{ message: 'Create the events site', files: SITE_FILES }, { message: 'ci: build once and deploy to staging', files: { '.github/workflows/deliver.yml': DELIVER } }], { collaborators: ['you'] });
          const key = siteServers(H);
          H.secret('lumen/events-site', 'DEPLOY_KEY', key);
          H.environment('lumen/events-site', 'production', { url: 'http://lumen.example.com', reviewers: ['you'], branches: [], tags: ['v*'] });
          H.bare('lumen/events-site').meta.runs.length = 0;
        },
        suggestions: ['git clone https://github.com/lumen/events-site.git && cd events-site'],
        tasks: [
          { title: 'Clone the repo and read the existing `deliver.yml`', solution: 'git clone https://github.com/lumen/events-site.git && cd events-site && cat .github/workflows/deliver.yml', check: t => t.ran(/cat\b.*deliver\.yml|less\b.*deliver\.yml/) },
          { title: 'Add a smoke test after the staging deploy: `curl -sf http://staging.lumen.example.com/VERSION | grep -q "$GITHUB_SHA"`. Push and watch it pass', solution: 'nano .github/workflows/deliver.yml', test: [{ cmd: 'nano .github/workflows/deliver.yml', edit: DELIVER_SMOKE }, 'git commit -am "ci: smoke test staging" && git push'], check: t => /curl\s+-[a-z]*f[a-z]*\s+.*staging\.lumen\.example\.com/.test(remoteFile(t, 'lumen/events-site', '.github/workflows/deliver.yml') || '') && lastRun(t, 'lumen/events-site', 'deliver.yml')?.conclusion === 'success' },
          { title: 'Create `.github/workflows/release.yml`: on tags `v*`, build, then `deploy-production` with `environment: production` to prod1, plus a smoke test on lumen.example.com', solution: 'nano .github/workflows/release.yml', test: [{ cmd: 'nano .github/workflows/release.yml', edit: RELEASE }], check: t => { const w = parsed(t, '/home/dev/events-site/.github/workflows/release.yml'); const tags = [].concat(w?.triggers.push?.tags || []); const d = w?.jobs.find(j => j.environment?.name === 'production'); return !!d && tags.some(x => /^v\*/.test(x)) && d.steps.some(s => /prod1/.test(s.run || '')) && d.steps.some(s => /curl\s+-[a-z]*f/.test(s.run || '')); } },
          { title: 'Commit and push it, then tag `v1.0.0` (annotated) and push the tag', solution: 'git add .github && git commit -m "ci: release tags to production" && git push && git tag -a v1.0.0 -m "Release 1.0.0" && git push origin v1.0.0', check: t => runsOf(t, 'lumen/events-site', 'release.yml').some(r => r.branch === 'v1.0.0' && r.status === 'waiting') },
          { title: 'The release waits for you. Approve it in the GitHub tab (Actions → Review deployments)', solution: 'Click "Approve and deploy" in the GitHub tab', test: [{ act: H => H.approve('lumen/events-site'), label: 'Approve and deploy' }], check: t => runsOf(t, 'lumen/events-site', 'release.yml').some(r => r.branch === 'v1.0.0' && r.conclusion === 'success') && servedVersion(t, 'prod1') === t.world.peel(t.remote('lumen/events-site').refs['refs/tags/v1.0.0']) },
          { title: 'Confirm from your laptop: production serves the tagged commit', solution: 'curl -s http://lumen.example.com/VERSION; git rev-parse v1.0.0^{commit}', check: t => t.events('http').some(e => e.host === 'laptop' && /\/\/lumen\.example\.com\/VERSION/.test(e.url) && e.status === 200) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Continuous delivery vs continuous deployment?', choices: ['Same thing', 'Delivery: always releasable, a deliberate step releases. Deployment: every green change goes to production automatically', 'Delivery is only for staging', 'Deployment needs no tests'], answer: 1, explain: 'Both automate the path; they differ in the last gate.' },
        { type: 'multi', q: 'What can a protected environment enforce?', choices: ['Required reviewers', 'Which branches or tags may deploy', 'Environment-specific secrets', 'That the code is bug-free'], answer: [0, 1, 2], explain: 'It controls who and what, not correctness.' },
        { type: 'mc', q: 'Why run a smoke test after every deploy?', choices: ['To make pipelines slower', 'A green deploy job only proves the commands ran; the smoke test proves the site works', 'GitHub requires it', 'To warm the cache'], answer: 1, explain: 'curl -f fails on HTTP errors.' },
        { type: 'mc', q: 'Which trigger starts a workflow when you push the tag v2.3.0?', choices: ["on: push: branches: ['v*']", "on: push: tags: ['v*']", 'on: release_tag', 'on: pull_request'], answer: 1, explain: 'Tag pushes are push events with refs/tags/.' },
        { type: 'tf', q: 'Staging and production should share the same deploy key, to keep things simple.', answer: false, explain: 'Separate credentials per environment limit the blast radius.' },
        { type: 'order', q: 'Order a tag-driven production release.', items: ['git tag -a v1.0.0 && git push origin v1.0.0', 'The pipeline builds and tests that commit', 'A reviewer approves the production environment', 'The artifact is deployed to production', 'A smoke test confirms it works'], explain: 'Each step gates the next.' },
      ],
    },
    {
      id: 'release-strategies',
      title: 'Release strategies and rollback',
      summary: 'Recreate, rolling, blue-green, canary and feature flags; a hands-on blue-green switch and rollback.',
      minutes: 24,
      lab: {
        cwd: '~',
        panels: ['system', 'network'],
        setup(H) {
          H.server('api1', { ip: '10.0.0.60' });
          H.install('api1', 'nodejs', 'nginx');
          H.user('api1', 'api', { shell: '/usr/sbin/nologin', noHome: true });
          H.authorize('laptop', 'dev', 'api1', 'ubuntu');
          for (const c of ['blue', 'green']) {
            H.mkdir('api1', `/opt/api/${c}/node_modules/express`, { owner: 'api' });
            H.write('api1', `/opt/api/${c}/server.js`, apiApp('1.4.0'), { owner: 'api' });
          }
          H.service('api1', 'api-blue', apiUnit('blue', 3001));
          H.service('api1', 'api-green', apiUnit('green', 3002));
          H.write('api1', '/etc/nginx/conf.d/live.conf', '# which colour receives traffic\nupstream api_live {\n    server 127.0.0.1:3001;\n}\n');
          H.write('api1', '/etc/nginx/sites-available/api', 'server {\n    listen 80;\n    server_name api.lumen.example.com;\n    location / {\n        proxy_pass http://api_live;\n    }\n}\n');
          H.run('sudo ln -s /etc/nginx/sites-available/api /etc/nginx/sites-enabled/api && sudo rm /etc/nginx/sites-enabled/default && sudo systemctl reload nginx', { on: 'api1' });
          H.dns('api.lumen.example.com', 'api1');
          H.write('laptop', '~/releases/api-1.5.0.tar.gz', tarball({ 'server.js': apiApp('1.5.0', true), 'node_modules/express/package.json': '{"name":"express"}\n' }), { owner: 'dev' });
        },
        suggestions: ['curl -s http://api.lumen.example.com/health', 'ssh ubuntu@api1'],
        tasks: [
          { title: 'Check which version users get: `curl -s http://api.lumen.example.com/health`', solution: 'curl -s http://api.lumen.example.com/health', check: t => t.events('http').some(e => /api\.lumen\.example\.com\/health/.test(e.url) && e.status === 200) },
          { title: 'On api1, find out which colour is live (look at `/etc/nginx/conf.d/live.conf` and both health endpoints)', solution: 'ssh ubuntu@api1 "cat /etc/nginx/conf.d/live.conf; curl -s localhost:3001/health; curl -s localhost:3002/health"', check: t => t.ran(/live\.conf/) },
          { title: 'Deploy 1.5.0 to green only: copy the tarball, unpack it into `/opt/api/green` as user `api`, restart `api-green`, check port 3002', solution: 'scp ~/releases/api-1.5.0.tar.gz ubuntu@api1:/tmp/ && ssh ubuntu@api1 "sudo -u api tar -xzf /tmp/api-1.5.0.tar.gz -C /opt/api/green && sudo systemctl restart api-green && curl -s localhost:3002/health"', check: t => /"version":"1\.5\.0"/.test(t.http('api1', 'http://localhost:3002/health').body || '') && /"version":"1\.4\.0"/.test(t.http('laptop', 'http://api.lumen.example.com/health').body || '') },
          { title: 'Switch traffic to green: point the upstream at 3002, test nginx, reload. Users now get 1.5.0', solution: "ssh ubuntu@api1 \"sudo sed -i 's/127.0.0.1:3001/127.0.0.1:3002/' /etc/nginx/conf.d/live.conf && sudo nginx -t && sudo systemctl reload nginx\"", check: t => /"version":"1\.5\.0"/.test(t.http('laptop', 'http://api.lumen.example.com/health').body || '') },
          { title: 'Support reports failed checkouts. Reproduce it: `curl -i http://api.lumen.example.com/checkout`', solution: 'curl -i http://api.lumen.example.com/checkout', check: t => t.events('http').some(e => /api\.lumen\.example\.com\/checkout/.test(e.url) && e.status === 500) },
          { title: 'Roll back in one step: switch the upstream back to blue (3001) and reload', solution: "ssh ubuntu@api1 \"sudo sed -i 's/127.0.0.1:3002/127.0.0.1:3001/' /etc/nginx/conf.d/live.conf && sudo nginx -t && sudo systemctl reload nginx\"", check: t => /"version":"1\.4\.0"/.test(t.http('laptop', 'http://api.lumen.example.com/health').body || '') && t.http('laptop', 'http://api.lumen.example.com/checkout').status === 200 && t.after(e => e.type === 'http' && /checkout/.test(e.url) && e.status === 500, e => e.type === 'nginx-test' || e.type === 'ssh') },
          { title: 'Green still runs 1.5.0, so you can debug it without affecting users: read its log', solution: 'ssh ubuntu@api1 "journalctl -u api-green -n 20"', check: t => t.ran(/journalctl\b.*api-green/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What is the main benefit of blue-green deployment?', choices: ['It needs no extra servers', 'Switching (and switching back) all traffic is one quick step, and the new version is fully up before users see it', 'It removes the need for tests', 'It makes the database faster'], answer: 1, explain: 'Rollback = switch back.' },
        { type: 'mc', q: 'A canary release sends 5% of traffic to the new version. What must you have?', choices: ['A bigger server', 'Metrics (error rate, latency) to compare canary and baseline, and a way to stop the rollout', 'Two databases', 'Manual testers'], answer: 1, explain: 'Without metrics, it is just a smaller outage.' },
        { type: 'mc', q: 'What do feature flags separate?', choices: ['Code and tests', 'Deploying code from releasing a feature to users', 'Frontend and backend', 'Staging and production'], answer: 1, explain: 'Ship dark, turn on later.' },
        { type: 'multi', q: 'Which releases avoid downtime?', choices: ['Rolling updates behind a load balancer', 'Blue-green switch', 'Canary', 'Stop the old version, then start the new one'], answer: [0, 1, 2], explain: 'Recreate means downtime.' },
        { type: 'mc', q: 'Why can a database migration break blue-green rollbacks?', choices: ['It cannot', 'If the new schema is incompatible with the old version, switching back leaves the old code facing a schema it cannot read', 'Databases do not support blue-green', 'Migrations delete nginx config'], answer: 1, explain: 'Expand, migrate, contract: keep both versions compatible.' },
        { type: 'tf', q: 'After a bad release, you should first restore service (roll back), then debug the new version calmly.', answer: true, explain: 'Mitigate, then remediate.' },
      ],
    },
    {
      id: 'pipeline-security',
      title: 'Securing the pipeline',
      summary: 'Secrets in logs, pinning actions to SHAs, least-privilege permissions, dependency audits that block releases.',
      minutes: 24,
      lab: {
        cwd: '~',
        panels: ['github', 'files'],
        laptopPackages: ['nodejs', 'npm'],
        setup(H) {
          const pkg = JSON.stringify({ name: 'web', version: '1.0.0', scripts: { test: 'jest' }, dependencies: { lodash: '^4.17.15', express: '^4.21.1' } }, null, 2) + '\n';
          H.remote('lumen', 'web', [{ message: 'Create web', files: { 'package.json': pkg, 'package-lock.json': LOCK({ lodash: '4.17.15', express: '4.21.1' }), 'index.js': 'module.exports = {};\n', '.github/workflows/deploy.yml': INSECURE } }], { collaborators: ['you'] });
          H.secret('lumen/web', 'DEPLOY_TOKEN', 'dt_live_8a71c0ffee');
          H.teammate('lumen/web', { message: 'docs: readme', files: { 'README.md': '# web\n' }, author: { name: 'Priya Sharma', email: 'priya@example.com' } });
        },
        suggestions: ['git clone https://github.com/lumen/web.git && cd web', 'gh run view'],
        tasks: [
          { title: 'Clone `lumen/web`, read the workflow, and look at the latest run\'s log with `gh run view`', solution: 'git clone https://github.com/lumen/web.git && cd web && cat .github/workflows/deploy.yml && gh run view', check: t => t.ran(/gh run view/) && t.ran(/deploy\.yml/) },
          { title: 'Remove the "Debug token" step: secrets must never be printed, masked or not', solution: 'nano .github/workflows/deploy.yml', test: [{ cmd: 'nano .github/workflows/deploy.yml', edit: c => c.replace(/      - name: Debug token\n[\s\S]*?(?=      - run: echo "deploying")/, '') }], check: t => { const f = wfText(t, '/home/dev/web/.github/workflows/deploy.yml'); return !!f && !/echo[^\n]*\$\{?DEPLOY_TOKEN|echo[^\n]*secrets\./.test(f) && !!parsed(t, '/home/dev/web/.github/workflows/deploy.yml'); } },
          { title: 'Pin both actions to full 40-character commit SHAs instead of tags or branches', detail: 'Use `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2) and `lumen-tools/slack-notify@8f4b7f84864484a7bf31766abe9204da3cbe65b3`.', solution: 'nano .github/workflows/deploy.yml', test: [{ cmd: 'nano .github/workflows/deploy.yml', edit: c => c.replace('actions/checkout@v4', 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683').replace('lumen-tools/slack-notify@main', 'lumen-tools/slack-notify@8f4b7f84864484a7bf31766abe9204da3cbe65b3') }], check: t => { const w = parsed(t, '/home/dev/web/.github/workflows/deploy.yml'); const uses = (w?.jobs || []).flatMap(j => j.steps.map(s => s.uses).filter(Boolean)); return uses.length >= 2 && uses.every(u => /@[0-9a-f]{40}$/.test(u)); } },
          { title: 'Make the token read-only by default: add `permissions:` with `contents: read` at the top level', solution: 'nano .github/workflows/deploy.yml', test: [{ cmd: 'nano .github/workflows/deploy.yml', edit: SECURE_NO_AUDIT }], check: t => /^permissions:\s*\n\s+contents:\s*read\b/m.test(wfText(t, '/home/dev/web/.github/workflows/deploy.yml')) },
          { title: 'Add a dependency audit step before the tests: `npm audit --audit-level=high`. Commit, push, and see what it finds', solution: 'nano .github/workflows/deploy.yml', test: [{ cmd: 'nano .github/workflows/deploy.yml', edit: SECURE }, 'git commit -am "ci: harden the deploy workflow" && git push'], check: t => /npm audit --audit-level=high/.test(remoteFile(t, 'lumen/web', '.github/workflows/deploy.yml') || '') && lastRun(t, 'lumen/web', 'deploy.yml')?.conclusion === 'failure' && lastRun(t, 'lumen/web', 'deploy.yml').jobs.some(j => j.log.some(l => /lodash/.test(l))) },
          { title: 'Fix the vulnerable dependency (update lodash to 4.17.21), push, and get the pipeline green', hint: '`npm install lodash@4.17.21` updates package.json; commit both package files.', solution: 'npm install lodash@4.17.21 && git commit -am "fix(deps): lodash 4.17.21" && git push', check: t => lastRun(t, 'lumen/web', 'deploy.yml')?.conclusion === 'success' && /lodash"?\s*:\s*"\^?4\.17\.21/.test(remoteFile(t, 'lumen/web', 'package.json') || '') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why pin third-party actions to a full commit SHA?', choices: ['It is faster', 'A tag or branch can be moved to malicious code; a commit SHA cannot change', 'GitHub requires it', 'SHAs are shorter'], answer: 1, explain: 'The tj-actions compromise moved tags.' },
        { type: 'mc', q: 'What does `permissions: contents: read` do?', choices: ['Hides the repository', 'Limits the workflow\'s GITHUB_TOKEN to reading the repository', 'Makes secrets read-only', 'Blocks pull requests'], answer: 1, explain: 'Grant write access only to jobs that need it.' },
        { type: 'mc', q: 'GitHub masks secret values in logs. Why is `echo $SECRET` still a bad idea?', choices: ['It is not', 'Masking misses transformed values (base64, substrings) and builds bad habits', 'echo is slow', 'It breaks YAML'], answer: 1, explain: 'Never print secrets.' },
        { type: 'mc', q: 'What does OIDC give a pipeline deploying to a cloud?', choices: ['Faster builds', 'Short-lived credentials minted per run, so no long-lived cloud keys are stored as secrets', 'Free cloud credits', 'A VPN'], answer: 1, explain: 'Nothing to leak, nothing to rotate.' },
        { type: 'multi', q: 'Which protect the pipeline itself?', choices: ['Require review for changes to .github/workflows (CODEOWNERS)', 'Protected main branch', 'Few, well-known, pinned actions', 'Letting fork PRs read deploy secrets'], answer: [0, 1, 2], explain: 'Untrusted code must not get secrets.' },
        { type: 'type', q: 'Type the npm command that fails only when high or critical vulnerabilities are found.', accept: ['npm audit --audit-level=high', 'npm audit --audit-level high'], model: 'npm audit --audit-level=high', explain: 'Decide which severity blocks a release.' },
      ],
    },
    {
      id: 'cicd-boss',
      title: 'Boss: Pipeline from scratch',
      summary: 'PR checks, build once, staging on main with a smoke test, production on tags with approval, end to end.',
      minutes: 40,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['github', 'network'],
        setup(H) {
          H.remote('lumen', 'tickets', [{ message: 'Create tickets', files: TICKETS_FILES }], { collaborators: ['you'] });
          H.protect('lumen/tickets', 'main', { requirePR: true, requiredReviews: 0, requireChecks: true });
          const key = siteServers(H);
          H.secret('lumen/tickets', 'DEPLOY_KEY', key);
          H.environment('lumen/tickets', 'production', { url: 'http://lumen.example.com', reviewers: ['you'], branches: [], tags: ['v*'] });
        },
        suggestions: ['git clone https://github.com/lumen/tickets.git && cd tickets'],
        tasks: [
          { title: 'Clone `lumen/tickets` and create a branch `ci/pipeline`', solution: 'git clone https://github.com/lumen/tickets.git && cd tickets && git switch -c ci/pipeline', check: t => !!t.host('laptop').findRepo('/home/dev/tickets') && t.sh.repo?.HEAD === 'ref: refs/heads/ci/pipeline' },
          { title: 'Add `ci.yml`: lint and test on pull requests', solution: 'mkdir -p .github/workflows && nano .github/workflows/ci.yml', test: ['mkdir -p .github/workflows', { cmd: 'nano .github/workflows/ci.yml', edit: BOSS_CI }], check: t => ciOk(wfText(t, '/home/dev/tickets/.github/workflows/ci.yml')) },
          { title: 'Add `deliver.yml`: on push to main, build once, upload `site`, deploy it to staging1 over SSH, smoke-test staging', solution: 'nano .github/workflows/deliver.yml', test: [{ cmd: 'nano .github/workflows/deliver.yml', edit: BOSS_DELIVER }], check: t => { const w = parsed(t, '/home/dev/tickets/.github/workflows/deliver.yml'); const d = w?.jobs.find(j => j.needs.length); return !!d && d.steps.some(s => /staging1/.test(s.run || '')) && d.steps.some(s => /curl\s+-[a-z]*f/.test(s.run || '')) && w.jobs.some(j => j.steps.some(s => /upload-artifact/.test(s.uses || ''))); } },
          { title: 'Add `release.yml`: on `v*` tags, build, deploy to prod1 through the protected `production` environment, smoke-test', solution: 'nano .github/workflows/release.yml', test: [{ cmd: 'nano .github/workflows/release.yml', edit: BOSS_RELEASE }], check: t => { const w = parsed(t, '/home/dev/tickets/.github/workflows/release.yml'); return !!w && [].concat(w.triggers.push?.tags || []).some(x => /^v\*/.test(x)) && w.jobs.some(j => j.environment?.name === 'production' && j.steps.some(s => /prod1/.test(s.run || ''))); } },
          { title: 'Push the branch, open a PR, and merge it once the check is green', solution: 'git add .github && git commit -m "ci: full delivery pipeline" && git push -u origin ci/pipeline && gh pr create --fill && gh pr merge --squash --delete-branch', check: t => t.remote('lumen/tickets').meta.prs.some(p => p.head === 'ci/pipeline' && p.state === 'merged') && prRuns(t, 'lumen/tickets', 'ci/pipeline').some(r => r.conclusion === 'success') },
          { title: 'The merge to main deployed staging: verify that staging serves main\'s commit', solution: 'git switch main && git pull -q && curl -s http://staging.lumen.example.com/VERSION && git rev-parse HEAD', check: t => servedVersion(t, 'staging1') === mainSha(t, 'lumen/tickets') && t.events('http').some(e => e.host === 'laptop' && /staging\.lumen\.example\.com/.test(e.url) && e.status === 200) },
          { title: 'Release `v1.0.0` (annotated tag on main), approve it, and confirm production serves it', solution: 'git tag -a v1.0.0 -m "Release 1.0.0" && git push origin v1.0.0', test: ['git tag -a v1.0.0 -m "Release 1.0.0" && git push origin v1.0.0', { act: H => H.approve('lumen/tickets'), label: 'Approve and deploy' }, 'curl -s http://lumen.example.com/VERSION'], check: t => servedVersion(t, 'prod1') === t.world.peel(t.remote('lumen/tickets').refs['refs/tags/v1.0.0'] || '') && t.events('http').some(e => /\/\/lumen\.example\.com\/VERSION/.test(e.url) && e.status === 200) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the stages of the pipeline you built.', items: ['Pull request: lint + test (required)', 'Merge to main', 'Build once and upload the artifact', 'Deploy to staging and smoke test', 'Tag v*, approve, deploy the same build to production, smoke test'], explain: 'Each gate earns more confidence.' },
        { type: 'mc', q: 'Production shows a different commit than the tag you approved. What is the most likely design flaw?', choices: ['DNS', 'Production rebuilt from a branch instead of deploying the artifact for the tagged commit', 'The smoke test', 'The approval'], answer: 1, explain: 'Build once, deploy the same bytes.' },
        { type: 'multi', q: 'Which belong in a mature delivery pipeline?', choices: ['Required PR checks', 'Version-stamped artifacts', 'Environment approvals for production', 'Smoke tests and a one-step rollback', 'SSH into prod to hot-fix files'], answer: [0, 1, 2, 3], explain: 'Manual hot-fixes bypass every gate.' },
        { type: 'tf', q: 'A green pipeline means the change is correct.', answer: false, explain: 'It means every check you wrote passed. Observability (next realms) catches the rest.' },
        { type: 'mc', q: 'Which DORA metric does a one-step rollback improve most?', choices: ['Deployment frequency', 'Time to restore service', 'Lead time', 'Lines of code'], answer: 1, explain: 'Fast recovery.' },
      ],
    },
  ],
};
