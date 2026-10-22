// Stepped replays embedded in lessons. Each step runs real commands in a fresh simulated
// world, so the graph you see is exactly what git would do.
//
// Macros (in setup and steps):
//   init                         git init in ~/project
//   commit "msg" [file]          append to a file and commit it (file defaults to a slug of msg)
//   github owner/name            create a GitHub repo with an initial commit
//   teammate owner/name "msg" [file]   a teammate pushes a commit to main

import { h, clear } from './dom.js';
import { ansiToHtml } from './ansi.js';
import { GraphView } from './graph.js';
import { AreasView } from './panels.js';
import { World, stripAnsi } from '../git/world.js';
import { Shell } from '../git/shell.js';
import { seedRemote, teammateCommit } from '../git/github.js';

export function splitTop(line) {
  const parts = [];
  let cur = '', q = null;
  for (const ch of line) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ';') { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'file';

export function expand(seg, world, shell) {
  let m;
  if (seg === 'init') return { cmd: 'mkdir -p ~/project && cd ~/project && git init -q -b main', shown: 'git init' };
  if ((m = seg.match(/^commit\s+"([^"]+)"(?:\s+(\S+))?$/))) {
    const file = m[2] || slug(m[1]) + '.txt';
    return { cmd: `echo "${m[1]}" >> ${file} && git add -A && git commit -q -m "${m[1]}"`, shown: `git add ${file} && git commit -m "${m[1]}"` };
  }
  if ((m = seg.match(/^github\s+(\S+)\/(\S+)$/))) {
    seedRemote(world, m[1], m[2], [{ message: 'Initial commit', files: { 'README.md': `# ${m[2]}\n` } }], { collaborators: ['you'] });
    return { cmd: '', shown: `(on GitHub: ${m[1]}/${m[2]} exists with one commit)` };
  }
  if ((m = seg.match(/^teammate\s+(\S+)\s+"([^"]+)"(?:\s+(\S+))?$/))) {
    teammateCommit(world, `https://github.com/${m[1]}.git`, { files: { [m[3] || slug(m[2]) + '.txt']: m[2] + '\n' }, message: m[2] });
    return { cmd: '', shown: `(a teammate pushes "${m[2]}" to GitHub)` };
  }
  void shell;
  return { cmd: seg, shown: seg };
}

export class Replay {
  constructor(spec) {
    this.spec = spec;
    this.step = 0;
    this.el = h('figure', { class: 'replay', style: { margin: 0 } });
    this.show = (spec.show || 'graph').split(',').map(s => s.trim());
    this.graph = new GraphView({ maxCommits: 30 });
    this.areas = new AreasView();
    this.build();
    this.go(0);
  }

  build() {
    const total = this.spec.steps.length;
    this.stepDots = h('span', { class: 'replay-steps', 'aria-hidden': 'true' }, this.spec.steps.map(() => h('i')));
    this.prev = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.go(this.step - 1), 'aria-label': 'Previous step' }, '← Back');
    this.next = h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => this.go(this.step + 1), 'aria-label': 'Next step' }, 'Step →');
    this.counter = h('span', { style: { fontSize: '.82rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' } });
    this.el.append(h('div', { class: 'replay-head' },
      h('span', { class: 't' }, this.spec.title || 'Watch it happen'),
      h('span', { class: 'replay-controls' }, this.stepDots, this.counter, this.prev, this.next)));
    this.cmdEl = h('div', { class: 'replay-cmd', 'aria-live': 'polite' });
    this.views = h('div', { class: 'replay-views' + (this.show.length > 1 ? ' two' : '') });
    if (this.show.includes('graph')) this.views.append(this.graph.el);
    if (this.show.includes('areas')) this.views.append(this.areas.el);
    this.caption = h('figcaption', { class: 'replay-caption' });
    this.el.append(h('div', { class: 'replay-body' }, this.cmdEl, this.views, this.caption));
    void total;
  }

  go(n) {
    const steps = this.spec.steps;
    n = Math.max(0, Math.min(steps.length, n));
    this.step = n;
    const world = new World({ time: 1767258000 });
    const shell = new Shell(world);
    world.dirs.add('/home/dev/project');
    shell.cwd = '/home/dev/project';
    const runSeg = (seg) => {
      const { cmd } = expand(seg, world, shell);
      if (!cmd) return { out: [] };
      return shell.run(cmd, { record: false });
    };
    for (const seg of this.spec.setup) runSeg(seg);
    let lastOut = [], shown = [];
    for (let i = 0; i < n; i++) {
      lastOut = []; shown = [];
      for (const seg of splitTop(steps[i].cmd)) {
        const ex = expand(seg, world, shell);
        shown.push(ex.shown);
        if (ex.cmd) { const r = shell.run(ex.cmd, { record: false }); lastOut.push(...r.out); }
      }
    }
    clear(this.cmdEl);
    if (n === 0) this.cmdEl.innerHTML = `<span class="p"># starting point${this.spec.setup.length ? '' : ': an empty folder'}. Press Step to run the first command.</span>`;
    else {
      this.cmdEl.innerHTML = shown.map(s => `<span class="p">$ </span>${ansiToHtml(s)}`).join('\n') +
        (lastOut.length ? '\n' + lastOut.slice(0, 8).map(l => `<span class="p">${ansiToHtml(stripAnsi(l))}</span>`).join('\n') + (lastOut.length > 8 ? '\n<span class="p">…</span>' : '') : '');
    }
    this.caption.textContent = n === 0 ? (this.spec.intro || 'Starting point.') : steps[n - 1].caption;
    const repo = shell.repo;
    if (this.show.includes('graph')) this.graph.render(repo);
    if (this.show.includes('areas')) this.areas.render(repo);
    [...this.stepDots.children].forEach((d, i) => d.classList.toggle('on', i < n));
    this.counter.textContent = `${n}/${steps.length}`;
    this.prev.disabled = n === 0;
    this.next.disabled = n === steps.length;
    this.next.textContent = n === steps.length ? 'Done' : 'Step →';
  }
}
