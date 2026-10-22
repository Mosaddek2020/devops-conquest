// Realm 6 · Containers: Docker on the simulator. Images are really built (RUN steps run
// in a build container), containers are small machines with their own files, users and
// IPs, volumes keep data, user-defined networks resolve names and compose runs stacks.

import { parseYaml } from '../git/yaml.js';

const LOCK = deps => JSON.stringify({ name: 'app', lockfileVersion: 3, packages: Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }])) }, null, 2) + '\n';
const pkg = (name, deps, dev = {}, scripts = { start: 'node server.js' }) => JSON.stringify({ name, version: '1.0.0', scripts, dependencies: deps, devDependencies: dev }, null, 2) + '\n';
const node = (name, { port = 3000, bind = null, env = [], deps = [], routes = [] } = {}) => [
  "const express = require('express');",
  ...deps.map(d => d.require),
  'const app = express();',
  `const PORT = process.env.PORT || ${port};`,
  ...env.map(v => `if (!process.env.${v}) throw new Error('${v} is required');`),
  ...deps.map(d => d.use),
  "app.get('/health', (req, res) => res.json({ status: 'ok' }));",
  ...routes,
  `app.listen(PORT${bind ? `, '${bind}'` : ''}, () => console.log(\`${name} listening on \${PORT}\`));`,
  '',
].join('\n');
const PG = { require: "const { Pool } = require('pg');", use: 'const pool = new Pool({ connectionString: process.env.DATABASE_URL });' };
const REDIS = { require: "const { createClient } = require('redis');", use: 'const cache = createClient({ url: process.env.REDIS_URL });' };

const yaml = (t, path) => { try { return parseYaml(t.file('laptop', path) || ''); } catch { return null; } };
const lastBuild = (t, dir) => t.events('docker-build').filter(e => e.ok && (!dir || e.context === dir)).pop() || null;
const httpOk = (t, from, url) => t.http(from, url).status === 200;
const count = (t, on, ctr, table, user = 'postgres') => { const r = t.inContainer(on, ctr, `psql -U ${user} -c "SELECT count(*) FROM ${table}"`); const m = r.out.match(/^\s+(\d+)\s*$/m); return m ? Number(m[1]) : -1; };
const imgFile = (img, p) => img?.files?.[p];
const nonRoot = img => !!img && !['', 'root', '0'].includes(String(img.config.user || 'root').split(':')[0]);

// ---------- lesson 2: notify ----------
const NOTIFY = {
  'server.js': node('notify', { port: 4000, env: ['NOTIFY_TOKEN'] }),
  'package.json': pkg('notify', { express: '^4.21.1' }),
  'package-lock.json': LOCK({ express: '4.21.1' }),
  'templates/welcome.txt': 'Welcome to Lumen! Your account is ready.\n',
  Dockerfile: 'FROM node:20-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER node\nEXPOSE 4000\nCMD ["node", "server.js"]\n',
};

// ---------- lesson 3: booking ----------
const BOOKING_ROUTE = "app.get('/', (req, res) => res.send('Lumen booking: 3 rooms free tonight'));";
const BOOKING_LOCAL = node('booking', { bind: '127.0.0.1', routes: [BOOKING_ROUTE] });
const BOOKING_FIXED = node('booking', { routes: [BOOKING_ROUTE] });
const BOOKING_V3 = node('booking', { routes: ["app.get('/', (req, res) => res.send('Lumen booking: 2 rooms free tonight'));"] });
const BOOKING_V4 = node('booking', { routes: ["app.get('/', (req, res) => res.send('Lumen booking: fully booked'));"] });
const DF_NAIVE = 'FROM node:20-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
const DF_CACHED = 'FROM node:20-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
const dfSteps = text => String(text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const cacheFriendly = text => { const s = dfSteps(text); const iDeps = s.findIndex(l => /^COPY\s+package/i.test(l)); const iRun = s.findIndex(l => /^RUN\s+npm\s+(ci|install)/i.test(l)); const iAll = s.findIndex(l => /^COPY\s+\.\s/i.test(l)); return iDeps >= 0 && iRun > iDeps && iAll > iRun; };

// ---------- lesson 4: payments ----------
const PAYMENTS_DF = 'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm install\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
const PAYMENTS_GOOD = ['FROM node:20-alpine AS deps', 'WORKDIR /app', 'COPY package*.json ./', 'RUN npm ci --omit=dev', '', 'FROM node:20-alpine', 'WORKDIR /app', 'COPY --from=deps /app/node_modules ./node_modules', 'COPY server.js ./', 'USER node', 'EXPOSE 3000', 'CMD ["node", "server.js"]', ''].join('\n');
const PAY_DEPS = { express: '^4.21.1' }, PAY_DEV = { jest: '^29.7.0', eslint: '^9.14.0', typescript: '^5.6.3' };
const goodImage = (img, { maxMB = 250 } = {}) => !!img && img.sizeMB < maxMB && nonRoot(img) && !Object.keys(img.files).some(p => /\/\.env$/.test(p)) && !Object.keys(img.files).some(p => /node_modules\/jest\//.test(p));

// ---------- lesson 5: reviews ----------
const REVIEWS = {
  'server.js': node('reviews', { env: ['DATABASE_URL'], deps: [PG] }),
  'package.json': pkg('reviews', { express: '^4.21.1', pg: '^8.13.1' }),
  'package-lock.json': LOCK({ express: '4.21.1', pg: '8.13.1' }),
  Dockerfile: 'FROM node:20-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER node\nCMD ["node", "server.js"]\n',
};

// ---------- lesson 6: shop ----------
const SHOP_FILES = {
  'server.js': node('shop', { deps: [PG, REDIS], routes: ["app.get('/', (req, res) => res.send('Lumen shop is open'));"] }),
  'package.json': pkg('shop', { express: '^4.21.1', pg: '^8.13.1', redis: '^4.7.0' }),
  'package-lock.json': LOCK({ express: '4.21.1', pg: '8.13.1', redis: '4.7.0' }),
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER node\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  '.dockerignore': 'node_modules\n.env\n.git\n',
  '.env': 'DB_PASSWORD=devpass\n',
  '.env.example': 'DB_PASSWORD=\n',
  '.gitignore': '.env\nnode_modules\n',
  'README.md': ['# Lumen shop: local setup (the old way)', '', '1. docker network create shop', '2. docker volume create shop-pgdata', '3. docker run -d --name db --network shop -e POSTGRES_USER=shop -e POSTGRES_PASSWORD=devpass \\', '     -v shop-pgdata:/var/lib/postgresql/data postgres:16', '4. wait until `docker exec db pg_isready` says accepting connections', '5. docker run -d --name cache --network shop redis:7-alpine', '6. docker build -t shop-api .', '7. docker run -d --name api --network shop -p 8080:3000 \\', '     -e DATABASE_URL=postgres://shop:devpass@db:5432/shop \\', '     -e REDIS_URL=redis://cache:6379 shop-api', '8. curl localhost:8080/health', '… (and 6 more steps for teardown and resets)', ''].join('\n'),
};
const SHOP_COMPOSE = (port = 8080) => ['services:', '  api:', '    build: .', '    ports:', `      - "${port}:3000"`, '    environment:', '      DATABASE_URL: postgres://shop:${DB_PASSWORD}@db:5432/shop', '      REDIS_URL: redis://cache:6379', '    depends_on:', '      db:', '        condition: service_healthy', '      cache:', '        condition: service_started', '    restart: unless-stopped', '  db:', '    image: postgres:16', '    environment:', '      POSTGRES_USER: shop', '      POSTGRES_PASSWORD: ${DB_PASSWORD}', '    volumes:', '      - pgdata:/var/lib/postgresql/data', '    healthcheck:', '      test: ["CMD-SHELL", "pg_isready -U shop"]', '      interval: 5s', '  cache:', '    image: redis:7-alpine', 'volumes:', '  pgdata:', ''].join('\n');
const depCond = (svc, dep) => { const d = svc?.depends_on; return d && !Array.isArray(d) ? d[dep]?.condition : null; };
const shopComposeOk = c => {
  const s = c?.services;
  if (!s?.api || !s?.db || !s?.cache) return false;
  const dbVol = (s.db.volumes || []).some(v => /:\/var\/lib\/postgresql\/data$/.test(String(v)) && !/^[./~]/.test(String(v)));
  return !!s.api.build && (s.api.ports || []).some(p => /:3000$/.test(String(p))) && /^postgres/.test(s.db.image || '') && dbVol && !!s.db.healthcheck && /^redis/.test(s.cache.image || '') && depCond(s.api, 'db') === 'service_healthy' && !(s.db.ports || []).length;
};
const projectUp = (t, on, project, svcs) => svcs.every(n => t.running(on, c => c.project === project && c.service === n).length);

// ---------- lesson 7: events ----------
const EVENTS_FILES = {
  'server.js': node('events', { routes: ["app.get('/', (req, res) => res.send('Lumen events: Jazz at the Docks, Friday 8pm'));"] }),
  'package.json': pkg('events', { express: '^4.21.1' }),
  'package-lock.json': LOCK({ express: '4.21.1' }),
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER node\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  '.dockerignore': 'node_modules\n.git\n.env\n',
};
const REG = 'registry.lumen.dev';
const TOKEN = 'rlt_7f3k9q2m4x8v';

// ---------- boss: tickets ----------
const TICKETS_FILES = {
  'server.js': node('tickets', { env: ['DATABASE_URL'], deps: [PG], routes: ["app.get('/', (req, res) => res.send('Lumen tickets'));"] }),
  'package.json': pkg('tickets', { express: '^4.21.1', pg: '^8.13.1' }, { jest: '^29.7.0', eslint: '^9.14.0' }, { start: 'node server.js', test: 'jest' }),
  'package-lock.json': LOCK({ express: '4.21.1', pg: '8.13.1', jest: '29.7.0', eslint: '9.14.0' }),
  '.env': 'DB_PASSWORD=t1ckets-Pr0d-2026\n',
  'README.md': '# tickets\n\nCurrently started by hand on app2 with `node server.js`. Needs DATABASE_URL.\n',
};
const TICKETS_DF = ['FROM node:20-alpine AS deps', 'WORKDIR /app', 'COPY package*.json ./', 'RUN npm ci --omit=dev', '', 'FROM node:20-alpine', 'WORKDIR /app', 'COPY --from=deps /app/node_modules ./node_modules', 'COPY server.js ./', 'USER node', 'EXPOSE 3000', 'CMD ["node", "server.js"]', ''].join('\n');
const TICKETS_IMG = `${REG}/team/tickets:1.0.0`;
const TICKETS_COMPOSE = ['services:', '  api:', `    image: ${TICKETS_IMG}`, '    ports:', '      - "80:3000"', '    environment:', '      DATABASE_URL: postgres://tickets:${DB_PASSWORD}@db:5432/tickets', '    depends_on:', '      db:', '        condition: service_healthy', '    restart: unless-stopped', '  db:', '    image: postgres:16', '    environment:', '      POSTGRES_USER: tickets', '      POSTGRES_PASSWORD: ${DB_PASSWORD}', '    volumes:', '      - pgdata:/var/lib/postgresql/data', '    healthcheck:', '      test: ["CMD-SHELL", "pg_isready -U tickets"]', '      interval: 5s', '    restart: unless-stopped', 'volumes:', '  pgdata:', ''].join('\n');
const ticketsComposeOk = c => {
  const s = c?.services;
  if (!s?.api || !s?.db) return false;
  return /tickets:1\.0\.0$/.test(s.api.image || '') && (s.api.ports || []).some(p => /:3000$/.test(String(p))) && depCond(s.api, 'db') === 'service_healthy' && /^postgres/.test(s.db.image || '') && !!s.db.healthcheck && (s.db.volumes || []).some(v => /:\/var\/lib\/postgresql\/data$/.test(String(v)) && !/^[./~]/.test(String(v))) && !(s.db.ports || []).length && /\$\{DB_PASSWORD\}/.test(JSON.stringify(s));
};

function bigNodeModules(H, dir, deps) {
  for (const [d, mb] of Object.entries(deps)) { H.write('laptop', `${dir}/node_modules/${d}/package.json`, `{"name":"${d}"}\n`, { owner: 'dev' }); H.fakeSize('laptop', `${dir}/node_modules/${d}/index.js`, mb * 1e6); }
}
function registryWorld(H) {
  H.docker('laptop');
  H.server('app2', { ip: '10.0.0.62' });
  H.docker('app2', 'ubuntu');
  H.authorize('laptop', 'dev', 'app2', 'ubuntu');
  H.registryCreds(REG, 'ci', TOKEN);
  H.write('laptop', '~/registry-token.txt', TOKEN + '\n', { owner: 'dev', mode: 0o600 });
  H.write('app2', '/home/ubuntu/registry-token.txt', TOKEN + '\n', { owner: 'ubuntu', mode: 0o600 });
}

export default {
  id: 'containers',
  n: 6,
  title: 'Containers',
  tagline: 'Images, containers, Dockerfiles, small and safe images, volumes, networks, Compose and registries',
  badge: 'Container Captain',
  intro: 'Package an app with everything it needs and run it the same way everywhere. Run and debug **containers**, write **Dockerfiles** that build in seconds, make images **small, non-root and secret-free**, keep data in **volumes**, connect services on **networks**, run whole stacks with **Compose**, and ship versioned images through a **registry**. Every build here really runs its steps, and every container is a small machine you can step inside.',
  lessons: [
    {
      id: 'why-containers',
      title: 'Why containers',
      summary: 'Images vs containers, namespaces and cgroups, installing Docker, the docker group, run, ps, logs, ports.',
      minutes: 20,
      lab: {
        cwd: '~',
        panels: ['docker', 'system'],
        suggestions: ['docker ps', 'sudo apt install -y docker.io'],
        tasks: [
          { title: 'Try `docker ps`. Docker is not installed: install the `docker.io` package', solution: 'sudo apt install -y docker.io', check: t => t.pkg('laptop', 'docker.io') },
          { title: '`docker ps` now says permission denied. Add yourself (`dev`) to the `docker` group, then `docker ps` works', hint: 'The CLI talks to the daemon through /var/run/docker.sock; only root and the docker group may use it. In real life you log out and back in after this.', solution: 'sudo usermod -aG docker dev && docker ps', check: t => t.inGroup('laptop', 'dev', 'docker') && t.ran(/docker\s+ps/) },
          { title: 'Run a one-off container: `alpine` printing its `/etc/os-release`. It runs, prints and exits', solution: 'docker run alpine cat /etc/os-release', check: t => t.containers('laptop', c => /alpine/.test(c.imageRef) && c.status === 'exited' && c.exitCode === 0).length > 0 },
          { title: 'Start `nginx` in the background, named `web`, publishing host port 8080 to the container\'s port 80', solution: 'docker run -d --name web -p 8080:80 nginx', check: t => { const c = t.container('laptop', 'web'); return !!c && c.status === 'running' && /nginx/.test(c.imageRef) && c.ports.some(p => p.host === 8080 && p.container === 80); } },
          { title: 'Fetch the page from your laptop with curl, then list running containers', solution: 'curl -s localhost:8080 && docker ps', check: t => t.events('http').some(e => e.host === 'laptop' && /localhost:8080|127\.0\.0\.1:8080/.test(e.url) && e.status === 200) && t.lastRan(/docker\s+ps/) },
          { title: 'A container is just a process: find nginx in the host\'s `ps aux`, and compare with `docker top web`', solution: 'ps aux | grep nginx; docker top web', check: t => t.ran(/ps\s+(aux|-ef|-e)/) && t.ran(/docker\s+top\s+web/) },
          { title: 'Stop and remove `web`, and confirm with `docker ps -a` that it is gone (the image stays)', solution: 'docker stop web && docker rm web && docker ps -a && docker images', check: t => !t.container('laptop', 'web') && t.ran(/docker\s+ps\s+-a/) && !!t.image('laptop', 'nginx') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does a container share with the machine it runs on?', choices: ['Nothing, it is a full virtual machine', 'The kernel', 'Its filesystem', 'Its process list'], answer: 1, explain: 'Namespaces give it its own view of files, processes and network; the kernel is shared. That is why it starts in milliseconds.' },
        { type: 'mc', q: 'Image vs container?', choices: ['Same thing', 'An image is a read-only template; a container is a running (or stopped) instance of it', 'A container is a compressed image', 'Images run, containers are stored'], answer: 1, explain: 'One image, many containers.' },
        { type: 'predict', q: 'What does the browser on the host reach at localhost:3000?', code: '$ docker run -d -p 3000:80 nginx', choices: ['nginx inside the container on port 80', 'Nothing: the container listens on 3000', 'The host\'s own port 80', 'An error: ports must match'], answer: 0, explain: '-p HOST:CONTAINER. Host port 3000 forwards to 80 in the container.' },
        { type: 'mc', q: 'Why does `docker ps` say "permission denied" right after installing Docker?', choices: ['Docker is broken', 'Your user is not allowed to use /var/run/docker.sock: only root and the docker group are', 'The firewall blocks it', 'You need a Docker Hub account'], answer: 1, explain: 'Add yourself to the docker group (and remember that group is root-equivalent).' },
        { type: 'tf', q: '`docker stop web` deletes the container.', answer: false, explain: 'It stops it. docker ps -a still lists it; docker rm deletes it.' },
        { type: 'multi', q: 'Which are real advantages of containers?', choices: ['Same image on laptop, CI and production', 'Starts in milliseconds, small overhead', 'Servers need nothing app-specific installed', 'Perfect security isolation, stronger than VMs'], answer: [0, 1, 2], explain: 'Containers share a kernel; VMs isolate more strongly.' },
        { type: 'type', q: 'Type the command that lists all containers, including stopped ones.', accept: ['docker ps -a', 'docker ps --all', 'docker container ls -a', 'docker container ls --all'], model: 'docker ps -a', explain: '-a shows exited containers too.' },
      ],
    },
    {
      id: 'images-containers',
      title: 'Images and the container lifecycle',
      summary: 'Pull and run, exit codes, logs, environment variables, restart policies, exec for debugging, the writable layer.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['docker', 'files'],
        setup(H) {
          H.docker('laptop');
          H.publishImage('lumen/notify:1.0', NOTIFY);
        },
        suggestions: ['docker run -d --name notify -p 4000:4000 lumen/notify:1.0'],
        tasks: [
          { title: 'Run `lumen/notify:1.0` in the background as `notify`, publishing port 4000. Check `docker ps`: is it running?', solution: 'docker run -d --name notify -p 4000:4000 lumen/notify:1.0 && docker ps', check: t => { const c = t.container('laptop', 'notify'); return !!c && c.status === 'exited' && c.exitCode === 1; } },
          { title: 'Find out why it stopped: its exit code and its logs', solution: 'docker ps -a && docker logs notify', check: t => t.ran(/docker\s+logs\s+(notify|[0-9a-f]{4,})/) },
          { title: 'Remove it and run it again with the missing setting (`NOTIFY_TOKEN=dev-token`) and a restart policy of `unless-stopped`', solution: 'docker rm notify && docker run -d --name notify --restart unless-stopped -e NOTIFY_TOKEN=dev-token -p 4000:4000 lumen/notify:1.0', check: t => { const c = t.container('laptop', 'notify'); return !!c && c.status === 'running' && !!c.env.NOTIFY_TOKEN && c.restart === 'unless-stopped'; } },
          { title: 'Check it is healthy from the laptop: `/health` on port 4000', solution: 'curl -s localhost:4000/health', check: t => t.events('http').some(e => e.host === 'laptop' && /:4000\/health/.test(e.url) && e.status === 200) },
          { title: 'Look inside the running container: read `/app/templates/welcome.txt` and see which user the app runs as', solution: 'docker exec notify cat /app/templates/welcome.txt && docker exec notify whoami', check: t => t.events('docker-exec').some(e => e.name === 'notify') && t.ran(/welcome\.txt/) && t.ran(/whoami|\bid\b/) },
          { title: 'Do the "2 a.m. hotfix": change the welcome text inside the container to `Hello from the hotfix`', solution: 'docker exec notify sh -c \'echo "Hello from the hotfix" > /app/templates/welcome.txt\'', test: ['docker exec -u root notify sh -c \'echo "Hello from the hotfix" > /app/templates/welcome.txt\''], hint: 'The app runs as `node`, which may not own that file. `docker exec -u root …` runs your command as root.', check: t => /hotfix/.test(t.inContainer('laptop', 'notify', 'cat /app/templates/welcome.txt').out) },
          { title: 'Now redeploy like the team does: remove the container and run the same image again (same name, token, port, policy). Where did your hotfix go?', solution: 'docker rm -f notify && docker run -d --name notify --restart unless-stopped -e NOTIFY_TOKEN=dev-token -p 4000:4000 lumen/notify:1.0 && docker exec notify cat /app/templates/welcome.txt', check: t => { const c = t.container('laptop', 'notify'); return !!c && c.status === 'running' && t.events('docker-rm').some(e => e.name === 'notify') && /Welcome to Lumen/.test(t.inContainer('laptop', 'notify', 'cat /app/templates/welcome.txt').out); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'A container exits immediately with code 1. Where do you look first?', choices: ['docker images', '`docker logs <name>`', 'docker network ls', 'Rebuild the image'], answer: 1, explain: 'The app printed why it failed; logs show stdout and stderr.' },
        { type: 'mc', q: 'Exit code 127 from a container usually means…', choices: ['Out of memory', 'The command does not exist in the image', 'A network error', 'Success'], answer: 1, explain: '"executable file not found in $PATH". 137 is killed (often OOM).' },
        { type: 'mc', q: 'You fixed a file with `docker exec` inside a running container. What happens on the next redeploy?', choices: ['The fix is kept', 'The fix is lost: the new container starts from the image', 'Docker merges it into the image', 'The deploy fails'], answer: 1, explain: 'Changes live in the container\'s writable layer only. Fix the image instead.' },
        { type: 'multi', q: 'Which are good uses of `docker exec`?', choices: ['Looking at files and env vars while debugging', 'Running a one-off database query', 'Patching production code permanently', 'Checking which user the app runs as'], answer: [0, 1, 3], explain: 'Permanent fixes go into the image or configuration.' },
        { type: 'mc', q: 'What does `--restart unless-stopped` do?', choices: ['Never restarts', 'Restarts the container when it dies and after a reboot, unless you stopped it yourself', 'Restarts every minute', 'Restarts only on success'], answer: 1, explain: 'A supervisor, like systemd\'s Restart=.' },
        { type: 'tf', q: 'Apps in containers should log to stdout/stderr rather than to files inside the container.', answer: true, explain: 'docker logs (and every platform) collects the console; files inside vanish with the container.' },
        { type: 'type', q: 'Type the command that opens an interactive shell (`sh`) inside the running container `api`.', accept: ['docker exec -it api sh', 'docker exec -ti api sh', 'docker exec -it api /bin/sh'], model: 'docker exec -it api sh', explain: '-i keeps stdin open, -t gives a terminal.' },
      ],
    },
    {
      id: 'dockerfiles',
      title: 'Writing Dockerfiles',
      summary: 'FROM, WORKDIR, COPY, RUN, CMD; build context; layer cache order; exec form; listening on 0.0.0.0.',
      minutes: 30,
      lab: {
        cwd: '~/booking',
        panels: ['docker', 'files'],
        setup(H) {
          H.docker('laptop');
          H.write('laptop', '~/booking/server.js', BOOKING_LOCAL, { owner: 'dev' });
          H.write('laptop', '~/booking/package.json', pkg('booking', { express: '^4.21.1' }), { owner: 'dev' });
          H.write('laptop', '~/booking/package-lock.json', LOCK({ express: '4.21.1' }), { owner: 'dev' });
          H.pull('laptop', 'node:20-slim');
        },
        suggestions: ['cat server.js package.json', 'nano Dockerfile'],
        tasks: [
          { title: 'Write `Dockerfile`: start from `node:20-slim`, work in `/app`, copy the project, run `npm ci`, and start `node server.js` (exec form). Build it as `booking:1`', solution: 'nano Dockerfile && docker build -t booking:1 .', test: [{ cmd: 'nano Dockerfile', edit: DF_NAIVE }, 'docker build -t booking:1 .'], check: t => !!t.image('laptop', 'booking:1') && /^CMD\s*\[/m.test(t.file('laptop', '~/booking/Dockerfile') || '') },
          { title: 'Run it as `booking` publishing 3000:3000 and curl it. It is running, yet curl fails: find out why', hint: 'Read the app\'s startup line in `docker logs booking`, then look at the `app.listen(...)` line in server.js. Inside a container, 127.0.0.1 is the container itself.', solution: 'docker run -d --name booking -p 3000:3000 booking:1 && curl localhost:3000; docker logs booking; grep listen server.js', check: t => t.events('http').some(e => e.host === 'laptop' && /:3000/.test(e.url) && e.error) && t.ran(/grep.*listen|cat\s+server\.js|docker\s+logs\s+booking/) },
          { title: 'Fix `server.js` so the app listens on all interfaces, rebuild as `booking:2`, replace the container and get the page', solution: 'nano server.js && docker build -t booking:2 . && docker rm -f booking && docker run -d --name booking -p 3000:3000 booking:2 && curl -s localhost:3000', test: [{ cmd: 'nano server.js', edit: BOOKING_FIXED }, 'docker build -t booking:2 . && docker rm -f booking && docker run -d --name booking -p 3000:3000 booking:2 && curl -s localhost:3000'], check: t => { const c = t.container('laptop', 'booking'); return !!c && c.status === 'running' && /booking:2/.test(c.imageRef) && httpOk(t, 'laptop', 'http://localhost:3000/'); } },
          { title: 'Change the message (3 → 2 rooms) and rebuild as `booking:3`. Read the build output: did `RUN npm ci` run again?', solution: 'sed -i "s/3 rooms/2 rooms/" server.js && docker build -t booking:3 .', test: ['sed -i "s/3 rooms/2 rooms/" server.js && docker build -t booking:3 .'], check: t => { const b = lastBuild(t, '/home/dev/booking'); return !!t.image('laptop', 'booking:3') && !!b && b.steps.some(s => /RUN npm (ci|install)/.test(s.text) && !s.cached); } },
          { title: 'Reorder the Dockerfile so dependencies install before the code is copied. Rebuild as `booking:4`, change the message again, and rebuild: `npm ci` must now come from the cache', solution: 'nano Dockerfile && docker build -t booking:4 . && sed -i "s/2 rooms free tonight/fully booked/" server.js && docker build -t booking:4 .', test: [{ cmd: 'nano Dockerfile', edit: DF_CACHED }, 'docker build -t booking:4 .', 'sed -i "s/2 rooms free tonight/fully booked/" server.js && docker build -t booking:4 .'], check: t => { const b = lastBuild(t, '/home/dev/booking'); return cacheFriendly(t.file('laptop', '~/booking/Dockerfile')) && !!b && b.steps.some(s => /RUN npm (ci|install)/.test(s.text) && s.cached) && b.steps.some(s => /^COPY \. /.test(s.text) && !s.cached); } },
          { title: 'Look at the layers of `booking:4` and their sizes', solution: 'docker history booking:4', check: t => t.ran(/docker\s+(history|image\s+history)\s+booking:4/) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order these lines for the best build cache in a Node app.', items: ['FROM node:20-slim', 'WORKDIR /app', 'COPY package*.json ./', 'RUN npm ci', 'COPY . .', 'CMD ["node", "server.js"]'], explain: 'Rarely-changing steps first; your code last.' },
        { type: 'mc', q: 'You change one line of code. Which layers rebuild?', choices: ['All of them', 'The layer that copies the code and every layer after it', 'Only the last layer', 'None: Docker patches the image'], answer: 1, explain: 'A changed layer invalidates everything after it.' },
        { type: 'mc', q: 'An app in a container listens on 127.0.0.1:3000 and you run it with `-p 3000:3000`. What does `curl localhost:3000` on the host get?', choices: ['The app', 'Connection reset: the app only accepts connections from inside its own container', 'A 404', 'The host\'s nginx'], answer: 1, explain: 'Listen on 0.0.0.0 inside containers.' },
        { type: 'mc', q: 'Why prefer `CMD ["node", "server.js"]` over `CMD node server.js`?', choices: ['It is shorter', 'Exec form runs node as PID 1 so it receives SIGTERM from docker stop and can shut down cleanly', 'Shell form is not allowed', 'It makes the image smaller'], answer: 1, explain: 'Shell form wraps it in /bin/sh -c, which does not forward the signal.' },
        { type: 'tf', q: '`EXPOSE 3000` publishes port 3000 on the host.', answer: false, explain: 'EXPOSE is documentation. -p (or compose ports:) publishes.' },
        { type: 'mc', q: 'What is the "build context"?', choices: ['The Dockerfile', 'The directory sent to the builder (the `.` in docker build .), which COPY can read from', 'The base image', 'The registry'], answer: 1, explain: 'Keep it small with .dockerignore.' },
        { type: 'predict', q: 'Which directory is the app in when the container starts?', code: 'FROM node:20-slim\nRUN cd /srv\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]', choices: ['/srv', '/app', '/', '/root'], answer: 1, explain: 'Each RUN is its own shell; only WORKDIR changes the directory for later steps and for the container.' },
      ],
    },
    {
      id: 'better-images',
      title: 'Small, safe images',
      summary: '.dockerignore, slim/alpine/distroless bases, multi-stage builds, non-root users, no secrets in layers, image scanning.',
      minutes: 30,
      lab: {
        cwd: '~/payments',
        panels: ['docker', 'files'],
        setup(H) {
          H.docker('laptop');
          H.write('laptop', '~/payments/server.js', node('payments', { routes: ["app.get('/', (req, res) => res.send('Lumen payments'));"] }), { owner: 'dev' });
          H.write('laptop', '~/payments/package.json', pkg('payments', PAY_DEPS, PAY_DEV, { start: 'node server.js', test: 'jest', lint: 'eslint .' }), { owner: 'dev' });
          H.write('laptop', '~/payments/package-lock.json', LOCK({ express: '4.21.1', jest: '29.7.0', eslint: '9.14.0', typescript: '5.6.3' }), { owner: 'dev' });
          H.write('laptop', '~/payments/.env', 'DB_PASSWORD=pr0d-Payments!2026\nSTRIPE_KEY=sk_live_51Lumen0000example\n', { owner: 'dev', mode: 0o600 });
          H.write('laptop', '~/payments/Dockerfile', PAYMENTS_DF, { owner: 'dev' });
          bigNodeModules(H, '~/payments', { express: 2.1, jest: 38, eslint: 24, typescript: 23, '.cache': 210 });
          H.pull('laptop', 'node:20', 'node:20-alpine');
        },
        suggestions: ['cat Dockerfile', 'ls -la', 'du -sh node_modules'],
        tasks: [
          { title: 'Build the current Dockerfile as `payments:1`. How big is it? Then look for the secret: list `/app` inside the image and read `/app/.env`', solution: 'docker build -t payments:1 . && docker images payments && docker run --rm payments:1 ls -la /app && docker run --rm payments:1 cat /app/.env', check: t => !!t.image('laptop', 'payments:1') && t.ran(/docker\s+run\b.*payments:1.*\.env/) },
          { title: 'Write a `.dockerignore` that keeps `node_modules`, `.env` and `.git` out of the build context', solution: 'printf "node_modules\\n.env\\n.git\\n" > .dockerignore', check: t => { const d = t.file('laptop', '~/payments/.dockerignore') || ''; return /^\/?node_modules\/?$/m.test(d) && /^\/?\.env\*?$/m.test(d) && /^\/?\.git\/?$/m.test(d); } },
          { title: 'Rewrite the Dockerfile as a multi-stage build on a small base (`node:20-alpine`): install only production dependencies with `npm ci --omit=dev`, copy just `node_modules` and `server.js` into the final stage, and run as the `node` user. Build `payments:2`', hint: 'Under 250 MB, not root, no .env, no jest. `docker history payments:2` shows what each step added.', solution: 'nano Dockerfile && docker build -t payments:2 .', test: [{ cmd: 'nano Dockerfile', edit: PAYMENTS_GOOD }, 'docker build -t payments:2 .'], check: t => goodImage(t.image('laptop', 'payments:2')) },
          { title: 'Compare the two images and prove `payments:2` runs as a non-root user and serves `/health` (run it as `payments` on port 3000)', solution: 'docker images payments && docker run --rm payments:2 id && docker run -d --name payments -p 3000:3000 payments:2 && curl -s localhost:3000/health', check: t => t.ran(/docker\s+(images|image\s+ls)/) && t.ran(/docker\s+run\b.*payments:2\s+(id|whoami)/) && httpOk(t, 'laptop', 'http://localhost:3000/health') && /payments:2/.test(t.container('laptop', 'payments')?.imageRef || '') },
          { title: 'Scan both images with `docker scout cves` and compare the vulnerability counts', solution: 'docker scout cves payments:1 && docker scout cves payments:2', check: t => ['payments:1', 'payments:2'].every(r => t.events('docker-scan').some(e => e.ref === r)) && t.events('docker-scan').some(e => e.ref === 'payments:2' && e.counts[0] === 0) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'A Dockerfile does `COPY . .` and then `RUN rm .env`. Is the secret gone from the image?', choices: ['Yes', 'No: it is still in the earlier COPY layer, readable by anyone who pulls the image', 'Only on alpine', 'Only if the image is private'], answer: 1, explain: 'Keep it out of the context with .dockerignore; never let it into a layer.' },
        { type: 'multi', q: 'What does a multi-stage build let you leave out of the final image?', choices: ['Compilers and build tools', 'devDependencies like jest and eslint', 'Source files you only needed for the build', 'The runtime your app needs'], answer: [0, 1, 2], explain: 'Copy only the result into a clean final stage.' },
        { type: 'mc', q: 'Why run as a non-root user in the container?', choices: ['It is faster', 'If the app is compromised, the attacker cannot modify the image\'s files or easily escalate', 'Docker requires it', 'It reduces image size'], answer: 1, explain: 'Defence in depth.' },
        { type: 'mc', q: 'You need `docker exec -it payments sh` but the image is distroless. What happens?', choices: ['It works', 'It fails: distroless images contain no shell', 'It opens bash instead', 'Docker installs a shell'], answer: 1, explain: 'That is the point of distroless: less to attack. Debug with logs or a debug image variant.' },
        { type: 'tf', q: 'Fewer packages in an image means fewer vulnerabilities to track and patch.', answer: true, explain: 'Every package is attack surface.' },
        { type: 'mc', q: 'An AI assistant suggests `ENV DB_PASSWORD=…` in the Dockerfile "so the app finds it". Best response?', choices: ['Accept it', 'Reject: ENV values are stored in the image metadata; pass secrets at run time from a secret store', 'Use ARG instead, which is secret', 'Base64-encode it'], answer: 1, explain: 'ENV and ARG values are visible via docker inspect / history.' },
        { type: 'type', q: 'Type the line in a Dockerfile that switches to the `node` user for everything after it.', accept: ['USER node'], model: 'USER node', explain: 'Official node images ship a `node` user.' },
      ],
    },
    {
      id: 'volumes-networks',
      title: 'Volumes and networks',
      summary: 'Named volumes vs bind mounts vs the writable layer; user-defined networks and DNS by name; publish only what must be public.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['docker', 'system'],
        setup(H) {
          H.docker('laptop');
          H.publishImage('lumen/reviews:1.0', REVIEWS);
          H.pull('laptop', 'postgres:16', 'lumen/reviews:1.0');
          H.container('laptop', 'lumen/reviews:1.0', { name: 'api-old', env: { DATABASE_URL: 'postgres://postgres:secret@db:5432/postgres' } });
          H.uni.ai = { rules: [{ id: 'cleanup', when: /disk|space|clean|free|prune/i, reply: ['Docker is using a lot of disk. Clean everything up in one go:', '', '    docker system prune -a --volumes -f', '', 'This removes all unused containers, images, networks and volumes', 'without asking. You will get gigabytes back!'] }] };
        },
        suggestions: ['docker ps -a', 'docker logs api-old'],
        tasks: [
          { title: 'A teammate\'s `api-old` container is dead. Read why', solution: 'docker ps -a && docker logs api-old', check: t => t.ran(/docker\s+logs\s+api-old/) },
          { title: 'Create a user-defined network called `reviews`', solution: 'docker network create reviews', check: t => !!t.network('laptop', 'reviews') },
          { title: 'Run Postgres 16 as `db` on that network, with `POSTGRES_PASSWORD=secret` and a named volume `reviews-data` mounted at `/var/lib/postgresql/data`. Do not publish its port', solution: 'docker run -d --name db --network reviews -e POSTGRES_PASSWORD=secret -v reviews-data:/var/lib/postgresql/data postgres:16', check: t => { const c = t.container('laptop', 'db'); return !!c && c.status === 'running' && c.network === 'reviews' && c.volumes.some(v => v.type === 'volume' && v.source === 'reviews-data' && v.target === '/var/lib/postgresql/data') && !c.ports.length; } },
          { title: 'Create a table `reviews` and insert two rows with `docker exec db psql -U postgres -c "…"`', solution: 'docker exec db psql -U postgres -c "CREATE TABLE reviews (id int, stars int, body text); INSERT INTO reviews VALUES (1, 5, \'Lovely\'), (2, 4, \'Good coffee\')"', check: t => count(t, 'laptop', 'db', 'reviews') >= 2 },
          { title: 'Run the API (`lumen/reviews:1.0`) as `api` on the same network, connecting to the database by name, publishing 3000:3000. Check `/health`', hint: 'DATABASE_URL=postgres://postgres:secret@db:5432/postgres', solution: 'docker run -d --name api --network reviews -e DATABASE_URL=postgres://postgres:secret@db:5432/postgres -p 3000:3000 lumen/reviews:1.0 && curl -s localhost:3000/health', check: t => { const c = t.container('laptop', 'api'); return !!c && c.status === 'running' && c.network === 'reviews' && httpOk(t, 'laptop', 'http://localhost:3000/health'); } },
          { title: 'Upgrade day: remove the `db` container and start a fresh one with the same name, network and volume. Are the reviews still there?', solution: 'docker rm -f db && docker run -d --name db --network reviews -e POSTGRES_PASSWORD=secret -v reviews-data:/var/lib/postgresql/data postgres:16 && docker exec db psql -U postgres -c "SELECT * FROM reviews"', check: t => t.after(e => e.type === 'docker-rm' && e.name === 'db', e => e.type === 'container-start' && e.name === 'db') && count(t, 'laptop', 'db', 'reviews') >= 2 },
          { title: 'Disk is filling up. Ask the AI assistant how to clean up, check its suggestion with `ai explain`, then free space without losing any data', hint: 'Removing stopped containers and unused images is safe here. Deleting volumes is not.', solution: 'ai "how do I free disk space used by docker?" && ai explain "docker system prune -a --volumes -f" && docker system prune -f', test: ['ai "how do I free disk space used by docker?"', 'ai explain "docker system prune -a --volumes -f"', 'docker system prune -f && docker volume ls'], check: t => t.events('ai-explain').some(e => /prune/.test(e.cmd)) && t.ran(/docker\s+(system|container)\s+prune/) && !t.events('docker-volume-deleted').length && !!t.volume('laptop', 'reviews-data') && !t.container('laptop', 'api-old') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Where should a database container keep its data?', choices: ['In the container\'s writable layer', 'In a named volume mounted at the image\'s data directory', 'In the image', 'In /tmp'], answer: 1, explain: 'The volume outlives every container that uses it.' },
        { type: 'mc', q: 'Two containers on the default bridge network. Can `api` reach `postgres://db:5432`?', choices: ['Yes, by name', 'No: the default bridge has no name resolution; use a user-defined network', 'Only with -p 5432:5432', 'Only with --privileged'], answer: 1, explain: 'User-defined networks (and every compose project) run Docker\'s DNS.' },
        { type: 'mc', q: 'Inside the `api` container, what does `localhost:5432` point to?', choices: ['The database container', 'The api container itself', 'The Docker host', 'The registry'], answer: 1, explain: 'Each container has its own network namespace.' },
        { type: 'multi', q: 'Which commands can delete database data?', choices: ['docker volume rm reviews-data', 'docker system prune --volumes', 'docker rm -f db (with data in a named volume)', 'docker compose down -v'], answer: [0, 1, 3], explain: 'Removing the container leaves the named volume intact.' },
        { type: 'mc', q: 'When is a bind mount (`-v ./src:/app/src`) the right choice?', choices: ['Production databases', 'Local development, so code edits on the host appear in the container instantly', 'Secrets', 'Never'], answer: 1, explain: 'Named volumes for data, bind mounts for dev workflows.' },
        { type: 'tf', q: 'A database container that only the API uses should normally not publish its port with -p.', answer: true, explain: 'Containers on the same network talk directly; publishing exposes it to whoever can reach the host.' },
      ],
    },
    {
      id: 'compose',
      title: 'Docker Compose',
      summary: 'One compose.yaml for a whole stack: services, build, ports, environment and .env, depends_on with healthchecks, volumes, up/down.',
      minutes: 30,
      lab: {
        cwd: '~/shop',
        panels: ['docker', 'files'],
        setup(H) {
          H.docker('laptop');
          for (const [p, t] of Object.entries(SHOP_FILES)) H.write('laptop', `~/shop/${p}`, t, { owner: 'dev' });
          H.pull('laptop', 'postgres:16', 'redis:7-alpine', 'node:20-alpine');
        },
        suggestions: ['cat README.md', 'nano compose.yaml'],
        tasks: [
          { title: 'Read the old 14-step README and the `.env` file', solution: 'cat README.md .env', check: t => t.ran(/cat\b.*README/) },
          { title: 'Write `compose.yaml`: `api` (built from `.`, publishing 8080→3000, DATABASE_URL and REDIS_URL pointing at the other services by name, waiting for a healthy db), `db` (postgres:16, user `shop`, password from `${DB_PASSWORD}`, named volume, `pg_isready` healthcheck, no published port) and `cache` (redis:7-alpine)', hint: 'Compose reads `${DB_PASSWORD}` from the `.env` file next to compose.yaml, so the password never appears in the file.', solution: 'nano compose.yaml', test: [{ cmd: 'nano compose.yaml', edit: SHOP_COMPOSE() }], check: t => shopComposeOk(yaml(t, '~/shop/compose.yaml')) && !/devpass/.test(t.file('laptop', '~/shop/compose.yaml') || '') },
          { title: 'Bring the stack up in the background and check the API answers on port 8080', solution: 'docker compose up -d && curl -s localhost:8080/health', check: t => projectUp(t, 'laptop', 'shop', ['api', 'db', 'cache']) && httpOk(t, 'laptop', 'http://localhost:8080/health') },
          { title: 'See the services with their health, and read the API\'s logs', solution: 'docker compose ps && docker compose logs api', check: t => t.ran(/docker\s+compose\s+ps/) && t.ran(/docker\s+compose\s+logs/) },
          { title: 'Add data: create an `orders` table with one row, using `docker compose exec db psql -U shop -c "…"`', solution: 'docker compose exec db psql -U shop -c "CREATE TABLE orders (id int, item text); INSERT INTO orders VALUES (1, \'espresso beans\')"', check: t => count(t, 'laptop', 'shop-db-1', 'orders', 'shop') >= 1 },
          { title: 'End of the day: take the stack down (keeping data), bring it back up, and check the order is still there', solution: 'docker compose down && docker compose up -d && docker compose exec db psql -U shop -c "SELECT * FROM orders"', check: t => t.after(e => e.type === 'compose-down' && e.project === 'shop' && !e.volumes, e => e.type === 'compose-up' && e.project === 'shop') && !t.events('compose-down').some(e => e.volumes) && count(t, 'laptop', 'shop-db-1', 'orders', 'shop') >= 1 },
          { title: 'Port 8080 clashes with another tool. Change the API to publish 8081 instead and apply it with the same `up -d`', solution: 'sed -i "s/8080:3000/8081:3000/" compose.yaml && docker compose up -d && curl -s localhost:8081/health', check: t => httpOk(t, 'laptop', 'http://localhost:8081/health') && t.running('laptop', c => c.project === 'shop' && c.service === 'api' && c.ports.some(p => p.host === 8081)).length > 0 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'How does the `api` service reach the database in a compose project?', choices: ['By the database container\'s IP, looked up by hand', 'By the service name (`db`) on the project\'s network', 'Through a published port on localhost', 'Only with links:'], answer: 1, explain: 'Compose creates a network per project with DNS for service names.' },
        { type: 'mc', q: '`depends_on: db` without a condition guarantees…', choices: ['Postgres accepts connections before api starts', 'Only that the db container is started first', 'Nothing at all', 'That db is restarted with api'], answer: 1, explain: 'Add a healthcheck and `condition: service_healthy` to wait for readiness.' },
        { type: 'mc', q: 'What does `docker compose down -v` do that `down` does not?', choices: ['Shows verbose output', 'Deletes the named volumes, i.e. the data', 'Keeps the network', 'Removes images'], answer: 1, explain: 'Plain down keeps volumes.' },
        { type: 'multi', q: 'Where can `${DB_PASSWORD}` in compose.yaml get its value?', choices: ['The shell environment', 'A `.env` file next to compose.yaml', 'The Dockerfile', 'An env file listed under env_file: (for the container)'], answer: [0, 1], explain: 'Interpolation uses the shell and .env; env_file sets variables inside the container instead.' },
        { type: 'tf', q: 'Running `docker compose up -d` again after editing compose.yaml recreates only the services whose configuration changed.', answer: true, explain: 'Compose is declarative: it converges on what the file says.' },
        { type: 'mc', q: 'Which file belongs in git?', choices: ['.env with real passwords', '.env.example listing the variable names', 'Both', 'Neither'], answer: 1, explain: 'Commit the shape, not the secrets.' },
      ],
    },
    {
      id: 'registries-tags',
      title: 'Registries and tags',
      summary: 'Image names, tags vs digests, version + commit tags, docker login --password-stdin, push, pull and run on a server.',
      minutes: 25,
      lab: {
        cwd: '~/events',
        panels: ['docker', 'network'],
        setup(H) {
          registryWorld(H);
          for (const [p, t] of Object.entries(EVENTS_FILES)) H.write('laptop', `~/events/${p}`, t, { owner: 'dev' });
          H.run('cd ~/events && git init -q && git add . && git commit -qm "events service"', { on: 'laptop' });
          H.pull('laptop', 'node:20-alpine');
        },
        suggestions: ['git log --oneline', 'docker build -t events:1.4.2 .'],
        tasks: [
          { title: 'Build the service as `events:1.4.2`', solution: 'docker build -t events:1.4.2 .', check: t => !!t.image('laptop', 'events:1.4.2') },
          { title: `Tag it for Lumen's registry twice: \`${REG}/team/events:1.4.2\` and \`${REG}/team/events:sha-<short commit>\``, solution: `docker tag events:1.4.2 ${REG}/team/events:1.4.2 && docker tag events:1.4.2 ${REG}/team/events:sha-$(git rev-parse --short HEAD) && docker images`, check: t => { const a = t.image('laptop', `${REG}/team/events:1.4.2`); const sha = t.exec('laptop', 'cd ~/events && git rev-parse --short HEAD').out.trim(); const b = t.image('laptop', `${REG}/team/events:sha-${sha}`); return !!a && !!b && a === b && a === t.image('laptop', 'events:1.4.2'); } },
          { title: 'Push the version tag. It is refused: log in as `ci` with the token from `~/registry-token.txt`, passing it on stdin', solution: `docker push ${REG}/team/events:1.4.2; cat ~/registry-token.txt | docker login ${REG} -u ci --password-stdin`, check: t => t.events('docker-login').some(e => e.host === 'laptop' && e.stdin) && !t.ran(/docker\s+login\b.*\s(-p|--password)[\s=]/) },
          { title: 'Push both tags', solution: `docker push ${REG}/team/events:1.4.2 && docker push ${REG}/team/events:sha-$(git rev-parse --short HEAD)`, check: t => { const sha = t.exec('laptop', 'cd ~/events && git rev-parse --short HEAD').out.trim(); return !!t.pushed(`${REG}/team/events:1.4.2`) && !!t.pushed(`${REG}/team/events:sha-${sha}`); } },
          { title: 'On `app2` (ssh as ubuntu): log in, and run exactly that version as `events`, restarting unless stopped, published on port 80', solution: `ssh ubuntu@app2`, test: ['ssh ubuntu@app2', `cat ~/registry-token.txt | docker login ${REG} -u ci --password-stdin`, `docker run -d --name events --restart unless-stopped -p 80:3000 ${REG}/team/events:1.4.2`, 'exit'], check: t => { const c = t.container('app2', 'events'); return !!c && c.status === 'running' && /:1\.4\.2$/.test(c.imageRef) && c.restart === 'unless-stopped' && c.ports.some(p => p.host === 80); } },
          { title: 'From your laptop, open the site on app2', solution: 'curl -s http://app2/', check: t => t.events('http').some(e => e.host === 'laptop' && /\/\/app2\/?$/.test(e.url) && e.status === 200) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What image does `docker pull lumen/events` fetch?', choices: ['The newest version by date', '`docker.io/lumen/events:latest`, whatever that tag points to right now', 'Nothing: a tag is required', 'The version running in production'], answer: 1, explain: 'No registry → Docker Hub; no tag → :latest, a moving label.' },
        { type: 'mc', q: 'Which reference can never point to different bytes later?', choices: ['events:latest', 'events:1.4.2', 'events@sha256:9f86d0…', 'events:stable'], answer: 2, explain: 'A digest is the content hash. Tags can be moved (though good registries make version tags immutable).' },
        { type: 'mc', q: 'Why `--password-stdin` instead of `-p <password>`?', choices: ['It is faster', 'A password on the command line lands in shell history and is visible in the process list', '-p does not work', 'stdin encrypts it'], answer: 1, explain: 'Pipe it from a file or secret store.' },
        { type: 'multi', q: 'Good tagging habits:', choices: ['A version tag (1.4.2)', 'A commit tag (sha-3f9c2e1)', 'Deploying :latest to production', 'Never re-pushing a version tag with new content'], answer: [0, 1, 3], explain: 'Know exactly what runs where.' },
        { type: 'tf', q: '`docker tag` copies the image, doubling disk usage.', answer: false, explain: 'It adds another name to the same image ID.' },
        { type: 'mc', q: 'Who should push images to the production registry?', choices: ['Any developer from a laptop', 'The CI pipeline, after tests pass', 'The production server', 'Nobody: build on the server'], answer: 1, explain: 'Build once in CI; servers only pull.' },
      ],
    },
    {
      id: 'containers-boss',
      title: 'Boss: Containerise tickets',
      summary: 'A production-grade image, a compose stack with a healthy database and a volume, shipped through the registry and running on a server.',
      minutes: 45,
      boss: true,
      lab: {
        cwd: '~/tickets',
        panels: ['docker', 'network'],
        setup(H) {
          registryWorld(H);
          for (const [p, t] of Object.entries(TICKETS_FILES)) H.write('laptop', `~/tickets/${p}`, t, { owner: 'dev' });
          bigNodeModules(H, '~/tickets', { express: 2.1, pg: 0.9, jest: 38, eslint: 24 });
          H.pull('laptop', 'node:20-alpine', 'postgres:16');
          H.pull('app2', 'postgres:16');
        },
        suggestions: ['ls -la', 'cat server.js package.json'],
        tasks: [
          { title: `Write \`.dockerignore\` and a multi-stage, non-root \`Dockerfile\`; build \`${TICKETS_IMG}\` (under 250 MB, no .env, no dev dependencies)`, solution: `printf "node_modules\\n.env\\n.git\\n" > .dockerignore && nano Dockerfile && docker build -t ${TICKETS_IMG} .`, test: ['printf "node_modules\\n.env\\n.git\\n" > .dockerignore', { cmd: 'nano Dockerfile', edit: TICKETS_DF }, `docker build -t ${TICKETS_IMG} .`], check: t => goodImage(t.image('laptop', TICKETS_IMG)) },
          { title: 'Scan it: no critical vulnerabilities allowed', solution: `docker scout cves ${TICKETS_IMG}`, check: t => t.events('docker-scan').some(e => e.ref === TICKETS_IMG && e.counts[0] === 0) },
          { title: 'Write `compose.yaml`: `api` from that image tag publishing 80→3000 with DATABASE_URL built from `${DB_PASSWORD}`, waiting for a healthy `db`; `db` postgres:16 with user `tickets`, a named volume, a healthcheck and no published port; both `restart: unless-stopped`', solution: 'nano compose.yaml', test: [{ cmd: 'nano compose.yaml', edit: TICKETS_COMPOSE }], check: t => ticketsComposeOk(yaml(t, '~/tickets/compose.yaml')) },
          { title: 'Try the stack on your laptop and check `/health`', solution: 'docker compose up -d && curl -s localhost/health', check: t => projectUp(t, 'laptop', 'tickets', ['api', 'db']) && httpOk(t, 'laptop', 'http://localhost/health') },
          { title: 'Push the image to the registry (log in with the token on stdin)', solution: `cat ~/registry-token.txt | docker login ${REG} -u ci --password-stdin && docker push ${TICKETS_IMG}`, check: t => !!t.pushed(TICKETS_IMG) && !t.ran(/docker\s+login\b.*\s(-p|--password)[\s=]/) },
          { title: 'Deploy on `app2`: copy `compose.yaml` and `.env` to `~/tickets` there, log in to the registry on app2, and bring the stack up', solution: 'ssh ubuntu@app2 mkdir -p tickets && scp compose.yaml .env ubuntu@app2:tickets/ && ssh ubuntu@app2', test: ['ssh ubuntu@app2 mkdir -p tickets && scp compose.yaml .env ubuntu@app2:tickets/', 'ssh ubuntu@app2', `cat ~/registry-token.txt | docker login ${REG} -u ci --password-stdin`, 'cd tickets && docker compose up -d', 'exit'], check: t => projectUp(t, 'app2', 'tickets', ['api', 'db']) && t.running('app2', c => c.service === 'api' && /tickets:1\.0\.0$/.test(c.imageRef)).length > 0 },
          { title: 'From your laptop, check that app2 serves `/health`', solution: 'curl -s http://app2/health', check: t => t.events('http').some(e => e.host === 'laptop' && /\/\/app2\/health/.test(e.url) && e.status === 200) },
          { title: 'Prove the data survives on app2: create a `tickets` table with a row, run `docker compose down` and `up -d`, and read the row back', solution: 'ssh ubuntu@app2', test: ['ssh ubuntu@app2', 'cd tickets && docker compose exec db psql -U tickets -c "CREATE TABLE tickets (id int, title text); INSERT INTO tickets VALUES (1, \'Printer on fire\')"', 'docker compose down && docker compose up -d && docker compose exec db psql -U tickets -c "SELECT * FROM tickets"', 'exit'], check: t => t.after(e => e.type === 'compose-down' && e.host === 'app2' && !e.volumes, e => e.type === 'compose-up' && e.host === 'app2') && count(t, 'app2', 'tickets-db-1', 'tickets', 'tickets') >= 1 },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the path of a change to production in this realm.', items: ['Write the Dockerfile and .dockerignore', 'Build and scan the image', 'Tag it with a version', 'Push to the registry', 'Pull and run it on the server with compose'], explain: 'Build once, ship the same image.' },
        { type: 'multi', q: 'Which make the tickets image production-grade?', choices: ['Multi-stage build with production dependencies only', 'Runs as a non-root user', 'No .env or secrets inside', 'Based on the full node:20 image for convenience'], answer: [0, 1, 2], explain: 'Small and minimal beats convenient.' },
        { type: 'mc', q: 'After `docker compose down` and `up -d` on app2, why are the tickets still there?', choices: ['Compose caches tables', 'Postgres stores them in the named volume, which down does not delete', 'They are in the image', 'They were never deleted because down failed'], answer: 1, explain: 'Only down -v deletes volumes.' },
        { type: 'mc', q: 'The compose file on app2 refers to `registry.lumen.dev/team/tickets:1.0.0` rather than `build: .`. Why?', choices: ['Servers cannot build', 'The server should run the exact image that was built and scanned, not build its own', 'build: . is deprecated', 'It is faster to type'], answer: 1, explain: 'Build once, deploy the same bytes.' },
        { type: 'tf', q: 'The database port should be published on app2 so the API can reach it.', answer: false, explain: 'They share the compose network; publishing it only exposes it to the outside.' },
      ],
    },
  ],
};
