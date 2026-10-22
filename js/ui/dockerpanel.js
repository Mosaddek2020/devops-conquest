// The Docker panel: what the engine on a machine holds right now. Running containers with
// their published ports and networks, images with a size bar and their layers, and the
// volumes that keep data when containers come and go.

import { h, clear } from './dom.js';
import { registerPanel } from './panelRegistry.js';
import { fmtMB } from '../sim/docker-images.js';

function engineHost(sh, uni, pick) {
  if (pick && uni.host(pick)?.docker) return uni.host(pick);
  let host = sh.host;
  // inside a container: show the machine that runs it
  if (host.kind === 'container') for (const x of uni.hosts.values()) if (x.docker && [...x.docker.containers.values()].some(c => c.h === host)) return x;
  if (host.docker) return host;
  return [...uni.hosts.values()].find(x => x.docker && !x.hidden) || host;
}

const statusDot = c => c.status === 'running' ? (c.health === 'unhealthy' ? 'bad' : c.health === 'starting' ? 'warn' : 'ok') : c.exitCode ? 'bad' : 'off';

export class DockerView {
  constructor() { this.el = h('div', { class: 'sys dock' }); this.pick = null; this.open = new Set(); }
  render(sh, uni) {
    clear(this.el);
    const host = engineHost(sh, uni, this.pick);
    const eng = host.docker;
    const choices = [...uni.hosts.values()].filter(x => x.docker && !x.hidden);
    this.el.append(h('div', { class: 'sys-head' },
      h('div', {}, h('div', { class: 'sys-name' }, `Docker on ${host.name}`),
        h('div', { class: 'meta' }, eng ? `${eng.containers.size} containers · ${eng.images.size} images · ${eng.volumes.size} volumes` : 'Docker is not installed here.')),
      choices.length > 1 ? h('select', { class: 'gh-select', 'aria-label': 'Choose a Docker host', onchange: e => { this.pick = e.target.value; this.render(sh, uni); } },
        choices.map(x => h('option', { value: x.name, selected: x === host }, x.name))) : null));
    if (!eng) { this.el.append(h('div', { class: 'gh-empty' }, 'Install it with: sudo apt install -y docker.io')); return; }

    // containers
    const ctrs = [...eng.containers.values()].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.created - a.created);
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `Containers (${ctrs.filter(c => c.status === 'running').length} running)`),
      ctrs.length ? h('ul', { class: 'gh-list' }, ctrs.map(c => h('li', { class: sh.host === c.h ? 'dock-here' : null },
        h('div', { class: 'row' },
          h('span', { class: 'dock-name' }, h('i', { class: 'dot dot-' + statusDot(c), 'aria-hidden': 'true' }), h('strong', {}, c.name), h('span', { class: 'meta mono' }, ` ${c.imageRef}`)),
          h('span', { class: 'meta' }, c.status === 'running' ? `up${c.health ? ` · ${c.health}` : ''}${c.restarts ? ` · ${c.restarts} restarts` : ''}` : c.status === 'created' ? 'created' : `exited (${c.exitCode})${c.oom ? ' · OOM' : ''}`)),
        h('div', { class: 'dock-tags' },
          c.ports.map(p => h('span', { class: 'pill ' + (c.status === 'running' ? 'pill-ok' : '') }, `${host.name}:${p.host} → ${p.container}`)),
          h('span', { class: 'pill' }, `net: ${c.network}`),
          c.ip && c.status === 'running' ? h('span', { class: 'pill mono' }, c.ip) : null,
          c.volumes.map(v => h('span', { class: 'pill pill-accent' }, `${v.type === 'volume' ? v.source : 'bind ' + v.source.split('/').pop()} → ${v.target}`)),
          c.user && c.user !== 'root' ? h('span', { class: 'pill' }, `user ${c.user}`) : c.status === 'running' ? h('span', { class: 'pill pill-warn' }, 'runs as root')  : null,
          sh.host === c.h ? h('span', { class: 'pill pill-accent' }, 'you are inside') : null)))) : h('div', { class: 'gh-empty' }, 'No containers yet. Try: docker run -d -p 8080:80 nginx')));

    // images
    const imgs = [...eng.images.values()].sort((a, b) => b.created - a.created);
    const max = Math.max(1, ...imgs.map(i => i.sizeMB));
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `Images (${imgs.length})`),
      imgs.length ? h('ul', { class: 'gh-list' }, imgs.map(img => {
        const name = [...img.tags][0] || `<none> ${img.id.slice(0, 12)}`;
        const isOpen = this.open.has(img.id);
        return h('li', {},
          h('button', { class: 'dock-img', type: 'button', 'aria-expanded': String(isOpen), onclick: () => { isOpen ? this.open.delete(img.id) : this.open.add(img.id); this.render(sh, uni); } },
            h('span', { class: 'row' }, h('span', { class: 'mono dock-tag' }, `${isOpen ? '▾' : '▸'} ${name}`), h('span', { class: 'meta mono' }, `${fmtMB(img.sizeMB)} · ${img.layers.length} layers`)),
            h('span', { class: 'sys-track' }, h('span', { class: img.sizeMB > 500 ? 'bad' : img.sizeMB > 200 ? 'warn' : 'ok', style: { width: `${Math.max(2, (img.sizeMB / max) * 100)}%` } }))),
          isOpen ? h('ol', { class: 'dock-layers' }, [...img.layers].reverse().map(l => h('li', {}, h('span', { class: 'mono' }, l.by.length > 70 ? l.by.slice(0, 70) + '…' : l.by), h('span', { class: 'meta mono' }, fmtMB(l.sizeMB))))) : null);
      })) : h('div', { class: 'gh-empty' }, 'No images. docker pull or docker build adds them.')));

    // networks and volumes
    const nets = [...eng.networks.values()].filter(n => !['host', 'none'].includes(n.name));
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Networks'),
      h('ul', { class: 'gh-list' }, nets.map(n => {
        const members = ctrs.filter(c => c.network === n.name && c.status === 'running');
        return h('li', {}, h('div', { class: 'row' }, h('span', {}, h('strong', { class: 'mono' }, n.name), h('span', { class: 'pill', style: { marginLeft: '8px' } }, n.dns ? 'names resolve' : 'no name lookup')), h('span', { class: 'meta mono' }, members.map(c => c.name).join(', ') || 'empty')));
      }))));
    if (eng.volumes.size) this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Volumes'),
      h('ul', { class: 'gh-list' }, [...eng.volumes.values()].map(v => {
        const users = ctrs.filter(c => c.volumes.some(x => x.source === v.name));
        const files = Object.values(v.files || {}).filter(f => !f.dir).length;
        return h('li', {}, h('div', { class: 'row' }, h('strong', { class: 'mono' }, v.name), h('span', { class: 'meta' }, `${files} files · ${users.length ? 'used by ' + users.map(c => c.name).join(', ') : 'not in use (data kept)'}`)));
      }))));
  }
}

registerPanel('docker', 'Docker', () => new DockerView());
