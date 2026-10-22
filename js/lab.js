// Lab runner: builds a fresh simulated world for a lesson's lab, wires the terminal to
// the visual panels, and checks tasks (in order) after every command.

import { h, clear } from './ui/dom.js';
import { renderMarkdown } from './ui/markdown.js';
import { Terminal } from './ui/terminal.js';
import { GraphView } from './ui/graph.js';
import { AreasView, FilesView, GitHubView } from './ui/panels.js';
import { World, normPath, stripAnsi } from './git/world.js';
import { Shell } from './git/shell.js';
import { seedRemote, teammateCommit, reviewPR, createPR, mergePR, approveDeployment, currentDeployment, ensureEnvironment } from './git/github.js';
import { deployTo } from './git/actions.js';
import { computeStatus, headCommit, currentBranch, revList, resolve, isAncestor, branchNames, commitTreeFlat } from './git/core.js';

export function makeHelpers(world, shell) {
  const H = {
    world, shell,
    run(line) {
      const r = shell.run(line, { record: false });
      if (r.code && r.code !== 0 && !line.includes('|| true')) console.warn(`[setup] "${line}" exited ${r.code}:`, r.out.map(stripAnsi).join('\n'));
      return r;
    },
    cd(p) { shell.cwd = shell.resolvePath(p); },
    write(path, content) { world.writeFile(shell.resolvePath(path), content); },
    hours(n) { world.time += Math.round(n * 3600); },
    repo(path, { branch = 'main' } = {}) {
      const abs = shell.resolvePath(path);
      world.dirs.add(abs);
      shell.cwd = abs;
      H.run(`git init -q -b ${branch}`);
      return world.repos.get(abs);
    },
    commit(message, files = {}, { author = null, remove = [], hours = 5 } = {}) {
      world.time += Math.round(hours * 3600);
      for (const [p, c] of Object.entries(files)) H.write(p, c);
      for (const p of remove) world.removeFile(shell.resolvePath(p));
      H.run('git add -A');
      const msg = message.replace(/"/g, '\\"');
      H.run(`git commit -q -m "${msg}"${author ? ` --author="${author}"` : ''}`);
      return headCommit(shell.repo);
    },
    remote(owner, name, commits = [], meta = {}) { return seedRemote(world, owner, name, commits, meta); },
    teammate(url, opts) {
      const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`;
      return teammateCommit(world, full, opts);
    },
    review(url, number, state, body, author = 'Priya Sharma') {
      const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`;
      return reviewPR(world, world.remotes.get(full), number, { state, body, author });
    },
    issue(url, { title, body = '', labels = [], author = 'Priya Sharma', state = 'open' }) {
      const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`;
      const bare = world.remotes.get(full);
      const issue = { number: bare.meta.nextNumber++, title, body, labels, state, author, comments: [], time: world.time };
      bare.meta.issues.push(issue);
      return issue.number;
    },
    mergePR(url, number, method = 'squash') {
      const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`;
      const bare = world.remotes.get(full);
      return mergePR(world, bare, bare.meta.prs.find(p => p.number === number), method, { admin: true });
    },
    protect(url, branch, rule = { requirePR: true, requiredReviews: 1 }) {
      const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`;
      world.remotes.get(full).meta.protected[branch] = rule;
    },
    pr(url, opts) {
      const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`;
      const bare = world.remotes.get(full);
      return createPR(world, bare, { headRepo: full, ...opts });
    },
    bare(url) { return world.remotes.get(url.startsWith('https://') ? url : `https://github.com/${url}.git`); },
    environment(url, name, { url: envUrl = null, reviewers = [], branches = null, tags = null } = {}) {
      const e = ensureEnvironment(H.bare(url), name, envUrl);
      Object.assign(e, { reviewers, branches, tags });
      return e;
    },
    secret(url, name, value) { const b = H.bare(url); b.meta.secrets = b.meta.secrets || {}; b.meta.secrets[name] = { updated: world.time, value }; },
    tagRemote(url, tag, branch = 'main') { const b = H.bare(url); b.refs['refs/tags/' + tag] = b.refs['refs/heads/' + branch]; return b.refs['refs/tags/' + tag]; },
    deploy(url, env, ref, { refType = 'tag', by = 'Ada Okafor' } = {}) {
      const b = H.bare(url);
      const hash = world.peel(b.refs[(refType === 'tag' ? 'refs/tags/' : 'refs/heads/') + ref]);
      return deployTo(world, b, env, { hash, ref, refType, by });
    },
    // what clicking "Approve and deploy" in the GitHub tab does
    approve(url, { approve = true } = {}) {
      const b = H.bare(url);
      const run = b.meta.runs.find(r => r.status === 'waiting');
      if (!run) return null;
      return approveDeployment(world, b, run.id, { by: world.github.user, approve });
    },
  };
  return H;
}

export function makeCheckApi(world, shell, history) {
  const api = {
    world, shell, history,
    get repo() { return shell.repo; },
    repoAt(path) { return world.repos.get(shell.resolvePath(path)) || null; },
    file(path) { return shell.readFile(shell.resolvePath(path)); },
    exists(path) { const a = shell.resolvePath(path); return world.files.has(a) || world.isDir(a); },
    cwd() { return shell.cwd; },
    inDir(path) { return shell.cwd === shell.resolvePath(path); },
    branch(repo = shell.repo) { return repo ? currentBranch(repo) : null; },
    branches(repo = shell.repo) { return repo ? branchNames(repo) : []; },
    headHash(repo = shell.repo) { return repo ? headCommit(repo) : null; },
    head(repo = shell.repo) { const hh = api.headHash(repo); return hh ? { hash: hh, ...world.commit(hh) } : null; },
    commits(repo = shell.repo, ref = null) {
      if (!repo) return [];
      const start = ref ? resolve(repo, ref, { quiet: true }) : headCommit(repo);
      if (!start) return [];
      return revList(world, [start]).map(hh => ({ hash: hh, ...world.commit(hh) }));
    },
    firstParent(repo = shell.repo, ref = null) {
      if (!repo) return [];
      const start = ref ? resolve(repo, ref, { quiet: true }) : headCommit(repo);
      if (!start) return [];
      return revList(world, [start], [], { firstParent: true }).map(hh => ({ hash: hh, ...world.commit(hh) }));
    },
    count(repo = shell.repo) { return api.commits(repo).length; },
    status(repo = shell.repo) { return repo ? computeStatus(repo) : null; },
    clean(repo = shell.repo) { const s = api.status(repo); return !!s && !s.staged.length && !s.unstaged.length && !s.untracked.length && !s.conflicts.length; },
    tracked(path, repo = shell.repo) { return !!repo && repo.index.has(path); },
    staged(path, repo = shell.repo) { const s = api.status(repo); return !!s && s.staged.some(x => x.path === path); },
    inHead(path, repo = shell.repo) { const hh = api.headHash(repo); return !!hh && commitTreeFlat(repo, hh).has(path); },
    headFile(path, repo = shell.repo) { const hh = api.headHash(repo); if (!hh) return undefined; const f = commitTreeFlat(repo, hh); return f.has(path) ? world.objects.get(f.get(path)).content : undefined; },
    fileAt(ref, path, repo = shell.repo) { const hh = resolve(repo, ref, { quiet: true }); if (!hh) return undefined; const f = commitTreeFlat(repo, hh); return f.has(path) ? world.objects.get(f.get(path)).content : undefined; },
    ref(name, repo = shell.repo) { return repo ? resolve(repo, name, { quiet: true }) : null; },
    isAncestor(a, b) { return !!a && !!b && isAncestor(world, a, b); },
    config(key, repo = shell.repo) { return (repo && repo.config[key] !== undefined) ? repo.config[key] : world.globalConfig[key]; },
    ran(re) { return history.some(l => re.test(l)); },
    lastRan(re) { return history.length > 0 && re.test(history[history.length - 1]); },
    remote(ownerName) { return world.remotes.get(`https://github.com/${ownerName}.git`) || null; },
    remoteRef(ownerName, branch) { const b = api.remote(ownerName); return b ? b.refs['refs/heads/' + branch] || null : null; },
    events(type) { return world.events.filter(e => e.type === type); },
    state(repo = shell.repo) { return repo?.state?.type || null; },
    hasConflicts(repo = shell.repo) { return !!repo && repo.conflicts.size > 0; },
    deployment(ownerName, env) { const b = api.remote(ownerName); return b ? currentDeployment(b, env) : null; },
    runsOf(ownerName, file) { const b = api.remote(ownerName); return b ? b.meta.runs.filter(r => !file || r.file === file) : []; },
    noMarkers(path) { const c = api.file(path); return c !== undefined && !/^(<<<<<<<|=======|>>>>>>>)/m.test(c); },
  };
  return api;
}

export class Lab {
  constructor(lesson, { onComplete, already = false } = {}) {
    this.lesson = lesson;
    this.def = lesson.lab;
    this.onComplete = onComplete;
    this.already = already;
    this.el = h('div', { class: 'lab' });
    this.build();
  }

  build() {
    clear(this.el);
    const def = this.def;
    this.world = new World(def.world || {});
    this.shell = new Shell(this.world, { cwd: this.world.home });
    this.history = [];
    this.helpers = makeHelpers(this.world, this.shell);
    try { def.setup?.(this.helpers); } catch (e) { console.error('lab setup failed', e); }
    this.shell.cwd = this.shell.resolvePath(def.cwd || '~');
    if (!this.world.isDir(this.shell.cwd)) this.world.dirs.add(this.shell.cwd);
    this.world.events.length = 0;
    this.api = makeCheckApi(this.world, this.shell, this.history);
    this.done = def.tasks.map(() => false);
    this.revealed = def.tasks.map(() => 0);
    this.complete = false;

    // brief + tasks
    const brief = h('div', { class: 'prose' });
    brief.innerHTML = renderMarkdown(this.lesson.labText?.md || def.intro || '');
    this.taskList = h('ol', { class: 'tasks', 'aria-label': 'Lab tasks' });
    const briefCol = h('div', {}, h('p', { class: 'eyebrow' }, this.lesson.boss ? 'Boss challenge' : 'Hands-on lab'), h('h2', { style: { fontSize: 'var(--step-2)', margin: '4px 0 12px' } }, this.lesson.labText?.title || 'Practice'), brief);
    const tasksCol = h('div', {}, h('p', { class: 'eyebrow', style: { marginBottom: '8px' } }, `Tasks · complete them in order`), this.taskList);
    this.banner = h('div');
    this.el.append(h('div', { class: 'lab-brief' }, briefCol, tasksCol), this.banner);

    // terminal + panels
    this.term = new Terminal(this.shell, {
      title: 'lab — bash',
      welcome: def.welcome || ['Type commands and press Enter. Tab completes, ↑ recalls history. Try `help` or `git help`.'],
      suggestions: def.suggestions || [],
      onReset: () => { this.build(); this.term.focus(); },
      onCommand: (line, res) => this.afterCommand(line, res),
    });
    this.graph = new GraphView();
    this.areas = new AreasView();
    this.files = new FilesView();
    this.gh = new GitHubView({ onAction: (msg, err) => { this.term.print(`\x1b[${err ? 31 : 35}m[GitHub] ${msg}\x1b[0m`); this.flushSay(); this.refresh(); this.check(); } });
    const panelDefs = { graph: ['Commit graph', this.graph], areas: ['Three areas', this.areas], files: ['Files', this.files], github: ['GitHub', this.gh] };
    const names = def.panels || ['graph', 'areas', 'files'];
    this.activePanel = names[0];
    const tabs = h('div', { class: 'panel-tabs', role: 'tablist' });
    this.panelBody = h('div', { class: 'panel-body', role: 'tabpanel' });
    const setTab = (n) => {
      this.activePanel = n;
      for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.p === n));
      clear(this.panelBody);
      this.panelBody.append(panelDefs[n][1].el);
      this.refresh();
    };
    for (const n of names) tabs.append(h('button', { type: 'button', role: 'tab', dataset: { p: n }, 'aria-selected': 'false', onclick: () => setTab(n) }, panelDefs[n][0]));
    this.el.append(h('div', { class: 'lab-work' }, this.term.el, h('div', { class: 'panel' }, tabs, this.panelBody)));
    setTab(this.activePanel);

    this.sayQueue = [];
    this.say = (t) => this.sayQueue.push(t);
    this.world.listeners.clear();
    this.world.listeners.add(ev => {
      if (!def.events) return;
      try { def.events(ev, { ...this.helpers, ...this.api, say: this.say }); } catch (e) { console.error(e); }
    });
    this.renderTasks();
    if (this.already) this.renderBanner(true);
  }

  refresh() {
    const repo = this.shell.repo;
    try {
      if (this.activePanel === 'graph') this.graph.render(repo);
      if (this.activePanel === 'areas') this.areas.render(repo);
      if (this.activePanel === 'files') this.files.render(repo, this.shell);
      if (this.activePanel === 'github') this.gh.render(repo, this.shell);
    } catch (e) { console.error('panel render failed', e); }
  }

  afterCommand(line, res) {
    if (line.trim()) this.history.push(line.trim());
    try { this.def.onCommand?.(line, res, { ...this.helpers, ...this.api, say: this.say }); } catch (e) { console.error(e); }
    this.flushSay();
    this.refresh();
    this.check();
  }

  flushSay() {
    for (const t of this.sayQueue.splice(0)) this.term.print(`\x1b[35m${t}\x1b[0m`);
  }

  check() {
    let changed = false;
    for (let i = 0; i < this.def.tasks.length; i++) {
      if (this.done[i]) continue;
      let ok = false;
      try { ok = !!this.def.tasks[i].check(this.api); } catch (e) { ok = false; }
      if (!ok) break;
      this.done[i] = true;
      changed = true;
      this.term.print(`\x1b[32m✓ Task ${i + 1} complete: ${this.def.tasks[i].title}\x1b[0m`);
      const note = this.def.tasks[i].after;
      if (note) this.term.print(`\x1b[2m  ${note}\x1b[0m`);
    }
    if (changed) this.renderTasks();
    if (!this.complete && this.done.every(Boolean)) {
      this.complete = true;
      this.renderBanner(false);
      this.onComplete?.();
    }
  }

  renderTasks() {
    clear(this.taskList);
    const cur = this.done.indexOf(false);
    this.def.tasks.forEach((t, i) => {
      const li = h('li', { class: 'task' + (this.done[i] ? ' is-done' : i === cur ? ' is-current' : ' is-later') });
      const body = h('div', {}, h('div', { class: 'tt' }, t.title));
      if (t.detail && i === cur) { const d = h('div', { class: 'td' }); d.innerHTML = renderMarkdown(t.detail).replace(/^<p>|<\/p>$/g, ''); body.append(d); }
      if (i === cur) {
        const r = this.revealed[i];
        if (r >= 1 && t.hint) { const d = h('div', { class: 'hint-text' }); d.innerHTML = renderMarkdown(t.hint).replace(/^<p>|<\/p>$/g, ''); body.append(d); }
        if (r >= 2 && t.solution) {
          const d = h('div', { class: 'hint-text' }, h('strong', {}, 'One way to do it: '), h('code', {}, t.solution));
          body.append(d);
        }
        const btns = h('div', { class: 'th' });
        if (r < 1 && t.hint) btns.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.revealed[i] = 1; this.renderTasks(); } }, 'Hint'));
        if (r >= 1 && r < 2 && t.solution) btns.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.revealed[i] = 2; this.renderTasks(); } }, 'Show a solution'));
        if (r >= 2 && t.solution) btns.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.term.input.value = t.solution; this.term.focus(); } }, 'Put it in the prompt'));
        if (btns.children.length) body.append(btns);
      }
      li.append(h('span', { class: 'tick', 'aria-hidden': 'true' }), body);
      li.setAttribute('aria-label', `${t.title}${this.done[i] ? ' (done)' : ''}`);
      this.taskList.append(li);
    });
  }

  renderBanner(already) {
    clear(this.banner);
    this.banner.append(h('div', { class: 'lab-done', role: 'status' },
      h('div', {}, h('h3', {}, already ? 'Lab already completed' : 'Lab complete'), h('p', { style: { margin: 0, color: 'var(--text-2)' } }, already ? 'You can replay it as often as you like. Reset lab starts it fresh.' : 'Nice work. Your progress is saved. Prove it in the quiz to master this lesson.')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.onProceed?.() }, 'Go to the quiz →')));
  }
}

export { normPath };
