// Repository-level operations shared by the porcelain commands.

import { GitError, shortHash } from './world.js';
import { merge3 } from './diff.js';

// ---------- refs ----------

export function headRef(repo) {
  return repo.HEAD.startsWith('ref: ') ? repo.HEAD.slice(5) : null;
}

export function currentBranch(repo) {
  const r = headRef(repo);
  return r && r.startsWith('refs/heads/') ? r.slice(11) : null;
}

export function headCommit(repo) {
  const r = headRef(repo);
  if (r) return repo.refs[r] || null;
  return repo.HEAD;
}

export function logRef(repo, ref, oldH, newH, msg) {
  const w = repo.world;
  (repo.reflog[ref] = repo.reflog[ref] || []).unshift({ old: oldH, new: newH, msg, time: w.time });
}

export function updateRef(repo, ref, hash, msg) {
  const old = repo.refs[ref] || null;
  if (hash === null) delete repo.refs[ref]; else repo.refs[ref] = hash;
  if (msg && !repo.bare) {
    logRef(repo, ref, old, hash, msg);
    if (headRef(repo) === ref) logRef(repo, 'HEAD', old, hash, msg);
  }
}

// Move HEAD (and the branch it points at, unless detaching / switching).
export function setHeadCommit(repo, hash, msg) {
  const r = headRef(repo);
  if (r) updateRef(repo, r, hash, msg);
  else {
    const old = repo.HEAD;
    repo.HEAD = hash;
    logRef(repo, 'HEAD', old, hash, msg);
  }
}

export function switchHead(repo, target, msg) {
  // target: 'refs/heads/x' (attach) or a commit hash (detach)
  const old = headCommit(repo);
  if (target.startsWith('refs/')) repo.HEAD = 'ref: ' + target;
  else repo.HEAD = target;
  logRef(repo, 'HEAD', old, headCommit(repo), msg);
}

export function branchNames(repo) {
  return Object.keys(repo.refs).filter(r => r.startsWith('refs/heads/')).map(r => r.slice(11)).sort();
}

export function upstreamOf(repo, branch) {
  const remote = repo.config[`branch.${branch}.remote`];
  const merge = repo.config[`branch.${branch}.merge`];
  if (!remote || !merge) return null;
  return { remote, branch: merge.replace('refs/heads/', ''), ref: `refs/remotes/${remote}/${merge.replace('refs/heads/', '')}` };
}

export function validRefName(name) {
  return !!name && !/(^[-.\/])|\.\.|[\s~^:?*\[\\]|\/$|\.lock$|@\{|\/\/|\.$/.test(name);
}

// ---------- revision parsing ----------

export function resolveRef(repo, name) {
  if (name === 'HEAD' || name === '@') return headCommit(repo);
  if (name === 'FETCH_HEAD' && repo.fetchHead) return repo.fetchHead;
  if (name === 'ORIG_HEAD' && repo.origHead) return repo.origHead;
  if (name === 'MERGE_HEAD' && repo.state && repo.state.mergeHead) return repo.state.mergeHead;
  for (const cand of [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]) {
    if (repo.refs[cand]) return repo.refs[cand];
  }
  if (/^[0-9a-f]{4,40}$/.test(name)) {
    const matches = [];
    for (const h of repo.world.objects.keys()) if (h.startsWith(name)) matches.push(h);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new GitError(`error: short object ID ${name} is ambiguous`);
  }
  return null;
}

export function resolve(repo, rev, { peel = true, quiet = false } = {}) {
  const fail = () => {
    if (quiet) return null;
    throw new GitError(`fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
  };
  const m = rev.match(/^(.*?)((?:[~^]\d*|@\{\d+\}|\^\{\w*\})*)$/);
  let base = m[1], suffix = m[2];
  let hash;
  const reflogM = rev.match(/^(.*?)@\{(\d+)\}(.*)$/);
  if (reflogM) {
    const refName = reflogM[1] === '' || reflogM[1] === 'HEAD' ? 'HEAD' : (repo.refs[`refs/heads/${reflogM[1]}`] !== undefined ? `refs/heads/${reflogM[1]}` : reflogM[1]);
    const log = repo.reflog[refName] || [];
    const entry = log[Number(reflogM[2])];
    if (!entry) { if (quiet) return null; throw new GitError(`fatal: log for '${reflogM[1] || 'HEAD'}' only has ${log.length} entries`); }
    hash = entry.new;
    suffix = reflogM[3];
  } else {
    if (base === '') base = 'HEAD';
    hash = resolveRef(repo, base);
    if (!hash) {
      if (base === 'HEAD' && !quiet) throw new GitError(`fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n(your branch has no commits yet)`);
      return fail();
    }
  }
  const re = /~(\d*)|\^\{(\w*)\}|\^(\d*)/g;
  let s;
  while ((s = re.exec(suffix))) {
    if (s[2] !== undefined) {
      hash = repo.world.peel(hash);
      if (s[2] === 'tree') hash = repo.world.commit(hash).tree;
      continue;
    }
    hash = repo.world.peel(hash);
    if (s[1] !== undefined) {
      const n = s[1] === '' ? 1 : Number(s[1]);
      for (let i = 0; i < n; i++) {
        const c = repo.world.commit(hash);
        if (!c.parents[0]) return fail();
        hash = c.parents[0];
      }
    } else {
      const n = s[3] === '' ? 1 : Number(s[3]);
      if (n === 0) continue;
      const c = repo.world.commit(hash);
      if (!c.parents[n - 1]) return fail();
      hash = c.parents[n - 1];
    }
  }
  if (peel) {
    const peeled = repo.world.peel(hash);
    const o = repo.world.objects.get(peeled);
    if (!o) return fail();
    return peeled;
  }
  return hash;
}

export function resolveCommit(repo, rev) {
  const h = resolve(repo, rev);
  const o = repo.world.objects.get(h);
  if (!o || o.type !== 'commit') throw new GitError(`fatal: '${rev}' is not a commit`);
  return h;
}

// ---------- history ----------

export function ancestors(world, hash) {
  const seen = new Set();
  const stack = hash ? [hash] : [];
  while (stack.length) {
    const h = stack.pop();
    if (seen.has(h)) continue;
    seen.add(h);
    for (const p of world.commit(h).parents) stack.push(p);
  }
  return seen;
}

export function isAncestor(world, a, b) {
  // is a an ancestor of (or equal to) b
  return ancestors(world, b).has(a);
}

export function mergeBase(world, a, b) {
  const A = ancestors(world, a);
  const B = ancestors(world, b);
  const common = [...A].filter(h => B.has(h));
  if (!common.length) return null;
  const best = common.filter(c => !common.some(o => o !== c && ancestors(world, o).has(c)));
  best.sort((x, y) => world.commit(y).committer.time - world.commit(x).committer.time);
  return best[0];
}

// Commits reachable from `heads` but not from `exclude`, newest first (date order, topo-safe).
export function revList(world, heads, exclude = [], { firstParent = false } = {}) {
  const ex = new Set();
  for (const e of exclude) for (const h of ancestors(world, e)) ex.add(h);
  const seen = new Set();
  const out = [];
  const queue = heads.filter(Boolean).filter(h => !ex.has(h));
  const childCount = new Map();
  // collect
  const stack = [...queue];
  while (stack.length) {
    const h = stack.pop();
    if (seen.has(h) || ex.has(h)) continue;
    seen.add(h);
    const ps = world.commit(h).parents;
    for (const p of (firstParent ? ps.slice(0, 1) : ps)) {
      if (!ex.has(p)) { childCount.set(p, (childCount.get(p) || 0) + 1); stack.push(p); }
    }
  }
  // topo order: a commit is emitted only after all its children (Kahn), ties by date
  const ready = [...seen].filter(h => !childCount.get(h));
  const pending = new Map(childCount);
  const time = h => world.commit(h).committer.time;
  while (ready.length) {
    ready.sort((a, b) => time(a) - time(b) || (a < b ? -1 : 1));
    const h = ready.pop();
    out.push(h);
    const ps = world.commit(h).parents;
    for (const p of (firstParent ? ps.slice(0, 1) : ps)) {
      if (!seen.has(p)) continue;
      const n = pending.get(p) - 1;
      pending.set(p, n);
      if (n === 0) ready.push(p);
    }
  }
  return out;
}

export function commitTreeFlat(repo, hash) {
  if (!hash) return new Map();
  return repo.world.readTreeFlat(repo.world.commit(hash).tree);
}

export function headTreeFlat(repo) {
  return commitTreeFlat(repo, headCommit(repo));
}

// ---------- working tree ----------

export function toRepoPath(repo, absPath) {
  if (absPath === repo.root) return '';
  if (!absPath.startsWith(repo.root + '/')) return null;
  return absPath.slice(repo.root.length + 1);
}

export function worktree(repo) {
  const out = new Map();
  const pre = repo.root + '/';
  for (const [p, content] of repo.world.files) {
    if (!p.startsWith(pre)) continue;
    const rel = p.slice(pre.length);
    if (rel.startsWith('.git/')) continue;
    // nested repositories are not part of this tree
    const nested = [...repo.world.repos.keys()].some(r => r !== repo.root && p.startsWith(r + '/') && r.startsWith(pre));
    if (nested) continue;
    out.set(rel, content);
  }
  return out;
}

export function readWork(repo, rel) {
  return repo.world.files.get(repo.root + '/' + rel);
}

export function writeWork(repo, rel, content) {
  repo.world.writeFile(repo.root + '/' + rel, content);
}

export function removeWork(repo, rel) {
  repo.world.removeFile(repo.root + '/' + rel);
}

// ---------- .gitignore ----------

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+()|{}^$[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return re;
}

export function ignoreRules(repo, wt = worktree(repo)) {
  const rules = [];
  for (const [rel, content] of wt) {
    if (rel !== '.gitignore' && !rel.endsWith('/.gitignore')) continue;
    const base = rel === '.gitignore' ? '' : rel.slice(0, -'.gitignore'.length);
    for (let line of content.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      let negate = false;
      if (line.startsWith('!')) { negate = true; line = line.slice(1); }
      let dirOnly = false;
      if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
      const anchored = line.includes('/') && !line.startsWith('**/');
      if (line.startsWith('/')) line = line.slice(1);
      const body = globToRegex(line);
      const prefix = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = anchored
        ? new RegExp(`^${prefix}${body}(/|$)`)
        : new RegExp(`^${prefix}(?:.*/)?${body}(/|$)`);
      rules.push({ re, negate, dirOnly, source: rel, pattern: (negate ? '!' : '') + line + (dirOnly ? '/' : '') });
    }
  }
  return rules;
}

export function isIgnored(rules, path) {
  let ignored = false;
  for (const r of rules) {
    const m = path.match(r.re);
    if (!m) continue;
    if (r.dirOnly && m[1] !== '/') continue; // pattern must match a directory component
    ignored = !r.negate;
  }
  return ignored;
}

// ---------- status ----------

export function computeStatus(repo) {
  const w = repo.world;
  const head = headTreeFlat(repo);
  const wt = worktree(repo);
  const rules = ignoreRules(repo, wt);
  const staged = [], unstaged = [], untracked = [], ignored = [];
  const paths = new Set([...head.keys(), ...repo.index.keys()]);
  for (const p of [...paths].sort()) {
    if (repo.conflicts.has(p)) continue;
    const h = head.get(p), i = repo.index.get(p);
    if (h && !i) staged.push({ path: p, kind: 'deleted' });
    else if (!h && i) staged.push({ path: p, kind: 'new file' });
    else if (h !== i) staged.push({ path: p, kind: 'modified' });
  }
  // simple exact-rename detection among staged changes
  const dels = staged.filter(s => s.kind === 'deleted');
  for (const d of dels) {
    const add = staged.find(s => s.kind === 'new file' && repo.index.get(s.path) === head.get(d.path));
    if (add) {
      staged.splice(staged.indexOf(d), 1);
      add.kind = 'renamed'; add.from = d.path;
    }
  }
  for (const [p, hash] of [...repo.index].sort()) {
    if (!wt.has(p)) unstaged.push({ path: p, kind: 'deleted' });
    else if (w.blobHash(wt.get(p)) !== hash) unstaged.push({ path: p, kind: 'modified' });
  }
  const conflicts = [...repo.conflicts.entries()].map(([path, c]) => ({
    path,
    kind: !c.ours ? 'deleted by us' : !c.theirs ? 'deleted by them' : !c.base ? 'both added' : 'both modified',
  }));
  for (const p of [...wt.keys()].sort()) {
    if (repo.index.has(p) || repo.conflicts.has(p)) continue;
    if (isIgnored(rules, p)) ignored.push(p); else untracked.push(p);
  }
  return { staged, unstaged, untracked, ignored, conflicts, head, wt };
}

export function isClean(repo) {
  const s = computeStatus(repo);
  return !s.staged.length && !s.unstaged.length && !s.conflicts.length;
}

// Collapse untracked files into their top-level untracked directory, the way git status shows them.
export function collapseUntracked(repo, untracked) {
  const tracked = new Set(repo.index.keys());
  const trackedDirs = new Set();
  for (const t of tracked) {
    const segs = t.split('/');
    for (let i = 1; i < segs.length; i++) trackedDirs.add(segs.slice(0, i).join('/'));
  }
  const out = new Set();
  for (const p of untracked) {
    const segs = p.split('/');
    let shown = p;
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      if (!trackedDirs.has(d)) { shown = d + '/'; break; }
    }
    out.add(shown);
  }
  return [...out].sort();
}

// ---------- checkout / reset ----------

// Move index + working tree from the HEAD tree to `target` (flat map), keeping
// unrelated local changes. Throws if local changes would be overwritten.
export function checkoutTree(repo, target, { force = false, from = null } = {}) {
  const w = repo.world;
  const head = from || headTreeFlat(repo);
  const wt = worktree(repo);
  const blocked = [];
  const untrackedBlocked = [];
  const paths = new Set([...head.keys(), ...target.keys()]);
  for (const p of paths) {
    if (head.get(p) === target.get(p)) continue;
    const inIndex = repo.index.get(p);
    const work = wt.has(p) ? w.blobHash(wt.get(p)) : undefined;
    if (!head.has(p)) {
      if (wt.has(p) && !inIndex && work !== target.get(p)) untrackedBlocked.push(p);
      else if (inIndex && inIndex !== target.get(p)) blocked.push(p);
      continue;
    }
    if (inIndex !== head.get(p) || work !== inIndex) {
      if (!(inIndex === target.get(p) && work === target.get(p))) blocked.push(p);
    }
  }
  if (!force && (blocked.length || untrackedBlocked.length)) {
    let msg = '';
    if (blocked.length) msg += `error: Your local changes to the following files would be overwritten by checkout:\n${blocked.map(p => '\t' + p).join('\n')}\nPlease commit your changes or stash them before you switch branches.\n`;
    if (untrackedBlocked.length) msg += `error: The following untracked working tree files would be overwritten by checkout:\n${untrackedBlocked.map(p => '\t' + p).join('\n')}\nPlease move or remove them before you switch branches.\n`;
    throw new GitError(msg + 'Aborting', 1);
  }
  for (const p of paths) {
    if (!force && head.get(p) === target.get(p)) continue;
    const t = target.get(p);
    if (t) {
      repo.index.set(p, t);
      writeWork(repo, p, w.objects.get(t).content);
    } else {
      repo.index.delete(p);
      removeWork(repo, p);
    }
  }
  if (force) {
    for (const p of [...repo.index.keys()]) if (!target.has(p)) repo.index.delete(p);
    repo.conflicts.clear();
  }
  w.pruneEmptyDirs(repo.root);
}

export function resetHard(repo, hash) {
  const target = commitTreeFlat(repo, hash);
  const wt = worktree(repo);
  // remove tracked files that are not in target
  for (const p of new Set([...repo.index.keys(), ...repo.conflicts.keys()])) {
    if (!target.has(p) && wt.has(p)) removeWork(repo, p);
  }
  repo.index = new Map(target);
  repo.conflicts.clear();
  for (const [p, h] of target) writeWork(repo, p, repo.world.objects.get(h).content);
  repo.world.pruneEmptyDirs(repo.root);
}

// ---------- commits ----------

export function identity(repo) {
  const g = repo.world.globalConfig;
  const name = repo.config['user.name'] || g['user.name'];
  const email = repo.config['user.email'] || g['user.email'];
  return { name, email };
}

export function requireIdentity(repo) {
  const id = identity(repo);
  if (!id.name || !id.email) {
    throw new GitError(`Author identity unknown

*** Please tell me who you are.

Run

  git config --global user.email "you@example.com"
  git config --global user.name "Your Name"

to set your account's default identity.
Omit --global to set the identity only in this repository.

fatal: unable to auto-detect email address (got 'dev@conquest.(none)')`);
  }
  return id;
}

export function indexTree(repo) {
  return repo.world.writeTree(repo.index);
}

export function makeCommit(repo, { message, parents, tree, author }) {
  const w = repo.world;
  const id = requireIdentity(repo);
  w.tick();
  const committer = { ...id, time: w.time };
  return w.writeCommit({ tree: tree || indexTree(repo), parents, message, author: author || committer, committer });
}

// ---------- merging trees ----------

// Returns {result: Map, conflicts: [{path, base, ours, theirs, text, kind}]}.
export function mergeTrees(world, base, ours, theirs, labels) {
  const result = new Map();
  const conflicts = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const p of [...paths].sort()) {
    const b = base.get(p), o = ours.get(p), t = theirs.get(p);
    if (o === t) { if (o) result.set(p, o); continue; }
    if (b === o) { if (t) result.set(p, t); continue; }
    if (b === t) { if (o) result.set(p, o); continue; }
    if (o && t) {
      const bt = b ? world.objects.get(b).content : '';
      const m = merge3(bt, world.objects.get(o).content, world.objects.get(t).content, labels);
      if (!m.conflict) { result.set(p, world.writeBlob(m.text)); continue; }
      conflicts.push({ path: p, base: b || null, ours: o, theirs: t, text: m.text, kind: b ? 'content' : 'add/add' });
      continue;
    }
    // one side deleted, the other modified
    conflicts.push({ path: p, base: b, ours: o || null, theirs: t || null, text: world.objects.get(o || t).content, kind: 'modify/delete', deletedBy: o ? 'theirs' : 'ours' });
  }
  return { result, conflicts };
}

// Apply a merge result to index + worktree (starting from HEAD == ours).
export function applyMerge(repo, ours, merge) {
  const w = repo.world;
  const all = new Set([...ours.keys(), ...merge.result.keys(), ...merge.conflicts.map(c => c.path)]);
  for (const p of all) {
    const c = merge.conflicts.find(x => x.path === p);
    if (c) {
      repo.index.delete(p);
      repo.conflicts.set(p, { base: c.base, ours: c.ours, theirs: c.theirs });
      writeWork(repo, p, c.text);
      continue;
    }
    const h = merge.result.get(p);
    if (h) {
      repo.index.set(p, h);
      writeWork(repo, p, w.objects.get(h).content);
    } else {
      repo.index.delete(p);
      removeWork(repo, p);
    }
  }
  w.pruneEmptyDirs(repo.root);
}

export function conflictLines(merge, theirsLabel = 'theirs') {
  const out = [];
  const touched = new Set();
  for (const c of merge.conflicts) {
    if (c.kind === 'content') { out.push(`Auto-merging ${c.path}`); out.push(`CONFLICT (content): Merge conflict in ${c.path}`); }
    else if (c.kind === 'add/add') { out.push(`Auto-merging ${c.path}`); out.push(`CONFLICT (add/add): Merge conflict in ${c.path}`); }
    else out.push(`CONFLICT (modify/delete): ${c.path} deleted in ${c.deletedBy === 'ours' ? 'HEAD' : theirsLabel} and modified in ${c.deletedBy === 'ours' ? theirsLabel : 'HEAD'}. Version of ${c.path} left in tree.`);
    touched.add(c.path);
  }
  return out;
}

export function describeCommit(world, hash) {
  const c = world.commit(hash);
  return `${shortHash(hash)} ${c.message.split('\n')[0]}`;
}
