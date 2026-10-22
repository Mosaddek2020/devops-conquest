// Terraform provider schemas for the simulated cloud: which arguments each resource type
// takes, which ones force replacement, what is computed, and how create/read/update/delete
// map onto the Cloud (js/sim/cloud.js), the random provider and the local filesystem.

import { SimError } from './host.js';
import { UBUNTU_AMI, AMIS } from './cloud.js';
import { fakeHash } from './hcl.js';
import { ipMatches } from './net.js';

const A = (o = {}) => ({ type: 'string', ...o });   // argument spec
const rule = { from_port: A({ type: 'number', req: true }), to_port: A({ type: 'number', req: true }), protocol: A({ req: true }), cidr_blocks: A({ type: 'list', def: [] }), security_groups: A({ type: 'list', def: [] }), self: A({ type: 'bool', def: false }), description: A({ def: '' }) };
const WORDS = ['lucky', 'brave', 'calm', 'eager', 'gentle', 'happy', 'jolly', 'keen', 'lively', 'proud', 'quick', 'witty'];
const ANIMALS = ['otter', 'falcon', 'badger', 'lynx', 'heron', 'marmot', 'gecko', 'ibex', 'puffin', 'koala', 'mole', 'wren'];
let rnd = 3;
const next = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd; };

export const SCHEMAS = {
  aws_vpc: {
    args: { cidr_block: A({ req: true, force: true }), enable_dns_hostnames: A({ type: 'bool', def: false }), enable_dns_support: A({ type: 'bool', def: true }), tags: A({ type: 'map', def: {} }) },
    computed: ['id', 'arn', 'default_security_group_id', 'main_route_table_id', 'owner_id'],
    times: [3, 2, 2],
    create(cloud, a) { if (!/^\d+\.\d+\.\d+\.\d+\/(1[6-9]|2[0-8])$/.test(a.cidr_block)) throw new SimError(`creating EC2 VPC: operation error EC2: CreateVpc, api error InvalidVpc.Range: The CIDR '${a.cidr_block}' is invalid.`); const v = cloud.put('aws_vpc', { ...a }); v.owner_id = cloud.account; v.main_route_table_id = cloud.newId('rtb'); v.default_security_group_id = cloud.newId('sg'); return v; },
  },
  aws_subnet: {
    args: { vpc_id: A({ req: true, force: true }), cidr_block: A({ req: true, force: true }), availability_zone: A({ force: true, computedDef: true }), map_public_ip_on_launch: A({ type: 'bool', def: false }), tags: A({ type: 'map', def: {} }) },
    computed: ['id', 'arn', 'availability_zone', 'owner_id'],
    times: [2, 2, 1],
    create(cloud, a) {
      const vpc = cloud.get('aws_vpc', a.vpc_id);
      if (!vpc) throw new SimError(`creating EC2 Subnet: operation error EC2: CreateSubnet, api error InvalidVpcID.NotFound: The vpc ID '${a.vpc_id}' does not exist`);
      if (!ipMatches(a.cidr_block.split('/')[0], vpc.cidr_block) || Number(a.cidr_block.split('/')[1]) < Number(vpc.cidr_block.split('/')[1])) throw new SimError(`creating EC2 Subnet: operation error EC2: CreateSubnet, api error InvalidSubnet.Range: The CIDR '${a.cidr_block}' is invalid.`);
      for (const s of cloud.all('aws_subnet')) if (s.vpc_id === a.vpc_id && (ipMatches(a.cidr_block.split('/')[0], s.cidr_block) || ipMatches(s.cidr_block.split('/')[0], a.cidr_block))) throw new SimError(`creating EC2 Subnet: operation error EC2: CreateSubnet, api error InvalidSubnet.Conflict: The CIDR '${a.cidr_block}' conflicts with another subnet`);
      return cloud.put('aws_subnet', { ...a, availability_zone: a.availability_zone || `${cloud.region}a`, owner_id: cloud.account });
    },
  },
  aws_internet_gateway: {
    args: { vpc_id: A({ req: false }), tags: A({ type: 'map', def: {} }) },
    computed: ['id', 'arn', 'owner_id'],
    times: [2, 1, 2],
    create(cloud, a) { return cloud.put('aws_internet_gateway', { ...a, owner_id: cloud.account }); },
  },
  aws_route_table: {
    args: { vpc_id: A({ req: true, force: true }), tags: A({ type: 'map', def: {} }) },
    blocks: { route: { cidr_block: A({}), gateway_id: A({ def: '' }) } },
    computed: ['id', 'arn', 'owner_id'],
    times: [2, 1, 1],
    create(cloud, a) { return cloud.put('aws_route_table', { ...a, id: cloud.newId('rtb'), owner_id: cloud.account }); },
  },
  aws_route_table_association: {
    args: { subnet_id: A({ req: true, force: true }), route_table_id: A({ req: true }) },
    computed: ['id'],
    times: [1, 1, 1],
    create(cloud, a) { return cloud.put('aws_route_table_association', { ...a, id: cloud.newId('rtbassoc') }); },
  },
  aws_security_group: {
    args: { name: A({ force: true, computedDef: true }), name_prefix: A({ force: true }), description: A({ force: true, def: 'Managed by Terraform' }), vpc_id: A({ force: true, computedDef: true }), tags: A({ type: 'map', def: {} }) },
    blocks: { ingress: rule, egress: rule },
    computed: ['id', 'arn', 'owner_id', 'name', 'vpc_id'],
    times: [3, 2, 2],
    create(cloud, a) {
      const vpc = a.vpc_id || cloud.defaultVpc;
      const name = a.name || `${a.name_prefix || 'terraform-'}${fakeHash(String(next()), 26)}`;
      if (cloud.all('aws_security_group').some(g => g.name === name && g.vpc_id === vpc)) throw new SimError(`creating Security Group (${name}): operation error EC2: CreateSecurityGroup, api error InvalidGroup.Duplicate: The security group '${name}' already exists for VPC '${vpc}'`);
      return cloud.put('aws_security_group', { ...a, name, vpc_id: vpc, owner_id: cloud.account, ingress: a.ingress || [], egress: a.egress || [] });
    },
    del(cloud, id) {
      const users = cloud.all('aws_instance').filter(i => (i.vpc_security_group_ids || []).includes(id));
      if (users.length) throw new SimError(`deleting Security Group (${id}): operation error EC2: DeleteSecurityGroup, api error DependencyViolation: resource ${id} has a dependent object`);
      cloud.table('aws_security_group').delete(id);
    },
  },
  aws_key_pair: {
    args: { key_name: A({ req: true, force: true }), public_key: A({ req: true, force: true }), tags: A({ type: 'map', def: {} }) },
    computed: ['id', 'arn', 'fingerprint', 'key_type'],
    times: [1, 1, 1],
    create(cloud, a) {
      if (cloud.get('aws_key_pair', a.key_name)) throw new SimError(`importing EC2 Key Pair (${a.key_name}): operation error EC2: ImportKeyPair, api error InvalidKeyPair.Duplicate: The keypair already exists`);
      if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) \S+/.test(String(a.public_key).trim())) throw new SimError(`importing EC2 Key Pair (${a.key_name}): operation error EC2: ImportKeyPair, api error InvalidKey.Format: Key is not in valid OpenSSH public key format`);
      return cloud.put('aws_key_pair', { ...a, id: a.key_name, arn: `arn:aws:ec2:${cloud.region}:${cloud.account}:key-pair/${a.key_name}`, fingerprint: fakeHash(a.public_key, 43).replace(/(.{2})/g, '$1').slice(0, 43) + '=', key_type: a.public_key.startsWith('ssh-rsa') ? 'rsa' : 'ed25519' });
    },
  },
  aws_instance: {
    args: { ami: A({ req: true, force: true }), instance_type: A({ req: true }), subnet_id: A({ force: true, computedDef: true }), vpc_security_group_ids: A({ type: 'set', computedDef: true }), key_name: A({ force: true, def: '' }), user_data: A({ def: null, hashed: true }), user_data_replace_on_change: A({ type: 'bool', def: false }), associate_public_ip_address: A({ type: 'bool', force: true, computedDef: true }), tags: A({ type: 'map', def: {} }) },
    computed: ['id', 'arn', 'public_ip', 'private_ip', 'public_dns', 'instance_state', 'availability_zone', 'subnet_id', 'vpc_security_group_ids', 'associate_public_ip_address'],
    times: [32, 12, 41],
    forceIf: (changed, a) => changed.includes('user_data') && a.user_data_replace_on_change ? ['user_data'] : [],
    create(cloud, a) { const i = cloud.launch({ ...a, key_name: a.key_name || undefined }); return { ...i, associate_public_ip_address: !!i.public_ip }; },
    read(cloud, id) { const i = cloud.get('aws_instance', id); return i ? { ...i, associate_public_ip_address: !!i.public_ip } : null; },
    update(cloud, id, a, changed) {
      const i = cloud.get('aws_instance', id);
      for (const k of changed) i[k] = a[k];
      if (changed.includes('vpc_security_group_ids') && (!a.vpc_security_group_ids || !a.vpc_security_group_ids.length)) i.vpc_security_group_ids = [cloud.defaultSg];
      const h = cloud.uni.host(i.host);
      if (h && changed.includes('instance_type')) h.memMB = ({ 't3.nano': 512, 't3.micro': 1024, 't3.small': 2048, 't3.medium': 4096, 't3.large': 8192 })[a.instance_type] || h.memMB;
      return { ...i, associate_public_ip_address: !!i.public_ip };
    },
    del(cloud, id) { cloud.terminate(id); },
  },
  aws_s3_bucket: {
    args: { bucket: A({ force: true, computedDef: true }), bucket_prefix: A({ force: true }), force_destroy: A({ type: 'bool', def: false }), tags: A({ type: 'map', def: {} }) },
    computed: ['id', 'arn', 'bucket', 'bucket_domain_name', 'region'],
    times: [2, 1, 1],
    create(cloud, a) {
      const name = a.bucket || `${a.bucket_prefix || 'terraform-'}${fakeHash(String(next()), 26)}`;
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) throw new SimError(`validating S3 Bucket (${name}) name: only lowercase alphanumeric characters and hyphens allowed in "${name}"`);
      if (cloud.takenBuckets.has(name) || cloud.buckets.has(name)) throw new SimError(`creating S3 Bucket (${name}): operation error S3: CreateBucket, https response error StatusCode: 409, api error BucketAlreadyExists: The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.`);
      cloud.buckets.set(name, { objects: new Map() });
      return cloud.put('aws_s3_bucket', { ...a, id: name, bucket: name, arn: `arn:aws:s3:::${name}`, bucket_domain_name: `${name}.s3.amazonaws.com`, region: cloud.region, created: cloud.uni.time });
    },
    read(cloud, id) { const b = cloud.get('aws_s3_bucket', id); return b ? { ...b } : null; },
    del(cloud, id, a) {
      const b = cloud.buckets.get(id);
      if (b && b.objects.size && !a.force_destroy) throw new SimError(`deleting S3 Bucket (${id}): operation error S3: DeleteBucket, https response error StatusCode: 409, api error BucketNotEmpty: The bucket you tried to delete is not empty`);
      cloud.buckets.delete(id); cloud.table('aws_s3_bucket').delete(id);
    },
  },
  aws_s3_object: {
    args: { bucket: A({ req: true, force: true }), key: A({ req: true, force: true }), content: A({ def: null }), source: A({ def: null }), content_type: A({ computedDef: true }), tags: A({ type: 'map', def: {} }) },
    computed: ['id', 'etag', 'content_type'],
    times: [1, 1, 1],
    create(cloud, a, env) {
      const b = cloud.buckets.get(a.bucket);
      if (!b) throw new SimError(`uploading S3 Object (${a.key}) to Bucket (${a.bucket}): operation error S3: PutObject, api error NoSuchBucket: The specified bucket does not exist`);
      const body = a.content ?? env.readFile(a.source);
      b.objects.set(a.key, { body, size: body.length, time: cloud.uni.time });
      const o = cloud.put('aws_s3_object', { ...a, id: a.key, etag: fakeHash(body, 32), content_type: a.content_type || (/\.html?$/.test(a.key) ? 'text/html' : 'binary/octet-stream') });
      return o;
    },
    update(cloud, id, a) { const r = SCHEMAS.aws_s3_object.create(cloud, a, { readFile: () => '' }); return r; },
    read(cloud, id) { return cloud.get('aws_s3_object', id); },
    del(cloud, id, a) { cloud.buckets.get(a.bucket)?.objects.delete(a.key); cloud.table('aws_s3_object').delete(id); },
  },
  aws_route53_zone: {
    args: { name: A({ req: true, force: true }), comment: A({ def: 'Managed by Terraform' }), tags: A({ type: 'map', def: {} }) },
    computed: ['id', 'zone_id', 'name_servers', 'arn'],
    times: [40, 1, 30],
    create(cloud, a) { const z = cloud.put('aws_route53_zone', { ...a }); z.zone_id = z.id; z.name_servers = ['ns-1201.awsdns-22.org', 'ns-1817.awsdns-35.co.uk', 'ns-338.awsdns-42.com', 'ns-882.awsdns-46.net']; z.arn = `arn:aws:route53:::hostedzone/${z.id}`; return z; },
  },
  aws_route53_record: {
    args: { zone_id: A({ req: true, force: true }), name: A({ req: true, force: true }), type: A({ req: true, force: true }), ttl: A({ type: 'number', def: null }), records: A({ type: 'set', def: [] }) },
    computed: ['id', 'fqdn'],
    times: [31, 31, 31],
    create(cloud, a) {
      const z = cloud.get('aws_route53_zone', a.zone_id);
      if (!z) throw new SimError(`creating Route 53 Record: operation error Route 53: ChangeResourceRecordSets, api error NoSuchHostedZone: No hosted zone found with ID: ${a.zone_id}`);
      const fqdn = a.name.endsWith(z.name) ? a.name : `${a.name}.${z.name}`;
      if (a.type === 'A' && a.records?.[0]) cloud.uni.dns.set(fqdn, a.records[0]);
      return cloud.put('aws_route53_record', { ...a, id: `${a.zone_id}_${fqdn}_${a.type}`, fqdn, name: a.name });
    },
    update(cloud, id, a) { const r = cloud.get('aws_route53_record', id); Object.assign(r, a); if (a.type === 'A' && a.records?.[0]) cloud.uni.dns.set(r.fqdn, a.records[0]); return r; },
    del(cloud, id) { const r = cloud.get('aws_route53_record', id); if (r) cloud.uni.dns.delete(r.fqdn); cloud.table('aws_route53_record').delete(id); },
  },
  random_pet: {
    args: { length: A({ type: 'number', def: 2, force: true }), separator: A({ def: '-', force: true }), prefix: A({ def: null, force: true }) },
    computed: ['id'], times: [0, 0, 0], local: true,
    create(cloud, a) { const words = []; for (let i = 0; i < (a.length || 2) - 1; i++) words.push(WORDS[next() % WORDS.length]); words.push(ANIMALS[next() % ANIMALS.length]); return { ...a, id: [a.prefix, ...words].filter(Boolean).join(a.separator ?? '-') }; },
  },
  random_id: {
    args: { byte_length: A({ type: 'number', req: true, force: true }), prefix: A({ def: null, force: true }) },
    computed: ['id', 'hex', 'dec', 'b64_url', 'b64_std'], times: [0, 0, 0], local: true,
    create(cloud, a) { const hex = fakeHash(String(next()), a.byte_length * 2); return { ...a, hex: (a.prefix || '') + hex, id: btoa(hex).replace(/=+$/, '').slice(0, Math.ceil(a.byte_length * 4 / 3)), dec: String(parseInt(hex.slice(0, 12), 16)), b64_url: btoa(hex).replace(/=+$/, ''), b64_std: btoa(hex) }; },
  },
  random_password: {
    args: { length: A({ type: 'number', req: true, force: true }), special: A({ type: 'bool', def: true, force: true }) },
    computed: ['id', 'result'], times: [0, 0, 0], local: true, sensitive: ['result'],
    create(cloud, a) { const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' + (a.special ? '!#$%&*()-_=+[]{}<>:?' : ''); let r = ''; for (let i = 0; i < a.length; i++) r += chars[next() % chars.length]; return { ...a, id: 'none', result: r }; },
  },
  local_file: {
    args: { filename: A({ req: true, force: true }), content: A({ req: true, force: true }), file_permission: A({ def: '0777', force: true }) },
    computed: ['id'], times: [0, 0, 0], local: true,
    create(cloud, a, env) { env.writeFile(a.filename, a.content, a.file_permission); return { ...a, id: fakeHash(a.content, 40) }; },
    read(cloud, id, a, env) { const t = env.fileContent(a.filename); return t === undefined ? null : (t === a.content ? { ...a } : { ...a, content: t }); },
    del(cloud, id, a, env) { env.removeFile(a.filename); },
  },
};

export const DATA_SOURCES = {
  aws_ami: {
    args: { most_recent: A({ type: 'bool', def: false }), owners: A({ type: 'list', def: [] }) }, blocks: { filter: { name: A({ req: true }), values: A({ type: 'list', req: true }) } },
    read(cloud, a) {
      const names = (a.filter || []).filter(f => f.name === 'name').flatMap(f => f.values);
      const re = names.length ? new RegExp('^' + names[0].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : /ubuntu-noble/;
      const hit = Object.entries(AMIS).find(([, n]) => re.test(n));
      if (!hit) throw new SimError('Your query returned no results. Please change your search criteria and try again.');
      return { id: hit[0], image_id: hit[0], name: hit[1], owner_id: hit[1].startsWith('ubuntu') ? '099720109477' : '137112412989', architecture: 'x86_64' };
    },
  },
  aws_vpc: { args: { default: A({ type: 'bool', def: false }), id: A({ def: null }) }, read(cloud, a) { const v = a.id ? cloud.get('aws_vpc', a.id) : cloud.get('aws_vpc', cloud.defaultVpc); if (!v) throw new SimError('no matching EC2 VPC found'); return { ...v }; } },
  aws_availability_zones: { args: { state: A({ def: null }) }, read(cloud) { return { id: cloud.region, names: ['a', 'b', 'c'].map(x => cloud.region + x) }; } },
  aws_caller_identity: { args: {}, read(cloud) { return { id: cloud.account, account_id: cloud.account, arn: `arn:aws:iam::${cloud.account}:user/dev`, user_id: 'AIDAZ3EXAMPLE7QX7A' }; } },
};

export const PROVIDER_VERSIONS = { aws: '5.72.1', random: '3.6.3', local: '2.5.2', null: '3.2.3' };
export { UBUNTU_AMI };
