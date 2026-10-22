// Realm 8 · Infrastructure as Code: Terraform against a simulated AWS account (instances
// are real servers, security groups really filter traffic, state can live in S3 with
// locking) and Ansible over SSH to those servers.

import { parseHcl } from '../sim/hcl.js';
import { parseYaml } from '../git/yaml.js';

const MY_IP = '198.51.100.23';
const UBUNTU = 'ami-0a7f1556c36aea1b6', JAMMY = 'ami-0f3c9c4c5b1e8b2a1';
const PROVIDER = ['terraform {', '  required_providers {', '    aws = {', '      source  = "hashicorp/aws"', '      version = "~> 5.0"', '    }', '  }', '}', '', 'provider "aws" {', '  region = "eu-west-1"', '}', ''].join('\n');
const CLOUD_INIT = ['#!/bin/bash', 'apt-get update', 'apt-get install -y nginx', 'echo "<h1>Lumen events</h1><p>served by $(hostname)</p>" > /var/www/html/index.html', ''].join('\n');

const cloudOf = t => t.cloud();
const inst = (t, pred = () => true) => t.cres('aws_instance', pred);
const sgByName = (t, name) => t.cres('aws_security_group', g => g.name === name)[0] || null;
const openSsh = sg => (sg?.ingress || []).some(r => (r.cidr_blocks || []).includes('0.0.0.0/0') && Number(r.from_port) <= 22 && Number(r.to_port) >= 22);
const tfEvents = (t, pred = () => true) => t.events('terraform').filter(pred);
const lastTf = (t, sub, dirRe) => tfEvents(t, e => e.sub === sub && (!dirRe || dirRe.test(e.dir))).pop() || null;
const hclOk = (t, path) => { try { return parseHcl(t.file('laptop', path) || ''); } catch { return null; } };
const stateOf = (t, dir) => t.tfstate(dir);
const inState = (st, type, name) => !!st?.resources?.some(r => r.type === type && r.name === name && r.instances.length);
const page = (t, ip) => { const r = t.http('laptop', `http://${ip}/`); return r.status === 200 ? String(r.body) : null; };

function sshKey(H) { H.run('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q', { on: 'laptop' }); }
// the hand-built server: launched "in the console" two years ago
function legacy(H) {
  H.clickops(cloud => {
    const sg = cloud.put('aws_security_group', { name: 'launch-wizard-1', description: 'launch-wizard-1 created 2024-03-14T10:22:41Z', vpc_id: cloud.defaultVpc, ingress: [{ from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'], description: '', security_groups: [], self: false }, { from_port: 80, to_port: 80, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'], description: '', security_groups: [], self: false }], egress: [], tags: {} });
    cloud.put('aws_key_pair', { id: 'old-key', key_name: 'old-key', public_key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQold old@samir-laptop', fingerprint: 'a1:b2:c3' });
    const i = cloud.launch({ ami: JAMMY, instance_type: 't3.medium', key_name: 'old-key', vpc_security_group_ids: [sg.id], user_data: CLOUD_INIT, tags: { Name: 'web-legacy' } });
    cloud.record('create', 'aws_instance', i.id, 'console');
  });
}
const WEB_TF = (o = {}) => [PROVIDER,
  'resource "aws_key_pair" "dev" {', '  key_name   = "dev-laptop"', '  public_key = file("~/.ssh/id_ed25519.pub")', '}', '',
  'resource "aws_security_group" "web" {', '  name        = "events-web"', '  description = "events web server"', '', '  ingress {', '    description = "SSH from my laptop"', '    from_port   = 22', '    to_port     = 22', '    protocol    = "tcp"', `    cidr_blocks = ["${MY_IP}/32"]`, '  }', '', '  ingress {', '    description = "HTTP from anywhere"', '    from_port   = 80', '    to_port     = 80', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '}', '',
  'resource "aws_instance" "web" {', `  ami                    = "${o.ami || UBUNTU}"`, `  instance_type          = "${o.type || 't3.micro'}"`, '  key_name               = aws_key_pair.dev.key_name', '  vpc_security_group_ids = [aws_security_group.web.id]', '  user_data              = file("cloud-init.sh")', '', '  tags = {', '    Name = "events-web"', '  }', '}', '',
  'output "public_ip" {', '  value = aws_instance.web.public_ip', '}', ''].join('\n');

// ---------- lesson 3: module ----------
const MODULE = {
  'variables.tf': ['variable "name" {', '  type        = string', '  description = "prefix for every resource"', '}', '', 'variable "instances" {', '  type    = number', '  default = 1', '  validation {', '    condition     = var.instances >= 1 && var.instances <= 4', '    error_message = "instances must be between 1 and 4 (ask the platform team for more)."', '  }', '}', '', 'variable "instance_type" {', '  type    = string', '  default = "t3.micro"', '}', ''].join('\n'),
  'main.tf': ['resource "aws_security_group" "web" {', '  name = "${var.name}-web"', '  ingress {', '    from_port   = 80', '    to_port     = 80', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '}', '', 'resource "aws_instance" "web" {', '  count                  = var.instances', `  ami                    = "${UBUNTU}"`, '  instance_type          = var.instance_type', '  vpc_security_group_ids = [aws_security_group.web.id]', '  user_data              = <<-EOF', '    #!/bin/bash', '    apt-get install -y nginx', '    echo "${var.name} web ${count.index + 1}" > /var/www/html/index.html', '  EOF', '', '  tags = {', '    Name = "${var.name}-${count.index + 1}"', '  }', '}', ''].join('\n'),
  'outputs.tf': ['output "public_ips" {', '  value = aws_instance.web[*].public_ip', '}', ''].join('\n'),
};
const ENV_TF = (name, n, type) => [PROVIDER, 'module "web" {', '  source        = "../../modules/web-server"', `  name          = "${name}"`, `  instances     = ${n}`, `  instance_type = "${type}"`, '}', '', 'output "ips" {', '  value = module.web.public_ips', '}', ''].join('\n');

// ---------- lesson 4: state ----------
const STATE_TF = [PROVIDER, 'resource "random_password" "db" {', '  length  = 20', '  special = false', '}', '', 'resource "aws_security_group" "web" {', '  name = "events-state-web"', '  ingress {', '    from_port   = 80', '    to_port     = 80', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '}', '', 'output "db_password" {', '  value     = random_password.db.result', '  sensitive = true', '}', ''].join('\n');
const BACKEND_TF = ['terraform {', '  backend "s3" {', '    bucket         = "lumen-tfstate"', '    key            = "events/terraform.tfstate"', '    region         = "eu-west-1"', '    dynamodb_table = "tf-locks"', '    encrypt        = true', '  }', '}', ''].join('\n');
const IMPORT_TF = ['resource "aws_s3_bucket" "assets" {', '  bucket = "lumen-assets-legacy"', '}', ''].join('\n');

// ---------- lesson 5: safe changes ----------
const PROD_TF = (o = {}) => [PROVIDER,
  'resource "aws_s3_bucket" "uploads" {', `  bucket = "${o.bucket || 'lumen-events-uploads-prod'}"`, ...(o.protect ? ['', '  lifecycle {', '    prevent_destroy = true', '  }'] : []), '}', '',
  'resource "aws_security_group" "web" {', '  name = "events-prod-web"', '  ingress {', '    from_port   = 22', '    to_port     = 22', '    protocol    = "tcp"', `    cidr_blocks = ["${o.sshCidr || MY_IP + '/32'}"]`, '  }', '  ingress {', '    from_port   = 80', '    to_port     = 80', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '}', '',
  'resource "aws_instance" "web" {', `  ami                    = "${UBUNTU}"`, `  instance_type          = "${o.type || 't3.small'}"`, '  vpc_security_group_ids = [aws_security_group.web.id]', '  tags = {', '    Name = "events-prod"', '  }', '}', ''].join('\n');
const PR_CHANGE = PROD_TF({ bucket: 'lumen-prod-events-uploads', sshCidr: '0.0.0.0/0', type: 't3.medium' });
const REVIEWED = PROD_TF({ protect: true, type: 't3.medium' });

// ---------- lessons 6-7: ansible ----------
const INV = ['[web]', 'web1', 'web2', '', '[db]', 'db1', '', '[all:vars]', 'ansible_user=ubuntu', ''].join('\n');
const BASE_YML = ['- name: Base setup for every server', '  hosts: all', '  become: true', '  tasks:', '    - name: Install the team toolset', '      ansible.builtin.apt:', '        name:', '          - htop', '          - curl', '          - jq', '        state: present', '        update_cache: true', '', '    - name: Create the deploy user', '      ansible.builtin.user:', '        name: deploy', '        shell: /bin/bash', ''].join('\n');
const SITE_TPL = ['<!doctype html>', '<title>{{ site_title }}</title>', '<h1>{{ site_title }}</h1>', '<ul>', '{% for e in events %}', '  <li>{{ e.name }} ({{ e.day }})</li>', '{% endfor %}', '</ul>', '<p>served by {{ inventory_hostname }}</p>', ''].join('\n');
const GROUP_VARS = (extra = false) => ['site_title: Lumen Events', 'events:', '  - name: Jazz at the Docks', '    day: Friday', '  - name: Poetry Slam', '    day: Saturday', ...(extra ? ['  - name: Stand-up Night', '    day: Sunday'] : []), ''].join('\n');
const SITE_YML = (vault = false) => ['- name: Events web servers', '  hosts: web', '  become: true', ...(vault ? ['  vars_files:', '    - secrets.yml'] : []), '  tasks:', '    - name: Install nginx', '      ansible.builtin.apt:', '        name: nginx', '        state: present', '', '    - name: Events home page', '      ansible.builtin.template:', '        src: index.html.j2', '        dest: /var/www/html/index.html', '        mode: "0644"', '      notify: Reload nginx', '', ...(vault ? ['    - name: Deploy token for the release job', '      ansible.builtin.copy:', '        content: "{{ deploy_token }}"', '        dest: /etc/events-token', '        mode: "0600"', '      no_log: true', ''] : []), '    - name: Keep nginx running', '      ansible.builtin.service:', '        name: nginx', '        state: started', '        enabled: true', '', '  handlers:', '    - name: Reload nginx', '      ansible.builtin.service:', '        name: nginx', '        state: reloaded', ''].join('\n');

// ---------- boss ----------
const BOSS_TF = [PROVIDER,
  'resource "aws_vpc" "main" {', '  cidr_block = "10.20.0.0/16"', '  tags = {', '    Name = "events"', '  }', '}', '',
  'resource "aws_subnet" "public" {', '  vpc_id                  = aws_vpc.main.id', '  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, 1)', '  map_public_ip_on_launch = true', '  tags = {', '    Name = "events-public"', '  }', '}', '',
  'resource "aws_internet_gateway" "gw" {', '  vpc_id = aws_vpc.main.id', '}', '',
  'resource "aws_route_table" "public" {', '  vpc_id = aws_vpc.main.id', '  route {', '    cidr_block = "0.0.0.0/0"', '    gateway_id = aws_internet_gateway.gw.id', '  }', '}', '',
  'resource "aws_route_table_association" "public" {', '  subnet_id      = aws_subnet.public.id', '  route_table_id = aws_route_table.public.id', '}', '',
  'resource "aws_security_group" "web" {', '  name   = "events-web"', '  vpc_id = aws_vpc.main.id', '  ingress {', '    from_port   = 80', '    to_port     = 80', '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', '  }', '  ingress {', '    from_port   = 22', '    to_port     = 22', '    protocol    = "tcp"', `    cidr_blocks = ["${MY_IP}/32"]`, '  }', '}', '',
  'resource "aws_key_pair" "dev" {', '  key_name   = "events-dev"', '  public_key = file("~/.ssh/id_ed25519.pub")', '}', '',
  'resource "aws_instance" "web" {', '  count                  = 2', `  ami                    = "${UBUNTU}"`, '  instance_type          = "t3.micro"', '  subnet_id              = aws_subnet.public.id', '  vpc_security_group_ids = [aws_security_group.web.id]', '  key_name               = aws_key_pair.dev.key_name', '  tags = {', '    Name = "events-${count.index + 1}"', '  }', '}', '',
  'resource "local_file" "inventory" {', '  filename = "${path.module}/../events-config/inventory.ini"', '  content  = "[web]\\n${join("\\n", aws_instance.web[*].public_ip)}\\n\\n[web:vars]\\nansible_user=ubuntu\\n"', '}', '',
  'output "ips" {', '  value = aws_instance.web[*].public_ip', '}', ''].join('\n');
const BOSS_YML = ['- name: Events web servers', '  hosts: web', '  become: true', '  vars:', '    site_title: Lumen Events', '  tasks:', '    - name: Install nginx', '      ansible.builtin.apt:', '        name: nginx', '        state: present', '        update_cache: true', '', '    - name: Events home page', '      ansible.builtin.template:', '        src: index.html.j2', '        dest: /var/www/html/index.html', '        mode: "0644"', '      notify: Reload nginx', '', '    - name: Keep nginx running', '      ansible.builtin.service:', '        name: nginx', '        state: started', '        enabled: true', '', '  handlers:', '    - name: Reload nginx', '      ansible.builtin.service:', '        name: nginx', '        state: reloaded', ''].join('\n');
const BOSS_TPL = ['<h1>{{ site_title }}</h1>', '<p>Built from code. Served by {{ inventory_hostname }}.</p>', ''].join('\n');

const playbookRuns = (t, pb) => t.events('ansible-playbook').filter(e => e.playbook === pb && e.stats && !e.check);
const allChangedZero = e => !!e && Object.values(e.stats).every(s => s.changed === 0 && s.failed === 0 && s.unreachable === 0) && Object.keys(e.stats).length > 0;

export default {
  id: 'iac',
  n: 8,
  title: 'Infrastructure as Code',
  tagline: 'Terraform for the cloud, Ansible for the servers: declarative, reviewed, repeatable infrastructure',
  badge: 'Infra Architect',
  intro: 'Stop clicking in consoles. Describe infrastructure in **Terraform** (plan it, apply it, keep its **state** shared and locked, detect **drift**), reuse it with **variables and modules**, review changes **safely**, then configure the servers with **Ansible** playbooks, templates and handlers. The cloud here is simulated but honest: instances are real servers, security groups really block traffic.',
  lessons: [
    {
      id: 'why-iac',
      title: 'Why Infrastructure as Code',
      summary: 'ClickOps and snowflakes; declarative vs imperative; idempotence; provisioning vs configuration; a first terraform init/plan/apply/destroy.',
      minutes: 25,
      lab: {
        cwd: '~',
        panels: ['cloud', 'files'],
        setup(H) { H.cloud(); legacy(H); H.mkdir('laptop', '/home/dev/first', { owner: 'dev' }); },
        suggestions: ['aws sts get-caller-identity', 'aws ec2 describe-instances --output table'],
        tasks: [
          { title: 'Which cloud account are you in, and what is running? Show your identity and list the instances', solution: 'aws sts get-caller-identity && aws ec2 describe-instances', check: t => t.ran(/aws\s+sts\s+get-caller-identity/) && t.ran(/aws\s+ec2\s+describe-instances/) },
          { title: 'Inspect `web-legacy`\'s security group. What is open to the whole internet?', solution: 'aws ec2 describe-security-groups --query "SecurityGroups[].IpPermissions"', check: t => t.ran(/aws\s+ec2\s+describe-security-groups/) },
          { title: 'In `~/first`, write `main.tf` with the AWS provider and one `aws_s3_bucket` named `lumen-events-notes-2026`, then initialise the directory', solution: 'cd ~/first && nano main.tf && terraform init', test: ['cd ~/first', { cmd: 'nano main.tf', edit: PROVIDER + 'resource "aws_s3_bucket" "notes" {\n  bucket = "lumen-events-notes-2026"\n}\n' }, 'terraform init'], check: t => { const b = hclOk(t, '~/first/main.tf'); return !!b?.blocks.some(x => x.type === 'resource' && x.labels[0] === 'aws_s3_bucket') && t.exists('laptop', '/home/dev/first/.terraform.lock.hcl'); } },
          { title: 'Plan, then apply (type `yes` when asked). The bucket now exists', solution: 'terraform plan && terraform apply', test: ['terraform plan', { cmd: 'terraform apply', answers: ['yes'] }], check: t => t.cres('aws_s3_bucket', b => b.bucket === 'lumen-events-notes-2026').length === 1 && inState(stateOf(t, '~/first'), 'aws_s3_bucket', 'notes') },
          { title: 'Run `terraform plan` again. What does Terraform want to change now, and why?', solution: 'terraform plan', check: t => t.after(e => e.type === 'terraform-apply' && /\/first$/.test(e.dir), e => e.type === 'terraform' && e.sub === 'plan' && e.ok && e.counts && e.counts.add + e.counts.change + e.counts.destroy === 0) },
          { title: 'Clean up: destroy what this configuration created', solution: 'terraform destroy', test: [{ cmd: 'terraform destroy', answers: ['yes'] }], check: t => t.cres('aws_s3_bucket', b => b.bucket === 'lumen-events-notes-2026').length === 0 && t.events('terraform-apply').some(e => e.destroy) && t.cres('aws_instance', i => i.tags?.Name === 'web-legacy').length === 1 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does "idempotent" mean for an infrastructure tool?', choices: ['It runs fast', 'Running it again when nothing needs changing changes nothing', 'It never fails', 'It runs in parallel'], answer: 1, explain: 'That is what makes re-running safe and drift detectable.' },
        { type: 'mc', q: 'Declarative vs imperative: which is declarative?', choices: ['A bash script: create the VPC, then the subnet, then attach…', 'A description of the end state that a tool converges on', 'Clicking through the console wizard', 'A runbook document'], answer: 1, explain: 'You say what, the tool works out how.' },
        { type: 'multi', q: 'Problems with ClickOps:', choices: ['Nobody can review or reproduce what was done', 'Environments drift apart', 'It is impossible to see the current state in the console', 'Rebuilding after a disaster depends on someone\'s memory'], answer: [0, 1, 3], explain: 'The console shows the current state fine; it just doesn\'t record intent or history.' },
        { type: 'mc', q: 'Terraform vs Ansible, roughly:', choices: ['Both only manage containers', 'Terraform provisions cloud resources via APIs; Ansible configures machines over SSH', 'Ansible creates VPCs; Terraform installs packages', 'They are the same tool'], answer: 1, explain: 'They overlap a little, but that is the usual split.' },
        { type: 'tf', q: '`terraform plan` changes nothing in the real infrastructure.', answer: true, explain: 'It only reads and compares. apply makes changes.' },
        { type: 'type', q: 'Type the command that downloads the providers a Terraform directory needs.', accept: ['terraform init'], model: 'terraform init', explain: 'Run it in each new directory, and after adding providers, modules or a backend.' },
      ],
    },
    {
      id: 'terraform-basics',
      title: 'Terraform: resources, references and plans',
      summary: 'Providers, resources, references as dependencies, plan symbols, update vs replace, outputs, state, user_data.',
      minutes: 35,
      lab: {
        cwd: '~/web',
        panels: ['cloud', 'files'],
        setup(H) { H.cloud(); sshKey(H); H.write('laptop', '~/web/cloud-init.sh', CLOUD_INIT, { owner: 'dev', mode: 0o755 }); },
        suggestions: ['cat cloud-init.sh', 'nano main.tf'],
        tasks: [
          { title: 'Write `main.tf`: a key pair from `~/.ssh/id_ed25519.pub`, a security group `events-web` (SSH only from 198.51.100.23/32, HTTP from anywhere), an Ubuntu `t3.micro` instance using both with `user_data = file("cloud-init.sh")` and tag `Name = events-web`, and an output `public_ip`. Then `init` and `validate`', hint: 'Refer to other resources by `type.name.attribute`, e.g. `[aws_security_group.web.id]`. Those references also tell Terraform the order.', solution: 'nano main.tf && terraform init && terraform validate', test: [{ cmd: 'nano main.tf', edit: WEB_TF() }, 'terraform init && terraform validate'], check: t => !!t.events('terraform').some(e => e.sub === 'validate' && e.ok) && !!hclOk(t, '~/web/main.tf')?.blocks.some(b => b.type === 'resource' && b.labels[0] === 'aws_instance') },
          { title: 'Plan and apply. Read the plan first: how many resources, in which order?', solution: 'terraform plan && terraform apply', test: ['terraform plan', { cmd: 'terraform apply', answers: ['yes'] }], check: t => { const i = inst(t, x => x.tags?.Name === 'events-web')[0]; const sg = sgByName(t, 'events-web'); return !!i && !!sg && !openSsh(sg) && (i.vpc_security_group_ids || []).includes(sg.id) && i.key_name === 'dev-laptop'; } },
          { title: 'Open the site (cloud-init installed nginx at boot) and SSH in as `ubuntu`, both using the output', solution: 'curl -s http://$(terraform output -raw public_ip)/ && ssh -o StrictHostKeyChecking=accept-new ubuntu@$(terraform output -raw public_ip) hostname', check: t => { const i = inst(t, x => x.tags?.Name === 'events-web')[0]; return !!i && t.events('http').some(e => e.host === 'laptop' && e.url.includes(i.public_ip) && e.status === 200) && t.events('ssh').some(e => e.to === i.host && e.user === 'ubuntu'); } },
          { title: 'Change the instance type to `t3.small` and apply. Did the server get replaced or updated in place?', solution: 'sed -i "s/t3.micro/t3.small/" main.tf && terraform apply', test: ['sed -i "s/t3.micro/t3.small/" main.tf', { cmd: 'terraform apply', answers: ['yes'] }], check: t => { const i = inst(t, x => x.tags?.Name === 'events-web'); return i.length === 1 && i[0].instance_type === 't3.small' && t.events('terraform-apply').some(e => e.changed === 1 && e.added === 0 && e.destroyed === 0); } },
          { title: `Switch the AMI to Ubuntu 22.04 (\`${JAMMY}\`). Plan first and find the line that explains what will happen, then apply`, solution: `sed -i "s/${UBUNTU}/${JAMMY}/" main.tf && terraform plan && terraform apply`, test: [`sed -i "s/${UBUNTU}/${JAMMY}/" main.tf`, 'terraform plan', { cmd: 'terraform apply', answers: ['yes'] }], check: t => { const i = inst(t, x => x.tags?.Name === 'events-web'); return i.length === 1 && i[0].ami === JAMMY && t.events('terraform-apply').some(e => e.added >= 1 && e.destroyed >= 1); } },
          { title: 'Look at what Terraform tracks: list the state and show the instance', solution: 'terraform state list && terraform state show aws_instance.web', check: t => t.ran(/terraform\s+state\s+list/) && t.ran(/terraform\s+state\s+show\s+aws_instance\.web/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'In a plan, what does `-/+` mean?', choices: ['Update in place', 'Destroy and re-create (replace)', 'Import', 'Read a data source'], answer: 1, explain: 'Look for "# forces replacement" next to the attribute that causes it.' },
        { type: 'mc', q: 'How does Terraform know to create the security group before the instance?', choices: ['File order', 'Alphabetical order', 'The instance refers to aws_security_group.web.id, which creates a dependency', 'It guesses'], answer: 2, explain: 'References form the dependency graph.' },
        { type: 'mc', q: 'You change user_data on a running instance (default settings). What happens?', choices: ['The script re-runs immediately', 'Terraform updates the attribute, but cloud-init only ran at first boot, so the server is unchanged', 'The instance is always replaced', 'Nothing appears in the plan'], answer: 1, explain: 'Use configuration management, or replace the instance (user_data_replace_on_change).' },
        { type: 'multi', q: 'Which belong in git?', choices: ['*.tf files', '.terraform.lock.hcl', '.terraform/ (downloaded providers)', 'terraform.tfstate'], answer: [0, 1], explain: 'Providers are downloaded; state belongs in a remote backend.' },
        { type: 'predict', q: 'What does the plan show?', code: '# live: instance_type = "t3.micro"\n# code:  instance_type = "t3.small"', choices: ['~ update in-place', '-/+ replace', '+ create', 'No changes'], answer: 0, explain: 'Instance type can be changed in place (AWS stops and starts the instance).' },
        { type: 'type', q: 'Type the command that prints just the value of output `public_ip`, without quotes.', accept: ['terraform output -raw public_ip'], model: 'terraform output -raw public_ip', explain: '-raw is handy inside $( ).' },
      ],
    },
    {
      id: 'variables-modules',
      title: 'Variables, outputs and modules',
      summary: 'Variables with types, defaults and validation; outputs; count; a local module reused by separate staging and production roots.',
      minutes: 35,
      lab: {
        cwd: '~/events',
        panels: ['cloud', 'files'],
        setup(H) { H.cloud(); for (const [f, t] of Object.entries(MODULE)) H.write('laptop', `~/events/modules/web-server/${f}`, t, { owner: 'dev' }); H.mkdir('laptop', '/home/dev/events/envs/staging', { owner: 'dev' }); H.mkdir('laptop', '/home/dev/events/envs/production', { owner: 'dev' }); },
        suggestions: ['tree ~/events', 'cat modules/web-server/variables.tf'],
        tasks: [
          { title: 'Read the module in `modules/web-server`: what are its inputs and outputs?', solution: 'cat modules/web-server/variables.tf modules/web-server/outputs.tf', check: t => t.ran(/(cat|less|head)\b.*variables\.tf/) && t.ran(/(cat|less|head)\b.*outputs\.tf/) },
          { title: 'In `envs/staging`, write `main.tf` that calls the module (`source = "../../modules/web-server"`, name `events-staging`, 1 instance, `t3.micro`) and outputs its IPs. Init and apply', solution: 'cd envs/staging && nano main.tf && terraform init && terraform apply', test: ['cd envs/staging', { cmd: 'nano main.tf', edit: ENV_TF('events-staging', 1, 't3.micro') }, 'terraform init', { cmd: 'terraform apply', answers: ['yes'] }], check: t => inst(t, i => /^events-staging-\d$/.test(i.tags?.Name || '')).length === 1 },
          { title: 'In `envs/production`, call the same module as `events-production` with `t3.small`. Try `instances = 10` first and read the error, then use 2', solution: 'cd ../production && nano main.tf && terraform init && terraform plan; nano main.tf && terraform apply', test: ['cd ../production', { cmd: 'nano main.tf', edit: ENV_TF('events-production', 10, 't3.small') }, 'terraform init', 'terraform plan', { cmd: 'nano main.tf', edit: ENV_TF('events-production', 2, 't3.small') }, { cmd: 'terraform apply', answers: ['yes'] }], check: t => t.events('terraform').some(e => e.ok === false && /Invalid value for variable/.test(e.error || '')) && inst(t, i => /^events-production-\d$/.test(i.tags?.Name || '') && i.instance_type === 't3.small').length === 2 },
          { title: 'Each environment has its own state. Show the outputs of both as JSON', solution: 'terraform output -json && cd ../staging && terraform output -json', check: t => t.events('terraform').filter(e => e.sub === 'output' && /envs\/(staging|production)$/.test(e.dir)).map(e => e.dir).filter((d, i, a) => a.indexOf(d) === i).length === 2 || (t.ran(/terraform\s+output\s+-json/) && t.events('terraform').filter(e => e.sub === 'output').length >= 2) },
          { title: 'Improve the module once: add a tag `Team = "events"` to its instances. Plan and apply in both environments', solution: 'nano ../../modules/web-server/main.tf && terraform apply && cd ../production && terraform apply', test: [{ cmd: 'nano /home/dev/events/modules/web-server/main.tf', edit: MODULE['main.tf'].replace('    Name = "${var.name}-${count.index + 1}"', '    Name = "${var.name}-${count.index + 1}"\n    Team = "events"') }, 'cd /home/dev/events/envs/staging', { cmd: 'terraform apply', answers: ['yes'] }, 'cd ../production', { cmd: 'terraform apply', answers: ['yes'] }], check: t => { const all = inst(t, i => /^events-(staging|production)-\d$/.test(i.tags?.Name || '')); return all.length === 3 && all.every(i => i.tags?.Team === 'events'); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'A variable has no default and no value is given. What does `terraform plan` do?', choices: ['Uses an empty string', 'Asks for it interactively (or fails with -input=false)', 'Skips resources using it', 'Uses the previous value'], answer: 1, explain: 'In CI, always pass values explicitly.' },
        { type: 'mc', q: 'Why prefer `for_each` over `count` for named things?', choices: ['It is faster', 'Removing one element does not renumber and replace the others', 'count is deprecated', 'for_each needs no state'], answer: 1, explain: 'count indexes shift; for_each keys stay stable.' },
        { type: 'mc', q: 'What does a variable `validation` block do?', choices: ['Encrypts the value', 'Rejects values that break a rule, with your error message, before anything changes', 'Validates the provider', 'Sets the default'], answer: 1, explain: 'Guard rails for module users.' },
        { type: 'tf', q: '`sensitive = true` keeps a value out of the state file.', answer: false, explain: 'It hides it in output; state still stores it in plain text.' },
        { type: 'multi', q: 'Good ways to keep staging and production separate:', choices: ['Separate root directories (or workspaces) with separate state', 'Different tfvars per environment', 'One state file switched with different tfvars', 'The same modules called with different inputs'], answer: [0, 1, 3], explain: 'One shared state switched between environments would replace one with the other.' },
        { type: 'mc', q: 'How does a root module read a module\'s output `public_ips`?', choices: ['var.public_ips', 'module.web.public_ips', 'output.web.public_ips', 'data.web.public_ips'], answer: 1, explain: 'module.<call name>.<output>.' },
      ],
    },
    {
      id: 'state-drift',
      title: 'State, locking and drift',
      summary: 'What state holds (secrets too), remote S3 backend with locking, migration, waiting for locks, drift detection, revert vs adopt, import.',
      minutes: 35,
      lab: {
        cwd: '~/events-state',
        panels: ['cloud', 'files'],
        setup(H) {
          H.cloud();
          H.write('laptop', '~/events-state/main.tf', STATE_TF, { owner: 'dev' });
          H.run('cd ~/events-state && terraform init >/dev/null && terraform apply -auto-approve >/dev/null', { on: 'laptop' });
          H.clickops(cloud => {
            cloud.buckets.set('lumen-tfstate', { objects: new Map() });
            cloud.put('aws_s3_bucket', { id: 'lumen-tfstate', bucket: 'lumen-tfstate', arn: 'arn:aws:s3:::lumen-tfstate', created: H.uni.time - 86400 * 90, tags: { Owner: 'platform' }, force_destroy: false });
            cloud.buckets.set('lumen-assets-legacy', { objects: new Map([['logo.png', { body: 'PNG', size: 18234, time: H.uni.time - 86400 * 400 }], ['flyer.pdf', { body: 'PDF', size: 220114, time: H.uni.time - 86400 * 200 }]]) });
            cloud.put('aws_s3_bucket', { id: 'lumen-assets-legacy', bucket: 'lumen-assets-legacy', arn: 'arn:aws:s3:::lumen-assets-legacy', bucket_domain_name: 'lumen-assets-legacy.s3.amazonaws.com', region: cloud.region, created: H.uni.time - 86400 * 400, tags: {}, force_destroy: false });
            cloud.record('create', 'aws_s3_bucket', 'lumen-assets-legacy', 'console');
          });
        },
        events(ev, t) {
          const U = t.uni;
          if (ev.type === 'terraform' && ev.sub === 'init' && ev.backend === 's3' && !U.labData.lockedOnce) {
            U.labData.lockedOnce = true; U.labData.lockAt = U.time;
            t.tfLock('lumen-tfstate/events/terraform.tfstate');
            if (!U.labData.unlockTicker) { U.labData.unlockTicker = true; U.tickers.push(() => { if (U.tfLocks && U.labData.lockAt && U.time - U.labData.lockAt >= 60) { delete U.tfLocks['lumen-tfstate/events/terraform.tfstate']; U.labData.lockAt = null; } }); }
            t.say('💬 Priya: "I\'m running an apply on events right now, give me a minute!"');
          }
          if (ev.type === 'terraform' && ev.sub === 'plan' && ev.ok && U.labData.lockedOnce && !U.labData.drifted && !U.tfLocks?.['lumen-tfstate/events/terraform.tfstate']) {
            U.labData.drifted = true;
            const sg = U.cloud.all('aws_security_group').find(g => g.name === 'events-state-web');
            sg.ingress = [...sg.ingress, { cidr_blocks: ['0.0.0.0/0'], description: 'temp debug', from_port: 22, protocol: 'tcp', security_groups: [], self: false, to_port: 22 }];
            U.cloud.record('update', 'aws_security_group', sg.id, 'console');
            t.say('💬 Kofi: "quickly opened SSH on events-state-web in the console to debug something, will tidy up later 🙏"');
          }
        },
        suggestions: ['cat main.tf', 'terraform state list'],
        tasks: [
          { title: 'The state is a local file. Look inside `terraform.tfstate`: find the database password the output marks as sensitive', solution: 'grep -n result terraform.tfstate', check: t => t.ran(/(grep|cat|less|jq)\b.*terraform\.tfstate/) },
          { title: 'Move the state to the shared backend: add a `backend "s3"` block (bucket `lumen-tfstate`, key `events/terraform.tfstate`, dynamodb_table `tf-locks`, encrypt) and run `terraform init`, letting it copy the state', solution: 'nano backend.tf && terraform init', test: [{ cmd: 'nano backend.tf', edit: BACKEND_TF }, { cmd: 'terraform init', answers: ['yes'] }], check: t => !!cloudOf(t).buckets.get('lumen-tfstate')?.objects.get('events/terraform.tfstate') && !t.exists('laptop', '/home/dev/events-state/terraform.tfstate') },
          { title: 'Run a plan. Someone holds the lock: do not force-unlock it. Wait a minute and plan again', hint: '`sleep 60` waits in the simulator. force-unlock is only for locks you know are stale.', solution: 'terraform plan; sleep 60; terraform plan', test: ['terraform plan', 'sleep 60', 'terraform plan'], check: t => t.events('terraform').some(e => e.ok === false && /state lock/.test(e.error || '')) && t.after(e => e.type === 'terraform' && e.ok === false && /state lock/.test(e.error || ''), e => e.type === 'terraform' && e.sub === 'plan' && e.ok) && !t.ran(/force-unlock/) },
          { title: 'Plan once more: something changed outside Terraform. Find what, and who did it (CloudTrail is in the Cloud panel)', solution: 'terraform plan', check: t => t.events('terraform').some(e => e.sub === 'plan' && e.ok && e.drift > 0) },
          { title: 'Kofi agrees the change was temporary. Put the code back in charge so SSH is closed again', solution: 'terraform apply', test: [{ cmd: 'terraform apply', answers: ['yes'] }], check: t => { const sg = sgByName(t, 'events-state-web'); return !!sg && !openSsh(sg) && t.events('terraform-apply').some(e => e.changed >= 1); } },
          { title: 'Adopt the hand-made bucket `lumen-assets-legacy`: write a resource block for it and import it, then confirm the plan shows no changes', solution: 'nano assets.tf && terraform import aws_s3_bucket.assets lumen-assets-legacy && terraform plan', test: [{ cmd: 'nano assets.tf', edit: IMPORT_TF }, 'terraform import aws_s3_bucket.assets lumen-assets-legacy', 'terraform plan'], check: t => { const st = JSON.parse(cloudOf(t).buckets.get('lumen-tfstate')?.objects.get('events/terraform.tfstate')?.body || '{}'); return inState(st, 'aws_s3_bucket', 'assets') && t.after(e => e.type === 'terraform' && e.sub === 'import', e => e.type === 'terraform' && e.sub === 'plan' && e.ok && e.counts?.add === 0 && e.counts?.destroy === 0); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Why use a remote backend with locking?', choices: ['Faster plans', 'One shared state that two people cannot write at the same time', 'It encrypts your .tf files', 'It removes the need for providers'], answer: 1, explain: 'Shared, locked, versioned state.' },
        { type: 'mc', q: '"Error acquiring the state lock", and the Who: field is a colleague with an apply in progress. What do you do?', choices: ['terraform force-unlock', 'Wait or talk to them; force-unlock only if their run is known to be dead', 'Delete the lock table', 'Use -lock=false'], answer: 1, explain: 'Two writers corrupt state.' },
        { type: 'mc', q: 'A plan shows "Objects have changed outside of Terraform". This is…', choices: ['A Terraform bug', 'Drift: someone or something changed the real resource', 'A provider upgrade', 'A syntax error'], answer: 1, explain: 'Then decide: revert with apply, or adopt into the code.' },
        { type: 'multi', q: 'Which are true about state?', choices: ['It can contain secrets in plain text', 'It maps resource addresses to real IDs', 'You should fix it by editing the JSON', 'terraform state rm forgets a resource without destroying it'], answer: [0, 1, 3], explain: 'Use state commands, never hand edits.' },
        { type: 'mc', q: 'What does `terraform import` do?', choices: ['Downloads a module', 'Brings an existing real resource under Terraform management (into state)', 'Copies state between backends', 'Creates a resource'], answer: 1, explain: 'Write the resource block first, then check the plan.' },
        { type: 'tf', q: 'After migrating to the S3 backend, the local terraform.tfstate should be kept in git as a backup.', answer: false, explain: 'It is stale and full of secrets. The bucket keeps versions.' },
      ],
    },
    {
      id: 'safe-changes',
      title: 'Safe changes and reviewing plans',
      summary: 'Reading plans for destroys and replacements, saved plans, prevent_destroy, -target, reviewing AI-written infrastructure.',
      minutes: 30,
      lab: {
        cwd: '~/events-prod',
        panels: ['cloud', 'files'],
        setup(H) {
          H.cloud();
          H.write('laptop', '~/events-prod/main.tf', PROD_TF(), { owner: 'dev' });
          H.run('cd ~/events-prod && terraform init >/dev/null && terraform apply -auto-approve >/dev/null', { on: 'laptop' });
          H.clickops(cloud => { const b = cloud.buckets.get('lumen-events-uploads-prod'); for (let i = 1; i <= 4; i++) b.objects.set(`tickets/2026/ticket-${1000 + i}.pdf`, { body: 'PDF', size: 48000 + i, time: H.uni.time - 3600 * i }); });
          H.write('laptop', '~/events-prod/main.tf', PR_CHANGE, { owner: 'dev' });
          H.uni.ai = { rules: [{ id: 'ssh', when: /ssh|connect|timeout|can't reach|cannot reach/i, reply: ['SSH times out because the security group only allows one IP.', 'Open it up so it always works:', '', '    cidr_blocks = ["0.0.0.0/0"]', '', 'and apply with `terraform apply -auto-approve` to skip the prompt.'] }] };
        },
        suggestions: ['git diff --no-index /dev/null main.tf', 'terraform plan -out=tfplan'],
        tasks: [
          { title: 'A teammate\'s change (written with an AI assistant) is in `main.tf`. Plan it and save the plan as `tfplan`. How many things will be destroyed?', solution: 'terraform plan -out=tfplan', check: t => t.events('terraform').some(e => e.sub === 'plan' && e.saved && e.counts?.destroy >= 1) },
          { title: 'The bucket "rename" forces replacement of a bucket full of customer tickets. Revert the name and protect the bucket with `lifecycle { prevent_destroy = true }`', solution: 'nano main.tf', test: [{ cmd: 'nano main.tf', edit: PROD_TF({ protect: true, sshCidr: '0.0.0.0/0', type: 't3.medium' }) }], check: t => { const b = hclOk(t, '~/events-prod/main.tf'); const bucket = b?.blocks.find(x => x.type === 'resource' && x.labels[0] === 'aws_s3_bucket'); return !!bucket && /lumen-events-uploads-prod/.test(t.file('laptop', '~/events-prod/main.tf')) && !!bucket.blocks.find(x => x.type === 'lifecycle')?.attrs.prevent_destroy; } },
          { title: 'Check the security group change with `ai explain` on the rule, then restrict SSH back to 198.51.100.23/32', solution: 'ai explain "cidr_blocks = [\\"0.0.0.0/0\\"] on port 22" ; nano main.tf', test: ['ai explain "0.0.0.0/0 on port 22"', { cmd: 'nano main.tf', edit: REVIEWED }], check: t => { const txt = t.file('laptop', '~/events-prod/main.tf') || ''; const m = txt.match(/from_port\s*=\s*22[\s\S]*?cidr_blocks\s*=\s*\[([^\]]*)\]/); return !!m && !/0\.0\.0\.0\/0/.test(m[1]) && t.events('ai-explain').length > 0; } },
          { title: 'Save a new plan (it should only change the instance type), review it, and apply exactly that plan file', solution: 'terraform plan -out=tfplan && terraform apply tfplan', check: t => { const i = inst(t, x => x.tags?.Name === 'events-prod')[0]; return i?.instance_type === 't3.medium' && t.ran(/terraform\s+apply\s+\S*tfplan/) && cloudOf(t).buckets.get('lumen-events-uploads-prod')?.objects.size === 4 && !openSsh(sgByName(t, 'events-prod-web')); } },
          { title: 'Prove the guard works: plan a targeted destroy of the uploads bucket and read why Terraform refuses', solution: 'terraform plan -destroy -target=aws_s3_bucket.uploads', check: t => t.events('terraform').some(e => e.ok === false && /cannot be destroyed/.test(e.error || '')) && cloudOf(t).buckets.has('lumen-events-uploads-prod') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What is the first thing to look at in a plan?', choices: ['The provider version', 'The summary line: anything to destroy?', 'The colours', 'The number of attributes'], answer: 1, explain: 'Then every -/+ and its "forces replacement".' },
        { type: 'mc', q: 'Why apply a saved plan file instead of plain `terraform apply`?', choices: ['It is faster', 'It applies exactly what was reviewed; if anything changed since, it refuses', 'It skips the state lock', 'It encrypts the state'], answer: 1, explain: 'Plan once, review, apply that.' },
        { type: 'mc', q: 'What does `prevent_destroy = true` do?', choices: ['Makes the resource undeletable in the cloud', 'Makes any plan that would destroy or replace it fail', 'Hides it from plans', 'Backs it up'], answer: 1, explain: 'It is a Terraform guard; the console can still delete it.' },
        { type: 'multi', q: 'Red flags when reviewing AI-generated Terraform:', choices: ['cidr_blocks = ["0.0.0.0/0"] on port 22 or a database port', 'terraform apply -auto-approve in instructions for humans', 'Hard-coded secrets', 'Resources referenced by type.name.attribute'], answer: [0, 1, 2], explain: 'References are good practice.' },
        { type: 'tf', q: 'Using `-target` routinely is a good way to keep changes small.', answer: false, explain: 'It leaves the rest of the configuration unapplied. Keep changes small in the code instead.' },
        { type: 'mc', q: 'Where should infrastructure changes be applied for production?', choices: ['From whoever\'s laptop is open', 'From a pipeline, after the plan was reviewed in the pull request', 'In the console', 'Anywhere, as long as -auto-approve is used'], answer: 1, explain: 'Reviewed, reproducible, with controlled credentials.' },
      ],
    },
    {
      id: 'ansible-basics',
      title: 'Ansible: inventories, modules, idempotence',
      summary: 'Inventory files and groups, ad-hoc commands, become, modules vs shell, a first playbook, check mode, idempotent re-runs.',
      minutes: 30,
      lab: {
        cwd: '~/ops',
        panels: ['system', 'files'],
        laptopPackages: ['ansible'],
        setup(H) { for (const n of ['web1', 'web2', 'db1']) { H.server(n); H.authorize('laptop', 'dev', n, 'ubuntu'); } H.mkdir('laptop', '/home/dev/ops', { owner: 'dev' }); },
        suggestions: ['nano inventory.ini', 'ansible --version'],
        tasks: [
          { title: 'Write `inventory.ini`: group `web` with web1 and web2, group `db` with db1, and `ansible_user=ubuntu` for all. Show it as a graph', solution: 'nano inventory.ini && ansible-inventory -i inventory.ini --graph', test: [{ cmd: 'nano inventory.ini', edit: INV }, 'ansible-inventory -i inventory.ini --graph'], check: t => t.events('ansible-inventory').length > 0 && /\[web\][\s\S]*web1[\s\S]*web2/.test(t.file('laptop', '~/ops/inventory.ini') || '') && /\[db\][\s\S]*db1/.test(t.file('laptop', '~/ops/inventory.ini') || '') },
          { title: 'Check Ansible can reach every server: ping them all', solution: 'ansible all -i inventory.ini -m ping', check: t => t.events('ansible').some(e => e.module === 'ping' && e.rc === 0 && e.hosts.length === 3) },
          { title: 'Ad hoc: show the uptime of just the web servers', solution: 'ansible web -i inventory.ini -m command -a "uptime"', check: t => t.events('ansible').some(e => e.pattern === 'web' && /uptime/.test(e.args || '')) },
          { title: 'Install `htop` on every server with the `apt` module. It fails at first: fix it with become', solution: 'ansible all -i inventory.ini -m apt -a "name=htop state=present"; ansible all -i inventory.ini -b -m apt -a "name=htop state=present"', test: ['ansible all -i inventory.ini -m apt -a "name=htop state=present"', 'ansible all -i inventory.ini -b -m apt -a "name=htop state=present"'], check: t => ['web1', 'web2', 'db1'].every(h => t.pkg(h, 'htop')) && t.events('ansible').some(e => e.module === 'apt' && e.rc !== 0 && !e.become) },
          { title: 'Write `base.yml`: for all hosts, with become, install `htop`, `curl` and `jq` and create a `deploy` user. Run it', solution: 'nano base.yml && ansible-playbook -i inventory.ini base.yml', test: [{ cmd: 'nano base.yml', edit: BASE_YML }, 'ansible-playbook -i inventory.ini base.yml'], check: t => ['web1', 'web2', 'db1'].every(h => t.pkg(h, 'jq') && t.userExists(h, 'deploy')) },
          { title: 'Run the playbook again. Every host should report `changed=0`: that is idempotence', solution: 'ansible-playbook -i inventory.ini base.yml', check: t => allChangedZero(playbookRuns(t, 'base.yml').pop()) && playbookRuns(t, 'base.yml').length >= 2 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does Ansible need on a managed server?', choices: ['An Ansible agent daemon', 'SSH access and Python', 'Docker', 'A Kubernetes node'], answer: 1, explain: 'Agentless: it pushes over SSH.' },
        { type: 'mc', q: 'Why prefer `apt: name=nginx state=present` over `shell: apt-get install -y nginx`?', choices: ['It is shorter', 'The module checks first and reports ok/changed correctly; shell always "changes"', 'shell does not work over SSH', 'apt is faster'], answer: 1, explain: 'Modules make runs idempotent and honest.' },
        { type: 'mc', q: 'A second run of a playbook reports changed=3. What does that suggest?', choices: ['Everything is fine', 'Something is not idempotent (often shell/command tasks or restarts)', 'The servers are down', 'You need -b'], answer: 1, explain: 'A converged system should report changed=0.' },
        { type: 'mc', q: 'An apt task fails with "are you root?". Fix?', choices: ['chmod 777 /var/lib/dpkg', 'Add become: true (or -b)', 'Use the shell module', 'Run as the ubuntu user'], answer: 1, explain: 'become escalates with sudo.' },
        { type: 'tf', q: '`ansible-playbook --check` changes nothing on the servers.', answer: true, explain: 'It predicts; command/shell tasks are skipped unless they support check mode.' },
        { type: 'type', q: 'Type the ad-hoc command that pings every host in `inventory.ini`.', accept: ['ansible all -i inventory.ini -m ping', 'ansible -i inventory.ini all -m ping', 'ansible all -m ping -i inventory.ini'], model: 'ansible all -i inventory.ini -m ping', explain: 'The ping module checks SSH and Python, not ICMP.' },
      ],
    },
    {
      id: 'ansible-playbooks',
      title: 'Templates, handlers and vault',
      summary: 'Jinja2 templates with group_vars, handlers that run only on change, check and diff mode, ansible-vault secrets, ansible-lint.',
      minutes: 35,
      lab: {
        cwd: '~/site',
        panels: ['system', 'files'],
        laptopPackages: ['ansible'],
        setup(H) {
          for (const n of ['web1', 'web2']) { H.server(n); H.authorize('laptop', 'dev', n, 'ubuntu'); }
          H.write('laptop', '~/site/inventory.ini', '[web]\nweb1\nweb2\n\n[web:vars]\nansible_user=ubuntu\n', { owner: 'dev' });
          H.write('laptop', '~/site/templates/index.html.j2', SITE_TPL, { owner: 'dev' });
          H.write('laptop', '~/site/token.txt', 'dpl_7Q2xk9VhP3rTn8\n', { owner: 'dev', mode: 0o600 });
        },
        suggestions: ['cat templates/index.html.j2', 'nano group_vars/web.yml'],
        tasks: [
          { title: 'The template uses `site_title` and a list `events` (each with `name` and `day`). Define them for the `web` group in `group_vars/web.yml`', solution: 'mkdir -p group_vars && nano group_vars/web.yml', test: ['mkdir -p group_vars', { cmd: 'nano group_vars/web.yml', edit: GROUP_VARS() }], check: t => { try { const v = parseYaml(t.file('laptop', '~/site/group_vars/web.yml') || ''); return !!v?.site_title && Array.isArray(v.events) && v.events.every(e => e.name && e.day); } catch { return false; } } },
          { title: 'Write `site.yml`: install nginx, render the template to `/var/www/html/index.html` (mode 0644) notifying a `Reload nginx` handler, keep nginx started. Run it and check web1 serves the page', solution: 'nano site.yml && ansible-playbook -i inventory.ini site.yml && curl -s web1', test: [{ cmd: 'nano site.yml', edit: SITE_YML() }, 'ansible-playbook -i inventory.ini site.yml && curl -s web1'], check: t => /Jazz at the Docks/.test(t.file('web1', '/var/www/html/index.html') || '') && /Jazz at the Docks/.test(t.file('web2', '/var/www/html/index.html') || '') && t.events('http').some(e => e.host === 'laptop' && /web1/.test(e.url) && e.status === 200) },
          { title: 'Add a third event (Stand-up Night, Sunday). Preview with `--check --diff`: what would change, and does the handler run?', solution: 'nano group_vars/web.yml && ansible-playbook -i inventory.ini site.yml --check --diff', test: [{ cmd: 'nano group_vars/web.yml', edit: GROUP_VARS(true) }, 'ansible-playbook -i inventory.ini site.yml --check --diff'], check: t => t.events('ansible-playbook').some(e => e.check && e.diff && e.rc === 0) && !/Stand-up/.test(t.file('web1', '/var/www/html/index.html') || '') },
          { title: 'Now apply it for real and confirm both servers list the new event', solution: 'ansible-playbook -i inventory.ini site.yml && curl -s web2', check: t => /Stand-up/.test(t.file('web1', '/var/www/html/index.html') || '') && /Stand-up/.test(t.file('web2', '/var/www/html/index.html') || '') },
          { title: 'The release job needs a token on every web server. Put `deploy_token` (from `token.txt`) in `secrets.yml`, encrypt it with ansible-vault, use it in the playbook (vars_files, a task writing `/etc/events-token` with mode 0600 and no_log) and run with `--ask-vault-pass`', solution: 'echo "deploy_token: $(cat token.txt)" > secrets.yml && ansible-vault encrypt secrets.yml && nano site.yml && ansible-playbook -i inventory.ini site.yml --ask-vault-pass', test: ['echo "deploy_token: $(cat token.txt)" > secrets.yml', { cmd: 'ansible-vault encrypt secrets.yml', answers: ['events-vault-pw', 'events-vault-pw'] }, { cmd: 'nano site.yml', edit: SITE_YML(true) }, { cmd: 'ansible-playbook -i inventory.ini site.yml --ask-vault-pass', answers: ['events-vault-pw'] }], check: t => /^\$ANSIBLE_VAULT/.test(t.file('laptop', '~/site/secrets.yml') || '') && /dpl_7Q2xk9VhP3rTn8/.test(t.file('web1', '/etc/events-token') || '') && (t.stat('web1', '/etc/events-token')?.mode & 0o777) === 0o600 },
          { title: 'Lint the playbook: `ansible-lint site.yml` must pass', solution: 'ansible-lint site.yml', check: t => t.events('ansible-lint').some(e => e.failures === 0) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'When does a handler run?', choices: ['After every task', 'Once at the end of the play, on hosts where a task that notifies it reported changed', 'Only with --check', 'Before the tasks'], answer: 1, explain: 'That is why config changes reload nginx only when needed.' },
        { type: 'mc', q: 'Where do variables for all hosts in group `web` usually live?', choices: ['In the template', 'group_vars/web.yml', 'host_vars/web.yml', '/etc/ansible.cfg'], answer: 1, explain: 'host_vars/<host>.yml is per host.' },
        { type: 'mc', q: 'What does `--check --diff` show?', choices: ['Lint errors', 'What each task would change, with file diffs, without changing anything', 'The inventory graph', 'Only failed tasks'], answer: 1, explain: 'Great for pull request reviews.' },
        { type: 'multi', q: 'Good secret handling in Ansible:', choices: ['ansible-vault encrypted files in git', 'no_log: true on tasks that handle secrets', 'debug: var=db_password to check it', 'A vault password file outside the repo or a secret manager'], answer: [0, 1, 3], explain: 'Never print secrets.' },
        { type: 'predict', q: 'What does this render to?', code: '{% for e in events %}{{ e.name | upper }} {% endfor %}\n# events: [{name: jazz}, {name: poetry}]', choices: ['JAZZ POETRY ', 'jazz poetry ', '{{ e.name }}', 'an error'], answer: 0, explain: 'Jinja loops and filters.' },
        { type: 'tf', q: 'Using `state: restarted` in a task (instead of a handler) is fine for config changes.', answer: false, explain: 'It restarts the service on every run, even when nothing changed.' },
      ],
    },
    {
      id: 'iac-boss',
      title: 'Boss: Events, rebuilt from code',
      summary: 'Terraform a VPC, security group, key pair and two servers plus a generated inventory; configure them with Ansible; prove idempotence; fix drift; retire the snowflake.',
      minutes: 50,
      boss: true,
      lab: {
        cwd: '~/events-infra',
        panels: ['cloud', 'files'],
        laptopPackages: ['ansible'],
        setup(H) {
          H.cloud();
          legacy(H);
          sshKey(H);
          H.mkdir('laptop', '/home/dev/events-infra', { owner: 'dev' });
          H.write('laptop', '~/events-config/templates/index.html.j2', BOSS_TPL, { owner: 'dev' });
        },
        events(ev, t) {
          const U = t.uni;
          if (U.labData.drifted) return;
          const tfOk = t.events('terraform').some(e => e.sub === 'plan' && e.ok && e.counts && e.counts.add + e.counts.change + e.counts.destroy === 0 && /events-infra$/.test(e.dir));
          const anOk = t.events('ansible-playbook').filter(e => e.stats && !e.check).length >= 2 && allChangedZero(t.events('ansible-playbook').filter(e => e.stats && !e.check).pop());
          if (tfOk && anOk) {
            U.labData.drifted = true;
            const sg = U.cloud.all('aws_security_group').find(g => g.name === 'events-web');
            if (sg) { sg.ingress = [...sg.ingress, { cidr_blocks: ['0.0.0.0/0'], description: '', from_port: 22, protocol: 'tcp', security_groups: [], self: false, to_port: 22 }]; U.cloud.record('update', 'aws_security_group', sg.id, 'console'); }
            t.say('🚨 Security alert: port 22 on events-web was just opened to 0.0.0.0/0 from the console.');
          }
        },
        suggestions: ['aws ec2 describe-instances --output table', 'nano main.tf'],
        tasks: [
          { title: 'Write Terraform in `~/events-infra`: a VPC (10.20.0.0/16) with a public subnet, internet gateway, route table and association; a security group (HTTP from anywhere, SSH from 198.51.100.23/32); a key pair; two Ubuntu `t3.micro` instances in the subnet; and a `local_file` that writes `../events-config/inventory.ini` (group `web`, `ansible_user=ubuntu`). Apply it', hint: 'Without a route to the internet gateway, instances in a new VPC are unreachable. `aws_instance.web[*].public_ip` gives you all the IPs.', solution: 'nano main.tf && terraform init && terraform apply', test: [{ cmd: 'nano main.tf', edit: BOSS_TF }, 'terraform init', { cmd: 'terraform apply', answers: ['yes'] }], check: t => { const vpc = t.cres('aws_vpc', v => !v.is_default)[0]; const is = inst(t, i => /^events-\d$/.test(i.tags?.Name || '')); const inv = t.file('laptop', '~/events-config/inventory.ini') || ''; return !!vpc && is.length === 2 && is.every(i => t.cres('aws_subnet', s => s.id === i.subnet_id && s.vpc_id === vpc.id).length) && is.every(i => inv.includes(i.public_ip)) && /ansible_user\s*=\s*ubuntu/.test(inv) && !openSsh(sgByName(t, 'events-web')); } },
          { title: 'In `~/events-config`, write `site.yml` (become; install nginx; render `templates/index.html.j2` to /var/www/html/index.html with a reload handler; nginx started) and run it against the generated inventory. Both IPs must serve the page', solution: 'cd ~/events-config && nano site.yml && ansible-playbook -i inventory.ini site.yml', test: ['cd ~/events-config', { cmd: 'nano site.yml', edit: BOSS_YML }, 'ansible-playbook -i inventory.ini site.yml'], check: t => { const is = inst(t, i => /^events-\d$/.test(i.tags?.Name || '')); return is.length === 2 && is.every(i => /Built from code/.test(page(t, i.public_ip) || '')); } },
          { title: 'Prove both are converged: a Terraform plan with no changes, and a second Ansible run with `changed=0`', solution: 'ansible-playbook -i inventory.ini site.yml && cd ~/events-infra && terraform plan', test: ['ansible-playbook -i inventory.ini site.yml', 'cd ~/events-infra', 'terraform plan'], check: t => t.events('terraform').some(e => e.sub === 'plan' && e.ok && e.counts && e.counts.add + e.counts.change + e.counts.destroy === 0 && /events-infra$/.test(e.dir)) && allChangedZero(t.events('ansible-playbook').filter(e => e.stats && !e.check).pop()) },
          { title: 'A security alert just fired. Detect the drift with Terraform and put the code back in charge', solution: 'terraform plan && terraform apply', test: ['terraform plan', { cmd: 'terraform apply', answers: ['yes'] }], check: t => !!t.uni.labData.drifted && t.events('terraform').some(e => e.sub === 'plan' && e.drift > 0) && !openSsh(sgByName(t, 'events-web')) },
          { title: 'Finally, retire the snowflake: terminate `web-legacy` with the aws CLI', solution: 'aws ec2 terminate-instances --instance-ids $(aws ec2 describe-instances --filters "Name=tag:Name,Values=web-legacy" --query "Reservations[].Instances[].InstanceId" --output text)', check: t => inst(t, i => i.tags?.Name === 'web-legacy').length === 0 && inst(t, i => /^events-\d$/.test(i.tags?.Name || '')).length === 2 },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the steps of rebuilding an environment from code.', items: ['terraform init', 'terraform plan (review it)', 'terraform apply', 'ansible-playbook against the new hosts', 'Re-run both: no changes'], explain: 'Provision, configure, verify convergence.' },
        { type: 'mc', q: 'New instances in your new VPC time out on every port, although the security group allows them. Likely cause?', choices: ['Wrong AMI', 'No route from the subnet to an internet gateway', 'Ansible is not installed', 'The key pair'], answer: 1, explain: 'A VPC is private until you route it to an internet gateway.' },
        { type: 'mc', q: 'Why generate the Ansible inventory from Terraform?', choices: ['It looks nicer', 'The IPs come from the source of truth, so the two never disagree', 'Ansible cannot read IPs', 'It is required'], answer: 1, explain: 'One source of truth, no copy-paste.' },
        { type: 'multi', q: 'Which prove an environment is fully described by code?', choices: ['terraform plan shows no changes', 'A second Ansible run reports changed=0', 'The console shows green', 'You could destroy and rebuild it from git'], answer: [0, 1, 3], explain: 'Green in the console proves nothing about the code.' },
        { type: 'tf', q: 'After fixing drift with apply, the next step is to find out why it happened.', answer: true, explain: 'Fix the process (access, alerts, review), not just the resource.' },
      ],
    },
  ],
};
