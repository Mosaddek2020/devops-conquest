// Cloud costs (FinOps) for the simulated AWS account: a price list, Cost Explorer
// (`aws ce get-cost-and-usage`, grouped by service or by tag), the usual waste (unattached
// EBS volumes, idle Elastic IPs, ancient snapshots), CloudWatch CPU statistics for
// right-sizing, AWS Budgets, and `infracost`, which prices a Terraform directory and
// shows what a change will cost before it is applied.

import { def } from './registry.js';
import { AWS_EXT } from './cloud.js';
import { C } from '../git/world.js';

const HOURS = 730;
export const PRICES = {
  instance: { 't3.nano': 0.0057, 't3.micro': 0.0114, 't3.small': 0.0228, 't3.medium': 0.0456, 't3.large': 0.0912, 'm5.large': 0.107, 'm5.xlarge': 0.214 },
  ebs: { gp2: 0.11, gp3: 0.088 },
  snapshot: 0.05,
  ipv4: 0.005,
  s3: 0.023,
};
const money = n => `$${n.toFixed(2)}`;
const SERVICE = { aws_instance: 'Amazon Elastic Compute Cloud - Compute', aws_ebs_volume: 'EC2 - Other', aws_ebs_snapshot: 'EC2 - Other', aws_eip: 'Amazon Virtual Private Cloud', aws_s3_bucket: 'Amazon Simple Storage Service' };

// hourly cost of one resource
export function hourly(type, r) {
  if (type === 'aws_instance') return r.instance_state === 'running' ? (PRICES.instance[r.instance_type] || 0.1) + (r.public_ip ? PRICES.ipv4 : 0) : 0;
  if (type === 'aws_ebs_volume') return (r.size || 8) * (PRICES.ebs[r.type] || 0.1) / HOURS;
  if (type === 'aws_ebs_snapshot') return (r.volume_size || 8) * PRICES.snapshot / HOURS * 0.6;
  if (type === 'aws_eip') return PRICES.ipv4;
  if (type === 'aws_s3_bucket') return (r.size_gb || 1) * PRICES.s3 / HOURS;
  return 0;
}

// every billable item with its life span: live resources plus ones deleted along the way
function billables(cloud) {
  const out = [];
  for (const type of Object.keys(SERVICE)) for (const r of cloud.all(type)) out.push({ type, r, from: r.billedFrom ?? r.created ?? r.launched ?? cloud.uni.time - 400 * 86400, to: null });
  for (const g of cloud.gone || []) out.push(g);
  return out;
}
export function forget(cloud, type, r) { (cloud.gone = cloud.gone || []).push({ type, r: { ...r }, from: r.billedFrom ?? r.created ?? r.launched ?? cloud.uni.time - 400 * 86400, to: cloud.uni.time }); }
export function costBetween(cloud, start, end, groupBy) {
  const groups = new Map();
  for (const b of billables(cloud)) {
    const s = Math.max(start, b.from), e = Math.min(end, b.to ?? cloud.uni.time);
    if (e <= s) continue;
    // instances that used to be bigger (right-sizing) are billed at their history
    let cost = 0;
    if (b.type === 'aws_instance' && b.r.typeHistory) { for (const h of b.r.typeHistory) { const hs = Math.max(s, h.from), he = Math.min(e, h.to ?? e); if (he > hs) cost += (PRICES.instance[h.type] || 0.1) * (he - hs) / 3600; } }
    else cost = hourly(b.type, b.r) * (e - s) / 3600;
    const key = !groupBy ? 'total' : groupBy.Type === 'TAG' ? `${groupBy.Key}$${b.r.tags?.[groupBy.Key] || ''}` : SERVICE[b.type];
    groups.set(key, (groups.get(key) || 0) + cost);
  }
  return groups;
}
export function monthlyRunRate(cloud) { let n = 0; for (const type of Object.keys(SERVICE)) for (const r of cloud.all(type)) n += hourly(type, r) * HOURS; return n; }

const dayStr = t => new Date(t * 1000).toISOString().slice(0, 10);
const parseKV = s => Object.fromEntries(String(s || '').split(',').map(p => p.split('=')).filter(x => x.length === 2));
const fileArg = (c, v) => { if (!/^file:\/\//.test(String(v || ''))) { try { return JSON.parse(v); } catch { return null; } } const t = c.host.files.get(c.resolve(String(v).slice(7))); if (t === undefined) return { __missing: String(v).slice(7) }; try { return JSON.parse(t); } catch { return { __bad: true }; } };
const tagList = tags => Object.entries(tags || {}).map(([Key, Value]) => ({ Key, Value }));

// ---------------------------------------------------------------- aws ce / cloudwatch / budgets
AWS_EXT.ce = ({ c, cloud, op, flags, show }) => {
  if (op !== 'get-cost-and-usage' && op !== 'get-cost-forecast') return c.fail(`\naws: error: argument operation: Invalid choice: '${op}'`, 252);
  if (op === 'get-cost-forecast') { const rate = monthlyRunRate(cloud); return show({ Total: { Amount: rate.toFixed(2), Unit: 'USD' }, ForecastResultsByTime: [{ TimePeriod: { Start: dayStr(cloud.uni.time), End: dayStr(cloud.uni.time + 30 * 86400) }, MeanValue: rate.toFixed(2) }] }); }
  const tp = parseKV(flags['time-period']);
  if (!tp.Start || !tp.End) return c.fail('\naws: error: the following arguments are required: --time-period', 252);
  const start = Date.parse(tp.Start + 'T00:00:00Z') / 1000, end = Date.parse(tp.End + 'T00:00:00Z') / 1000;
  if (!(end > start)) return c.fail('\nAn error occurred (ValidationException) when calling the GetCostAndUsage operation: Start date (and hour) should be before end date (and hour)', 254);
  const gb = flags['group-by'] ? parseKV([].concat(flags['group-by'])[0]) : null;
  const gran = flags.granularity || 'MONTHLY';
  const periods = [];
  if (gran === 'DAILY') for (let t = start; t < end; t += 86400) periods.push([t, Math.min(end, t + 86400)]);
  else { let t = start; while (t < end) { const d = new Date(t * 1000); const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; periods.push([t, Math.min(end, next)]); t = Math.min(end, next); } }
  const metric = [].concat(flags.metrics || 'UnblendedCost')[0];
  c.uni.emit({ type: 'finops', tool: 'ce', groupBy: gb ? `${gb.Type}:${gb.Key}` : null });
  return show({ GroupDefinitions: gb ? [{ Type: gb.Type, Key: gb.Key }] : [], ResultsByTime: periods.map(([s, e]) => { const g = costBetween(cloud, s, e, gb); return gb ? { TimePeriod: { Start: dayStr(s), End: dayStr(e) }, Total: {}, Groups: [...g].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ Keys: [k], Metrics: { [metric]: { Amount: v.toFixed(2), Unit: 'USD' } } })), Estimated: e > cloud.uni.time - 86400 } : { TimePeriod: { Start: dayStr(s), End: dayStr(e) }, Total: { [metric]: { Amount: (g.get('total') || 0).toFixed(2), Unit: 'USD' } }, Groups: [], Estimated: e > cloud.uni.time - 86400 }; }), DimensionValueAttributes: [] });
};

AWS_EXT.cloudwatch = ({ c, cloud, op, flags, show }) => {
  if (op !== 'get-metric-statistics') return c.fail(`\naws: error: argument operation: Invalid choice: '${op}'`, 252);
  const dims = parseKV([].concat(flags.dimensions || [])[0]);
  const id = dims.Value;
  const i = cloud.get('aws_instance', id);
  if (flags['metric-name'] !== 'CPUUtilization' || !i) return show({ Label: flags['metric-name'] || '', Datapoints: [] });
  const start = Date.parse(flags['start-time']) / 1000 || cloud.uni.time - 14 * 86400, end = Date.parse(flags['end-time']) / 1000 || cloud.uni.time;
  const period = Number(flags.period || 86400);
  const m = i.metrics || { cpuAvg: 35, cpuMax: 70 };
  const pts = [];
  for (let t = start, k = 0; t < end && pts.length < 60; t += period, k++) { const j = ((k * 7919) % 13) / 13 - 0.5; pts.push({ Timestamp: new Date(t * 1000).toISOString().replace('.000Z', '+00:00'), Average: +(m.cpuAvg * (1 + j * 0.3)).toFixed(2), Maximum: +(m.cpuMax * (1 + j * 0.15)).toFixed(2), Unit: 'Percent' }); }
  c.uni.emit({ type: 'finops', tool: 'cloudwatch', instance: id });
  return show({ Label: 'CPUUtilization', Datapoints: pts.map(p => Object.fromEntries(Object.entries(p).filter(([k]) => k === 'Timestamp' || k === 'Unit' || [].concat(flags.statistics || ['Average']).includes(k)))) });
};

AWS_EXT.budgets = ({ c, cloud, op, flags, show }) => {
  cloud.budgets = cloud.budgets || new Map();
  if (op === 'create-budget') {
    const b = fileArg(c, flags.budget);
    if (!b || b.__missing) return c.fail(`\nError parsing parameter '--budget': Unable to load paramfile ${flags.budget}: [Errno 2] No such file or directory: '${b?.__missing || ''}'`, 252);
    if (b.__bad) return c.fail(`\nError parsing parameter '--budget': Invalid JSON`, 252);
    if (!b.BudgetName || !b.BudgetLimit?.Amount || !b.TimeUnit) return c.fail('\nAn error occurred (InvalidParameterException) when calling the CreateBudget operation: BudgetName, BudgetLimit and TimeUnit are required', 254);
    if (cloud.budgets.has(b.BudgetName)) return c.fail(`\nAn error occurred (DuplicateRecordException) when calling the CreateBudget operation: Error creating budget: the budget ${b.BudgetName} already exists.`, 254);
    const n = flags['notifications-with-subscribers'] ? fileArg(c, flags['notifications-with-subscribers']) : [];
    if (n && (n.__missing || n.__bad)) return c.fail(`\nError parsing parameter '--notifications-with-subscribers': Unable to load paramfile`, 252);
    cloud.budgets.set(b.BudgetName, { ...b, notifications: n || [] });
    c.uni.emit({ type: 'finops', tool: 'budget', name: b.BudgetName, amount: Number(b.BudgetLimit.Amount), thresholds: (n || []).map(x => x.Notification?.Threshold) });
    return 0;
  }
  if (op === 'describe-budgets') return show({ Budgets: [...cloud.budgets.values()].map(b => ({ BudgetName: b.BudgetName, BudgetLimit: b.BudgetLimit, TimeUnit: b.TimeUnit, BudgetType: b.BudgetType || 'COST', CalculatedSpend: { ActualSpend: { Amount: (monthlyRunRate(cloud) * 0.9).toFixed(2), Unit: 'USD' }, ForecastedSpend: { Amount: monthlyRunRate(cloud).toFixed(2), Unit: 'USD' } } })) });
  if (op === 'delete-budget') { cloud.budgets.delete(flags['budget-name']); return 0; }
  return c.fail(`\naws: error: argument operation: Invalid choice: '${op}'`, 252);
};

// ---------------------------------------------------------------- EC2 waste
const filtersOf = flags => [].concat(flags.filters || []).map(f => String(f).match(/Name=([^,]+),Values=(.+)/)).filter(Boolean).map(m => [m[1], m[2].split(',')]);
AWS_EXT['ec2:describe-volumes'] = ({ cloud, flags, show }) => {
  let list = cloud.all('aws_ebs_volume');
  for (const [k, vals] of filtersOf(flags)) list = list.filter(v => k === 'status' ? vals.includes(v.state) : k.startsWith('tag:') ? vals.includes(v.tags?.[k.slice(4)]) : true);
  const ids = [].concat(flags['volume-ids'] || []);
  if (ids.length) list = list.filter(v => ids.includes(v.id));
  return show({ Volumes: list.map(v => ({ VolumeId: v.id, Size: v.size, VolumeType: v.type, State: v.state, CreateTime: new Date(v.created * 1000).toISOString().replace('.000Z', '+00:00'), AvailabilityZone: `${cloud.region}a`, Attachments: v.attached ? [{ InstanceId: v.attached, Device: '/dev/sdf', State: 'attached' }] : [], Tags: tagList(v.tags) })) });
};
AWS_EXT['ec2:delete-volume'] = ({ c, cloud, flags, by }) => {
  const v = cloud.get('aws_ebs_volume', flags['volume-id']);
  if (!v) return c.fail(`\nAn error occurred (InvalidVolume.NotFound) when calling the DeleteVolume operation: The volume '${flags['volume-id']}' does not exist.`, 254);
  if (v.state === 'in-use') return c.fail(`\nAn error occurred (VolumeInUse) when calling the DeleteVolume operation: Volume ${v.id} is currently attached to ${v.attached}`, 254);
  forget(cloud, 'aws_ebs_volume', v); cloud.table('aws_ebs_volume').delete(v.id); cloud.record('delete', 'aws_ebs_volume', v.id, by);
  return 0;
};
AWS_EXT['ec2:describe-addresses'] = ({ cloud, show }) => show({ Addresses: cloud.all('aws_eip').map(e => ({ PublicIp: e.public_ip, AllocationId: e.id, Domain: 'vpc', ...(e.association ? { InstanceId: e.association, AssociationId: 'eipassoc-' + e.id.slice(9) } : {}), Tags: tagList(e.tags) })) });
AWS_EXT['ec2:release-address'] = ({ c, cloud, flags, by }) => {
  const e = cloud.get('aws_eip', flags['allocation-id']);
  if (!e) return c.fail(`\nAn error occurred (InvalidAllocationID.NotFound) when calling the ReleaseAddress operation: The allocation ID '${flags['allocation-id']}' does not exist`, 254);
  if (e.association) return c.fail(`\nAn error occurred (InvalidIPAddress.InUse) when calling the ReleaseAddress operation: Address ${e.public_ip} is in use.`, 254);
  forget(cloud, 'aws_eip', e); cloud.table('aws_eip').delete(e.id); cloud.record('delete', 'aws_eip', e.id, by);
  return 0;
};
AWS_EXT['ec2:describe-snapshots'] = ({ cloud, flags, show }) => {
  let list = cloud.all('aws_ebs_snapshot');
  for (const [k, vals] of filtersOf(flags)) list = list.filter(s => k.startsWith('tag:') ? vals.includes(s.tags?.[k.slice(4)]) : true);
  return show({ Snapshots: list.sort((a, b) => a.created - b.created).map(s => ({ SnapshotId: s.id, VolumeId: s.volume_id, VolumeSize: s.volume_size, StartTime: new Date(s.created * 1000).toISOString().replace('.000Z', '+00:00'), State: 'completed', Description: s.description || '', OwnerId: cloud.account, Tags: tagList(s.tags) })) });
};
AWS_EXT['ec2:delete-snapshot'] = ({ c, cloud, flags, by }) => {
  const s = cloud.get('aws_ebs_snapshot', flags['snapshot-id']);
  if (!s) return c.fail(`\nAn error occurred (InvalidSnapshot.NotFound) when calling the DeleteSnapshot operation: The snapshot '${flags['snapshot-id']}' does not exist.`, 254);
  forget(cloud, 'aws_ebs_snapshot', s); cloud.table('aws_ebs_snapshot').delete(s.id); cloud.record('delete', 'aws_ebs_snapshot', s.id, by);
  return 0;
};

// ---------------------------------------------------------------- infracost
function readTf(c, dir) {
  const abs = c.resolve(dir || '.');
  const files = [...c.host.files.keys()].filter(p => p.startsWith(abs + '/') && !p.slice(abs.length + 1).includes('/') && /\.tf$/.test(p)).sort();
  const text = files.map(p => c.host.files.get(p)).join('\n');
  const tfvars = c.host.files.get(abs + '/terraform.tfvars') || '';
  return { abs, text, tfvars, files };
}
function blocks(text, kind) {
  const out = [];
  const re = new RegExp(`${kind}\\s+"([^"]+)"(?:\\s+"([^"]+)")?\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(text))) {
    let depth = 1, i = re.lastIndex;
    while (i < text.length && depth) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
    out.push({ a: m[1], b: m[2], body: text.slice(re.lastIndex, i - 1) });
  }
  return out;
}
function resolver(text, tfvars) {
  const vars = {};
  for (const v of blocks(text, 'variable')) { const d = v.body.match(/default\s*=\s*("([^"]*)"|[\d.]+|true|false)/); if (d) vars[v.a] = d[2] ?? d[1]; }
  for (const line of tfvars.split('\n')) { const m = line.match(/^\s*(\w+)\s*=\s*("([^"]*)"|[\d.]+)/); if (m) vars[m[1]] = m[3] ?? m[2]; }
  return expr => { const s = String(expr || '').trim(); if (/^"/.test(s)) return s.replace(/^"|"$/g, ''); if (/^var\.\w+$/.test(s)) return vars[s.slice(4)]; if (/^[\d.]+$/.test(s)) return Number(s); return undefined; };
}
const attr = (body, name) => (body.match(new RegExp(`^\\s*${name}\\s*=\\s*([^\\n#]+)`, 'm')) || [])[1];
export function estimate(text, tfvars) {
  const val = resolver(text, tfvars);
  const items = [];
  for (const r of blocks(text, 'resource')) {
    const count = attr(r.body, 'count') !== undefined ? Number(val(attr(r.body, 'count')) ?? 1) : 1;
    for (let k = 0; k < count; k++) {
      const name = `${r.a}.${r.b}${attr(r.body, 'count') !== undefined ? `[${k}]` : ''}`;
      if (r.a === 'aws_instance') {
        const type = val(attr(r.body, 'instance_type')) || 'unknown';
        const rootSize = Number(val((r.body.match(/root_block_device\s*\{[^}]*volume_size\s*=\s*([^\n]+)/) || [])[1]) ?? 8);
        const lines = [{ label: `Instance usage (Linux/UNIX, on-demand, ${type})`, qty: HOURS, unit: 'hours', cost: (PRICES.instance[type] || 0) * HOURS }, { label: 'root_block_device', children: [{ label: 'Storage (general purpose SSD, gp3)', qty: rootSize, unit: 'GB', cost: rootSize * PRICES.ebs.gp3 }] }];
        items.push({ name, lines, cost: lines[0].cost + lines[1].children[0].cost });
      } else if (r.a === 'aws_ebs_volume') {
        const size = Number(val(attr(r.body, 'size')) ?? 8), t = val(attr(r.body, 'type')) || 'gp3';
        items.push({ name, lines: [{ label: `Storage (general purpose SSD, ${t})`, qty: size, unit: 'GB', cost: size * (PRICES.ebs[t] || 0.1) }], cost: size * (PRICES.ebs[t] || 0.1) });
      } else if (r.a === 'aws_eip') items.push({ name, lines: [{ label: 'IP address (if unused)', qty: HOURS, unit: 'hours', cost: PRICES.ipv4 * HOURS }], cost: PRICES.ipv4 * HOURS });
      else items.push({ name, free: true, cost: 0 });
    }
  }
  return items;
}

def('infracost', c => {
  const [cmd, ...rest] = c.args;
  const flags = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) { const k = rest[i].slice(2); if (k.includes('=')) flags[k.split('=')[0]] = k.split('=')[1]; else flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  if (!cmd || cmd === 'help' || cmd === '--help') { c.print('Infracost - cloud cost estimates for Terraform', '', 'USAGE', '  infracost [flags]', '  infracost [command]', '', 'COMMANDS', '  breakdown   Show breakdown of costs', '  diff        Show diff of monthly costs between current and planned state'); return 0; }
  if (cmd === '--version' || cmd === 'version') { c.print('Infracost v0.10.39'); return 0; }
  const { text, tfvars, files } = readTf(c, flags.path);
  if (!files.length) return c.fail(`Error: No Terraform files found in ${flags.path || '.'}`, 1);
  const items = estimate(text, tfvars);
  const total = items.reduce((s, x) => s + x.cost, 0);
  if (cmd === 'breakdown') {
    if (flags.format === 'json') {
      const json = JSON.stringify({ version: '0.2', totalMonthlyCost: total.toFixed(2), projects: [{ name: flags.path || '.', breakdown: { totalMonthlyCost: total.toFixed(2), resources: items.map(x => ({ name: x.name, monthlyCost: x.cost.toFixed(2) })) } }] }, null, 2);
      if (flags['out-file']) c.host.writeFile(c.resolve(flags['out-file']), json + '\n', c.user); else c.print(...json.split('\n'));
    } else {
      const L = [`Project: ${flags.path || '.'}`, '', ' Name                                                    Monthly Qty  Unit   Monthly Cost', ''];
      for (const x of items.filter(i => !i.free)) {
        L.push(` ${x.name}`);
        x.lines.forEach((l, i) => { const last = i === x.lines.length - 1; if (l.children) { L.push(` ${last ? '└─' : '├─'} ${l.label}`); for (const ch of l.children) L.push(`    └─ ${ch.label.padEnd(46)} ${String(ch.qty).padStart(6)}  ${ch.unit.padEnd(6)} ${money(ch.cost).padStart(12)}`); } else L.push(` ${last ? '└─' : '├─'} ${l.label.padEnd(49)} ${String(l.qty).padStart(6)}  ${l.unit.padEnd(6)} ${money(l.cost).padStart(12)}`); });
        L.push('');
      }
      L.push(` OVERALL TOTAL${money(total).padStart(76)}`, '──────────────────────────────────', `${items.length} cloud resources were detected:`, `∙ ${items.filter(i => !i.free).length} were estimated`, `∙ ${items.filter(i => i.free).length} were free`);
      c.print(...L);
    }
    c.uni.emit({ type: 'finops', tool: 'infracost', cmd, total, out: flags['out-file'] || null });
    return 0;
  }
  if (cmd === 'diff') {
    if (!flags['compare-to']) return c.fail('Error: --compare-to is required (create a baseline with: infracost breakdown --path . --format json --out-file infracost-base.json)', 1);
    const base = (() => { try { return JSON.parse(c.host.files.get(c.resolve(flags['compare-to'])) || ''); } catch { return null; } })();
    if (!base) return c.fail(`Error: could not read ${flags['compare-to']}`, 1);
    const before = new Map(base.projects[0].breakdown.resources.map(r => [r.name, Number(r.monthlyCost)]));
    const after = new Map(items.map(x => [x.name, x.cost]));
    const L = ['Key: ~ changed, + added, - removed', ''];
    for (const n of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(n) ?? 0, a = after.get(n) ?? 0;
      if (Math.abs(a - b) < 0.005) continue;
      const sym = !before.has(n) ? '+' : !after.has(n) ? '-' : '~';
      L.push(`${sym} ${n}`, `  ${a - b >= 0 ? '+' : '-'}${money(Math.abs(a - b))} (${money(b)} → ${money(a)})`, '');
    }
    const bt = Number(base.totalMonthlyCost);
    L.push(`Monthly cost change for ${flags.path || '.'}`, `Amount:  ${total - bt >= 0 ? '+' : '-'}${money(Math.abs(total - bt))} (${money(bt)} → ${money(total)})`, `Percent: ${bt ? `${total - bt >= 0 ? '+' : ''}${Math.round((total - bt) / bt * 100)}%` : 'n/a'}`);
    c.print(...L);
    c.uni.emit({ type: 'finops', tool: 'infracost', cmd, total, before: bt });
    return 0;
  }
  return c.fail(`Error: unknown command "${cmd}" for "infracost"`, 1);
}, { pkg: 'infracost' });

export { money, C };
