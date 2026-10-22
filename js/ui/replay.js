// Stepped replays embedded in lessons. Each step runs real commands in a freshly built
// simulated world (a sandbox scenario), so what you see is exactly what the simulator does.
//
//   ```replay
//   title: Following a request
//   scenario: webstack            (a sandbox scenario; default: laptop)
//   show: network                 (network | system | files | none)
//   setup: commands run first, not shown; separated by ;
//   step: curl -I http://shop.example.com | caption shown under the output
//   ```

import { h, clear } from './dom.js';
import { ansiToHtml } from './ansi.js';
import { stripAnsi } from '../git/world.js';
import { SystemView, FileTreeView, NetworkView } from './devpanels.js';
import { buildLabWorld } from '../lab.js';
import { SCENARIOS } from '../content/sandbox.js';
import { extraPanels } from './panelRegistry.js';

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

export function replayWorld(spec) {
  const sc = SCENARIOS[spec.scenario || 'laptop'] || SCENARIOS.laptop;
  const built = buildLabWorld({ ...sc, cwd: spec.cwd || sc.cwd });
  built.sh.advancePerCommand = 0;
  for (const line of spec.setup || []) built.sh.run(line, { record: false });
  return built;
}

export class Replay {
  constructor(spec) {
    this.spec = spec;
    this.step = 0;
    this.el = h('figure', { class: 'replay', style: { margin: 0 } });
    const show = (spec.show || 'none').trim();
    const panels = { network: () => new NetworkView(), system: () => new SystemView(), files: () => new FileTreeView() };
    for (const [k, make] of Object.entries(extraPanels)) panels[k] = () => make.create({ onAction: () => {}, lab: null, compact: true });
    this.panel = panels[show] ? panels[show]() : null;
    this.build();
    this.go(0);
  }

  build() {
    this.stepDots = h('span', { class: 'replay-steps', 'aria-hidden': 'true' }, this.spec.steps.map(() => h('i')));
    this.prev = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.go(this.step - 1), 'aria-label': 'Previous step' }, '← Back');
    this.next = h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => this.go(this.step + 1), 'aria-label': 'Next step' }, 'Step →');
    this.counter = h('span', { style: { fontSize: '.82rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' } });
    this.el.append(h('div', { class: 'replay-head' },
      h('span', { class: 't' }, this.spec.title || 'Watch it happen'),
      h('span', { class: 'replay-controls' }, this.stepDots, this.counter, this.prev, this.next)));
    this.cmdEl = h('div', { class: 'replay-cmd replay-term', 'aria-live': 'polite' });
    this.views = h('div', { class: 'replay-views' });
    if (this.panel) this.views.append(this.panel.el);
    this.caption = h('figcaption', { class: 'replay-caption' });
    this.el.append(h('div', { class: 'replay-body' }, this.cmdEl, this.panel ? this.views : null, this.caption));
  }

  go(n) {
    const steps = this.spec.steps;
    n = Math.max(0, Math.min(steps.length, n));
    this.step = n;
    const { uni, sh } = replayWorld(this.spec);
    let lastOut = [], prompt = '', cmd = '';
    for (let i = 0; i < n; i++) {
      const p = sh.prompt();
      prompt = `${p.user}@${p.host}:${p.path}${p.root ? '#' : '$'} `;
      cmd = steps[i].cmd;
      const r = sh.run(cmd, { record: false });
      lastOut = r.out;
      if (r.editor) { const save = steps[i].edit; if (save !== undefined) lastOut = sh.resolveEditor(r.editor, save).out; }
    }
    clear(this.cmdEl);
    if (n === 0) this.cmdEl.innerHTML = `<span class="p"># ${esc(this.spec.intro || 'Starting point. Press Step to run the first command.')}</span>`;
    else {
      const max = Number(this.spec.lines || 14);
      this.cmdEl.innerHTML = `<span class="pr">${esc(prompt)}</span>${ansiToHtml(cmd)}` +
        (lastOut.length ? '\n' + lastOut.slice(0, max).map(l => ansiToHtml(l)).join('\n') + (lastOut.length > max ? `\n<span class="p">… (${lastOut.length - max} more lines)</span>` : '') : '');
    }
    this.caption.textContent = n === 0 ? (this.spec.caption || '') : steps[n - 1].caption;
    try { this.panel?.render(sh, uni); } catch (e) { console.error(e); }
    [...this.stepDots.children].forEach((d, i) => d.classList.toggle('on', i < n));
    this.counter.textContent = `${n}/${steps.length}`;
    this.prev.disabled = n === 0;
    this.next.disabled = n === steps.length;
    this.next.textContent = n === steps.length ? 'Done' : 'Step →';
    void stripAnsi;
  }
}

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
