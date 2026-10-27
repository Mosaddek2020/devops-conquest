// Realm 13 · Hero Trials: capstones that combine the earlier realms. Tasks state the outcome
// that must be true, not the commands; checks look only at the end state of the world.

import { kubeconfigText } from '../sim/kubectl.js';
import { UBUNTU_AMI } from '../sim/cloud.js';
import { makeCertPem } from '../sim/net.js';
import { pmOk, inc } from './r10-reliability.js';

const REG = 'registry.lumen.dev';
const TOKEN = ['lmn', 'ci', '7f3a9c2e5b81'].join('-');
const CHECKOUT = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683';
const TRIVY = 'aquasecurity/trivy-action@18f2510ee396bbf400402947b394f2dd8c87dbb0';

const file = (t, p) => t.file('laptop', p) || '';
const runsOf = (t, repo, wf) => (t.remote(repo)?.meta.runs || []).filter(r => !wf || r.file === wf);
const lastRun = (t, repo, wf) => runsOf(t, repo, wf)[0] || null;
const headOf = (t, repo, branch = 'main') => t.remote(repo)?.refs['refs/heads/' + branch] || null;
const remoteFile = (t, repo, path, branch = 'main') => {
  const h = headOf(t, repo, branch);
  if (!h) return null;
  const blob = t.uni.readTreeFlat(t.uni.commit(h).tree).get(path);
  return blob ? t.uni.objects.get(blob)?.content ?? null : null;
};
const ctr = (t, ns, name) => t.kobj('lumen', 'Deployment', ns, name)?.spec.template.spec.containers[0] || null;

// ------------------------------------------------------------ trial 1: commit to cluster

const NOTIFY = (v, broken = false) => ["const express = require('express');", 'const app = express();', `app.get('/', (req, res) => res.send('Lumen notify ${v}'));`, broken ? "app.get('/health', (req, res) => res.status(500).json({ status: 'error', reason: 'queue connection refused' }));" : "app.get('/health', (req, res) => res.json({ status: 'ok' }));", broken ? "app.get('/ready', (req, res) => res.status(503).json({ ready: false, reason: 'queue connection refused' }));" : "app.get('/ready', (req, res) => res.json({ ready: true }));", 'app.listen(3000);', ''].join('\n');
const NOTIFY_PKG = JSON.stringify({ name: 'notify', version: '1.0.0', dependencies: { express: '4.21.1' } }, null, 2) + '\n';
const DF_BAD = 'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD ["node", "server.js"]\n';
const DF_GOOD = 'FROM node:20-alpine\nWORKDIR /app\nCOPY package.json .\nRUN npm install --omit=dev\nCOPY server.js .\nUSER node\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
const NOTIFY_K8S = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: notify', '  namespace: notify', 'spec:', '  replicas: 2', '  progressDeadlineSeconds: 120', '  selector:', '    matchLabels:', '      app: notify', '  template:', '    metadata:', '      labels:', '        app: notify', '    spec:', '      imagePullSecrets:', '        - name: regcred', '      containers:', '        - name: notify', `          image: ${REG}/notify:dev`, '          ports:', '            - name: http', '              containerPort: 3000', '          resources:', '            requests:', '              cpu: 100m', '              memory: 64Mi', '            limits:', '              memory: 128Mi', '          readinessProbe:', '            httpGet:', '              path: /ready', '              port: http', '            periodSeconds: 5', '          livenessProbe:', '            httpGet:', '              path: /health', '              port: http', '            initialDelaySeconds: 5', '            periodSeconds: 10', '---', 'apiVersion: v1', 'kind: Service', 'metadata:', '  name: notify', '  namespace: notify', 'spec:', '  selector:', '    app: notify', '  ports:', '    - port: 80', '      targetPort: http', '---', 'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: notify', '  namespace: notify', 'spec:', '  ingressClassName: nginx', '  rules:', '    - host: notify.lumen.dev', '      http:', '        paths:', '          - path: /', '            pathType: Prefix', '            backend:', '              service:', '                name: notify', '                port:', '                  number: 80', ''].join('\n');
const DELIVER = ['name: deliver', 'on:', '  push:', '    branches: [main]', 'permissions:', '  contents: read', 'jobs:', '  deliver:', '    runs-on: ubuntu-latest', '    steps:', `      - uses: ${CHECKOUT}`, '      - name: build', `        run: docker build -t ${REG}/notify:\${{ github.sha }} .`, `      - uses: ${TRIVY}`, '        with:', `          image-ref: ${REG}/notify:\${{ github.sha }}`, '          severity: HIGH,CRITICAL', '          ignore-unfixed: true', '          exit-code: "1"', '      - name: push', '        run: |', `          echo "\${{ secrets.REGISTRY_TOKEN }}" | docker login ${REG} -u ci --password-stdin`, `          docker push ${REG}/notify:\${{ github.sha }}`, '      - name: deploy', '        run: |', '          mkdir -p ~/.kube && echo "${{ secrets.KUBECONFIG_DATA }}" > ~/.kube/config', `          kubectl -n notify set image deploy/notify notify=${REG}/notify:\${{ github.sha }}`, '          kubectl -n notify rollout status deploy/notify --timeout=120s', ''].join('\n');
const site = t => t.http('laptop', 'http://notify.lumen.dev/');
const fileAt = (t, hash, path) => { const blob = t.uni.readTreeFlat(t.uni.commit(hash).tree).get(path); return blob ? t.uni.objects.get(blob)?.content ?? '' : ''; };
// a green pipeline run of the v2 change whose image is what the ready pods serve
const v2Live = t => runsOf(t, 'lumen/notify', 'deliver.yml').some(r => r.conclusion === 'success' && /notify v2/.test(fileAt(t, r.hash, 'server.js')) && !/queue connection refused/.test(fileAt(t, r.hash, 'server.js')) && t.kready('lumen', 'notify', 'app=notify').some(p => p.spec.containers[0].image === `${REG}/notify:${r.hash}`));
const deployedHead = t => ctr(t, 'notify', 'notify')?.image === `${REG}/notify:${headOf(t, 'lumen/notify')}`;

// ------------------------------------------------------------ trial 2: trust but verify

const SBOM_ACTION = 'anchore/sbom-action@f325610c9f50a54015d37c8d16cb3b0e2c8f4de0';
const UPLOAD = 'actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882';
const COSIGN_INSTALL = 'sigstore/cosign-installer@dc72c7d5c4d10cd6bcb8cf6e3fd625a9e5e537da';
const KEY_PW = ['notify', 'signing', '2026'].join('-');
const PIPE = ({ sbom = false, sign = false } = {}) => ['name: deliver', 'on:', '  push:', '    branches: [main]', 'permissions:', '  contents: read', 'jobs:', '  deliver:', '    runs-on: ubuntu-latest', '    steps:', `      - uses: ${CHECKOUT}`, '      - name: build', `        run: docker build -t ${REG}/notify:\${{ github.sha }} .`, `      - uses: ${TRIVY}`, '        with:', `          image-ref: ${REG}/notify:\${{ github.sha }}`, '          severity: HIGH,CRITICAL', '          ignore-unfixed: true', '          exit-code: "1"',
  ...(sbom ? [`      - uses: ${SBOM_ACTION}`, '        with:', `          image: ${REG}/notify:\${{ github.sha }}`, '          format: cyclonedx-json', '          output-file: sbom.cdx.json', `      - uses: ${UPLOAD}`, '        with:', '          name: sbom', '          path: sbom.cdx.json'] : []),
  '      - name: push', '        run: |', `          echo "\${{ secrets.REGISTRY_TOKEN }}" | docker login ${REG} -u ci --password-stdin`,
  ...(sign ? [`          docker push ${REG}/notify:\${{ github.sha }} | tee push.log`, "          grep -oE 'sha256:[0-9a-f]{64}' push.log | tail -1 > digest.txt", `      - uses: ${COSIGN_INSTALL}`, '      - name: sign by digest', '        env:', '          COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}', '        run: |', '          echo "${{ secrets.COSIGN_PRIVATE_KEY }}" > cosign.key', `          cosign sign --key cosign.key -y ${REG}/notify@$(cat digest.txt)`, '          rm cosign.key', '      - name: verify, then deploy the digest', '        run: |', `          cosign verify --key cosign.pub ${REG}/notify@$(cat digest.txt)`, '          mkdir -p ~/.kube && echo "${{ secrets.KUBECONFIG_DATA }}" > ~/.kube/config', `          kubectl -n notify set image deploy/notify notify=${REG}/notify@$(cat digest.txt)`, '          kubectl -n notify rollout status deploy/notify --timeout=120s', '']
    : [`          docker push ${REG}/notify:\${{ github.sha }}`, '      - name: deploy', '        run: |', '          mkdir -p ~/.kube && echo "${{ secrets.KUBECONFIG_DATA }}" > ~/.kube/config', `          kubectl -n notify set image deploy/notify notify=${REG}/notify:\${{ github.sha }}`, '          kubectl -n notify rollout status deploy/notify --timeout=120s', '']),
].join('\n');
const pubKeyId = t => (remoteFile(t, 'lumen/notify', 'cosign.pub') || '').split('\n')[2]?.slice(0, 24) || null;
const signedByUs = (t, digest) => { const id = pubKeyId(t); return !!id && !!t.uni.cosign?.get(digest)?.has(id); };
const deployedDigest = t => (ctr(t, 'notify', 'notify')?.image || '').match(/@(sha256:[0-9a-f]{64})$/)?.[1] || null;
const trustWorld = H => {
  const c = H.cluster('lumen', { ingress: true });
  H.docker('laptop');
  H.install('laptop', 'trivy', 'cosign', 'syft');
  H.registryCreds(REG, 'ci', TOKEN);
  H.write('laptop', '~/registry-token.txt', TOKEN + '\n', { owner: 'dev', mode: 0o600 });
  H.run(`docker login ${REG} -u ci --password-stdin < ~/registry-token.txt > /dev/null`, { on: 'laptop' });
  const files = { 'server.js': NOTIFY('v3'), 'package.json': NOTIFY_PKG, 'Dockerfile': DF_GOOD };
  H.publishImage(`${REG}/notify:boot`, files, { private: true });
  H.k8s('lumen', 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: notify\n');
  H.run(`kubectl -n notify create secret docker-registry regcred --docker-server=${REG} --docker-username=ci --docker-password=${TOKEN} > /dev/null`, { on: 'laptop' });
  H.k8s('lumen', NOTIFY_K8S.replace(`${REG}/notify:dev`, `${REG}/notify:boot`), { settle: 60 });
  H.dns('notify.lumen.dev', c.ingressHost.ip);
  H.remote('lumen', 'notify', [{ message: 'notify service', files: { ...files, 'k8s/notify.yaml': NOTIFY_K8S, 'README.md': '# notify\n' } }], { collaborators: ['you'] });
  H.secret('lumen/notify', 'REGISTRY_TOKEN', TOKEN);
  H.secret('lumen/notify', 'KUBECONFIG_DATA', kubeconfigText(c));
  H.teammate('lumen/notify', { files: { '.github/workflows/deliver.yml': PIPE() }, message: 'Delivery pipeline', author: { name: 'Priya Sharma', email: 'priya@lumen.dev' } });
  H.run('git clone -q https://github.com/lumen/notify.git', { on: 'laptop' });
  return c;
};

// ------------------------------------------------------------ trial 3: platform from code

const MY_IP = '198.51.100.23';
const TF_PROVIDER = ['terraform {', '  required_providers {', '    aws = {', '      source  = "hashicorp/aws"', '      version = "~> 5.0"', '    }', '  }', '}', '', 'provider "aws" {', '  region = "eu-west-1"', '}', ''].join('\n');
const PLATFORM_TF = [TF_PROVIDER,
  'variable "web_count" {', '  type    = number', '  default = 2', '}', '',
  'resource "aws_key_pair" "dev" {', '  key_name   = "platform-dev"', '  public_key = file("~/.ssh/id_ed25519.pub")', '}', '',
  'resource "aws_security_group" "mon" {', '  name = "platform-mon"', '  ingress {', '    from_port   = 9090', '    to_port     = 9090', '    protocol    = "tcp"', `    cidr_blocks = ["${MY_IP}/32"]`, '  }', '  ingress {', '    from_port   = 22', '    to_port     = 22', '    protocol    = "tcp"', `    cidr_blocks = ["${MY_IP}/32"]`, '  }', '}', '',
  'resource "aws_security_group" "web" {', '  name = "platform-web"', '  ingress {', '    from_port   = 80', '    to_port     = 80', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '  ingress {', '    from_port   = 22', '    to_port     = 22', '    protocol    = "tcp"', `    cidr_blocks = ["${MY_IP}/32"]`, '  }', '  ingress {', '    description     = "node exporter, from the monitoring server only"', '    from_port       = 9100', '    to_port         = 9100', '    protocol        = "tcp"', '    security_groups = [aws_security_group.mon.id]', '  }', '}', '',
  'resource "aws_instance" "web" {', '  count                  = var.web_count', `  ami                    = "${UBUNTU_AMI}"`, '  instance_type          = "t3.micro"', '  vpc_security_group_ids = [aws_security_group.web.id]', '  key_name               = aws_key_pair.dev.key_name', '  tags = {', '    Name = "web-${count.index + 1}"', '  }', '}', '',
  'resource "aws_instance" "mon" {', `  ami                    = "${UBUNTU_AMI}"`, '  instance_type          = "t3.small"', '  vpc_security_group_ids = [aws_security_group.mon.id]', '  key_name               = aws_key_pair.dev.key_name', '  tags = {', '    Name = "mon"', '  }', '}', '',
  'resource "local_file" "inventory" {', '  filename = "${path.module}/../platform-config/inventory.ini"', '  content  = "[web]\\n${join("\\n", aws_instance.web[*].public_ip)}\\n\\n[mon]\\n${aws_instance.mon.public_ip}\\n\\n[all:vars]\\nansible_user=ubuntu\\n"', '}', '',
  'output "web_ips" {', '  value = aws_instance.web[*].public_ip', '}', '',
  'output "mon_ip" {', '  value = aws_instance.mon.public_ip', '}', ''].join('\n');
const SITE_TPL3 = '<h1>Lumen Events</h1>\n<p>Served by {{ inventory_hostname }}</p>\n';
const RULES3 = ['groups:', '  - name: fleet', '    rules:', '      - alert: InstanceDown', '        expr: up{job="node"} == 0', '        for: 1m', '        labels:', '          severity: page', '        annotations:', '          summary: "{{ $labels.instance }} is down"', ''].join('\n');
const PROM_TPL = ['global:', '  scrape_interval: 15s', '  evaluation_interval: 15s', '', 'rule_files:', '  - rules.yml', '', 'scrape_configs:', '  - job_name: node', '    static_configs:', '      - targets:', "{% for h in groups['web'] %}", '          - "{{ h }}:9100"', '{% endfor %}', ''].join('\n');
const SITE_YML3 = ['- name: Web servers', '  hosts: web', '  become: true', '  tasks:', '    - name: Install nginx and the node exporter', '      ansible.builtin.apt:', '        name:', '          - nginx', '          - prometheus-node-exporter', '        state: present', '        update_cache: true', '', '    - name: Home page', '      ansible.builtin.template:', '        src: templates/index.html.j2', '        dest: /var/www/html/index.html', '        mode: "0644"', '', '    - name: Services running', '      ansible.builtin.service:', '        name: "{{ item }}"', '        state: started', '        enabled: true', '      loop:', '        - nginx', '        - prometheus-node-exporter', '', '- name: Monitoring', '  hosts: mon', '  become: true', '  tasks:', '    - name: Install Prometheus', '      ansible.builtin.apt:', '        name: prometheus', '        state: present', '        update_cache: true', '', '    - name: Scrape every web server in the inventory', '      ansible.builtin.template:', '        src: templates/prometheus.yml.j2', '        dest: /etc/prometheus/prometheus.yml', '        mode: "0644"', '      notify: Restart prometheus', '', '    - name: Alert rules', '      ansible.builtin.copy:', '        src: files/rules.yml', '        dest: /etc/prometheus/rules.yml', '        mode: "0644"', '      notify: Restart prometheus', '', '    - name: Prometheus running', '      ansible.builtin.service:', '        name: prometheus', '        state: started', '        enabled: true', '', '  handlers:', '    - name: Restart prometheus', '      ansible.builtin.service:', '        name: prometheus', '        state: restarted', ''].join('\n');
const webs = t => t.cres('aws_instance', i => /^web-\d+$/.test(i.tags?.Name || '') && i.instance_state === 'running');
const monInst = t => t.cres('aws_instance', i => i.tags?.Name === 'mon' && i.instance_state === 'running')[0] || null;
const upTargets = t => (t.promq('up{job="node"}')?.samples || []);
const sgNamed = (t, n) => t.cres('aws_security_group', g => g.name === n)[0] || null;
const playRuns = t => t.events('ansible-playbook').filter(e => e.stats && !e.check);
const zeroChanged = e => !!e && Object.keys(e.stats).length > 0 && Object.values(e.stats).every(x => x.changed === 0 && x.failed === 0 && x.unreachable === 0);

// ------------------------------------------------------------ trial 4: the on-call week

const GB = 1073741824;
const SHOP_SRC = ["const express = require('express');", "const client = require('prom-client');", 'const app = express();', "if (!process.env.PAYMENTS_URL) throw new Error('PAYMENTS_URL is required');", "app.get('/', (req, res) => res.send('Lumen shop'));", "app.get('/health', (req, res) => res.json({ status: 'ok' }));", "app.post('/checkout', (req, res) => res.json({ ok: true }));", 'app.listen(3000);', ''].join('\n');
const SHOP_UNIT4 = '[Unit]\nDescription=Lumen shop\nAfter=network.target\n\n[Service]\nUser=ubuntu\nWorkingDirectory=/opt/shop\nEnvironmentFile=/etc/shop/shop.env\nExecStart=/usr/bin/node server.js\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n';
const SHOP_ENV4 = (level = 'info', payments = 'http://payments.lumen.dev') => `PORT=3000\nLOG_LEVEL=${level}\nPAYMENTS_URL=${payments}\n`;
const LB_CONF = ['upstream shop {', '    server web1:3000;', '    server web2:3000;', '}', '', 'server {', '    listen 80;', '    server_name shop.lumen.dev;', '    return 301 https://$host$request_uri;', '}', '', 'server {', '    listen 443 ssl;', '    server_name shop.lumen.dev;', '    ssl_certificate /etc/letsencrypt/live/shop.lumen.dev/fullchain.pem;', '    ssl_certificate_key /etc/letsencrypt/live/shop.lumen.dev/privkey.pem;', '', '    location / {', '        proxy_pass http://shop;', '    }', '}', ''].join('\n');
const PROM4 = ['global:', '  scrape_interval: 15s', '  evaluation_interval: 15s', '', 'rule_files:', '  - rules.yml', '', 'alerting:', '  alertmanagers:', '    - static_configs:', '        - targets: ["localhost:9093"]', '', 'scrape_configs:', '  - job_name: node', '    static_configs:', '      - targets: ["web1:9100", "web2:9100"]', '  - job_name: shop', '    static_configs:', '      - targets: ["web1:3000", "web2:3000"]', ''].join('\n');
const RULES4 = ['groups:', '  - name: shop', '    rules:', '      - alert: DiskFillingUp', '        expr: node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.15', '        for: 2m', '        labels:', '          severity: page', '        annotations:', '          summary: "{{ $labels.instance }}: only {{ $value | humanizePercentage }} disk left"', '      - alert: ShopHighErrorRate', '        expr: sum by (instance) (rate(http_requests_total{job="shop",status=~"5.."}[5m])) / sum by (instance) (rate(http_requests_total{job="shop"}[5m])) > 0.05', '        for: 2m', '        labels:', '          severity: page', '        annotations:', '          summary: "{{ $labels.instance }}: {{ $value | humanizePercentage }} of requests fail"', ''].join('\n');
const AM4 = ['route:', '  receiver: team-chat', '  group_by: [alertname]', '  group_wait: 30s', '  repeat_interval: 4h', '  routes:', '    - matchers: [ \'severity="page"\' ]', '      receiver: oncall', '', 'receivers:', '  - name: team-chat', '    webhook_configs:', '      - url: http://chat.lumen.dev/hooks/team', '  - name: oncall', '    webhook_configs:', '      - url: http://chat.lumen.dev/hooks/oncall', ''].join('\n');
const ROUTES4 = () => ({ '/': { rps: 8, p50: 0.03, p99: 0.15, err: 0.001 }, '/checkout': { rps: 2, p50: 0.2, p99: 0.9, err: 0.002, method: 'POST' } });
const LOGROTATE4 = ['/var/log/shop/*.log {', '    daily', '    rotate 7', '    maxsize 500M', '    compress', '    missingok', '    notifempty', '    copytruncate', '}', ''].join('\n');
const WEEK = ['# On-call report: week 11', '', '## Summary', 'Three pages and one email this week. All were fixed, and each now has a guard rail so it cannot recur the same way.', '', '## Impact', '- Monday: no customer impact; web1 reached 92% disk before the fix.', '- Tuesday: about 45% of checkouts on web2 failed for roughly 12 minutes (INC declared SEV2).', '- Wednesday: none; the certificate was renewed 3 days before expiry.', '', '## Timeline', '- Mon 09:00 DiskFillingUp on web1: debug logging left on; LOG_LEVEL set to info, debug.log truncated, log rotation added on web1 and web2.', '- Tue 14:10 ShopHighErrorRate on web2: PAYMENTS_URL pointed at a host that does not exist after a manual config change; restored from the backup, alert resolved.', '- Wed 10:30 certificate for shop.lumen.dev expiring in 3 days: certbot renew run, renewal scheduled in cron.', '', '## Contributing factors', '- Debug logging could be switched on in production with no size limit on the logs.', '- Config changes on single servers are made by hand, without review or a health check.', '- Certificate renewal depended on a person; nothing alerted on certificate expiry.', '', '## Action items', '- [ ] Manage /etc/shop/shop.env with Ansible from git, with a health check after changes (owner: @priya, due: 2026-03-27)', '- [ ] Add a certificate expiry alert (blackbox exporter, 14 days) (owner: @kofi, due: 2026-03-20)', '- [ ] Make LOG_LEVEL=debug expire automatically after one hour (owner: @dev, due: 2026-04-03)', ''].join('\n');
const diskFrac = (t, h) => { const x = t.host(h); return x.diskUsedGB / x.diskGB; };
const certDaysLeft = t => { const c = t.host('lb').certbotCerts?.['shop.lumen.dev']; return c ? (c.notAfter - t.uni.time) / 86400 : -1; };
const oncallWorld = H => {
  H.observe();
  for (const w of ['web1', 'web2']) {
    H.server(w, { packages: ['nodejs', 'prometheus-node-exporter'] });
    H.authorize('laptop', 'dev', w, 'ubuntu');
    for (const m of ['express', 'prom-client']) H.mkdir(w, `/opt/shop/node_modules/${m}`, { owner: 'ubuntu' });
    H.write(w, '/opt/shop/server.js', SHOP_SRC, { owner: 'ubuntu' });
    H.write(w, '/etc/shop/shop.env', SHOP_ENV4(w === 'web1' ? 'debug' : 'info'));
    H.write(w, '/etc/shop/shop.env.bak', SHOP_ENV4());
    H.mkdir(w, '/var/log/shop', { owner: 'ubuntu' });
    H.write(w, '/var/log/shop/shop.log', 'shop started\n', { owner: 'ubuntu' });
    H.service(w, 'shop', SHOP_UNIT4);
    H.traffic(w, 3000, 'shop', ROUTES4());
  }
  H.fakeSize('web1', '/var/log/shop/debug.log', 28 * GB);
  H.server('lb', { packages: ['nginx', 'certbot', 'python3-certbot-nginx'], fqdn: ['shop.lumen.dev'] });
  H.authorize('laptop', 'dev', 'lb', 'ubuntu');
  const lb = H.uni.host('lb');
  const cert = { cn: 'shop.lumen.dev', sans: ['shop.lumen.dev'], issuer: "Let's Encrypt R11", notBefore: H.uni.time - 87 * 86400, notAfter: H.uni.time + 3 * 86400 + 4000 };
  lb.certbotCerts = { 'shop.lumen.dev': cert };
  H.write('lb', '/etc/letsencrypt/live/shop.lumen.dev/fullchain.pem', makeCertPem(cert));
  H.write('lb', '/etc/letsencrypt/live/shop.lumen.dev/privkey.pem', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
  H.write('lb', '/etc/nginx/sites-available/default', LB_CONF);
  H.write('lb', '/etc/nginx/sites-enabled/default', LB_CONF);
  H.run('sudo systemctl reload nginx', { on: 'lb' });
  H.server('mon', { packages: ['prometheus', 'prometheus-alertmanager'] });
  H.authorize('laptop', 'dev', 'mon', 'ubuntu');
  H.write('mon', '/etc/prometheus/prometheus.yml', PROM4);
  H.write('mon', '/etc/prometheus/rules.yml', RULES4);
  H.write('mon', '/etc/alertmanager/alertmanager.yml', AM4);
  H.run('sudo systemctl restart prometheus prometheus-alertmanager', { on: 'mon' });
  H.install('laptop', 'prometheus', 'logcli');
  // debug logging on web1 grows its log while the shop runs with LOG_LEVEL=debug
  const U = H.uni;
  U.tickers.push(dt => {
    const w1 = U.host('web1');
    if (!/LOG_LEVEL=debug/.test(w1.files.get('/etc/shop/shop.env') || '') || !w1.procs.size) return;
    const cur = w1.fakeSizes?.get('/var/log/shop/debug.log');
    if (cur === undefined) return;
    const room = (w1.diskGB * 0.93 - w1.diskUsedGB) * GB;
    if (room > 0) w1.fakeSizes.set('/var/log/shop/debug.log', cur + Math.min(room, 0.3 * GB * dt / 60));
  });
  H.uni.advance(900);
};

export default {
  id: 'hero',
  n: 13,
  title: 'Hero Trials',
  tagline: 'Capstones that combine every realm: tasks say what must be true, you decide how',
  badge: 'DevOps Hero',
  intro: 'The trials put everything together. Each one is a realistic piece of work across several realms, with goals instead of step-by-step commands: the checks only look at the end state of the world. Use the Field Guide, `ai explain`, the reset button and your own notes, like you would at work.',
  lessons: [
    {
      id: 'hero-delivery',
      title: 'Trial: Commit to cluster',
      summary: 'From source to a hardened image, a production-shaped Kubernetes deployment, and a pipeline that builds, scans, pushes and rolls out every commit, including a bad one.',
      minutes: 60,
      boss: true,
      lab: {
        cwd: '~/notify',
        panels: ['cluster', 'github'],
        setup(H) {
          const c = H.cluster('lumen', { ingress: true });
          H.docker('laptop');
          H.install('laptop', 'trivy');
          H.registryCreds(REG, 'ci', TOKEN);
          H.write('laptop', '~/registry-token.txt', TOKEN + '\n', { owner: 'dev', mode: 0o600 });
          H.remote('lumen', 'notify', [{ message: 'notify service', files: { 'server.js': NOTIFY('v1'), 'package.json': NOTIFY_PKG, 'Dockerfile': DF_BAD, 'README.md': '# notify\nSends order notifications. Listens on 3000; /health and /ready.\n' } }], { collaborators: ['you'] });
          H.secret('lumen/notify', 'REGISTRY_TOKEN', TOKEN);
          H.secret('lumen/notify', 'KUBECONFIG_DATA', kubeconfigText(c));
          H.k8s('lumen', 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: notify\n');
          H.dns('notify.lumen.dev', c.ingressHost.ip);
          H.run('git clone -q https://github.com/lumen/notify.git', { on: 'laptop' });
          const U = H.uni;
          // once v2 is live through the pipeline, a teammate pushes a release that is not ready
          U.tickers.push(() => {
            if (U.labData.broke) return;
            const b = U.remotes.get('https://github.com/lumen/notify.git');
            const run = b?.meta.runs.find(r => r.file === 'deliver.yml');
            const h = b?.refs['refs/heads/main'];
            const blob = h && U.readTreeFlat(U.commit(h).tree).get('server.js');
            if (!run || run.conclusion !== 'success' || run.hash !== h || !blob || !/notify v2/.test(U.objects.get(blob).content)) return;
            U.labData.broke = true;
            H.teammate('lumen/notify', { files: { 'server.js': NOTIFY('v2', true) }, message: 'Connect to the new message queue', author: { name: 'Kofi Mensah', email: 'kofi@lumen.dev' } });
            U.labData.say?.('📣 Kofi pushed "Connect to the new message queue" to main. The pipeline is running…');
          });
        },
        events(ev, t) { t.uni.labData.say = t.say; },
        suggestions: ['cat Dockerfile', `docker build -t ${REG}/notify:dev .`, `trivy image --severity HIGH,CRITICAL ${REG}/notify:dev`],
        tasks: [
          { title: `Gate the image: build \`${REG}/notify:dev\` from \`~/notify\` and prove with trivy that it has no HIGH or CRITICAL vulnerabilities. It must not run as root`, solution: 'nano Dockerfile', test: [{ cmd: 'nano Dockerfile', edit: DF_GOOD }, `docker build -t ${REG}/notify:dev .`, `trivy image --severity HIGH,CRITICAL ${REG}/notify:dev`], check: t => t.events('trivy').some(e => e.mode === 'image' && e.target === `${REG}/notify:dev` && (e.counts.HIGH || 0) + (e.counts.CRITICAL || 0) === 0) && /^USER\s+(?!root\b|0\b)\S+/m.test(file(t, '~/notify/Dockerfile')) },
          { title: 'Deploy it by hand once: log in to the registry and push the image, then in namespace `notify` a pull secret, a Deployment (2 replicas, readiness and liveness probes, requests and a memory limit), a Service and an Ingress for `notify.lumen.dev`. Keep the manifests in `~/notify/k8s/`', solution: `docker push ${REG}/notify:dev && kubectl apply -f k8s/`, test: [`docker login ${REG} -u ci --password-stdin < ~/registry-token.txt`, `docker push ${REG}/notify:dev`, `kubectl -n notify create secret docker-registry regcred --docker-server=${REG} --docker-username=ci --docker-password=$(cat ~/registry-token.txt)`, 'mkdir -p k8s', { cmd: 'nano k8s/notify.yaml', edit: NOTIFY_K8S }, 'kubectl apply -f k8s/notify.yaml', 'kubectl -n notify rollout status deploy/notify', 'curl -s http://notify.lumen.dev/'], check: t => { const c = ctr(t, 'notify', 'notify'); const r = site(t); return !!c && !!c.readinessProbe && !!c.livenessProbe && !!c.resources?.limits?.memory && !!c.resources?.requests && t.kready('lumen', 'notify', 'app=notify').length >= 2 && r.status === 200 && /Lumen notify/.test(String(r.body)) && t.host('laptop').listDir('/home/dev/notify/k8s').length > 0; } },
          { title: 'Automate it: `.github/workflows/deliver.yml` builds `notify:<commit sha>`, fails on HIGH/CRITICAL findings (trivy), pushes, then deploys with `kubectl set image` and waits for `rollout status`. The repository secrets `REGISTRY_TOKEN` and `KUBECONFIG_DATA` exist. Push everything and get a green run', solution: 'mkdir -p .github/workflows && nano .github/workflows/deliver.yml', test: ['mkdir -p .github/workflows', { cmd: 'nano .github/workflows/deliver.yml', edit: DELIVER }, 'git add Dockerfile k8s .github && git commit -m "Hardened image, manifests and delivery pipeline" && git push', 'gh run view'], check: t => { const wf = remoteFile(t, 'lumen/notify', '.github/workflows/deliver.yml') || ''; return lastRun(t, 'lumen/notify', 'deliver.yml')?.conclusion === 'success' && /trivy-action/.test(wf) && /rollout status/.test(wf) && deployedHead(t); } },
          { title: 'Ship a change through the pipeline only: make `/` say `Lumen notify v2`, commit and push. The site must serve it without you running kubectl', solution: "sed -i 's/notify v1/notify v2/' server.js && git commit -am 'Say v2' && git push", test: ["sed -i 's/notify v1/notify v2/' server.js", 'git commit -am "notify: v2 greeting" && git push', 'gh run view', 'curl -s http://notify.lumen.dev/'], check: t => v2Live(t) && /notify v2/.test(String(site(t).body)) },
          { title: 'Kofi\'s release breaks readiness and the pipeline goes red. Confirm the site stayed up, find why, and fix `main` the clean way (revert in git) until the pipeline is green and the site serves v2 again', solution: 'gh run view --log-failed && git pull && git revert --no-edit HEAD && git push', test: ['gh run list', 'gh run view --log-failed', 'curl -s http://notify.lumen.dev/', 'git pull -q', 'git log --oneline -3', 'git revert --no-edit HEAD', 'git push', 'gh run view', 'curl -s http://notify.lumen.dev/health'], check: t => !!t.uni.labData.broke && runsOf(t, 'lumen/notify', 'deliver.yml').some(r => r.conclusion === 'failure') && lastRun(t, 'lumen/notify', 'deliver.yml')?.conclusion === 'success' && deployedHead(t) && !/queue connection refused/.test(remoteFile(t, 'lumen/notify', 'server.js') || '') && /notify v2/.test(String(site(t).body)) && t.http('laptop', 'http://notify.lumen.dev/health').status === 200 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why tag images with the commit SHA instead of `latest`?', choices: ['Shorter names', 'Every deployment points at exactly one build, so rollbacks and audits are unambiguous', 'Registries require it', 'It is faster to pull'], answer: 1, explain: 'latest moves; a SHA does not.' },
        { type: 'mc', q: 'Kofi\'s broken release reached the cluster, yet the site stayed up. Why?', choices: ['The pipeline rolled back', 'The new pods never became ready, so the rolling update kept the old pods serving', 'The Ingress cached it', 'Kubernetes skipped the update'], answer: 1, explain: 'Readiness probes gate traffic.' },
        { type: 'multi', q: 'What makes this pipeline safe to run on every commit?', choices: ['A vulnerability gate before push', 'Waiting for rollout status, so a bad rollout turns the run red', 'Least-privilege token permissions', 'Deploying with kubectl from a laptop afterwards'], answer: [0, 1, 2], explain: 'Manual deploys bypass every check.' },
        { type: 'tf', q: 'After the failed release, `kubectl rollout undo` alone is the complete fix.', answer: false, explain: 'Git still contains the broken commit; the next push would deploy it again. Revert in git.' },
        { type: 'order', q: 'Order the pipeline steps.', items: ['Check out the commit', 'Build the image tagged with the SHA', 'Scan it', 'Push it', 'Deploy and wait for rollout status'], explain: 'Never push or deploy an image that failed the gate.' },
      ],
    },
    {
      id: 'hero-trust',
      title: 'Trial: Trust but verify',
      summary: 'Extend a working pipeline with SBOMs, CI-held signing keys, signing and verifying by digest, and deploy-by-digest, then show a tampered tag cannot reach production.',
      minutes: 50,
      boss: true,
      lab: {
        cwd: '~/notify',
        panels: ['github', 'cluster'],
        setup(H) {
          trustWorld(H);
          const U = H.uni;
          U.tickers.push(() => {
            if (U.labData.tampered) return;
            const d = U.clusters.get('lumen')?.get('Deployment', 'notify', 'notify')?.spec.template.spec.containers[0].image || '';
            const m = d.match(/@(sha256:[0-9a-f]{64})$/);
            const b = U.remotes.get('https://github.com/lumen/notify.git');
            const h = b?.refs['refs/heads/main'];
            if (!m || !h || !U.cosign?.get(m[1])?.size || !U.registry.get(`${REG}/notify:${h}`)) return;
            U.labData.tampered = h;
            H.publishImage(`${REG}/notify:${h}`, { 'server.js': NOTIFY('v3').replace("Lumen notify v3'", "Lumen notify v3 (tampered)'"), 'package.json': NOTIFY_PKG, 'Dockerfile': DF_GOOD }, { private: true });
            U.labData.say?.(`⚠ Registry audit log: ${REG}/notify:${h.slice(0, 12)}… was pushed again a minute ago by "ci-legacy".`);
          });
        },
        events(ev, t) { t.uni.labData.say = t.say; },
        suggestions: ['cat .github/workflows/deliver.yml', 'gh run list'],
        tasks: [
          { title: 'Know what you ship: every run must produce a CycloneDX SBOM of the image it built (`anchore/sbom-action`) and keep it as the build artifact `sbom` (`actions/upload-artifact`). Push and get a green run', solution: 'nano .github/workflows/deliver.yml', test: [{ cmd: 'nano .github/workflows/deliver.yml', edit: PIPE({ sbom: true }) }, 'git commit -am "ci: SBOM for every image" && git push', 'gh run view'], check: t => { const r = lastRun(t, 'lumen/notify', 'deliver.yml'); return r?.conclusion === 'success' && Object.values(r.artifacts?.sbom || {}).some(c => /"bomFormat":\s*"CycloneDX"/.test(c)); } },
          { title: 'A signing key only CI can use: generate a cosign key pair, store the private key and its password as the repository secrets `COSIGN_PRIVATE_KEY` and `COSIGN_PASSWORD`, and commit only `cosign.pub` (make sure `cosign.key` can never be committed)', solution: 'cosign generate-key-pair && gh secret set COSIGN_PRIVATE_KEY < cosign.key && gh secret set COSIGN_PASSWORD --body "…"', test: [`COSIGN_PASSWORD=${KEY_PW} cosign generate-key-pair`, 'gh secret set COSIGN_PRIVATE_KEY < cosign.key', `gh secret set COSIGN_PASSWORD --body "${KEY_PW}"`, 'echo cosign.key >> .gitignore', 'git add .gitignore cosign.pub && git commit -m "Public key for image signatures" && git push'], check: t => { const sec = t.remote('lumen/notify')?.meta.secrets || {}; const tree = t.uni.readTreeFlat(t.uni.commit(headOf(t, 'lumen/notify')).tree); return /PRIVATE KEY/.test(sec.COSIGN_PRIVATE_KEY?.value || '') && !!sec.COSIGN_PASSWORD?.value && tree.has('cosign.pub') && !tree.has('cosign.key') && /cosign\.key/.test(remoteFile(t, 'lumen/notify', '.gitignore') || ''); } },
          { title: 'Sign and deploy what you signed: after pushing, the pipeline signs the image by digest (`sigstore/cosign-installer`, `cosign sign`), verifies it with `cosign.pub`, and deploys `notify@sha256:…` instead of a tag. Push and get a green run', solution: 'nano .github/workflows/deliver.yml', test: [{ cmd: 'nano .github/workflows/deliver.yml', edit: PIPE({ sbom: true, sign: true }) }, 'git commit -am "ci: sign by digest, verify, deploy the digest" && git push', 'gh run view', 'kubectl -n notify get deploy notify -o jsonpath="{.spec.template.spec.containers[0].image}"'], check: t => { const d = deployedDigest(t); return lastRun(t, 'lumen/notify', 'deliver.yml')?.conclusion === 'success' && !!d && signedByUs(t, d) && t.events('cosign').some(e => e.op === 'verify' && e.ok && e.digest === d && /^runner-/.test(e.host)) && t.kready('lumen', 'notify', 'app=notify').length >= 2; } },
          { title: 'Somebody re-pushed the tag your pipeline built with a different image. Show that `cosign verify` of that tag now fails, restart the deployment, and prove production still runs only the signed digest and serves the real v3', solution: 'cosign verify --key cosign.pub registry.lumen.dev/notify:<sha>; kubectl -n notify rollout restart deploy/notify', test: [t => `cosign verify --key cosign.pub ${REG}/notify:${t.uni.labData.tampered || headOf(t, 'lumen/notify')}`, 'kubectl -n notify rollout restart deploy/notify', 'kubectl -n notify rollout status deploy/notify', 'curl -s http://notify.lumen.dev/'], check: t => { const h = t.uni.labData.tampered; const d = deployedDigest(t); const pods = t.kready('lumen', 'notify', 'app=notify'); return !!h && t.events('cosign').some(e => e.op === 'verify' && !e.ok && e.ref === `${REG}/notify:${h}`) && t.events('kubectl').some(e => e.verb === 'rollout' && /restart/.test(e.args || '')) && pods.length >= 2 && pods.every(p => p.spec.containers[0].image.endsWith('@' + d)) && signedByUs(t, d) && /notify v3'?$|notify v3$/.test(String(site(t).body).trim()) && !/tampered/.test(String(site(t).body)); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why deploy `image@sha256:…` instead of `image:tag` after signing?', choices: ['It is shorter', 'The digest is exactly what was scanned and signed; a tag can be moved to other bytes', 'Kubernetes requires digests', 'It pulls faster'], answer: 1, explain: 'Close the gap between verified and running.' },
        { type: 'mc', q: 'Where should the cosign private key live?', choices: ['Committed next to cosign.pub', 'In CI secrets (or use keyless signing); only the public key is committed', 'On every developer laptop', 'In the Docker image'], answer: 1, explain: 'Whoever holds it can sign as your pipeline.' },
        { type: 'multi', q: 'What did the tampered tag push NOT affect?', choices: ['Pods already running', 'New pods after a restart (they pull the pinned digest)', 'The signature check of the tag', 'The SBOM of the original build'], answer: [0, 1, 3], explain: 'Verification of the tag fails, which is how you detect it.' },
        { type: 'tf', q: 'An SBOM is only useful at build time.', answer: false, explain: 'Its value is later: when a new CVE appears, you check which shipped images contain the component.' },
        { type: 'order', q: 'Order the trusted release.', items: ['Build', 'Scan', 'SBOM', 'Push and record the digest', 'Sign the digest', 'Verify, then deploy the digest'], explain: 'Never deploy what was not verified.' },
      ],
    },
    {
      id: 'hero-platform',
      title: 'Trial: Platform from code',
      summary: 'Terraform web and monitoring servers with tight security groups and a generated inventory, configure them and Prometheus with Ansible, see an alert fire, scale with one number, and prove convergence.',
      minutes: 60,
      boss: true,
      lab: {
        cwd: '~/platform',
        panels: ['cloud', 'files'],
        laptopPackages: ['ansible'],
        setup(H) {
          H.observe();
          H.cloud();
          H.install('laptop', 'prometheus');
          H.run('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q', { on: 'laptop' });
          H.mkdir('laptop', '/home/dev/platform', { owner: 'dev' });
          H.write('laptop', '~/platform-config/templates/index.html.j2', SITE_TPL3, { owner: 'dev' });
          H.write('laptop', '~/platform-config/files/rules.yml', RULES3, { owner: 'dev' });
        },
        suggestions: ['nano main.tf', 'terraform init'],
        tasks: [
          { title: 'Terraform in `~/platform`: a `web_count` variable (default 2) of Ubuntu web servers named `web-1`, `web-2`…, a monitoring server `mon`, a key pair from your SSH key, security groups (HTTP from anywhere; SSH and Prometheus 9090 only from your IP; node exporter 9100 on the web servers only from the monitoring server\'s security group), and a `local_file` that writes `../platform-config/inventory.ini` with groups `web` and `mon`. Apply it', solution: 'nano main.tf && terraform init && terraform apply', test: [{ cmd: 'nano main.tf', edit: PLATFORM_TF }, 'terraform init', { cmd: 'terraform apply', answers: ['yes'] }], check: t => { const w = webs(t), m = monInst(t), sg = sgNamed(t, 'platform-web'), msg = sgNamed(t, 'platform-mon'); const inv = file(t, '~/platform-config/inventory.ini'); const r9100 = (sg?.ingress || []).filter(r => Number(r.from_port) <= 9100 && Number(r.to_port) >= 9100); return w.length === 2 && !!m && !!sg && !!msg && r9100.length > 0 && r9100.every(r => !(r.cidr_blocks || []).length && (r.security_groups || []).includes(msg.id)) && !(sg.ingress || []).some(r => Number(r.from_port) === 22 && (r.cidr_blocks || []).includes('0.0.0.0/0')) && w.every(i => inv.includes(i.public_ip)) && inv.includes(m.public_ip) && /\[web\]/.test(inv) && /\[mon\]/.test(inv); } },
          { title: 'Ansible in `~/platform-config`: nginx serving the home page and the node exporter on every web server; Prometheus on `mon` with a templated `prometheus.yml` that scrapes port 9100 on every host in the `web` group, plus `files/rules.yml`. Every web server must serve the page and every node target must be up', solution: 'cd ~/platform-config && nano templates/prometheus.yml.j2 site.yml && ansible-playbook -i inventory.ini site.yml', test: ['cd ~/platform-config', { cmd: 'nano templates/prometheus.yml.j2', edit: PROM_TPL }, { cmd: 'nano site.yml', edit: SITE_YML3 }, 'ansible-playbook -i inventory.ini site.yml', 'sleep 60', t => `promtool query instant http://${monInst(t).public_ip}:9090 'up{job="node"}'`], check: t => { const w = webs(t); const up = upTargets(t); return w.length >= 2 && w.every(i => /Lumen Events/.test(String(t.http('laptop', `http://${i.public_ip}/`).body))) && up.length === w.length && up.every(x => x.v === 1); } },
          { title: 'See the alert work: stop the node exporter on `web-2` and wait until `InstanceDown` is firing in Prometheus', solution: 'ssh ubuntu@<web-2 ip> sudo systemctl stop prometheus-node-exporter; sleep 120', test: [t => `ssh -o StrictHostKeyChecking=no ubuntu@${webs(t).find(i => i.tags.Name === 'web-2').public_ip} sudo systemctl stop prometheus-node-exporter`, 'sleep 150', t => `curl -s http://${monInst(t).public_ip}:9090/api/v1/alerts`], check: t => t.firing('InstanceDown').length > 0 },
          { title: 'Scale to three web servers by changing one number, then run the same playbook. web-3 must serve the page, Prometheus must scrape all three, and web-2 must be healthy again', solution: 'cd ~/platform && terraform apply -var web_count=3 && cd ~/platform-config && ansible-playbook -i inventory.ini site.yml', test: ['cd ~/platform', 'echo "web_count = 3" > terraform.tfvars', { cmd: 'terraform apply', answers: ['yes'] }, 'cd ~/platform-config', 'ansible-playbook -i inventory.ini site.yml', 'sleep 60'], check: t => { const w = webs(t); const up = upTargets(t); return w.length === 3 && w.every(i => /Lumen Events/.test(String(t.http('laptop', `http://${i.public_ip}/`).body))) && up.length === 3 && up.every(x => x.v === 1) && t.firing('InstanceDown').length === 0; } },
          { title: 'Prove it has converged: `terraform plan` shows no changes (with the 3 kept in code, e.g. `terraform.tfvars`), and a second playbook run reports `changed=0` everywhere', solution: 'ansible-playbook -i inventory.ini site.yml && cd ~/platform && terraform plan', test: ['ansible-playbook -i inventory.ini site.yml', 'cd ~/platform', 'terraform plan'], check: t => t.events('terraform').some(e => e.sub === 'plan' && e.ok && e.counts && e.counts.add + e.counts.change + e.counts.destroy === 0) && zeroChanged(playRuns(t).pop()) && webs(t).length === 3 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why let Terraform write the Ansible inventory?', choices: ['Ansible cannot read files', 'So configuration always targets exactly the servers that exist, with no hand-copied IPs', 'It is faster', 'Terraform requires it'], answer: 1, explain: 'Provisioning feeds configuration.' },
        { type: 'mc', q: 'Port 9100 on the web servers allows only the monitoring server\'s security group. What does that buy you?', choices: ['Nothing', 'Metrics are reachable by Prometheus but not by the internet, even if IPs change', 'Faster scrapes', 'Encryption'], answer: 1, explain: 'Rules by role, not by address.' },
        { type: 'multi', q: 'After `web_count = 3`, what followed automatically?', choices: ['A third server', 'Its line in the inventory', 'Its scrape target (the template loops over the web group)', 'A new alert rule'], answer: [0, 1, 2], explain: 'The rule already covered every node target.' },
        { type: 'tf', q: '`terraform apply -var web_count=3` is enough to keep three servers forever.', answer: false, explain: 'The next plain apply would go back to 2. Put the value in code (tfvars or the default).' },
        { type: 'order', q: 'Order adding a server to a code-built platform.', items: ['Change the count in code', 'terraform plan and apply', 'Run the playbook against the new inventory', 'Check the new target is up', 'Re-run both: no changes'], explain: 'Provision, configure, observe, converge.' },
      ],
    },
    {
      id: 'hero-oncall',
      title: 'Trial: The on-call week',
      summary: 'Carry the pager for a week: a disk filling up, a broken config on one server, an expiring certificate. Fix each, stop it recurring, and write the report.',
      minutes: 75,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['observe', 'system'],
        setup(H) {
          oncallWorld(H);
          const U = H.uni;
          U.labData.tuesday = () => {
            if (U.labData.tue || !['web1', 'web2'].every(w => /maxsize|size\s/.test(U.host(w).files.get('/etc/logrotate.d/shop') || ''))) return;
            U.labData.tue = true;
            H.write('web2', '/etc/shop/shop.env', SHOP_ENV4('info', 'http://payments-v2.lumen.dev'));
            H.run('sudo systemctl restart shop', { on: 'web2' });
            const p = U.obs.profiles.find(x => x.host === 'web2');
            Object.assign(p.routes['/checkout'], { err: 0.45, errStatus: 502, errMsg: 'payment request failed: getaddrinfo ENOTFOUND payments-v2.lumen.dev' });
            Object.assign(p.routes['/'], { err: 0.2, errStatus: 502, errMsg: 'payment health check failed: getaddrinfo ENOTFOUND payments-v2.lumen.dev' });
            U.labData.say?.('🗓 Tuesday 14:00. Someone changed the payments setting on web2 "for the new payments API". Keep an eye on your pager.');
          };
          U.tickers.push(() => U.labData.tuesday());
        },
        events(ev, t) {
          const U = t.uni;
          U.labData.say = t.say;
          if (ev.type === 'chat-message' && ev.status === 'firing' && ev.channel === 'oncall') t.say(`📟 PAGE: ${(ev.alerts || []).join(', ')} is firing`);
          if (ev.type === 'proc-start' && ev.unit === 'shop.service' && ev.host === 'web2' && U.labData.tue && /PAYMENTS_URL=http:\/\/payments\.lumen\.dev\b/.test(t.file('web2', '/etc/shop/shop.env') || '')) {
            const p = t.obs().profiles.find(x => x.host === 'web2');
            Object.assign(p.routes['/checkout'], { err: 0.002, errStatus: 500, errMsg: 'payment declined' });
            Object.assign(p.routes['/'], { err: 0.001, errStatus: 500, errMsg: 'request failed' });
            if (!U.labData.wed) { U.labData.wed = true; t.say('📧 Wednesday 10:30, from Let\'s Encrypt: "Your certificate for shop.lumen.dev expires in 3 days."'); }
          }
        },
        suggestions: ['curl -s mon:9090/api/v1/alerts | jq ".data.alerts[] | {alert: .labels.alertname, instance: .labels.instance, state}"', 'ssh ubuntu@web1 df -h /'],
        tasks: [
          { title: 'Monday 09:00, you are paged: `DiskFillingUp`. Find what is filling the disk and why, stop it growing without breaking the shop, free the space, and wait until the alert resolves', solution: 'ssh ubuntu@web1', test: ['curl -s mon:9090/api/v1/alerts', 'ssh ubuntu@web1', 'df -h /', 'sudo du -sh /var/log/shop/*', 'cat /etc/shop/shop.env', "sudo sed -i 's/LOG_LEVEL=debug/LOG_LEVEL=info/' /etc/shop/shop.env", 'sudo systemctl restart shop', 'sudo truncate -s 0 /var/log/shop/debug.log', 'df -h /', 'exit', 'sleep 240'], check: t => diskFrac(t, 'web1') < 0.7 && !/LOG_LEVEL=debug/.test(t.file('web1', '/etc/shop/shop.env') || '') && t.active('web1', 'shop') && t.firing('DiskFillingUp').length === 0 && t.events('promql').length + t.events('http').filter(e => /mon:9090|:9090\/api/.test(e.url || '')).length > 0 },
          { title: 'Make sure it cannot happen again, on both web servers: `/etc/logrotate.d/shop` for `/var/log/shop/*.log` with a size limit, checked with `logrotate -d`', solution: 'for h in web1 web2; do …; done', test: [`printf '%s' '${LOGROTATE4.replace(/\n/g, '\\n')}' > ~/shop.logrotate`, 'for h in web1 web2; do scp ~/shop.logrotate ubuntu@$h:/tmp/shop && ssh ubuntu@$h "sudo mv /tmp/shop /etc/logrotate.d/shop && sudo chown root:root /etc/logrotate.d/shop && sudo logrotate -d /etc/logrotate.d/shop"; done'], check: t => ['web1', 'web2'].every(w => { const s = t.file(w, '/etc/logrotate.d/shop') || ''; return /\/var\/log\/shop\/\*\.log/.test(s) && /\b(maxsize|size)\s+\d+[kMG]?\b/.test(s); }) && t.ran(/logrotate\s+-d\b/) },
          { title: 'Tuesday: when `ShopHighErrorRate` pages you, declare a SEV2, find which server and why (metrics by instance, logs), fix it, check the alert resolves, and resolve the incident', solution: 'incident declare --sev 2 --title "Checkout errors"', test: ['sleep 240', 'incident declare --sev 2 --title "Checkout errors on the shop" && incident role commander dev', "promtool query instant http://mon:9090 'sum by (instance) (rate(http_requests_total{job=\"shop\",status=~\"5..\"}[5m]))'", "logcli query '{app=\"shop\", level=\"error\"}' --limit 3", 'ssh ubuntu@web2 cat /etc/shop/shop.env', 'ssh ubuntu@web2 "sudo cp /etc/shop/shop.env.bak /etc/shop/shop.env && sudo systemctl restart shop"', 'incident note "web2 PAYMENTS_URL pointed at payments-v2.lumen.dev (does not exist); restored from backup"', 'incident status mitigated', 'sleep 420', 'incident status resolved'], check: t => { const i = inc(t); return !!t.uni.labData.tue && /PAYMENTS_URL=http:\/\/payments\.lumen\.dev\b/.test(t.file('web2', '/etc/shop/shop.env') || '') && t.active('web2', 'shop') && t.firing('ShopHighErrorRate').length === 0 && t.chat().some(m => m.payload.status === 'firing' && (m.payload.alerts || []).some(a => a.labels?.alertname === 'ShopHighErrorRate')) && !!i && i.sev <= 2 && i.status === 'resolved'; } },
          { title: 'Wednesday: renew the certificate for `shop.lumen.dev` on `lb`, and schedule renewal so it never depends on a person again', solution: 'ssh ubuntu@lb', test: ['ssh ubuntu@lb', 'sudo certbot certificates', 'sudo certbot renew', '(sudo crontab -l 2>/dev/null; echo "17 3 * * * certbot renew --quiet --deploy-hook \'systemctl reload nginx\'") | sudo crontab -', 'sudo crontab -l', 'exit', 'curl -sI https://shop.lumen.dev/ | head -1'], check: t => !!t.uni.labData.wed && certDaysLeft(t) > 60 && /certbot\s+renew/.test(t.cron('lb', 'root')) && t.http('laptop', 'https://shop.lumen.dev/').status === 200 },
          { title: 'Friday: write the on-call report in `~/oncall-week.md`: Summary, Impact, Timeline (all three issues), Contributing factors, and at least three Action items with @owner and a date. Blameless', solution: 'nano ~/oncall-week.md', test: [{ cmd: 'nano ~/oncall-week.md', edit: WEEK }], check: t => pmOk(file(t, '~/oncall-week.md'), { mustMention: [/disk|log/i, /payments|config/i, /certificate|cert/i] }) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'The disk alert fired. You truncated the log but left LOG_LEVEL=debug. What happens?', choices: ['The alert stays resolved', 'The log grows again and the page comes back', 'The shop stops', 'Nothing logs'], answer: 1, explain: 'Remove the cause, not just the symptom.' },
        { type: 'mc', q: 'Only web2 returned errors. Which query finds that quickly?', choices: ['sum(rate(http_requests_total[5m]))', 'sum by (instance) of the 5xx rate', 'up', 'node_load1'], answer: 1, explain: 'Break the error rate down by instance.' },
        { type: 'multi', q: 'Good outcomes from an on-call week:', choices: ['Every alert resolved', 'Guard rails so each issue cannot recur the same way', 'Owned, dated action items', 'A list of who caused what'], answer: [0, 1, 2], explain: 'Blameless: systems, not scapegoats.' },
        { type: 'tf', q: 'Renewing the certificate by hand completes the Wednesday task.', answer: false, explain: 'Automate renewal (and alert on expiry) or it will happen again in 90 days.' },
        { type: 'order', q: 'Order your response to a page.', items: ['Acknowledge and look at the alert', 'Find the affected machine and the cause', 'Mitigate', 'Check the alert resolves', 'Add a guard rail and record it'], explain: 'Then write it down for the report.' },
      ],
    },
  ],
};
