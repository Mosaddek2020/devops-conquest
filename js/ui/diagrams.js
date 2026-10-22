// Named illustrations used by lessons (```diagram fences). All colours come from theme tokens.

import { svg, h } from './dom.js';

const T = { text: 'var(--text)', muted: 'var(--muted)', line: 'var(--line-strong)', surface: 'var(--surface)', s2: 'var(--surface-2)', main: 'var(--main)', feat: 'var(--feat)', remote: 'var(--remote)', info: 'var(--info)', accent: 'var(--accent)', ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)' };

function defs(id) {
  return svg('defs', {}, ...['text', 'main', 'feat', 'remote', 'info', 'accent', 'muted', 'ok', 'bad'].map(k =>
    svg('marker', { id: `${id}-${k}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      svg('path', { d: 'M0 0 L10 5 L0 10 z', fill: T[k] }))));
}

function mk(width, height, label) {
  const id = 'd' + Math.random().toString(36).slice(2, 7);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, role: 'img', 'aria-label': label, style: 'width:100%;height:auto' });
  root.append(defs(id));
  const api = {
    root, id,
    box(x, y, w, hgt, title, { sub = null, color = 'line', fill = 'surface', r = 10, dash = null, titleSize = 15, subSize = 12.5, align = 'middle' } = {}) {
      root.append(svg('rect', { x, y, width: w, height: hgt, rx: r, fill: T[fill] || fill, stroke: T[color] || color, 'stroke-width': 1.6, 'stroke-dasharray': dash }));
      const tx = align === 'start' ? x + 14 : x + w / 2;
      if (title) root.append(svg('text', { x: tx, y: sub ? y + hgt / 2 - 4 : y + hgt / 2 + 5, 'text-anchor': align, fill: T.text, 'font-family': 'var(--font-display)', 'font-weight': 700, 'font-size': titleSize, text: title }));
      if (sub) {
        const lines = sub.split('\n');
        lines.forEach((l, i) => root.append(svg('text', { x: tx, y: y + hgt / 2 + 14 + i * 15, 'text-anchor': align, fill: T.muted, 'font-family': 'var(--font-body)', 'font-size': subSize, text: l })));
      }
    },
    text(x, y, s, { size = 13, color = 'text', anchor = 'middle', weight = 400, font = 'body', italic = false } = {}) {
      root.append(svg('text', { x, y, 'text-anchor': anchor, fill: T[color] || color, 'font-size': size, 'font-weight': weight, 'font-family': font === 'mono' ? 'var(--font-mono)' : font === 'display' ? 'var(--font-display)' : 'var(--font-body)', 'font-style': italic ? 'italic' : null, text: s }));
    },
    arrow(x1, y1, x2, y2, { color = 'text', label = null, dy = -8, curve = 0, dash = null, width = 2, size = 12.5, labelColor = null, lx = null, ly = null } = {}) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const d = curve ? `M${x1} ${y1} Q${mx} ${my + curve} ${x2} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`;
      root.append(svg('path', { d, fill: 'none', stroke: T[color], 'stroke-width': width, 'marker-end': `url(#${id}-${color})`, 'stroke-dasharray': dash }));
      if (label) root.append(svg('text', { x: lx ?? mx, y: ly ?? (my + (curve ? curve / 2 : 0) + dy), 'text-anchor': 'middle', fill: T[labelColor || color], 'font-family': 'var(--font-mono)', 'font-size': size, 'font-weight': 600, text: label }));
    },
    line(x1, y1, x2, y2, { color = 'line', width = 2, dash = null } = {}) {
      root.append(svg('path', { d: `M${x1} ${y1} L${x2} ${y2}`, stroke: T[color] || color, 'stroke-width': width, fill: 'none', 'stroke-dasharray': dash }));
    },
    path(d, { color = 'line', width = 2.4, dash = null, fill = 'none' } = {}) {
      root.append(svg('path', { d, stroke: T[color] || color, 'stroke-width': width, fill, 'stroke-dasharray': dash }));
    },
    commit(x, y, { color = 'main', label = null, r = 9, hollow = false, below = false, size = 12 } = {}) {
      root.append(svg('circle', { cx: x, cy: y, r, fill: hollow ? T.surface : T[color], stroke: T[color], 'stroke-width': 2.5 }));
      if (label) root.append(svg('text', { x, y: below ? y + r + 16 : y - r - 8, 'text-anchor': 'middle', fill: T.muted, 'font-family': 'var(--font-mono)', 'font-size': size, text: label }));
    },
    tag(x, y, s, { color = 'main', solid = false, anchor = 'start' } = {}) {
      const w = s.length * 7.4 + 16;
      const x0 = anchor === 'middle' ? x - w / 2 : x;
      root.append(svg('rect', { x: x0, y: y - 11, width: w, height: 22, rx: 11, fill: solid ? T[color] : T.surface, stroke: T[color], 'stroke-width': 1.5 }));
      root.append(svg('text', { x: x0 + w / 2, y: y + 4.5, 'text-anchor': 'middle', fill: solid ? T.surface : T[color], 'font-family': 'var(--font-mono)', 'font-size': 12, 'font-weight': 600, text: s }));
      return w;
    },
  };
  return api;
}

function figure(d, caption) {
  return h('figure', { class: 'figure', style: { margin: 0 } }, d.root, caption ? h('figcaption', {}, caption) : null);
}

const D = {};

D['vcs-chaos'] = () => {
  const d = mk(720, 250, 'Manual versioning with copied files compared with a version history');
  d.text(170, 26, 'Without version control', { weight: 700, font: 'display', size: 15 });
  ['essay.docx', 'essay_v2.docx', 'essay_final.docx', 'essay_final_FIXED.docx', 'essay_final_REALLY_final.docx', 'essay (copy) (2).docx'].forEach((f, i) => {
    d.box(30, 44 + i * 32, 280, 26, null, { r: 5, fill: 's2' });
    d.text(44, 62 + i * 32, f, { anchor: 'start', font: 'mono', size: 12.5, color: i === 5 ? 'bad' : 'text' });
  });
  d.text(540, 26, 'With Git', { weight: 700, font: 'display', size: 15 });
  d.line(400, 120, 690, 120, { color: 'main', width: 3 });
  const msgs = ['First draft', 'Add sources', 'Rewrite intro', 'Fix typos', 'Final edit'];
  msgs.forEach((m, i) => { const x = 410 + i * 68; d.commit(x, 120, { color: i === 4 ? 'accent' : 'main' }); d.text(x, i % 2 ? 160 : 96, m, { size: 11.5, color: 'muted' }); });
  d.text(545, 210, 'one file, every version, with who, when and why', { size: 12.5, color: 'muted', italic: true });
  return figure(d, 'Left: copies with names that lie. Right: one file and a history that tells you exactly what changed.');
};

D['three-areas'] = () => {
  const d = mk(720, 300, 'The three areas of git: working directory, staging area, repository');
  d.box(20, 60, 200, 110, 'Working directory', { sub: 'the files you edit\nin your editor', color: 'feat' });
  d.box(260, 60, 200, 110, 'Staging area', { sub: 'the next commit,\nbeing assembled', color: 'warn' });
  d.box(500, 60, 200, 110, 'Repository', { sub: 'committed snapshots\nin .git', color: 'main' });
  d.arrow(222, 92, 256, 92, { color: 'ok', label: 'git add', lx: 239, ly: 48 });
  d.arrow(462, 92, 496, 92, { color: 'main', label: 'git commit', lx: 479, ly: 48 });
  d.arrow(256, 140, 222, 140, { color: 'muted', dash: '4 3' });
  d.arrow(496, 140, 462, 140, { color: 'muted', dash: '4 3' });
  d.text(239, 196, 'git restore <file>', { font: 'mono', size: 11.5, color: 'muted' });
  d.text(239, 212, '(throw the edit away)', { size: 11.5, color: 'muted' });
  d.text(479, 196, 'git restore --staged <file>', { font: 'mono', size: 11.5, color: 'muted' });
  d.text(479, 212, '(unstage, keep the edit)', { size: 11.5, color: 'muted' });
  d.path('M600 172 L600 252 L120 252 L120 176', { color: 'muted', width: 1.4, dash: '4 3' });
  d.root.append(svg('path', { d: 'M115 182 L120 172 L125 182', fill: 'none', stroke: T.muted, 'stroke-width': 1.4 }));
  d.text(360, 276, 'git switch / git checkout rewrite the working directory from a commit', { size: 11.5, color: 'muted' });
  return figure(d, 'Edits start in the working directory. git add copies them into the staging area. git commit turns the staging area into a permanent snapshot. The dashed arrows go the other way.');
};

D['snapshots'] = () => {
  const d = mk(720, 240, 'Commits store full snapshots; unchanged files are reused');
  const files = ['README.md', 'app.js', 'style.css'];
  const versions = [['A1', 'B1', 'C1'], ['A1', 'B2', 'C1'], ['A2', 'B2', 'C1'], ['A2', 'B3', 'C2']];
  versions.forEach((v, ci) => {
    const x = 40 + ci * 170;
    d.box(x, 30, 140, 190, `Commit ${ci + 1}`, { titleSize: 13 });
    v.forEach((f, fi) => {
      const changed = ci === 0 || versions[ci - 1][fi] !== f;
      d.box(x + 14, 70 + fi * 46, 112, 34, null, { r: 6, color: changed ? 'main' : 'line', dash: changed ? null : '4 3', fill: changed ? 'surface' : 's2' });
      d.text(x + 70, 84 + fi * 46, files[fi], { size: 11.5, font: 'mono' });
      d.text(x + 70, 98 + fi * 46, changed ? `new: ${f}` : `same as before`, { size: 10.5, color: changed ? 'main' : 'muted' });
    });
    if (ci) d.arrow(x - 28, 125, x - 4, 125, { color: 'muted' });
  });
  return figure(d, 'Each commit is a complete picture of the project. Files that did not change are not copied again: git points at the stored version it already has.');
};

D['git-vs-github'] = () => {
  const d = mk(720, 250, 'Git runs on your computer; GitHub hosts repositories online');
  d.box(30, 40, 290, 170, 'Your computer', { color: 'main' });
  d.box(55, 120, 240, 70, 'git', { sub: 'a program: tracks history\nworks offline, free, open source', color: 'main', fill: 's2', titleSize: 16 });
  d.box(400, 40, 290, 170, 'The internet', { color: 'remote' });
  d.box(425, 100, 115, 46, 'GitHub', { color: 'remote', fill: 's2', titleSize: 14 });
  d.box(552, 100, 115, 46, 'GitLab', { color: 'line', fill: 's2', titleSize: 14 });
  d.box(425, 154, 115, 40, 'Bitbucket', { color: 'line', fill: 's2', titleSize: 13 });
  d.box(552, 154, 115, 40, 'Azure Repos', { color: 'line', fill: 's2', titleSize: 13 });
  d.arrow(322, 108, 398, 108, { color: 'remote', label: 'git push' });
  d.arrow(398, 162, 322, 162, { color: 'remote', label: 'git pull / clone', dy: 18 });
  d.text(545, 232, 'hosts repositories + pull requests, issues, Actions…', { size: 12, color: 'muted' });
  return figure(d, 'Git is the tool. GitHub is one of several services that host git repositories and add collaboration features around them.');
};

D['commit-anatomy'] = () => {
  const d = mk(720, 250, 'What a commit contains');
  d.box(30, 30, 330, 190, null, { color: 'main' });
  const rows = [['tree', '7cde1b8…', 'the snapshot of every file'], ['parent', '98969a4…', 'the commit before this one'], ['author', 'Ada <ada@example.com>', 'who wrote it, and when'], ['committer', 'Ada <ada@example.com>', 'who recorded it'], ['message', 'Fix login timeout', 'why it changed']];
  rows.forEach(([k, v], i) => {
    d.text(48, 62 + i * 34, k, { anchor: 'start', font: 'mono', size: 13, color: 'main', weight: 600 });
    d.text(140, 62 + i * 34, v, { anchor: 'start', font: 'mono', size: 13 });
  });
  rows.forEach(([, , why], i) => d.text(400, 62 + i * 34, '← ' + why, { anchor: 'start', size: 13, color: 'muted' }));
  d.arrow(195, 222, 195, 242, { color: 'accent' });
  d.text(400, 244, 'SHA-1 of all of the above = the commit id 9fba052…', { anchor: 'start', size: 13, color: 'accent', weight: 700 });
  return figure(d, 'Change any part of a commit, even one letter of the message, and you get a different id. That is why history in git is tamper-evident.');
};

D['branch-pointer'] = () => {
  const d = mk(720, 230, 'Branches are pointers to commits and HEAD points at the current branch');
  d.line(60, 140, 460, 140, { color: 'main', width: 3 });
  ['a1f3', 'b7c9', 'c2d8', 'd4e0'].forEach((hh, i) => d.commit(80 + i * 120, 140, { label: hh, below: true }));
  d.path('M440 140 Q470 140 490 110 L560 110', { color: 'feat', width: 3 });
  d.commit(580, 110, { color: 'feat', label: 'e9f1', below: true });
  d.tag(410, 70, 'main', { color: 'main', anchor: 'middle' });
  d.arrow(440, 82, 440, 124, { color: 'main' });
  d.tag(580, 46, 'feature', { color: 'feat', anchor: 'middle' });
  d.arrow(580, 58, 580, 94, { color: 'feat' });
  d.tag(580, 16, 'HEAD', { color: 'accent', solid: true, anchor: 'middle' });
  d.arrow(580, 27, 580, 34, { color: 'accent' });
  d.text(160, 212, 'A branch is a 41-byte file holding a commit id. Creating one is instant.', { size: 12.5, color: 'muted' });
  return figure(d, 'main and feature are labels stuck on commits. HEAD is the "you are here" marker: it points at the branch you have checked out.');
};

D['reset-modes'] = () => {
  const d = mk(720, 250, 'What git reset changes in each mode');
  const cols = ['HEAD / branch', 'Staging area', 'Working directory'];
  const rows = [['--soft', [1, 0, 0]], ['--mixed (default)', [1, 1, 0]], ['--hard', [1, 1, 1]]];
  cols.forEach((c, i) => d.text(330 + i * 140, 40, c, { weight: 700, font: 'display', size: 14 }));
  rows.forEach(([name, cells], r) => {
    const y = 70 + r * 56;
    d.text(40, y + 26, name, { anchor: 'start', font: 'mono', size: 14, weight: 600, color: r === 2 ? 'bad' : 'text' });
    cells.forEach((on, i) => {
      d.box(270 + i * 140, y, 120, 40, on ? 'reset' : 'kept', { color: on ? (r === 2 && i === 2 ? 'bad' : 'warn') : 'ok', fill: 's2', titleSize: 13 });
    });
  });
  d.text(360, 244, '--hard is the only mode that can destroy uncommitted work.', { size: 12.5, color: 'bad' });
  return figure(d, 'Every mode moves the branch. --mixed also resets the staging area. --hard also overwrites your files.');
};

D['merge-types'] = () => {
  const d = mk(720, 270, 'Fast-forward merge compared with a three-way merge');
  d.text(170, 24, 'Fast-forward', { weight: 700, font: 'display', size: 15 });
  d.line(40, 80, 300, 80, { color: 'main', width: 3 });
  [60, 120].forEach(x => d.commit(x, 80));
  [180, 240].forEach(x => d.commit(x, 80, { color: 'feat' }));
  d.tag(120, 120, 'main (before)', { color: 'muted', anchor: 'middle' });
  d.tag(240, 120, 'main (after)', { color: 'main', anchor: 'middle', solid: true });
  d.text(170, 170, 'main had no new commits, so git', { size: 12.5, color: 'muted' });
  d.text(170, 186, 'just slides the label forward.', { size: 12.5, color: 'muted' });
  d.text(530, 24, 'Three-way merge', { weight: 700, font: 'display', size: 15 });
  d.line(400, 140, 660, 140, { color: 'main', width: 3 });
  [420, 480].forEach(x => d.commit(x, 140));
  d.commit(560, 140);
  d.path('M480 140 Q500 140 520 90 L580 90 Q610 90 640 140', { color: 'feat', width: 3 });
  [540, 600].forEach(x => d.commit(x, 90, { color: 'feat' }));
  d.commit(650, 140, { hollow: true, color: 'main', r: 11 });
  d.text(650, 178, 'merge commit', { size: 12, color: 'main' });
  d.text(650, 192, '(two parents)', { size: 12, color: 'muted' });
  d.text(480, 178, 'base', { size: 12, color: 'muted' });
  d.text(530, 236, 'Both sides moved. Git compares base, ours and theirs and', { size: 12.5, color: 'muted' });
  d.text(530, 252, 'records the result in a new commit with two parents.', { size: 12.5, color: 'muted' });
  return figure(d, 'Which kind of merge you get depends only on the shape of history, not on a setting (unless you pass --no-ff).');
};

D['conflict-anatomy'] = () => {
  const d = mk(720, 230, 'The parts of a merge conflict');
  const lines = [['<<<<<<< HEAD', 'bad'], ['  timeout: 30,', 'main'], ['=======', 'bad'], ['  timeout: 60,', 'remote'], ['>>>>>>> feature/slow-network', 'bad']];
  d.box(30, 20, 340, 190, null, { fill: 's2' });
  lines.forEach(([l, c], i) => d.text(50, 58 + i * 34, l, { anchor: 'start', font: 'mono', size: 14, color: c, weight: 600 }));
  const notes = ['start of YOUR version (the branch you are on)', 'what your branch has', 'divider', 'what the incoming branch has', 'end, with the name of the incoming branch'];
  notes.forEach((n, i) => { d.arrow(380, 54 + i * 34, 400, 54 + i * 34, { color: 'muted', width: 1.5 }); d.text(408, 58 + i * 34, n, { anchor: 'start', size: 12.5, color: 'muted' }); });
  return figure(d, 'Resolve by editing the file into the version you want, deleting all three marker lines, then git add the file.');
};

D['rebase-vs-merge'] = () => {
  const d = mk(720, 300, 'Merging compared with rebasing the same work');
  d.text(170, 24, 'git merge main', { weight: 700, font: 'mono', size: 14 });
  d.line(40, 90, 300, 90, { color: 'main', width: 3 });
  [60, 120, 180].forEach(x => d.commit(x, 90));
  d.path('M120 90 Q140 90 160 50 L230 50 Q260 50 280 90', { color: 'feat', width: 3 });
  [180, 230].forEach(x => d.commit(x, 50, { color: 'feat' }));
  d.commit(280, 90, { hollow: true, color: 'feat', r: 10 });
  d.text(170, 140, 'history shows what really happened,', { size: 12.5, color: 'muted' });
  d.text(170, 156, 'plus a merge commit', { size: 12.5, color: 'muted' });
  d.text(530, 24, 'git rebase main', { weight: 700, font: 'mono', size: 14 });
  d.line(400, 90, 680, 90, { color: 'main', width: 3 });
  [420, 480, 540].forEach(x => d.commit(x, 90));
  [600, 660].forEach(x => d.commit(x, 90, { color: 'feat', label: x === 600 ? "C'" : "D'" }));
  d.text(530, 140, 'commits are replayed on top: a straight', { size: 12.5, color: 'muted' });
  d.text(530, 156, 'line, but they get NEW ids', { size: 12.5, color: 'muted' });
  d.box(120, 200, 480, 74, 'The golden rule', { sub: 'Never rebase commits that other people already have.\nRebase your own local work; merge shared branches.', color: 'accent', fill: 's2' });
  return figure(d, 'Both end with the same files. They differ in how the history looks and whether commit ids change.');
};

D['remote-model'] = () => {
  const d = mk(720, 280, 'Local branches, remote-tracking branches and the remote repository');
  d.box(20, 30, 400, 230, 'Your laptop', { color: 'main', align: 'start' });
  d.box(40, 80, 160, 70, 'main', { sub: 'your branch', color: 'main', fill: 's2' });
  d.box(240, 80, 160, 70, 'origin/main', { sub: 'last known state\nof GitHub', color: 'remote', fill: 's2', dash: '5 3' });
  d.box(500, 30, 200, 230, 'GitHub (origin)', { color: 'remote', align: 'start' });
  d.box(520, 80, 160, 70, 'main', { sub: 'the shared branch', color: 'remote', fill: 's2' });
  d.arrow(518, 100, 402, 100, { color: 'remote', label: 'git fetch', dy: -8 });
  d.arrow(238, 118, 202, 118, { color: 'main', label: 'merge', dy: 22 });
  d.path('M120 152 Q120 230 360 230 Q600 230 600 154', { color: 'feat', width: 2 });
  d.root.append(svg('path', { d: 'M596 160 L600 152 L604 160', fill: 'none', stroke: T.feat, 'stroke-width': 2 }));
  d.text(360, 222, 'git push', { font: 'mono', size: 12.5, color: 'feat', weight: 600 });
  d.text(220, 196, 'git pull = git fetch + git merge (or rebase)', { size: 12.5, color: 'muted' });
  return figure(d, 'origin/main is a read-only bookmark of where GitHub\'s main was the last time you talked to it. Only fetch and pull update it.');
};

D['fork-triangle'] = () => {
  const d = mk(720, 300, 'Upstream, fork and local clone');
  d.box(250, 20, 220, 70, 'upstream', { sub: 'their-org/project (read-only to you)', color: 'remote' });
  d.box(30, 190, 220, 70, 'origin', { sub: 'you/project (your fork)', color: 'main' });
  d.box(470, 190, 220, 70, 'local', { sub: 'clone on your laptop', color: 'accent' });
  d.arrow(250, 70, 150, 186, { color: 'remote', label: 'fork (once, on GitHub)', lx: 150, ly: 120 });
  d.arrow(254, 228, 466, 228, { color: 'main', label: 'clone', dy: -8 });
  d.arrow(466, 246, 254, 246, { color: 'feat', label: 'git push origin feature', dy: 18 });
  d.arrow(170, 186, 300, 94, { color: 'feat', label: 'pull request', curve: -30, lx: 270, ly: 160 });
  d.arrow(470, 92, 580, 186, { color: 'remote', label: 'git fetch upstream', lx: 580, ly: 130 });
  return figure(d, 'You cannot push to someone else\'s repository, so you push to your fork and ask them to pull your work in.');
};

D['pr-lifecycle'] = () => {
  const d = mk(720, 210, 'The life of a pull request');
  const steps = [['Branch', 'git switch -c'], ['Commit', 'small, focused'], ['Push', 'git push -u'], ['Open PR', 'gh pr create'], ['Review + CI', 'comments, checks'], ['Merge', 'merge / squash'], ['Clean up', 'pull, delete branch']];
  steps.forEach(([t, s], i) => {
    const x = 14 + i * 100;
    d.box(x, 60, 92, 74, t, { sub: s, color: i === 5 ? 'remote' : i === 4 ? 'warn' : 'main', titleSize: 13.5, subSize: 11 });
    if (i) d.arrow(x - 7, 97, x - 1, 97, { color: 'muted' });
  });
  d.path('M460 136 Q460 180 380 180 Q300 180 300 136', { color: 'warn', width: 1.8, dash: '4 3' });
  d.text(380, 198, 'changes requested? commit + push again: the PR updates itself', { size: 12, color: 'warn' });
  return figure(d, 'A pull request is a conversation about a branch. Every push to that branch shows up in the PR.');
};

D['github-flow'] = () => {
  const d = mk(720, 200, 'GitHub flow: short-lived branches off main');
  d.line(30, 140, 690, 140, { color: 'main', width: 3 });
  [60, 300, 520, 660].forEach(x => d.commit(x, 140));
  const br = (x1, x2, y, label, color) => {
    d.path(`M${x1} 140 Q${x1 + 20} ${y} ${x1 + 50} ${y} L${x2 - 50} ${y} Q${x2 - 20} ${y} ${x2} 140`, { color, width: 2.6 });
    d.commit(x1 + 70, y, { color }); d.commit(x2 - 70, y, { color });
    d.text((x1 + x2) / 2, y - 16, label, { size: 12, color, font: 'mono' });
    d.commit(x2, 140, { hollow: true, color: 'main', r: 10 });
  };
  br(80, 300, 80, 'feature/login', 'feat');
  br(320, 520, 60, 'fix/typo', 'remote');
  br(420, 660, 100, 'feature/search', 'info');
  d.text(360, 186, 'main is always deployable · branch → PR → review → merge → deploy', { size: 12.5, color: 'muted' });
  return figure(d, 'One long-lived branch. Everything else is a short branch that lives for hours or days and merges back through a pull request.');
};

D['git-flow'] = () => {
  const d = mk(720, 300, 'Git flow branches');
  const lanes = [['main', 50, 'main'], ['hotfix/*', 100, 'bad'], ['release/*', 150, 'accent'], ['develop', 200, 'info'], ['feature/*', 250, 'feat']];
  lanes.forEach(([n, y, c]) => { d.text(16, y + 4, n, { anchor: 'start', font: 'mono', size: 12, color: c, weight: 600 }); d.line(110, y, 700, y, { color: c, width: 1, dash: '2 5' }); });
  d.line(130, 50, 690, 50, { color: 'main', width: 3 });
  d.line(130, 200, 690, 200, { color: 'info', width: 3 });
  [140, 420, 640].forEach(x => d.commit(x, 50, { label: x === 140 ? 'v1.0' : x === 420 ? 'v1.1' : 'v1.1.1', size: 11 }));
  d.path('M170 200 Q190 250 220 250 L300 250 Q330 250 350 200', { color: 'feat', width: 2.4 });
  [230, 290].forEach(x => d.commit(x, 250, { color: 'feat' }));
  d.commit(350, 200, { color: 'info' });
  d.path('M360 200 Q370 150 390 150 L400 150 Q410 150 420 50', { color: 'accent', width: 2.4 });
  d.commit(390, 150, { color: 'accent' });
  d.path('M400 150 Q440 150 460 200', { color: 'accent', width: 2.4 });
  d.path('M430 50 Q480 100 560 100 Q610 100 640 50', { color: 'bad', width: 2.4 });
  d.commit(560, 100, { color: 'bad' });
  d.path('M580 100 Q620 140 650 200', { color: 'bad', width: 2.4 });
  return figure(d, 'Git flow uses two permanent branches (main and develop) plus feature, release and hotfix branches. Powerful for versioned releases, heavy for teams that deploy daily.');
};

D['object-model'] = () => {
  const d = mk(720, 300, 'Git objects: commit, tree and blob');
  d.box(40, 30, 180, 80, 'commit 9fba052', { sub: 'tree 7cde1b8\nparent 98969a4', color: 'accent', titleSize: 13.5 });
  d.box(290, 30, 160, 80, 'tree 7cde1b8', { sub: 'README.md\nsrc/', color: 'main', titleSize: 13.5 });
  d.box(520, 20, 170, 56, 'blob a7a9b9b', { sub: '"# My App…"', color: 'info', titleSize: 13 });
  d.box(290, 170, 160, 70, 'tree 3f1c2aa', { sub: 'app.js', color: 'main', titleSize: 13.5 });
  d.box(520, 180, 170, 56, 'blob a57fd9c', { sub: '"console.log(1)…"', color: 'info', titleSize: 13 });
  d.arrow(222, 70, 286, 70, { color: 'accent' });
  d.arrow(452, 56, 516, 48, { color: 'main', label: 'README.md', dy: -6 });
  d.arrow(370, 112, 370, 166, { color: 'main', label: 'src/', dy: 0, lx: 395, ly: 144 });
  d.arrow(452, 205, 516, 208, { color: 'main', label: 'app.js', dy: -6 });
  d.arrow(130, 112, 130, 160, { color: 'muted', dash: '4 3', label: 'parent', lx: 160, ly: 140 });
  d.box(60, 160, 140, 40, 'commit 98969a4', { color: 'line', titleSize: 12.5, dash: '4 3' });
  d.text(360, 288, 'Every object is stored by the SHA-1 of its content in .git/objects/', { size: 12.5, color: 'muted' });
  return figure(d, 'A commit points to one tree (the project root). Trees point to blobs (file contents) and other trees (folders). Nothing points forward in time.');
};

D['ssh-keys'] = () => {
  const d = mk(720, 230, 'An SSH key pair: private key stays home, public key goes to GitHub');
  d.box(30, 40, 300, 150, 'Your laptop: ~/.ssh/', { color: 'main', align: 'start' });
  d.box(50, 90, 125, 70, 'id_ed25519', { sub: 'PRIVATE\nnever share', color: 'bad', fill: 's2', titleSize: 12.5 });
  d.box(190, 90, 125, 70, 'id_ed25519.pub', { sub: 'public\nsafe to share', color: 'ok', fill: 's2', titleSize: 12.5 });
  d.box(420, 40, 270, 150, 'GitHub → Settings → SSH keys', { color: 'remote', align: 'start', titleSize: 13.5 });
  d.box(450, 90, 210, 70, 'id_ed25519.pub', { sub: 'GitHub uses it to check\nthat you hold the private key', color: 'ok', fill: 's2', titleSize: 12.5 });
  d.arrow(318, 125, 446, 125, { color: 'ok', label: 'gh ssh-key add' });
  d.text(360, 220, 'Like a padlock (public) you can hand out and the one key (private) that opens it.', { size: 12.5, color: 'muted' });
  return figure(d, 'With SSH, your laptop proves who it is without sending a password.');
};

D['ci-pipeline'] = () => {
  const d = mk(720, 210, 'From push to status check');
  const s = [['git push', 'or open a PR', 'feat'], ['workflow', '.github/workflows/*.yml', 'info'], ['job', 'runs-on: ubuntu-latest', 'remote'], ['steps', 'checkout, install, test', 'main'], ['check', '✓ or ✗ on the PR', 'ok']];
  s.forEach(([t, sub, c], i) => { const x = 14 + i * 142; d.box(x, 60, 126, 80, t, { sub, color: c, subSize: 11, titleSize: 14 }); if (i) d.arrow(x - 14, 100, x - 2, 100, { color: 'muted' }); });
  d.text(360, 182, 'A required check that fails blocks the merge button.', { size: 12.5, color: 'muted' });
  return figure(d, 'GitHub Actions runs your workflow on a fresh virtual machine for every event you subscribe to.');
};

D['semver'] = () => {
  const d = mk(720, 200, 'Semantic versioning');
  d.text(360, 70, '2 . 4 . 1', { size: 54, font: 'display', weight: 800 });
  d.arrow(282, 90, 200, 140, { color: 'bad' }); d.arrow(360, 92, 360, 140, { color: 'warn' }); d.arrow(436, 90, 520, 140, { color: 'ok' });
  d.text(180, 162, 'MAJOR', { weight: 700, color: 'bad' }); d.text(180, 180, 'breaking changes', { size: 12.5, color: 'muted' });
  d.text(360, 162, 'MINOR', { weight: 700, color: 'warn' }); d.text(360, 180, 'new features, compatible', { size: 12.5, color: 'muted' });
  d.text(540, 162, 'PATCH', { weight: 700, color: 'ok' }); d.text(540, 180, 'bug fixes only', { size: 12.5, color: 'muted' });
  return figure(d, 'Tags like v2.4.1 mark releases. The number tells users whether upgrading can break them.');
};

D['bisect'] = () => {
  const d = mk(720, 230, 'Binary search through commits with git bisect');
  const n = 16;
  for (let r = 0; r < 4; r++) {
    const y = 40 + r * 46;
    const lo = [0, 8, 8, 10][r], hi = [15, 15, 11, 11][r];
    for (let i = 0; i < n; i++) {
      const inRange = i >= lo && i <= hi;
      d.commit(40 + i * 42, y, { r: 7, color: i === 10 && r === 3 ? 'bad' : inRange ? 'main' : 'line', hollow: !inRange });
    }
    d.text(706, y + 4, ['16 suspects', '8 left', '4 left', '2 left → found'][r], { anchor: 'end', size: 12, color: 'muted' });
  }
  d.text(40, 224, 'good', { size: 12, color: 'ok', anchor: 'start' });
  d.text(670, 224, 'bad', { size: 12, color: 'bad' });
  return figure(d, 'Each test halves the suspects. 1,000 commits need about 10 tests.');
};

D['undo-map'] = () => {
  const d = mk(720, 330, 'Choosing the right undo command');
  d.box(250, 10, 220, 46, 'What do you want to undo?', { color: 'accent', titleSize: 14 });
  const items = [
    ['An edit I have not staged', 'git restore <file>', 'feat'],
    ['Something I staged', 'git restore --staged <file>', 'warn'],
    ['My last commit (not pushed)', 'git commit --amend\ngit reset HEAD~1', 'info'],
    ['A commit others already have', 'git revert <commit>', 'remote'],
    ['A reset or deleted branch', 'git reflog → git reset/branch', 'main'],
  ];
  items.forEach(([q, a, c], i) => {
    const y = 80 + i * 48;
    d.box(20, y, 300, 38, q, { color: c, titleSize: 13 });
    d.arrow(322, y + 19, 382, y + 19, { color: c });
    d.box(386, y, 314, 38, null, { color: c, fill: 's2' });
    a.split('\n').forEach((l, k, arr) => d.text(543, y + 24 - (arr.length - 1) * 8 + k * 16, l, { font: 'mono', size: 12.5 }));
  });
  return figure(d, 'Rule of thumb: rewrite only what is still private to you. Once it is shared, add a new commit that undoes it.');
};

D['trunk-based'] = () => {
  const d = mk(720, 170, 'Trunk-based development');
  d.line(30, 100, 690, 100, { color: 'main', width: 3 });
  for (let i = 0; i < 12; i++) d.commit(50 + i * 56, 100, { r: 7 });
  [[78, 'feat'], [246, 'remote'], [414, 'info'], [582, 'feat']].forEach(([x, c]) => { d.path(`M${x} 100 Q${x + 10} 60 ${x + 28} 60 Q${x + 46} 60 ${x + 56} 100`, { color: c, width: 2.2 }); d.commit(x + 28, 60, { r: 6, color: c }); });
  d.text(360, 150, 'tiny branches (or direct commits) merged at least daily, unfinished work hidden behind feature flags', { size: 12.5, color: 'muted' });
  return figure(d, 'Everyone integrates into one trunk many times a day. It needs strong automated tests, and it keeps merges small.');
};

D['detached-head'] = () => {
  const d = mk(720, 200, 'Detached HEAD');
  d.line(60, 120, 520, 120, { color: 'main', width: 3 });
  ['a1', 'b2', 'c3', 'd4', 'e5'].forEach((l, i) => d.commit(80 + i * 105, 120, { label: l, below: true }));
  d.tag(500, 70, 'main', { color: 'main', anchor: 'middle' });
  d.arrow(500, 82, 500, 104, { color: 'main' });
  d.tag(290, 50, 'HEAD', { color: 'accent', solid: true, anchor: 'middle' });
  d.arrow(290, 62, 290, 104, { color: 'accent' });
  d.text(600, 70, 'HEAD points straight at', { size: 12.5, color: 'muted' });
  d.text(600, 86, 'a commit, not a branch', { size: 12.5, color: 'muted' });
  return figure(d, 'Looking around is safe. New commits made here belong to no branch until you create one with git switch -c.');
};

D['stash'] = () => {
  const d = mk(720, 200, 'git stash shelves work in progress');
  d.box(30, 50, 200, 90, 'Working directory', { sub: 'half-finished edits', color: 'feat' });
  d.box(490, 30, 200, 130, 'Stash (a stack)', { color: 'info' });
  ['stash@{0}  newest', 'stash@{1}', 'stash@{2}'].forEach((s, i) => d.box(510, 60 + i * 30, 160, 24, null, { r: 4, fill: 's2', color: 'info' }) || d.text(590, 77 + i * 30, s, { font: 'mono', size: 11.5 }));
  d.arrow(232, 78, 486, 78, { color: 'info', label: 'git stash' });
  d.arrow(486, 116, 232, 116, { color: 'ok', label: 'git stash pop', dy: 20 });
  d.text(360, 190, 'After git stash your working directory is clean, so you can switch branches.', { size: 12.5, color: 'muted' });
  return figure(d, 'The stash is a stack: the last thing you stash is the first thing pop gives back.');
};

D['cherry-pick'] = () => {
  const d = mk(720, 190, 'Cherry-picking one commit onto another branch');
  d.line(40, 130, 420, 130, { color: 'main', width: 3 });
  [60, 140, 220].forEach(x => d.commit(x, 130));
  d.path('M140 130 Q160 70 200 70 L420 70', { color: 'feat', width: 3 });
  [240, 320, 400].forEach((x, i) => d.commit(x, 70, { color: i === 1 ? 'accent' : 'feat', label: i === 1 ? 'fix' : null }));
  d.commit(300, 130, { color: 'accent', label: "fix'", below: true });
  d.arrow(320, 82, 304, 116, { color: 'accent', dash: '4 3' });
  d.tag(220, 170, 'main', { color: 'main', anchor: 'middle' });
  d.tag(460, 70, 'feature', { color: 'feat', anchor: 'start' });
  d.text(570, 120, 'Same change, new commit,', { size: 12.5, color: 'muted' });
  d.text(570, 136, 'new id.', { size: 12.5, color: 'muted' });
  return figure(d, 'git cherry-pick copies the change a commit made and applies it where you are.');
};

D['cd-pipeline'] = () => {
  const d = mk(720, 270, 'A delivery pipeline: merge to main deploys to staging, a version tag deploys to production after approval');
  d.text(20, 34, 'Every merge to main', { anchor: 'start', weight: 700, font: 'display', size: 14 });
  d.box(20, 50, 120, 56, 'push main', { sub: 'merged PR', color: 'main' });
  d.box(180, 50, 120, 56, 'test', { sub: 'npm test', color: 'info' });
  d.box(340, 50, 150, 56, 'deploy staging', { sub: 'automatic', color: 'feat' });
  d.arrow(142, 78, 176, 78, { color: 'text' });
  d.arrow(302, 78, 336, 78, { color: 'text' });
  d.box(540, 50, 160, 56, 'staging', { sub: 'staging.app.example', color: 'feat', fill: 's2' });
  d.arrow(492, 78, 536, 78, { color: 'feat' });
  d.text(20, 154, 'Every version tag (v*)', { anchor: 'start', weight: 700, font: 'display', size: 14 });
  d.box(20, 170, 120, 56, 'push v1.2.0', { sub: 'git tag', color: 'accent' });
  d.box(180, 170, 120, 56, 'test', { sub: 'same commit', color: 'info' });
  d.box(340, 170, 150, 56, 'approval', { sub: 'environment rule', color: 'warn', dash: '5 4' });
  d.box(540, 170, 160, 56, 'production', { sub: 'app.example', color: 'ok', fill: 's2' });
  d.arrow(142, 198, 176, 198, { color: 'text' });
  d.arrow(302, 198, 336, 198, { color: 'text' });
  d.arrow(492, 198, 536, 198, { color: 'ok' });
  d.text(20, 256, 'Each arrow between jobs is a needs: dependency. Rollback = run the production pipeline again on an older tag.', { anchor: 'start', size: 12, color: 'muted' });
  return figure(d, 'Continuous delivery: every change is proven and deployable; a person (or a rule) decides when it reaches production.');
};

export function renderDiagram(name) {
  const fn = D[name];
  if (!fn) return h('div', { class: 'figure' }, `Missing diagram: ${name}`);
  return fn();
}

export const diagramNames = Object.keys(D);
