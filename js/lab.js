// Lab runner: builds a fresh simulated universe for a lesson's lab (a laptop plus any
// servers the lab needs), wires the terminal to the visual panels, and checks tasks in
// order after every command.

import { h, clear } from './ui/dom.js';
import { renderMarkdown } from './ui/markdown.js';
import { Terminal } from './ui/terminal.js';
import { GitHubView } from './ui/panels.js';
import { SystemView, FileTreeView, NetworkView } from './ui/devpanels.js';
import { extraPanels } from './ui/panelRegistry.js';
import './sim/index.js';
import { Session } from './sim/session.js';
import { newUniverse, addServer, addLaptop, authorizeKey } from './sim/machines.js';
import { installPkg } from './sim/packages.js';
import { unitState, startUnit } from './sim/systemd.js';
import { httpRequest, connect } from './sim/net.js';
import { normPath } from './sim/host.js';
import { seedRemote, teammateCommit, reviewPR, createPR, mergePR } from './git/github.js';
import { stripAnsi } from './git/world.js';
import { labExtensions } from './labext.js';

export function makeHelpers(uni, sh) {
  const host = n => (typeof n === 'string' ? uni.host(n) : n) || sh.host;
  const H = {
    uni, sh, world: uni,
    get laptop() { return uni.host('laptop'); },
    server(name, opts = {}) { return addServer(uni, name, opts); },
    host,
    run(line, { on, user } = {}) {
      const target = host(on);
      const s = new Session(uni, target, { user: user || target.defaultUser });
      s.advancePerCommand = 0;
      const r = s.run(line, { record: false });
      if (r.code && r.code !== 0 && !line.includes('|| true')) console.warn(`[setup ${target.name}] "${line}" exited ${r.code}:`, r.out.map(stripAnsi).join('\n'));
      return r;
    },
    cd(p) { sh.cwd = sh.resolvePath(p); },
    write(on, path, content, { owner, mode } = {}) {
      const hh = host(on);
      const p = normPath(path.replace(/^~/, hh.users.get(owner || hh.defaultUser)?.home || '/root'));
      hh.ensureParents(p, owner || 'root');
      hh.writeFile(p, content, owner || (p.startsWith('/home/') ? hh.ownerFor(p) : 'root'));
      if (owner) hh.setMeta(p, { owner, group: hh.userGroups(owner)[0] || owner });
      if (mode !== undefined) hh.setMeta(p, { mode });
      return p;
    },
    mkdir(on, path, { owner = 'root', mode = 0o755 } = {}) { const hh = host(on); hh.mkdirMeta(path, owner, mode); if (owner !== 'root') hh.setMeta(path, { owner, group: hh.userGroups(owner)[0] || owner }); },
    install(on, ...pkgs) { const hh = host(on); for (const p of pkgs) installPkg(hh, uni, p, []); },
    user(on, name, opts = {}) { const hh = host(on); if (!hh.users.has(name)) hh.addUser(name, opts); return hh.users.get(name); },
    service(on, name, text, { enable = true, start = true } = {}) {
      const hh = host(on);
      const unit = name.endsWith('.service') ? name : name + '.service';
      hh.writeSys(`/etc/systemd/system/${unit}`, text);
      const st = unitState(hh, unit);
      st.enabled = enable;
      st.loadedText = text;
      if (start) return startUnit(hh, uni, unit);
      return { ok: true };
    },
    dns(name, target) { uni.dns.set(name, typeof target === 'string' && /^\d/.test(target) ? target : host(target).ip); },
    dnsRecord(name, type, value) { uni.dnsRecords = uni.dnsRecords || {}; (uni.dnsRecords[name] = uni.dnsRecords[name] || {})[type] = value; if (type === 'A') uni.dns.set(name, [].concat(value)[0]); },
    authorize(fromHost, fromUser, toHost, toUser) { authorizeKey(uni, host(fromHost), fromUser, host(toHost), toUser); },
    hours(n) { uni.time += Math.round(n * 3600); },
    log(on, unit, msg, { prio = 'info', ago = 0 } = {}) { const hh = host(on); hh.journal.push({ time: uni.time - ago, unit, prio, msg }); },
    fakeSize(on, path, bytes) { const hh = host(on); hh.fakeSizes = hh.fakeSizes || new Map(); if (!hh.files.has(path)) hh.writeFile(path, '', hh.ownerFor(path)); hh.fakeSizes.set(path, bytes); },
    // a plain background process (no ports), e.g. a runaway job or an app holding a log open
    proc(on, { cmd, user = 'root', mem = 20, cpu = 0.2, openFiles = [], unit = null, state = 'S' }) { const hh = host(on); const p = hh.addProc({ cmd, user, mem, cpu, unit }); p.openFiles = openFiles; p.state = state; return p; },
    load(on, avg) { host(on).loadAvg = avg; },
    age(on, path, days) { const hh = host(on); hh.setMeta(path, { mtime: uni.time - Math.round(days * 86400) }); },
    // a website on "the internet": routes map a path (or '*') to { status, body, headers } or a function(req)
    site(hostname, routes, { ip } = {}) {
      uni.dns.set(hostname, ip || `203.0.113.${10 + uni.httpHooks.length}`);
      uni.httpHooks.push(({ url, method, headers, body }) => {
        if (url.host !== hostname) return null;
        const r = routes[url.path] ?? routes['*'];
        if (r === undefined) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not Found' };
        const res = typeof r === 'function' ? r({ path: url.path, method, headers, body, query: url.query }) : r;
        return { status: res.status || 200, headers: { 'content-type': /^\s*[{[]/.test(res.body || '') ? 'application/json' : 'text/html', ...(res.headers || {}) }, body: res.body ?? '' };
      });
    },
    // GitHub helpers (shared with Git Conquest)
    remote(owner, name, commits = [], meta = {}) { return seedRemote(uni, owner, name, commits, meta); },
    teammate(url, opts) { return teammateCommit(uni, url.startsWith('https://') ? url : `https://github.com/${url}.git`, opts); },
    review(url, number, state, body, author = 'Priya Sharma') { const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`; return reviewPR(uni, uni.remotes.get(full), number, { state, body, author }); },
    pr(url, opts) { const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`; return createPR(uni, uni.remotes.get(full), { headRepo: full, ...opts }); },
    mergePR(url, number, method = 'squash') { const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`; const b = uni.remotes.get(full); return mergePR(uni, b, b.meta.prs.find(p => p.number === number), method, { admin: true }); },
    protect(url, branch, rule = { requirePR: true, requiredReviews: 1 }) { const full = url.startsWith('https://') ? url : `https://github.com/${url}.git`; uni.remotes.get(full).meta.protected[branch] = rule; },
  };
  for (const ext of labExtensions) Object.assign(H, ext.helpers?.(uni, sh, H) || {});
  return H;
}

export function makeCheckApi(uni, sh, history) {
  const host = n => (typeof n === 'string' ? uni.host(n) : n) || sh.host;
  const api = {
    uni, sh, history, world: uni,
    host,
    get here() { return sh.host; },
    get user() { return sh.user; },
    get cwd() { return sh.cwd; },
    onHost: name => sh.host.name === name,
    asUser: name => sh.user === name,
    inDir: p => sh.cwd === normPath(p.replace(/^~/, sh.host.users.get(sh.user)?.home || '/root')),
    file: (on, path) => host(on).files.get(path.replace(/^~/, host(on).users.get(host(on).defaultUser)?.home || '/root')),
    exists: (on, path) => !!host(on).stat(path),
    stat: (on, path) => host(on).stat(path),
    mode: (on, path) => host(on).stat(path)?.mode ?? null,
    owner: (on, path) => host(on).stat(path)?.owner ?? null,
    isLink: (on, path) => host(on).isLink(path),
    linkTarget: (on, path) => host(on).links.get(path),
    userExists: (on, name) => host(on).users.has(name),
    inGroup: (on, user, group) => host(on).userGroups(user).includes(group),
    pkg: (on, name) => host(on).packages.has(name),
    unit: (on, name) => unitState(host(on), name.endsWith('.service') ? name : name + '.service'),
    active: (on, name) => unitState(host(on), name.endsWith('.service') ? name : name + '.service').active === 'active',
    enabled: (on, name) => unitState(host(on), name.endsWith('.service') ? name : name + '.service').enabled,
    listening: (on, port) => { const hh = host(on); const l = hh.listening.get(port); return l && hh.procs.has(l.pid) ? l : null; },
    proc: (on, re) => [...host(on).procs.values()].find(p => re.test(p.cmd)) || null,
    procs: (on, re) => [...host(on).procs.values()].filter(p => re.test(p.cmd)),
    http: (from, url, opts) => httpRequest(uni, host(from), url, opts),
    reach: (from, name, port) => connect(uni, host(from), name, port),
    fw: on => host(on).firewall,
    cron: (on, user) => host(on).crontabs.get(user) || '',
    journal: (on, unit) => host(on).journal.filter(j => !unit || j.unit === unit),
    ran: re => history.some(l => re.test(l)),
    ranOn: (re, hostName) => history.some(l => re.test(l.line ?? l) && (l.host ?? hostName) === hostName),
    lastRan: re => history.length > 0 && re.test(history[history.length - 1]),
    events: type => uni.events.filter(e => !type || e.type === type),
    remote: ownerName => uni.remotes.get(`https://github.com/${ownerName}.git`) || null,
    // did an event matching b happen after the last event matching a?
    after(a, b) { const ev = uni.events; let ia = -1; ev.forEach((e, i) => { if (a(e)) ia = i; }); return ia >= 0 && ev.some((e, i) => i > ia && b(e)); },
  };
  for (const ext of labExtensions) Object.assign(api, ext.checks?.(uni, sh, api) || {});
  return api;
}

export function buildLabWorld(def) {
  const uni = newUniverse(def.world || {});
  const laptop = addLaptop(uni, 'laptop', { packages: def.laptopPackages || [] });
  const sh = new Session(uni, laptop);
  const H = makeHelpers(uni, sh);
  def.setup?.(H);
  if (def.startOn) { const hh = uni.host(def.startOn.host); sh.e.host = hh; sh.e.user = def.startOn.user || hh.defaultUser; sh.setVar(sh.e, 'HOME', hh.users.get(sh.e.user)?.home || '/root', { exported: true }); sh.setVar(sh.e, 'USER', sh.e.user, { exported: true }); }
  sh.cwd = sh.resolvePath(def.cwd || '~');
  if (!sh.host.isDir(sh.cwd)) sh.host.mkdirMeta(sh.cwd, sh.user);
  uni.events.length = 0;
  return { uni, sh, H };
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
    let built;
    try { built = buildLabWorld(def); } catch (e) { console.error('lab setup failed', e); built = buildLabWorld({ ...def, setup: null }); }
    Object.assign(this, built);
    this.helpers = built.H;
    this.history = [];
    this.api = makeCheckApi(this.uni, this.sh, this.history);
    this.done = def.tasks.map(() => false);
    this.revealed = def.tasks.map(() => 0);
    this.complete = false;

    const brief = h('div', { class: 'prose' });
    brief.innerHTML = renderMarkdown(this.lesson.labText?.md || def.intro || '');
    this.taskList = h('ol', { class: 'tasks', 'aria-label': 'Lab tasks' });
    const briefCol = h('div', {}, h('p', { class: 'eyebrow' }, this.lesson.boss ? 'Boss challenge' : 'Hands-on lab'), h('h2', { style: { fontSize: 'var(--step-2)', margin: '4px 0 12px' } }, this.lesson.labText?.title || 'Practice'), brief);
    const tasksCol = h('div', {}, h('p', { class: 'eyebrow', style: { marginBottom: '8px' } }, 'Tasks · complete them in order'), this.taskList);
    this.banner = h('div');
    this.el.append(h('div', { class: 'lab-brief' }, briefCol, tasksCol), this.banner);

    this.term = new Terminal(this.sh, {
      title: 'lab — bash',
      welcome: def.welcome || ['Type commands and press Enter. Tab completes, ↑ recalls history. Try `help`.'],
      suggestions: def.suggestions || [],
      onReset: () => { this.build(); this.term.focus(); },
      onCommand: (line, res) => this.afterCommand(line, res),
    });
    const onAction = (msg, err) => { this.term.print(`\x1b[${err ? 31 : 35}m[${msg.startsWith('[') ? '' : 'GitHub'}] ${msg}\x1b[0m`.replace('[] ', '')); this.flushSay(); this.refresh(); this.check(); };
    const panelDefs = {
      system: ['System', new SystemView({ fixedHost: def.systemHost })],
      files: ['Files', new FileTreeView()],
      network: ['Network', new NetworkView()],
      github: ['GitHub', new GitHubView({ onAction })],
    };
    for (const [k, make] of Object.entries(extraPanels)) panelDefs[k] = [make.label, make.create({ onAction, lab: this })];
    const names = (def.panels || ['system', 'files']).filter(n => panelDefs[n]);
    this.panelDefs = panelDefs;
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
    this.uni.listeners.clear();
    this.uni.listeners.add(ev => {
      if (!def.events) return;
      try { def.events(ev, { ...this.helpers, ...this.api, say: this.say }); } catch (e) { console.error(e); }
    });
    this.renderTasks();
    if (this.already) this.renderBanner(true);
  }

  refresh() {
    const p = this.panelDefs?.[this.activePanel]?.[1];
    if (!p) return;
    try {
      if (p instanceof GitHubView) p.render(this.sh.repo, this.sh);
      else p.render(this.sh, this.uni);
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
      this.term.print(`\x1b[32m✓ Task ${i + 1} complete: ${stripMd(this.def.tasks[i].title)}\x1b[0m`);
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
      const tt = h('div', { class: 'tt' });
      tt.innerHTML = renderMarkdown(t.title).replace(/^<p>|<\/p>\s*$/g, '');
      const body = h('div', {}, tt);
      if (t.detail && i === cur) { const d = h('div', { class: 'td' }); d.innerHTML = renderMarkdown(t.detail).replace(/^<p>|<\/p>\s*$/g, ''); body.append(d); }
      if (i === cur) {
        const r = this.revealed[i];
        if (r >= 1 && t.hint) { const d = h('div', { class: 'hint-text' }); d.innerHTML = renderMarkdown(t.hint).replace(/^<p>|<\/p>\s*$/g, ''); body.append(d); }
        if (r >= 2 && t.solution) body.append(h('div', { class: 'hint-text' }, h('strong', {}, 'One way to do it: '), h('code', {}, t.solution)));
        const btns = h('div', { class: 'th' });
        if (r < 1 && t.hint) btns.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.revealed[i] = 1; this.renderTasks(); } }, 'Hint'));
        if (((r >= 1) || !t.hint) && r < 2 && t.solution) btns.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.revealed[i] = 2; this.renderTasks(); } }, 'Show a solution'));
        if (r >= 2 && t.solution && !/^\(|^Click|^Open/.test(t.solution)) btns.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { this.term.input.value = t.solution; this.term.focus(); } }, 'Put it in the prompt'));
        if (btns.children.length) body.append(btns);
      }
      li.append(h('span', { class: 'tick', 'aria-hidden': 'true' }), body);
      li.setAttribute('aria-label', `${stripMd(t.title)}${this.done[i] ? ' (done)' : ''}`);
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

const stripMd = s => String(s).replace(/`/g, '').replace(/\*\*/g, '');
