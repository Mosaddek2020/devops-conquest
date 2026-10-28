import { relWorld } from './r10-reliability.js';
import devsecops from './r11-devsecops.js';
import aiops from './r12-aiops.js';
import hero from './r14-hero.js';

// Sandbox starting points. Later simulators add more (containers, clusters, cloud).

export const SCENARIOS = {
  laptop: {
    title: 'Just your laptop',
    note: 'A Linux laptop with your home folder. Try: ls -la, cat /etc/os-release, echo $PATH, ps aux',
    setup(H) {
      H.write('laptop', '~/notes.txt', 'Things to learn:\n- the shell\n- networking\n- containers\n', { owner: 'dev' });
      H.write('laptop', '~/scripts/hello.sh', '#!/bin/bash\necho "Hello, $USER! Today is $(date +%A)."\n', { owner: 'dev', mode: 0o755 });
    },
    panels: ['system', 'files'],
  },
  server: {
    title: 'One Ubuntu server',
    note: 'web1 is a fresh Ubuntu server and your SSH key is already authorized. Try: ssh ubuntu@web1, then sudo apt install -y nginx',
    setup(H) {
      H.server('web1', { fqdn: ['web1.example.com'] });
      H.authorize('laptop', 'dev', 'web1', 'ubuntu');
      H.dns('web1.example.com', 'web1');
    },
    panels: ['network', 'system', 'files'],
  },
  webstack: {
    title: 'Web app + database',
    note: 'shop.example.com: nginx and a Node app on web1, PostgreSQL on db1. Try: curl -i http://shop.example.com/health, then ssh in and explore',
    setup(H) {
      const web = H.server('web1', { fqdn: ['shop.example.com'] });
      const db = H.server('db1');
      H.authorize('laptop', 'dev', 'web1', 'ubuntu');
      H.authorize('laptop', 'dev', 'db1', 'ubuntu');
      H.install('db1', 'postgresql');
      H.write('db1', '/etc/postgresql/16/main/postgresql.conf', "listen_addresses = '*'\nport = 5432\n");
      H.run('sudo systemctl restart postgresql', { on: 'db1' });
      H.install('web1', 'nginx', 'nodejs', 'npm');
      H.mkdir('web1', '/opt/shop', { owner: 'ubuntu' });
      H.write('web1', '/opt/shop/server.js', "const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || 3000;\nconst db = connect(process.env.DATABASE_URL);\n\napp.get('/health', (req, res) => res.json({ status: 'ok', version: process.env.VERSION || 'dev' }));\napp.get('/', (req, res) => res.send('Welcome to the shop'));\n\napp.listen(PORT, () => console.log(`shop listening on port ${PORT}`));\n", { owner: 'ubuntu' });
      H.mkdir('web1', '/opt/shop/node_modules/express', { owner: 'ubuntu' });
      H.service('web1', 'shop', '[Unit]\nDescription=Shop web app\nAfter=network.target\n\n[Service]\nUser=ubuntu\nWorkingDirectory=/opt/shop\nEnvironment=PORT=3000\nEnvironment=VERSION=1.4.2\nEnvironment=DATABASE_URL=postgres://db1:5432/shop\nExecStart=/usr/bin/node server.js\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n');
      H.write('web1', '/etc/nginx/sites-available/shop', 'server {\n    listen 80;\n    server_name shop.example.com;\n\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}\n');
      H.run('sudo ln -s /etc/nginx/sites-available/shop /etc/nginx/sites-enabled/shop && sudo rm /etc/nginx/sites-enabled/default && sudo systemctl reload nginx', { on: 'web1' });
      H.dns('shop.example.com', 'web1');
      void web; void db;
    },
    panels: ['network', 'system', 'files'],
  },
  docker: {
    title: 'Docker playground',
    note: 'Docker is installed and you are in the docker group; a small Node app is in ~/app. Try: docker run -d -p 8080:80 nginx, curl localhost:8080, then write a Dockerfile for ~/app and docker build -t app .',
    setup(H) {
      H.docker('laptop');
      H.write('laptop', '~/app/server.js', "const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || 3000;\napp.get('/', (req, res) => res.send('Hello from a container'));\napp.get('/health', (req, res) => res.json({ status: 'ok' }));\napp.listen(PORT, () => console.log(`app listening on ${PORT}`));\n", { owner: 'dev' });
      H.write('laptop', '~/app/package.json', '{\n  "name": "app",\n  "version": "1.0.0",\n  "dependencies": { "express": "^4.21.1" }\n}\n', { owner: 'dev' });
      H.write('laptop', '~/app/package-lock.json', '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "packages": { "node_modules/express": { "version": "4.21.1" } }\n}\n', { owner: 'dev' });
      H.pull('laptop', 'nginx', 'alpine', 'node:20-alpine');
    },
    panels: ['docker', 'files', 'system'],
  },
  k8s: {
    title: 'Kubernetes cluster',
    note: 'A cluster called lumen (control plane + 2 workers) with an ingress controller; kubectl is configured. Try: kubectl get nodes, kubectl create deployment web --image=nginx:1.27 --replicas=3, kubectl expose deployment web --port=80, then curl it from a pod: kubectl run tmp --image=curlimages/curl --rm -it --restart=Never -- curl -s http://web',
    setup(H) {
      const c = H.cluster('lumen', { ingress: true });
      H.dns('app.lumen.dev', c.ingressHost.ip);
    },
    panels: ['cluster', 'files'],
  },
  cloud: {
    title: 'Cloud + Terraform + Ansible',
    note: 'An AWS-like account with credentials, an SSH key, terraform and ansible installed, and a starter config in ~/infra. Try: cd infra && terraform init && terraform plan, then apply and curl the output IP.',
    setup(H) {
      H.cloud({ tools: ['awscli', 'terraform', 'ansible'] });
      H.run('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q', { on: 'laptop' });
      H.write('laptop', '~/infra/main.tf', 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }\n  }\n}\n\nprovider "aws" {\n  region = "eu-west-1"\n}\n\nresource "aws_key_pair" "me" {\n  key_name   = "me"\n  public_key = file("~/.ssh/id_ed25519.pub")\n}\n\nresource "aws_security_group" "web" {\n  name = "web"\n  ingress {\n    from_port   = 80\n    to_port     = 80\n    protocol    = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n  ingress {\n    from_port   = 22\n    to_port     = 22\n    protocol    = "tcp"\n    cidr_blocks = ["198.51.100.23/32"]\n  }\n}\n\nresource "aws_instance" "web" {\n  ami                    = "ami-0a7f1556c36aea1b6"\n  instance_type          = "t3.micro"\n  key_name               = aws_key_pair.me.key_name\n  vpc_security_group_ids = [aws_security_group.web.id]\n  user_data              = <<-EOF\n    #!/bin/bash\n    apt-get install -y nginx\n  EOF\n  tags = {\n    Name = "sandbox-web"\n  }\n}\n\noutput "public_ip" {\n  value = aws_instance.web.public_ip\n}\n', { owner: 'dev' });
    },
    panels: ['cloud', 'files'],
  },
  observe: {
    title: 'Monitored shop',
    note: 'A shop on web1 with real traffic, node_exporter, Prometheus + Alertmanager on mon, logs and traces. Try: promtool query instant http://mon:9090 \'sum by (route) (rate(http_requests_total[5m]))\', logcli query \'{app="shop", level="error"}\', traces search --service shop --min-duration 500ms',
    setup(H) {
      H.observe();
      H.server('web1', { packages: ['nodejs', 'prometheus-node-exporter'] });
      H.mkdir('web1', '/opt/shop/node_modules/express', { owner: 'ubuntu' });
      H.mkdir('web1', '/opt/shop/node_modules/prom-client', { owner: 'ubuntu' });
      H.write('web1', '/opt/shop/server.js', "const express = require('express');\nconst client = require('prom-client');\nconst app = express();\napp.get('/', (req, res) => res.send('shop'));\napp.listen(3000);\n", { owner: 'ubuntu' });
      H.service('web1', 'shop', '[Unit]\nDescription=shop\n[Service]\nUser=ubuntu\nWorkingDirectory=/opt/shop\nExecStart=/usr/bin/node server.js\nRestart=always\n[Install]\nWantedBy=multi-user.target\n');
      H.traffic('web1', 3000, 'shop', { '/': { rps: 15, p50: 0.03, p99: 0.15, err: 0.002 }, '/checkout': { rps: 2, p50: 0.2, p99: 1.4, err: 0.02, method: 'POST', slowFrac: 0.05, spans: [['auth', 'verify session', 0.1], ['payments', 'POST /charge', 0.6, { children: [['bank-api', 'authorize card', 0.8]] }], ['db', 'INSERT order', 0.2]] } });
      H.server('mon', { packages: ['prometheus', 'prometheus-alertmanager'] });
      H.authorize('laptop', 'dev', 'mon', 'ubuntu');
      H.authorize('laptop', 'dev', 'web1', 'ubuntu');
      H.write('mon', '/etc/prometheus/prometheus.yml', 'global:\n  scrape_interval: 15s\n\nscrape_configs:\n  - job_name: prometheus\n    static_configs:\n      - targets: ["localhost:9090"]\n  - job_name: node\n    static_configs:\n      - targets: ["web1:9100"]\n  - job_name: shop\n    static_configs:\n      - targets: ["web1:3000"]\n');
      H.run('sudo systemctl restart prometheus', { on: 'mon' });
      H.install('laptop', 'prometheus', 'logcli', 'traces');
      H.uni.advance(1200);
    },
    panels: ['observe', 'files'],
  },
  reliable: {
    title: 'Redundant shop',
    note: 'nginx on lb balancing web1 and web2, PostgreSQL with 100 orders on db1 and an S3 bucket for backups. Try: ab -n 200 -c 10 http://shop.lumen.dev/, stop the shop on one server, incident declare --sev 3 --title "game day", ssh ubuntu@db1 then sudo -u postgres pg_dump shop -f /var/backups/shop.sql',
    setup(H) { relWorld(H, { db: true, orders: 100, cloud: true }); },
    panels: ['network', 'system'],
  },
  secure: {
    title: 'Security workbench',
    note: 'web1 runs the shop site with nginx and an exposed Redis, and every scanner is on your laptop. Try: ssh ubuntu@web1 sudo lynis audit system, zap-baseline.py -t http://shop.lumen.dev/, trivy config ~/infra, gitleaks dir ~, semgrep scan --config auto ~/infra.',
    setup(H) {
      const lab = name => devsecops.lessons.find(l => l.id === name).lab;
      lab('threat-modeling').setup(H);
      for (const p of ['/var/www/shop/index.html', '/var/www/shop/about.html', '/var/www/shop/.env']) H.write('web1', p, p.endsWith('.env') ? 'DB_PASSWORD=Shop-db-2026!\n' : '<!doctype html>\n<h1>Lumen shop</h1>\n<a href="/about.html">About</a>\n');
      H.write('web1', '/etc/nginx/sites-enabled/default', 'server {\n    listen 80;\n    server_name shop.lumen.dev web1;\n    root /var/www/shop;\n    index index.html;\n}\n');
      H.dns('shop.lumen.dev', 'web1');
      H.run('sudo systemctl reload nginx', { on: 'web1' });
      lab('misconfig').setup(H);
      H.install('laptop', 'gitleaks', 'semgrep', 'syft', 'cosign', 'zaproxy');
    },
    panels: ['network', 'files'],
  },
  aiops: {
    title: 'AI ops desk',
    note: 'An LLM gateway on ai1 with Prometheus on mon, and an ops agent on your laptop with no policy yet. Try: promtool query instant http://mon:9090 \'sum by (client) (rate(llm_cost_usd_total[5m])) * 3600\', agent plan "free disk space on db1", shellcheck, ai explain "…".',
    setup(H) {
      const lab = name => aiops.lessons.find(l => l.id === name).lab;
      lab('llm-services').setup(H);
      lab('ai-agents').setup(H);
      H.install('laptop', 'shellcheck');
    },
    panels: ['observe', 'system'],
  },
  pipeline: {
    title: 'Pipeline to cluster',
    note: 'The notify service in ~/notify with a private registry, a Kubernetes cluster with an ingress for notify.lumen.dev, and CI secrets ready. Build the image, write manifests and a delivery workflow, and push.',
    setup(H) { hero.lessons.find(l => l.id === 'hero-delivery').lab.setup(H); },
    cwd: '~/notify',
    panels: ['cluster', 'github'],
  },
};
