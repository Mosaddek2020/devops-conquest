// The simulated world: a filesystem, a content-addressed object store, local repositories
// and a pretend GitHub that hosts bare repositories. Object ids are real SHA-1s of the
// same byte layout git uses, so `git hash-object` here matches real git for the same text.

import { sha1Bytes, utf8, concatBytes, hexToBytes } from './sha1.js';

export class GitError extends Error {
  constructor(message, code = 128) { super(message); this.code = code; }
}

export const C = {
  red: s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  blue: s => `\x1b[34m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
};

export const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

export function normPath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

export class Repo {
  constructor(world, root, { bare = false } = {}) {
    this.world = world;
    this.root = root;          // working tree root (null for bare)
    this.bare = bare;
    this.HEAD = 'ref: refs/heads/' + (world.globalConfig['init.defaultBranch'] || 'master');
    this.refs = {};            // 'refs/heads/main' -> hash
    this.index = new Map();    // stage-0 entries: path -> blob hash
    this.conflicts = new Map();// path -> {base, ours, theirs} blob hashes (null = absent)
    this.config = {};
    this.reflog = {};          // ref -> [{old, new, msg, time}]
    this.stash = [];           // [{hash, message}] newest first
    this.state = null;         // merge / rebase / cherry-pick / revert / bisect in progress
    this.bisect = null;
    this.hooks = {};           // name -> script text
    this.meta = {};            // GitHub-side data for bare repos
  }
}

export class World {
  constructor(opts = {}) {
    this.home = '/home/dev';
    this.files = new Map();
    this.dirs = new Set(['/', '/home', this.home]);
    this.objects = new Map();
    this.repos = new Map();     // root -> Repo
    this.remotes = new Map();   // canonical url -> bare Repo
    this.time = opts.time || 1767258000; // 2026-01-01 09:00 UTC
    this.globalConfig = {
      'user.name': 'Dev Learner',
      'user.email': 'dev@example.com',
      'init.defaultBranch': 'main',
      'core.editor': 'code --wait',
      ...(opts.globalConfig || {}),
    };
    if (opts.noIdentity) { delete this.globalConfig['user.name']; delete this.globalConfig['user.email']; }
    if (opts.freshConfig) this.globalConfig = { ...(opts.globalConfig || {}) };
    this.github = {
      user: opts.githubUser || 'you',
      sshKeys: [],
      authed: opts.authed !== false,
      nextIds: {},
    };
    this.treeCache = new Map();
    this.listeners = new Set();
    this.events = [];           // log of notable things labs can inspect
  }

  tick(minutes = 7) { this.time += minutes * 60 + 13; return this.time; }

  emit(ev) { this.events.push(ev); for (const l of this.listeners) l(ev); }

  // ---------- object store ----------
  hashObject(type, bodyBytes) {
    const header = utf8(`${type} ${bodyBytes.length}\0`);
    return sha1Bytes(concatBytes([header, bodyBytes]));
  }

  writeBlob(content) {
    const body = utf8(content);
    const hash = this.hashObject('blob', body);
    if (!this.objects.has(hash)) this.objects.set(hash, { type: 'blob', content, size: body.length });
    return hash;
  }

  blobHash(content) {
    return this.hashObject('blob', utf8(content));
  }

  // flat: Map(path -> blobHash) -> tree hash, writing nested trees.
  writeTree(flat) {
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, hash] of flat) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], { files: new Map(), dirs: new Map() });
        node = node.dirs.get(segs[i]);
      }
      node.files.set(segs[segs.length - 1], hash);
    }
    const write = (node) => {
      const entries = [];
      for (const [name, hash] of node.files) entries.push({ mode: '100644', name, hash, type: 'blob' });
      for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, hash: write(sub), type: 'tree' });
      entries.sort((a, b) => {
        const ka = a.type === 'tree' ? a.name + '/' : a.name;
        const kb = b.type === 'tree' ? b.name + '/' : b.name;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      const parts = [];
      for (const e of entries) parts.push(utf8(`${e.mode} ${e.name}\0`), hexToBytes(e.hash));
      const body = concatBytes(parts);
      const hash = this.hashObject('tree', body);
      if (!this.objects.has(hash)) this.objects.set(hash, { type: 'tree', entries, size: body.length });
      return hash;
    };
    return write(root);
  }

  readTreeFlat(treeHash) {
    if (!treeHash) return new Map();
    if (this.treeCache.has(treeHash)) return new Map(this.treeCache.get(treeHash));
    const out = new Map();
    const walk = (hash, prefix) => {
      const t = this.objects.get(hash);
      for (const e of t.entries) {
        if (e.type === 'tree') walk(e.hash, prefix + e.name + '/');
        else out.set(prefix + e.name, e.hash);
      }
    };
    walk(treeHash, '');
    this.treeCache.set(treeHash, out);
    return new Map(out);
  }

  writeCommit({ tree, parents = [], message, author, committer }) {
    const sig = s => `${s.name} <${s.email}> ${s.time} +0000`;
    committer = committer || author;
    let text = `tree ${tree}\n`;
    for (const p of parents) text += `parent ${p}\n`;
    text += `author ${sig(author)}\ncommitter ${sig(committer)}\n\n${message.endsWith('\n') ? message : message + '\n'}`;
    const body = utf8(text);
    const hash = this.hashObject('commit', body);
    if (!this.objects.has(hash)) {
      this.objects.set(hash, { type: 'commit', tree, parents: [...parents], author: { ...author }, committer: { ...committer }, message: message.replace(/\n+$/, ''), raw: text, size: body.length });
    }
    return hash;
  }

  writeTag({ object, tag, tagger, message }) {
    const target = this.objects.get(object);
    const text = `object ${object}\ntype ${target.type}\ntag ${tag}\ntagger ${tagger.name} <${tagger.email}> ${tagger.time} +0000\n\n${message}\n`;
    const body = utf8(text);
    const hash = this.hashObject('tag', body);
    this.objects.set(hash, { type: 'tag', object, objtype: target.type, tag, tagger: { ...tagger }, message, raw: text, size: body.length });
    return hash;
  }

  commit(hash) {
    const o = this.objects.get(hash);
    if (!o || o.type !== 'commit') throw new GitError(`fatal: ${hash} is not a commit`);
    return o;
  }

  peel(hash) {
    let o = this.objects.get(hash);
    while (o && o.type === 'tag') { hash = o.object; o = this.objects.get(hash); }
    return hash;
  }

  // ---------- filesystem ----------
  isFile(p) { return this.files.has(p); }
  isDir(p) {
    if (this.dirs.has(p)) return true;
    const pre = p === '/' ? '/' : p + '/';
    for (const f of this.files.keys()) if (f.startsWith(pre)) return true;
    return false;
  }
  writeFile(p, content) {
    this.files.set(p, content);
    let d = dirname(p);
    while (d !== '/' && !this.dirs.has(d)) { this.dirs.add(d); d = dirname(d); }
  }
  removeFile(p) { this.files.delete(p); }
  listDir(p) {
    const pre = p === '/' ? '/' : p + '/';
    const names = new Map();
    for (const f of this.files.keys()) {
      if (!f.startsWith(pre)) continue;
      const rest = f.slice(pre.length);
      const i = rest.indexOf('/');
      if (i === -1) names.set(rest, 'file'); else names.set(rest.slice(0, i), 'dir');
    }
    for (const d of this.dirs) {
      if (!d.startsWith(pre) || d === p) continue;
      const rest = d.slice(pre.length);
      if (!rest.includes('/')) names.set(rest, 'dir');
    }
    if (this.repos.has(p)) names.set('.git', 'dir');
    return [...names.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  pruneEmptyDirs(root) {
    const dirs = [...this.dirs].filter(d => d.startsWith(root + '/')).sort((a, b) => b.length - a.length);
    for (const d of dirs) {
      if (this.listDir(d).length === 0) this.dirs.delete(d);
    }
  }

  // ---------- repo discovery ----------
  findRepo(cwd) {
    let d = cwd;
    while (true) {
      if (this.repos.has(d)) return this.repos.get(d);
      if (d === '/') return null;
      d = dirname(d);
    }
  }

  createRepo(root) {
    const repo = new Repo(this, root);
    this.repos.set(root, repo);
    this.dirs.add(root);
    return repo;
  }

  // ---------- GitHub ----------
  canonicalUrl(url) {
    let m = url.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/);
    if (m) return { url: `https://github.com/${m[1]}/${m[2]}.git`, owner: m[1], name: m[2], ssh: true };
    m = url.match(/^(?:https?:\/\/)?github\.com\/([^/]+)\/(.+?)(\.git)?\/?$/);
    if (m) return { url: `https://github.com/${m[1]}/${m[2]}.git`, owner: m[1], name: m[2], ssh: false };
    m = url.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (m) return { url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}.git`, owner: m[1], name: m[2].replace(/\.git$/, ''), ssh: false, short: true };
    return null;
  }

  createRemoteRepo(owner, name, meta = {}) {
    const url = `https://github.com/${owner}/${name}.git`;
    const repo = new Repo(this, null, { bare: true });
    repo.HEAD = 'ref: refs/heads/main';
    repo.meta = {
      owner, name, url, description: meta.description || '', visibility: meta.visibility || 'public',
      prs: [], issues: [], nextNumber: 1, protected: {}, forkOf: meta.forkOf || null,
      releases: [], runs: [], collaborators: meta.collaborators || [], stars: meta.stars || 0,
      defaultBranch: 'main',
    };
    this.remotes.set(url, repo);
    return repo;
  }

  remoteByUrl(url) {
    const c = this.canonicalUrl(url);
    return c ? this.remotes.get(c.url) || null : null;
  }
}

// ---------- helpers shared by commands ----------

export function shortHash(h) { return h ? h.slice(0, 7) : '0000000'; }

export function formatDate(ts) {
  const d = new Date(ts * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = n => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} +0000`;
}

export function isoDate(ts) {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');
}

export function relativeTime(ts, now) {
  const s = Math.max(0, now - ts);
  if (s < 90) return `${Math.max(1, Math.round(s))} seconds ago`;
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}
