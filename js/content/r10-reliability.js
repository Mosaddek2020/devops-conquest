// Realm 10 · Reliability & Incident Response: redundancy behind nginx, load tests with
// ab, incidents with roles and a status page, runbooks graded by running them, blameless
// postmortems, PostgreSQL backups to S3 with a real restore, and game days.

import { incidentStore } from '../sim/reliability.js';
import { installCloud } from '../sim/cloud.js';

const SHOP = ["const express = require('express');", 'const app = express();', 'const PORT = process.env.PORT || 3000;', "if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');", "app.get('/', (req, res) => res.send('Lumen shop (served by ' + process.env.HOSTNAME + ')'));", "app.get('/health', (req, res) => res.json({ status: 'ok' }));", 'app.listen(PORT, () => console.log(`shop listening on ${PORT}`));', ''].join('\n');
const ENV = 'PORT=3000\nDATABASE_URL=postgres://shop@db1:5432/shop\n';
const unit = w => `[Unit]\nDescription=Lumen shop\nAfter=network.target\n\n[Service]\nUser=ubuntu\nWorkingDirectory=/opt/shop\nEnvironmentFile=/etc/shop/shop.env\nEnvironment=HOSTNAME=${w}\nExecStart=/usr/bin/node server.js\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n`;
const SINGLE = 'server {\n    listen 80;\n    server_name shop.lumen.dev;\n\n    location / {\n        proxy_pass http://web1:3000;\n    }\n}\n';
const UPSTREAM = 'upstream shop {\n    server web1:3000;\n    server web2:3000;\n}\n\nserver {\n    listen 80;\n    server_name shop.lumen.dev;\n\n    location / {\n        proxy_pass http://shop;\n    }\n}\n';

export function relWorld(H, { lb = UPSTREAM, db = false, orders = 0, cloud = false } = {}) {
  for (const w of ['web1', 'web2']) {
    H.server(w, { packages: ['nodejs'] });
    H.authorize('laptop', 'dev', w, 'ubuntu');
    H.mkdir(w, '/opt/shop/node_modules/express', { owner: 'ubuntu' });
    H.write(w, '/opt/shop/server.js', SHOP, { owner: 'ubuntu' });
    H.write(w, '/etc/shop/shop.env', ENV);
    H.write(w, '/etc/shop/shop.env.bak', ENV);
    H.service(w, 'shop', unit(w));
  }
  H.server('lb', { packages: ['nginx'], fqdn: ['shop.lumen.dev'] });
  H.authorize('laptop', 'dev', 'lb', 'ubuntu');
  H.write('lb', '/etc/nginx/sites-available/default', lb);
  H.write('lb', '/etc/nginx/sites-enabled/default', lb);
  H.run('sudo systemctl reload nginx', { on: 'lb' });
  H.install('laptop', 'apache2-utils');
  if (cloud) { installCloud(H.uni); H.clickops(c => { c.buckets.set('lumen-backups', { objects: new Map() }); c.put('aws_s3_bucket', { id: 'lumen-backups', bucket: 'lumen-backups', arn: 'arn:aws:s3:::lumen-backups', created: H.uni.time - 86400 * 200, tags: {}, force_destroy: false }); }); }
  if (db) {
    H.server('db1', { packages: ['postgresql', ...(cloud ? ['awscli'] : [])] });
    H.authorize('laptop', 'dev', 'db1', 'ubuntu');
    if (orders) H.run(`sudo -u postgres psql -c "CREATE TABLE orders (id int, item text); INSERT INTO orders VALUES ${Array.from({ length: orders }, (_, i) => `(${i + 1}, 'order ${i + 1}')`).join(', ')}"`, { on: 'db1' });
    if (cloud) for (const home of ['/home/ubuntu', '/root']) { H.write('db1', `${home}/.aws/credentials`, '[default]\naws_access_key_id = AKIAZ3EXAMPLEDB1\naws_secret_access_key = Z9xEXAMPLEdb1backupKey\n', { owner: home === '/root' ? 'root' : 'ubuntu', mode: 0o600 }); H.write('db1', `${home}/.aws/config`, '[default]\nregion = eu-west-1\n', { owner: home === '/root' ? 'root' : 'ubuntu' }); }
  }
}
const ordersCount = t => { const r = t.exec('db1', 'sudo -u postgres psql -c "SELECT count(*) FROM orders"', { user: 'ubuntu' }); const m = r.out.match(/^\s+(\d+)\s*$/m); return m ? Number(m[1]) : -1; };
const loads = t => t.events('loadtest').filter(e => /shop\.lumen\.dev/.test(e.url));
const clean = e => !!e && e.failed === 0 && e.non2xx === 0 && e.n >= 50;
export const inc = t => (t.uni.incidents?.list || []).slice(-1)[0] || null;
const file = (t, p) => t.file('laptop', p) || '';
const servedBy = t => { const seen = new Set(); for (let i = 0; i < 4; i++) { const r = t.http('laptop', 'http://shop.lumen.dev/'); const m = String(r.body || '').match(/served by (\w+)/); if (m) seen.add(m[1]); } return seen; };

const PM_DRAFT = ['# Postmortem: INC-37 shop outage', '', '## Summary', 'On Saturday the shop was down for about 2 hours because Kofi carelessly deleted the shop config file on both web servers.', '', '## Root cause', 'Human error. Kofi ran a cleanup command without checking it.', '', '## Timeline', '- 19:10 Kofi deletes the config', '- 21:10 Shop restored', '', '## Action items', '- Kofi should be more careful', '- Improve monitoring', ''].join('\n');
const PM_GOOD = ['# Postmortem: INC-37 shop outage', '', '## Summary', 'From 19:42 to 20:14 UTC the shop returned 502 errors for all customers (32 minutes of full outage, resolved at 20:20 after monitoring). The weekly config-cleanup job deleted /etc/shop/shop.env on both web servers; the shop could not start without it.', '', '## Impact', '- 32 minutes of full outage; about 1,240 failed requests and 37 failed checkouts.', '- Status page updated at 19:51 and 20:16.', '', '## Timeline (UTC)', '- 19:30 cleanup job runs on web1 and web2 and removes *.env files', '- 19:42 alert: shop 5xx ratio 100%; INC-37 declared SEV1', '- 19:51 first public status update', '- 20:05 cause identified: shop.service fails with "Failed to load environment files"', '- 20:14 mitigated: env files restored from backups, shop restarted on both servers', '- 20:20 resolved after monitoring', '', '## Contributing factors', '- The cleanup job matched `*.env` under /etc, which includes application config.', '- No alert when shop.service failed on a single server; both failed together.', '- Config files were not managed by configuration management, so restoring relied on manual .bak copies.', '', '## What went well', '- Clear incident command; the .bak copies made mitigation fast.', '', '## Action items', '- [ ] Restrict the cleanup job to /tmp and review it (owner: @kofi, due: 2026-03-20)', '- [ ] Manage /etc/shop/shop.env with Ansible from git (owner: @priya, due: 2026-03-27)', '- [ ] Alert when shop.service is not active on any server (owner: @dev, due: 2026-03-20)', ''].join('\n');
const RUNBOOK = ['#!/usr/bin/env bash', '# Rolling restart of the shop: one server at a time, wait for health before moving on.', 'set -euo pipefail', '', 'DRY=0', '[[ "${1:-}" == "--dry-run" ]] && DRY=1', '', 'for host in web1 web2; do', '  echo "restarting shop on $host"', '  if (( DRY )); then continue; fi', '  ssh "ubuntu@$host" sudo systemctl restart shop', '  for i in $(seq 1 30); do', '    if curl -sf "http://$host:3000/health" >/dev/null; then break; fi', '    if [[ $i == 30 ]]; then echo "$host did not become healthy" >&2; exit 1; fi', '    sleep 1', '  done', '  echo "$host healthy"', 'done', 'echo "rolling restart complete"', ''].join('\n');
const BACKUP_SH = ['#!/usr/bin/env bash', 'set -euo pipefail', 'f=/var/backups/shop-$(date +%F).sql', 'sudo -u postgres pg_dump shop -f "$f"', 'aws s3 cp "$f" s3://lumen-backups/db1/', ''].join('\n');
const POSTMORTEM_SECTIONS = ['summary', 'impact', 'timeline', 'contributing factors', 'action items'];
export const pmOk = (text, { mustMention = [] } = {}) => {
  const t = String(text);
  const has = POSTMORTEM_SECTIONS.every(s => new RegExp(`^#+\\s*${s}`, 'im').test(t));
  const blame = /careless|human error|fault|should be more careful|stupid|negligen/i.test(t);
  const actions = (t.split(/^#+\s*action items/im)[1] || '').split('\n').filter(l => /^\s*[-*]/.test(l) && /@\w+|owner/i.test(l) && /\d{4}-\d{2}-\d{2}/.test(l));
  const factors = (t.split(/^#+\s*contributing factors/im)[1] || '').split(/^#/m)[0].split('\n').filter(l => /^\s*[-*]/.test(l));
  return has && !blame && actions.length >= 3 && factors.length >= 2 && mustMention.every(re => re.test(t));
};

export default {
  id: 'reliability',
  n: 10,
  title: 'Reliability & Incidents',
  tagline: 'Design for failure, run incidents calmly, automate runbooks, learn blamelessly, back up and restore, and break things on purpose',
  badge: 'Calm Under Fire',
  intro: 'Everything fails; reliable systems are designed and operated for it. Remove **single points of failure**, run **incidents** with clear roles and communication, turn runbooks into **safe automation**, write **blameless postmortems**, keep **backups** you have actually restored, and practise with **game days**. Outages here are real inside the simulator: servers stop, disks fill, tables get dropped.',
  lessons: [
    {
      id: 'failure-design',
      title: 'Designing for failure',
      summary: 'Single points of failure, redundancy, load balancing with failover, timeouts, retries with backoff, graceful degradation.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        setup(H) { relWorld(H, { lb: SINGLE }); },
        suggestions: ['ab -n 100 -c 10 http://shop.lumen.dev/', 'curl -s shop.lumen.dev'],
        tasks: [
          { title: 'Measure the steady state: load-test the shop with `ab` (100 requests, 10 at a time). Expect 0 failures', solution: 'ab -n 100 -c 10 http://shop.lumen.dev/', check: t => loads(t).some(clean) },
          { title: 'Find the single point of failure: stop the shop on `web1` and load-test again', solution: 'ssh ubuntu@web1 sudo systemctl stop shop; ab -n 100 -c 10 http://shop.lumen.dev/', check: t => loads(t).some(e => e.non2xx > 0 || e.failed > 0) },
          { title: 'Start `web1` again, then change the load balancer (`lb`) to an nginx `upstream` with both web1:3000 and web2:3000. Test the config and reload', solution: 'ssh ubuntu@web1 sudo systemctl start shop; ssh ubuntu@lb', test: ['ssh ubuntu@web1 sudo systemctl start shop', 'ssh ubuntu@lb', { cmd: 'sudo nano /etc/nginx/sites-enabled/default', edit: UPSTREAM }, 'sudo nginx -t && sudo systemctl reload nginx', 'exit', 'for i in 1 2 3 4; do curl -s shop.lumen.dev; echo; done'], check: t => { const s = servedBy(t); return s.has('web1') && s.has('web2'); } },
          { title: 'Prove it: stop the shop on `web1` again and load-test. No request may fail now', solution: 'ssh ubuntu@web1 sudo systemctl stop shop; ab -n 200 -c 10 http://shop.lumen.dev/', check: t => !t.active('web1', 'shop') && clean(loads(t).slice(-1)[0]) && loads(t).slice(-1)[0].n >= 100 },
          { title: 'Start web1 again, and see in the load balancer\'s error log how nginx failed over', solution: 'ssh ubuntu@web1 sudo systemctl start shop; ssh ubuntu@lb sudo tail -5 /var/log/nginx/error.log', check: t => t.active('web1', 'shop') && t.ran(/error\.log/) },
          { title: 'What is still a single point of failure? Write it into `~/spof.txt`', solution: 'echo "lb: the load balancer itself is a single point of failure" > ~/spof.txt', check: t => /\blb\b|load.?balancer|nginx/i.test(file(t, '~/spof.txt')) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What is a single point of failure?', choices: ['The slowest component', 'A component whose failure takes the whole service down', 'A server with one CPU', 'A failing test'], answer: 1, explain: 'Find them by asking "what if this dies?".' },
        { type: 'mc', q: 'Why add jitter to retry backoff?', choices: ['To make it slower', 'So many clients do not retry in sync and hammer a recovering service together', 'It is required by HTTP', 'To log better'], answer: 1, explain: 'Avoids thundering herds.' },
        { type: 'mc', q: 'nginx upstream with web1 and web2; web1\'s app is stopped. What does a client see?', choices: ['502 every other request', 'Success: nginx retries the next server when a connection fails', 'A redirect', 'Timeouts'], answer: 1, explain: 'proxy_next_upstream (error, timeout) by default.' },
        { type: 'multi', q: 'Good failure-design habits:', choices: ['Timeouts on every network call', 'N+1 capacity', 'Testing failover regularly', 'Retrying forever without backoff'], answer: [0, 1, 2], explain: 'Unbounded retries cause storms.' },
        { type: 'tf', q: 'With two app servers behind one load balancer, there is no single point of failure left.', answer: false, explain: 'The load balancer (and the database, DNS…) still are.' },
        { type: 'mc', q: 'Graceful degradation means…', choices: ['Failing slowly', 'Keeping the core working when a non-essential part fails (shop without recommendations)', 'Lower image quality', 'Retrying'], answer: 1, explain: 'Partial service beats no service.' },
      ],
    },
    {
      id: 'incident-response',
      title: 'Incident response',
      summary: 'Severity levels, declaring early, incident commander and roles, mitigation first, status updates, timelines.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        setup(H) {
          relWorld(H);
          for (const w of ['web1', 'web2']) { H.uni.host(w).removeFile('/etc/shop/shop.env'); H.run('sudo systemctl restart shop || true', { on: w }); }
        },
        suggestions: ['curl -s -o /dev/null -w "%{http_code}\\n" shop.lumen.dev', 'incident declare --sev 1 --title "…"'],
        tasks: [
          { title: 'Support says the shop is broken. Check it yourself, then declare an incident with the right severity and make yourself commander', solution: 'curl -s -o /dev/null -w "%{http_code}\\n" shop.lumen.dev; incident declare --sev 1 --title "Shop returns 502 for all customers" && incident role commander dev', check: t => { const i = inc(t); return !!i && i.sev <= 2 && !!i.roles.commander && t.events('http').some(e => /shop\.lumen\.dev/.test(e.url)); } },
          { title: 'Tell customers you are on it: post a public update to the status page', solution: 'incident update --public "We are investigating errors on the shop. Next update in 30 minutes." && curl -s status.lumen.dev', check: t => (inc(t)?.public.length || 0) >= 1 },
          { title: 'Investigate on the web servers: why is the shop not running?', solution: 'ssh ubuntu@web1 systemctl status shop; ssh ubuntu@web1 journalctl -u shop -n 20', check: t => t.ran(/systemctl\s+status\s+shop|journalctl\b.*shop/) },
          { title: 'Record what you found in the incident timeline', solution: 'incident note "shop.service fails on web1+web2: Failed to load environment files (/etc/shop/shop.env missing)"', check: t => (inc(t)?.timeline || []).some(e => e.kind === 'note' && /env/i.test(e.text)) },
          { title: 'Mitigate: restore `/etc/shop/shop.env` on both servers (there is a `.bak`), restart the shop, check the site, and mark the incident mitigated', solution: 'for h in web1 web2; do ssh ubuntu@$h "sudo cp /etc/shop/shop.env.bak /etc/shop/shop.env && sudo systemctl restart shop"; done; curl -s shop.lumen.dev; incident status mitigated', check: t => t.active('web1', 'shop') && t.active('web2', 'shop') && t.http('laptop', 'http://shop.lumen.dev/').status === 200 && ['mitigated', 'monitoring', 'resolved'].includes(inc(t)?.status) },
          { title: 'Post a final public update and resolve the incident. Review the timeline', solution: 'incident update --public "The shop is working normally again. We will publish a postmortem." && incident status resolved && incident timeline', check: t => inc(t)?.status === 'resolved' && (inc(t)?.public.length || 0) >= 2 && t.events('incident-view').length > 0 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'The incident commander\'s main job is…', choices: ['Fixing the bug', 'Coordinating: deciding, delegating, keeping everyone aligned', 'Writing the postmortem alone', 'Talking to the press'], answer: 1, explain: 'The IC does not debug.' },
        { type: 'mc', q: 'During an outage, the bad deploy is known. What first?', choices: ['Find the exact line of code', 'Mitigate: roll back to restore service, investigate after', 'Write the postmortem', 'Wait for monitoring'], answer: 1, explain: 'Mitigation first.' },
        { type: 'multi', q: 'Why post status updates even with no news?', choices: ['Customers know you are working on it', 'Support stops guessing', 'It reduces duplicate reports', 'It fixes the outage'], answer: [0, 1, 2], explain: 'Silence is read as neglect.' },
        { type: 'mc', q: 'Unsure whether something is SEV2 or SEV3?', choices: ['Wait and see', 'Declare at the higher severity; downgrading is cheap', 'Do not declare', 'Ask the customer'], answer: 1, explain: 'Declare early.' },
        { type: 'tf', q: 'The incident timeline is mainly useful for the postmortem.', answer: true, explain: 'And for handovers during the incident.' },
        { type: 'order', q: 'Order the incident statuses.', items: ['investigating', 'identified', 'mitigated', 'monitoring', 'resolved'], explain: 'Resolve only after monitoring.' },
      ],
    },
    {
      id: 'runbooks-automation',
      title: 'Runbooks and safe automation',
      summary: 'Runbooks as scripts: rolling, health-checked, stop on failure, dry-run; toil and what to automate.',
      minutes: 30,
      lab: {
        cwd: '~/runbooks',
        panels: ['system', 'files'],
        setup(H) { relWorld(H); H.mkdir('laptop', '/home/dev/runbooks', { owner: 'dev' }); },
        suggestions: ['nano rolling-restart.sh'],
        tasks: [
          { title: 'Write `rolling-restart.sh`: for web1 then web2, restart the shop over SSH and wait (up to 30 tries) until `http://<host>:3000/health` answers before moving on. Use `set -euo pipefail`, support `--dry-run`, and check the syntax with `bash -n`', solution: 'nano rolling-restart.sh && bash -n rolling-restart.sh', test: [{ cmd: 'nano rolling-restart.sh', edit: RUNBOOK }, 'bash -n rolling-restart.sh'], check: t => { const s = file(t, '~/runbooks/rolling-restart.sh'); return /set -euo pipefail/.test(s) && /--dry-run/.test(s) && /\/health/.test(s) && t.ran(/bash\s+-n\s+\S*rolling-restart\.sh/); } },
          { title: 'Dry-run it: it must print both hosts and restart nothing', solution: 'bash rolling-restart.sh --dry-run', check: t => t.ran(/rolling-restart\.sh\s+--dry-run/) && !t.events('proc-start').some(e => e.unit === 'shop.service') },
          { title: 'Run it for real. It must restart web1, wait for its health check, then web2', solution: 'bash rolling-restart.sh', check: t => { const ev = t.events(); const r1 = ev.findIndex(e => e.type === 'proc-start' && e.unit === 'shop.service' && e.host === 'web1'); const hc = ev.findIndex((e, i) => i > r1 && e.type === 'http' && /web1:3000\/health/.test(e.url) && e.status === 200); const r2 = ev.findIndex((e, i) => i > hc && e.type === 'proc-start' && e.unit === 'shop.service' && e.host === 'web2'); return r1 >= 0 && hc > r1 && r2 > hc; } },
          { title: 'Confirm the shop stayed healthy: load test after the restart shows no errors', solution: 'ab -n 200 -c 10 http://shop.lumen.dev/', check: t => clean(loads(t).slice(-1)[0]) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why restart servers one at a time with a health check between?', choices: ['It is faster', 'So there is always healthy capacity serving users', 'systemd requires it', 'To save logs'], answer: 1, explain: 'Restarting all at once is an outage.' },
        { type: 'mc', q: 'What does `set -euo pipefail` buy you in a runbook script?', choices: ['Colour output', 'Stopping at the first failure instead of carrying on blindly', 'Parallelism', 'Logging'], answer: 1, explain: 'Fail safe, not silent.' },
        { type: 'multi', q: 'Signs of a safe automation script:', choices: ['Dry-run mode', 'Bounded waits with a clear failure', 'Idempotent steps', 'No way to stop it once started'], answer: [0, 1, 2], explain: 'Always an abort path.' },
        { type: 'mc', q: 'What is toil?', choices: ['Any work', 'Manual, repetitive operational work that could be automated and scales with the service', 'Writing code', 'On-call'], answer: 1, explain: 'Measure it and reduce it.' },
        { type: 'tf', q: 'A script an AI assistant wrote is safe to run in production if it looks right.', answer: false, explain: 'Dry-run it, test the failure paths, limit the blast radius.' },
      ],
    },
    {
      id: 'postmortems',
      title: 'Blameless postmortems',
      summary: 'Summary, impact, timeline from the record, contributing factors, action items with owners and dates; checking AI drafts.',
      minutes: 25,
      lab: {
        cwd: '~/postmortems',
        panels: ['files', 'system'],
        setup(H) {
          const S = incidentStore(H.uni);
          const d0 = Date.UTC(2026, 2, 7, 19, 42) / 1000;
          S.list.push({ id: 'INC-37', title: 'Shop returns 502 for all customers', sev: 1, status: 'resolved', roles: { commander: 'priya', ops: 'kofi', comms: 'sam' }, declared: d0, resolved: d0 + 38 * 60, public: [{ t: d0 + 9 * 60, text: 'We are investigating errors on the shop.' }, { t: d0 + 34 * 60, text: 'The shop is working normally again.' }], timeline: [
            { t: d0 - 12 * 60, kind: 'note', text: 'cleanup job ran on web1 and web2 (removes *.env under /etc)' },
            { t: d0, kind: 'declared', text: 'Declared SEV1: Shop returns 502 for all customers' },
            { t: d0 + 60, kind: 'role', text: 'priya is commander' },
            { t: d0 + 9 * 60, kind: 'public-update', text: 'We are investigating errors on the shop.' },
            { t: d0 + 23 * 60, kind: 'note', text: 'shop.service fails: Failed to load environment files (/etc/shop/shop.env missing on both servers)' },
            { t: d0 + 32 * 60, kind: 'status', text: 'Status → mitigated (env restored from .bak, shop restarted)' },
            { t: d0 + 34 * 60, kind: 'public-update', text: 'The shop is working normally again.' },
            { t: d0 + 38 * 60, kind: 'status', text: 'Status → resolved' },
            { t: d0 + 38 * 60, kind: 'note', text: 'impact: ~1,240 failed requests, 37 failed checkouts' },
          ] });
          H.write('laptop', '~/postmortems/INC-37-draft.md', PM_DRAFT, { owner: 'dev' });
          H.uni.ai = { rules: [{ id: 'pm', when: /postmortem|review|blameless/i, reply: ['Review of INC-37-draft.md:', '- "carelessly" and "Human error" assign blame to a person; describe what the system allowed instead.', '- The timeline does not match the incident record (check `incident timeline INC-37`).', '- Action items need owners and due dates, and must be specific.', '- Missing sections: Impact, Contributing factors.', '(I may still be wrong about the facts: verify every time and number against the record.)'] }] };
        },
        suggestions: ['incident timeline INC-37', 'cat INC-37-draft.md'],
        tasks: [
          { title: 'Read the real incident record for INC-37', solution: 'incident timeline INC-37', check: t => t.events('incident-view').some(e => e.id === 'INC-37') },
          { title: 'Read the AI-drafted postmortem and compare it with the record', solution: 'cat INC-37-draft.md', check: t => t.ran(/(cat|less|head)\b.*INC-37-draft\.md/) },
          { title: 'Ask the AI assistant to review the draft for blameless language', solution: 'ai "review this postmortem for blameless language"', check: t => t.events('ai-ask').some(e => e.rule === 'pm') },
          { title: 'Write the real postmortem in `INC-37.md`: Summary, Impact, Timeline (UTC, from the record: declared 19:42, mitigated 20:14), Contributing factors (at least two), Action items (at least three, each with an owner like @name and a due date YYYY-MM-DD), and no blame', solution: 'nano INC-37.md', test: [{ cmd: 'nano INC-37.md', edit: PM_GOOD }], check: t => pmOk(file(t, '~/postmortems/INC-37.md'), { mustMention: [/19:42/, /20:14/] }) },
        ],
      },
      quiz: [
        { type: 'mc', q: '"Root cause: human error". What is wrong with it?', choices: ['Nothing', 'It stops the investigation at a person instead of asking what made the error easy and its impact large', 'It is too long', 'It names the date'], answer: 1, explain: 'Look for contributing factors in systems and processes.' },
        { type: 'multi', q: 'A good action item is…', choices: ['Specific', 'Owned by a named person', 'Dated and tracked', '"Be more careful"'], answer: [0, 1, 2], explain: '"Be more careful" changes nothing.' },
        { type: 'mc', q: 'Where should the timeline come from?', choices: ['Memory', 'The incident record, logs and metrics', 'The AI draft', 'The status page only'], answer: 1, explain: 'Facts from records.' },
        { type: 'tf', q: 'Blameless means nobody is accountable.', answer: false, explain: 'People own actions; the analysis targets systems, not scapegoats.' },
        { type: 'mc', q: 'An AI drafted your postmortem from chat logs. Your job:', choices: ['Publish it', 'Verify every fact against the record and remove blame copied from chat', 'Shorten it', 'Ignore it'], answer: 1, explain: 'AI drafts quickly, but it can be confidently wrong.' },
      ],
    },
    {
      id: 'backups-recovery',
      title: 'Backups and recovery',
      summary: '3-2-1, RPO and RTO, pg_dump to off-site object storage, scheduled backups, a real restore and measuring data loss.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['system', 'files'],
        setup(H) {
          relWorld(H, { db: true, orders: 100, cloud: true });
          const U = H.uni;
          U.tickers.push(() => {
            if (U.labData.dropped) return;
            const objs = U.cloud.buckets.get('lumen-backups')?.objects;
            if (!objs || ![...objs.keys()].some(k => k.startsWith('db1/'))) return;
            const cron = U.host('db1').crontabs.get('root') || '';
            if (!/backup-shop\.sh/.test(cron)) return;
            U.labData.dropped = true;
            const db = U.host('db1');
            const f = '/var/lib/postgresql/16/main/lumen_tables.json';
            const data = JSON.parse(db.files.get(f));
            delete data.tables.orders;
            db.writeFile(f, JSON.stringify(data), 'postgres');
            U.labData.say?.('💥 A deploy just ran migration 0043: "DROP TABLE orders" (it was meant for a temp table). Four new orders had come in since your backup.');
          });
        },
        events(ev, t) { t.uni.labData.say = t.say; },
        suggestions: ['ssh ubuntu@db1', 'sudo -u postgres psql -c "SELECT count(*) FROM orders"'],
        tasks: [
          { title: 'On db1, dump the `shop` database to `/var/backups/shop-<today>.sql` with pg_dump', solution: 'ssh ubuntu@db1', test: ['ssh ubuntu@db1', 'sudo -u postgres pg_dump shop -f /var/backups/shop-$(date +%F).sql'], check: t => t.events('pg_dump').some(e => /^\/var\/backups\/shop-\d{4}-\d{2}-\d{2}\.sql$/.test(e.file || '') && e.rows >= 100) },
          { title: 'A backup on the same server is not a backup. Copy it off-site to `s3://lumen-backups/db1/`', solution: 'aws s3 cp /var/backups/shop-$(date +%F).sql s3://lumen-backups/db1/', check: t => [...(t.cloud()?.buckets.get('lumen-backups')?.objects.entries() || [])].some(([k, o]) => k.startsWith('db1/') && /INSERT INTO orders/.test(o.body)) },
          { title: 'Automate it: write `/usr/local/bin/backup-shop.sh` (dump + upload) and schedule it in root\'s crontab every night at 02:00', solution: 'sudo nano /usr/local/bin/backup-shop.sh && sudo chmod +x /usr/local/bin/backup-shop.sh && (echo "0 2 * * * /usr/local/bin/backup-shop.sh") | sudo crontab -', test: [{ cmd: 'sudo nano /usr/local/bin/backup-shop.sh', edit: BACKUP_SH }, 'sudo chmod +x /usr/local/bin/backup-shop.sh', 'echo "0 2 * * * /usr/local/bin/backup-shop.sh" | sudo crontab -', 'sudo crontab -l'], check: t => /pg_dump/.test(t.file('db1', '/usr/local/bin/backup-shop.sh') || '') && /aws s3 cp/.test(t.file('db1', '/usr/local/bin/backup-shop.sh') || '') && /^0 2 \* \* \* .*backup-shop\.sh/m.test(t.cron('db1', 'root')) },
          { title: 'Disaster: the orders table is gone. Restore it from the newest backup in S3', solution: 'aws s3 ls s3://lumen-backups/db1/ && aws s3 cp s3://lumen-backups/db1/shop-$(date +%F).sql /tmp/restore.sql && sudo -u postgres psql -f /tmp/restore.sql && sudo -u postgres psql -c "SELECT count(*) FROM orders"', test: ['sudo -u postgres psql -c "SELECT count(*) FROM orders"', 'aws s3 ls s3://lumen-backups/db1/', 'aws s3 cp s3://lumen-backups/db1/shop-$(date +%F).sql /tmp/restore.sql', 'sudo -u postgres psql -f /tmp/restore.sql', 'sudo -u postgres psql -c "SELECT count(*) FROM orders"', 'exit'], check: t => !!t.uni.labData.dropped && ordersCount(t) >= 100 },
          { title: 'How many orders were lost (your RPO in practice)? Write the number into `~/rpo.txt`', solution: 'echo 4 > ~/rpo.txt', check: t => /^\s*4\b/.test(file(t, '~/rpo.txt')) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Nightly backups at 02:00. The database dies at 18:00. Worst-case data loss?', choices: ['None', 'About 16 hours (RPO = time since the last backup)', '24 hours always', 'Only today\'s logs'], answer: 1, explain: 'More frequent backups or WAL archiving shrink RPO.' },
        { type: 'mc', q: 'RTO is…', choices: ['How much data you lose', 'How long until service is restored', 'Backup size', 'Retention time'], answer: 1, explain: 'Measure it in restore drills.' },
        { type: 'multi', q: '3-2-1 means:', choices: ['3 copies', '2 different media', '1 copy off-site', '1 backup per year'], answer: [0, 1, 2], explain: 'Off-site and ideally immutable.' },
        { type: 'tf', q: 'A backup that has never been restored can be trusted.', answer: false, explain: 'Test restores regularly.' },
        { type: 'mc', q: 'Why keep backups in a separate account or with delete protection?', choices: ['Cheaper', 'So the same mistake, script or attacker that hits production cannot delete them', 'Faster restores', 'Required by PostgreSQL'], answer: 1, explain: 'Ransomware targets backups first.' },
      ],
    },
    {
      id: 'chaos-engineering',
      title: 'Chaos engineering and game days',
      summary: 'Steady state, hypotheses, blast radius and abort plans; injecting failures on purpose; turning findings into fixes.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['network', 'files'],
        setup(H) { relWorld(H); },
        suggestions: ['nano ~/gameday.md'],
        tasks: [
          { title: 'Plan first: write `~/gameday.md` with the steady state you will measure and your hypothesis', solution: 'nano ~/gameday.md', test: [{ cmd: 'nano ~/gameday.md', edit: '# Game day: shop\n\n## Steady state\nab -n 200 -c 10 http://shop.lumen.dev/ shows 0 failed and 0 non-2xx.\n\n## Hypothesis\nIf the shop stops on one web server, customers see no errors.\n\n## Abort plan\nIf errors appear, start the shop again immediately.\n' }], check: t => /steady state/i.test(file(t, '~/gameday.md')) && /hypothesis/i.test(file(t, '~/gameday.md')) },
          { title: 'Measure the steady state', solution: 'ab -n 200 -c 10 http://shop.lumen.dev/', check: t => loads(t).some(clean) },
          { title: 'Experiment 1: stop the shop on `web2` and measure again', solution: 'ssh ubuntu@web2 sudo systemctl stop shop; ab -n 200 -c 10 http://shop.lumen.dev/', check: t => !t.active('web2', 'shop') && clean(loads(t).slice(-1)[0]) },
          { title: 'Restore web2. Experiment 2: stop nginx on `lb` (a bigger blast radius), measure, and restore it at once', solution: 'ssh ubuntu@web2 sudo systemctl start shop; ssh ubuntu@lb sudo systemctl stop nginx; ab -n 50 http://shop.lumen.dev/; ssh ubuntu@lb sudo systemctl start nginx', check: t => t.active('web2', 'shop') && t.active('lb', 'nginx') && loads(t).some(e => e.failed > 0) && t.http('laptop', 'http://shop.lumen.dev/').status === 200 },
          { title: 'Record the findings in `~/gameday.md`: what survived, what did not, and an action item for the load balancer', solution: 'nano ~/gameday.md', test: [{ cmd: 'nano ~/gameday.md', edit: '# Game day: shop\n\n## Steady state\nab: 0 failed, 0 non-2xx.\n\n## Hypothesis\nLosing one web server causes no errors.\n\n## Results\n- Experiment 1 (web2 down): confirmed, 0 errors.\n- Experiment 2 (nginx on lb down): total outage. The load balancer is a single point of failure.\n\n## Action items\n- Add a second load balancer with a floating IP (owner: @dev, due: 2026-04-01)\n' }], check: t => { const g = file(t, '~/gameday.md'); return /\blb\b|load.?balancer|nginx/i.test(g) && /single point|spof/i.test(g) && /action/i.test(g); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What comes first in a chaos experiment?', choices: ['Breaking production', 'Defining the steady state and a hypothesis', 'Writing the postmortem', 'Buying a tool'], answer: 1, explain: 'Otherwise you cannot tell what broke.' },
        { type: 'mc', q: 'Blast radius means…', choices: ['How loud the alert is', 'How much of the system and how many users an experiment can affect', 'Server count', 'Duration'], answer: 1, explain: 'Start small.' },
        { type: 'multi', q: 'A responsible game day has:', choices: ['An abort plan', 'People informed in advance', 'A steady-state metric', 'Surprise failures for on-call at 3 a.m.'], answer: [0, 1, 2], explain: 'Planned, not ambushes.' },
        { type: 'tf', q: 'If an experiment breaks the steady state, it failed and was a waste.', answer: false, explain: 'You found a weakness before a real outage did.' },
        { type: 'mc', q: 'Experiment 2 took the whole shop down. Best next step?', choices: ['Never run experiments again', 'Turn the finding into an action item (redundant load balancers) and retest later', 'Hide the result', 'Blame the load balancer'], answer: 1, explain: 'Learn and fix.' },
      ],
    },
    {
      id: 'reliability-boss',
      title: 'Boss: The game day that turned real',
      summary: 'Run a real incident end to end: commander and comms, fix a server with a full disk, restore lost data from backups, verify under load, write the postmortem.',
      minutes: 45,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        setup(H) {
          relWorld(H, { db: true, orders: 120, cloud: true });
          // yesterday's backup is in S3 (118 orders)
          const db = H.uni.host('db1');
          const f = '/var/lib/postgresql/16/main/lumen_tables.json';
          const rows = n => Array.from({ length: n }, (_, i) => [String(i + 1), `order ${i + 1}`]);
          const dump = `--\n-- PostgreSQL database dump\n--\n\nCREATE TABLE orders (id text, item text);\nINSERT INTO orders VALUES ${rows(118).map(r => `(${r[0]}, '${r[1]}')`).join(', ')};\n`;
          H.uni.cloud.buckets.get('lumen-backups').objects.set('db1/shop-2026-03-06.sql', { body: dump, size: dump.length, time: H.uni.time - 3600 * 14 });
          // the orders table was dropped by a bad migration
          db.writeFile(f, JSON.stringify({ tables: {} }), 'postgres');
          // web1's disk is full of debug logs, so its shop cannot start
          H.mkdir('web1', '/var/log/shop', { owner: 'ubuntu' });
          H.fakeSize('web1', '/var/log/shop/debug.log', 34.5 * 1073741824);
          H.run('sudo systemctl restart shop || true', { on: 'web1' });
        },
        suggestions: ['incident declare --sev 2 --title "…"', 'ab -n 100 http://shop.lumen.dev/'],
        tasks: [
          { title: 'Declare an incident (SEV2: some customers affected, orders page empty), take command, and post a public update', solution: 'incident declare --sev 2 --title "Shop errors and missing orders" && incident role commander dev && incident update --public "We are investigating errors and missing order history."', check: t => { const i = inc(t); return !!i && i.sev <= 2 && !!i.roles.commander && i.public.length >= 1; } },
          { title: 'One web server is not serving. Find out why, fix it and get its shop running again', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', 'systemctl status shop', 'journalctl -u shop -n 10', 'df -h /', 'sudo du -sh /var/log/shop/*', 'sudo truncate -s 0 /var/log/shop/debug.log', 'sudo systemctl restart shop && systemctl is-active shop', 'exit', 'incident note "web1: disk full (34G debug.log), shop failed with ENOSPC; truncated log, restarted"'], check: t => t.active('web1', 'shop') && t.host('web1').diskUsedGB < t.host('web1').diskGB * 0.9 },
          { title: 'The orders table is gone. Restore it from the newest backup in `s3://lumen-backups/db1/`', solution: 'ssh ubuntu@db1', test: ['ssh ubuntu@db1', 'aws s3 ls s3://lumen-backups/db1/', 'aws s3 cp s3://lumen-backups/db1/shop-2026-03-06.sql /tmp/restore.sql', 'sudo -u postgres psql -f /tmp/restore.sql', 'sudo -u postgres psql -c "SELECT count(*) FROM orders"', 'exit', 'incident note "orders restored from 2026-03-06 backup: 118 orders; 2 newer orders need manual recovery"'], check: t => ordersCount(t) >= 118 },
          { title: 'Verify under load (200 requests, no errors), then mitigate and resolve the incident with a final public update', solution: 'ab -n 200 -c 10 http://shop.lumen.dev/ && incident status mitigated && incident update --public "The shop is fully working again." && incident status resolved', check: t => clean(loads(t).slice(-1)[0]) && inc(t)?.status === 'resolved' && inc(t).public.length >= 2 && t.active('web1', 'shop') && t.active('web2', 'shop') },
          { title: 'Write the blameless postmortem in `~/postmortem.md`: Summary, Impact, Timeline, Contributing factors (2+), Action items (3+, with @owner and YYYY-MM-DD), mentioning the disk and the backup', solution: 'nano ~/postmortem.md', test: [{ cmd: 'nano ~/postmortem.md', edit: ['# Postmortem: shop errors and missing orders', '', '## Summary', 'web1 stopped serving because its disk filled with debug logs, and a migration dropped the orders table. Orders were restored from the nightly backup.', '', '## Impact', '- Reduced capacity (one of two web servers) and an empty orders page for about 40 minutes.', '- 2 orders placed after the last backup had to be recovered manually.', '', '## Timeline (UTC)', '- 14:02 support reports errors; incident declared SEV2', '- 14:10 web1: disk full, shop fails with ENOSPC; log truncated, shop restarted', '- 14:25 orders restored from the 2026-03-06 backup', '- 14:35 load test clean; resolved', '', '## Contributing factors', '- Debug logging left on in production with no log rotation or disk alert.', '- Migration ran DROP TABLE on the wrong table with no review or pre-migration backup.', '', '## Action items', '- Add logrotate for /var/log/shop and a disk usage alert at 80% (owner: @dev, due: 2026-03-20)', '- Require review and an automatic backup before migrations (owner: @priya, due: 2026-03-27)', '- Move to hourly backups / WAL archiving to cut RPO (owner: @kofi, due: 2026-04-10)', ''].join('\n') }], check: t => pmOk(file(t, '~/postmortem.md'), { mustMention: [/disk/i, /backup/i] }) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the incident.', items: ['Declare and take command', 'Communicate publicly', 'Mitigate: restore the failed server', 'Recover data from backups', 'Verify, resolve, write the postmortem'], explain: 'Service first, then data, then learning.' },
        { type: 'mc', q: 'A disk full of debug logs took down an app. Best long-term fix?', choices: ['Bigger disk', 'Log rotation, sane log levels in production and a disk-usage alert', 'Delete logs by hand each week', 'Disable logging'], answer: 1, explain: 'Prevent and detect.' },
        { type: 'mc', q: 'The latest backup is 14 hours old and two orders are missing. That gap is…', choices: ['RTO', 'The real RPO', 'Uptime', 'MTTR'], answer: 1, explain: 'Data you could not recover.' },
        { type: 'multi', q: 'Which helped most here?', choices: ['Redundant web servers', 'Off-site backups', 'A clear incident process', 'Guessing the cause'], answer: [0, 1, 2], explain: 'Design + backups + process.' },
        { type: 'tf', q: 'After resolving, the incident commander\'s job is done.', answer: false, explain: 'Postmortem and action items follow.' },
      ],
    },
  ],
};
