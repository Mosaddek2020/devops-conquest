// Docker scenario: install, run, build, ports, networks, volumes, compose, registry.
import '../js/sim/index.js';
import { Session } from '../js/sim/session.js';
import { newUniverse, addLaptop } from '../js/sim/machines.js';
import { stripAnsi } from '../js/git/world.js';

const uni = newUniverse();
const laptop = addLaptop(uni);
const s = new Session(uni, laptop);
let fails = 0;
const run = (cmd, expect, not) => {
  const r = s.run(cmd);
  const out = r.out.map(stripAnsi).join('\n');
  const ok = (!expect || (expect instanceof RegExp ? expect.test(out) : out.includes(expect))) && (!not || !(not instanceof RegExp ? not.test(out) : out.includes(not)));
  if (!ok) { fails++; console.log(`✗ ${cmd}\n${out.split('\n').map(l => '    ' + l).join('\n')}`); }
  else console.log(`✓ ${cmd.split('\n')[0]}`);
  if (process.argv.includes('-v')) console.log(out.split('\n').map(l => '    ' + l).join('\n'));
  return out;
};
run('docker ps', /Command 'docker' not found/);
run('sudo apt install -y docker.io', /Setting up docker.io/);
run('docker ps', /permission denied while trying to connect/);
run('sudo usermod -aG docker dev');
run('docker ps', 'CONTAINER ID');
run('docker run hello-world', /Unable to find image|pull access denied/);
run('docker run alpine echo hi from alpine', 'hi from alpine');
run('docker run alpine bash -c "echo x"', /executable file not found/);
run('docker ps -a', /Exited \(0\)/);
run('docker images', /alpine\s+3\.20|alpine\s+latest/);
run('docker run -d --name web -p 8080:80 nginx', /^[0-9a-f]{64}$/m);
run('curl -s localhost:8080', 'Welcome to nginx');
run('docker ps', /0\.0\.0\.0:8080->80\/tcp\s+web/);
run('docker run -d --name web2 -p 8080:80 nginx', /port is already allocated/);
run('docker exec web cat /etc/os-release', 'Debian');
run('docker exec -it web bash');
run('hostname; whoami', /root/);
run('echo "<h1>edited inside</h1>" > /usr/share/nginx/html/index.html; exit');
run('curl -s localhost:8080', 'edited inside');
run('docker rm -f web && docker run -d --name web -p 8080:80 nginx >/dev/null && curl -s localhost:8080', 'Welcome to nginx');
// build an app image
run('mkdir -p ~/app && cd ~/app');
run(`cat > server.js <<'EOF'
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('hello from the container'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(\`listening on \${PORT}\`));
EOF`);
run(`echo '{"name":"app","version":"1.0.0","scripts":{"start":"node server.js"},"dependencies":{"express":"^4.21.1"},"devDependencies":{"jest":"^29.7.0"}}' > package.json`);
run(`cat > Dockerfile <<'EOF'
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["node", "server.js"]
EOF`);
run('docker build -t app:1 .', /naming to docker.io\/library\/app:1/);
run('docker images app', /app\s+1/);
run('docker run -d -p 3000:3000 --name app1 app:1 && curl -s localhost:3000', 'hello from the container');
run('docker build -t app:1 .', /CACHED/);
run('docker history app:1', /npm install/);
run(`cat > Dockerfile <<'EOF'
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server.js .
USER nonroot
CMD ["server.js"]
EOF`);
run('sudo apt install -y nodejs npm >/dev/null; npm install >/dev/null; echo "node_modules\n.git" > .dockerignore; docker build -t app:2 .', /naming to/);
run('docker images', /app\s+2/);
run('docker run -d -p 3001:3000 --name app2 app:2 && curl -s localhost:3001/health', 'ok');
run('docker exec -it app2 sh', /executable file not found/);
// networks
run('docker run -d --name cache redis:7-alpine', /^[0-9a-f]{64}$/m);
run('docker exec app1 sh -c "getent hosts cache || echo none"', '');
run('docker network create appnet && docker network connect appnet cache');
run('docker network ls', 'appnet');
// volumes
run('docker volume create pgdata && docker run -d --name db -e POSTGRES_PASSWORD=secret -v pgdata:/var/lib/postgresql/data postgres:16', /^[0-9a-f]{64}$/m);
run('docker exec db sh -c "echo row1 > /var/lib/postgresql/data/table.txt"');
run('docker rm -f db && docker run -d --name db -e POSTGRES_PASSWORD=secret -v pgdata:/var/lib/postgresql/data postgres:16 >/dev/null && docker exec db cat /var/lib/postgresql/data/table.txt', 'row1');
run('docker run -d --name db2 postgres:16; sleep 1; docker logs db2', /POSTGRES_PASSWORD/);
// compose
run('mkdir -p ~/stack && cd ~/stack && cp ~/app/server.js ~/app/package.json ~/app/package-lock.json . && printf "FROM node:20-slim\\nWORKDIR /app\\nCOPY . .\\nRUN npm ci --omit=dev\\nCMD [\\"node\\",\\"server.js\\"]\\n" > Dockerfile');
run(`cat > compose.yaml <<'EOF'
services:
  api:
    build: .
    ports:
      - "4000:3000"
    environment:
      REDIS_URL: redis://cache:6379
    depends_on:
      cache:
        condition: service_healthy
  cache:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
volumes:
  data:
EOF`);
run('docker compose up -d', /Container stack-api-1\s+Started/);
run('docker compose ps', /stack-cache-1/);
run('curl -s localhost:4000', 'hello from the container');
run('docker compose down', /Removed/);
// registry
run('docker tag app:2 registry.example.com/team/app:2 && docker push registry.example.com/team/app:2', /authentication required/);
run('echo s3cret | docker login registry.example.com -u ci --password-stdin', 'Login Succeeded');
run('docker push registry.example.com/team/app:2', /digest: sha256/);
run('docker system df', /Images/);
console.log(fails ? `\n${fails} FAILED` : '\nall docker checks passed');
process.exit(fails ? 1 : 0);
