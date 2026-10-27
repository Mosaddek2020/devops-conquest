// Realm 11 · DevSecOps: threat modelling and host hardening, leaked secrets and key rotation,
// SAST, DAST, SBOMs and image signing, IaC misconfiguration scanning, Kubernetes pod security
// and CI security gates. Every lab is defensive: find the problem with a scanner, fix it,
// prove the fix with a clean re-scan, and add a guard rail so it does not come back.

import { pmOk, inc } from './r10-reliability.js';
import { UBUNTU_AMI } from '../sim/cloud.js';
import { sshdConfig } from '../sim/sshdconf.js';
import { scanHistory } from '../sim/security.js';

// Keys and tokens are assembled at run time so this source never contains anything that
// looks like a real credential (GitHub push protection and secret scanners stay quiet).
const AK = s => 'AKIA' + s;
const LEAK = AK('Q4LUMEN7DEMO2KEY');
const LEAK_SECRET = ['wJ8rLumen', 'DemoSecret', 'Key2026k9Vq3XyZ0aBcD'].join('');
const SYNC_KEY = AK('Z7DATASYNC3LEAKX');
const SYNC_SECRET = ['Zs9dLumen', 'SyncSecret', 'Key2026mP4tW8nQ1eRu'].join('');
const FIXTURE_KEY = ['sk', 'test', '51LumenFixture000000000000'].join('_');
const LIVE_KEY = ['sk', 'live', '51LumenDemo9xQ2mZ7vRk3'].join('_');
const PINS = {
  checkout: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  gitleaks: 'gitleaks/gitleaks-action@83373cf2f8c4db6e24b41c1a9b086bb9619e9cd3',
  trivy: 'aquasecurity/trivy-action@18f2510ee396bbf400402947b394f2dd8c87dbb0',
};

const file = (t, p) => t.file('laptop', p) || '';
const last = (t, type, pred = () => true) => t.events(type).filter(pred).slice(-1)[0] || null;
const gitShow = (t, dir, spec) => { const r = t.exec('laptop', `cd ${dir} && git show ${spec}`); return r.code === 0 ? r.out : null; };
const remoteHead = (t, repo, branch = 'main') => t.remote(repo)?.refs['refs/heads/' + branch] || null;
const remoteFile = (t, repo, path, branch = 'main') => {
  const h = remoteHead(t, repo, branch);
  if (!h) return null;
  const blob = t.uni.readTreeFlat(t.uni.commit(h).tree).get(path);
  return blob ? t.uni.objects.get(blob)?.content ?? null : null;
};
const runsOf = (t, repo, wf) => (t.remote(repo)?.meta.runs || []).filter(r => !wf || r.file === wf);
const lastRun = (t, repo, wf) => runsOf(t, repo, wf)[0] || null;
const runLog = r => (r?.jobs || []).flatMap(j => j.log || []).join('\n');
const pinned = text => { const uses = [...String(text).matchAll(/uses:\s*(\S+)/g)].map(m => m[1]); return uses.length > 0 && uses.every(u => /@[0-9a-f]{40}$/.test(u)); };
const iamKeys = (t, user) => t.cloud()?.iam?.users.get(user)?.keys || [];
const credKey = (t, host, home) => (t.file(host, `${home}/.aws/credentials`) || '').match(/aws_access_key_id\s*=\s*(\S+)/)?.[1] || null;
const trivyJson = (t, cmd) => { const r = t.exec('laptop', cmd); try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return null; } };
const misconfIds = j => (j?.Results || []).flatMap(r => (r.Misconfigurations || []).map(m => m.ID));

// ------------------------------------------------------------ threat modelling

const SSHD_WEAK = ['# /etc/ssh/sshd_config', 'Port 22', 'PermitRootLogin yes', 'PasswordAuthentication yes', 'PubkeyAuthentication yes', 'X11Forwarding yes', ''].join('\n');
const SSHD_GOOD = ['# /etc/ssh/sshd_config', 'Port 22', 'PermitRootLogin no', 'PasswordAuthentication no', 'PubkeyAuthentication yes', 'X11Forwarding no', ''].join('\n');
const SHOP_ENV = 'PORT=3000\nREDIS_URL=redis://127.0.0.1:6379\nDB_PASSWORD=Shop-db-2026!\nSESSION_SECRET=9f1c7e2a4b8d3f60\n';
const THREATS = ['# Threat model: web1 (shop, nginx, Redis)', '', '## What we are building', 'Customers reach nginx on web1 over HTTP; nginx serves the shop; sessions live in Redis on the same server; secrets are in /etc/shop/shop.env.', '', '## What can go wrong (STRIDE)', '- Spoofing: stolen session ids from an exposed Redis let someone log in as a customer. Mitigation: Redis on 127.0.0.1 only, firewall. Owner: @dev', '- Tampering: anyone who reaches Redis can change sessions or cart data. Mitigation: bind + firewall + requirepass. Owner: @dev', '- Repudiation: shared root login over SSH hides who did what. Mitigation: no root login, personal keys, sudo logs. Owner: @priya', '- Information disclosure: shop.env was readable by every user. Mitigation: chmod 600. Owner: @dev', '- Denial of service: password SSH invites brute force. Mitigation: keys only, fail2ban. Owner: @kofi', '- Elevation of privilege: root SSH login with a password. Mitigation: PermitRootLogin no. Owner: @priya', '', '## Did we do a good job?', 'lynis hardening index re-checked monthly in CI.', ''].join('\n');

// ------------------------------------------------------------ secrets

const PAY_SERVER = "const express = require('express');\nconst app = express();\napp.get('/health', (req, res) => res.json({ ok: true }));\napp.listen(process.env.PORT || 3000);\n";

// ------------------------------------------------------------ SAST

const ORDERS_VULN = ["const express = require('express');", "const db = require('../db');", 'const router = express.Router();', '', "router.get('/orders', async (req, res) => {", '  const id = req.query.id;', `  const sql = "SELECT * FROM orders WHERE id = '" + id + "'";`, '  const rows = await db.query(sql);', '  res.json(rows);', '});', '', 'module.exports = router;', ''].join('\n');
const ORDERS_AI = ["const express = require('express');", "const db = require('../db');", 'const router = express.Router();', '', "router.get('/orders', async (req, res) => {", '  // escape single quotes so the id cannot break out of the SQL string', `  const id = String(req.query.id || '').replace(/'/g, "''");`, `  const sql = "SELECT * FROM orders WHERE id = '" + id + "'";`, '  const rows = await db.query(sql);', '  res.json(rows);', '});', '', 'module.exports = router;', ''].join('\n');
const ORDERS_FIXED = ["const express = require('express');", "const db = require('../db');", 'const router = express.Router();', '', "router.get('/orders', async (req, res) => {", '  const id = req.query.id;', "  const rows = await db.query('SELECT * FROM orders WHERE id = $1', [id]);", '  res.json(rows);', '});', '', 'module.exports = router;', ''].join('\n');
const PAYMENTS = ["const express = require('express');", "const payments = require('../payments');", 'const router = express.Router();', '', "router.post('/payments', async (req, res) => {", "  console.log('payment request', req.body);", '  const { amount, card } = req.body;', '  const result = await payments.charge({ amount, card });', '  res.json({ id: result.id });', '});', '', 'module.exports = router;', ''].join('\n');
const PAYMENTS_FIXED = PAYMENTS.replace("  console.log('payment request', req.body);\n", "  console.log('payment request received');\n");
const RULE = ['rules:', '  - id: lumen-no-request-body-logging', '    message: Do not log request bodies. They contain card numbers and passwords; log only the fields you need.', '    severity: ERROR', '    languages: [javascript]', "    pattern-regex: 'console\\.(log|info|debug)\\(.*req\\.body'", ''].join('\n');
const SQL_LINE = (t, line) => t.events('semgrep').some(e => e.findings.some(f => /tainted-sql/.test(f.rule) && /routes\/orders\.js$/.test(f.file) && f.line === line));

// ------------------------------------------------------------ DAST

const SHOP_SITE = 'server {\n    listen 80;\n    server_name shop.lumen.dev;\n    root /var/www/shop;\n    index index.html;\n}\n';
const SHOP_SITE_FIXED = ['server {', '    listen 80;', '    server_name shop.lumen.dev;', '    root /var/www/shop;', '    index index.html;', '', '    server_tokens off;', '    add_header X-Content-Type-Options "nosniff";', '    add_header X-Frame-Options "DENY";', `    add_header Content-Security-Policy "default-src 'self'";`, '', '    # never serve dotfiles (.env, .git)', '    location ~ /\\. {', '        deny all;', '    }', '}', ''].join('\n');

// ------------------------------------------------------------ supply chain

const SHOP_PKG = v => JSON.stringify({ name: 'shop', version: v, dependencies: { express: '4.21.1', lodash: v === '1.4.0' ? '4.17.15' : '4.17.21' } }, null, 2) + '\n';
const SHOP_JS = "const express = require('express');\nconst _ = require('lodash');\nconst app = express();\napp.get('/', (req, res) => res.send(_.capitalize('lumen shop')));\napp.listen(3000);\n";
const SHOP_DOCKERFILE = 'FROM node:20-alpine\nWORKDIR /app\nCOPY package.json .\nRUN npm install --omit=dev\nCOPY server.js .\nUSER node\nCMD ["node", "server.js"]\n';
const signedDigest = (t, ref) => t.events('cosign').some(e => e.op === 'sign' && e.byDigest && e.ref === ref && e.digest === t.pushed(ref)?.digest);
const tampered = t => /collect\.js/.test(Object.keys(t.pushed('registry.lumen.dev/shop:1.5')?.image.files || {}).join(' '));

// ------------------------------------------------------------ misconfiguration

const TF = ['resource "aws_security_group" "web" {', '  name = "shop-web"', '', '  ingress {', '    description = "SSH for debugging"', '    from_port   = 22', '    to_port     = 22', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '', '  ingress {', '    description = "public HTTPS"', '    from_port   = 443', '    to_port     = 443', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '}', '', 'resource "aws_instance" "web" {', `  ami                    = "${UBUNTU_AMI}"`, '  instance_type          = "t3.small"', '  vpc_security_group_ids = [aws_security_group.web.id]', '}', '', 'resource "aws_s3_bucket" "assets" {', '  bucket = "lumen-shop-assets"', '}', ''].join('\n');
const TF_FIXED = ['resource "aws_security_group" "web" {', '  name = "shop-web"', '', '  ingress {', '    description = "SSH from the office VPN only"', '    from_port   = 22', '    to_port     = 22', '    protocol    = "tcp"', '    cidr_blocks = ["203.0.113.0/24"]', '  }', '', '  #trivy:ignore:AVD-AWS-0107 public HTTPS is the website itself; reviewed by @priya 2026-03-12', '  ingress {', '    description = "public HTTPS"', '    from_port   = 443', '    to_port     = 443', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '}', '', 'resource "aws_instance" "web" {', `  ami                    = "${UBUNTU_AMI}"`, '  instance_type          = "t3.small"', '  vpc_security_group_ids = [aws_security_group.web.id]', '', '  metadata_options {', '    http_tokens = "required"', '  }', '', '  root_block_device {', '    encrypted = true', '  }', '}', '', 'resource "aws_s3_bucket" "assets" {', '  bucket = "lumen-shop-assets"', '}', '', 'resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {', '  bucket = aws_s3_bucket.assets.id', '  rule {', '    apply_server_side_encryption_by_default {', '      sse_algorithm = "AES256"', '    }', '  }', '}', '', 'resource "aws_s3_bucket_versioning" "assets" {', '  bucket = aws_s3_bucket.assets.id', '  versioning_configuration {', '    status = "Enabled"', '  }', '}', '', 'resource "aws_s3_bucket_public_access_block" "assets" {', '  bucket                  = aws_s3_bucket.assets.id', '  block_public_acls       = true', '  block_public_policy     = true', '  ignore_public_acls      = true', '  restrict_public_buckets = true', '}', ''].join('\n');
const API_DOCKERFILE = 'FROM node:20\nWORKDIR /app\nENV API_TOKEN=lumen-7f3a9c2e1b8d4a60\nCOPY . .\nRUN npm ci --omit=dev\nCMD ["node", "server.js"]\n';
const API_DOCKERFILE_FIXED = 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER node\nHEALTHCHECK CMD wget -qO- http://localhost:3000/health || exit 1\nCMD ["node", "server.js"]\n';
const API_YAML = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: api', 'spec:', '  replicas: 2', '  selector:', '    matchLabels:', '      app: api', '  template:', '    metadata:', '      labels:', '        app: api', '    spec:', '      containers:', '        - name: api', '          image: registry.lumen.dev/api:latest', '          ports:', '            - containerPort: 3000', '          securityContext:', '            privileged: true', ''].join('\n');
const API_YAML_FIXED = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: api', 'spec:', '  replicas: 2', '  selector:', '    matchLabels:', '      app: api', '  template:', '    metadata:', '      labels:', '        app: api', '    spec:', '      containers:', '        - name: api', '          image: registry.lumen.dev/api:2.3.1', '          ports:', '            - containerPort: 3000', '          resources:', '            limits:', '              cpu: 500m', '              memory: 256Mi', '          securityContext:', '            runAsNonRoot: true', '            runAsUser: 10001', '            allowPrivilegeEscalation: false', '            readOnlyRootFilesystem: true', '            capabilities:', '              drop: ["ALL"]', '            seccompProfile:', '              type: RuntimeDefault', ''].join('\n');

// ------------------------------------------------------------ Kubernetes

const K8S_API = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: api', '  namespace: shop', 'spec:', '  replicas: 2', '  selector:', '    matchLabels:', '      app: api', '  template:', '    metadata:', '      labels:', '        app: api', '    spec:', '      containers:', '        - name: api', '          image: hashicorp/http-echo:1.0', '          args: ["-text=lumen api", "-listen=:5678"]', '          ports:', '            - containerPort: 5678', ''].join('\n');
const K8S_API_FIXED = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: api', '  namespace: shop', 'spec:', '  replicas: 2', '  selector:', '    matchLabels:', '      app: api', '  template:', '    metadata:', '      labels:', '        app: api', '    spec:', '      securityContext:', '        runAsNonRoot: true', '        runAsUser: 10001', '        seccompProfile:', '          type: RuntimeDefault', '      containers:', '        - name: api', '          image: hashicorp/http-echo:1.0', '          args: ["-text=lumen api", "-listen=:5678"]', '          ports:', '            - containerPort: 5678', '          resources:', '            limits:', '              cpu: 200m', '              memory: 64Mi', '          securityContext:', '            allowPrivilegeEscalation: false', '            readOnlyRootFilesystem: true', '            capabilities:', '              drop: ["ALL"]', ''].join('\n');
const K8S_DEBUG = ['apiVersion: v1', 'kind: Pod', 'metadata:', '  name: debug', '  namespace: shop', 'spec:', '  containers:', '    - name: debug', '      image: nginx:1.27', '      securityContext:', '        privileged: true', ''].join('\n');
const nsLabels = t => t.kobj('lumen', 'Namespace', null, 'shop')?.metadata.labels || {};

// ------------------------------------------------------------ security gates

const CART = ["const express = require('express');", "const db = require('./db');", 'const router = express.Router();', '', "router.get('/cart/:id', async (req, res) => {", '  const rows = await db.query("SELECT * FROM carts WHERE id = " + req.params.id);', '  res.json(rows[0] || {});', '});', '', 'module.exports = router;', ''].join('\n');
const CART_FIXED = CART.replace('db.query("SELECT * FROM carts WHERE id = " + req.params.id)', "db.query('SELECT * FROM carts WHERE id = $1', [req.params.id])");
const CHECKOUT_PKG = v => JSON.stringify({ name: 'checkout', version: '2.1.0', dependencies: { express: '4.21.1', lodash: v } }, null, 2) + '\n';
const SECURITY_YML = ['name: security', 'on:', '  push:', '    branches: [main]', '  pull_request:', '', 'permissions:', '  contents: read', '', 'jobs:', '  scan:', '    runs-on: ubuntu-latest', '    steps:', `      - uses: ${PINS.checkout}`, `      - uses: ${PINS.gitleaks}`, '      - name: semgrep', '        run: pip install semgrep && semgrep scan --config auto --error', `      - uses: ${PINS.trivy}`, '        with:', '          scan-type: fs', '          scan-ref: .', '          scanners: vuln', '          severity: HIGH,CRITICAL', '          exit-code: "1"', ''].join('\n');

// ------------------------------------------------------------ boss

const SYNC_SH = (key, secret) => ['#!/usr/bin/env bash', '# nightly export of the analytics tables to S3', 'set -euo pipefail', ...(key ? [`export AWS_ACCESS_KEY_ID=${key}`, `export AWS_SECRET_ACCESS_KEY=${secret}`] : ['# credentials come from the instance (root\'s ~/.aws/credentials on sync1), never from the repo']), 'pg_dump analytics -f /tmp/analytics.sql', 'aws s3 cp /tmp/analytics.sql s3://lumen-data/exports/', ''].join('\n');
const GATE_YML = ['name: secrets', 'on: [push, pull_request]', 'permissions:', '  contents: read', 'jobs:', '  gitleaks:', '    runs-on: ubuntu-latest', '    steps:', `      - uses: ${PINS.checkout}`, `      - uses: ${PINS.gitleaks}`, ''].join('\n');
const BOSS_PM = ['# Postmortem: leaked data-sync access key', '', '## Summary', `On Saturday an access key for the data-sync service user (${SYNC_KEY}) was used from 203.0.113.66 to launch three m5.xlarge instances in us-east-1, a region Lumen does not use. The key had been committed to the lumen/data-sync repository in sync.sh. CloudTrail showed every call made with it.`, '', '## Impact', '- About 860 USD of unplanned EC2 spend over 11 hours.', '- No customer data access was found in CloudTrail (only EC2 and STS calls).', '', '## Timeline (UTC)', '- 19:12 first RunInstances call from 203.0.113.66 with the data-sync key', '- 06:40 billing alert; incident declared SEV1', '- 06:58 key found in lumen/data-sync history with gitleaks', '- 07:05 new key deployed to sync1, sync verified, leaked key deactivated', '- 07:09 three instances terminated in us-east-1', '- 07:30 secret removed from the repo, gitleaks gate added, leaked key deleted; resolved', '', '## Contributing factors', '- The key was hard-coded in sync.sh instead of coming from the instance.', '- The repository had no secret scanning in CI or pre-commit.', '- No billing or CloudTrail alert for activity in unused regions.', '', '## Action items', '- [ ] Replace long-lived keys on sync1 with an instance role (owner: @dev, due: 2026-03-20)', '- [ ] Add the gitleaks gate to every repository via an org-wide required workflow (owner: @priya, due: 2026-03-27)', '- [ ] Alert on any API call in regions we do not use, and a daily billing anomaly alert (owner: @kofi, due: 2026-03-20)', ''].join('\n');

export default {
  id: 'devsecops',
  n: 11,
  title: 'DevSecOps',
  tagline: 'Threat-model, scan, fix and gate: secrets, code, running sites, images, infrastructure and clusters, with security built into the pipeline',
  badge: 'Shift-Left Guardian',
  intro: 'Security is part of everyone\'s delivery work, not a phase at the end. Model **threats** before choosing tools, keep **secrets** out of code and rotate them when they leak, catch dangerous code with **SAST** and exposed sites with **DAST**, know and sign what you ship (**SBOMs**, **cosign**), scan **infrastructure as code**, enforce **pod security**, and turn all of it into fast **CI gates**. Every lab here is defensive: find the problem with a scanner, fix it, prove it with a clean re-scan, and add a guard rail.',
  lessons: [
    {
      id: 'threat-modeling',
      title: 'Threat modelling and hardening',
      summary: 'The four questions, STRIDE, attack surface, least privilege and defence in depth; auditing a server with lynis and hardening it without locking yourself out.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        setup(H) {
          H.server('web1', { packages: ['nginx', 'redis-server', 'lynis'] });
          H.authorize('laptop', 'dev', 'web1', 'ubuntu');
          H.authorize('laptop', 'dev', 'web1', 'root');
          H.write('web1', '/etc/ssh/sshd_config', SSHD_WEAK);
          H.write('web1', '/etc/redis/redis.conf', '# Redis configuration file\nbind 0.0.0.0\nport 6379\nprotected-mode no\n');
          H.run('sudo systemctl restart redis-server', { on: 'web1' });
          H.write('web1', '/etc/shop/shop.env', SHOP_ENV, { mode: 0o644 });
          H.uni.ai = { rules: [{ id: 'stride', when: /stride|threat|what can go wrong/i, reply: ['Possible threats for web1 (verify each one on the server):', '- Spoofing: sessions in Redis could be stolen if Redis is reachable.', '- Tampering: data in Redis could be changed by anyone who reaches port 6379.', '- Repudiation: a shared root login hides who did what.', '- Information disclosure: secrets in config files readable by other users.', '- Denial of service: password logins attract brute-force attempts.', '- Elevation of privilege: root login over SSH.', '(I cannot see your server: check what actually listens and who can read what.)'] }] };
        },
        suggestions: ['ssh ubuntu@web1', 'sudo lynis audit system', 'sudo ss -tlnp'],
        tasks: [
          { title: 'Measure the attack surface first: on `web1`, list what listens on which address (`ss -tlnp`) and run a lynis audit as root. Note the hardening index', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', 'sudo ss -tlnp', 'sudo lynis audit system', 'exit'], check: t => t.events('lynis').some(e => e.host === 'web1' && e.warnings.length >= 4) },
          { title: 'Redis listens on every interface. Bind it to 127.0.0.1 (the shop runs on the same server), turn protected mode on, and restart it. From your laptop, port 6379 must no longer answer', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', { cmd: 'sudo nano /etc/redis/redis.conf', edit: '# Redis configuration file\nbind 127.0.0.1 -::1\nport 6379\nprotected-mode yes\n' }, 'sudo systemctl restart redis-server', 'sudo ss -tlnp', 'exit', 'nc -zv web1 6379'], check: t => t.active('web1', 'redis-server') && t.listening('web1', 6379)?.addr === '127.0.0.1' && !!t.reach('laptop', 'web1', 6379).error },
          { title: 'Lock down SSH: `PermitRootLogin no` and `PasswordAuthentication no`. Check the file with `sudo sshd -t` before reloading. Your own key login as `ubuntu` must keep working; root must be refused', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', { cmd: 'sudo nano /etc/ssh/sshd_config', edit: SSHD_GOOD }, 'sudo sshd -t && sudo systemctl reload ssh', 'exit', 'ssh ubuntu@web1 whoami', 'ssh root@web1 whoami'], check: t => { const { cfg } = sshdConfig(t.host('web1')); return cfg.permitrootlogin === 'no' && cfg.passwordauthentication === 'no' && t.events('sshd-test').some(e => e.host === 'web1' && e.ok) && t.exec('laptop', 'ssh ubuntu@web1 true').code === 0 && t.exec('laptop', 'ssh root@web1 true').code !== 0; } },
          { title: 'Turn on the firewall with only SSH (22) and HTTP (80) allowed. Allow SSH *before* enabling it. The site must still load from your laptop', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', 'sudo ufw allow 22/tcp', 'sudo ufw allow 80/tcp', { cmd: 'sudo ufw enable', answers: ['y'] }, 'sudo ufw status verbose', 'exit', 'curl -sI http://web1/ | head -1'], check: t => t.fw('web1').enabled && !t.reach('laptop', 'web1', 22).error && t.http('laptop', 'http://web1/').status === 200 && t.exec('laptop', 'ssh ubuntu@web1 true').code === 0 },
          { title: 'Secrets in `/etc/shop/shop.env` are readable by every user on the server. Make the file readable only by root', solution: 'ssh ubuntu@web1 sudo chmod 600 /etc/shop/shop.env', check: t => (t.mode('web1', '/etc/shop/shop.env') & 0o077) === 0 },
          { title: 'Follow lynis\'s suggestions (automatic security updates, fail2ban), then audit again: no warnings and a hardening index of at least 90', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', 'sudo apt install -y unattended-upgrades fail2ban', 'sudo lynis audit system', 'exit'], check: t => { const e = last(t, 'lynis', x => x.host === 'web1'); return !!e && e.warnings.length === 0 && e.index >= 90; } },
          { title: 'Write `~/threats.md`: what web1 does, then at least four STRIDE categories with a concrete threat, its mitigation and an owner. You can ask `ai` to brainstorm, but verify each claim', solution: 'nano ~/threats.md', test: ['ai "brainstorm STRIDE threats for web1"', { cmd: 'nano ~/threats.md', edit: THREATS }], check: t => { const s = file(t, '~/threats.md'); const cats = ['spoofing', 'tampering', 'repudiation', 'information disclosure', 'denial of service', 'elevation of privilege'].filter(c => s.toLowerCase().includes(c)); return cats.length >= 4 && /redis/i.test(s) && /mitigat/i.test(s) && /owner|@\w+/i.test(s); } },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the four threat-modelling questions.', items: ['What are we building?', 'What can go wrong?', 'What are we going to do about it?', 'Did we do a good job?'], explain: 'Questions before tools.' },
        { type: 'mc', q: 'In STRIDE, a secrets file readable by every user is mainly…', choices: ['Spoofing', 'Information disclosure', 'Repudiation', 'Denial of service'], answer: 1, explain: 'Data reaching people who should not see it.' },
        { type: 'mc', q: 'Redis on a web server listens on 0.0.0.0:6379 with no password. Best first fix?', choices: ['Add a login rate limit to the shop', 'Bind Redis to 127.0.0.1 (and firewall the port)', 'Change the port to 16379', 'Turn on Redis persistence'], answer: 1, explain: 'Shrink the attack surface; obscurity is not a control.' },
        { type: 'multi', q: 'Before enabling a firewall or disabling root SSH on a remote server, you should…', choices: ['Allow port 22 first', 'Check that your own key-based login works', 'Run `sshd -t` before reloading sshd', 'Close your SSH session to save time'], answer: [0, 1, 2], explain: 'Keep a working way in until the new config is proven.' },
        { type: 'tf', q: 'Defence in depth means several independent layers, so one mistake does not become a breach.', answer: true, explain: 'Bind address and firewall and authentication.' },
        { type: 'mc', q: 'An AI lists threats for your architecture. Your job:', choices: ['Paste them into the document', 'Check each against the real system and assign owners', 'Ignore them', 'Ask for more'], answer: 1, explain: 'AI cannot see your server; verify.' },
      ],
    },
    {
      id: 'secrets',
      title: 'Secrets: detect, rotate, prevent',
      summary: 'Secrets in git history, scanning with gitleaks, rotating a leaked cloud key without an outage, .gitignore and .env.example, pre-commit hooks, fingerprinted exceptions.',
      minutes: 35,
      lab: {
        cwd: '~/payments',
        panels: ['github', 'system'],
        setup(H) {
          H.cloud({ tools: ['awscli'] });
          H.clickops(c => c.enableIam({ dev: [{ id: LEAK, secret: LEAK_SECRET }] }));
          H.write('laptop', '~/.aws/credentials', `[default]\naws_access_key_id = ${LEAK}\naws_secret_access_key = ${LEAK_SECRET}\n`, { owner: 'dev', mode: 0o600 });
          H.install('laptop', 'gitleaks');
          H.remote('lumen', 'payments', [
            { message: 'Initial payments service', files: { 'README.md': '# payments\n', 'server.js': PAY_SERVER, 'package.json': '{ "name": "payments", "version": "1.0.0" }\n' } },
            { message: 'Add webhook test fixture', files: { 'test/fixtures/stripe-event.json': JSON.stringify({ id: 'evt_test_1', api_key: FIXTURE_KEY, type: 'charge.succeeded' }, null, 2) + '\n' } },
            { message: 'Add local config', files: { '.env': `PORT=3000\nAWS_ACCESS_KEY_ID=${LEAK}\nAWS_SECRET_ACCESS_KEY=${LEAK_SECRET}\n` } },
            { message: 'Remove .env (oops)', remove: ['.env'] },
          ], { collaborators: ['you'] });
          H.run('git clone -q https://github.com/lumen/payments.git', { on: 'laptop' });
        },
        suggestions: ['gitleaks git -v', 'aws iam list-access-keys'],
        tasks: [
          { title: 'Scan the whole history of `~/payments` for secrets with gitleaks (verbose, so you see the commit of each finding)', solution: 'gitleaks git -v', check: t => t.events('gitleaks').some(e => e.mode === 'git' && e.findings.some(f => f.secret === LEAK)) },
          { title: 'The AWS key in history is yours. Is it still active, and has it been used? Check with IAM', solution: `aws iam list-access-keys && aws iam get-access-key-last-used --access-key-id ${LEAK}`, check: t => (t.cloud().trail || []).some(e => e.name === 'ListAccessKeys') && (t.cloud().trail || []).some(e => e.name === 'GetAccessKeyLastUsed') },
          { title: 'Rotate without locking yourself out: create a new access key, switch your CLI to it (`aws configure set`), and prove it works with `aws sts get-caller-identity`', solution: 'NEW=$(aws iam create-access-key --query "AccessKey.[AccessKeyId,SecretAccessKey]" --output text); aws configure set aws_access_key_id $(echo "$NEW" | cut -f1); aws configure set aws_secret_access_key $(echo "$NEW" | cut -f2); aws sts get-caller-identity', check: t => { const k = credKey(t, 'laptop', '/home/dev'); return !!k && k !== LEAK && iamKeys(t, 'dev').some(x => x.id === k && x.status === 'Active') && (t.cloud().trail || []).some(e => e.key === k && e.name === 'GetCallerIdentity'); } },
          { title: 'Now kill the leaked key: deactivate it first (so a mistake is reversible), then delete it', solution: `aws iam update-access-key --access-key-id ${LEAK} --status Inactive && aws iam delete-access-key --access-key-id ${LEAK} && aws iam list-access-keys`, check: t => t.after(e => e.type === 'iam' && e.op === 'update-key' && e.key === LEAK && e.status === 'Inactive', e => e.type === 'iam' && e.op === 'delete-key' && e.key === LEAK) && !iamKeys(t, 'dev').some(k => k.id === LEAK) },
          { title: 'Guard rail 1: ignore `.env` in `.gitignore`, add a `.env.example` with empty placeholders, and commit both', solution: 'printf ".env\\n" >> .gitignore && printf "PORT=3000\\nAWS_ACCESS_KEY_ID=\\nAWS_SECRET_ACCESS_KEY=\\n" > .env.example && git add .gitignore .env.example && git commit -m "Ignore .env, document required settings"', check: t => /^\.env$/m.test(gitShow(t, '~/payments', 'HEAD:.gitignore') || '') && /AWS_ACCESS_KEY_ID=\s*$/m.test(gitShow(t, '~/payments', 'HEAD:.env.example') || '') },
          { title: 'Guard rail 2: a pre-commit hook (`.git/hooks/pre-commit`, executable) that runs `gitleaks protect --staged`. Prove it: try to commit a file containing a live Stripe key. The commit must be blocked; then remove the file', solution: 'printf "#!/bin/sh\\ngitleaks protect --staged --redact -v\\n" > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit', test: ['printf "#!/bin/sh\\ngitleaks protect --staged --redact -v\\n" > .git/hooks/pre-commit', 'chmod +x .git/hooks/pre-commit', `echo "STRIPE_KEY=${LIVE_KEY}" > config.local.env`, 'git add config.local.env', 'git commit -m "Add local config"', 'git rm -q --cached config.local.env && rm config.local.env', 'git status --short'], check: t => t.events('gitleaks').some(e => e.mode === 'staged' && e.findings.length > 0) && !/config\.local\.env/.test(t.exec('laptop', 'cd ~/payments && git ls-files').out) && !t.exists('laptop', '/home/dev/payments/config.local.env') },
          { title: 'The rotated key in history is dead, and the Stripe key in the test fixture is a fake. Record both in `.gitleaksignore` by fingerprint, with a `#` comment saying why, until `gitleaks git` is clean. Commit and push', solution: 'gitleaks git -v', test: ['gitleaks git -v', t => { const ev = last(t, 'gitleaks', e => e.mode === 'git'); return `printf '%s\\n' '# ${LEAK.slice(0, 8)}… rotated and deleted in IAM; the fixture key is a fake test value' ${ev.findings.map(f => `'${f.commit}:${f.file}:${f.rule}:${f.line}'`).join(' ')} > .gitleaksignore`; }, 'gitleaks git', 'git add .gitleaksignore && git commit -m "Record reviewed gitleaks findings"', 'git push'], check: t => { const e = last(t, 'gitleaks', x => x.mode === 'git'); const ign = remoteFile(t, 'lumen/payments', '.gitleaksignore') || ''; return !!e && e.findings.length === 0 && /^#/m.test(ign) && !iamKeys(t, 'dev').some(k => k.id === LEAK); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'A key was committed and removed in the next commit. Is it leaked?', choices: ['No, it was deleted', 'Yes: it is in history, clones and forks; treat it as compromised', 'Only if the repo is public', 'Only if someone ran git log'], answer: 1, explain: 'Deleted is not gone.' },
        { type: 'order', q: 'Order a safe rotation of your own leaked key.', items: ['Create a new key', 'Switch your tools to it and test', 'Deactivate the old key', 'Delete the old key', 'Add guard rails (hook, CI scan)'], explain: 'Deactivate before delete, and never before the new key works.' },
        { type: 'tf', q: 'Rewriting git history with filter-repo makes rotation unnecessary.', answer: false, explain: 'The secret may already be copied. Rotate first.' },
        { type: 'mc', q: 'How should a known-fake test key be handled by the scanner?', choices: ['Disable the rule', 'Add its fingerprint to .gitleaksignore with a reason', 'Use --no-verify', 'Delete the test'], answer: 1, explain: 'Narrow, reviewed, documented exception.' },
        { type: 'multi', q: 'Which keep secrets out of repositories?', choices: ['.gitignore for .env', 'A pre-commit gitleaks hook', 'The same scan in CI', 'Base64-encoding the secret'], answer: [0, 1, 2], explain: 'Base64 is encoding, not protection.' },
        { type: 'mc', q: 'Where is the best place for the key a service uses in production?', choices: ['In the repo, encrypted', 'Injected at runtime from a secrets manager or an instance role', 'In the Dockerfile', 'In a comment'], answer: 1, explain: 'Short-lived or managed credentials, never in code.' },
      ],
    },
    {
      id: 'sast',
      title: 'SAST: dangerous code before it ships',
      summary: 'Static analysis with semgrep, parameterized queries, why escaping is not a fix, re-scanning AI changes, custom rules for team lessons.',
      minutes: 30,
      lab: {
        cwd: '~/orders-api',
        panels: ['files', 'github'],
        setup(H) {
          H.install('laptop', 'semgrep');
          H.remote('lumen', 'orders-api', [
            { message: 'Orders API', files: { 'server.js': "const express = require('express');\nconst app = express();\napp.use(express.json());\napp.use(require('./routes/orders'));\napp.use(require('./routes/payments'));\napp.listen(3000);\n", 'db.js': "const { Pool } = require('pg');\nmodule.exports = new Pool();\n", 'routes/orders.js': ORDERS_VULN, 'routes/payments.js': PAYMENTS, 'package.json': '{ "name": "orders-api", "version": "1.3.0" }\n' } },
          ], { collaborators: ['you'] });
          const b = H.bare('lumen/orders-api');
          b.refs['refs/heads/ai/fix-orders'] = b.refs['refs/heads/main'];
          H.teammate('lumen/orders-api', { branch: 'ai/fix-orders', files: { 'routes/orders.js': ORDERS_AI }, message: 'Fix SQL injection in /orders by escaping quotes', author: { name: 'lumen-ai-agent', email: 'ai-agent@lumen.dev' } });
          H.run('git clone -q https://github.com/lumen/orders-api.git', { on: 'laptop' });
          H.uni.ai = { rules: [{ id: 'sqlfix', when: /sql|inject|orders|fix/i, reply: ['I fixed the SQL injection in routes/orders.js: the id now has its single quotes escaped,', 'so it cannot break out of the string. Escaping is equivalent to a parameterized query.', 'The change is on branch ai/fix-orders.'] }] };
        },
        suggestions: ['semgrep scan --config auto', 'git switch ai/fix-orders'],
        tasks: [
          { title: 'Scan the API with semgrep\'s registry rules. Which file and line builds SQL from request input?', solution: 'semgrep scan --config auto', check: t => SQL_LINE(t, 7) },
          { title: 'Ask the AI assistant how it fixed the problem, then check its branch `ai/fix-orders` with the scanner before believing it', solution: 'ai "how did you fix the SQL injection in orders?"', test: ['ai "how did you fix the SQL injection in orders?"', 'git switch ai/fix-orders', 'git diff main -- routes/orders.js', 'semgrep scan --config auto', 'git switch main'], check: t => t.events('ai-ask').some(e => e.rule === 'sqlfix') && SQL_LINE(t, 8) },
          { title: 'Escaping is not a fix. On `main`, use a parameterized query (`db.query(\'… WHERE id = $1\', [id])`), make `semgrep scan --config auto --error` pass, and commit', solution: 'nano routes/orders.js', test: ['git switch main', { cmd: 'nano routes/orders.js', edit: ORDERS_FIXED }, 'semgrep scan --config auto --error', 'git commit -am "Use a parameterized query for /orders"'], check: t => { const s = gitShow(t, '~/orders-api', 'main:routes/orders.js') || ''; return /\$1/.test(s) && !/\+\s*id\b/.test(s) && t.events('semgrep').some(e => e.configs.includes('auto') && !e.findings.some(f => /tainted-sql/.test(f.rule)) && e.dir.endsWith('orders-api')); } },
          { title: 'The team keeps logging whole request bodies (card numbers end up in logs). Write a custom rule in `.semgrep/rules.yml` that flags `console.log(... req.body ...)` and run it', solution: 'mkdir -p .semgrep && nano .semgrep/rules.yml && semgrep scan --config .semgrep/rules.yml', test: ['mkdir -p .semgrep', { cmd: 'nano .semgrep/rules.yml', edit: RULE }, 'semgrep scan --config .semgrep/rules.yml'], check: t => t.events('semgrep').some(e => e.custom.length > 0 && e.findings.some(f => /routes\/payments\.js$/.test(f.file))) },
          { title: 'Fix the logging, then run both configs together with `--error` until it passes. Commit the rule and the fix, and push', solution: 'nano routes/payments.js', test: [{ cmd: 'nano routes/payments.js', edit: PAYMENTS_FIXED }, 'semgrep scan --config auto --config .semgrep/rules.yml --error', 'git add .semgrep routes/payments.js && git commit -m "Custom rule: never log request bodies"', 'git push'], check: t => { const e = last(t, 'semgrep', x => x.custom.length > 0); return !!e && e.configs.includes('auto') && e.findings.length === 0 && !!remoteFile(t, 'lumen/orders-api', '.semgrep/rules.yml') && /\$1/.test(remoteFile(t, 'lumen/orders-api', 'routes/orders.js') || ''); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'The right fix for SQL built from user input is…', choices: ['Escaping quotes', 'A parameterized query (placeholders plus a values array)', 'A regex that rejects quotes', 'Base64-encoding the input'], answer: 1, explain: 'Code and data travel separately, so data cannot become code.' },
        { type: 'mc', q: 'An AI says it fixed an injection. What next?', choices: ['Merge it', 'Re-run the scanner and read the diff', 'Ask it again', 'Add nosemgrep'], answer: 1, explain: 'Trust the evidence, not the claim.' },
        { type: 'tf', q: 'A clean SAST scan proves the code is secure.', answer: false, explain: 'It finds known patterns; logic bugs and access control need tests and review.' },
        { type: 'multi', q: 'Good uses of custom rules:', choices: ['Encode a lesson from an incident', 'Enforce a team convention (use our logger)', 'Silence a noisy registry rule globally', 'Catch a dangerous API option (rejectUnauthorized: false)'], answer: [0, 1, 3], explain: 'Silencing belongs in reviewed, narrow exceptions.' },
        { type: 'mc', q: 'For command injection the fix is…', choices: ['Quote the input', 'Call the program with an argument array, not a shell string, and validate input', 'Use sudo', 'Log the command'], answer: 1, explain: 'execFile with arguments, no shell.' },
      ],
    },
    {
      id: 'dast',
      title: 'DAST: testing the running site',
      summary: 'OWASP ZAP baseline and full scans of your own staging site, security headers, version banners, never serving dotfiles, clean re-scans.',
      minutes: 30,
      lab: {
        cwd: '~',
        panels: ['network', 'system'],
        setup(H) {
          H.server('web1', { packages: ['nginx'], fqdn: ['shop.lumen.dev'] });
          H.authorize('laptop', 'dev', 'web1', 'ubuntu');
          H.write('web1', '/var/www/shop/index.html', '<!doctype html>\n<title>Lumen shop</title>\n<h1>Lumen shop</h1>\n<a href="/about.html">About us</a>\n');
          H.write('web1', '/var/www/shop/about.html', '<!doctype html>\n<title>About</title>\n<p>Lumen makes lamps.</p>\n<a href="/">Home</a>\n');
          H.write('web1', '/var/www/shop/.env', 'DB_PASSWORD=Shop-db-2026!\nSESSION_SECRET=9f1c7e2a4b8d3f60\n');
          H.write('web1', '/var/www/shop/.git/config', '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/lumen/shop-site.git\n');
          H.write('web1', '/etc/nginx/sites-available/default', SHOP_SITE);
          H.write('web1', '/etc/nginx/sites-enabled/default', SHOP_SITE);
          H.run('sudo systemctl reload nginx', { on: 'web1' });
          H.install('laptop', 'zaproxy');
        },
        suggestions: ['curl -sI http://shop.lumen.dev/', 'zap-baseline.py -t http://shop.lumen.dev/'],
        tasks: [
          { title: 'Look at the site the way any visitor can: fetch only the response headers', solution: 'curl -sI http://shop.lumen.dev/', check: t => t.ran(/curl\b.*-\w*I\b.*shop\.lumen\.dev|curl\b.*--head\b/) },
          { title: 'Run a passive ZAP baseline scan against the site. Which headers are missing, and what does the Server header give away?', solution: 'zap-baseline.py -t http://shop.lumen.dev/', check: t => t.events('zap').some(e => !e.full && e.warn.includes(10036) && e.warn.includes(10021)) },
          { title: 'This staging site is yours, so run the full scan too. It finds files that should never be public', solution: 'zap-full-scan.py -t http://shop.lumen.dev/ -r report.html', check: t => t.events('zap').some(e => e.full && e.fail.includes(40035)) },
          { title: 'Fix nginx on `web1` (`/etc/nginx/sites-enabled/default`): deny every dotfile path, hide the version (`server_tokens off`), and add `X-Content-Type-Options`, `X-Frame-Options` and a `Content-Security-Policy`. Test and reload', solution: 'ssh ubuntu@web1', test: ['ssh ubuntu@web1', { cmd: 'sudo nano /etc/nginx/sites-enabled/default', edit: SHOP_SITE_FIXED }, 'sudo nginx -t && sudo systemctl reload nginx', 'exit', 'curl -s -o /dev/null -w "%{http_code}\\n" http://shop.lumen.dev/.env', 'curl -sI http://shop.lumen.dev/'], check: t => { const r = t.http('laptop', 'http://shop.lumen.dev/'); const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v])); return r.status === 200 && [403, 404].includes(t.http('laptop', 'http://shop.lumen.dev/.env').status) && [403, 404].includes(t.http('laptop', 'http://shop.lumen.dev/.git/config').status) && !/\d/.test(h.server || '') && !!h['x-content-type-options'] && !!h['x-frame-options'] && !!h['content-security-policy']; } },
          { title: 'Prove it: the full scan now reports no FAIL and no WARN (exit code 0)', solution: 'zap-full-scan.py -t http://shop.lumen.dev/; echo "exit $?"', check: t => { const e = last(t, 'zap', x => x.full); return !!e && e.fail.length === 0 && e.warn.length === 0 && t.http('laptop', 'http://shop.lumen.dev/about.html').status === 200; } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does a DAST tool look at?', choices: ['The source code', 'The running application from the outside', 'The git history', 'The Dockerfile'], answer: 1, explain: 'It sees what a visitor sees.' },
        { type: 'mc', q: 'Why is `Server: nginx/1.24.0 (Ubuntu)` a finding?', choices: ['It is slow', 'It tells anyone which exact version (and known CVEs) you run', 'It breaks caching', 'It is not valid HTTP'], answer: 1, explain: '`server_tokens off;`' },
        { type: 'multi', q: 'Before an active scan you should…', choices: ['Own the target or have written permission', 'Prefer a staging environment', 'Tell the team and the hosting provider', 'Run it against a competitor for comparison'], answer: [0, 1, 2], explain: 'Active scans look like attacks.' },
        { type: 'mc', q: 'The best defence against exposed `.env` and `.git` on a website:', choices: ['Rename them', 'Deploy built artifacts, not the project folder, and deny dotfiles in the web server', 'Use a robots.txt entry', 'Make them read-only'], answer: 1, explain: 'robots.txt advertises them.' },
        { type: 'tf', q: 'A passive baseline scan is generally safe to run against production.', answer: true, explain: 'It only reads responses; still tell the team.' },
      ],
    },
    {
      id: 'supply-chain',
      title: 'Supply chain: SBOMs and signed images',
      summary: 'SBOMs with syft, scanning them with trivy, fixing a vulnerable dependency, signing by digest with cosign, verifying before deploy, catching a moved tag.',
      minutes: 35,
      lab: {
        cwd: '~/shop',
        panels: ['docker', 'files'],
        setup(H) {
          H.install('laptop', 'trivy', 'syft', 'cosign');
          H.docker('laptop');
          H.registryCreds('registry.lumen.dev', 'dev', 'lumen-registry-pw');
          H.run('echo lumen-registry-pw | docker login registry.lumen.dev -u dev --password-stdin', { on: 'laptop' });
          const files = { 'package.json': SHOP_PKG('1.4.0'), 'server.js': SHOP_JS, 'Dockerfile': SHOP_DOCKERFILE };
          H.publishImage('registry.lumen.dev/shop:1.4', files, { private: true });
          for (const [p, txt] of Object.entries(files)) H.write('laptop', `~/shop/${p}`, txt, { owner: 'dev' });
          const U = H.uni;
          U.tickers.push(() => {
            if (U.labData.tampered || !U.events.some(e => e.type === 'cosign' && e.op === 'verify' && e.ok && e.ref === 'registry.lumen.dev/shop:1.5')) return;
            U.labData.tampered = true;
            H.publishImage('registry.lumen.dev/shop:1.5', { ...files, 'package.json': SHOP_PKG('1.5.0'), 'collect.js': "require('https').get('https://cdn-metrics.example.net/c?' + process.env.HOSTNAME);\n", 'Dockerfile': SHOP_DOCKERFILE.replace('COPY server.js .', 'COPY server.js collect.js .') }, { private: true });
            U.labData.say?.('⚠ Registry audit log: registry.lumen.dev/shop:1.5 was pushed again a minute ago by "ci-contractor".');
          });
        },
        events(ev, t) { t.uni.labData.say = t.say; },
        suggestions: ['syft registry.lumen.dev/shop:1.4 -o cyclonedx-json=sbom-1.4.json', 'trivy sbom sbom-1.4.json'],
        tasks: [
          { title: 'Generate a CycloneDX SBOM of the released image `registry.lumen.dev/shop:1.4` into `sbom-1.4.json`', solution: 'syft registry.lumen.dev/shop:1.4 -o cyclonedx-json=sbom-1.4.json', check: t => t.events('syft').some(e => e.format === 'cyclonedx-json' && /shop:1\.4/.test(e.target) && !!e.file) },
          { title: 'Scan the SBOM (not the image) for known vulnerabilities. Which dependency needs fixing?', solution: 'trivy sbom sbom-1.4.json', check: t => t.events('trivy').some(e => e.mode === 'sbom' && e.vulns > 0) },
          { title: 'Fix it: raise the vulnerable package to its fixed version in `package.json`, build `registry.lumen.dev/shop:1.5`, and scan the new image: no HIGH or CRITICAL findings', solution: 'nano package.json', test: [{ cmd: 'nano package.json', edit: SHOP_PKG('1.5.0') }, 'docker build -t registry.lumen.dev/shop:1.5 .', 'trivy image --severity HIGH,CRITICAL registry.lumen.dev/shop:1.5'], check: t => t.events('trivy').some(e => e.mode === 'image' && /shop:1\.5/.test(e.target) && (e.counts.HIGH || 0) + (e.counts.CRITICAL || 0) === 0) && /"lodash":\s*"4\.17\.2[1-9]/.test(file(t, '~/shop/package.json')) },
          { title: 'Push 1.5, create a cosign key pair, and sign the release **by digest** (the `sha256:…` that `docker push` prints), not by tag', solution: 'docker push registry.lumen.dev/shop:1.5 && cosign generate-key-pair && cosign sign --key cosign.key registry.lumen.dev/shop@sha256:…', test: ['docker push registry.lumen.dev/shop:1.5', { cmd: 'cosign generate-key-pair', answers: ['release-key-pw'] }, t => `COSIGN_PASSWORD=release-key-pw cosign sign --key cosign.key -y registry.lumen.dev/shop@${t.pushed('registry.lumen.dev/shop:1.5').digest}`], check: t => signedDigest(t, 'registry.lumen.dev/shop:1.5') },
          { title: 'Verify the release like production would, with the public key only', solution: 'cosign verify --key cosign.pub registry.lumen.dev/shop:1.5', check: t => t.events('cosign').some(e => e.op === 'verify' && e.ok && e.ref === 'registry.lumen.dev/shop:1.5') },
          { title: 'It is deploy day. Verify `shop:1.5` again before deploying. What happened, and why did the check matter?', solution: 'cosign verify --key cosign.pub registry.lumen.dev/shop:1.5', check: t => !!t.uni.labData.tampered && t.events('cosign').some(e => e.op === 'verify' && !e.ok && e.ref === 'registry.lumen.dev/shop:1.5' && e.digest === t.pushed('registry.lumen.dev/shop:1.5')?.digest) },
          { title: 'Restore the release: push your own verified build again, sign the new digest, and verify it. (In real life, also rotate the registry credential the contractor used.)', solution: 'docker push registry.lumen.dev/shop:1.5', test: ['docker push registry.lumen.dev/shop:1.5', t => `COSIGN_PASSWORD=release-key-pw cosign sign --key cosign.key -y registry.lumen.dev/shop@${t.pushed('registry.lumen.dev/shop:1.5').digest}`, 'cosign verify --key cosign.pub registry.lumen.dev/shop:1.5'], check: t => !!t.uni.labData.tampered && !tampered(t) && t.events('cosign').some(e => e.op === 'verify' && e.ok && e.digest === t.pushed('registry.lumen.dev/shop:1.5')?.digest) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why keep an SBOM for every release?', choices: ['It makes images smaller', 'When a new CVE appears, you can tell in seconds which releases contain the component', 'It signs the image', 'Docker requires it'], answer: 1, explain: 'Ingredients label for recalls.' },
        { type: 'mc', q: 'Why sign by digest instead of tag?', choices: ['Digests are shorter', 'A tag can be moved to another image; a digest always means the same bytes', 'Tags are not supported by cosign', 'It is faster'], answer: 1, explain: 'You might sign an image swapped a second earlier.' },
        { type: 'tf', q: 'If `cosign verify` fails for the tag you are about to deploy, you should stop the deployment.', answer: true, explain: 'An unsigned or re-pushed image is not the one you released.' },
        { type: 'multi', q: 'Good signing practice:', choices: ['Only CI holds the signing key (or uses keyless OIDC)', 'Verify at deploy time and with an admission policy', 'Commit cosign.key next to the code', 'Sign by digest'], answer: [0, 1, 3], explain: 'Never keep the private key in the repo.' },
        { type: 'order', q: 'Order a trustworthy release.', items: ['Build in CI', 'Generate and store the SBOM', 'Scan for vulnerabilities', 'Push and sign by digest', 'Verify before deploy'], explain: 'Know it, sign it, verify it.' },
      ],
    },
    {
      id: 'misconfig',
      title: 'Infrastructure misconfiguration scanning',
      summary: 'trivy config on Terraform, Kubernetes and Dockerfiles; fixing high-severity findings; accepting a risk inline with a reason; gating on HIGH and CRITICAL.',
      minutes: 30,
      lab: {
        cwd: '~/infra',
        panels: ['files', 'system'],
        setup(H) {
          H.install('laptop', 'trivy');
          H.write('laptop', '~/infra/main.tf', TF, { owner: 'dev' });
          H.write('laptop', '~/infra/api/Dockerfile', API_DOCKERFILE, { owner: 'dev' });
          H.write('laptop', '~/infra/k8s/api.yaml', API_YAML, { owner: 'dev' });
        },
        suggestions: ['trivy config .', 'trivy config --severity HIGH,CRITICAL .'],
        tasks: [
          { title: 'Scan the whole `infra/` folder for misconfigurations', solution: 'trivy config .', check: t => t.events('trivy').some(e => e.mode === 'config' && e.misconfigs.includes('AVD-AWS-0107') && e.misconfigs.includes('AVD-KSV-0017') && e.misconfigs.includes('AVD-DS-0031')) },
          { title: 'Fix `main.tf`: SSH only from the office range 203.0.113.0/24, IMDSv2 required, an encrypted root volume, and encryption, versioning and a public access block for the bucket. Leave public HTTPS for the next task', solution: 'nano main.tf', test: [{ cmd: 'nano main.tf', edit: TF_FIXED.replace(/^  #trivy:ignore.*\n/m, '') }, 'trivy config main.tf'], check: t => { const ids = misconfIds(trivyJson(t, 'cd ~/infra && trivy config --format json main.tf')); const tf = file(t, '~/infra/main.tf'); return !['AVD-AWS-0028', 'AVD-AWS-0131', 'AVD-AWS-0088', 'AVD-AWS-0090', 'AVD-AWS-0094'].some(id => ids.includes(id)) && !/from_port\s*=\s*22[\s\S]{0,120}0\.0\.0\.0\/0/.test(tf); } },
          { title: 'Fix the API\'s Dockerfile: a small pinned base, no secret in `ENV`, a non-root `USER`, and a `HEALTHCHECK`', solution: 'nano api/Dockerfile', test: [{ cmd: 'nano api/Dockerfile', edit: API_DOCKERFILE_FIXED }, 'trivy config api/Dockerfile'], check: t => misconfIds(trivyJson(t, 'cd ~/infra && trivy config --format json api/Dockerfile')).length === 0 },
          { title: 'Fix `k8s/api.yaml`: not privileged, non-root, no privilege escalation, drop ALL capabilities, read-only root filesystem, seccomp RuntimeDefault, CPU and memory limits, and a pinned image tag', solution: 'nano k8s/api.yaml', test: [{ cmd: 'nano k8s/api.yaml', edit: API_YAML_FIXED }, 'trivy config k8s/api.yaml'], check: t => misconfIds(trivyJson(t, 'cd ~/infra && trivy config --format json k8s/api.yaml')).length === 0 },
          { title: 'Public HTTPS on 443 is intended. Accept that one finding inline (`#trivy:ignore:AVD-AWS-0107` directly above that ingress block) with a reason, a reviewer and a date. Then the CI gate `trivy config --exit-code 1 --severity HIGH,CRITICAL .` must pass', solution: 'nano main.tf && trivy config --exit-code 1 --severity HIGH,CRITICAL .', test: [{ cmd: 'nano main.tf', edit: TF_FIXED }, 'trivy config --exit-code 1 --severity HIGH,CRITICAL .; echo "exit $?"'], check: t => { const tf = file(t, '~/infra/main.tf'); const m = tf.match(/#\s*trivy:ignore:AVD-AWS-0107\s+(.+)/); return !!m && m[1].trim().split(/\s+/).length >= 4 && t.events('trivy').some(e => e.mode === 'config' && e.exitCode === 1 && e.severity.length === 2 && e.severity.includes('CRITICAL') && e.misconfigs.length === 0 && e.dir.endsWith('/infra')); } },
        ],
      },
      quiz: [
        { type: 'mc', q: '`cidr_blocks = ["0.0.0.0/0"]` on port 22 means…', choices: ['SSH only from inside the VPC', 'SSH open to the whole internet', 'No SSH', 'SSH over IPv6 only'], answer: 1, explain: 'Restrict to a VPN or office range, or use SSM.' },
        { type: 'mc', q: 'How should an intended exception (public HTTPS) be recorded?', choices: ['Disable the rule globally', 'An inline ignore next to the resource, with reason, reviewer and date', 'A Slack message', 'Nothing; everyone knows'], answer: 1, explain: 'Visible in review, revisited later.' },
        { type: 'multi', q: 'Dockerfile findings worth fixing:', choices: ['Secrets in ENV', 'Running as root', 'An unpinned or :latest base', 'Using COPY instead of ADD'], answer: [0, 1, 2], explain: 'COPY is the recommendation.' },
        { type: 'tf', q: 'Fixing a misconfiguration in the cloud console is enough.', answer: false, explain: 'The next apply reverts it: fix the code.' },
        { type: 'mc', q: 'A good CI gate for IaC scanning:', choices: ['Fail on every LOW finding', 'Fail on HIGH and CRITICAL, report the rest, tighten over time', 'Never fail', 'Only scan on release'], answer: 1, explain: 'Gates people do not learn to ignore.' },
      ],
    },
    {
      id: 'k8s-hardening',
      title: 'Kubernetes pod security',
      summary: 'Pod Security Standards and admission (warn, then enforce), FailedCreate on ReplicaSets, a restricted securityContext, keeping privileged pods out.',
      minutes: 30,
      lab: {
        cwd: '~/k8s',
        panels: ['cluster', 'files'],
        setup(H) {
          H.cluster('lumen');
          H.k8s('lumen', 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n');
          H.k8s('lumen', K8S_API, { ns: 'shop' });
          H.write('laptop', '~/k8s/api.yaml', K8S_API, { owner: 'dev' });
          H.write('laptop', '~/k8s/debug-pod.yaml', K8S_DEBUG, { owner: 'dev' });
        },
        suggestions: ['kubectl -n shop get deploy,rs,pods', 'kubectl label ns shop pod-security.kubernetes.io/warn=restricted'],
        tasks: [
          { title: 'Start gently: label the `shop` namespace with `pod-security.kubernetes.io/warn=restricted`, re-apply `api.yaml`, and read the warnings', solution: 'kubectl label ns shop pod-security.kubernetes.io/warn=restricted && kubectl apply -f api.yaml', check: t => nsLabels(t)['pod-security.kubernetes.io/warn'] === 'restricted' && t.kran(/^apply/) },
          { title: 'Now enforce it (`…/enforce=restricted`) and restart the deployment. Are the running pods affected? What happens to the new ReplicaSet?', solution: 'kubectl label ns shop pod-security.kubernetes.io/enforce=restricted && kubectl -n shop rollout restart deploy/api && sleep 10 && kubectl -n shop get rs,pods', check: t => nsLabels(t)['pod-security.kubernetes.io/enforce'] === 'restricted' && t.events('k8s-event').some(e => e.reason === 'FailedCreate' && e.ns === 'shop') },
          { title: 'Find out exactly why with the namespace\'s events', solution: 'kubectl -n shop get events --field-selector reason=FailedCreate', check: t => t.ran(/kubectl\b.*(get\s+(ev|events)\b|describe\s+(rs|replicaset)\b)/) },
          { title: 'Fix `api.yaml` to meet the restricted level (non-root user, no privilege escalation, drop ALL, seccomp RuntimeDefault, plus a read-only root filesystem and limits), apply it, and wait for the rollout', solution: 'nano api.yaml && kubectl apply -f api.yaml && kubectl -n shop rollout status deploy/api', test: [{ cmd: 'nano api.yaml', edit: K8S_API_FIXED }, 'kubectl apply -f api.yaml', 'kubectl -n shop rollout status deploy/api', 'kubectl -n shop get pods'], check: t => { const pods = t.kready('lumen', 'shop', 'app=api'); const cl = t.cluster('lumen'); return pods.length >= 2 && pods.every(p => cl.podSecurity('shop', p.spec) === null && p.spec.securityContext?.runAsNonRoot === true); } },
          { title: 'Prove the namespace keeps privileged pods out: try to apply `debug-pod.yaml`', solution: 'kubectl apply -f debug-pod.yaml', check: t => t.kran(/^apply\b.*debug-pod/) && !t.kobj('lumen', 'Pod', 'shop', 'debug') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'With `enforce=restricted`, a Deployment that violates the policy is applied. What happens?', choices: ['kubectl apply fails', 'The Deployment is accepted, but its ReplicaSet cannot create pods (FailedCreate events)', 'Pods start and are killed', 'Nothing'], answer: 1, explain: 'Admission checks Pods, which the ReplicaSet creates.' },
        { type: 'multi', q: 'The restricted level requires:', choices: ['allowPrivilegeEscalation: false', 'capabilities drop ALL', 'runAsNonRoot: true', 'A service mesh'], answer: [0, 1, 2], explain: 'Plus a seccomp profile.' },
        { type: 'mc', q: 'Safest rollout of pod security to an existing namespace:', choices: ['enforce immediately', 'warn first, fix the warnings, then enforce', 'label it privileged', 'delete the namespace'], answer: 1, explain: 'warn and audit before enforce.' },
        { type: 'tf', q: 'Running pods are killed when you start enforcing a stricter level.', answer: false, explain: 'Enforcement happens at creation; restarts are where it bites.' },
        { type: 'mc', q: '`runAsNonRoot: true` on an image whose user is root, with no runAsUser:', choices: ['Runs as root anyway', 'CreateContainerConfigError until the image or runAsUser changes', 'Runs as nobody', 'Is ignored'], answer: 1, explain: 'Kubernetes refuses to start it.' },
      ],
    },
    {
      id: 'security-gates',
      title: 'Security gates in CI',
      summary: 'A security workflow with pinned actions and least privilege: gitleaks, semgrep and trivy on every push and pull request, fixing findings until green.',
      minutes: 35,
      lab: {
        cwd: '~/checkout',
        panels: ['github', 'files'],
        setup(H) {
          H.install('laptop', 'gitleaks', 'semgrep', 'trivy');
          H.remote('lumen', 'checkout', [
            { message: 'Checkout service', files: { 'server.js': "const express = require('express');\nconst app = express();\napp.use(require('./src/cart'));\napp.listen(3000);\n", 'src/db.js': "const { Pool } = require('pg');\nmodule.exports = new Pool();\n", 'src/cart.js': CART, 'package.json': CHECKOUT_PKG('4.17.15') } },
            { message: 'Add payment webhook fixture', files: { 'test/fixtures/webhook.json': JSON.stringify({ id: 'evt_test_9', api_key: FIXTURE_KEY }, null, 2) + '\n' } },
          ], { collaborators: ['you'] });
          H.run('git clone -q https://github.com/lumen/checkout.git', { on: 'laptop' });
        },
        suggestions: ['mkdir -p .github/workflows && nano .github/workflows/security.yml', 'gh run view --log-failed'],
        tasks: [
          { title: 'Write `.github/workflows/security.yml`: on push to main and on pull requests, `permissions: contents: read`, actions pinned to full commit SHAs, running gitleaks, semgrep (`pip install semgrep && semgrep scan --config auto --error`) and trivy fs for vulnerable dependencies (`scanners: vuln`, since gitleaks already covers secrets; HIGH,CRITICAL; exit-code 1). Push it and watch it fail', solution: 'mkdir -p .github/workflows && nano .github/workflows/security.yml', test: ['mkdir -p .github/workflows', { cmd: 'nano .github/workflows/security.yml', edit: SECURITY_YML }, 'git add .github && git commit -m "ci: security gates" && git push', 'gh run view'], check: t => { const wf = remoteFile(t, 'lumen/checkout', '.github/workflows/security.yml') || ''; return pinned(wf) && /contents:\s*read/.test(wf) && /gitleaks-action/.test(wf) && /semgrep/.test(wf) && /trivy-action/.test(wf) && lastRun(t, 'lumen/checkout', 'security.yml')?.conclusion === 'failure'; } },
          { title: 'Read the failed log. The first gate is gitleaks: the key in `test/fixtures/webhook.json` is a fake test value. Confirm locally, record its fingerprint in `.gitleaksignore` with a reason, push, and get past that step', solution: 'gh run view --log-failed && gitleaks git -v', test: ['gh run view --log-failed', 'gitleaks git -v', t => { const ev = last(t, 'gitleaks', e => e.mode === 'git'); return `printf '%s\\n' '# fake Stripe test key in a webhook fixture (reviewed by @priya)' ${ev.findings.map(f => `'${f.commit}:${f.file}:${f.rule}:${f.line}'`).join(' ')} > .gitleaksignore`; }, 'git add .gitleaksignore && git commit -m "Record reviewed fixture finding" && git push', 'gh run view --log-failed'], check: t => t.ran(/gh run view\b.*--log/) && /^#/m.test(remoteFile(t, 'lumen/checkout', '.gitleaksignore') || '') && /No leaks detected/.test(runLog(lastRun(t, 'lumen/checkout', 'security.yml'))) },
          { title: 'Next gate: semgrep. Fix `src/cart.js` with a parameterized query (check locally with semgrep first), push', solution: 'nano src/cart.js', test: [{ cmd: 'nano src/cart.js', edit: CART_FIXED }, 'semgrep scan --config auto --error', 'git commit -am "Parameterize the cart query" && git push', 'gh run view'], check: t => /\$1/.test(remoteFile(t, 'lumen/checkout', 'src/cart.js') || '') && /Ran \d+ rules on \d+ files?: 0 findings/.test(runLog(lastRun(t, 'lumen/checkout', 'security.yml'))) },
          { title: 'Last gate: trivy. Upgrade the vulnerable dependency (check with `trivy fs --scanners vuln` locally), push, and get a green run', solution: 'nano package.json', test: [{ cmd: 'nano package.json', edit: CHECKOUT_PKG('4.17.21') }, 'trivy fs --scanners vuln --severity HIGH,CRITICAL .', 'git commit -am "Upgrade lodash to 4.17.21" && git push', 'gh run view'], check: t => lastRun(t, 'lumen/checkout', 'security.yml')?.conclusion === 'success' },
          { title: 'Prove the gate protects pull requests: on branch `debug-tls`, add `rejectUnauthorized: false` to `src/db.js`, push and open a PR. The security check must fail (do not merge it)', solution: 'git switch -c debug-tls', test: ['git switch -c debug-tls', { cmd: 'nano src/db.js', edit: "const { Pool } = require('pg');\nmodule.exports = new Pool({ ssl: { rejectUnauthorized: false } });\n" }, 'git commit -am "Debug: skip TLS verification"', 'git push -u origin debug-tls', 'gh pr create --fill', 'gh pr checks'], check: t => { const b = t.remote('lumen/checkout'); const pr = b?.meta.prs.find(p => p.head === 'debug-tls'); return !!pr && pr.state !== 'merged' && b.meta.runs.some(r => r.pr === pr.number && r.file === 'security.yml' && r.conclusion === 'failure'); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why pin third-party actions to a full commit SHA?', choices: ['It is faster', 'A tag can be moved to malicious code; a SHA cannot', 'GitHub requires it', 'To save minutes'], answer: 1, explain: 'Supply chain of your pipeline.' },
        { type: 'mc', q: 'What makes a failing security job actually block a merge?', choices: ['A README note', 'A required status check in branch protection', 'continue-on-error: true', 'A Slack alert'], answer: 1, explain: 'No green check, no merge.' },
        { type: 'multi', q: 'Gates people do not bypass are…', choices: ['Fast (seconds, not 30 minutes)', 'Focused on HIGH/CRITICAL', 'Visible on the pull request', 'Configured with continue-on-error'], answer: [0, 1, 2], explain: 'continue-on-error makes it decoration.' },
        { type: 'tf', q: 'Exceptions such as .gitleaksignore should go through code review like any other change.', answer: true, explain: 'Exceptions are code.' },
        { type: 'mc', q: 'The CI workflow only needs to read the repository. Its token permissions should be…', choices: ['write-all', 'contents: read', 'admin', 'Whatever the default is'], answer: 1, explain: 'Least privilege for the pipeline.' },
      ],
    },
    {
      id: 'devsecops-boss',
      title: 'Boss: The leaked key',
      summary: 'Run a security incident end to end: find the abused credential in CloudTrail and the leak in git, contain it without breaking production, clean up the attacker\'s resources, fix the repo and gate it, and write the postmortem.',
      minutes: 50,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['cloud', 'github'],
        setup(H) {
          const cloud = H.cloud({ tools: ['awscli'] });
          H.install('laptop', 'gitleaks');
          H.clickops(c => {
            c.enableIam({ dev: [{ id: 'AKIAZ3EXAMPLEQX7A', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEh3Kd' }], 'data-sync': [{ id: SYNC_KEY, secret: SYNC_SECRET }] });
            c.buckets.set('lumen-data', { objects: new Map([['exports/analytics-2026-03-06.sql', { body: '-- analytics export\n', size: 20, time: H.uni.time - 86400 }]]) });
            c.put('aws_s3_bucket', { id: 'lumen-data', bucket: 'lumen-data', arn: 'arn:aws:s3:::lumen-data', created: H.uni.time - 86400 * 300, tags: {}, force_destroy: false });
          });
          // production in eu-west-1
          cloud.launch({ ami: UBUNTU_AMI, instance_type: 't3.small', tags: { Name: 'shop-web' } });
          // the server that runs the nightly sync with the data-sync key
          H.server('sync1', { packages: ['awscli', 'postgresql-client'] });
          H.authorize('laptop', 'dev', 'sync1', 'ubuntu');
          H.write('sync1', '/root/.aws/credentials', `[default]\naws_access_key_id = ${SYNC_KEY}\naws_secret_access_key = ${SYNC_SECRET}\n`, { mode: 0o600 });
          H.write('sync1', '/root/.aws/config', '[default]\nregion = eu-west-1\n');
          // the attacker's instances in a region Lumen does not use, and their CloudTrail trail
          const t0 = H.uni.time - 11 * 3600;
          const miners = [];
          for (let i = 0; i < 3; i++) { const m = cloud.launch({ ami: UBUNTU_AMI, instance_type: 'm5.xlarge', tags: { Name: `worker-${i + 1}` } }); m.region = 'us-east-1'; m.launched = t0 + 60 * i; miners.push(m.id); }
          const ev = (dt, name, extra = {}) => cloud.trail.push({ id: `trail-${dt}-${name}`, time: t0 + dt, region: 'us-east-1', name, source: 'ec2.amazonaws.com', user: 'data-sync', key: SYNC_KEY, ip: '203.0.113.66', readOnly: /^(Describe|List|Get)/.test(name), resources: [], ...extra });
          cloud.trail.length = 0;
          ev(0, 'GetCallerIdentity', { source: 'sts.amazonaws.com' });
          ev(30, 'DescribeRegions');
          ev(60, 'RunInstances', { resources: [miners[0]] });
          ev(120, 'RunInstances', { resources: [miners[1]] });
          ev(180, 'RunInstances', { resources: [miners[2]] });
          cloud.trail.push({ id: 'trail-sync', time: H.uni.time - 3 * 3600, region: 'eu-west-1', name: 'PutObject', source: 's3.amazonaws.com', user: 'data-sync', key: SYNC_KEY, ip: H.uni.host('sync1').ip, readOnly: false, resources: [] });
          H.remote('lumen', 'data-sync', [
            { message: 'Nightly analytics export', files: { 'README.md': '# data-sync\nNightly export of the analytics tables to S3 (runs on sync1).\n', 'sync.sh': SYNC_SH(SYNC_KEY, SYNC_SECRET) } },
            { message: 'Document the schedule', files: { 'README.md': '# data-sync\nNightly export of the analytics tables to S3 (runs on sync1 at 02:00).\n' } },
          ], { collaborators: ['you'] });
        },
        suggestions: ['incident declare --sev 1 --title "…"', 'aws cloudtrail lookup-events --max-results 20'],
        tasks: [
          { title: 'A billing alert: spend jumped overnight. Declare a SEV1 security incident and take command', solution: 'incident declare --sev 1 --title "Unexpected AWS spend: possible credential abuse" && incident role commander dev', check: t => { const i = inc(t); return !!i && i.sev <= 1 && !!i.roles.commander; } },
          { title: 'Find the abused credential: search CloudTrail for who launched instances, from where, with which access key. Record the key id in the incident timeline', solution: 'aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunInstances', test: ['aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunInstances --query "Events[].[EventName,Username,AccessKeyId]" --output text', `incident note "RunInstances x3 in us-east-1 from 203.0.113.66 by data-sync using ${SYNC_KEY}"`], check: t => t.events('cloudtrail').length > 0 && (inc(t)?.timeline || []).some(e => e.kind === 'note' && e.text.includes(SYNC_KEY)) },
          { title: 'Where did it leak? Clone `lumen/data-sync` and scan it with gitleaks', solution: 'git clone https://github.com/lumen/data-sync.git && cd data-sync && gitleaks git -v', check: t => t.events('gitleaks').some(e => e.findings.some(f => f.secret === SYNC_KEY)) },
          { title: 'Contain without breaking production: create a new key for `data-sync`, put it in root\'s AWS credentials on `sync1`, check the sync still reaches `s3://lumen-data`, then deactivate the leaked key', solution: 'aws iam create-access-key --user-name data-sync', test: ['NEW=$(aws iam create-access-key --user-name data-sync --query "AccessKey.[AccessKeyId,SecretAccessKey]" --output text)', 'ssh ubuntu@sync1 "sudo aws configure set aws_access_key_id $(echo "$NEW" | cut -f1) && sudo aws configure set aws_secret_access_key $(echo "$NEW" | cut -f2) && sudo aws s3 ls s3://lumen-data/exports/"', `aws iam update-access-key --user-name data-sync --access-key-id ${SYNC_KEY} --status Inactive`, `incident note "new data-sync key on sync1, sync verified; ${SYNC_KEY} deactivated"`], check: t => { const k = credKey(t, 'sync1', '/root'); return !!k && k !== SYNC_KEY && iamKeys(t, 'data-sync').some(x => x.id === k && x.status === 'Active') && !iamKeys(t, 'data-sync').some(x => x.id === SYNC_KEY && x.status === 'Active') && t.exec('sync1', 'aws s3 ls s3://lumen-data/exports/', { user: 'root' }).code === 0; } },
          { title: 'Remove the attacker\'s resources: terminate the instances they launched in us-east-1, and only those (production runs in eu-west-1)', solution: 'aws ec2 describe-instances --region us-east-1 --query "Reservations[].Instances[].InstanceId" --output text', test: [t => `aws ec2 terminate-instances --region us-east-1 --instance-ids ${t.cloud().all('aws_instance').filter(i => i.region === 'us-east-1').map(i => i.id).join(' ')}`, 'aws ec2 describe-instances --query "Reservations[].Instances[].[InstanceId,State.Name]" --output text'], check: t => { const all = t.cloud().all('aws_instance'); return all.filter(i => i.region === 'us-east-1').every(i => i.instance_state !== 'running') && all.some(i => !i.region && i.tags?.Name === 'shop-web' && i.instance_state === 'running'); } },
          { title: 'Fix the repo: `sync.sh` must not contain credentials. Add a pinned gitleaks workflow (`.github/workflows/secrets.yml`), record the now-deactivated key\'s history finding in `.gitleaksignore` with a reason, push, and get a green run', solution: 'cd ~/data-sync', test: ['cd ~/data-sync', { cmd: 'nano sync.sh', edit: SYNC_SH(null) }, 'mkdir -p .github/workflows', { cmd: 'nano .github/workflows/secrets.yml', edit: GATE_YML }, 'gitleaks git -v', t => { const ev = last(t, 'gitleaks', e => e.mode === 'git'); return `printf '%s\\n' '# data-sync key leaked 2026-03; deactivated and deleted in IAM' ${ev.findings.map(f => `'${f.commit}:${f.file}:${f.rule}:${f.line}'`).join(' ')} > .gitleaksignore`; }, 'git add -A && git commit -m "Remove hard-coded credentials; add gitleaks gate" && git push', 'gh run view', 'cd ~'], check: t => { const sh = remoteFile(t, 'lumen/data-sync', 'sync.sh') || ''; const wf = remoteFile(t, 'lumen/data-sync', '.github/workflows/secrets.yml') || ''; return !!sh && !sh.includes(SYNC_KEY) && !sh.includes(SYNC_SECRET) && pinned(wf) && /gitleaks-action/.test(wf) && /^#/m.test(remoteFile(t, 'lumen/data-sync', '.gitleaksignore') || '') && lastRun(t, 'lumen/data-sync', 'secrets.yml')?.conclusion === 'success'; } },
          { title: 'Delete the leaked key, resolve the incident, and write the blameless postmortem in `~/postmortem.md` (Summary, Impact, Timeline, Contributing factors, Action items with @owner and YYYY-MM-DD), mentioning CloudTrail and the key rotation', solution: `aws iam delete-access-key --user-name data-sync --access-key-id ${SYNC_KEY} && incident status resolved && nano ~/postmortem.md`, test: [`aws iam delete-access-key --user-name data-sync --access-key-id ${SYNC_KEY}`, 'incident status mitigated', 'incident status resolved', { cmd: 'nano ~/postmortem.md', edit: BOSS_PM }], check: t => !iamKeys(t, 'data-sync').some(k => k.id === SYNC_KEY) && inc(t)?.status === 'resolved' && pmOk(file(t, '~/postmortem.md'), { mustMention: [/cloudtrail/i, /key/i] }) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the response to a leaked cloud key.', items: ['Declare and take command', 'Identify the key and its activity (CloudTrail)', 'Deploy a replacement, then deactivate the leaked key', 'Remove the attacker\'s resources', 'Fix the source of the leak and add a gate', 'Delete the old key and write the postmortem'], explain: 'Contain without breaking production, then clean up and learn.' },
        { type: 'mc', q: 'Why deploy the new key to sync1 before deactivating the old one?', choices: ['It is faster', 'Deactivating first would break the nightly sync, adding an outage to the incident', 'IAM requires it', 'To keep both active forever'], answer: 1, explain: 'Rotate without self-inflicted outages.' },
        { type: 'mc', q: 'What does CloudTrail give you during this incident?', choices: ['The leaked key\'s secret', 'Every API call made with the key: action, region, source IP, time', 'The attacker\'s name', 'The billing total'], answer: 1, explain: 'It scopes the damage.' },
        { type: 'multi', q: 'Which prevent the next leak from becoming an incident?', choices: ['Instance roles instead of long-lived keys', 'A gitleaks gate in CI and pre-commit', 'Alerts on activity in unused regions', 'Keeping the key in a private repo'], answer: [0, 1, 2], explain: 'Private repos leak too (forks, laptops, tokens).' },
        { type: 'tf', q: 'After terminating the attacker\'s instances, the leaked key is safe to keep active.', answer: false, explain: 'It still works for anyone who has it.' },
      ],
    },
  ],
};
