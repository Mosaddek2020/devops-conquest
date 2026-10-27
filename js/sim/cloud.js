// A small AWS-like cloud. Resources are records in an account; some have real effects in
// the simulated world: instances are servers (cloud-init runs their user_data, the key
// pair's public key is authorised for `ubuntu`), security groups filter traffic to them,
// Route 53 records are DNS, S3 buckets hold objects. The `aws` CLI reads and changes it,
// which is also how "someone clicked in the console" drift happens in labs.

import { def } from './registry.js';
import { C } from '../git/world.js';
import { ipMatches } from './net.js';
import { Session } from './session.js';
import { SimError } from './host.js';
import { dirname } from './fsx.js';

const hex = (n, seed) => { let h = 0x811c9dc5 ^ seed; let s = ''; for (let i = 0; i < n; i++) { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; s += (h & 15).toString(16); } return s; };
const INSTANCE_TYPES = { 't3.nano': [512, 2], 't3.micro': [1024, 2], 't3.small': [2048, 2], 't3.medium': [4096, 2], 't3.large': [8192, 2], 'm5.large': [8192, 2], 'm5.xlarge': [16384, 4] };
export const UBUNTU_AMI = 'ami-0a7f1556c36aea1b6';
const AMIS = { [UBUNTU_AMI]: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20241004', 'ami-0f3c9c4c5b1e8b2a1': 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20240927', 'ami-08f9a9c699d2ab3f9': 'al2023-ami-2023.6.20241010.0-kernel-6.1-x86_64' };

export class Cloud {
  constructor(uni, { region = 'eu-west-1', account = '123456789012' } = {}) {
    this.uni = uni; this.region = region; this.account = account;
    this.res = new Map();       // type -> Map(id -> attrs)
    this.seq = 1;
    this.buckets = new Map();   // name -> { objects: Map(key -> {body, size, time}) }
    this.takenBuckets = new Set(['assets', 'backups', 'lumen', 'test', 'my-bucket']);
    this.ipSeq = 20;
    this.log = [];              // CloudTrail-ish: who changed what
    const vpc = this.put('aws_vpc', { cidr_block: '172.31.0.0/16', is_default: true, tags: { Name: 'default' } });
    this.defaultVpc = vpc.id;
    this.defaultSubnet = this.put('aws_subnet', { vpc_id: vpc.id, cidr_block: '172.31.0.0/20', availability_zone: `${region}a`, map_public_ip_on_launch: true, default_for_az: true, tags: {} }).id;
    this.defaultSg = this.put('aws_security_group', { name: 'default', description: 'default VPC security group', vpc_id: vpc.id, ingress: [], egress: [{ from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }], tags: {} }).id;
    uni.cloudFilter = (from, to, port) => this.allows(from, to, port);
  }

  // IAM users and access keys. Off by default: once a lab enables it, the CLI rejects keys that
  // are deactivated, deleted or unknown, and every call lands in the CloudTrail event history.
  enableIam(users) {
    this.iam = { users: new Map() };
    this.trail = this.trail || [];
    for (const [name, keys] of Object.entries(users)) this.iam.users.set(name, { name, created: this.uni.time - 86400 * 400, keys: keys.map(k => ({ id: k.id, secret: k.secret, status: k.status || 'Active', created: k.created ?? this.uni.time - 86400 * 200, lastUsed: null })) });
  }
  iamKey(id) { for (const u of this.iam?.users.values() || []) { const k = u.keys.find(x => x.id === id); if (k) return { ...k, ref: k, user: u.name }; } return null; }
  trailEvent(e) { (this.trail = this.trail || []).push({ id: `${hex(8, this.seq++)}-${hex(4, this.seq)}-4${hex(3, this.seq)}-a${hex(3, this.seq + 1)}-${hex(12, this.seq + 2)}`, time: this.uni.time, region: this.region, ...e }); }

  table(type) { if (!this.res.has(type)) this.res.set(type, new Map()); return this.res.get(type); }
  all(type) { return [...this.table(type).values()]; }
  get(type, id) { return this.table(type).get(id) || null; }
  newId(prefix) { return `${prefix}-0${hex(16, this.seq++)}`; }
  put(type, attrs) {
    const prefixes = { aws_vpc: 'vpc', aws_subnet: 'subnet', aws_security_group: 'sg', aws_instance: 'i', aws_route53_zone: 'Z0', aws_internet_gateway: 'igw', aws_eip: 'eipalloc' };
    const id = attrs.id || (type === 'aws_route53_zone' ? `Z0${hex(18, this.seq++).toUpperCase()}` : this.newId(prefixes[type] || 'r'));
    const a = { ...attrs, id };
    if (['aws_vpc', 'aws_subnet', 'aws_security_group', 'aws_instance'].includes(type)) a.arn = `arn:aws:ec2:${this.region}:${this.account}:${type.replace('aws_', '').replace('security_group', 'security-group')}/${id}`;
    this.table(type).set(id, a);
    return a;
  }
  record(action, type, id, by = 'terraform') { this.log.push({ time: this.uni.time, action, type, id, by }); this.uni.emit({ type: 'cloud-change', action, rtype: type, id, by }); }

  // ---------------------------------------------------------------- networking rules
  sgsOf(host) { return host?.cloudInstance ? (host.cloudInstance.vpc_security_group_ids?.length ? host.cloudInstance.vpc_security_group_ids : [this.defaultSg]) : null; }
  allows(from, to, port) {
    const sgs = this.sgsOf(to);
    if (!sgs) return true;
    if (from === to) return true;
    const src = from.publicIp || from.ip;
    const fromSgs = this.sgsOf(from) || [];
    // outside traffic needs a public IP and, in a custom VPC, a route to an internet gateway
    const inst = to.cloudInstance;
    const subnet = this.get('aws_subnet', inst.subnet_id);
    const vpc = this.get('aws_vpc', subnet?.vpc_id);
    const sameVpc = from.cloudInstance && this.get('aws_subnet', from.cloudInstance.subnet_id)?.vpc_id === subnet?.vpc_id;
    if (!sameVpc) {
      if (to.noPublicIp) return false;
      if (vpc && !vpc.is_default) {
        const assoc = this.all('aws_route_table_association').find(a => a.subnet_id === subnet.id);
        const rt = assoc && this.get('aws_route_table', assoc.route_table_id);
        const igws = this.all('aws_internet_gateway').filter(g => g.vpc_id === vpc.id).map(g => g.id);
        if (!rt || !(rt.route || []).some(r => r.cidr_block === '0.0.0.0/0' && igws.includes(r.gateway_id))) return false;
      }
    }
    for (const id of sgs) {
      const sg = this.get('aws_security_group', id);
      if (!sg) continue;
      for (const r of sg.ingress || []) {
        const proto = String(r.protocol);
        const portOk = proto === '-1' || proto === 'all' || (port === 'icmp' ? proto === 'icmp' : (proto === 'tcp' || proto === '6') && port >= Number(r.from_port) && port <= Number(r.to_port));
        if (!portOk) continue;
        if ((r.cidr_blocks || []).some(cidr => ipMatches(src, cidr))) return true;
        if ((r.security_groups || []).some(g => fromSgs.includes(g))) return true;
        if (r.self && fromSgs.includes(id)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- instances
  launch(attrs) {
    const uni = this.uni;
    const [memMB, cpus] = INSTANCE_TYPES[attrs.instance_type] || [1024, 2];
    if (!INSTANCE_TYPES[attrs.instance_type]) throw new SimError(`api error InvalidParameterValue: Invalid value '${attrs.instance_type}' for InstanceType.`);
    if (!AMIS[attrs.ami]) throw new SimError(`api error InvalidAMIID.NotFound: The image id '[${attrs.ami}]' does not exist`);
    if (attrs.key_name && !this.get('aws_key_pair', attrs.key_name)) throw new SimError(`api error InvalidKeyPair.NotFound: The key pair '${attrs.key_name}' does not exist`);
    for (const sg of attrs.vpc_security_group_ids || []) if (!this.get('aws_security_group', sg)) throw new SimError(`api error InvalidGroup.NotFound: The security group '${sg}' does not exist`);
    const subnet = this.get('aws_subnet', attrs.subnet_id || this.defaultSubnet);
    if (!subnet) throw new SimError(`api error InvalidSubnetID.NotFound: The subnet ID '${attrs.subnet_id}' does not exist`);
    const pubIp = (attrs.associate_public_ip_address ?? subnet.map_public_ip_on_launch) ? `54.${170 + (this.ipSeq >> 8)}.${(this.ipSeq * 37) % 250 + 3}.${(this.ipSeq++ * 53) % 250 + 3}` : null;
    const base = subnet.cidr_block.split('/')[0].split('.').slice(0, 3).join('.');
    const privIp = `${base}.${10 + (this.seq % 200)}`;
    const id = this.newId('i');
    const name = attrs.tags?.Name ? attrs.tags.Name.toLowerCase().replace(/[^a-z0-9-]/g, '-') : `ip-${privIp.replace(/\./g, '-')}`;
    let hostName = name;
    for (let k = 2; uni.hosts.has(hostName); k++) hostName = `${name}-${k}`;
    const host = uni.makeServer(hostName, { ip: pubIp || `10.255.${this.seq % 250}.${(this.seq * 7) % 250 + 2}`, memMB, cpus, user: 'ubuntu' });
    if (!pubIp) host.noPublicIp = true;
    const inst = this.put('aws_instance', { ...attrs, id, subnet_id: subnet.id, availability_zone: subnet.availability_zone, public_ip: pubIp || '', private_ip: privIp, public_dns: pubIp ? `ec2-${pubIp.replace(/\./g, '-')}.${this.region}.compute.amazonaws.com` : '', instance_state: 'running', host: hostName, vpc_security_group_ids: attrs.vpc_security_group_ids?.length ? attrs.vpc_security_group_ids : [this.defaultSg], launched: uni.time });
    host.cloudInstance = inst;
    host.publicIp = pubIp;
    if (pubIp) uni.dns.set(inst.public_dns, pubIp);
    // the key pair becomes ubuntu's authorized key
    if (attrs.key_name) {
      const kp = this.get('aws_key_pair', attrs.key_name);
      host.mkdirMeta('/home/ubuntu/.ssh', 'ubuntu', 0o700);
      host.writeFile('/home/ubuntu/.ssh/authorized_keys', kp.public_key.trim() + '\n', 'ubuntu');
      host.setMeta('/home/ubuntu/.ssh/authorized_keys', { mode: 0o600, owner: 'ubuntu', group: 'ubuntu' });
    } else host.removeFile?.('/home/ubuntu/.ssh/authorized_keys');
    // cloud-init: user_data runs once, as root, at first boot
    const ud = attrs.user_data;
    let out = `Cloud-init v. 24.3.1-0ubuntu0~24.04.2 running 'init' at ${new Date(uni.time * 1000).toUTCString()}.\n`;
    if (ud) {
      host.writeSys('/var/lib/cloud/instance/user-data.txt', ud);
      if (/^#!/.test(ud)) {
        const sh = new Session(uni, host, { user: 'root', cwd: '/' });
        sh.advancePerCommand = 0;
        const mark = uni.events.length;
        const r = sh.run(ud.replace(/^#!.*\n/, ''), { record: false });
        uni.events.length = mark;
        out += r.out.map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n') + '\n';
        if (r.code) out += `Cloud-init v. 24.3.1 finished with errors: script exited with ${r.code}\n`;
      } else if (/^#cloud-config/.test(ud)) out += 'cloud-config processed\n';
    }
    out += `Cloud-init v. 24.3.1-0ubuntu0~24.04.2 finished at ${new Date(uni.time * 1000).toUTCString()}. Up 18.42 seconds\n`;
    host.writeSys('/var/log/cloud-init-output.log', out);
    return inst;
  }
  terminate(id) {
    const inst = this.get('aws_instance', id);
    if (!inst) return;
    const host = this.uni.host(inst.host);
    if (host) { this.uni.hosts.delete(host.name); this.uni.byIp.delete(host.ip); if (this.uni.dns.get(host.name) === host.ip) this.uni.dns.delete(host.name); }
    if (inst.public_dns) this.uni.dns.delete(inst.public_dns);
    this.table('aws_instance').delete(id);
  }
}

// ---------------------------------------------------------------- the aws CLI

function jmes(obj, q) {
  if (!q) return obj;
  const expr = q.replace(/^['"]|['"]$/g, '');
  const steps = expr.split('.').flatMap(p => { const m = p.match(/^([^[]*)((\[[^\]]*\])*)$/); return m ? [m[1], ...(m[2].match(/\[[^\]]*\]/g) || [])].filter(Boolean) : [p]; });
  let cur = obj, projected = false;
  const apply = (v, s) => { if (s === '[]' || s === '[*]') return { flat: true, v: Array.isArray(v) ? v : [] }; const ms = s.match(/^\[([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)+)\]$/); if (ms) return { v: v == null ? undefined : ms[1].split(',').map(f => jmes(v, f.trim())) }; const n = s.match(/^\[(-?\d+)\]$/); if (n) return { v: Array.isArray(v) ? v.at(Number(n[1])) : undefined }; const f = s.match(/^\[\?(\w+)\s*==\s*[`']([^`']*)[`']\]$/); if (f) return { flat: true, v: (Array.isArray(v) ? v : []).filter(x => String(x?.[f[1]]) === f[2]) }; return { v: v?.[s] }; };
  for (const s of steps) {
    if (projected) { const out = []; for (const item of cur) { const r = apply(item, s); if (r.flat) out.push(...r.v); else if (r.v !== undefined) out.push(r.v); } cur = out; }
    else { const r = apply(cur, s); cur = r.v; if (r.flat) projected = true; }
  }
  return cur;
}
const tagList = tags => Object.entries(tags || {}).map(([Key, Value]) => ({ Key, Value }));
function printOut(c, data, output) {
  if (output === 'text') { const flat = v => Array.isArray(v) ? v.map(flat).join('\t') : v && typeof v === 'object' ? Object.values(v).map(flat).join('\t') : String(v ?? 'None'); c.print(Array.isArray(data) && data.some(Array.isArray) ? data.map(flat).join('\n') : flat(data)); return; }
  if (output === 'table') { c.print(JSON.stringify(data, null, 2)); return; }
  c.print(...JSON.stringify(data ?? null, null, 4).split('\n'));
}

def('aws', c => {
  const a = [...c.args];
  const flags = {};
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); if (k.includes('=')) { flags[k.split('=')[0]] = k.split('=').slice(1).join('='); continue; } const nxt = a[i + 1]; if (nxt === undefined || nxt.startsWith('--')) flags[k] = true; else { const vals = []; while (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) vals.push(a[++i]); flags[k] = vals.length > 1 ? vals : vals[0]; } }
    else pos.push(a[i]);
  }
  const [svc, op, ...rest] = pos;
  const cloud = c.uni.cloud;
  if (!svc || svc === 'help') { c.print('usage: aws [options] <command> <subcommand> [parameters]', '', 'Commands: ec2, s3, route53, sts, iam, cloudtrail, configure'); return 0; }
  if (svc === '--version' || flags.version) { c.print('aws-cli/2.18.12 Python/3.12.6 Linux/6.8.0 exe/x86_64.ubuntu.24'); return 0; }
  const credFile = `${c.host.users.get(c.user)?.home}/.aws/credentials`;
  const hasCreds = c.host.files.has(credFile) || (c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY);
  if (svc === 'configure') {
    if (op === 'set' || op === 'get') {
      const key = rest[0];
      const file = /region|output/.test(key || '') ? credFile.replace(/credentials$/, 'config') : credFile;
      const text = c.host.files.get(file) || '';
      if (op === 'get') { const m = text.match(new RegExp(`^${key}\\s*=\\s*(\\S+)`, 'm')); if (!m) return 1; c.print(m[1]); return 0; }
      if (!key || rest[1] === undefined) return c.fail('usage: aws configure set varname value', 252);
      const line = `${key} = ${rest[1]}`;
      const next = new RegExp(`^${key}\\s*=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}\\s*=.*$`, 'm'), line) : (text.includes('[default]') ? text.replace('[default]\n', `[default]\n${line}\n`) : `[default]\n${line}\n${text}`);
      c.host.mkdirMeta(dirname(file), c.user, 0o700);
      c.host.writeFile(file, next, c.user);
      if (/credentials$/.test(file)) c.host.setMeta(file, { mode: 0o600 });
      return 0;
    }
    if (op === 'list') { c.print('      Name                    Value             Type    Location', '      ----                    -----             ----    --------', `   profile                <not set>             None    None`, `access_key     ${hasCreds ? '****************QX7A shared-credentials-file' : '<not set>             None    None'}`, `secret_key     ${hasCreds ? '****************h3Kd shared-credentials-file' : '<not set>             None    None'}`, `    region                ${cloud?.region || '<not set>'}      config-file    ~/.aws/config`); return 0; }
    return c.fail('aws configure is interactive; in the lab your credentials are already in ~/.aws/credentials', 1);
  }
  if (!cloud) return c.fail('Could not connect to the endpoint URL: "https://sts.eu-west-1.amazonaws.com/"', 255);
  if (!hasCreds) return c.fail('\nUnable to locate credentials. You can configure credentials by running "aws configure".', 253);
  const out = flags.output || 'json';
  const show = data => { printOut(c, flags.query ? jmes(data, flags.query) : data, out); return 0; };
  const by = 'console';
  const opName = svc === 's3' ? ({ ls: rest.length ? 'ListObjectsV2' : 'ListBuckets', cp: 'PutObject', mb: 'CreateBucket', rb: 'DeleteBucket', rm: 'DeleteObject' })[op] || 'ListBuckets' : String(op || '').split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join('');
  let caller = 'dev';
  if (cloud.iam) {
    const keyId = c.env.AWS_ACCESS_KEY_ID || (c.host.files.get(credFile) || '').match(/aws_access_key_id\s*=\s*(\S+)/)?.[1];
    const k = cloud.iamKey(keyId);
    if (!k || k.status !== 'Active') return c.fail(`\nAn error occurred (InvalidClientTokenId) when calling the ${opName} operation: The security token included in the request is invalid.`, 254);
    caller = k.user;
    k.ref.lastUsed = { time: c.uni.time, service: svc, region: flags.region || cloud.region };
    cloud.trailEvent({ name: opName, source: `${svc === 's3' ? 's3' : svc}.amazonaws.com`, user: k.user, key: k.id, ip: c.host.publicIp || '198.51.100.23', region: flags.region || cloud.region, readOnly: /^(describe|list|get|lookup|ls)/.test(op || ''), resources: [].concat(flags['instance-ids'] || [], flags['access-key-id'] || []) });
  }
  const region = flags.region || cloud.region;
  const inRegion = i => (i.region || cloud.region) === region;
  if (svc === 'sts' && op === 'get-caller-identity') return show({ UserId: 'AIDAZ3EXAMPLE7QX7A', Account: cloud.account, Arn: `arn:aws:iam::${cloud.account}:user/${caller}` });
  if (svc === 'iam' && cloud.iam) {
    const uname = flags['user-name'] || caller;
    const u = cloud.iam.users.get(uname);
    if (!u && op !== 'list-users') return c.fail(`\nAn error occurred (NoSuchEntity) when calling the ${opName} operation: The user with name ${uname} cannot be found.`, 254);
    const iso = t => new Date(t * 1000).toISOString().replace('.000Z', '+00:00');
    const findKey = () => { const k = u.keys.find(x => x.id === flags['access-key-id']); if (!k) c.eprint(`\nAn error occurred (NoSuchEntity) when calling the ${opName} operation: The Access Key with id ${flags['access-key-id']} cannot be found.`); return k; };
    switch (op) {
      case 'list-users': return show({ Users: [...cloud.iam.users.values()].map(x => ({ Path: '/', UserName: x.name, UserId: 'AIDA' + hex(16, x.name.length * 977).toUpperCase(), Arn: `arn:aws:iam::${cloud.account}:user/${x.name}`, CreateDate: iso(x.created) })) });
      case 'list-access-keys': return show({ AccessKeyMetadata: u.keys.map(k => ({ UserName: u.name, AccessKeyId: k.id, Status: k.status, CreateDate: iso(k.created) })) });
      case 'create-access-key': {
        if (u.keys.length >= 2) return c.fail(`\nAn error occurred (LimitExceeded) when calling the CreateAccessKey operation: Cannot exceed quota for AccessKeysPerUser: 2`, 254);
        const n = (cloud.keySeq = (cloud.keySeq || 0) + 1);
        const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const id = 'AKIA' + Array.from({ length: 16 }, (_, i) => alpha[(n * 131 + i * 17 + u.name.length * 7 + i * i) % 32]).join('');
        const secret = btoa(`lumen-${u.name}-${n}-${c.uni.time}-secret-key-material`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
        const k = { id, secret, status: 'Active', created: c.uni.time, lastUsed: null };
        u.keys.push(k);
        c.uni.emit({ type: 'iam', op: 'create-key', user: u.name, key: id });
        return show({ AccessKey: { UserName: u.name, AccessKeyId: id, Status: 'Active', SecretAccessKey: secret, CreateDate: iso(k.created) } });
      }
      case 'update-access-key': {
        const k = findKey(); if (!k) return 254;
        const st = String(flags.status || '');
        if (!['Active', 'Inactive'].includes(st)) return c.fail(`\nAn error occurred (ValidationError) when calling the UpdateAccessKey operation: 1 validation error detected: Value '${st}' at 'status' failed to satisfy constraint: Member must satisfy enum value set: [Active, Inactive]`, 254);
        k.status = st;
        c.uni.emit({ type: 'iam', op: 'update-key', user: u.name, key: k.id, status: st });
        return 0;
      }
      case 'delete-access-key': {
        const k = findKey(); if (!k) return 254;
        u.keys = u.keys.filter(x => x !== k);
        c.uni.emit({ type: 'iam', op: 'delete-key', user: u.name, key: k.id });
        return 0;
      }
      case 'get-access-key-last-used': {
        const k = cloud.iamKey(flags['access-key-id']);
        if (!k) return c.fail(`\nAn error occurred (AccessDenied) when calling the GetAccessKeyLastUsed operation: Access key ${flags['access-key-id']} does not exist`, 254);
        return show({ UserName: k.user, AccessKeyLastUsed: k.lastUsed ? { LastUsedDate: iso(k.lastUsed.time), ServiceName: k.lastUsed.service, Region: k.lastUsed.region } : { ServiceName: 'N/A', Region: 'N/A' } });
      }
    }
    return c.fail(`\naws: error: argument operation: Invalid choice: '${op}'`, 252);
  }
  if (svc === 'cloudtrail' && op === 'lookup-events') {
    let ev = [...(cloud.trail || [])].reverse();
    const attr = String(flags['lookup-attributes'] || '');
    const m = attr.match(/AttributeKey=(\w+),AttributeValue=(.+)/);
    if (m) ev = ev.filter(e => ({ AccessKeyId: e.key, Username: e.user, EventName: e.name, EventSource: e.source, ReadOnly: String(e.readOnly), ResourceName: (e.resources || []).join(' ') })[m[1]]?.includes(m[2]));
    if (flags['max-results']) ev = ev.slice(0, Number(flags['max-results']));
    c.uni.emit({ type: 'cloudtrail', filter: attr, count: ev.length });
    return show({ Events: ev.map(e => ({ EventId: e.id, EventName: e.name, ReadOnly: String(!!e.readOnly), AccessKeyId: e.key, EventTime: new Date(e.time * 1000).toISOString().replace('.000Z', '+00:00'), EventSource: e.source, Username: e.user, Resources: (e.resources || []).map(r => ({ ResourceType: /^i-/.test(r) ? 'AWS::EC2::Instance' : /^AKIA/.test(r) ? 'AWS::IAM::AccessKey' : 'AWS::Resource', ResourceName: r })), CloudTrailEvent: JSON.stringify({ eventVersion: '1.09', userIdentity: { type: 'IAMUser', userName: e.user, accessKeyId: e.key }, eventTime: new Date(e.time * 1000).toISOString(), eventSource: e.source, eventName: e.name, awsRegion: e.region, sourceIPAddress: e.ip, userAgent: e.agent || 'aws-cli/2.18.12' }) })) });
  }
  if (svc === 'ec2') {
    const ids = [].concat(flags['instance-ids'] || []);
    switch (op) {
      case 'describe-instances': {
        let list = cloud.all('aws_instance').filter(inRegion);
        if (ids.length) list = list.filter(i => ids.includes(i.id));
        for (const f of [].concat(flags.filters || [])) { const m = String(f).match(/Name=([^,]+),Values=(.+)/); if (!m) continue; const vals = m[2].split(','); list = list.filter(i => m[1].startsWith('tag:') ? vals.includes(i.tags?.[m[1].slice(4)]) : m[1] === 'instance-state-name' ? vals.includes(i.instance_state) : true); }
        return show({ Reservations: list.map(i => ({ ReservationId: 'r-0' + i.id.slice(3), OwnerId: cloud.account, Instances: [{ InstanceId: i.id, ImageId: i.ami, InstanceType: i.instance_type, KeyName: i.key_name, LaunchTime: new Date(i.launched * 1000).toISOString(), State: { Code: 16, Name: i.instance_state }, PrivateIpAddress: i.private_ip, PublicIpAddress: i.public_ip || undefined, PublicDnsName: i.public_dns, SubnetId: i.subnet_id, VpcId: cloud.get('aws_subnet', i.subnet_id)?.vpc_id, SecurityGroups: (i.vpc_security_group_ids || []).map(g => ({ GroupId: g, GroupName: cloud.get('aws_security_group', g)?.name })), Tags: tagList(i.tags) }] })) });
      }
      case 'describe-security-groups': {
        let list = cloud.all('aws_security_group');
        const gids = [].concat(flags['group-ids'] || []);
        if (gids.length) list = list.filter(g => gids.includes(g.id));
        return show({ SecurityGroups: list.map(g => ({ GroupId: g.id, GroupName: g.name, Description: g.description, VpcId: g.vpc_id, IpPermissions: (g.ingress || []).map(r => ({ IpProtocol: String(r.protocol), FromPort: r.from_port, ToPort: r.to_port, IpRanges: (r.cidr_blocks || []).map(x => ({ CidrIp: x, Description: r.description })) })), Tags: tagList(g.tags) })) });
      }
      case 'describe-vpcs': return show({ Vpcs: cloud.all('aws_vpc').map(v => ({ VpcId: v.id, CidrBlock: v.cidr_block, IsDefault: !!v.is_default, Tags: tagList(v.tags) })) });
      case 'describe-subnets': return show({ Subnets: cloud.all('aws_subnet').map(s => ({ SubnetId: s.id, VpcId: s.vpc_id, CidrBlock: s.cidr_block, AvailabilityZone: s.availability_zone, MapPublicIpOnLaunch: !!s.map_public_ip_on_launch, Tags: tagList(s.tags) })) });
      case 'describe-images': return show({ Images: Object.entries(AMIS).map(([ImageId, Name]) => ({ ImageId, Name, OwnerId: Name.startsWith('ubuntu') ? '099720109477' : '137112412989', State: 'available' })) });
      case 'describe-key-pairs': return show({ KeyPairs: cloud.all('aws_key_pair').map(k => ({ KeyName: k.id, KeyFingerprint: k.fingerprint, KeyType: 'ed25519' })) });
      case 'terminate-instances': {
        const r = [];
        for (const id of ids) { const i = cloud.get('aws_instance', id); if (!i || !inRegion(i)) return c.fail(`\nAn error occurred (InvalidInstanceID.NotFound) when calling the TerminateInstances operation: The instance ID '${id}' does not exist`, 254); cloud.terminate(id); cloud.record('delete', 'aws_instance', id, by); r.push({ InstanceId: id, CurrentState: { Code: 32, Name: 'shutting-down' }, PreviousState: { Code: 16, Name: 'running' } }); }
        return show({ TerminatingInstances: r });
      }
      case 'stop-instances': case 'start-instances': {
        for (const id of ids) { const i = cloud.get('aws_instance', id); if (!i) return c.fail(`An error occurred (InvalidInstanceID.NotFound)`, 254); i.instance_state = op === 'stop-instances' ? 'stopped' : 'running'; const h = c.uni.host(i.host); if (h) h.down = op === 'stop-instances'; cloud.record('update', 'aws_instance', id, by); }
        return show({ [op === 'stop-instances' ? 'StoppingInstances' : 'StartingInstances']: ids.map(id => ({ InstanceId: id })) });
      }
      case 'create-tags': {
        const rids = [].concat(flags.resources || []);
        const tags = Object.fromEntries([].concat(flags.tags || []).map(t => { const m = String(t).match(/Key=([^,]+),Value=(.*)/); return m ? [m[1], m[2]] : null; }).filter(Boolean));
        for (const id of rids) for (const t of ['aws_instance', 'aws_security_group', 'aws_vpc', 'aws_subnet']) { const r = cloud.get(t, id); if (r) { r.tags = { ...(r.tags || {}), ...tags }; cloud.record('update', t, id, by); } }
        return 0;
      }
      case 'modify-instance-attribute': {
        const i = cloud.get('aws_instance', flags['instance-id']);
        if (!i) return c.fail('An error occurred (InvalidInstanceID.NotFound)', 254);
        if (flags['instance-type']) { i.instance_type = String(flags['instance-type']).replace(/^Value=/, ''); const h = c.uni.host(i.host); if (h) h.memMB = (INSTANCE_TYPES[i.instance_type] || [h.memMB])[0]; }
        if (flags.groups) i.vpc_security_group_ids = [].concat(flags.groups);
        cloud.record('update', 'aws_instance', i.id, by);
        return 0;
      }
      case 'authorize-security-group-ingress': case 'revoke-security-group-ingress': {
        const g = cloud.get('aws_security_group', flags['group-id']);
        if (!g) return c.fail(`\nAn error occurred (InvalidGroup.NotFound) when calling the ${op === 'authorize-security-group-ingress' ? 'AuthorizeSecurityGroupIngress' : 'RevokeSecurityGroupIngress'} operation: The security group '${flags['group-id']}' does not exist`, 254);
        const port = Number(flags.port);
        const rule = { cidr_blocks: [flags.cidr || '0.0.0.0/0'], description: '', from_port: port, protocol: flags.protocol || 'tcp', security_groups: [], self: false, to_port: port };
        if (op === 'authorize-security-group-ingress') { if ((g.ingress || []).some(r => r.from_port === port && r.cidr_blocks.includes(rule.cidr_blocks[0]))) return c.fail(`\nAn error occurred (InvalidPermission.Duplicate) when calling the AuthorizeSecurityGroupIngress operation: the specified rule "peer: ${rule.cidr_blocks[0]}, TCP, from port: ${port}, to port: ${port}, ALLOW" already exists`, 254); g.ingress = [...(g.ingress || []), rule]; }
        else g.ingress = (g.ingress || []).filter(r => !(r.from_port === port && r.cidr_blocks.includes(rule.cidr_blocks[0])));
        cloud.record('update', 'aws_security_group', g.id, by);
        return show({ Return: true });
      }
    }
    return c.fail(`\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: argument operation: Invalid choice: '${op}'`, 252);
  }
  if (svc === 's3') {
    const parse = u => { const m = String(u || '').match(/^s3:\/\/([^/]+)\/?(.*)$/); return m ? { bucket: m[1], key: m[2] } : null; };
    switch (op) {
      case 'ls': {
        const t = parse(rest[0]);
        if (!t) { for (const b of cloud.all('aws_s3_bucket')) c.print(`${new Date(b.created * 1000).toISOString().replace('T', ' ').slice(0, 19)} ${b.bucket}`); return 0; }
        const b = cloud.buckets.get(t.bucket);
        if (!b) return c.fail('\nAn error occurred (NoSuchBucket) when calling the ListObjectsV2 operation: The specified bucket does not exist', 254);
        for (const [k, o] of b.objects) if (k.startsWith(t.key)) c.print(`${new Date(o.time * 1000).toISOString().replace('T', ' ').slice(0, 19)} ${String(o.size).padStart(10)} ${k}`);
        return 0;
      }
      case 'mb': {
        const t = parse(rest[0]);
        if (cloud.takenBuckets.has(t.bucket) || cloud.buckets.has(t.bucket)) return c.fail(`make_bucket failed: s3://${t.bucket} An error occurred (BucketAlreadyExists) when calling the CreateBucket operation: The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.`, 1);
        cloud.put('aws_s3_bucket', { id: t.bucket, bucket: t.bucket, arn: `arn:aws:s3:::${t.bucket}`, created: c.uni.time, tags: {}, force_destroy: false });
        cloud.buckets.set(t.bucket, { objects: new Map() });
        cloud.record('create', 'aws_s3_bucket', t.bucket, by);
        c.print(`make_bucket: ${t.bucket}`);
        return 0;
      }
      case 'cp': {
        const [src, dst] = rest;
        const d = parse(dst), s = parse(src);
        if (d) {
          const b = cloud.buckets.get(d.bucket);
          if (!b) return c.fail(`upload failed: ${src} to ${dst} An error occurred (NoSuchBucket) when calling the PutObject operation: The specified bucket does not exist`, 1);
          const body = c.host.files.get(c.resolve(src));
          if (body === undefined) return c.fail(`\nThe user-provided path ${src} does not exist.`, 255);
          const key = !d.key || d.key.endsWith('/') ? d.key + src.split('/').pop() : d.key;
          b.objects.set(key, { body, size: body.length, time: c.uni.time });
          c.print(`upload: ${src} to s3://${d.bucket}/${key}`);
          return 0;
        }
        if (s) {
          const o = cloud.buckets.get(s.bucket)?.objects.get(s.key);
          if (!o) return c.fail(`fatal error: An error occurred (404) when calling the HeadObject operation: Key "${s.key}" does not exist`, 1);
          const p = c.resolve(dst === '.' ? s.key.split('/').pop() : dst);
          c.host.writeFile(p, o.body, c.user);
          c.print(`download: ${src} to ${dst}`);
          return 0;
        }
        return c.fail('usage: aws s3 cp <LocalPath> <S3Uri> or <S3Uri> <LocalPath>', 252);
      }
      case 'rm': { const t = parse(rest[0]); cloud.buckets.get(t?.bucket)?.objects.delete(t.key); c.print(`delete: ${rest[0]}`); return 0; }
      case 'rb': {
        const t = parse(rest[0]);
        const b = cloud.buckets.get(t?.bucket);
        if (!b) return c.fail('remove_bucket failed: NoSuchBucket', 1);
        if (b.objects.size && !flags.force) return c.fail(`remove_bucket failed: s3://${t.bucket} An error occurred (BucketNotEmpty) when calling the DeleteBucket operation: The bucket you tried to delete is not empty`, 1);
        cloud.buckets.delete(t.bucket); cloud.table('aws_s3_bucket').delete(t.bucket); cloud.record('delete', 'aws_s3_bucket', t.bucket, by);
        c.print(`remove_bucket: ${t.bucket}`);
        return 0;
      }
    }
    return c.fail(`aws s3: unknown command ${op}`, 252);
  }
  if (svc === 'route53') {
    if (op === 'list-hosted-zones') return show({ HostedZones: cloud.all('aws_route53_zone').map(z => ({ Id: `/hostedzone/${z.id}`, Name: z.name + '.', ResourceRecordSetCount: cloud.all('aws_route53_record').filter(r => r.zone_id === z.id).length + 2 })) });
    if (op === 'list-resource-record-sets') return show({ ResourceRecordSets: cloud.all('aws_route53_record').filter(r => !flags['hosted-zone-id'] || r.zone_id === String(flags['hosted-zone-id']).replace('/hostedzone/', '')).map(r => ({ Name: r.name + '.', Type: r.type, TTL: r.ttl, ResourceRecords: (r.records || []).map(Value => ({ Value })) })) });
  }
  return c.fail(`\naws: error: argument command: Invalid choice: '${svc} ${op || ''}'`, 252);
}, { pkg: 'awscli' });

export function installCloud(uni, opts) {
  uni.cloud = new Cloud(uni, opts);
  return uni.cloud;
}
export { INSTANCE_TYPES, AMIS };
