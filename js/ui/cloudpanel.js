// The Cloud panel: what exists in the simulated AWS account right now, and whether
// Terraform manages it (found in a state file) or someone made it by hand.

import { h, clear } from './dom.js';
import { registerPanel } from './panelRegistry.js';

function managedIds(uni) {
  const ids = new Set();
  const add = text => { try { for (const r of JSON.parse(text).resources || []) for (const i of r.instances || []) if (i.attributes?.id) ids.add(i.attributes.id); } catch { /* not state */ } };
  for (const host of uni.hosts.values()) for (const [p, t] of host.files) if (/terraform\.tfstate$/.test(p)) add(t);
  for (const b of uni.cloud?.buckets.values() || []) for (const [k, o] of b.objects) if (/\.tfstate$/.test(k)) add(o.body);
  return ids;
}
const risky = r => (r.cidr_blocks || []).includes('0.0.0.0/0') && [22, 3306, 5432, 6379, 27017, 3389].some(p => p >= Number(r.from_port) && p <= Number(r.to_port));
const ruleText = r => `${String(r.protocol) === '-1' ? 'all' : r.protocol} ${r.from_port === r.to_port ? r.from_port : `${r.from_port}-${r.to_port}`} ← ${(r.cidr_blocks || []).join(', ') || (r.security_groups || []).join(', ') || (r.self ? 'self' : '?')}`;

export class CloudView {
  constructor() { this.el = h('div', { class: 'sys cloudv' }); }
  render(sh, uni) {
    clear(this.el);
    const cloud = uni.cloud;
    if (!cloud) { this.el.append(h('div', { class: 'gh-empty' }, 'No cloud account in this lab.')); return; }
    const managed = managedIds(uni);
    const tag = id => managed.has(id) ? h('span', { class: 'pill pill-ok' }, 'terraform') : h('span', { class: 'pill pill-warn' }, 'by hand');
    const insts = cloud.all('aws_instance');
    const sgs = cloud.all('aws_security_group').filter(g => g.name !== 'default');
    const buckets = cloud.all('aws_s3_bucket');
    const vpcs = cloud.all('aws_vpc').filter(v => !v.is_default);
    const recs = cloud.all('aws_route53_record');
    this.el.append(h('div', { class: 'sys-head' }, h('div', {}, h('div', { class: 'sys-name' }, `AWS account ${cloud.account}`), h('div', { class: 'meta' }, `${cloud.region} · ${insts.length} instances · ${sgs.length} security groups · ${buckets.length} buckets`))));
    const section = (title, items, render, empty) => this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `${title} (${items.length})`), items.length ? h('ul', { class: 'gh-list' }, items.map(render)) : h('div', { class: 'gh-empty' }, empty)));
    section('EC2 instances', insts, i => h('li', {},
      h('div', { class: 'row' }, h('span', {}, h('i', { class: 'dot dot-' + (i.instance_state === 'running' ? 'ok' : 'off'), 'aria-hidden': 'true' }), h('strong', {}, i.tags?.Name || i.id), h('span', { class: 'meta mono' }, ` ${i.instance_type}`)), tag(i.id)),
      h('div', { class: 'dock-tags' }, h('span', { class: 'pill mono' }, i.public_ip || 'no public IP'), h('span', { class: 'pill mono' }, i.id), ...(i.vpc_security_group_ids || []).map(g => h('span', { class: 'pill' }, cloud.get('aws_security_group', g)?.name || g)))), 'No instances.');
    section('Security groups', sgs, g => h('li', {},
      h('div', { class: 'row' }, h('strong', { class: 'mono' }, g.name), tag(g.id)),
      h('div', { class: 'dock-tags' }, (g.ingress || []).length ? g.ingress.map(r => h('span', { class: 'pill ' + (risky(r) ? 'pill-bad' : '') , title: risky(r) ? 'open to the whole internet' : '' }, ruleText(r))) : h('span', { class: 'meta' }, 'no inbound rules'))), 'No security groups yet.');
    if (buckets.length) section('S3 buckets', buckets, b => h('li', {}, h('div', { class: 'row' }, h('span', { class: 'mono' }, b.bucket), h('span', {}, h('span', { class: 'meta' }, `${cloud.buckets.get(b.bucket)?.objects.size || 0} objects `), tag(b.id)))), '');
    if (vpcs.length) section('VPCs', vpcs, v => h('li', {}, h('div', { class: 'row' }, h('span', { class: 'mono' }, `${v.tags?.Name || v.id} ${v.cidr_block}`), tag(v.id)), h('div', { class: 'dock-tags' }, cloud.all('aws_subnet').filter(s => s.vpc_id === v.id).map(s => h('span', { class: 'pill mono' }, `${s.tags?.Name || 'subnet'} ${s.cidr_block}`)), cloud.all('aws_internet_gateway').some(g => g.vpc_id === v.id) ? h('span', { class: 'pill pill-ok' }, 'internet gateway') : h('span', { class: 'pill pill-warn' }, 'no internet gateway'))), '');
    if (recs.length) section('DNS records', recs, r => h('li', {}, h('div', { class: 'row' }, h('span', { class: 'mono' }, `${r.fqdn} ${r.type}`), h('span', { class: 'meta mono' }, (r.records || []).join(', ')))), '');
    const recent = cloud.log.slice(-5).reverse();
    if (recent.length) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Recent changes (CloudTrail)'), h('ul', { class: 'gh-list' }, recent.map(e => h('li', {}, h('div', { class: 'row' }, h('span', { class: 'mono' }, `${e.action} ${e.type.replace('aws_', '')} ${e.id}`), h('span', { class: 'pill ' + (e.by === 'terraform' ? 'pill-ok' : 'pill-warn') }, e.by)))))));
  }
}

registerPanel('cloud', 'Cloud', () => new CloudView());
