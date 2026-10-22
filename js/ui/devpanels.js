// Panels for DevOps labs: a host dashboard (System), a file tree with permissions
// (Files) and a network map (Network). Each renders from the live simulator state.

import { h, clear, svg } from './dom.js';
import { modeString, humanSize } from '../sim/fsx.js';
import { access } from '../sim/session.js';
import { normPath, dirname } from '../sim/host.js';

const dotFor = st => st.active === 'active' ? 'ok' : st.active === 'failed' ? 'bad' : st.active === 'activating' ? 'warn' : 'off';

function hostChoice(sh, uni, current, onPick) {
  const hosts = [...uni.hosts.values()].filter(x => !x.hidden && x.name !== 'acme-validator' && x.kind !== 'container');
  if (hosts.length < 2) return null;
  return h('select', { class: 'gh-select', 'aria-label': 'Choose a machine', onchange: e => onPick(e.target.value) },
    hosts.map(x => h('option', { value: x.name, selected: x.name === current }, `${x.name}${x === sh.host ? ' (you are here)' : ''}`)));
}

function bar(label, used, total, unit, warnAt = 0.8) {
  const frac = total ? Math.min(1, used / total) : 0;
  return h('div', { class: 'sys-bar' },
    h('div', { class: 'sys-bar-top' }, h('span', {}, label), h('span', { class: 'mono' }, `${unit(used)} / ${unit(total)}`)),
    h('div', { class: 'sys-track', role: 'meter', 'aria-valuenow': Math.round(frac * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label },
      h('span', { class: frac >= 0.95 ? 'bad' : frac >= warnAt ? 'warn' : 'ok', style: { width: `${Math.max(2, frac * 100)}%` } })));
}

export class SystemView {
  constructor({ fixedHost = null } = {}) { this.el = h('div', { class: 'sys' }); this.pick = fixedHost; }
  render(sh, uni) {
    clear(this.el);
    const host = (this.pick && uni.host(this.pick)) || sh.host;
    const choice = hostChoice(sh, uni, host.name, n => { this.pick = n; this.render(sh, uni); });
    this.el.append(h('div', { class: 'sys-head' },
      h('div', {}, h('div', { class: 'sys-name' }, host.name, host === sh.host ? h('span', { class: 'pill pill-accent', style: { marginLeft: '8px' } }, `you: ${sh.user}`) : null),
        h('div', { class: 'meta mono' }, `${host.ip}  ·  ${host.os}`)),
      choice));
    const mem = Math.min(host.memMB, host.memUsedMB());
    const disk = host.mounts ? host.mounts[0].used / 1073741824 : host.diskUsedGB;
    const diskTotal = host.mounts ? host.mounts[0].size / 1073741824 : host.diskGB;
    this.el.append(h('div', { class: 'sys-bars' },
      bar('CPU load', host.loadAvg[0], host.cpus, v => v.toFixed(2), 0.7),
      bar('Memory', mem, host.memMB, v => v >= 1024 ? (v / 1024).toFixed(1) + 'G' : Math.round(v) + 'M'),
      bar('Disk /', disk, diskTotal, v => v.toFixed(1) + 'G', 0.85)));
    // services
    const units = [...host.units.values()].filter(u => host.files.has(`/etc/systemd/system/${u.name}`) || host.files.has(`/lib/systemd/system/${u.name}`));
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `Services (${units.length})`),
      units.length ? h('ul', { class: 'gh-list' }, units.sort((a, b) => a.name.localeCompare(b.name)).map(u => h('li', {}, h('div', { class: 'row' },
        h('span', {}, h('i', { class: 'dot dot-' + dotFor(u), 'aria-hidden': 'true' }), h('strong', {}, u.name.replace(/\.service$/, ''))),
        h('span', { class: 'meta' }, `${u.active}${u.active === 'active' ? ` (${u.sub})` : u.active === 'failed' ? ` · ${u.result}` : ''}${u.enabled ? ' · enabled' : ''}${u.pid ? ` · pid ${u.pid}` : ''}`))))) : h('div', { class: 'gh-empty' }, 'No services.')));
    // ports
    const ports = [...host.listening].filter(([, l]) => host.procs.has(l.pid)).sort((a, b) => a[0] - b[0]);
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Listening ports'),
      ports.length ? h('ul', { class: 'gh-list' }, ports.map(([port, l]) => {
        const p = host.procs.get(l.pid);
        const local = l.addr === '127.0.0.1';
        return h('li', {}, h('div', { class: 'row' },
          h('span', {}, h('strong', { class: 'mono' }, `:${port}`), h('span', { class: 'pill ' + (local ? '' : 'pill-ok'), style: { marginLeft: '8px' } }, local ? 'localhost only' : 'all interfaces')),
          h('span', { class: 'meta mono' }, `${p.cmd.split(' ')[0].split('/').pop().replace(':', '')} (pid ${p.pid}, ${p.user})`)));
      })) : h('div', { class: 'gh-empty' }, 'Nothing is listening.')));
    // firewall
    const fw = host.firewall;
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Firewall (ufw)'),
      h('div', { class: 'sys-fw ' + (fw.enabled ? 'on' : 'off') },
        h('strong', {}, fw.enabled ? `active · default ${fw.defaultIn} incoming` : 'inactive (everything that listens is reachable)'),
        fw.enabled && fw.rules.length ? h('div', { class: 'meta mono' }, fw.rules.map(r => `${r.action} ${r.ports ? r.ports.join(',') : r.port ?? 'any'}${r.from && r.from !== 'any' ? ' from ' + r.from : ''}`).join('  ·  ')) : null)));
    // processes
    const procs = [...host.procs.values()].filter(p => p.pid !== 1).sort((a, b) => (b.mem || 0) - (a.mem || 0)).slice(0, 6);
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Top processes (by memory)'),
      h('ul', { class: 'gh-list' }, procs.map(p => h('li', {}, h('div', { class: 'row' }, h('span', { class: 'mono', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' } }, `${p.pid}  ${p.cmd}`), h('span', { class: 'meta mono' }, `${p.user} · ${Math.round(p.mem || 0)}M`)))))));
  }
}

export class FileTreeView {
  constructor() { this.el = h('div', { class: 'ftree' }); this.selected = null; this.root = null; }
  render(sh) {
    clear(this.el);
    const host = sh.host;
    const root = this.root && host.isDir(this.root) ? this.root : sh.cwd;
    const up = dirname(root);
    this.el.append(h('div', { class: 'ftree-head' },
      h('span', { class: 'mono' }, `${host.name}:${root}`),
      root !== '/' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.root = up; this.render(sh); } }, '↑ up') : null,
      this.root && this.root !== sh.cwd ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.root = null; this.render(sh); } }, 'back to cwd') : null));
    const list = h('ul', { class: 'ftree-list', role: 'tree' });
    const add = (dir, depth) => {
      let items;
      try { items = host.listDir(dir); } catch { return; }
      if (!access(host, sh.user, dir, 'r')) { list.append(h('li', { class: 'ftree-denied', style: { paddingLeft: `${depth * 14 + 6}px` } }, `(permission denied for ${sh.user})`)); return; }
      for (const [name, kind] of items) {
        if (name === 'node_modules' || name === '.git') { list.append(h('li', { style: { paddingLeft: `${depth * 14 + 6}px` } }, h('span', { class: 'ftree-name dim' }, name + '/ …'))); continue; }
        const p = normPath(dir + '/' + name);
        const st = host.lstat(p) || host.stat(p);
        if (!st) continue;
        const isLink = st.type === 'link';
        const li = h('li', { role: 'treeitem', class: (this.selected === p ? 'is-sel ' : '') + (kind === 'dir' ? 'is-dir' : 'is-file'), style: { paddingLeft: `${depth * 14 + 6}px` } },
          h('button', { type: 'button', class: 'ftree-row', onclick: () => { if (kind === 'dir') { this.root = p; } else this.selected = p; this.render(sh); } },
            h('span', { class: 'ftree-name' }, (kind === 'dir' ? '▸ ' : '') + name + (kind === 'dir' ? '/' : '') + (isLink ? ` → ${st.target}` : '')),
            h('span', { class: 'ftree-meta mono' }, `${modeString(st)} ${st.owner}:${st.group}${kind === 'dir' ? '' : ' ' + humanSize(host.fakeSizes?.get(p) ?? st.size)}`)));
        list.append(li);
        if (kind === 'dir' && depth < 1 && !isLink) add(p, depth + 1);
      }
    };
    add(root, 0);
    if (!list.children.length) list.append(h('li', { class: 'gh-empty' }, 'This folder is empty.'));
    this.el.append(list);
    if (this.selected && host.files.has(this.selected)) {
      const ok = access(host, sh.user, this.selected, 'r');
      const text = ok ? host.files.get(this.selected) : null;
      this.el.append(h('div', { class: 'ftree-preview' },
        h('div', { class: 'ftree-ph mono' }, this.selected, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.selected = null; this.render(sh); } }, 'close')),
        ok ? h('pre', {}, text.length > 4000 ? text.slice(0, 4000) + '\n…' : text || '(empty file)') : h('p', { class: 'meta' }, `${sh.user} cannot read this file (cat would say: Permission denied).`)));
    }
  }
}

export class NetworkView {
  constructor() { this.el = h('div', { class: 'netmap' }); }
  render(sh, uni) {
    clear(this.el);
    const hosts = [...uni.hosts.values()].filter(x => !x.hidden && x.name !== 'acme-validator' && x.kind !== 'container');
    const laptop = hosts.find(x => x.kind === 'laptop');
    const servers = hosts.filter(x => x !== laptop);
    const W = 560, rowH = 92;
    const H = Math.max(200, 40 + servers.length * rowH);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Network map of the lab machines' });
    const pos = new Map();
    if (laptop) pos.set(laptop.name, { x: 20, y: H / 2 - 32, w: 140, h: 64 });
    servers.forEach((x, k) => pos.set(x.name, { x: 330, y: 20 + k * rowH, w: 210, h: 72 }));
    // internet cloud
    // last connection attempt
    const last = [...uni.events].reverse().find(e => ['http', 'ssh', 'ssh-denied', 'tcp-check', 'ping', 'copy'].includes(e.type));
    for (const x of servers) {
      const a = pos.get(laptop?.name), b = pos.get(x.name);
      if (!a) continue;
      let color = 'var(--line-strong)', dash = '4 4', label = null;
      if (last) {
        const target = last.type === 'http' ? hostOfUrl(uni, last.url, laptop) : last.type === 'ssh' || last.type === 'ssh-denied' ? uni.host(last.to) : last.type === 'tcp-check' || last.type === 'ping' ? hostByName(uni, last.target, laptop) : last.type === 'copy' ? uni.host(last.to === laptop?.name ? last.from : last.to) : null;
        if (target === x) {
          const ok = last.type === 'http' ? !last.error : last.type === 'ssh' || last.type === 'copy' ? true : last.type === 'ssh-denied' ? false : last.ok;
          const err = last.error || (last.type === 'ssh-denied' ? 'denied' : null);
          color = ok ? 'var(--ok)' : err === 'ETIMEDOUT' ? 'var(--warn)' : 'var(--bad)';
          dash = null;
          label = last.type === 'http' ? (last.error ? { ECONNREFUSED: 'refused', ETIMEDOUT: 'timed out', ENOTFOUND: 'no DNS' }[last.error] || last.error : `HTTP ${last.status}`) : last.type === 'ssh' ? 'ssh ✓' : last.type === 'ssh-denied' ? 'ssh denied' : last.type === 'ping' ? (ok ? 'ping ✓' : 'no reply') : last.type === 'copy' ? last.tool : (ok ? `:${last.port} open` : `:${last.port} ${err === 'ETIMEDOUT' ? 'filtered' : 'closed'}`);
        }
      }
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
      s.append(svg('path', { d: `M${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`, stroke: color, 'stroke-width': dash ? 1.5 : 3, fill: 'none', 'stroke-dasharray': dash }));
      if (label) s.append(svg('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle', fill: color, 'font-size': 12, 'font-weight': 700, 'font-family': 'var(--font-mono)', text: label }));
    }
    for (const x of hosts) {
      const p = pos.get(x.name);
      if (!p) continue;
      const here = x === sh.host;
      s.append(svg('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 10, fill: 'var(--surface)', stroke: here ? 'var(--accent)' : 'var(--line-strong)', 'stroke-width': here ? 2.5 : 1.4 }));
      s.append(svg('text', { x: p.x + 12, y: p.y + 20, fill: 'var(--text)', 'font-weight': 700, 'font-size': 14, 'font-family': 'var(--font-display)', text: x.name + (here ? '  ●' : '') }));
      s.append(svg('text', { x: p.x + 12, y: p.y + 36, fill: 'var(--muted)', 'font-size': 11.5, 'font-family': 'var(--font-mono)', text: x.ip }));
      if (x.firewall.enabled) s.append(svg('text', { x: p.x + p.w - 12, y: p.y + 20, 'text-anchor': 'end', fill: 'var(--warn)', 'font-size': 11, 'font-family': 'var(--font-body)', 'font-weight': 700, text: '⛨ ufw' }));
      const ports = [...x.listening].filter(([, l]) => x.procs.has(l.pid)).map(([port, l]) => ({ port, local: l.addr === '127.0.0.1', blocked: x.firewall.enabled && !fwAllows(x, port) })).sort((m, n) => m.port - n.port).slice(0, 6);
      let cx = p.x + 12;
      for (const pt of ports) {
        const label = String(pt.port);
        const w = 8 + label.length * 7.4;
        if (cx + w > p.x + p.w - 6) break;
        s.append(svg('rect', { x: cx, y: p.y + 46, width: w, height: 18, rx: 9, fill: pt.local ? 'var(--surface-2)' : pt.blocked ? 'var(--warn-soft)' : 'var(--ok-soft, var(--surface-2))', stroke: pt.local ? 'var(--line)' : pt.blocked ? 'var(--warn)' : 'var(--ok)', 'stroke-width': 1 }));
        s.append(svg('text', { x: cx + w / 2, y: p.y + 59, 'text-anchor': 'middle', fill: 'var(--text)', 'font-size': 11, 'font-family': 'var(--font-mono)', text: label }));
        cx += w + 5;
      }
    }
    this.el.append(h('div', { class: 'netmap-svg' }, s));
    this.el.append(h('p', { class: 'meta', style: { margin: '6px 0 0' } }, 'Port chips: green = reachable from other machines, grey = localhost only, amber = blocked by the firewall. The line shows your latest connection attempt.'));
    const names = [...uni.dns].filter(([n]) => n.includes('.') && !hosts.some(x => x.name === n));
    if (names.length || uni.dnsRecords) {
      const rows = [...names.map(([n, ip]) => [n, 'A', ip]), ...Object.entries(uni.dnsRecords || {}).flatMap(([n, r]) => Object.entries(r).filter(([t]) => t !== 'A').map(([t, v]) => [n, t, [].concat(v).join(', ')]))];
      this.el.append(h('section', { class: 'gh-section', style: { marginTop: '10px' } }, h('h5', {}, 'DNS records'),
        h('ul', { class: 'gh-list' }, rows.map(([n, t, v]) => h('li', {}, h('div', { class: 'row' }, h('span', { class: 'mono' }, n), h('span', { class: 'meta mono' }, `${t} → ${v}${t === 'A' && uni.byIp.get(v) ? ` (${uni.byIp.get(v).name})` : ''}`)))))));
    }
  }
}

function fwAllows(host, port) {
  const fw = host.firewall;
  for (const r of fw.rules) if ((r.port === port || r.ports?.includes(port)) && (!r.from || r.from === 'any')) return r.action === 'allow';
  return fw.defaultIn === 'allow';
}
function hostByName(uni, name, from) { const ip = uni.resolveName(name, from); return ip ? uni.byIp.get(ip) || (ip === '127.0.0.1' ? from : null) : null; }
function hostOfUrl(uni, url, from) { const m = String(url).match(/^(?:https?:\/\/)?([^/:]+)/); return m ? hostByName(uni, m[1], from) : null; }
