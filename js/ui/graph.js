// SVG commit graph. Newest commit on top, lanes on the left, refs and messages on the right.
// Commits that are no longer reachable from any ref but still in the reflog are drawn faded,
// which makes reset/reflog lessons visible.

import { svg, h, clear } from './dom.js';
import { revList, headCommit, currentBranch, headRef } from '../git/core.js';
import { shortHash } from '../git/world.js';

const ROW = 36, LANE = 22, PAD = 18, R = 7;
const LANE_COLORS = ['var(--main)', 'var(--feat)', 'var(--remote)', 'var(--info)', 'var(--accent)', 'var(--ok)'];

export class GraphView {
  constructor({ showOrphans = true, maxCommits = 60, emptyText = 'No commits yet. Your first commit will appear here.' } = {}) {
    this.el = h('div', { class: 'graph-wrap graph' });
    this.seen = new Set();
    this.showOrphans = showOrphans;
    this.maxCommits = maxCommits;
    this.emptyText = emptyText;
  }

  render(repo, { title = null } = {}) {
    clear(this.el);
    if (!repo) { this.el.append(h('div', { class: 'graph-empty' }, 'Not inside a git repository. Run git init or cd into a project.')); return; }
    const w = repo.world;
    const refs = Object.entries(repo.refs).filter(([r]) => r !== 'refs/stash');
    const heads = refs.map(([, hsh]) => w.peel(hsh));
    const head = headCommit(repo);
    if (head) heads.push(head);
    if (repo.state?.mergeHead) heads.push(repo.state.mergeHead);
    const reachable = new Set(revList(w, [...new Set(heads)]));
    let orphans = [];
    if (this.showOrphans && !repo.bare) {
      for (const e of (repo.reflog.HEAD || []).slice(0, 12)) {
        if (e.new && !reachable.has(e.new) && w.objects.get(e.new)?.type === 'commit') orphans.push(e.new);
      }
    }
    const all = revList(w, [...new Set([...heads, ...orphans])]).slice(0, this.maxCommits);
    if (!all.length) {
      this.el.append(h('div', { class: 'graph-empty' }, title ? `${title}: ${this.emptyText}` : this.emptyText));
      return;
    }
    const orphanSet = new Set(all.filter(c => !reachable.has(c)));

    // mainline: first-parent chain of main/master (or current branch)
    const mainRef = ['refs/heads/main', 'refs/heads/master'].find(r => repo.refs[r]) || headRef(repo);
    const mainline = new Set();
    let m = mainRef ? repo.refs[mainRef] : head;
    while (m && all.includes(m)) { mainline.add(m); m = w.commit(m).parents[0]; }

    const inSet = new Set(all);
    const lane = new Map();
    const lanes = [null];
    for (const c of all) {
      let l;
      if (mainline.has(c)) l = 0;
      else {
        l = lanes.findIndex((x, i) => i > 0 && x === c);
        if (l === -1) { l = lanes.findIndex((x, i) => i > 0 && x === null); if (l === -1) { lanes.push(null); l = lanes.length - 1; } }
        for (let i = 1; i < lanes.length; i++) if (i !== l && lanes[i] === c) lanes[i] = null;
      }
      lane.set(c, l);
      const ps = w.commit(c).parents.filter(p => inSet.has(p));
      if (l > 0) lanes[l] = ps[0] && !mainline.has(ps[0]) ? ps[0] : null;
      for (const p of ps.slice(1)) {
        if (mainline.has(p) || lanes.includes(p) || lane.has(p)) continue;
        let free = lanes.findIndex((x, i) => i > 0 && x === null);
        if (free === -1) { lanes.push(null); free = lanes.length - 1; }
        lanes[free] = p;
      }
    }
    const nLanes = Math.max(1, ...[...lane.values()].map(v => v + 1));
    const row = new Map(all.map((c, i) => [c, i]));
    const x = c => PAD + lane.get(c) * LANE;
    const y = c => PAD + row.get(c) * ROW;
    const textX = PAD + nLanes * LANE + 8;

    // refs per commit
    const labels = new Map();
    const add = (c, label) => { if (!labels.has(c)) labels.set(c, []); labels.get(c).push(label); };
    const cur = currentBranch(repo);
    if (!repo.bare && head && !cur) add(head, { kind: 'head', text: 'HEAD' });
    for (const [r, hsh] of refs) {
      const c = w.peel(hsh);
      if (r.startsWith('refs/heads/')) {
        const name = r.slice(11);
        add(c, { kind: name === cur && !repo.bare ? 'current' : 'branch', text: name === cur && !repo.bare ? `HEAD → ${name}` : name });
      } else if (r.startsWith('refs/remotes/')) { if (!r.endsWith('/HEAD')) add(c, { kind: 'remote', text: r.slice(13) }); }
      else if (r.startsWith('refs/tags/')) add(c, { kind: 'tag', text: 'tag: ' + r.slice(10) });
    }
    if (repo.stash?.length) add(w.commit(repo.stash[0].hash).parents[0], { kind: 'stash', text: `stash (${repo.stash.length})` });
    if (repo.state?.mergeHead) add(repo.state.mergeHead, { kind: 'stash', text: 'MERGE_HEAD' });

    const width = textX + 520;
    const height = PAD * 2 + (all.length - 1) * ROW + 4;
    const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Commit graph with ${all.length} commits` });
    const color = c => LANE_COLORS[lane.get(c) % LANE_COLORS.length];

    // edges
    for (const c of all) {
      const ps = w.commit(c).parents;
      ps.forEach((p, i) => {
        if (!inSet.has(p)) {
          root.append(svg('path', { class: 'g-edge', d: `M${x(c)} ${y(c)} L${x(c)} ${y(c) + ROW * 0.6}`, stroke: color(c), 'stroke-dasharray': '3 3', opacity: .6 }));
          return;
        }
        const x1 = x(c), y1 = y(c), x2 = x(p), y2 = y(p);
        let d;
        if (x1 === x2) d = `M${x1} ${y1} L${x2} ${y2}`;
        else if (i === 0 && lane.get(c) > lane.get(p)) {
          // branch leaves its parent: curve near the parent
          d = `M${x1} ${y1} L${x1} ${y2 - ROW * 0.55} Q${x1} ${y2 - 4} ${x2} ${y2}`;
        } else {
          // merge edge: curve near the child
          d = `M${x1} ${y1} Q${x2} ${y1 + 4} ${x2} ${y1 + ROW * 0.55} L${x2} ${y2}`;
        }
        const strokeLane = i === 0 && lane.get(c) >= lane.get(p) ? color(c) : color(p);
        root.append(svg('path', { class: 'g-edge' + (orphanSet.has(c) ? ' g-orphan' : ''), d, stroke: i > 0 ? color(p) : strokeLane }));
      });
    }

    // nodes + text
    for (const c of all) {
      const commit = w.commit(c);
      const isNew = !this.seen.has(c) && this.seen.size > 0;
      const g = svg('g', { class: (orphanSet.has(c) ? 'g-orphan ' : '') + (isNew ? 'g-new' : '') });
      const isHead = c === head && !repo.bare;
      const merge = commit.parents.length > 1;
      g.append(svg('circle', { class: 'g-node' + (isHead ? ' is-head' : ''), cx: x(c), cy: y(c), r: merge ? R + 1 : R, fill: merge ? 'var(--surface)' : color(c), stroke: isHead ? null : color(c) }));
      if (merge) g.append(svg('circle', { cx: x(c), cy: y(c), r: 3, fill: color(c) }));
      let tx = textX;
      for (const lab of labels.get(c) || []) {
        const wdt = lab.text.length * 6.6 + 14;
        g.append(svg('g', { class: `g-ref k-${lab.kind}` },
          svg('rect', { x: tx, y: y(c) - 10, width: wdt, height: 20, rx: 10 }),
          svg('text', { x: tx + 7, y: y(c) + 4, text: lab.text })));
        tx += wdt + 6;
      }
      g.append(svg('text', { class: 'g-hash', x: tx, y: y(c) + 4, text: shortHash(c) }));
      const msg = commit.message.split('\n')[0];
      g.append(svg('text', { class: 'g-msg', x: tx + 60, y: y(c) + 4, text: msg.length > 56 ? msg.slice(0, 55) + '…' : msg + (orphanSet.has(c) ? '   (unreachable: only the reflog remembers it)' : '') }));
      const t = svg('title', { text: `${c}\n${commit.author.name}\n${commit.message}` });
      g.append(t);
      root.append(g);
    }
    for (const c of all) this.seen.add(c);
    this.el.append(root);
  }
}
