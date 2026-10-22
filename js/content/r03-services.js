// Realm 3 · Servers & Services: systemd, nginx as a reverse proxy, release deploys, logs and cron.

const hist = (t, re) => { let k = -1; t.history.forEach((l, i) => { if (re.test(l)) k = i; }); return k; };
const GB = 1073741824;

const notesApp = (version, { bind = '127.0.0.1', extra = '' } = {}) => `const express = require('express');
const app = express();
const PORT = process.env.PORT || 4000;
const VERSION = '${version}';
${extra}
app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION }));
app.get('/', (req, res) => res.send('Lumen notes ' + VERSION));
app.listen(PORT, '${bind}', () => console.log(\`notes \${VERSION} listening on \${PORT}\`));
`;
const tarball = files => 'TAR1' + JSON.stringify(files);
const release = (version, extra) => tarball({ 'server.js': notesApp(version, { extra }), 'package.json': JSON.stringify({ name: 'notes', version, dependencies: { express: '^4.21.1' } }) + '\n', 'node_modules/express/package.json': '{"name":"express","version":"4.21.1"}\n' });

const NOTES_UNIT = `[Unit]
Description=Lumen notes API
After=network.target

[Service]
User=notes
WorkingDirectory=/opt/notes
Environment=PORT=4000
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

function notesHost(H, name = 'web1', { asService = false, owner = 'notes' } = {}) {
  H.server(name, { ip: '10.0.0.11' });
  H.install(name, 'nodejs');
  H.user(name, 'notes', { shell: '/usr/sbin/nologin', noHome: true });
  H.mkdir(name, '/opt/notes', { owner });
  H.mkdir(name, '/opt/notes/node_modules', { owner });
  H.mkdir(name, '/opt/notes/node_modules/express', { owner });
  H.write(name, '/opt/notes/server.js', notesApp('1.3.0'), { owner });
  if (asService) H.service(name, 'notes', NOTES_UNIT);
}

const SHOP_APP = `const express = require('express');
const app = express();
const PORT = process.env.PORT || 5000;
const CURRENCY = process.env.SHOP_CURRENCY;
if (!CURRENCY) throw new Error('SHOP_CURRENCY is not set (expected e.g. EUR)');
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('/', (req, res) => res.send('Lumen merch shop: hoodies, mugs, posters'));
app.listen(PORT, '127.0.0.1', () => console.log(\`shop listening on \${PORT}\`));
`;

export default {
  id: 'services',
  n: 3,
  title: 'Servers & Services',
  tagline: 'systemd, nginx, release deploys, logs and scheduled jobs',
  badge: 'Service Keeper',
  intro: 'Turn programs into dependable **services**: supervised by **systemd**, published through **nginx**, deployed as **releases** you can roll back in seconds, with **logs** that stay bounded and **scheduled jobs** you can trust.',
  lessons: [
    {
      id: 'systemd-services',
      title: 'Services with systemd',
      summary: 'Unit files, enable vs start, daemon-reload, Restart=, the journal, and surviving a crash.',
      minutes: 22,
      lab: {
        startOn: { host: 'web1', user: 'ubuntu' },
        cwd: '~',
        panels: ['system', 'files'],
        setup(H) {
          notesHost(H, 'web1', { owner: 'ubuntu' });
          H.run('cd /opt/notes && PORT=4000 node server.js > /tmp/notes.log 2>&1 &', { on: 'web1', user: 'ubuntu' });
        },
        suggestions: ['pgrep -a node', 'cat /opt/notes/server.js'],
        tasks: [
          { title: 'Find the notes API process someone started by hand', solution: 'pgrep -a node', check: t => t.ran(/\b(pgrep|ps)\b/) },
          { title: 'Stop that hand-started process', solution: 'pkill -f server.js', check: t => !t.procs('web1', /server\.js/).some(p => !p.unit) && t.events('kill').length > 0 },
          { title: 'Create a system user `notes` with no login shell, and give it `/opt/notes`', hint: '`sudo useradd --system --no-create-home --shell /usr/sbin/nologin notes` (it exists already here, so useradd will say so) then `sudo chown -R notes:notes /opt/notes`.', solution: 'sudo chown -R notes:notes /opt/notes', check: t => t.userExists('web1', 'notes') && t.owner('web1', '/opt/notes/server.js') === 'notes' },
          { title: 'Write the unit file `/etc/systemd/system/notes.service` (User=notes, WorkingDirectory, PORT=4000, absolute ExecStart, Restart=always)', hint: 'Copy the example from the Mental Model lens: `sudo nano /etc/systemd/system/notes.service`.', solution: 'sudo nano /etc/systemd/system/notes.service', test: [{ cmd: 'sudo nano /etc/systemd/system/notes.service', edit: NOTES_UNIT }], check: t => { const f = t.file('web1', '/etc/systemd/system/notes.service') || ''; return /User=notes/.test(f) && /ExecStart=\/\S+node/.test(f) && /Restart=(always|on-failure)/.test(f) && /WantedBy=/.test(f); } },
          { title: 'Load it and start it now and at every boot', solution: 'sudo systemctl daemon-reload && sudo systemctl enable --now notes', check: t => t.active('web1', 'notes') && t.enabled('web1', 'notes') && !!t.listening('web1', 4000) },
          { title: 'Check its status and read its logs in the journal', solution: 'systemctl status notes && journalctl -u notes -n 20', check: t => t.ran(/journalctl\b.*-u\s+notes/) },
          { title: 'Simulate a crash: `sudo kill -9` its main PID, wait a few seconds, and confirm systemd restarted it', hint: '`systemctl show -p MainPID notes`… or just: `sudo kill -9 $(pgrep -f server.js)`, then `sleep 5` and `systemctl status notes`.', solution: 'sudo kill -9 $(pgrep -f server.js); sleep 5; systemctl status notes', test: ['sudo kill -9 $(pgrep -f server.js)', 'sleep 5', 'systemctl status notes'], check: t => t.events('kill').some(e => e.signal === 'KILL' && /server\.js/.test(e.cmd)) && t.active('web1', 'notes') && t.journal('web1', 'notes.service').some(j => /Scheduled restart/.test(j.msg)) },
          { title: 'Change the port to 4001 in the unit file and apply it properly', hint: 'Edit `Environment=PORT=…`, then `daemon-reload` and `restart`. Watch for the "changed on disk" warning if you forget.', solution: "sudo sed -i 's/PORT=4000/PORT=4001/' /etc/systemd/system/notes.service && sudo systemctl daemon-reload && sudo systemctl restart notes", check: t => !!t.listening('web1', 4001) && t.active('web1', 'notes') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What is the difference between `systemctl start` and `systemctl enable`?', choices: ['None', 'start runs it now; enable makes it start at boot', 'enable runs it now; start at boot', 'start is for root only'], answer: 1, explain: '`enable --now` does both.' },
        { type: 'mc', q: 'You edited a unit file and restarted the service, but nothing changed. Why?', choices: ['The service is broken', 'You forgot systemctl daemon-reload, so systemd still uses the old unit', 'Restart does not exist', 'The journal is full'], answer: 1, explain: 'systemctl status warns that the unit changed on disk.' },
        { type: 'mc', q: 'Where do a service\'s stdout and stderr go by default?', choices: ['/dev/null', 'The systemd journal (journalctl -u name)', 'A file next to the binary', 'Your terminal'], answer: 1, explain: 'One place for every service\'s logs.' },
        { type: 'multi', q: 'Which belong in a well-behaved unit file?', choices: ['User= a dedicated service user', 'An absolute path in ExecStart', 'Restart=on-failure (or always)', 'ExecStart=cd /opt/app && npm start'], answer: [0, 1, 2], explain: 'Use WorkingDirectory=; ExecStart is not a shell line.' },
        { type: 'mc', q: 'A service crashes in a loop. What stops it from restarting forever?', choices: ['Nothing', 'systemd\'s start rate limit (StartLimitBurst): it gives up and marks the unit failed', 'The kernel', 'nginx'], answer: 1, explain: '"Start request repeated too quickly".' },
        { type: 'type', q: 'Type the command that shows the last 50 log lines of the service called api.', accept: ['journalctl -u api -n 50', 'journalctl -n 50 -u api', 'sudo journalctl -u api -n 50', 'journalctl -u api.service -n 50'], model: 'journalctl -u api -n 50', explain: '-u unit, -n lines.' },
        { type: 'tf', q: 'Without a User= line, a systemd service runs as root.', answer: true, explain: 'Always set a dedicated user.' },
      ],
    },
    {
      id: 'nginx-proxy',
      title: 'nginx as a reverse proxy',
      summary: 'Server blocks, locations, proxy_pass, static files, sites-enabled symlinks, nginx -t, and reading a 502.',
      minutes: 24,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        setup(H) {
          notesHost(H, 'web1', { asService: true });
          H.authorize('laptop', 'dev', 'web1', 'ubuntu');
          H.dns('notes.lumen.example.com', 'web1');
          H.write('web1', '/var/www/notes/static/app.css', 'body { font-family: sans-serif; }\n');
        },
        suggestions: ['curl -I http://notes.lumen.example.com'],
        tasks: [
          { title: 'From your laptop, try `curl -I http://notes.lumen.example.com`. Why does it fail?', solution: 'curl -I http://notes.lumen.example.com', check: t => t.events('http').some(e => /notes\.lumen/.test(e.url) && e.error === 'ECONNREFUSED') },
          { title: 'Log in to web1 and install nginx', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', 'sudo apt install -y nginx'], check: t => t.pkg('web1', 'nginx') && t.active('web1', 'nginx') },
          { title: 'Write `/etc/nginx/sites-available/notes`: server_name notes.lumen.example.com, `location /` proxied to 127.0.0.1:4000, `location /static/` served from root /var/www/notes', solution: 'sudo nano /etc/nginx/sites-available/notes', test: [{ cmd: 'sudo nano /etc/nginx/sites-available/notes', edit: 'server {\n    listen 80;\n    server_name notes.lumen.example.com;\n\n    location / {\n        proxy_pass http://127.0.0.1:4000;\n        proxy_set_header Host $host;\n    }\n\n    location /static/ {\n        root /var/www/notes;\n    }\n}\n' }], check: t => { const f = t.file('web1', '/etc/nginx/sites-available/notes') || ''; return /server_name\s+notes\.lumen\.example\.com/.test(f) && /proxy_pass\s+http:\/\/127\.0\.0\.1:4000/.test(f) && /location\s+\/static\//.test(f); } },
          { title: 'Enable it with a symlink in sites-enabled, and disable the default site', solution: 'sudo ln -s /etc/nginx/sites-available/notes /etc/nginx/sites-enabled/ && sudo rm /etc/nginx/sites-enabled/default', check: t => t.isLink('web1', '/etc/nginx/sites-enabled/notes') && !t.exists('web1', '/etc/nginx/sites-enabled/default') },
          { title: 'Test the configuration, then reload nginx', solution: 'sudo nginx -t && sudo systemctl reload nginx', check: t => t.events('nginx-test').some(e => e.ok) && t.http('laptop', 'http://notes.lumen.example.com/').status === 200 },
          { title: 'From your laptop, fetch both the app and a static file through nginx', solution: 'exit', test: ['exit', 'curl http://notes.lumen.example.com/', 'curl -I http://notes.lumen.example.com/static/app.css'], check: t => t.events('http').some(e => e.host === 'laptop' && /notes\.lumen\.example\.com\/?$/.test(e.url) && e.status === 200) && t.events('http').some(e => e.host === 'laptop' && /\/static\/app\.css$/.test(e.url) && e.status === 200) },
          { title: 'Stop the notes service and see what nginx returns now', solution: 'ssh ubuntu@web1 "sudo systemctl stop notes"; curl -I http://notes.lumen.example.com/', test: ['ssh ubuntu@web1 "sudo systemctl stop notes"', 'curl -I http://notes.lumen.example.com/'], check: t => t.events('http').some(e => /notes\.lumen/.test(e.url) && e.status === 502) },
          { title: 'Read the reason in nginx\'s error log, then start the service again and confirm 200', solution: 'ssh ubuntu@web1 "sudo tail -n 3 /var/log/nginx/error.log; sudo systemctl start notes"; curl -I http://notes.lumen.example.com/', test: ['ssh ubuntu@web1 "sudo tail -n 3 /var/log/nginx/error.log"', 'ssh ubuntu@web1 "sudo systemctl start notes"', 'curl -I http://notes.lumen.example.com/'], check: t => t.ran(/error\.log/) && t.after(e => e.type === 'http' && e.status === 502, e => e.type === 'http' && /notes\.lumen/.test(e.url) && e.status === 200) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'How does nginx choose which server block handles a request on port 80?', choices: ['Alphabetically', 'By the Host header matching server_name, falling back to the default_server', 'Randomly', 'By the client IP'], answer: 1, explain: 'Then the most specific location inside it.' },
        { type: 'mc', q: 'You created /etc/nginx/sites-available/app but nginx ignores it. Most likely?', choices: ['A missing symlink in sites-enabled', 'nginx needs a reboot', 'The file needs chmod 777', 'DNS'], answer: 0, explain: 'sites-enabled is what nginx.conf includes.' },
        { type: 'mc', q: 'Which pair should always go together when changing nginx config?', choices: ['nginx -s stop && nginx', 'nginx -t && systemctl reload nginx', 'reboot && nginx -t', 'rm nginx.conf && apt install nginx'], answer: 1, explain: 'A broken config is never applied.' },
        { type: 'mc', q: 'nginx returns 502 Bad Gateway. What do you check first?', choices: ['The browser cache', 'Whether the upstream app is running and listening where proxy_pass points; the nginx error log', 'The TLS certificate', 'The DNS TTL'], answer: 1, explain: 'nginx itself is working.' },
        { type: 'multi', q: 'Why put apps behind a reverse proxy?', choices: ['One place for TLS, compression and limits', 'Apps can listen on 127.0.0.1 only', 'Several apps can share ports 80/443 by hostname or path', 'It makes the app code run faster'], answer: [0, 1, 2], explain: 'It does not speed up your code.' },
        { type: 'tf', q: '`systemctl reload nginx` drops all open connections.', answer: false, explain: 'Reload swaps workers gracefully; restart drops connections.' },
      ],
    },
    {
      id: 'deploy-releases',
      title: 'Deploying with releases and rollbacks',
      summary: 'Release folders, shared config, an atomic current symlink, health checks, and rolling back a bad version.',
      minutes: 26,
      lab: {
        cwd: '~',
        panels: ['system', 'files'],
        setup(H) {
          H.server('web1', { ip: '10.0.0.11' });
          H.install('web1', 'nodejs');
          H.user('web1', 'notes', { shell: '/usr/sbin/nologin', noHome: true });
          H.authorize('laptop', 'dev', 'web1', 'ubuntu');
          H.mkdir('web1', '/opt/notes', { owner: 'notes' });
          H.mkdir('web1', '/opt/notes/releases', { owner: 'notes' });
          H.mkdir('web1', '/opt/notes/shared', { owner: 'notes' });
          const r200 = JSON.parse(release('2.0.0').slice(4));
          for (const [p, c] of Object.entries(r200)) H.write('web1', `/opt/notes/releases/2.0.0/${p}`, c, { owner: 'notes' });
          H.write('web1', '/opt/notes/shared/notes.env', 'PORT=4000\nAPP_SECRET=6f1d0c\n', { owner: 'notes', mode: 0o600 });
          H.run('cd /opt/notes && sudo -u notes ln -sfn releases/2.0.0 current', { on: 'web1' });
          H.service('web1', 'notes', '[Unit]\nDescription=Lumen notes API\nAfter=network.target\n\n[Service]\nUser=notes\nWorkingDirectory=/opt/notes/current\nEnvironmentFile=/opt/notes/shared/notes.env\nExecStart=/usr/bin/node /opt/notes/current/server.js\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n');
          H.write('laptop', '~/releases/notes-2.1.0.tar.gz', release('2.1.0'), { owner: 'dev' });
          H.write('laptop', '~/releases/notes-2.2.0.tar.gz', release('2.2.0', "if (!process.env.PAYMENTS_KEY) throw new Error('PAYMENTS_KEY is required');"), { owner: 'dev' });
        },
        suggestions: ['ssh ubuntu@web1 "curl -s localhost:4000/health"', 'ssh ubuntu@web1 "ls -l /opt/notes"'],
        tasks: [
          { title: 'Ask the running app which version it is: `ssh ubuntu@web1 "curl -s localhost:4000/health"`', solution: 'ssh ubuntu@web1 "curl -s localhost:4000/health"', check: t => t.events('http').some(e => e.host === 'web1' && /4000\/health/.test(e.url) && e.status === 200) },
          { title: 'Look at the layout: `ls -l /opt/notes` on web1. What is `current`?', solution: 'ssh ubuntu@web1 "ls -l /opt/notes /opt/notes/releases"', check: t => t.ran(/ls\b.*\/opt\/notes/) },
          { title: 'Copy the 2.1.0 tarball from `~/releases/` to `/tmp/` on web1', solution: 'scp ~/releases/notes-2.1.0.tar.gz ubuntu@web1:/tmp/', check: t => t.exists('web1', '/tmp/notes-2.1.0.tar.gz') },
          { title: 'On web1, unpack it as the `notes` user into `/opt/notes/releases/2.1.0`', hint: '`sudo -u notes mkdir -p /opt/notes/releases/2.1.0 && sudo -u notes tar -xzf /tmp/notes-2.1.0.tar.gz -C /opt/notes/releases/2.1.0`', solution: 'ssh ubuntu@web1 "sudo -u notes mkdir -p /opt/notes/releases/2.1.0 && sudo -u notes tar -xzf /tmp/notes-2.1.0.tar.gz -C /opt/notes/releases/2.1.0"', check: t => /2\.1\.0/.test(t.file('web1', '/opt/notes/releases/2.1.0/server.js') || '') && t.owner('web1', '/opt/notes/releases/2.1.0/server.js') === 'notes' },
          { title: 'Switch `current` to 2.1.0 atomically, restart, and verify with the health check', hint: '`cd /opt/notes && sudo -u notes ln -sfn releases/2.1.0 current && sudo systemctl restart notes && curl -s localhost:4000/health`', solution: 'ssh ubuntu@web1 "cd /opt/notes && sudo -u notes ln -sfn releases/2.1.0 current && sudo systemctl restart notes && curl -s localhost:4000/health"', check: t => /releases\/2\.1\.0$/.test(t.linkTarget('web1', '/opt/notes/current') || '') && /"version":"2\.1\.0"/.test(t.http('web1', 'http://localhost:4000/health').body || '') },
          { title: 'Now deploy 2.2.0 the same way (copy, unpack, switch, restart)', solution: 'scp ~/releases/notes-2.2.0.tar.gz ubuntu@web1:/tmp/ && ssh ubuntu@web1 "sudo -u notes mkdir -p /opt/notes/releases/2.2.0 && sudo -u notes tar -xzf /tmp/notes-2.2.0.tar.gz -C /opt/notes/releases/2.2.0 && cd /opt/notes && sudo -u notes ln -sfn releases/2.2.0 current && sudo systemctl restart notes"', check: t => /releases\/2\.2\.0$/.test(t.linkTarget('web1', '/opt/notes/current') || '') && t.ran(/systemctl\s+restart\s+notes/) && hist(t, /2\.2\.0/) >= 0 },
          { title: 'The health check fails. Find out why in the service\'s logs', solution: 'ssh ubuntu@web1 "curl -s localhost:4000/health; journalctl -u notes -n 15"', check: t => t.ran(/journalctl\b.*-u\s+notes/) && hist(t, /journalctl\b.*-u\s+notes/) > hist(t, /ln\s+-sfn\s+releases\/2\.2\.0/) },
          { title: 'Roll back to 2.1.0 and confirm the health check passes again', solution: 'ssh ubuntu@web1 "cd /opt/notes && sudo -u notes ln -sfn releases/2.1.0 current && sudo systemctl restart notes && curl -s localhost:4000/health"', check: t => /releases\/2\.1\.0$/.test(t.linkTarget('web1', '/opt/notes/current') || '') && t.active('web1', 'notes') && /"version":"2\.1\.0"/.test(t.http('web1', 'http://localhost:4000/health').body || '') && t.after(e => e.type === 'symlink' && /2\.2\.0/.test(e.target), e => e.type === 'symlink' && /2\.1\.0/.test(e.target)) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why deploy into a new release folder instead of updating files in place?', choices: ['It uses less disk', 'The running version is never half-updated, and rollback is switching a pointer back', 'It is required by systemd', 'It makes the app faster'], answer: 1, explain: 'Atomic switch, instant rollback.' },
        { type: 'mc', q: 'Why does `ln -sfn releases/2.1.0 current` need `-n`?', choices: ['It makes the link hidden', 'Without it, ln follows the existing current link into the old release and creates the new link inside it', 'It creates a hard link', 'It is optional decoration'], answer: 1, explain: '-n treats the existing link as a plain file to replace.' },
        { type: 'mc', q: 'Where should secrets like APP_SECRET live in a release layout?', choices: ['Inside every release folder', 'In a shared folder outside the releases, with mode 600, loaded via EnvironmentFile', 'In the git repository', 'In the symlink name'], answer: 1, explain: 'Releases are replaceable; config persists.' },
        { type: 'order', q: 'Order a safe manual release.', items: ['Copy the artifact to the server', 'Unpack it into a new release folder', 'Switch the current symlink', 'Restart the service', 'Check the health endpoint (roll back if it fails)'], explain: 'The health check decides.' },
        { type: 'tf', q: 'If `systemctl restart` returns without an error, the new version is working.', answer: false, explain: 'It only means the start was requested; check health and logs.' },
        { type: 'mc', q: 'A new version crashes at start with "PAYMENTS_KEY is required". Best immediate action?', choices: ['Debug in production while it is down', 'Roll back to the previous release, then add the missing setting to shared config before redeploying', 'Delete the old releases', 'Reboot the server'], answer: 1, explain: 'Restore service first.' },
      ],
    },
    {
      id: 'logs-cron',
      title: 'Logs, rotation and scheduled jobs',
      summary: 'journalctl filters, /var/log, logrotate (copytruncate), crontab syntax, and proving a job actually runs.',
      minutes: 24,
      lab: {
        startOn: { host: 'web1', user: 'ubuntu' },
        cwd: '~',
        panels: ['system', 'files'],
        setup(H) {
          notesHost(H, 'web1', { asService: true });
          H.mkdir('web1', '/var/log/notes', { owner: 'notes' });
          H.fakeSize('web1', '/var/log/notes/notes.log', 2 * GB);
          H.host('web1').setMeta('/var/log/notes/notes.log', { owner: 'notes', group: 'notes' });
          for (const p of H.host('web1').procs.values()) if (p.unit === 'notes.service') p.openFiles = ['/var/log/notes/notes.log'];
          H.log('web1', 'notes.service', 'ERROR db timeout after 3000ms (GET /notes/17)', { prio: 'err', ago: 1800 });
          H.log('web1', 'notes.service', 'ERROR db timeout after 3000ms (GET /notes/4)', { prio: 'err', ago: 900 });
          H.write('web1', '/opt/notes/data/notes.db', 'SQLite format 3\n');
          H.write('web1', '/usr/local/bin/notes-backup.sh', '#!/bin/bash\nset -euo pipefail\nmkdir -p /var/backups/notes\nfile=/var/backups/notes/notes-$(date +%F-%H%M).tar.gz\ntar -czf "$file" /opt/notes/data\necho "backup ok: $file"\n', { mode: 0o755 });
        },
        suggestions: ['journalctl -u notes -p err --since today', 'ls -lh /var/log/notes'],
        tasks: [
          { title: 'Show only today\'s errors from the notes service', solution: 'journalctl -u notes -p err --since today', check: t => t.ran(/journalctl\b.*-u\s+notes\b.*-p\s+err|journalctl\b.*-p\s+err.*-u\s+notes/) },
          { title: 'Look at the app\'s own log folder: how big is notes.log?', solution: 'ls -lh /var/log/notes', check: t => t.ran(/\b(ls|du)\b.*\/var\/log\/notes/) },
          { title: 'Create `/etc/logrotate.d/notes`: daily, keep 14, compress (delayed), missingok, notifempty, and copytruncate (the app keeps the file open)', solution: 'sudo nano /etc/logrotate.d/notes', test: [{ cmd: 'sudo nano /etc/logrotate.d/notes', edit: '/var/log/notes/*.log {\n    daily\n    rotate 14\n    compress\n    delaycompress\n    missingok\n    notifempty\n    copytruncate\n}\n' }], check: t => { const f = t.file('web1', '/etc/logrotate.d/notes') || ''; return /\/var\/log\/notes\//.test(f) && /rotate\s+14/.test(f) && /copytruncate/.test(f) && /compress/.test(f); } },
          { title: 'Dry-run it first (`-d`) to see what logrotate would do', solution: 'sudo logrotate -d /etc/logrotate.d/notes', check: t => t.ran(/logrotate\b.*-d\b/) },
          { title: 'Force a rotation now and check the folder again', solution: 'sudo logrotate -f /etc/logrotate.d/notes && ls -lh /var/log/notes', check: t => !t.host('web1').fakeSizes.has('/var/log/notes/notes.log') && t.exists('web1', '/var/log/notes/notes.log.1') },
          { title: 'Run the backup script once by hand to make sure it works', solution: 'sudo /usr/local/bin/notes-backup.sh', check: t => [...t.host('web1').files.keys()].some(p => /^\/var\/backups\/notes\/notes-.*\.tar\.gz$/.test(p)) },
          { title: 'Schedule it every 5 minutes in root\'s crontab, appending output to `/var/log/notes-backup.log`', hint: '`sudo crontab -e`, then: `*/5 * * * * /usr/local/bin/notes-backup.sh >> /var/log/notes-backup.log 2>&1`', solution: 'sudo crontab -e', test: [{ cmd: 'sudo crontab -e', edit: c => c + '*/5 * * * * /usr/local/bin/notes-backup.sh >> /var/log/notes-backup.log 2>&1\n' }], check: t => /^\s*\*\/5\s+\*\s+\*\s+\*\s+\*\s+\/usr\/local\/bin\/notes-backup\.sh\b.*>>\s*\/var\/log\/notes-backup\.log/m.test(t.cron('web1', 'root')) },
          { title: 'Prove it runs: wait (`sleep 600`), then read the backup log', solution: 'sleep 600 && cat /var/log/notes-backup.log', check: t => (t.file('web1', '/var/log/notes-backup.log') || '').split('backup ok').length > 2 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'An app keeps its log file open forever. Which logrotate option is safe for it?', choices: ['create', 'copytruncate', 'nocompress', 'olddir'], answer: 1, explain: 'Copy, then truncate in place; the app keeps writing to the same file.' },
        { type: 'predict', q: 'When does this crontab line run?', code: '30 2 * * 1  /usr/local/bin/report.sh', choices: ['Every 30 minutes', 'At 02:30 every Monday', 'At 01:30 every day', 'On the 2nd of every month'], answer: 1, explain: 'minute hour day-of-month month day-of-week.' },
        { type: 'mc', q: 'A script works in your shell but fails from cron. The most common reason?', choices: ['cron is slower', 'cron runs with a minimal environment: different PATH, no .bashrc, different working directory', 'cron cannot run bash', 'The script is too long'], answer: 1, explain: 'Use absolute paths and set what you need.' },
        { type: 'multi', q: 'How do you make sure a nightly backup really works?', choices: ['Send its output to a log you check or monitor', 'Alert when no successful run was reported in the last ~26 hours', 'Regularly test restoring a backup', 'Trust it because it is in the crontab'], answer: [0, 1, 2], explain: 'A backup you never restored is a hope.' },
        { type: 'type', q: 'Type the cron schedule (just the five fields) for "every 15 minutes".', accept: ['*/15 * * * *'], model: '*/15 * * * *', explain: '*/15 in the minute field.' },
        { type: 'tf', q: '`logrotate -d` changes nothing; it only shows what would happen.', answer: true, explain: 'Always dry-run new rotation configs.' },
      ],
    },
    {
      id: 'services-boss',
      title: 'Boss: Ship the shop',
      summary: 'From a bare server to production: user, release, env file, systemd, nginx, HTTPS, firewall and backups.',
      minutes: 35,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        setup(H) {
          H.server('shop1', { ip: '10.0.0.40' });
          H.authorize('laptop', 'dev', 'shop1', 'ubuntu');
          H.dns('shop.lumen.example.com', 'shop1');
          H.write('laptop', '~/releases/shop-1.0.0.tar.gz', tarball({ 'server.js': SHOP_APP, 'package.json': '{"name":"shop","version":"1.0.0"}\n', 'node_modules/express/package.json': '{"name":"express"}\n' }), { owner: 'dev' });
          H.write('shop1', '/usr/local/bin/shop-backup.sh', '#!/bin/bash\nset -euo pipefail\nmkdir -p /var/backups/shop\ntar -czf /var/backups/shop/shop-$(date +%F).tar.gz /opt/shop/shared\necho "shop backup ok"\n', { mode: 0o755 });
        },
        suggestions: ['ssh ubuntu@shop1'],
        tasks: [
          { title: 'On shop1, install nginx, Node.js and certbot (with its nginx plugin)', solution: 'ssh ubuntu@shop1', test: ['ssh ubuntu@shop1', 'sudo apt update && sudo apt install -y nginx nodejs certbot python3-certbot-nginx'], check: t => ['nginx', 'nodejs', 'certbot', 'python3-certbot-nginx'].every(p => t.pkg('shop1', p)) },
          { title: 'Create a system user `shop` and the layout `/opt/shop/{releases,shared}` owned by it', solution: 'sudo useradd --system --no-create-home --shell /usr/sbin/nologin shop && sudo mkdir -p /opt/shop/releases /opt/shop/shared && sudo chown -R shop:shop /opt/shop', check: t => t.userExists('shop1', 'shop') && ['/opt/shop/releases', '/opt/shop/shared'].every(p => t.stat('shop1', p)?.type === 'dir' && t.owner('shop1', p) === 'shop') },
          { title: 'Upload release 1.0.0 from your laptop and unpack it into `/opt/shop/releases/1.0.0`; point `current` at it', solution: 'exit', test: ['exit', 'scp ~/releases/shop-1.0.0.tar.gz ubuntu@shop1:/tmp/', 'ssh ubuntu@shop1 "sudo -u shop mkdir -p /opt/shop/releases/1.0.0 && sudo -u shop tar -xzf /tmp/shop-1.0.0.tar.gz -C /opt/shop/releases/1.0.0 && cd /opt/shop && sudo -u shop ln -sfn releases/1.0.0 current"', 'ssh ubuntu@shop1'], check: t => t.exists('shop1', '/opt/shop/releases/1.0.0/server.js') && /releases\/1\.0\.0$/.test(t.linkTarget('shop1', '/opt/shop/current') || '') },
          { title: 'Create `/opt/shop/shared/shop.env` (PORT=5000, SHOP_CURRENCY=EUR), owned by shop, mode 600', solution: 'printf "PORT=5000\\nSHOP_CURRENCY=EUR\\n" | sudo -u shop tee /opt/shop/shared/shop.env > /dev/null && sudo chmod 600 /opt/shop/shared/shop.env', check: t => { const f = t.file('shop1', '/opt/shop/shared/shop.env') || ''; return /PORT=5000/.test(f) && /SHOP_CURRENCY=\w+/.test(f) && (t.mode('shop1', '/opt/shop/shared/shop.env') & 0o077) === 0 && t.owner('shop1', '/opt/shop/shared/shop.env') === 'shop'; } },
          { title: 'Write `shop.service` (User=shop, EnvironmentFile, current release, Restart=on-failure) and start it at boot and now', solution: 'sudo nano /etc/systemd/system/shop.service', test: [{ cmd: 'sudo nano /etc/systemd/system/shop.service', edit: '[Unit]\nDescription=Lumen merch shop\nAfter=network.target\n\n[Service]\nUser=shop\nWorkingDirectory=/opt/shop/current\nEnvironmentFile=/opt/shop/shared/shop.env\nExecStart=/usr/bin/node /opt/shop/current/server.js\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n' }, 'sudo systemctl daemon-reload && sudo systemctl enable --now shop'], check: t => t.active('shop1', 'shop') && t.enabled('shop1', 'shop') && !!t.listening('shop1', 5000) && /EnvironmentFile=/.test(t.file('shop1', '/etc/systemd/system/shop.service') || '') },
          { title: 'Publish it with nginx at `shop.lumen.example.com` (proxy to 127.0.0.1:5000), test the config and reload', solution: 'sudo nano /etc/nginx/sites-available/shop', test: [{ cmd: 'sudo nano /etc/nginx/sites-available/shop', edit: 'server {\n    listen 80;\n    server_name shop.lumen.example.com;\n\n    location / {\n        proxy_pass http://127.0.0.1:5000;\n        proxy_set_header Host $host;\n    }\n}\n' }, 'sudo ln -s /etc/nginx/sites-available/shop /etc/nginx/sites-enabled/ && sudo rm /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl reload nginx'], check: t => t.http('laptop', 'http://shop.lumen.example.com/').status === 200 && /merch/.test(t.http('laptop', 'http://shop.lumen.example.com/').body || '') },
          { title: 'Firewall: allow only SSH and the web, then enable it', solution: "sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable", check: t => t.fw('shop1').enabled && t.reach('laptop', 'shop1', 22).error === undefined && t.reach('laptop', 'shop1', 80).error === undefined && t.reach('laptop', 'shop1', 5000).error },
          { title: 'Get a Let\'s Encrypt certificate for shop.lumen.example.com with redirect to HTTPS', solution: 'sudo certbot --nginx -d shop.lumen.example.com --non-interactive --agree-tos -m ops@lumen.example.com --redirect', check: t => t.events('certbot').some(e => e.domains.includes('shop.lumen.example.com')) && t.http('laptop', 'https://shop.lumen.example.com/').status === 200 },
          { title: 'Schedule `/usr/local/bin/shop-backup.sh` nightly at 02:30 in root\'s crontab, with output to `/var/log/shop-backup.log`', solution: 'sudo crontab -e', test: [{ cmd: 'sudo crontab -e', edit: c => c + '30 2 * * * /usr/local/bin/shop-backup.sh >> /var/log/shop-backup.log 2>&1\n' }], check: t => /^\s*30\s+2\s+\*\s+\*\s+\*\s+\/usr\/local\/bin\/shop-backup\.sh\b.*>>/m.test(t.cron('shop1', 'root')) },
          { title: 'Launch check from your laptop: HTTPS answers 200 and HTTP redirects', solution: 'exit', test: ['exit', 'curl -I https://shop.lumen.example.com/', 'curl -I http://shop.lumen.example.com/'], check: t => t.events('http').some(e => e.host === 'laptop' && /^https:\/\/shop\.lumen/.test(e.url) && e.status === 200) && t.events('http').some(e => e.host === 'laptop' && /^http:\/\/shop\.lumen/.test(e.url) && e.status === 301) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the launch steps for a new service.', items: ['Create a service user and the release layout', 'Install the release and shared config', 'Write and enable the systemd unit', 'Put nginx in front and test it', 'Lock down the firewall', 'Add HTTPS and verify from outside'], explain: 'Inside out, then verify outside in.' },
        { type: 'mc', q: 'The shop service fails at start with "SHOP_CURRENCY is not set". Where should the fix go?', choices: ['Hard-code it in server.js', 'Into /opt/shop/shared/shop.env, loaded by EnvironmentFile=', 'Into ~/.bashrc of the ubuntu user', 'Into nginx'], answer: 1, explain: 'systemd does not read anyone\'s .bashrc.' },
        { type: 'multi', q: 'Which make this server safer?', choices: ['App listens on 127.0.0.1 behind nginx', 'Firewall allows only 22, 80 and 443', 'Secrets file mode 600 owned by the service user', 'Running the app as root for simplicity'], answer: [0, 1, 2], explain: 'Least privilege, least exposure.' },
        { type: 'tf', q: 'Certbot needs port 80 reachable for the HTTP-01 challenge, even if you redirect everything to HTTPS.', answer: true, explain: 'The redirect block still answers the challenge path.' },
        { type: 'mc', q: 'What should a launch check always include?', choices: ['A test from the server itself only', 'A test from outside, through DNS, TLS and the proxy, exactly as users arrive', 'A reboot', 'Reading the source code'], answer: 1, explain: 'Users do not come from localhost.' },
      ],
    },
  ],
};
