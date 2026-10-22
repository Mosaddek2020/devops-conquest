// Realm 2 · Networking for DevOps: IPs, ports, DNS, HTTP, SSH, firewalls, TLS.

import { makeCertPem } from '../sim/net.js';

const hist = (t, re) => { let k = -1; t.history.forEach((l, i) => { if (re.test(l)) k = i; }); return k; };
const httpTo = (t, re, pred = () => true) => t.events('http').some(e => re.test(e.url) && pred(e));

const EVENTS = [
  { id: 42, name: 'Jazz at the Docks', date: '2026-02-14', seats_left: 12 },
  { id: 43, name: 'Hamlet (open air)', date: '2026-02-20', seats_left: 0 },
  { id: 44, name: 'Stand-up Night', date: '2026-02-21', seats_left: 57 },
];
const TOKEN = 'lt_9f2c41e07b';

function nodeApp(port, bind) {
  return `const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || ${port};\napp.get('/health', (req, res) => res.json({ status: 'ok', service: 'events-api' }));\napp.get('/', (req, res) => res.send('Lumen events: tonight, 3 shows'));\napp.listen(PORT${bind ? `, '${bind}'` : ''}, () => console.log(\`events-api listening on \${PORT}\`));\n`;
}

function webSetup(H, host, { port = 3000, unit = 'events', bind = null } = {}) {
  H.install(host, 'nginx', 'nodejs');
  H.user(host, 'app', { shell: '/usr/sbin/nologin' });
  H.mkdir(host, '/opt/events/node_modules/express', { owner: 'app' });
  H.write(host, '/opt/events/server.js', nodeApp(port, bind), { owner: 'app' });
  H.service(host, unit, `[Unit]\nDescription=Lumen events app\nAfter=network.target\n\n[Service]\nUser=app\nWorkingDirectory=/opt/events\nEnvironment=PORT=${port}\nExecStart=/usr/bin/node server.js\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n`);
}

export default {
  id: 'network',
  n: 2,
  title: 'Networking for DevOps',
  tagline: 'IPs, ports, DNS, HTTP, SSH, firewalls and TLS',
  badge: 'Network Navigator',
  intro: 'Every outage eventually becomes a networking question: does the name resolve, can packets get there, is anything listening, is the certificate valid? Learn **IPs, ports and DNS**, speak **HTTP** with curl, work over **SSH** with keys, build **firewalls** without locking yourself out, and keep **HTTPS** working.',
  lessons: [
    {
      id: 'ip-ports-dns',
      title: 'IPs, ports and DNS',
      summary: 'Addresses, ports, 127.0.0.1 vs 0.0.0.0, DNS records and TTLs, /etc/hosts, refused vs timed out.',
      minutes: 22,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        laptopPackages: ['nodejs', 'redis-server', 'dnsutils'],
        setup(H) {
          H.mkdir('laptop', '/home/dev/dev/api/node_modules/express', { owner: 'dev' });
          H.write('laptop', '~/dev/api/server.js', nodeApp(3000), { owner: 'dev' });
          H.run('cd ~/dev/api && node server.js > /tmp/api.log 2>&1 &', { on: 'laptop' });
          const api = H.server('api', { ip: '10.0.0.12' });
          H.install('api', 'nginx');
          H.dnsRecord('api.lumen.example.com', 'A', api.ip);
          H.dnsRecord('lumen.example.com', 'A', api.ip);
          H.dnsRecord('www.lumen.example.com', 'CNAME', 'lumen.example.com');
          H.dnsRecord('lumen.example.com', 'MX', '10 mail.lumen.example.com.');
          const db = H.server('db', { ip: '10.0.0.20' });
          H.install('db', 'postgresql');
          H.dnsRecord('db.lumen.internal', 'A', db.ip);
          const cache = H.server('cache', { ip: '10.0.0.30' });
          H.install('cache', 'redis-server');
          H.write('cache', '/etc/redis/redis.conf', 'bind 0.0.0.0\nport 6379\nprotected-mode no\n');
          H.run('sudo systemctl restart redis-server && sudo ufw allow OpenSSH && sudo ufw enable', { on: 'cache' });
          H.dnsRecord('cache.lumen.internal', 'A', cache.ip);
          const st = H.server('staging', { ip: '10.0.0.50' });
          H.install('staging', 'nginx');
          void st;
        },
        suggestions: ['ip a', 'sudo ss -tlnp'],
        tasks: [
          { title: 'Find your laptop\'s IP address', hint: '`ip a` (look for inet on eth0).', solution: 'ip a', check: t => t.ran(/^ip\s+(a|addr|address)\b/) },
          { title: 'List the TCP ports listening on your laptop, with their processes', solution: 'sudo ss -tlnp', check: t => t.ran(/\b(ss|netstat)\b.*-[a-z]*l/) },
          { title: 'Your dev API listens on port 3000. Check it answers: `curl localhost:3000/health`', solution: 'curl localhost:3000/health', check: t => httpTo(t, /localhost:3000\/health|127\.0\.0\.1:3000\/health/, e => e.status === 200) },
          { title: 'Resolve `api.lumen.example.com` to its address', solution: 'dig +short api.lumen.example.com', check: t => t.events('dns').some(e => e.name === 'api.lumen.example.com') || t.ran(/\b(nslookup|host)\b.*api\.lumen/) },
          { title: 'Look up `www.lumen.example.com` with full output: what kind of record is it?', solution: 'dig www.lumen.example.com', check: t => t.ran(/\bdig\b(?!.*\+short).*www\.lumen\.example\.com|\bnslookup\b.*www\.lumen|\bhost\b.*www\.lumen/) },
          { title: 'Test PostgreSQL on the database server: `nc -zv db.lumen.internal 5432`. Read how it fails', hint: 'Refused: the machine answered, but nothing listens there for you (postgres listens on localhost only).', solution: 'nc -zv db.lumen.internal 5432', check: t => t.events('tcp-check').some(e => e.target === 'db.lumen.internal' && e.port === 5432 && e.error === 'ECONNREFUSED') },
          { title: 'Now test Redis on the cache server: `nc -zv -w 3 cache.lumen.internal 6379`. How is this failure different?', hint: 'Timed out: a firewall silently dropped the packets.', solution: 'nc -zv -w 3 cache.lumen.internal 6379', check: t => t.events('tcp-check').some(e => e.target === 'cache.lumen.internal' && e.port === 6379 && e.error === 'ETIMEDOUT') },
          { title: 'Staging (10.0.0.50) has no DNS name yet. Add `staging.lumen.internal` to /etc/hosts and reach it by name', hint: '`echo "10.0.0.50 staging.lumen.internal" | sudo tee -a /etc/hosts`, then `curl -I http://staging.lumen.internal`.', solution: 'echo "10.0.0.50 staging.lumen.internal" | sudo tee -a /etc/hosts && curl -I http://staging.lumen.internal', check: t => /10\.0\.0\.50\s+.*staging\.lumen\.internal/.test(t.file('laptop', '/etc/hosts') || '') && (httpTo(t, /staging\.lumen\.internal/, e => e.status === 200) || t.events('ping').some(e => e.target === 'staging.lumen.internal' && e.ok)) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'An app listens on 127.0.0.1:8080. Who can connect to it?', choices: ['Anyone on the internet', 'Only programs on the same machine', 'Only machines in the same network', 'Nobody'], answer: 1, explain: '127.0.0.1 is the loopback interface. 0.0.0.0 means all interfaces.' },
        { type: 'mc', q: '`curl` says "Connection refused". What is most likely?', choices: ['The DNS name does not exist', 'A firewall dropped the packets', 'The host is reachable but nothing listens on that port (for you)', 'The certificate expired'], answer: 2, explain: 'Refused is an active answer from the host.' },
        { type: 'mc', q: '`curl` hangs, then says "Timed out". What is most likely?', choices: ['Nothing listens on the port', 'A firewall or security group is dropping the packets, or the host is down', 'A typo in the path', 'HTTP 500'], answer: 1, explain: 'Silence means the packets never got an answer.' },
        { type: 'mc', q: 'You will move a service to a new IP tomorrow. What should you do with its DNS record today?', choices: ['Delete it', 'Lower its TTL so caches pick up the change quickly', 'Raise its TTL', 'Nothing'], answer: 1, explain: 'Resolvers cache answers for the TTL.' },
        { type: 'multi', q: 'Which statements about DNS records are true?', choices: ['A maps a name to an IPv4 address', 'CNAME maps a name to another name', 'MX tells where to deliver mail for a domain', 'TXT records open firewall ports'], answer: [0, 1, 2], explain: 'TXT holds text: verification tokens, SPF and so on.' },
        { type: 'tf', q: 'Entries in /etc/hosts are checked before DNS.', answer: true, explain: 'Useful for tests, confusing when forgotten.' },
        { type: 'type', q: 'Type the command that shows listening TCP ports with the owning processes.', accept: ['sudo ss -tlnp', 'ss -tlnp', 'sudo ss -tulpn', 'sudo ss -ltnp', 'sudo netstat -tlnp', 'ss -ltnp'], model: 'sudo ss -tlnp', explain: '-t TCP, -l listening, -n numeric, -p processes (needs sudo to see all).' },
      ],
    },
    {
      id: 'http-curl',
      title: 'HTTP and curl',
      summary: 'Methods, status codes, headers, redirects and JSON APIs, all from the terminal.',
      minutes: 20,
      lab: {
        cwd: '~',
        panels: ['network', 'files'],
        laptopPackages: ['jq'],
        setup(H) {
          H.write('laptop', '~/api-token.txt', TOKEN + '\n', { owner: 'dev', mode: 0o600 });
          H.site('api.lumen.example.com', {
            '/v1/health': { body: '{"status":"ok"}\n' },
            '/v1/events': { body: JSON.stringify(EVENTS, null, 2) + '\n' },
            '/v1/events/42': { body: JSON.stringify(EVENTS[0], null, 2) + '\n' },
            '/events': { status: 301, headers: { location: 'https://api.lumen.example.com/v1/events' }, body: 'Moved Permanently\n' },
            '/v1/tickets': (req) => {
              if (req.method !== 'POST') return { status: 405, body: '{"error":"use POST to buy tickets"}\n' };
              if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: '{"error":"missing or invalid token"}\n' };
              let b; try { b = JSON.parse(req.body || ''); } catch { return { status: 400, body: '{"error":"body must be JSON like {\\"event\\": 42, \\"seats\\": 2}"}\n' }; }
              if (!b.event || !b.seats) return { status: 400, body: '{"error":"event and seats are required"}\n' };
              return { status: 201, body: JSON.stringify({ ticket: 'T-9912', event: b.event, seats: b.seats }) + '\n' };
            },
          });
        },
        suggestions: ['curl -i https://api.lumen.example.com/v1/events'],
        tasks: [
          { title: 'List the events with the status line and headers: `curl -i …/v1/events`', solution: 'curl -i https://api.lumen.example.com/v1/events', check: t => httpTo(t, /\/v1\/events$/, e => e.status === 200) && t.ran(/curl\b.*-[a-zA-Z]*i\b.*\/v1\/events/) },
          { title: 'Print only the event names, using `-s` and piping into `jq -r \'.[].name\'`', solution: "curl -s https://api.lumen.example.com/v1/events | jq -r '.[].name'", check: t => t.ran(/curl\b.*\/v1\/events.*\|\s*jq\b.*name/) },
          { title: 'The old URL `/events` still exists. Look at its headers only: where does it point?', solution: 'curl -I https://api.lumen.example.com/events', check: t => httpTo(t, /\/events$/, e => e.status === 301) && t.ran(/curl\b.*-[a-zA-Z]*I/) },
          { title: 'Follow the redirect automatically with `-L`', solution: 'curl -sL https://api.lumen.example.com/events', check: t => t.ran(/curl\b.*-[a-zA-Z]*L.*\/events\b/) && t.after(e => e.type === 'http' && /\/events$/.test(e.url) && e.status === 301, e => e.type === 'http' && /\/v1\/events$/.test(e.url) && e.status === 200) },
          { title: 'Try to buy 2 seats for event 42 with a POST to `/v1/tickets` without a token. Read the status code', solution: `curl -i -X POST -d '{"event":42,"seats":2}' https://api.lumen.example.com/v1/tickets`, check: t => t.events('http').some(e => /\/v1\/tickets/.test(e.url) && e.method === 'POST' && e.status === 401) },
          { title: 'Now send the token from `~/api-token.txt` as `Authorization: Bearer <token>` and get a 201', hint: '`-H "Authorization: Bearer $(cat ~/api-token.txt)"` reads it from the file so it never lands in your history.', solution: `curl -i -X POST -H "Authorization: Bearer $(cat ~/api-token.txt)" -H "Content-Type: application/json" -d '{"event":42,"seats":2}' https://api.lumen.example.com/v1/tickets`, check: t => t.events('http').some(e => /\/v1\/tickets/.test(e.url) && e.status === 201) },
          { title: 'For a script, print only the status code of `/v1/health`', hint: '`curl -s -o /dev/null -w "%{http_code}\\n" URL`', solution: 'curl -s -o /dev/null -w "%{http_code}\\n" https://api.lumen.example.com/v1/health', check: t => t.ran(/-w\s+["']?%\{http_code\}/) && httpTo(t, /\/v1\/health/, e => e.status === 200) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Which status code range means the client sent a bad or unauthorised request?', choices: ['2xx', '3xx', '4xx', '5xx'], answer: 2, explain: '5xx means the server failed.' },
        { type: 'mc', q: 'nginx returns 502 Bad Gateway. Where is the problem most likely?', choices: ['The browser', 'nginx\'s upstream: the app behind it is down or unreachable', 'DNS', 'The certificate'], answer: 1, explain: 'The proxy works; what it forwards to does not.' },
        { type: 'mc', q: 'What does `curl -L` do?', choices: ['Shows only headers', 'Follows redirects (3xx with a Location header)', 'Logs to a file', 'Limits the rate'], answer: 1, explain: 'Without -L, curl stops at the 301.' },
        { type: 'multi', q: 'Which are safe ways to send an API token with curl in a script?', choices: ['-H "Authorization: Bearer $TOKEN" with TOKEN read from a protected file or secret store', 'Typing the literal token on the command line in a shared terminal', '-H "Authorization: Bearer $(cat ~/token.txt)" with the file mode 600', 'Putting the token in the URL query string of a logged request'], answer: [0, 2], explain: 'Literal tokens end up in shell history and logs.' },
        { type: 'predict', q: 'What does this print for a healthy endpoint?', code: '$ curl -s -o /dev/null -w "%{http_code}" https://api.example.com/health', choices: ['The JSON body', '200', 'Nothing', 'HTTP/1.1 200 OK'], answer: 1, explain: '-o /dev/null discards the body; -w prints the code.' },
        { type: 'tf', q: 'An API can return a JSON error body together with status 200, so you should check the status code, not just the body.', answer: true, explain: 'Badly behaved APIs exist; status codes are the contract.' },
        { type: 'type', q: 'Type the curl command that shows only the response headers of https://example.com.', accept: ['curl -I https://example.com', 'curl --head https://example.com', 'curl -sI https://example.com', 'curl -Is https://example.com'], model: 'curl -I https://example.com', explain: '-I sends a HEAD request.' },
      ],
    },
    {
      id: 'ssh-keys',
      title: 'SSH and keys',
      summary: 'Key pairs, authorized_keys, ssh-copy-id, ~/.ssh/config, scp, and the permissions SSH insists on.',
      minutes: 22,
      lab: {
        cwd: '~',
        panels: ['network', 'files'],
        setup(H) {
          const web = H.server('web1', { ip: '10.0.0.11' });
          web.passwordAuth = true;
          H.write('laptop', '~/release-notes.md', '# Release 2.4\n- faster seat picker\n', { owner: 'dev' });
          // a teammate's deploy key, saved with the wrong permissions
          H.mkdir('laptop', '/home/dev/.ssh', { owner: 'dev', mode: 0o700 });
          H.write('laptop', '/home/dev/.ssh/deploy_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\n', { owner: 'dev', mode: 0o644 });
          const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIdeployKeyForWeb1 deploy@lumen\n';
          H.write('laptop', '/home/dev/.ssh/deploy_key.pub', pub, { owner: 'dev', mode: 0o644 });
          H.user('web1', 'deploy');
          H.mkdir('web1', '/home/deploy/.ssh', { owner: 'deploy', mode: 0o700 });
          H.write('web1', '/home/deploy/.ssh/authorized_keys', pub, { owner: 'deploy', mode: 0o600 });
        },
        suggestions: ['ls -la ~/.ssh', 'ssh-keygen -t ed25519'],
        tasks: [
          { title: 'Create your own key pair (ed25519)', hint: '`ssh-keygen -t ed25519 -C "dev@lumen"`. In real life, add a passphrase.', solution: 'ssh-keygen -t ed25519 -C "dev@lumen"', check: t => t.exists('laptop', '/home/dev/.ssh/id_ed25519') && t.exists('laptop', '/home/dev/.ssh/id_ed25519.pub') },
          { title: 'Install your public key on web1 for the user `ubuntu`', solution: 'ssh-copy-id ubuntu@web1', check: t => { const k = (t.file('laptop', '/home/dev/.ssh/id_ed25519.pub') || '').trim(); return !!k && (t.file('web1', '/home/ubuntu/.ssh/authorized_keys') || '').includes(k.split(' ')[1]); } },
          { title: 'Log in to web1', solution: 'ssh ubuntu@web1', check: t => t.events('ssh').some(e => e.to === 'web1' && e.user === 'ubuntu' && !e.cmd) },
          { title: 'On web1, look at the authorized keys file, then `exit` back to your laptop', solution: 'cat ~/.ssh/authorized_keys', test: ['cat ~/.ssh/authorized_keys', 'exit'], check: t => t.ran(/\bcat\b.*authorized_keys/) && t.here.name === 'laptop' && hist(t, /^exit\b|^logout\b/) > hist(t, /authorized_keys/) },
          { title: 'Create `~/.ssh/config` with an alias `prod-web` (HostName web1, User ubuntu), then run `ssh prod-web hostname`', hint: 'Lines: `Host prod-web`, `    HostName web1`, `    User ubuntu`', solution: 'nano ~/.ssh/config', test: [{ cmd: 'nano ~/.ssh/config', edit: 'Host prod-web\n    HostName web1\n    User ubuntu\n    IdentityFile ~/.ssh/id_ed25519\n' }, 'ssh prod-web hostname'], check: t => /Host\s+prod-web/.test(t.file('laptop', '/home/dev/.ssh/config') || '') && t.events('ssh').some(e => e.to === 'web1' && /hostname/.test(e.cmd || '')) && t.ran(/ssh\s+prod-web/) },
          { title: 'Copy `~/release-notes.md` to `/tmp/` on web1 using the alias', solution: 'scp ~/release-notes.md prod-web:/tmp/', check: t => /Release 2\.4/.test(t.file('web1', '/tmp/release-notes.md') || '') },
          { title: 'Use the teammate\'s key: `ssh -i ~/.ssh/deploy_key deploy@web1 whoami`. It fails: fix the key\'s permissions and try again', hint: 'Read the warning: the private key must be readable only by you. `chmod 600 ~/.ssh/deploy_key`', solution: 'chmod 600 ~/.ssh/deploy_key && ssh -i ~/.ssh/deploy_key deploy@web1 whoami', test: ['ssh -i ~/.ssh/deploy_key deploy@web1 whoami', 'chmod 600 ~/.ssh/deploy_key', 'ssh -i ~/.ssh/deploy_key deploy@web1 whoami'], check: t => (t.mode('laptop', '/home/dev/.ssh/deploy_key') & 0o077) === 0 && t.events('ssh').some(e => e.to === 'web1' && e.user === 'deploy') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Which file must never leave your laptop?', choices: ['id_ed25519.pub', 'id_ed25519', 'known_hosts', 'config'], answer: 1, explain: 'The private key. The .pub is meant to be shared.' },
        { type: 'mc', q: 'Where does the server look for the public keys allowed to log in as ubuntu?', choices: ['/etc/ssh/keys', '/home/ubuntu/.ssh/authorized_keys', '/root/.ssh/id_rsa', '~/.ssh/known_hosts on your laptop'], answer: 1, explain: 'One public key per line.' },
        { type: 'mc', q: 'SSH says "WARNING: UNPROTECTED PRIVATE KEY FILE! Permissions 0644". The fix?', choices: ['chmod 777 the key', 'chmod 600 the key', 'Delete known_hosts', 'Use a password instead'], answer: 1, explain: 'Only the owner may read a private key.' },
        { type: 'mc', q: 'SSH refuses with "REMOTE HOST IDENTIFICATION HAS CHANGED". What do you do first?', choices: ['Immediately remove the line from known_hosts and reconnect', 'Find out why the server\'s host key changed (rebuilt server? or someone in the middle?)', 'Disable host key checking', 'Reboot your laptop'], answer: 1, explain: 'It is a security alarm, not an annoyance.' },
        { type: 'multi', q: 'Good SSH practices for production servers:', choices: ['One key per person', 'Disable password logins', 'Disable root login', 'Share one team key in a chat channel'], answer: [0, 1, 2], explain: 'Shared keys cannot be revoked per person.' },
        { type: 'type', q: 'Type the command that copies backup.tar.gz into /srv/backups/ on server db1 as user admin.', accept: ['scp backup.tar.gz admin@db1:/srv/backups/', 'scp backup.tar.gz admin@db1:/srv/backups', 'rsync -avz backup.tar.gz admin@db1:/srv/backups/', 'rsync backup.tar.gz admin@db1:/srv/backups/'], model: 'scp backup.tar.gz admin@db1:/srv/backups/', explain: 'user@host:path on the remote side.' },
        { type: 'tf', q: 'With key authentication, your private key is sent to the server at every login.', answer: false, explain: 'The server sends a challenge; your key signs it locally.' },
      ],
    },
    {
      id: 'firewalls',
      title: 'Firewalls and reachability',
      summary: 'Default deny, allow SSH first, allow by source, scan from outside, recover from a lockout.',
      minutes: 22,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        laptopPackages: ['nmap'],
        setup(H) {
          const app = H.server('app1', { ip: '10.0.0.21' });
          const worker = H.server('worker1', { ip: '10.0.0.22' });
          webSetup(H, 'app1', { port: 3000 });
          H.install('app1', 'redis-server');
          H.write('app1', '/etc/redis/redis.conf', 'bind 0.0.0.0\nport 6379\nprotected-mode no\n');
          H.run('sudo systemctl restart redis-server', { on: 'app1' });
          H.install('worker1', 'redis-tools');
          H.authorize('laptop', 'dev', 'app1', 'ubuntu');
          H.authorize('laptop', 'dev', 'worker1', 'ubuntu');
          H.console('app1');
          H.uni.labData.worker = worker.ip;
          void app;
        },
        events(ev, t) {
          if (ev.type === 'ufw-lockout') t.say('[team] app1 stopped answering SSH. Recover with: console app1 (then allow OpenSSH).');
        },
        suggestions: ['nmap app1', 'ssh ubuntu@app1'],
        tasks: [
          { title: 'From your laptop, scan app1 to see what is exposed', solution: 'nmap app1', check: t => t.events('nmap').some(e => e.target === 'app1' && e.open.includes(6379)) },
          { title: 'Log in to app1', solution: 'ssh ubuntu@app1', check: t => t.events('ssh').some(e => e.to === 'app1') || t.events('console').some(e => e.host === 'app1') },
          { title: 'Before anything else, allow SSH', solution: 'sudo ufw allow OpenSSH', check: t => t.fw('app1').rules.some(r => r.action === 'allow' && (r.port === 22 || r.ports?.includes(22)) && (!r.from || r.from === 'any')) },
          { title: 'Allow the website (HTTP and HTTPS)', solution: "sudo ufw allow 'Nginx Full'", check: t => [80, 443].every(p => t.fw('app1').rules.some(r => r.action === 'allow' && (r.port === p || r.ports?.includes(p)))) },
          { title: 'Allow Redis (6379) only from the worker server', hint: t => '', detail: 'The worker\'s IP is 10.0.0.22: `sudo ufw allow from 10.0.0.22 to any port 6379`', solution: 'sudo ufw allow from 10.0.0.22 to any port 6379', check: t => t.fw('app1').rules.some(r => r.action === 'allow' && r.port === 6379 && r.from === t.uni.labData.worker) },
          { title: 'Turn the firewall on and check its status', solution: 'sudo ufw enable && sudo ufw status', check: t => t.fw('app1').enabled && t.fw('app1').defaultIn === 'deny' },
          { title: 'Go back to your laptop and scan again: only SSH and the website should be open', solution: 'exit && nmap app1', test: ['exit', 'nmap app1'], check: t => t.after(e => e.type === 'ufw' && e.action === 'enable', e => e.type === 'nmap' && e.host === 'laptop' && e.target === 'app1' && !e.open.includes(6379) && !e.open.includes(3000) && e.open.includes(80) && e.open.includes(22)) },
          { title: 'Prove the worker still reaches Redis: `ssh ubuntu@worker1 "nc -zv app1 6379"`', solution: 'ssh ubuntu@worker1 "nc -zv app1 6379"', check: t => t.events('tcp-check').some(e => e.host === 'worker1' && e.target === 'app1' && e.port === 6379 && e.ok) },
        ],
      },
      quiz: [
        { type: 'order', q: 'You are connected to a server over SSH. Order the steps to turn on a default-deny firewall safely.', items: ['sudo ufw default deny incoming', 'sudo ufw allow OpenSSH', 'sudo ufw allow the ports the server serves', 'sudo ufw enable', 'Verify from another machine'], explain: 'SSH must be allowed before enabling.' },
        { type: 'mc', q: 'An nmap scan from outside shows port 6379 "filtered". What does that mean?', choices: ['Redis is not installed', 'Packets to that port are being dropped by a firewall', 'Redis has a password', 'The port is open'], answer: 1, explain: 'Filtered = no response, the firewall signature.' },
        { type: 'mc', q: 'Which rule lets only 10.0.0.22 reach PostgreSQL?', choices: ['sudo ufw allow 5432', 'sudo ufw allow from 10.0.0.22 to any port 5432', 'sudo ufw deny from 10.0.0.22', 'sudo ufw allow from any to 10.0.0.22'], answer: 1, explain: 'Restrict internal services by source.' },
        { type: 'mc', q: 'You enabled ufw without allowing SSH and got disconnected. How do you get back in?', choices: ['ssh -f', 'Wait: it resets after an hour', 'Through the cloud provider\'s console or serial access, then allow SSH', 'You cannot; delete the server'], answer: 2, explain: 'Out-of-band access exists for exactly this.' },
        { type: 'tf', q: 'If a database is behind a firewall, it does not need a password.', answer: false, explain: 'Defense in depth: firewalls get misconfigured.' },
        { type: 'mc', q: 'Why scan from another machine rather than from the server itself?', choices: ['It is faster', 'Local connections bypass the host firewall, so you would see everything as open', 'nmap does not run on servers', 'To save money'], answer: 1, explain: 'Test the way an outsider would.' },
        { type: 'type', q: 'Type the command that lists the ufw rules with numbers.', accept: ['sudo ufw status numbered', 'ufw status numbered'], model: 'sudo ufw status numbered', explain: 'Then `sudo ufw delete N` removes one.' },
      ],
    },
    {
      id: 'tls-https',
      title: 'TLS, certificates and HTTPS',
      summary: 'Certificates and CAs, expiry and name checks, openssl, Let\'s Encrypt with certbot, renewal and redirects.',
      minutes: 22,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        setup(H) {
          const web = H.server('web1', { ip: '10.0.0.11' });
          H.install('web1', 'nginx', 'certbot', 'python3-certbot-nginx');
          H.authorize('laptop', 'dev', 'web1', 'ubuntu');
          H.dns('shop.example.com', 'web1');
          const now = H.uni.time;
          H.write('web1', '/etc/ssl/shop/fullchain.pem', makeCertPem({ cn: 'shop.example.com', sans: ['shop.example.com'], issuer: 'DigiCert Global G2', notBefore: now - 365 * 86400, notAfter: now - 6 * 3600 }));
          H.write('web1', '/etc/ssl/shop/privkey.pem', '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
          H.write('web1', '/var/www/shop/index.html', '<h1>Lumen shop</h1>\n');
          H.write('web1', '/etc/nginx/sites-available/shop', 'server {\n    listen 80;\n    listen 443 ssl;\n    server_name shop.example.com;\n\n    ssl_certificate /etc/ssl/shop/fullchain.pem;\n    ssl_certificate_key /etc/ssl/shop/privkey.pem;\n\n    root /var/www/shop;\n    index index.html;\n}\n');
          H.run('sudo ln -s /etc/nginx/sites-available/shop /etc/nginx/sites-enabled/shop && sudo rm /etc/nginx/sites-enabled/default && sudo systemctl reload nginx', { on: 'web1' });
          H.run("sudo ufw allow OpenSSH && sudo ufw allow 443/tcp && sudo ufw enable", { on: 'web1' });
          void web;
        },
        suggestions: ['curl -I https://shop.example.com'],
        tasks: [
          { title: 'Reproduce what customers see: `curl -I https://shop.example.com`', solution: 'curl -I https://shop.example.com', check: t => t.events('http').some(e => /shop\.example\.com/.test(e.url) && e.error === 'TLS') },
          { title: 'Inspect the certificate the server presents (dates, issuer)', hint: '`openssl s_client -connect shop.example.com:443 -servername shop.example.com`', solution: 'openssl s_client -connect shop.example.com:443 -servername shop.example.com', check: t => t.ran(/openssl\s+s_client\b.*shop\.example\.com|curl\b.*-v.*shop\.example\.com/) },
          { title: 'Log in to web1 and ask certbot for a Let\'s Encrypt certificate for shop.example.com', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', 'sudo certbot --nginx -d shop.example.com --non-interactive --agree-tos -m ops@lumen.example.com'], check: t => t.ran(/certbot\b.*--nginx\b.*-d\s+shop\.example\.com/) },
          { title: 'It failed. Read why, fix it, and run certbot again until it succeeds', hint: 'Let\'s Encrypt must reach port 80 for the HTTP-01 challenge, and the firewall only allows 443. `sudo ufw allow 80/tcp` (or \'Nginx Full\').', solution: "sudo ufw allow 'Nginx Full' && sudo certbot --nginx -d shop.example.com --non-interactive --agree-tos -m ops@lumen.example.com", check: t => t.events('certbot').some(e => e.domains.includes('shop.example.com')) },
          { title: 'Check that renewal will work without you: `sudo certbot renew --dry-run`', solution: 'sudo certbot renew --dry-run', check: t => t.ran(/certbot\s+renew\b.*--dry-run/) },
          { title: 'Back on your laptop, confirm HTTPS works: `curl -I https://shop.example.com`', solution: 'exit && curl -I https://shop.example.com', test: ['exit', 'curl -I https://shop.example.com'], check: t => t.after(e => e.type === 'certbot', e => e.type === 'http' && e.host === 'laptop' && /^https:\/\/shop\.example\.com/.test(e.url) && e.status === 200) },
          { title: 'And that plain HTTP now redirects to HTTPS', solution: 'curl -I http://shop.example.com', check: t => t.events('http').some(e => e.host === 'laptop' && /^http:\/\/shop\.example\.com/.test(e.url) && e.status === 301) },
        ],
      },
      quiz: [
        { type: 'multi', q: 'Why would a client reject a certificate?', choices: ['It has expired', 'It was issued for a different hostname', 'It is self-signed / from an unknown CA', 'The server uses port 443'], answer: [0, 1, 2], explain: 'Expiry, name and trust are the three checks.' },
        { type: 'mc', q: 'Let\'s Encrypt\'s HTTP-01 challenge fails with "Timeout during connect (likely firewall problem)". Fix?', choices: ['Use curl -k', 'Allow inbound port 80 so Let\'s Encrypt can fetch the challenge file', 'Buy a longer certificate', 'Restart nginx'], answer: 1, explain: 'The validator connects to http://yourdomain/.well-known/acme-challenge/…' },
        { type: 'mc', q: 'What does `curl -k` do?', choices: ['Fixes certificate errors', 'Skips certificate verification for this request only', 'Renews the certificate', 'Uses HTTP instead of HTTPS'], answer: 1, explain: 'Browsers and other clients still fail. Never leave it in scripts.' },
        { type: 'mc', q: 'Most HTTPS outages are caused by…', choices: ['Broken encryption algorithms', 'Expired certificates', 'Too many users', 'DNS TTLs'], answer: 1, explain: 'Automate renewal and monitor expiry.' },
        { type: 'tf', q: 'Let\'s Encrypt certificates last 90 days, so renewal must be automated.', answer: true, explain: 'certbot installs a timer; test it with renew --dry-run.' },
        { type: 'type', q: 'Type the openssl command that shows the validity dates of cert.pem.', accept: ['openssl x509 -in cert.pem -noout -dates', 'openssl x509 -noout -dates -in cert.pem', 'openssl x509 -in cert.pem -dates -noout'], model: 'openssl x509 -in cert.pem -noout -dates', explain: 'notBefore and notAfter.' },
      ],
    },
    {
      id: 'network-boss',
      title: 'Boss: The site is down',
      summary: 'Fix a stale DNS record, a firewall gap and a broken proxy, working from the outside in.',
      minutes: 30,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        laptopPackages: ['dnsutils'],
        setup(H) {
          const old = H.server('web-old', { ip: '10.0.0.99' });
          old.down = true;
          const w3 = H.server('web3', { ip: '10.0.0.31' });
          webSetup(H, 'web3', { port: 3000, unit: 'events' });
          const now = H.uni.time;
          H.write('web3', '/etc/ssl/events/fullchain.pem', makeCertPem({ cn: 'events.lumen.example.com', sans: ['events.lumen.example.com'], issuer: "Let's Encrypt R11", notBefore: now - 10 * 86400, notAfter: now + 80 * 86400 }));
          H.write('web3', '/etc/ssl/events/privkey.pem', '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
          H.write('web3', '/etc/nginx/sites-available/events', 'server {\n    listen 80;\n    server_name events.lumen.example.com;\n    return 301 https://$host$request_uri;\n}\n\nserver {\n    listen 443 ssl;\n    server_name events.lumen.example.com;\n    ssl_certificate /etc/ssl/events/fullchain.pem;\n    ssl_certificate_key /etc/ssl/events/privkey.pem;\n\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n    }\n}\n');
          H.run('sudo ln -s /etc/nginx/sites-available/events /etc/nginx/sites-enabled/events && sudo rm /etc/nginx/sites-enabled/default && sudo systemctl reload nginx', { on: 'web3' });
          H.run('sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw enable', { on: 'web3' });
          H.authorize('laptop', 'dev', 'web3', 'ubuntu');
          H.dnsRecord('events.lumen.example.com', 'A', old.ip);
          H.dnsRecord('web3.lumen.internal', 'A', w3.ip);
          H.uni.labData.w3 = w3.ip;
          H.sh.extraCommands.dnsctl = (c) => {
            const [sub, name, type, value] = c.args;
            const recs = c.uni.dnsRecords;
            if (sub === 'list') { for (const [n, r] of Object.entries(recs)) for (const [t2, v] of Object.entries(r)) c.print(`${n.padEnd(30)} ${t2.padEnd(6)} ${[].concat(v).join(', ')}`); return 0; }
            if (sub === 'set' && name && type && value) {
              if (!/^(A|CNAME|TXT|MX)$/.test(type)) return c.fail(`dnsctl: unsupported record type ${type}`, 1);
              if (type === 'A' && !/^\d+\.\d+\.\d+\.\d+$/.test(value)) return c.fail(`dnsctl: "${value}" is not an IPv4 address`, 1);
              (recs[name] = recs[name] || {})[type] = value;
              if (type === 'A') c.uni.dns.set(name, value);
              c.print(`✓ ${name} ${type} ${value} (TTL 60)`);
              c.uni.emit({ type: 'dns-change', name, rtype: type, value });
              return 0;
            }
            c.print('usage: dnsctl list | dnsctl set <name> <A|CNAME|TXT> <value>');
            return sub ? 1 : 0;
          };
        },
        suggestions: ['curl -I https://events.lumen.example.com', 'dig +short events.lumen.example.com'],
        tasks: [
          { title: 'Reproduce the outage from your laptop', solution: 'curl -I -m 5 https://events.lumen.example.com/', check: t => t.events('http').some(e => /events\.lumen\.example\.com/.test(e.url) && e.error) },
          { title: 'Start with the name: where does `events.lumen.example.com` point?', solution: 'dig +short events.lumen.example.com', check: t => t.events('dns').some(e => e.name === 'events.lumen.example.com') },
          { title: 'It still points at web-old. Find web3\'s address and fix the record with `dnsctl`', hint: '`dig +short web3.lumen.internal` gives the new address; `dnsctl set events.lumen.example.com A <ip>`.', solution: 'dnsctl set events.lumen.example.com A 10.0.0.31', check: t => t.uni.dns.get('events.lumen.example.com') === t.uni.labData.w3 },
          { title: 'Test again. Still failing, but how? Fix the next layer on web3', hint: 'A timeout on 443 with the right IP: look at web3\'s firewall.', solution: "ssh ubuntu@web3 \"sudo ufw allow 443/tcp\"", check: t => t.fw('web3').rules.some(r => r.action === 'allow' && (r.port === 443 || r.ports?.includes(443))) && t.after(e => e.type === 'dns-change', e => e.type === 'http' && /events\.lumen/.test(e.url)) },
          { title: 'Next symptom: 502 Bad Gateway. Find out why (nginx error log, listening ports) and fix nginx', hint: 'On web3: `sudo tail /var/log/nginx/error.log`, `sudo ss -tlnp`. The app listens on 3000; nginx proxies to 8080. Edit the site, `sudo nginx -t`, `sudo systemctl reload nginx`.', solution: "ssh ubuntu@web3 \"sudo sed -i 's/127.0.0.1:8080/127.0.0.1:3000/' /etc/nginx/sites-available/events && sudo nginx -t && sudo systemctl reload nginx\"", check: t => /proxy_pass\s+http:\/\/127\.0\.0\.1:3000/.test(t.file('web3', '/etc/nginx/sites-available/events') || '') && t.http('laptop', 'https://events.lumen.example.com/').status === 200 },
          { title: 'Confirm from your laptop, the way customers see it: HTTP 200', solution: 'curl -I https://events.lumen.example.com/', check: t => t.events('http').some(e => e.host === 'laptop' && /^https:\/\/events\.lumen\.example\.com/.test(e.url) && e.status === 200) },
          { title: 'Write `~/postmortem.md`: the three causes (DNS, firewall, proxy port) and one prevention idea each', solution: 'printf "Outage: events site\\n- DNS still pointed at web-old -> lower TTL and verify DNS in the migration checklist\\n- web3 firewall blocked 443 -> firewall rules as code, reviewed\\n- nginx proxied to 8080 but app listens on 3000 (502) -> health check through nginx before cutover\\n" > ~/postmortem.md', check: t => { const f = (t.file('laptop', '/home/dev/postmortem.md') || '').toLowerCase(); return /dns/.test(f) && /firewall|ufw|443/.test(f) && /nginx|proxy|502|port/.test(f); } },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the checks when a website does not answer, from the outside in.', items: ['Does the name resolve to the right IP? (dig)', 'Can packets reach the port? (curl/nc: refused or timed out?)', 'Is the process listening? (ss -tlnp)', 'What do the logs and config say? (journalctl, nginx error log)'], explain: 'Each layer depends on the one before.' },
        { type: 'mc', q: 'After fixing DNS, some users still reach the old server for a while. Why?', choices: ['Their browsers are broken', 'Resolvers cache the old answer until its TTL expires', 'DNS takes 48 hours by law', 'The firewall'], answer: 1, explain: 'Plan migrations with a low TTL.' },
        { type: 'mc', q: 'nginx logs "connect() failed (111: Connection refused) while connecting to upstream". What does it mean?', choices: ['The client refused', 'Nothing listens on the upstream address/port nginx proxies to', 'TLS failed', 'DNS failed'], answer: 1, explain: 'Check proxy_pass against ss -tlnp.' },
        { type: 'multi', q: 'Which belong in a migration checklist to prevent this outage?', choices: ['Lower the DNS TTL a day before', 'Open the firewall ports on the new server, and test from outside', 'Test the full path through nginx on the new server before switching DNS', 'Switch DNS first and test later'], answer: [0, 1, 2], explain: 'Verify before you cut over.' },
        { type: 'tf', q: 'Testing with `curl localhost` on the new server proves customers can reach it.', answer: false, explain: 'It skips DNS, the firewall and TLS for the real name.' },
      ],
    },
  ],
};
