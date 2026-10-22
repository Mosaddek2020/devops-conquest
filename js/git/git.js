// Porcelain git commands for the simulator. Output text follows real git (2.4x) closely so
// that what a learner sees here is what they will see in a real terminal.

import { GitError, C, shortHash, formatDate, isoDate, relativeTime, normPath, stripAnsi } from './world.js';
import { unifiedHunks, diffStats, splitLines, diffLines } from './diff.js';
import {
  headRef, currentBranch, headCommit, updateRef, setHeadCommit, switchHead, branchNames, upstreamOf,
  validRefName, resolve, resolveCommit, ancestors, isAncestor, mergeBase, revList, commitTreeFlat,
  headTreeFlat, toRepoPath, worktree, readWork, writeWork, removeWork, ignoreRules, isIgnored,
  computeStatus, collapseUntracked, checkoutTree, resetHard, requireIdentity, indexTree, makeCommit,
  mergeTrees, applyMerge, conflictLines, describeCommit, logRef, identity,
} from './core.js';
import { remoteCommands } from './remote.js';

export const GIT_VERSION = '2.47.0';

// ---------- argument parsing ----------

export function parseOpts(args, { bool = [], val = [], alias = {} } = {}) {
  const o = { _: [], paths: null };
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (a === '--') { o.paths = args.slice(i + 1); break; }
    if (alias[a]) a = alias[a];
    if (a.startsWith('--') && a.includes('=')) {
      const k = a.slice(0, a.indexOf('='));
      const key = alias[k] || k;
      if (!val.includes(key) && !bool.includes(key)) throw new GitError(`error: unknown option \`${k.slice(2)}'`, 129);
      o[key] = a.slice(a.indexOf('=') + 1);
      continue;
    }
    if (val.includes(a)) {
      if (i + 1 >= args.length) throw new GitError(`error: option \`${a.replace(/^-+/, '')}' requires a value`, 129);
      o[a] = args[++i];
      if (a === '-m') (o.mList = o.mList || []).push(o[a]);
      continue;
    }
    if (bool.includes(a)) { o[a] = true; continue; }
    if (/^-[a-zA-Z]{2,}$/.test(a)) {
      let ok = true;
      for (let j = 1; j < a.length; j++) {
        const f = alias['-' + a[j]] || '-' + a[j];
        if (val.includes(f)) {
          const rest = a.slice(j + 1);
          o[f] = rest || args[++i];
          if (f === '-m') (o.mList = o.mList || []).push(o[f]);
          break;
        }
        if (bool.includes(f)) o[f] = true; else { ok = false; break; }
      }
      if (ok) continue;
    }
    if (/^-\d+$/.test(a) && val.includes('-n')) { o['-n'] = a.slice(1); continue; }
    if (a.startsWith('-') && a.length > 1) {
      throw new GitError(`error: unknown ${a.startsWith('--') ? 'option' : 'switch'} \`${a.replace(/^-+/, '')}'`, 129);
    }
    o._.push(a);
  }
  return o;
}

// ---------- context helpers ----------

function needRepo(ctx) {
  if (!ctx.repo) throw new GitError('fatal: not a git repository (or any of the parent directories): .git');
  return ctx.repo;
}

function needWorkTree(ctx) {
  const repo = needRepo(ctx);
  if (repo.bare) throw new GitError('fatal: this operation must be run in a work tree');
  return repo;
}

export function relPath(ctx, arg) {
  const repo = ctx.repo;
  const abs = arg.startsWith('/') ? normPath(arg) : normPath(ctx.cwd + '/' + arg);
  const rel = toRepoPath(repo, abs);
  if (rel === null) throw new GitError(`fatal: ${arg}: '${arg}' is outside repository at '${repo.root}'`);
  return rel;
}

function displayPath(ctx, rel) {
  const cwdRel = toRepoPath(ctx.repo, ctx.cwd) || '';
  if (!cwdRel) return rel;
  if (rel.startsWith(cwdRel + '/')) return rel.slice(cwdRel.length + 1);
  const up = cwdRel.split('/').map(() => '..').join('/');
  return up + '/' + rel;
}

function specMatcher(ctx, specs) {
  const matchers = specs.map(s => {
    if (/[*?]/.test(s)) {
      const base = toRepoPath(ctx.repo, ctx.cwd) || '';
      const pat = (base ? base + '/' : '') + s;
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.') + '$');
      const reAny = new RegExp('(^|/)' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
      return p => re.test(p) || (!s.includes('/') && reAny.test(p) && p.startsWith(base));
    }
    const rel = relPath(ctx, s);
    return p => rel === '' || p === rel || p.startsWith(rel + '/');
  });
  return p => matchers.some(m => m(p));
}

function pl(n, word, plural = word + 's') { return `${n} ${n === 1 ? word : plural}`; }

function firstLine(msg) { return msg.split('\n')[0]; }

function refsByCommit(repo) {
  const map = new Map();
  const add = (h, label) => { if (!map.has(h)) map.set(h, []); map.get(h).push(label); };
  for (const [ref, h] of Object.entries(repo.refs)) {
    const peeled = repo.world.peel(h);
    if (ref.startsWith('refs/heads/')) add(peeled, { kind: 'branch', name: ref.slice(11) });
    else if (ref.startsWith('refs/remotes/')) add(peeled, { kind: 'remote', name: ref.slice(13) });
    else if (ref.startsWith('refs/tags/')) add(peeled, { kind: 'tag', name: ref.slice(10) });
  }
  return map;
}

function decorate(repo, hash, map) {
  const labels = map.get(hash) || [];
  const parts = [];
  const cur = currentBranch(repo);
  const detached = !headRef(repo) && headCommit(repo) === hash;
  if (detached) parts.push(C.bold(C.cyan('HEAD')));
  for (const l of labels) if (l.kind === 'branch' && l.name === cur) parts.push(C.bold(C.cyan('HEAD -> ')) + C.bold(C.green(cur)));
  for (const l of labels) if (l.kind === 'remote') parts.push(C.bold(C.red(l.name)));
  for (const l of labels) if (l.kind === 'branch' && l.name !== cur) parts.push(C.bold(C.green(l.name)));
  for (const l of labels) if (l.kind === 'tag') parts.push(C.bold(C.yellow('tag: ' + l.name)));
  if (!parts.length) return '';
  return C.yellow(' (') + parts.join(C.yellow(', ')) + C.yellow(')');
}

function trackingInfo(repo) {
  const b = currentBranch(repo);
  if (!b) return null;
  const up = upstreamOf(repo, b);
  if (!up) return null;
  const remoteHash = repo.refs[up.ref];
  const label = `${up.remote}/${up.branch}`;
  if (!remoteHash) return { label, gone: true };
  const local = repo.refs['refs/heads/' + b];
  const ahead = local ? revList(repo.world, [local], [remoteHash]).length : 0;
  const behind = local ? revList(repo.world, [remoteHash], [local]).length : 0;
  return { label, ahead, behind };
}

// ---------- diff output ----------

function fileDiff(world, path, oldHash, newHash, newContentOverride, opts = {}) {
  const out = [];
  const oldText = oldHash ? world.objects.get(oldHash).content : '';
  const newText = newContentOverride !== undefined ? newContentOverride : (newHash ? world.objects.get(newHash).content : '');
  const newH = newContentOverride !== undefined ? world.blobHash(newContentOverride) : newHash;
  out.push(C.bold(`diff --git a/${path} b/${path}`));
  if (!oldHash) { out.push(C.bold('new file mode 100644')); out.push(C.bold(`index 0000000..${shortHash(newH)}`)); }
  else if (!newH) { out.push(C.bold('deleted file mode 100644')); out.push(C.bold(`index ${shortHash(oldHash)}..0000000`)); }
  else out.push(C.bold(`index ${shortHash(oldHash)}..${shortHash(newH)} 100644`));
  const hunks = unifiedHunks(oldText, newText, opts.context ?? 3);
  if (!hunks.length) return out.slice(0, 2);
  out.push(C.bold(oldHash ? `--- a/${path}` : '--- /dev/null'));
  out.push(C.bold(newH ? `+++ b/${path}` : '+++ /dev/null'));
  for (const h of hunks) {
    if (h.startsWith('@@')) out.push(C.cyan(h));
    else if (h.startsWith('+')) out.push(C.green(h));
    else if (h.startsWith('-')) out.push(C.red(h));
    else out.push(h);
  }
  return out;
}

// pairs: [{path, old, new, newContent?}]
function renderDiff(ctx, pairs, o) {
  const w = ctx.world;
  const out = [];
  if (o['--name-only']) { for (const p of pairs) out.push(p.path); return out; }
  if (o['--name-status']) {
    for (const p of pairs) out.push(`${!p.old ? 'A' : (!p.new && p.newContent === undefined) ? 'D' : 'M'}\t${p.path}`);
    return out;
  }
  if (o['--stat']) return statLines(w, pairs);
  for (const p of pairs) out.push(...fileDiff(w, p.path, p.old, p.new, p.newContent));
  return out;
}

function statLines(w, pairs) {
  const out = [];
  let ins = 0, del = 0;
  const width = Math.max(0, ...pairs.map(p => p.path.length));
  for (const p of pairs) {
    const a = p.old ? w.objects.get(p.old).content : '';
    const b = p.newContent !== undefined ? p.newContent : (p.new ? w.objects.get(p.new).content : '');
    const s = diffStats(a, b);
    ins += s.add; del += s.del;
    const bar = C.green('+'.repeat(Math.min(s.add, 30))) + C.red('-'.repeat(Math.min(s.del, 30)));
    out.push(` ${p.path.padEnd(width)} | ${String(s.add + s.del).padStart(2)} ${bar}`);
  }
  out.push(summaryLine(pairs.length, ins, del));
  return out;
}

function summaryLine(files, ins, del) {
  let s = ` ${pl(files, 'file')} changed`;
  if (ins || !del) s += `, ${pl(ins, 'insertion')}(+)`;
  if (del) s += `, ${pl(del, 'deletion')}(-)`;
  return s;
}

function treePairs(a, b, match) {
  const pairs = [];
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (match && !match(p)) continue;
    if (a.get(p) !== b.get(p)) pairs.push({ path: p, old: a.get(p) || null, new: b.get(p) || null });
  }
  return pairs;
}

function commitStat(w, before, after) {
  const pairs = treePairs(before, after);
  let ins = 0, del = 0;
  const modes = [];
  for (const p of pairs) {
    const s = diffStats(p.old ? w.objects.get(p.old).content : '', p.new ? w.objects.get(p.new).content : '');
    ins += s.add; del += s.del;
    if (!p.old) modes.push(` create mode 100644 ${p.path}`);
    if (!p.new) modes.push(` delete mode 100644 ${p.path}`);
  }
  return [summaryLine(pairs.length, ins, del), ...modes];
}

// ---------- commands ----------

const commands = {};

commands.version = (ctx) => { ctx.out.push(`git version ${GIT_VERSION}`); return 0; };

commands.help = (ctx) => {
  ctx.out.push(
    'usage: git <command> [<args>]', '',
    'start a working area', '   clone      init',
    'work on the current change', '   add  mv  restore  rm',
    'examine the history and state', '   bisect  diff  grep  log  show  status  blame  reflog',
    'grow, mark and tweak your common history', '   branch  commit  merge  rebase  reset  switch  tag  cherry-pick  revert  stash',
    'collaborate', '   fetch  pull  push  remote',
    'look under the hood', '   cat-file  hash-object  rev-parse  ls-files  config',
    '', C.dim('This is the Git Conquest simulator. Every command above works here.'));
  return 0;
};

commands.init = (ctx, args) => {
  const o = parseOpts(args, { bool: ['-q', '--quiet', '--bare'], val: ['-b', '--initial-branch'] });
  const dir = o._[0] ? normPath(ctx.cwd + '/' + o._[0]) : ctx.cwd;
  const w = ctx.world;
  if (w.repos.has(dir)) {
    ctx.out.push(`Reinitialized existing Git repository in ${dir}/.git/`);
    return 0;
  }
  const repo = w.createRepo(dir);
  const b = o['-b'] || o['--initial-branch'] || w.globalConfig['init.defaultBranch'] || 'master';
  repo.HEAD = 'ref: refs/heads/' + b;
  if (!w.globalConfig['init.defaultBranch'] && !o['-b']) {
    ctx.out.push(C.yellow(`hint: Using 'master' as the name for the initial branch. This default branch name`),
      C.yellow(`hint: is subject to change. To configure the initial branch name to use in all`),
      C.yellow(`hint: of your new repositories, which will suppress this warning, call:`),
      C.yellow(`hint:`), C.yellow(`hint: \tgit config --global init.defaultBranch <name>`));
  }
  if (!o['-q']) ctx.out.push(`Initialized empty Git repository in ${dir}/.git/`);
  w.emit({ type: 'init', root: dir });
  return 0;
};

commands.config = (ctx, args) => {
  const o = parseOpts(args, { bool: ['--global', '--local', '--list', '-l', '--unset', '--get', '--show-origin', '--system'], val: [] });
  const w = ctx.world;
  const scope = o['--global'] || o['--system'] ? w.globalConfig : (ctx.repo ? ctx.repo.config : null);
  if (o['--list'] || o['-l']) {
    const showG = !o['--local'];
    const showL = !o['--global'] && ctx.repo;
    if (showG) for (const [k, v] of Object.entries(w.globalConfig)) ctx.out.push(`${o['--show-origin'] ? 'file:~/.gitconfig\t' : ''}${k}=${v}`);
    if (showL) for (const [k, v] of Object.entries(ctx.repo.config)) ctx.out.push(`${o['--show-origin'] ? 'file:.git/config\t' : ''}${k}=${v}`);
    return 0;
  }
  const key = o._[0];
  if (!key) throw new GitError('usage: git config [<options>]', 129);
  if (!scope) throw new GitError('fatal: --local can only be used inside a git repository');
  if (!/^[a-zA-Z][\w-]*(\.[^\s]+)?\.[a-zA-Z][\w-]*$/.test(key)) throw new GitError(`error: key does not contain a section: ${key}`, 2);
  const k = key.replace(/^([^.]+)\./, (m, s) => s.toLowerCase() + '.');
  if (o['--unset']) { delete scope[k]; return 0; }
  if (o._.length === 1 || o['--get']) {
    const v = (ctx.repo && !o['--global'] && ctx.repo.config[k] !== undefined) ? ctx.repo.config[k] : w.globalConfig[k];
    if (v === undefined) return 1;
    ctx.out.push(v);
    return 0;
  }
  scope[k] = o._.slice(1).join(' ');
  w.emit({ type: 'config', key: k, value: scope[k], global: scope === w.globalConfig });
  return 0;
};

commands.status = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['-s', '--short', '-b', '--branch', '--ignored', '-u', '-uall'], val: [] });
  const st = computeStatus(repo);
  const w = ctx.world;
  const branch = currentBranch(repo);
  const dp = p => displayPath(ctx, p);
  if (o['-s'] || o['--short']) {
    if (o['-b'] || o['--branch']) {
      const t = trackingInfo(repo);
      let line = `## ${branch || 'HEAD (no branch)'}`;
      if (!headCommit(repo)) line = `## No commits yet on ${branch}`;
      if (t && !t.gone) {
        line += `...${t.label}`;
        const bits = [];
        if (t.ahead) bits.push(`ahead ${t.ahead}`);
        if (t.behind) bits.push(`behind ${t.behind}`);
        if (bits.length) line += ` [${bits.join(', ')}]`;
      }
      ctx.out.push(line);
    }
    const map = new Map();
    for (const s of st.staged) map.set(s.path, [{ 'new file': 'A', modified: 'M', deleted: 'D', renamed: 'R' }[s.kind], ' ', s]);
    for (const s of st.unstaged) { const e = map.get(s.path) || [' ', ' ', s]; e[1] = s.kind === 'deleted' ? 'D' : 'M'; map.set(s.path, e); }
    for (const c of st.conflicts) ctx.out.push(`${C.red(c.kind === 'both added' ? 'AA' : c.kind === 'deleted by us' ? 'DU' : c.kind === 'deleted by them' ? 'UD' : 'UU')} ${dp(c.path)}`);
    for (const [p, [x, y, s]] of [...map].sort()) {
      const name = s.kind === 'renamed' && s.from ? `${dp(s.from)} -> ${dp(p)}` : dp(p);
      ctx.out.push(`${C.green(x)}${C.red(y)} ${name}`);
    }
    for (const u of collapseUntracked(repo, st.untracked)) ctx.out.push(`${C.red('??')} ${dp(u)}`);
    if (o['--ignored']) for (const i of st.ignored) ctx.out.push(`${C.red('!!')} ${dp(i)}`);
    return 0;
  }

  if (branch) ctx.out.push(`On branch ${branch}`);
  else {
    const reflog = repo.reflog.HEAD || [];
    ctx.out.push(C.red(`HEAD detached at ${shortHash(headCommit(repo))}`));
    void reflog;
  }
  if (repo.state?.type === 'rebase') {
    const s = repo.state;
    ctx.out.push(`${s.interactive ? 'interactive rebase' : 'You are currently rebasing'}${s.interactive ? ' in progress; onto ' + shortHash(s.onto) : ` branch '${(s.headName || '').replace('refs/heads/', '')}' on '${shortHash(s.onto)}'.`}`);
    if (st.conflicts.length) {
      ctx.out.push('  (fix conflicts and then run "git rebase --continue")', '  (use "git rebase --skip" to skip this patch)', '  (use "git rebase --abort" to check out the original branch)');
    } else if (s.stopped === 'edit') {
      ctx.out.push('  (use "git commit --amend" to amend the current commit)', '  (use "git rebase --continue" once you are satisfied with your changes)');
    } else ctx.out.push('  (all conflicts fixed: run "git rebase --continue")');
    ctx.out.push('');
  }
  if (repo.state?.type === 'cherry-pick' || repo.state?.type === 'revert') {
    const verb = repo.state.type;
    ctx.out.push(`You are currently ${verb === 'revert' ? 'reverting' : 'cherry-picking'} commit ${shortHash(repo.state.commit)}.`);
    ctx.out.push(st.conflicts.length ? `  (fix conflicts and run "git ${verb} --continue")` : `  (all conflicts fixed: run "git ${verb} --continue")`);
    ctx.out.push(`  (use "git ${verb} --skip" to skip this patch)`, `  (use "git ${verb} --abort" to cancel the ${verb} operation)`, '');
  }
  if (repo.bisect) ctx.out.push(`You are currently bisecting, started from branch '${repo.bisect.startBranch || 'HEAD'}'.`, '  (use "git bisect reset" to get back to the original branch)', '');
  const t = trackingInfo(repo);
  if (t) {
    if (t.gone) ctx.out.push(`Your branch is based on '${t.label}', but the upstream is gone.`, '  (use "git branch --unset-upstream" to fixup)');
    else if (!t.ahead && !t.behind) ctx.out.push(`Your branch is up to date with '${t.label}'.`);
    else if (t.ahead && !t.behind) ctx.out.push(`Your branch is ahead of '${t.label}' by ${pl(t.ahead, 'commit')}.`, '  (use "git push" to publish your local commits)');
    else if (!t.ahead && t.behind) ctx.out.push(`Your branch is behind '${t.label}' by ${pl(t.behind, 'commit')}, and can be fast-forwarded.`, '  (use "git pull" to update your local branch)');
    else ctx.out.push(`Your branch and '${t.label}' have diverged,`, `and have ${t.ahead} and ${t.behind} different commits each, respectively.`, '  (use "git pull" if you want to integrate the remote branch with yours)');
  }
  ctx.out.push('');
  if (!headCommit(repo)) { ctx.out.push('No commits yet', ''); }
  if (repo.state?.type === 'merge') {
    if (st.conflicts.length) ctx.out.push('You have unmerged paths.', '  (fix conflicts and run "git commit")', '  (use "git merge --abort" to abort the merge)', '');
    else ctx.out.push('All conflicts fixed but you are still merging.', '  (use "git commit" to conclude merge)', '');
  }
  const kindLabel = k => (k + ':').padEnd(12);
  if (st.staged.length) {
    ctx.out.push('Changes to be committed:', headCommit(repo) ? '  (use "git restore --staged <file>..." to unstage)' : '  (use "git rm --cached <file>..." to unstage)');
    for (const s of st.staged) ctx.out.push(C.green(`\t${kindLabel(s.kind)}${s.kind === 'renamed' ? `${dp(s.from)} -> ${dp(s.path)}` : dp(s.path)}`));
    ctx.out.push('');
  }
  if (st.conflicts.length) {
    ctx.out.push('Unmerged paths:', '  (use "git add <file>..." to mark resolution)');
    for (const c of st.conflicts) ctx.out.push(C.red(`\t${(c.kind + ':').padEnd(17)}${dp(c.path)}`));
    ctx.out.push('');
  }
  if (st.unstaged.length) {
    ctx.out.push('Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)');
    for (const s of st.unstaged) ctx.out.push(C.red(`\t${kindLabel(s.kind)}${dp(s.path)}`));
    ctx.out.push('');
  }
  const unt = collapseUntracked(repo, st.untracked);
  if (unt.length) {
    ctx.out.push('Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const u of unt) ctx.out.push(C.red(`\t${dp(u)}`));
    ctx.out.push('');
  }
  if (o['--ignored'] && st.ignored.length) {
    ctx.out.push('Ignored files:', '  (use "git add -f <file>..." to include in what will be committed)');
    for (const i of st.ignored) ctx.out.push(C.red(`\t${dp(i)}`));
    ctx.out.push('');
  }
  if (!st.staged.length && !st.conflicts.length) {
    if (st.unstaged.length) ctx.out.push('no changes added to commit (use "git add" and/or "git commit -a")');
    else if (unt.length) ctx.out.push(`nothing added to commit but untracked files present (use "git add" to track)`);
    else if (!headCommit(repo)) ctx.out.push('nothing to commit (create/copy files and use "git add" to track)');
    else if (!repo.state) ctx.out.push('nothing to commit, working tree clean');
  }
  while (ctx.out.length && ctx.out[ctx.out.length - 1] === '') ctx.out.pop();
  return 0;
};

commands.add = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['-A', '--all', '-u', '--update', '-f', '--force', '-v', '--verbose', '-n', '--dry-run', '-p', '--patch', '.'], val: [] });
  if (o['-p'] || o['--patch']) {
    ctx.out.push(C.dim('(git add -p lets you stage individual hunks. The simulator stages whole files; try `git add <file>`.)'));
    return 0;
  }
  const specs = [...o._, ...(o['.'] ? ['.'] : []), ...(o.paths || [])];
  const all = o['-A'] || o['--all'];
  const update = o['-u'] || o['--update'];
  if (!specs.length && !all && !update) {
    ctx.out.push('Nothing specified, nothing added.', C.yellow(`hint: Maybe you wanted to say 'git add .'?`),
      C.yellow('hint: Disable this message with "git config advice.addEmptyPathspec false"'));
    return 0;
  }
  const w = ctx.world;
  const wt = worktree(repo);
  const rules = ignoreRules(repo, wt);
  const match = specs.length ? specMatcher(ctx, specs) : () => true;
  let matched = false;
  const ignoredHits = [];
  // explicit file that does not exist and is not tracked
  for (const s of specs) {
    if (/[*?]/.test(s)) continue;
    const rel = relPath(ctx, s);
    const exists = rel === '' || wt.has(rel) || [...wt.keys()].some(p => p.startsWith(rel + '/')) || repo.index.has(rel) || repo.conflicts.has(rel) || [...repo.index.keys()].some(p => p.startsWith(rel + '/'));
    if (!exists) throw new GitError(`fatal: pathspec '${s}' did not match any files`);
  }
  for (const [p, content] of wt) {
    if (!match(p)) continue;
    const tracked = repo.index.has(p) || repo.conflicts.has(p);
    if (update && !tracked) continue;
    if (!tracked && isIgnored(rules, p) && !(o['-f'] || o['--force'])) {
      if (specs.some(s => !/[*?]/.test(s) && relPath(ctx, s) === p)) ignoredHits.push(p);
      continue;
    }
    matched = true;
    const h = w.writeBlob(content);
    if (o['-n'] || o['--dry-run']) { ctx.out.push(`add '${p}'`); continue; }
    if (repo.index.get(p) !== h || repo.conflicts.has(p)) {
      if (o['-v'] || o['--verbose']) ctx.out.push(`add '${p}'`);
      repo.index.set(p, h);
      repo.conflicts.delete(p);
    }
  }
  // deletions
  for (const p of [...repo.index.keys(), ...repo.conflicts.keys()]) {
    if (wt.has(p) || !match(p)) continue;
    if (!specs.length && !all && !update) continue;
    if (o['-n'] || o['--dry-run']) { ctx.out.push(`remove '${p}'`); continue; }
    repo.index.delete(p);
    repo.conflicts.delete(p);
    matched = true;
  }
  if (ignoredHits.length) {
    ctx.out.push('The following paths are ignored by one of your .gitignore files:', ...ignoredHits,
      C.yellow('hint: Use -f if you really want to add them.'),
      C.yellow('hint: Disable this message with "git config advice.addIgnoredFile false"'));
    return 1;
  }
  void matched;
  w.emit({ type: 'add' });
  return 0;
};

commands.rm = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['--cached', '-r', '-f', '--force', '-q', '-rf', '-n'], val: [] });
  const specs = [...o._, ...(o.paths || [])];
  if (!specs.length) throw new GitError('usage: git rm [<options>] [--] <file>...', 129);
  const match = specMatcher(ctx, specs);
  const hits = [...new Set([...repo.index.keys(), ...repo.conflicts.keys()])].filter(match);
  if (!hits.length) throw new GitError(`fatal: pathspec '${specs[0]}' did not match any files`);
  for (const s of specs) {
    const rel = relPath(ctx, s);
    if (!o['-r'] && !o['-rf'] && !repo.index.has(rel) && hits.some(h => h.startsWith(rel + '/'))) {
      throw new GitError(`fatal: not removing '${s}' recursively without -r`);
    }
  }
  const head = headTreeFlat(repo);
  if (!o['--cached'] && !o['-f'] && !o['--force'] && !o['-rf']) {
    const dirty = hits.filter(p => {
      if (repo.conflicts.has(p)) return false;
      const work = readWork(repo, p);
      return repo.index.get(p) !== head.get(p) || (work !== undefined && ctx.world.blobHash(work) !== repo.index.get(p));
    });
    if (dirty.length) throw new GitError(`error: the following file has local modifications:\n${dirty.map(d => '    ' + d).join('\n')}\n(use --cached to keep the file, or -f to force removal)`, 1);
  }
  for (const p of hits) {
    ctx.out.push(`rm '${p}'`);
    repo.index.delete(p);
    repo.conflicts.delete(p);
    if (!o['--cached']) removeWork(repo, p);
  }
  ctx.world.pruneEmptyDirs(repo.root);
  return 0;
};

commands.mv = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['-f', '-n', '-v'], val: [] });
  if (o._.length !== 2) throw new GitError('usage: git mv [<options>] <source>... <destination>', 129);
  let src = relPath(ctx, o._[0]);
  let dst = relPath(ctx, o._[1]);
  const w = ctx.world;
  if (!repo.index.has(src)) {
    const under = [...repo.index.keys()].filter(p => p.startsWith(src + '/'));
    if (!under.length) throw new GitError(`fatal: not under version control, source=${src}, destination=${dst}`);
    for (const p of under) {
      const np = dst + p.slice(src.length);
      repo.index.set(np, repo.index.get(p)); repo.index.delete(p);
      writeWork(repo, np, readWork(repo, p)); removeWork(repo, p);
    }
    w.pruneEmptyDirs(repo.root);
    return 0;
  }
  if (w.isDir(repo.root + '/' + dst)) dst = dst + '/' + src.split('/').pop();
  if (readWork(repo, dst) !== undefined && !o['-f']) throw new GitError(`fatal: destination exists, source=${src}, destination=${dst}`);
  const content = readWork(repo, src);
  writeWork(repo, dst, content); removeWork(repo, src);
  repo.index.set(dst, repo.index.get(src)); repo.index.delete(src);
  w.pruneEmptyDirs(repo.root);
  if (o['-v']) ctx.out.push(`Renaming ${src} to ${dst}`);
  return 0;
};

function commitTemplate(repo, extra = '') {
  const st = computeStatus(repo);
  const b = currentBranch(repo);
  const lines = [extra, '# Please enter the commit message for your changes. Lines starting', "# with '#' will be ignored, and an empty message aborts the commit.", '#'];
  lines.push(b ? `# On branch ${b}` : `# HEAD detached at ${shortHash(headCommit(repo))}`);
  if (st.staged.length) {
    lines.push('# Changes to be committed:');
    for (const s of st.staged) lines.push(`#\t${(s.kind + ':').padEnd(12)}${s.path}`);
  }
  lines.push('#');
  return lines.join('\n');
}

function cleanMessage(text) {
  return text.split('\n').filter(l => !l.startsWith('#')).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

commands.commit = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, {
    bool: ['-a', '--all', '--amend', '--no-edit', '--allow-empty', '-q', '--quiet', '-v', '--no-verify', '-n'],
    val: ['-m', '--message', '-F', '--author', '-C', '--fixup'],
  });
  const w = ctx.world;
  requireIdentity(repo);
  if (repo.conflicts.size) {
    throw new GitError(`error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.`);
  }
  if (o['-a'] || o['--all']) {
    for (const [p] of [...repo.index]) {
      const work = readWork(repo, p);
      if (work === undefined) repo.index.delete(p);
      else repo.index.set(p, w.writeBlob(work));
    }
  }
  if (o._.length) {
    // `git commit file` commits only those paths (stage them first)
    const match = specMatcher(ctx, o._);
    for (const [p] of [...repo.index]) {
      if (!match(p)) continue;
      const work = readWork(repo, p);
      if (work === undefined) repo.index.delete(p); else repo.index.set(p, w.writeBlob(work));
    }
  }
  const head = headCommit(repo);
  const amend = o['--amend'];
  if (amend && !head) throw new GitError('fatal: You have nothing to amend.');
  const parentsBase = amend ? w.commit(head).parents : (head ? [head] : []);
  const merging = repo.state?.type === 'merge' ? repo.state : null;
  const parents = merging && !amend ? [...parentsBase, merging.mergeHead] : parentsBase;
  const tree = indexTree(repo);
  const compareTree = amend ? (parentsBase[0] ? w.commit(parentsBase[0]).tree : null) : (head ? w.commit(head).tree : null);
  if (tree === (compareTree || w.writeTree(new Map())) && !o['--allow-empty'] && !merging && !amend && repo.state?.type !== 'cherry-pick' && repo.state?.type !== 'revert') {
    if (!head) {
      const st = computeStatus(repo);
      ctx.out.push(`On branch ${currentBranch(repo)}`, '', 'Initial commit', '');
      if (st.untracked.length) { ctx.out.push('Untracked files:', '  (use "git add <file>..." to include in what will be committed)'); for (const u of collapseUntracked(repo, st.untracked)) ctx.out.push(C.red('\t' + u)); ctx.out.push('', 'nothing added to commit but untracked files present (use "git add" to track)'); }
      else ctx.out.push('nothing to commit (create/copy files and use "git add" to track)');
      return 1;
    }
    commands.status(ctx, []);
    return 1;
  }

  const finish = (message, c2 = ctx) => {
    if (!message) { c2.out.push('Aborting commit due to empty commit message.'); return 1; }
    if (repo.hooks['pre-commit'] && !o['--no-verify'] && !o['-n'] && ctx.runHook) {
      const code = ctx.runHook(repo, 'pre-commit', c2);
      if (code !== 0) return 1;
    }
    if (repo.hooks['commit-msg'] && !o['--no-verify'] && ctx.runHook) {
      const code = ctx.runHook(repo, 'commit-msg', c2, message);
      if (code !== 0) return 1;
    }
    let author;
    if (amend && !o['--author']) author = w.commit(head).author;
    if (o['--author']) {
      const m = o['--author'].match(/^(.*?)\s*<(.+)>$/);
      if (!m) throw new GitError(`fatal: --author '${o['--author']}' is not 'Name <email>' and matches no existing author`);
      w.tick(); author = { name: m[1], email: m[2], time: w.time };
    }
    if (repo.state?.type === 'cherry-pick' || repo.state?.type === 'revert') author = repo.state.author || author;
    const h = makeCommit(repo, { message, parents, tree, author });
    const b = currentBranch(repo);
    const verb = amend ? 'commit (amend)' : merging ? 'commit (merge)' : !head ? 'commit (initial)' : 'commit';
    setHeadCommit(repo, h, `${verb}: ${firstLine(message)}`);
    if (merging) repo.state = null;
    if (repo.state?.type === 'cherry-pick' || repo.state?.type === 'revert') repo.state = null;
    if (!o['-q'] && !o['--quiet']) {
      const where = b || `detached HEAD`;
      c2.out.push(`[${where}${!head ? ' (root-commit)' : ''} ${shortHash(h)}] ${firstLine(message)}`);
      if (amend) c2.out.push(` Date: ${formatDate(w.commit(h).author.time)}`);
      const before = parents[0] ? commitTreeFlat(repo, parents[0]) : new Map();
      c2.out.push(...commitStat(w, before, w.readTreeFlat(tree)));
    }
    w.emit({ type: 'commit', hash: h, message });
    return 0;
  };

  const message = o.mList ? o.mList.join('\n\n') : o['--message'];
  if (o['--fixup']) {
    const target = resolveCommit(repo, o['--fixup']);
    return finish(`fixup! ${firstLine(w.commit(target).message)}`);
  }
  if (message !== undefined) return finish(message.replace(/\s+$/, ''));
  if (o['-C']) return finish(w.commit(resolveCommit(repo, o['-C'])).message);
  if (o['--no-edit']) {
    if (amend) return finish(w.commit(head).message);
    if (merging) return finish(merging.msg);
    if (repo.state?.msg) return finish(repo.state.msg);
  }
  const initial = amend ? w.commit(head).message : merging ? merging.msg + (merging.conflicted?.length ? `\n\n# Conflicts:\n${merging.conflicted.map(p => '#\t' + p).join('\n')}` : '') : (repo.state?.msg || '');
  ctx.openEditor({
    title: '.git/COMMIT_EDITMSG',
    content: commitTemplate(repo, initial ? initial + '\n' : ''),
    hint: 'Write your commit message on the first line. Lines starting with # are ignored.',
    onSave: (text, c2) => finish(cleanMessage(text), c2),
  });
  return 0;
};

commands.log = (ctx, args) => {
  const repo = needRepo(ctx);
  const o = parseOpts(args, {
    bool: ['--oneline', '--graph', '--all', '--decorate', '-p', '--patch', '--stat', '--reverse', '--first-parent', '--no-merges', '--merges', '--name-only', '--abbrev-commit', '--follow'],
    val: ['-n', '--max-count', '--author', '--grep', '--format', '--pretty', '--since', '--until', '-S'],
  });
  const w = ctx.world;
  let heads = [], exclude = [];
  const revs = o._.filter(a => !(o.paths === null && !/[.^~@]|^[0-9a-f]{4,40}$/.test(a) && resolve(repo, a, { quiet: true }) === null && (readWork(repo, relPathSafe(ctx, a)) !== undefined)));
  const filePaths = [...(o.paths || []), ...o._.filter(a => !revs.includes(a))];
  for (const r of revs) {
    if (r.includes('...')) {
      const [a, b] = r.split('...');
      const ha = resolveCommit(repo, a || 'HEAD'), hb = resolveCommit(repo, b || 'HEAD');
      heads.push(ha, hb); exclude.push(mergeBase(w, ha, hb));
    } else if (r.includes('..')) {
      const [a, b] = r.split('..');
      exclude.push(resolveCommit(repo, a || 'HEAD')); heads.push(resolveCommit(repo, b || 'HEAD'));
    } else if (r.startsWith('^')) exclude.push(resolveCommit(repo, r.slice(1)));
    else heads.push(resolveCommit(repo, r));
  }
  if (o['--all']) heads.push(...Object.entries(repo.refs).filter(([k]) => !k.startsWith('refs/stash')).map(([, h]) => w.peel(h)), headCommit(repo));
  if (!revs.filter(r => !r.startsWith('^')).length && !o['--all']) {
    const h = headCommit(repo);
    if (!h) throw new GitError(`fatal: your current branch '${currentBranch(repo)}' does not have any commits yet`);
    heads.push(h);
  }
  let list = revList(w, [...new Set(heads.filter(Boolean))], exclude.filter(Boolean), { firstParent: o['--first-parent'] });
  if (o['--no-merges']) list = list.filter(h => w.commit(h).parents.length < 2);
  if (o['--merges']) list = list.filter(h => w.commit(h).parents.length > 1);
  if (o['--author']) { const re = new RegExp(o['--author'], 'i'); list = list.filter(h => re.test(`${w.commit(h).author.name} <${w.commit(h).author.email}>`)); }
  if (o['--grep']) { const re = new RegExp(o['--grep'], 'i'); list = list.filter(h => re.test(w.commit(h).message)); }
  if (o['--since']) { const t = parseWhen(o['--since'], w.time); if (t !== null) list = list.filter(h => w.commit(h).committer.time >= t); }
  if (o['--until']) { const t = parseWhen(o['--until'], w.time); if (t !== null) list = list.filter(h => w.commit(h).committer.time <= t); }
  if (o['-S']) {
    const needle = o['-S'];
    const count = (h) => { let n = 0; for (const [, b] of commitTreeFlat(repo, h)) n += w.objects.get(b).content.split(needle).length - 1; return n; };
    list = list.filter(h => { const c = w.commit(h); return count(h) !== (c.parents[0] ? count(c.parents[0]) : 0); });
  }
  if (filePaths.length) {
    const match = specMatcher(ctx, filePaths);
    list = list.filter(h => {
      const c = w.commit(h);
      const before = c.parents[0] ? commitTreeFlat(repo, c.parents[0]) : new Map();
      return treePairs(before, commitTreeFlat(repo, h), match).length > 0;
    });
  }
  const n = o['-n'] || o['--max-count'];
  if (n) list = list.slice(0, Number(n));
  if (o['--reverse']) list.reverse();

  const refMap = refsByCommit(repo);
  const fmt = o['--format'] || o['--pretty'];
  const lines = [];
  const graphRows = o['--graph'] ? asciiGraph(w, list) : null;
  list.forEach((h, idx) => {
    const c = w.commit(h);
    let body = [];
    if (fmt && fmt !== 'oneline' && fmt !== 'short' && fmt !== 'full') {
      const f = fmt.replace(/^(format|tformat):/, '');
      body.push(f.replace(/%(H|h|s|an|ae|ad|ar|d|D|n|b|cn|P|p|T|t|Cred|Cgreen|Cyellow|Cblue|Creset|ad)/g, (m, k) => ({
        H: h, h: shortHash(h), s: firstLine(c.message), an: c.author.name, ae: c.author.email, ad: formatDate(c.author.time),
        ar: relativeTime(c.author.time, w.time), d: decorate(repo, h, refMap), D: stripAnsi(decorate(repo, h, refMap)).replace(/^ \(|\)$/g, ''), n: '\n', b: c.message.split('\n').slice(2).join('\n'),
        cn: c.committer.name, P: c.parents.join(' '), p: c.parents.map(shortHash).join(' '), T: c.tree, t: shortHash(c.tree),
        Cred: '\x1b[31m', Cgreen: '\x1b[32m', Cyellow: '\x1b[33m', Cblue: '\x1b[34m', Creset: '\x1b[0m',
      })[k] ?? m));
      body = body.join('\n').split('\n');
    } else if (o['--oneline'] || fmt === 'oneline') {
      body.push(`${C.yellow(shortHash(h))}${decorate(repo, h, refMap)} ${firstLine(c.message)}`);
    } else {
      body.push(C.yellow(`commit ${h}`) + decorate(repo, h, refMap));
      if (c.parents.length > 1) body.push(`Merge: ${c.parents.map(shortHash).join(' ')}`);
      body.push(`Author: ${c.author.name} <${c.author.email}>`);
      body.push(`Date:   ${formatDate(c.author.time)}`);
      body.push('');
      for (const l of c.message.split('\n')) body.push('    ' + l);
    }
    if (o['--stat'] || o['-p'] || o['--patch'] || o['--name-only']) {
      const before = c.parents[0] ? commitTreeFlat(repo, c.parents[0]) : new Map();
      const pairs = treePairs(before, commitTreeFlat(repo, h));
      if (!(o['--oneline'])) body.push('');
      if (o['--name-only']) body.push(...pairs.map(p => p.path));
      else if (o['--stat']) body.push(...statLines(w, pairs));
      else for (const p of pairs) body.push(...fileDiff(w, p.path, p.old, p.new));
    }
    if (graphRows) {
      const g = graphRows[idx];
      lines.push(...g.pre);
      body.forEach((l, i) => lines.push((i === 0 ? g.row : g.cont) + l));
      for (const extra of g.after) lines.push(extra);
    } else {
      lines.push(...body);
      if (!o['--oneline'] && fmt !== 'oneline' && !(fmt && fmt.startsWith('format')) && idx < list.length - 1) lines.push('');
    }
  });
  ctx.out.push(...lines);
  return 0;
};

export function parseWhen(s, now) {
  s = String(s).trim().toLowerCase();
  if (s === 'yesterday') return now - 86400;
  if (s === 'today' || s === 'now') return now - (now % 86400);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const t = Date.parse(s.length === 10 ? s + 'T23:59:59Z' : s); return Number.isNaN(t) ? null : Math.floor(t / 1000); }
  const m = s.match(/^(\d+)[\s.]*(second|minute|hour|day|week|month|year)s?(\s+ago)?$/);
  if (!m) return null;
  const unit = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[2]];
  return now - Number(m[1]) * unit;
}

function relPathSafe(ctx, a) {
  try { return relPath(ctx, a); } catch { return '\u0000'; }
}

// A compact ASCII graph in the spirit of `git log --graph`.
export function asciiGraph(w, list) {
  const rows = [];
  let cols = [];
  const inList = new Set(list);
  const draw = (arr, f) => arr.map((c, i) => f(c, i)).join(' ') + ' ';
  for (const h of list) {
    const pre = [];
    // lanes that were waiting for this commit join back first
    const idxs = cols.map((c, i) => (c === h ? i : -1)).filter(i => i >= 0);
    if (idxs.length > 1) {
      const keep = idxs[0];
      const drop = new Set(idxs.slice(1));
      pre.push(draw(cols.slice(0, Math.max(...idxs) + 1), (c, i) => (drop.has(i) ? '/' : c === null ? ' ' : '|')).replace(/\| \//g, '|/'));
      cols = cols.filter((_, i) => !drop.has(i));
      void keep;
    }
    let ci = cols.indexOf(h);
    if (ci === -1) { const free = cols.indexOf(null); if (free >= 0) { cols[free] = h; ci = free; } else { cols.push(h); ci = cols.length - 1; } }
    const row = draw(cols, (c, i) => (i === ci ? C.bold('*') : c === null ? ' ' : '|'));
    const parents = w.commit(h).parents.filter(p => inList.has(p));
    const next = [...cols];
    next[ci] = parents[0] ?? null;
    const after = [];
    if (parents.length > 1) {
      for (const p of parents.slice(1)) if (!next.includes(p)) next.splice(ci + 1, 0, p);
      after.push(draw(next, (c, i) => (i <= ci ? (c === null ? ' ' : '|') : i === ci + 1 ? '\\' : c === null ? ' ' : '|')).replace(/\| \\/g, '|\\'));
    }
    while (next.length && next[next.length - 1] === null) next.pop();
    const cont = next.length ? draw(next, c => (c === null ? ' ' : '|')) : '';
    rows.push({ pre, row, cont, after });
    cols = next;
  }
  return rows;
}

commands.diff = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['--staged', '--cached', '--stat', '--name-only', '--name-status', '--color-words', '--word-diff', '-w'], val: [], alias: { '--cached': '--staged' } });
  const w = ctx.world;
  const pathspecs = o.paths || [];
  let revs = o._;
  // allow `git diff file` without --
  if (revs.length && !o.paths) {
    const asPaths = revs.filter(r => resolve(repo, r.split('..')[0] || 'HEAD', { quiet: true }) === null);
    if (asPaths.length) { pathspecs.push(...asPaths); revs = revs.filter(r => !asPaths.includes(r)); }
  }
  const match = pathspecs.length ? specMatcher(ctx, pathspecs) : () => true;
  let pairs;
  if (revs.length === 1 && revs[0].includes('..')) {
    const [a, b] = revs[0].split(/\.\.\.?/);
    const ha = resolveCommit(repo, a || 'HEAD'), hb = resolveCommit(repo, b || 'HEAD');
    const base = revs[0].includes('...') ? mergeBase(w, ha, hb) : ha;
    pairs = treePairs(commitTreeFlat(repo, base), commitTreeFlat(repo, hb), match);
  } else if (revs.length === 2) {
    pairs = treePairs(commitTreeFlat(repo, resolveCommit(repo, revs[0])), commitTreeFlat(repo, resolveCommit(repo, revs[1])), match);
  } else if (o['--staged']) {
    const base = revs[0] ? commitTreeFlat(repo, resolveCommit(repo, revs[0])) : headTreeFlat(repo);
    pairs = treePairs(base, repo.index, match);
  } else {
    const wt = worktree(repo);
    let base;
    if (revs.length === 1) base = commitTreeFlat(repo, resolveCommit(repo, revs[0]));
    else base = repo.index;
    pairs = [];
    const paths = revs.length === 1 ? new Set([...base.keys(), ...repo.index.keys()]) : new Set([...repo.index.keys(), ...repo.conflicts.keys()]);
    for (const p of [...paths].sort()) {
      if (!match(p)) continue;
      if (repo.conflicts.has(p) && revs.length === 0) {
        const c = repo.conflicts.get(p);
        const content = wt.get(p) ?? '';
        ctx.out.push(C.bold(`diff --cc ${p}`));
        const oursText = c.ours ? w.objects.get(c.ours).content : '';
        for (const l of splitLines(content)) {
          const inOurs = splitLines(oursText).includes(l);
          if (/^(<<<<<<<|=======|>>>>>>>)/.test(l)) ctx.out.push(C.green('++' + l));
          else ctx.out.push(inOurs ? '  ' + l : C.green(' +' + l));
        }
        continue;
      }
      const old = base.get(p);
      const work = wt.get(p);
      if (work === undefined) { if (old) pairs.push({ path: p, old, new: null, newContent: undefined }); continue; }
      if (!old && revs.length === 0) continue;
      if (old && w.blobHash(work) === old) continue;
      pairs.push({ path: p, old: old || null, new: null, newContent: work });
    }
  }
  if (o['--word-diff'] || o['--color-words']) {
    for (const p of pairs) {
      ctx.out.push(C.bold(`diff --git a/${p.path} b/${p.path}`));
      const a = p.old ? w.objects.get(p.old).content : '';
      const b = p.newContent !== undefined ? p.newContent : (p.new ? w.objects.get(p.new).content : '');
      ctx.out.push(...wordDiff(a, b));
    }
    return 0;
  }
  ctx.out.push(...renderDiff(ctx, pairs, o));
  return 0;
};

function wordDiff(a, b) {
  const out = [];
  const la = splitLines(a), lb = splitLines(b);
  const ops = diffLines(la, lb);
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === '=') { i++; continue; }
    const dels = [], adds = [];
    while (i < ops.length && ops[i].op !== '=') { if (ops[i].op === '-') dels.push(la[ops[i].a]); else adds.push(lb[ops[i].b]); i++; }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const wa = (dels[k] || '').split(/(\s+)/), wb = (adds[k] || '').split(/(\s+)/);
      const wo = diffLines(wa, wb);
      out.push(wo.map(x => x.op === '=' ? wa[x.a] : x.op === '-' ? C.red(`[-${wa[x.a]}-]`) : C.green(`{+${wb[x.b]}+}`)).join(''));
    }
  }
  return out;
}

commands.show = (ctx, args) => {
  const repo = needRepo(ctx);
  const o = parseOpts(args, { bool: ['--stat', '--name-only', '--oneline', '-s', '--no-patch'], val: ['--format', '--pretty'] });
  const w = ctx.world;
  const target = o._[0] || 'HEAD';
  if (target.includes(':')) {
    const [rev, path] = target.split(':');
    const h = resolveCommit(repo, rev || 'HEAD');
    const flat = commitTreeFlat(repo, h);
    const rel = path.startsWith('./') ? relPath(ctx, path) : path;
    if (!flat.has(rel)) {
      const dir = [...flat.keys()].filter(p => p.startsWith(rel ? rel + '/' : ''));
      if (dir.length) { ctx.out.push(`tree ${target}`, ''); ctx.out.push(...new Set(dir.map(p => p.slice(rel ? rel.length + 1 : 0).split('/')[0] + (p.slice(rel ? rel.length + 1 : 0).includes('/') ? '/' : '')))); return 0; }
      throw new GitError(`fatal: path '${path}' does not exist in '${rev || 'HEAD'}'`);
    }
    ctx.out.push(...splitLines(w.objects.get(flat.get(rel)).content));
    return 0;
  }
  const raw = resolve(repo, target, { peel: false });
  const obj = w.objects.get(raw);
  if (obj.type === 'tag') {
    ctx.out.push(C.yellow(`tag ${obj.tag}`), `Tagger: ${obj.tagger.name} <${obj.tagger.email}>`, `Date:   ${formatDate(obj.tagger.time)}`, '', obj.message, '');
  }
  if (obj.type === 'blob') { ctx.out.push(...splitLines(obj.content)); return 0; }
  if (obj.type === 'tree') { for (const e of obj.entries) ctx.out.push(e.name + (e.type === 'tree' ? '/' : '')); return 0; }
  const h = w.peel(raw);
  const logArgs = ['-n', '1', h];
  if (o['--oneline']) logArgs.push('--oneline');
  if (o['--format']) logArgs.push('--format', o['--format']);
  if (o['--pretty']) logArgs.push('--pretty', o['--pretty']);
  commands.log(ctx, logArgs);
  if (o['-s'] || o['--no-patch']) return 0;
  const c = w.commit(h);
  const before = c.parents[0] ? commitTreeFlat(repo, c.parents[0]) : new Map();
  const pairs = c.parents.length > 1 ? [] : treePairs(before, commitTreeFlat(repo, h));
  if (pairs.length) ctx.out.push('');
  if (o['--stat']) ctx.out.push(...statLines(w, pairs));
  else if (o['--name-only']) ctx.out.push(...pairs.map(p => p.path));
  else for (const p of pairs) ctx.out.push(...fileDiff(w, p.path, p.old, p.new));
  return 0;
};

commands.branch = (ctx, args) => {
  const repo = needRepo(ctx);
  const o = parseOpts(args, {
    bool: ['-d', '--delete', '-D', '-m', '--move', '-M', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--merged', '--no-merged', '--show-current', '-f', '--force', '--unset-upstream', '--list', '-c', '--copy', '-q', '--quiet'],
    val: ['-u', '--set-upstream-to', '--contains'],
    alias: { '--delete': '-d', '--move': '-m', '--all': '-a', '--remotes': '-r', '--verbose': '-v', '--set-upstream-to': '-u', '--force': '-f' },
  });
  const w = ctx.world;
  const cur = currentBranch(repo);
  if (o['--show-current']) { if (cur) ctx.out.push(cur); return 0; }
  if (o['--unset-upstream']) {
    const b = o._[0] || cur;
    delete repo.config[`branch.${b}.remote`]; delete repo.config[`branch.${b}.merge`];
    return 0;
  }
  if (o['-u']) {
    const up = o['-u'];
    const b = o._[0] || cur;
    if (!repo.refs['refs/remotes/' + up]) throw new GitError(`error: the requested upstream branch '${up}' does not exist`);
    const [remote, ...rest] = up.split('/');
    repo.config[`branch.${b}.remote`] = remote;
    repo.config[`branch.${b}.merge`] = 'refs/heads/' + rest.join('/');
    ctx.out.push(`branch '${b}' set up to track '${up}'.`);
    return 0;
  }
  if (o['-d'] || o['-D']) {
    if (!o._.length) throw new GitError('fatal: branch name required');
    let code = 0;
    for (const name of o._) {
      if (o['-r']) {
        const ref = 'refs/remotes/' + name;
        if (!repo.refs[ref]) { ctx.out.push(`error: remote-tracking branch '${name}' not found`); code = 1; continue; }
        const h = repo.refs[ref]; delete repo.refs[ref];
        ctx.out.push(`Deleted remote-tracking branch ${name} (was ${shortHash(h)}).`);
        continue;
      }
      const ref = 'refs/heads/' + name;
      if (!repo.refs[ref]) { ctx.out.push(`error: branch '${name}' not found`); code = 1; continue; }
      if (name === cur) { ctx.out.push(`error: cannot delete branch '${name}' used by worktree at '${repo.root}'`); code = 1; continue; }
      const h = repo.refs[ref];
      const up = upstreamOf(repo, name);
      const against = (up && repo.refs[up.ref]) || headCommit(repo);
      if (!o['-D'] && !o['-f'] && against && !isAncestor(w, h, against)) {
        ctx.out.push(`error: the branch '${name}' is not fully merged.`, `hint: If you are sure you want to delete it, run 'git branch -D ${name}'`, `hint: Disable this message with "git config advice.forceDeleteBranch false"`);
        code = 1; continue;
      }
      delete repo.refs[ref];
      delete repo.reflog[ref];
      delete repo.config[`branch.${name}.remote`]; delete repo.config[`branch.${name}.merge`];
      ctx.out.push(`Deleted branch ${name} (was ${shortHash(h)}).`);
      w.emit({ type: 'branch-delete', name });
    }
    return code;
  }
  if (o['-m'] || o['-M']) {
    let [from, to] = o._;
    if (!to) { to = from; from = cur; }
    if (!from) throw new GitError('fatal: cannot rename the current branch while not on any');
    if (!repo.refs['refs/heads/' + from] && from !== cur) throw new GitError(`error: refname refs/heads/${from} not found\nfatal: branch rename failed`);
    if (!validRefName(to)) throw new GitError(`fatal: '${to}' is not a valid branch name`);
    if (repo.refs['refs/heads/' + to] && !o['-M']) throw new GitError(`fatal: a branch named '${to}' already exists`);
    if (repo.refs['refs/heads/' + from]) { repo.refs['refs/heads/' + to] = repo.refs['refs/heads/' + from]; delete repo.refs['refs/heads/' + from]; }
    if (repo.reflog['refs/heads/' + from]) { repo.reflog['refs/heads/' + to] = repo.reflog['refs/heads/' + from]; delete repo.reflog['refs/heads/' + from]; }
    for (const k of ['remote', 'merge']) {
      if (repo.config[`branch.${from}.${k}`]) { repo.config[`branch.${to}.${k}`] = repo.config[`branch.${from}.${k}`]; delete repo.config[`branch.${from}.${k}`]; }
    }
    if (from === cur) repo.HEAD = 'ref: refs/heads/' + to;
    w.emit({ type: 'branch-rename', from, to });
    return 0;
  }
  if (o['-c'] || o['--copy']) {
    const [from, to] = o._.length === 2 ? o._ : [cur, o._[0]];
    repo.refs['refs/heads/' + to] = repo.refs['refs/heads/' + from];
    return 0;
  }
  const listing = !o._.length || o['--list'] || o['-a'] || o['-r'] || o['--merged'] || o['--no-merged'] || o['-v'] || o['-vv'] || o['--contains'];
  if (listing && !(o._.length && !o['--list'])) {
    const items = [];
    const showLocal = !o['-r'];
    const showRemote = o['-a'] || o['-r'];
    if (showLocal) {
      if (!cur && headCommit(repo)) items.push({ name: `(HEAD detached at ${shortHash(headCommit(repo))})`, hash: headCommit(repo), current: true, detached: true });
      for (const b of branchNames(repo)) items.push({ name: b, hash: repo.refs['refs/heads/' + b], current: b === cur });
    }
    if (showRemote) for (const [ref, h] of Object.entries(repo.refs)) if (ref.startsWith('refs/remotes/')) items.push({ name: (o['-a'] ? 'remotes/' : '') + ref.slice(13), hash: h, remote: true });
    const head = headCommit(repo);
    let filtered = items;
    if (o['--merged']) { const t = o._[0] ? resolveCommit(repo, o._[0]) : head; filtered = items.filter(i => isAncestor(w, i.hash, t)); }
    if (o['--no-merged']) { const t = o._[0] ? resolveCommit(repo, o._[0]) : head; filtered = items.filter(i => !isAncestor(w, i.hash, t)); }
    if (o['--contains']) { const t = resolveCommit(repo, o['--contains']); filtered = items.filter(i => isAncestor(w, t, i.hash)); }
    const width = Math.max(0, ...filtered.map(i => i.name.length));
    for (const i of filtered) {
      const nameCol = i.current ? C.green(i.name) : i.remote ? C.red(i.name) : i.name;
      let line = (i.current ? '* ' : '  ') + nameCol;
      if (o['-v'] || o['-vv']) {
        line = (i.current ? '* ' : '  ') + (i.current ? C.green(i.name.padEnd(width)) : i.remote ? C.red(i.name.padEnd(width)) : i.name.padEnd(width));
        let track = '';
        if (o['-vv'] && !i.remote && !i.detached) {
          const up = upstreamOf(repo, i.name);
          if (up) {
            const rh = repo.refs[up.ref];
            if (!rh) track = `[${C.blue(up.remote + '/' + up.branch)}: gone] `;
            else {
              const a = revList(w, [i.hash], [rh]).length, b = revList(w, [rh], [i.hash]).length;
              const bits = [a ? `ahead ${a}` : '', b ? `behind ${b}` : ''].filter(Boolean).join(', ');
              track = `[${C.blue(up.remote + '/' + up.branch)}${bits ? ': ' + bits : ''}] `;
            }
          }
        }
        line += ` ${C.yellow(shortHash(i.hash))} ${track}${firstLine(w.commit(w.peel(i.hash)).message)}`;
      }
      ctx.out.push(line);
    }
    return 0;
  }
  // create
  const name = o._[0];
  if (!validRefName(name)) throw new GitError(`fatal: '${name}' is not a valid branch name`);
  if (repo.refs['refs/heads/' + name] && !o['-f']) throw new GitError(`fatal: a branch named '${name}' already exists`);
  if (name === cur && o['-f']) throw new GitError(`fatal: cannot force update the current branch.`);
  const start = o._[1] ? resolveCommit(repo, o._[1]) : headCommit(repo);
  if (!start) throw new GitError(`fatal: not a valid object name: '${currentBranch(repo) || 'HEAD'}'`);
  updateRef(repo, 'refs/heads/' + name, start, `branch: Created from ${o._[1] || 'HEAD'}`);
  if (o._[1] && repo.refs['refs/remotes/' + o._[1]]) {
    const [remote, ...rest] = o._[1].split('/');
    repo.config[`branch.${name}.remote`] = remote;
    repo.config[`branch.${name}.merge`] = 'refs/heads/' + rest.join('/');
    ctx.out.push(`branch '${name}' set up to track '${o._[1]}'.`);
  }
  w.emit({ type: 'branch-create', name });
  return 0;
};

function switchCore(ctx, target, { create = null, force = false, detach = false, startPoint = null, track = true, verb = 'switch' } = {}) {
  const repo = ctx.repo;
  const w = ctx.world;
  const prev = currentBranch(repo) || shortHash(headCommit(repo));
  if (repo.state && !force && (repo.state.type === 'merge' || repo.state.type === 'rebase')) {
    throw new GitError(`fatal: you need to resolve your current index first`);
  }
  if (create) {
    if (!validRefName(create)) throw new GitError(`fatal: '${create}' is not a valid branch name`);
    if (repo.refs['refs/heads/' + create] && !force) throw new GitError(`fatal: a branch named '${create}' already exists`);
    const start = startPoint ? resolveCommit(repo, startPoint) : headCommit(repo);
    if (!start) {
      // unborn branch: just repoint HEAD
      repo.HEAD = 'ref: refs/heads/' + create;
      ctx.out.push(`Switched to a new branch '${create}'`);
      return 0;
    }
    checkoutTree(repo, commitTreeFlat(repo, start), { force });
    updateRef(repo, 'refs/heads/' + create, start, `branch: Created from ${startPoint || 'HEAD'}`);
    switchHead(repo, 'refs/heads/' + create, `checkout: moving from ${prev} to ${create}`);
    if (startPoint && repo.refs['refs/remotes/' + startPoint] && track) {
      const [remote, ...rest] = startPoint.split('/');
      repo.config[`branch.${create}.remote`] = remote;
      repo.config[`branch.${create}.merge`] = 'refs/heads/' + rest.join('/');
      ctx.out.push(`branch '${create}' set up to track '${startPoint}'.`);
    }
    ctx.out.push(`Switched to a new branch '${create}'`);
    w.emit({ type: 'switch', branch: create, created: true });
    return 0;
  }
  if (target === '-') {
    const log = repo.reflog.HEAD || [];
    const m = log.map(e => e.msg.match(/^checkout: moving from (\S+) to /)).find(Boolean);
    if (!m) throw new GitError(`fatal: invalid reference: @{-1}`);
    target = m[1];
  }
  const isBranch = !!repo.refs['refs/heads/' + target];
  if (isBranch && !detach) {
    if (target === currentBranch(repo)) { ctx.out.push(`Already on '${target}'`); return 0; }
    const h = repo.refs['refs/heads/' + target];
    checkoutTree(repo, commitTreeFlat(repo, h), { force });
    switchHead(repo, 'refs/heads/' + target, `checkout: moving from ${prev} to ${target}`);
    ctx.out.push(`Switched to branch '${target}'`);
    const t = trackingInfo(repo);
    if (t && !t.gone) {
      if (!t.ahead && !t.behind) ctx.out.push(`Your branch is up to date with '${t.label}'.`);
      else if (t.ahead && !t.behind) ctx.out.push(`Your branch is ahead of '${t.label}' by ${pl(t.ahead, 'commit')}.`, '  (use "git push" to publish your local commits)');
      else if (!t.ahead) ctx.out.push(`Your branch is behind '${t.label}' by ${pl(t.behind, 'commit')}, and can be fast-forwarded.`, '  (use "git pull" to update your local branch)');
      else ctx.out.push(`Your branch and '${t.label}' have diverged,`, `and have ${t.ahead} and ${t.behind} different commits each, respectively.`);
    }
    w.emit({ type: 'switch', branch: target });
    return 0;
  }
  // guess remote branch
  if (!detach && verb !== 'checkout-detach') {
    const remoteRefs = remoteMatches(repo.refs, target);
    if (remoteRefs.length === 1) return switchCore(ctx, null, { create: target, startPoint: remoteRefs[0].slice(13), force });
  }
  const h = resolve(repo, target, { quiet: true });
  if (!h || w.objects.get(h)?.type !== 'commit') {
    if (verb === 'switch') throw new GitError(`fatal: invalid reference: ${target}`);
    throw new GitError(`error: pathspec '${target}' did not match any file(s) known to git`);
  }
  if (verb === 'switch' && !detach) {
    throw new GitError(`fatal: a branch is expected, got commit '${target}'\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
  }
  checkoutTree(repo, commitTreeFlat(repo, h), { force });
  switchHead(repo, h, `checkout: moving from ${prev} to ${target}`);
  if (verb === 'switch') ctx.out.push(`HEAD is now at ${describeCommit(w, h)}`);
  else {
    ctx.out.push(`Note: switching to '${target}'.`, '',
      `You are in 'detached HEAD' state. You can look around, make experimental`,
      `changes and commit them, and you can discard any commits you make in this`,
      `state without impacting any branches by switching back to a branch.`, '',
      `If you want to create a new branch to retain commits you create, you may`,
      `do so (now or later) by using -c with the switch command. Example:`, '',
      `  git switch -c <new-branch-name>`, '',
      `Or undo this operation with:`, '', `  git switch -`, '',
      `HEAD is now at ${describeCommit(w, h)}`);
  }
  w.emit({ type: 'detach', hash: h });
  return 0;
}

commands.switch = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['--detach', '-f', '--force', '--discard-changes', '--no-track', '-t', '--track', '-q', '--quiet'], val: ['-c', '--create', '-C', '--force-create', '--orphan'] });
  if (o['-q'] || o['--quiet']) { const out = ctx.out; ctx.out = []; try { return commands.switch({ ...ctx, out: [], get repo() { return ctx.repo; } }, args.filter(a => a !== '-q' && a !== '--quiet')); } finally { ctx.out = out; } }
  if (o['--orphan']) {
    resetHard(repo, null); repo.index.clear();
    repo.HEAD = 'ref: refs/heads/' + o['--orphan'];
    ctx.out.push(`Switched to a new branch '${o['--orphan']}'`);
    return 0;
  }
  const create = o['-c'] || o['--create'] || o['-C'] || o['--force-create'];
  if (!create && !o._.length) throw new GitError('fatal: missing branch or commit argument', 128);
  return doSwitch(ctx, o._[0], { create, startPoint: create ? o._[0] : null, force: !!(o['-f'] || o['--force'] || o['--discard-changes'] || o['-C']), detach: o['--detach'], track: !o['--no-track'] });
};

commands.checkout = (ctx, args) => {
  const repo = needWorkTree(ctx);
  if (args.includes('-q') || args.includes('--quiet')) { const sub = { ...ctx, out: [] }; return commands.checkout(sub, args.filter(a => a !== '-q' && a !== '--quiet')); }
  const o = parseOpts(args, { bool: ['-f', '--force', '--detach', '--ours', '--theirs', '-t', '--track', '--no-track'], val: ['-b', '-B', '--orphan'] });
  const w = ctx.world;
  // file checkout: git checkout -- file / git checkout <rev> -- file / git checkout file
  let paths = o.paths;
  let rev = null;
  if (!paths && o._.length && !o['-b'] && !o['-B']) {
    const first = o._[0];
    const isRev = first === '-' || resolve(repo, first, { quiet: true }) !== null || remoteMatches(repo.refs, first).length > 0;
    if (!isRev || o._.length > 1) {
      if (isRev) { rev = first; paths = o._.slice(1); } else paths = o._;
    }
  } else if (paths) rev = o._[0] || null;
  if (paths && paths.length) {
    const match = specMatcher(ctx, paths);
    if (o['--ours'] || o['--theirs']) {
      let n = 0;
      for (const [p, c] of repo.conflicts) {
        if (!match(p)) continue;
        const h = o['--ours'] ? c.ours : c.theirs;
        if (h) writeWork(repo, p, w.objects.get(h).content); else removeWork(repo, p);
        n++;
      }
      if (!n) throw new GitError(`error: path '${paths[0]}' does not have ${o['--ours'] ? 'our' : 'their'} version`);
      return 0;
    }
    const source = rev ? commitTreeFlat(repo, resolveCommit(repo, rev)) : repo.index;
    let n = 0;
    for (const [p, h] of source) {
      if (!match(p)) continue;
      writeWork(repo, p, w.objects.get(h).content);
      if (rev) repo.index.set(p, h);
      n++;
    }
    if (!n) throw new GitError(`error: pathspec '${paths[0]}' did not match any file(s) known to git`, 1);
    ctx.out.push(`Updated ${pl(n, 'path')} from ${rev ? 'the index' : 'the index'}`);
    return 0;
  }
  if (o['--orphan']) return commands.switch(ctx, ['--orphan', o['--orphan']]);
  const create = o['-b'] || o['-B'];
  if (create) return doSwitch(ctx, null, { create, startPoint: o._[0] || null, force: !!o['-B'] || o['-f'], verb: 'checkout' });
  if (!o._.length) return 0;
  return doSwitch(ctx, o._[0], { force: !!(o['-f'] || o['--force']), detach: true, verb: repo.refs['refs/heads/' + o._[0]] && !o['--detach'] ? 'checkout-branch' : 'checkout' });
};

// remote-tracking refs named <remote>/<target>, e.g. refs/remotes/origin/feature/x for "feature/x"
function remoteMatches(refs, target) {
  return Object.keys(refs).filter(r => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD') && r.slice(13).split('/').slice(1).join('/') === target);
}

// `git checkout <name>` attaches to branches, guesses remote branches and otherwise detaches.
function doSwitch(ctx, target, opts) {
  const refs = ctx.repo.refs;
  if (opts.verb === 'checkout-branch') return switchCore(ctx, target, { ...opts, detach: false, verb: 'checkout' });
  if (opts.verb === 'checkout' && target && (refs['refs/heads/' + target] || target === '-')) return switchCore(ctx, target, { ...opts, detach: false });
  if (opts.verb === 'checkout' && target && !opts.create && !refs['refs/heads/' + target]) {
    const remoteRefs = remoteMatches(refs, target);
    if (remoteRefs.length === 1) return switchCore(ctx, null, { create: target, startPoint: remoteRefs[0].slice(13), force: opts.force, verb: 'checkout' });
  }
  return switchCore(ctx, target, opts);
}

commands.restore = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['--staged', '-S', '--worktree', '-W', '--ours', '--theirs'], val: ['--source', '-s'], alias: { '-S': '--staged', '-W': '--worktree', '-s': '--source' } });
  const w = ctx.world;
  const specs = [...o._, ...(o.paths || [])];
  if (!specs.length) throw new GitError('fatal: you must specify path(s) to restore');
  const match = specMatcher(ctx, specs);
  const staged = o['--staged'];
  const worktreeToo = o['--worktree'] || !staged;
  let any = false;
  if (o['--ours'] || o['--theirs']) return commands.checkout(ctx, [o['--ours'] ? '--ours' : '--theirs', '--', ...specs]);
  if (staged) {
    const source = o['--source'] ? commitTreeFlat(repo, resolveCommit(repo, o['--source'])) : headTreeFlat(repo);
    for (const p of new Set([...repo.index.keys(), ...source.keys()])) {
      if (!match(p)) continue;
      any = true;
      if (source.has(p)) repo.index.set(p, source.get(p)); else repo.index.delete(p);
    }
  }
  if (worktreeToo) {
    const source = o['--source'] ? commitTreeFlat(repo, resolveCommit(repo, o['--source'])) : (staged ? headTreeFlat(repo) : repo.index);
    const wt = worktree(repo);
    for (const p of new Set([...source.keys(), ...wt.keys()])) {
      if (!match(p)) continue;
      if (source.has(p)) { writeWork(repo, p, w.objects.get(source.get(p)).content); any = true; }
      else if (o['--source'] && repo.index.has(p)) { removeWork(repo, p); any = true; }
    }
  }
  if (!any) throw new GitError(`error: pathspec '${specs[0]}' did not match any file(s) known to git`, 1);
  w.emit({ type: 'restore' });
  return 0;
};

commands.reset = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['--soft', '--mixed', '--hard', '--keep', '--merge', '-q', '--quiet'], val: [] });
  const w = ctx.world;
  const specs = o.paths || [];
  let rev = o._[0];
  if (o._.length && !o.paths) {
    if (resolve(repo, o._[0], { quiet: true }) === null) { specs.push(...o._); rev = null; }
    else if (o._.length > 1) specs.push(...o._.slice(1));
  }
  if (specs.length) {
    const source = rev ? commitTreeFlat(repo, resolveCommit(repo, rev)) : headTreeFlat(repo);
    const match = specMatcher(ctx, specs);
    for (const p of new Set([...repo.index.keys(), ...source.keys()])) {
      if (!match(p)) continue;
      if (source.has(p)) repo.index.set(p, source.get(p)); else repo.index.delete(p);
    }
    const st = computeStatus(repo);
    if (st.unstaged.length) { ctx.out.push('Unstaged changes after reset:'); for (const s of st.unstaged) ctx.out.push(`${s.kind === 'deleted' ? 'D' : 'M'}\t${s.path}`); }
    return 0;
  }
  const target = resolveCommit(repo, rev || 'HEAD');
  const mode = o['--soft'] ? 'soft' : o['--hard'] ? 'hard' : 'mixed';
  const old = headCommit(repo);
  repo.origHead = old;
  if (mode === 'hard') resetHard(repo, target);
  else if (mode === 'mixed') { repo.index = commitTreeFlat(repo, target); repo.conflicts.clear(); }
  if (repo.state?.type === 'merge' || repo.state?.type === 'cherry-pick' || repo.state?.type === 'revert') repo.state = null;
  setHeadCommit(repo, target, `reset: moving to ${rev || 'HEAD'}`);
  if (mode === 'hard') ctx.out.push(`HEAD is now at ${describeCommit(w, target)}`);
  if (mode === 'mixed' && !o['-q']) {
    const st = computeStatus(repo);
    if (st.unstaged.length) { ctx.out.push('Unstaged changes after reset:'); for (const s of st.unstaged) ctx.out.push(`${s.kind === 'deleted' ? 'D' : 'M'}\t${s.path}`); }
  }
  w.emit({ type: 'reset', mode, target });
  return 0;
};

// ---------- merge / sequencer ----------

function mergeLabel(repo, name) {
  if (repo.refs['refs/remotes/' + name]) return `remote-tracking branch '${name}'`;
  if (repo.refs['refs/tags/' + name]) return `tag '${name}'`;
  if (repo.refs['refs/heads/' + name]) return `branch '${name}'`;
  return `commit '${name}'`;
}

export function mergeInto(ctx, theirsRev, { noFF = false, ffOnly = false, squash = false, message = null, label = null, noCommit = false } = {}) {
  const repo = ctx.repo;
  const w = ctx.world;
  const ours = headCommit(repo);
  const theirs = resolveCommit(repo, theirsRev);
  const name = label || theirsRev;
  if (repo.state) throw new GitError(`error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.`);
  if (!ours) {
    checkoutTree(repo, commitTreeFlat(repo, theirs));
    setHeadCommit(repo, theirs, `merge ${name}: Fast-forward`);
    return 0;
  }
  if (isAncestor(w, theirs, ours)) { ctx.out.push('Already up to date.'); return 0; }
  const cur = currentBranch(repo);
  if (isAncestor(w, ours, theirs) && !noFF && !squash) {
    const before = commitTreeFlat(repo, ours), after = commitTreeFlat(repo, theirs);
    checkoutTree(repo, after);
    setHeadCommit(repo, theirs, `merge ${name}: Fast-forward`);
    ctx.out.push(`Updating ${shortHash(ours)}..${shortHash(theirs)}`, 'Fast-forward', ...statLines(w, treePairs(before, after)));
    w.emit({ type: 'merge', ff: true, theirs });
    return 0;
  }
  if (ffOnly) throw new GitError('fatal: Not possible to fast-forward, aborting.');
  const st = computeStatus(repo);
  const base = mergeBase(w, ours, theirs);
  const baseFlat = commitTreeFlat(repo, base), oursFlat = commitTreeFlat(repo, ours), theirsFlat = commitTreeFlat(repo, theirs);
  const touched = treePairs(baseFlat, theirsFlat).map(p => p.path);
  const dirty = [...st.staged, ...st.unstaged].map(s => s.path).filter(p => touched.includes(p));
  if (st.staged.length || dirty.length) {
    throw new GitError(`error: Your local changes to the following files would be overwritten by merge:\n${(dirty.length ? dirty : st.staged.map(s => s.path)).map(p => '\t' + p).join('\n')}\nPlease commit your changes or stash them before you merge.\nAborting`, 1);
  }
  const merge = mergeTrees(w, baseFlat, oursFlat, theirsFlat, { ours: 'HEAD', theirs: name });
  applyMerge(repo, oursFlat, merge);
  const msg = message || `Merge ${mergeLabel(repo, theirsRev)}${cur && cur !== 'main' && cur !== 'master' ? ` into ${cur}` : ''}`;
  for (const p of touched) if (oursFlat.get(p) && theirsFlat.get(p) && oursFlat.get(p) !== baseFlat.get(p) && !merge.conflicts.find(c => c.path === p)) ctx.out.push(`Auto-merging ${p}`);
  if (merge.conflicts.length) {
    ctx.out.push(...conflictLines(merge, name));
    if (squash) { ctx.out.push('Squash commit -- not updating HEAD', 'Automatic merge failed; fix conflicts and then commit the result.'); repo.state = { type: 'squash-merge', msg }; repo.state = null; return 1; }
    repo.state = { type: 'merge', mergeHead: theirs, msg, conflicted: merge.conflicts.map(c => c.path) };
    ctx.out.push('Automatic merge failed; fix conflicts and then commit the result.');
    w.emit({ type: 'conflict', paths: merge.conflicts.map(c => c.path) });
    return 1;
  }
  if (squash) {
    ctx.out.push('Squash commit -- not updating HEAD', ...statLines(w, treePairs(oursFlat, merge.result)));
    repo.squashMsg = `Squashed commit of the following:`;
    return 0;
  }
  if (noCommit) {
    repo.state = { type: 'merge', mergeHead: theirs, msg, conflicted: [] };
    ctx.out.push('Automatic merge went well; stopped before committing as requested');
    return 0;
  }
  const h = makeCommit(repo, { message: msg, parents: [ours, theirs] });
  setHeadCommit(repo, h, `merge ${name}: Merge made by the 'ort' strategy.`);
  ctx.out.push(`Merge made by the 'ort' strategy.`, ...statLines(w, treePairs(oursFlat, merge.result)));
  w.emit({ type: 'merge', ff: false, hash: h, theirs });
  return 0;
}

commands.merge = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['--no-ff', '--ff-only', '--ff', '--squash', '--abort', '--continue', '--no-edit', '--no-commit', '-q'], val: ['-m'] });
  if (o['--abort']) {
    if (repo.state?.type !== 'merge') throw new GitError('fatal: There is no merge to abort (MERGE_HEAD missing).');
    resetHard(repo, headCommit(repo));
    repo.state = null;
    ctx.world.emit({ type: 'merge-abort' });
    return 0;
  }
  if (o['--continue']) {
    if (repo.state?.type !== 'merge') throw new GitError('fatal: There is no merge in progress (MERGE_HEAD missing).');
    return commands.commit(ctx, ['--no-edit']);
  }
  if (!o._.length) {
    const b = currentBranch(repo);
    const up = b && upstreamOf(repo, b);
    if (!up) throw new GitError('fatal: No remote for the current branch.');
    o._.push(`${up.remote}/${up.branch}`);
  }
  return mergeInto(ctx, o._[0], { noFF: o['--no-ff'], ffOnly: o['--ff-only'], squash: o['--squash'], message: o['-m'], noCommit: o['--no-commit'] });
};

// Pick the changes of `hash` onto HEAD. Returns {ok, conflicts, empty}.
function pickOnto(repo, hash, { revert = false, label } = {}) {
  const w = repo.world;
  const c = w.commit(hash);
  const parent = c.parents[0] || null;
  const head = headCommit(repo);
  const oursFlat = commitTreeFlat(repo, head);
  const baseFlat = revert ? commitTreeFlat(repo, hash) : commitTreeFlat(repo, parent);
  const theirsFlat = revert ? commitTreeFlat(repo, parent) : commitTreeFlat(repo, hash);
  const merge = mergeTrees(w, baseFlat, oursFlat, theirsFlat, { ours: 'HEAD', theirs: label || `${shortHash(hash)} (${firstLine(c.message)})` });
  applyMerge(repo, oursFlat, merge);
  const empty = !merge.conflicts.length && w.writeTree(merge.result) === w.commit(head).tree;
  return { merge, empty, conflicts: merge.conflicts };
}

function rebaseFinish(ctx) {
  const repo = ctx.repo;
  const s = repo.state;
  const final = headCommit(repo);
  if (s.headName) {
    updateRef(repo, s.headName, final, `rebase (finish): ${s.headName} onto ${s.onto}`);
    repo.HEAD = 'ref: ' + s.headName;
    logRef(repo, 'HEAD', final, final, `rebase (finish): returning to ${s.headName}`);
  }
  repo.state = null;
  ctx.out.push(`Successfully rebased and updated ${s.headName || 'detached HEAD'}.`);
  ctx.world.emit({ type: 'rebase-done' });
  return 0;
}

function runSequencer(ctx) {
  const repo = ctx.repo;
  const w = ctx.world;
  const s = repo.state;
  while (s.todo.length) {
    const step = s.todo.shift();
    s.current = step;
    if (step.action === 'drop') continue;
    if (step.action === 'exec') { ctx.out.push(`Executing: ${step.cmd}`); continue; }
    if (step.action === 'break') { ctx.out.push('Stopped at HEAD', `You can amend the commit now, with`, '', `  git commit --amend`, '', `Once you are satisfied with your changes, run`, '', `  git rebase --continue`); s.stopped = 'edit'; return 0; }
    const c = w.commit(step.hash);
    if (c.parents.length > 1) continue; // merges are dropped by plain rebase
    const res = pickOnto(repo, step.hash);
    if (res.conflicts.length) {
      ctx.out.push(...conflictLines(res.merge));
      ctx.out.push(`error: could not apply ${shortHash(step.hash)}... ${firstLine(c.message)}`,
        C.yellow(`hint: Resolve all conflicts manually, mark them as resolved with`),
        C.yellow(`hint: "git add/rm <conflicted_files>", then run "git rebase --continue".`),
        C.yellow(`hint: You can instead skip this commit: run "git rebase --skip".`),
        C.yellow(`hint: To abort and get back to the state before "git rebase", run "git rebase --abort".`),
        `Could not apply ${shortHash(step.hash)}... ${firstLine(c.message)}`);
      s.stopped = 'conflict';
      w.emit({ type: 'conflict', paths: res.conflicts.map(x => x.path) });
      return 1;
    }
    if (res.empty && step.action !== 'squash' && step.action !== 'fixup') {
      continue; // already applied upstream
    }
    const r = commitStep(ctx, step);
    if (r === 'paused') return 0;
  }
  return rebaseFinish(ctx);
}

// Commit the index for a sequencer step. Returns 'paused' when waiting on the editor or an edit stop.
function commitStep(ctx, step) {
  const repo = ctx.repo;
  const w = ctx.world;
  const s = repo.state;
  const c = w.commit(step.hash);
  const head = headCommit(repo);
  if (step.action === 'squash' || step.action === 'fixup') {
    const prev = w.commit(head);
    s.squashMsgs = s.squashMsgs || [prev.message];
    if (step.action === 'squash') s.squashMsgs.push(c.message);
    const tree = indexTree(repo);
    const doCommit = (message) => {
      const h = makeCommit(repo, { message, parents: prev.parents, tree, author: prev.author });
      setHeadCommit(repo, h, `rebase (${step.action}): ${firstLine(message)}`);
    };
    const nextIsSquash = s.todo[0] && (s.todo[0].action === 'squash' || s.todo[0].action === 'fixup');
    if (step.action === 'squash' && !nextIsSquash) {
      const msgs = s.squashMsgs;
      s.squashMsgs = null;
      const content = `# This is a combination of ${msgs.length} commits.\n` + msgs.map((m, i) => `# This is the ${['1st', '2nd', '3rd'][i] || (i + 1) + 'th'} commit message:\n\n${m}\n`).join('\n') +
        `\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.`;
      ctx.openEditor({
        title: '.git/COMMIT_EDITMSG (squash)', content,
        hint: 'Combine the messages into one. Lines starting with # are ignored.',
        onSave: (text, c2) => { doCommit(cleanMessage(text) || msgs[0]); c2.repo = repo; return runSequencer(c2); },
      });
      return 'paused';
    }
    if (!nextIsSquash) {
      const msgs = s.squashMsgs; s.squashMsgs = null;
      doCommit(msgs.join('\n\n'));
    } else doCommit(s.squashMsgs.join('\n\n'));
    return 'ok';
  }
  const h = makeCommit(repo, { message: c.message, parents: [head], author: c.author });
  setHeadCommit(repo, h, `rebase (${step.action}): ${firstLine(c.message)}`);
  if (step.action === 'reword') {
    ctx.openEditor({
      title: '.git/COMMIT_EDITMSG (reword)', content: c.message + '\n\n# Rewrite the message above. Lines starting with # are ignored.',
      hint: 'Edit the commit message, then save.',
      onSave: (text, c2) => {
        const msg = cleanMessage(text) || c.message;
        const cur = w.commit(headCommit(repo));
        const nh = makeCommit(repo, { message: msg, parents: cur.parents, author: cur.author, tree: cur.tree });
        setHeadCommit(repo, nh, `rebase (reword): ${firstLine(msg)}`);
        c2.repo = repo;
        return runSequencer(c2);
      },
    });
    return 'paused';
  }
  if (step.action === 'edit') {
    ctx.out.push(`Stopped at ${shortHash(step.hash)}...  ${firstLine(c.message)}`, 'You can amend the commit now, with', '', '  git commit --amend ', '', 'Once you are satisfied with your changes, run', '', '  git rebase --continue');
    s.stopped = 'edit';
    return 'paused';
  }
  return 'ok';
}

function todoList(w, commits) {
  return commits.map(h => ({ action: 'pick', hash: h, msg: firstLine(w.commit(h).message) }));
}

commands.rebase = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['-i', '--interactive', '--continue', '--abort', '--skip', '--root', '--autosquash', '-q', '--edit-todo'], val: ['--onto'] });
  const w = ctx.world;
  if (o['--abort']) {
    if (repo.state?.type !== 'rebase') throw new GitError('fatal: No rebase in progress?');
    const s = repo.state;
    resetHard(repo, s.origHead);
    if (s.headName) { repo.refs[s.headName] = s.origHead; repo.HEAD = 'ref: ' + s.headName; } else repo.HEAD = s.origHead;
    logRef(repo, 'HEAD', null, s.origHead, `rebase (abort): returning to ${s.headName || s.origHead}`);
    repo.state = null;
    w.emit({ type: 'rebase-abort' });
    return 0;
  }
  if (o['--continue'] || o['--skip']) {
    if (repo.state?.type !== 'rebase') throw new GitError('fatal: No rebase in progress?');
    const s = repo.state;
    if (o['--skip']) {
      resetHard(repo, headCommit(repo));
      s.stopped = null;
      return runSequencer(ctx);
    }
    if (repo.conflicts.size) {
      ctx.out.push(...[...repo.conflicts.keys()].map(p => `${p}: needs merge`), 'You must edit all merge conflicts and then', 'mark them as resolved using git add');
      return 1;
    }
    if (s.stopped === 'conflict') {
      s.stopped = null;
      const r = commitStep(ctx, s.current);
      if (r === 'paused') return 0;
    } else if (s.stopped === 'edit') {
      s.stopped = null;
      if (!isCleanIndex(repo)) {
        const cur = w.commit(headCommit(repo));
        const h = makeCommit(repo, { message: cur.message, parents: cur.parents, author: cur.author });
        setHeadCommit(repo, h, 'rebase (continue)');
      }
    }
    return runSequencer(ctx);
  }
  if (repo.state) throw new GitError(`fatal: It seems that there is already a ${repo.state.type} in progress.`);
  const st = computeStatus(repo);
  if (st.staged.length || st.unstaged.length) {
    throw new GitError(`error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.`, 1);
  }
  const head = headCommit(repo);
  const interactive = o['-i'] || o['--interactive'];
  let upstream;
  if (o._.length) upstream = resolveCommit(repo, o._[0]);
  else if (!o['--root']) {
    const b = currentBranch(repo);
    const up = b && upstreamOf(repo, b);
    if (!up || !repo.refs[up.ref]) throw new GitError(`There is no tracking information for the current branch.\nPlease specify which branch you want to rebase against.\n\n    git rebase <branch>\n`, 1);
    upstream = repo.refs[up.ref];
  }
  const onto = o['--onto'] ? resolveCommit(repo, o['--onto']) : upstream;
  let commits = revList(w, [head], upstream ? [upstream] : []).reverse().filter(h => w.commit(h).parents.length < 2);
  const headName = headRef(repo);
  if (!interactive && upstream && isAncestor(w, upstream, head) && !o['--onto']) {
    ctx.out.push(`Current branch ${currentBranch(repo) || 'HEAD'} is up to date.`);
    return 0;
  }
  if (!interactive && upstream && isAncestor(w, head, upstream) && !o['--onto']) {
    // fast-forward
    checkoutTree(repo, commitTreeFlat(repo, upstream));
    setHeadCommit(repo, upstream, `rebase (finish): ${headName} onto ${upstream}`);
    ctx.out.push(`Successfully rebased and updated ${headName || 'detached HEAD'}.`);
    return 0;
  }
  const start = (state) => {
    repo.origHead = head;
    repo.state = state;
    if (o['--root'] && !upstream) {
      // replaying from the root: first pick becomes a new root commit
      const first = state.todo.shift();
      const fc = w.commit(first.hash);
      resetHard(repo, first.hash);
      repo.HEAD = first.hash;
      if (first.action === 'reword' || first.action === 'edit') state.todo.unshift({ ...first, action: 'noop' });
      void fc;
    } else {
      checkoutTree(repo, commitTreeFlat(repo, onto), { force: true });
      repo.HEAD = onto;
      logRef(repo, 'HEAD', head, onto, `rebase (start): checkout ${o._[0] || onto}`);
    }
    return runSequencer(ctx);
  };
  const baseState = { type: 'rebase', headName, onto, origHead: head, interactive, todo: [], current: null };
  if (o['--root']) commits = revList(w, [head], []).reverse();
  if (!interactive) return start({ ...baseState, todo: todoList(w, commits) });
  let todo = todoList(w, commits);
  if (o['--autosquash']) {
    const out = [];
    for (const t of todo) {
      const m = t.msg.match(/^(fixup|squash)! (.*)$/);
      if (m) { const target = out.findIndex(x => x.msg === m[2]); if (target >= 0) { let k = target + 1; while (out[k] && /^(fixup|squash)/.test(out[k].action)) k++; out.splice(k, 0, { ...t, action: m[1] }); continue; } }
      out.push(t);
    }
    todo = out;
  }
  const text = todo.map(t => `${t.action} ${shortHash(t.hash)} ${t.msg}`).join('\n') + `\n
# Rebase ${shortHash(onto)}..${shortHash(head)} onto ${shortHash(onto)} (${pl(todo.length, 'command')})
#
# Commands:
# p, pick <commit> = use commit
# r, reword <commit> = use commit, but edit the commit message
# e, edit <commit> = use commit, but stop for amending
# s, squash <commit> = use commit, but meld into previous commit
# f, fixup <commit> = like "squash" but keep only the previous commit's log message
# d, drop <commit> = remove commit
#
# These lines can be re-ordered; they are executed from top to bottom.
# If you remove a line here THAT COMMIT WILL BE LOST.
# However, if you remove everything, the rebase will be aborted.`;
  ctx.openEditor({
    title: '.git/rebase-merge/git-rebase-todo',
    content: text,
    hint: 'Change the word at the start of each line (pick, reword, edit, squash, fixup, drop) or reorder lines, then save.',
    onSave: (saved, c2) => {
      const abbrev = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop', x: 'exec', b: 'break' };
      const steps = [];
      for (const line of saved.split('\n')) {
        const l = line.trim();
        if (!l || l.startsWith('#')) continue;
        const m = l.match(/^(\w+)\s+([0-9a-f]{4,40})?\s*(.*)$/);
        if (!m) { c2.out.push(`error: invalid line: ${l}`); return 1; }
        const action = abbrev[m[1]] || m[1];
        if (!['pick', 'reword', 'edit', 'squash', 'fixup', 'drop', 'exec', 'break'].includes(action)) { c2.out.push(`error: invalid command '${m[1]}'`, 'You can fix this with \'git rebase --edit-todo\' and then run \'git rebase --continue\'.'); return 1; }
        if (action === 'exec' || action === 'break') { steps.push({ action, cmd: m[3] }); continue; }
        const hash = resolve(repo, m[2], { quiet: true });
        if (!hash) { c2.out.push(`error: could not parse '${m[2]}'`); return 1; }
        steps.push({ action, hash, msg: m[3] });
      }
      if (!steps.length) { c2.out.push('Nothing to do'); return 1; }
      if (steps[0].action === 'squash' || steps[0].action === 'fixup') { c2.out.push(`error: cannot '${steps[0].action}' without a previous commit`, `You can fix this with 'git rebase --edit-todo' and then run 'git rebase --continue'.`); return 1; }
      c2.repo = repo;
      ctx.out = c2.out;
      ctx.openEditor = c2.openEditor;
      return start({ ...baseState, todo: steps });
    },
  });
  return 0;
};

function isCleanIndex(repo) {
  return repo.world.writeTree(repo.index) === repo.world.commit(headCommit(repo)).tree;
}

function pickCommand(kind) {
  return (ctx, args) => {
    const repo = needWorkTree(ctx);
    const o = parseOpts(args, { bool: ['--continue', '--abort', '--skip', '--no-edit', '-n', '--no-commit', '-x', '-e'], val: ['-m'] });
    const w = ctx.world;
    if (o['--abort']) {
      if (repo.state?.type !== kind) throw new GitError(`error: no ${kind} in progress\nfatal: ${kind} failed`);
      resetHard(repo, headCommit(repo)); repo.state = null; return 0;
    }
    if (o['--skip']) { resetHard(repo, headCommit(repo)); repo.state = null; return 0; }
    if (o['--continue']) {
      if (repo.state?.type !== kind) throw new GitError(`error: no ${kind} in progress\nfatal: ${kind} failed`);
      if (repo.conflicts.size) { ctx.out.push(`error: Committing is not possible because you have unmerged files.`); return 1; }
      const msg = repo.state.msg, author = repo.state.author;
      const rest = repo.state.rest || [];
      const h = makeCommit(repo, { message: msg, parents: [headCommit(repo)], author });
      setHeadCommit(repo, h, `${kind}: ${firstLine(msg)}`);
      repo.state = null;
      ctx.out.push(`[${currentBranch(repo) || 'detached HEAD'} ${shortHash(h)}] ${firstLine(msg)}`);
      if (rest.length) return commands[kind](ctx, rest);
      return 0;
    }
    if (repo.state) throw new GitError(`error: ${repo.state.type} is already in progress\nhint: try "git ${repo.state.type} (--continue | --abort | --quit)"`);
    if (!o._.length) throw new GitError(`usage: git ${kind} [<options>] <commit-ish>...`, 129);
    if (!isClean(repo)) throw new GitError(`error: your local changes would be overwritten by ${kind}.\nhint: commit your changes or stash them to proceed.\nfatal: ${kind} failed`);
    // expand ranges
    let targets = [];
    for (const a of o._) {
      if (a.includes('..')) { const [x, y] = a.split('..'); targets.push(...revList(w, [resolveCommit(repo, y || 'HEAD')], [resolveCommit(repo, x)]).reverse()); }
      else targets.push(resolveCommit(repo, a));
    }
    for (let i = 0; i < targets.length; i++) {
      const hash = targets[i];
      const c = w.commit(hash);
      if (c.parents.length > 1 && !o['-m']) throw new GitError(`error: commit ${hash} is a merge but no -m option was given.\nfatal: ${kind} failed`);
      const res = pickOnto(repo, hash, { revert: kind === 'revert' });
      const msg = kind === 'revert'
        ? `Revert "${firstLine(c.message)}"\n\nThis reverts commit ${hash}.`
        : c.message + (o['-x'] ? `\n\n(cherry picked from commit ${hash})` : '');
      if (res.conflicts.length) {
        ctx.out.push(...conflictLines(res.merge));
        ctx.out.push(`error: could not ${kind} ${shortHash(hash)}... ${firstLine(c.message)}`,
          C.yellow(`hint: After resolving the conflicts, mark them with`),
          C.yellow(`hint: "git add/rm <pathspec>", then run`),
          C.yellow(`hint: "git ${kind} --continue".`),
          C.yellow(`hint: You can instead skip this commit with "git ${kind} --skip".`),
          C.yellow(`hint: To abort and get back to the state before "git ${kind}",`),
          C.yellow(`hint: run "git ${kind} --abort".`));
        repo.state = { type: kind, commit: hash, msg, author: kind === 'revert' ? null : c.author, rest: targets.slice(i + 1).map(x => x) };
        w.emit({ type: 'conflict', paths: res.conflicts.map(x => x.path) });
        return 1;
      }
      if (res.empty) {
        ctx.out.push(`On branch ${currentBranch(repo)}`, `You are currently ${kind === 'revert' ? 'reverting' : 'cherry-picking'} commit ${shortHash(hash)}.`, '', 'nothing to commit, working tree clean',
          `The previous ${kind} is now empty, possibly due to conflict resolution.`);
        return 1;
      }
      if (o['-n'] || o['--no-commit']) continue;
      const author = kind === 'revert' ? undefined : c.author;
      const before = commitTreeFlat(repo, headCommit(repo));
      const h = makeCommit(repo, { message: msg, parents: [headCommit(repo)], author });
      setHeadCommit(repo, h, `${kind}: ${firstLine(msg)}`);
      ctx.out.push(`[${currentBranch(repo) || 'detached HEAD'} ${shortHash(h)}] ${firstLine(msg)}`);
      if (kind === 'cherry-pick') ctx.out.push(` Date: ${formatDate(c.author.time)}`);
      ctx.out.push(...commitStat(w, before, commitTreeFlat(repo, h)));
      w.emit({ type: kind, hash: h, source: hash });
    }
    return 0;
  };
}

function isClean(repo) {
  const st = computeStatus(repo);
  return !st.staged.length && !st.unstaged.length && !st.conflicts.length;
}

commands['cherry-pick'] = pickCommand('cherry-pick');
commands.revert = pickCommand('revert');

// ---------- stash ----------

commands.stash = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const w = ctx.world;
  let sub = args[0] && !args[0].startsWith('-') ? args[0] : 'push';
  const rest = sub === args[0] ? args.slice(1) : args;
  if (sub === 'save') { sub = 'push'; if (rest[0] && !rest[0].startsWith('-')) rest.unshift('-m'); }
  const o = parseOpts(rest, { bool: ['-u', '--include-untracked', '--index', '-p', '-k', '--keep-index', '-a', '--all', '-q'], val: ['-m', '--message'] });
  const idx = (s) => {
    const m = (s || 'stash@{0}').match(/^(?:stash@\{(\d+)\}|(\d+))$/);
    const n = m ? Number(m[1] ?? m[2]) : NaN;
    if (Number.isNaN(n) || !repo.stash[n]) throw new GitError(`error: ${s || 'stash@{0}'} is not a valid reference`, 1);
    return n;
  };
  const head = headCommit(repo);
  if (sub === 'push') {
    if (!head) throw new GitError('You do not have the initial commit yet', 1);
    const st = computeStatus(repo);
    const includeUntracked = o['-u'] || o['--include-untracked'] || o['-a'] || o['--all'];
    if (!st.staged.length && !st.unstaged.length && !(includeUntracked && st.untracked.length)) { ctx.out.push('No local changes to save'); return 0; }
    const b = currentBranch(repo) || '(no branch)';
    const baseMsg = `${shortHash(head)} ${firstLine(w.commit(head).message)}`;
    const message = (o['-m'] || o['--message']) ? `On ${b}: ${o['-m'] || o['--message']}` : `WIP on ${b}: ${baseMsg}`;
    const indexCommit = makeCommit(repo, { message: `index on ${b}: ${baseMsg}`, parents: [head], tree: indexTree(repo) });
    const wtFlat = new Map(repo.index);
    const wt = worktree(repo);
    for (const p of [...wtFlat.keys()]) { if (wt.has(p)) wtFlat.set(p, w.writeBlob(wt.get(p))); else wtFlat.delete(p); }
    const untracked = new Map();
    if (includeUntracked) for (const p of st.untracked) untracked.set(p, w.writeBlob(wt.get(p)));
    const parents = [head, indexCommit];
    if (untracked.size) parents.push(makeCommit(repo, { message: `untracked files on ${b}: ${baseMsg}`, parents: [], tree: w.writeTree(untracked) }));
    const h = makeCommit(repo, { message, parents, tree: w.writeTree(wtFlat) });
    repo.stash.unshift({ hash: h, message });
    repo.refs['refs/stash'] = h;
    resetHard(repo, head);
    for (const p of untracked.keys()) removeWork(repo, p);
    w.pruneEmptyDirs(repo.root);
    if (o['-k'] || o['--keep-index']) {
      repo.index = w.readTreeFlat(w.commit(indexCommit).tree);
      for (const [p, hh] of repo.index) writeWork(repo, p, w.objects.get(hh).content);
    }
    ctx.out.push(`Saved working directory and index state ${message}`);
    w.emit({ type: 'stash' });
    return 0;
  }
  if (sub === 'list') {
    repo.stash.forEach((s, i) => ctx.out.push(`stash@{${i}}: ${s.message}`));
    return 0;
  }
  if (sub === 'show') {
    const n = idx(o._[0]);
    const s = w.commit(repo.stash[n].hash);
    const pairs = treePairs(commitTreeFlat(repo, s.parents[0]), w.readTreeFlat(s.tree));
    if (o['-p']) for (const p of pairs) ctx.out.push(...fileDiff(w, p.path, p.old, p.new));
    else ctx.out.push(...statLines(w, pairs));
    return 0;
  }
  if (sub === 'drop') {
    const n = idx(o._[0]);
    const s = repo.stash.splice(n, 1)[0];
    if (repo.stash[0]) repo.refs['refs/stash'] = repo.stash[0].hash; else delete repo.refs['refs/stash'];
    ctx.out.push(`Dropped stash@{${n}} (${s.hash})`);
    return 0;
  }
  if (sub === 'clear') { repo.stash = []; delete repo.refs['refs/stash']; return 0; }
  if (sub === 'apply' || sub === 'pop') {
    const n = idx(o._[0]);
    const s = repo.stash[n];
    const sc = w.commit(s.hash);
    const baseFlat = commitTreeFlat(repo, sc.parents[0]);
    const oursFlat = headTreeFlat(repo);
    const theirsFlat = w.readTreeFlat(sc.tree);
    const st = computeStatus(repo);
    const touched = treePairs(baseFlat, theirsFlat).map(p => p.path);
    const dirty = [...st.staged, ...st.unstaged].map(x => x.path).filter(p => touched.includes(p));
    if (dirty.length) throw new GitError(`error: Your local changes to the following files would be overwritten by merge:\n${dirty.map(p => '\t' + p).join('\n')}\nPlease commit your changes or stash them before you merge.\nAborting`, 1);
    const savedIndex = new Map(repo.index);
    const merge = mergeTrees(w, baseFlat, oursFlat, theirsFlat, { ours: 'Updated upstream', theirs: 'Stashed changes' });
    applyMerge(repo, oursFlat, merge);
    // stash apply leaves changes unstaged except brand-new files
    const stashIndex = w.readTreeFlat(w.commit(sc.parents[1]).tree);
    for (const [p, h] of merge.result) {
      if (merge.conflicts.find(c => c.path === p)) continue;
      if (o['--index'] && stashIndex.get(p) !== baseFlat.get(p)) { repo.index.set(p, stashIndex.get(p)); continue; }
      if (oursFlat.has(p)) repo.index.set(p, oursFlat.get(p));
      else if (!baseFlat.has(p)) repo.index.set(p, h);
      else repo.index.delete(p);
    }
    for (const [p, h] of savedIndex) if (!merge.result.has(p) && !merge.conflicts.find(c => c.path === p) && oursFlat.has(p)) repo.index.set(p, h);
    for (const p of [...repo.index.keys()]) if (!merge.result.has(p) && !oursFlat.has(p) && !savedIndex.has(p)) repo.index.delete(p);
    if (oursFlat.size) for (const [p, h] of oursFlat) if (!merge.result.has(p) && !merge.conflicts.find(c => c.path === p)) { /* deleted by stash */ repo.index.set(p, h); }
    if (sc.parents[2]) {
      const untracked = w.readTreeFlat(w.commit(sc.parents[2]).tree);
      for (const [p, h] of untracked) writeWork(repo, p, w.objects.get(h).content);
    }
    if (merge.conflicts.length) {
      ctx.out.push(...conflictLines(merge));
      ctx.out.push('The stash entry is kept in case you need it again.');
      return 1;
    }
    commands.status(ctx, []);
    if (sub === 'pop') {
      repo.stash.splice(n, 1);
      if (repo.stash[0]) repo.refs['refs/stash'] = repo.stash[0].hash; else delete repo.refs['refs/stash'];
      ctx.out.push(`Dropped stash@{${n}} (${s.hash})`);
    }
    w.emit({ type: 'stash-' + sub });
    return 0;
  }
  if (sub === 'branch') {
    const name = o._[0];
    const n = idx(o._[1]);
    const sc = w.commit(repo.stash[n].hash);
    doSwitch(ctx, null, { create: name, startPoint: sc.parents[0] });
    return commands.stash(ctx, ['pop', `stash@{${n}}`]);
  }
  throw new GitError(`error: unknown subcommand: \`${sub}'`, 129);
};

// ---------- tags ----------

commands.tag = (ctx, args) => {
  const repo = needRepo(ctx);
  const o = parseOpts(args, { bool: ['-a', '--annotate', '-d', '--delete', '-f', '--force', '-n', '--list'], val: ['-m', '--message', '-l'] });
  const w = ctx.world;
  const tags = Object.keys(repo.refs).filter(r => r.startsWith('refs/tags/')).map(r => r.slice(10)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (o['-d'] || o['--delete']) {
    for (const t of o._) {
      if (!repo.refs['refs/tags/' + t]) { ctx.out.push(`error: tag '${t}' not found.`); return 1; }
      const h = repo.refs['refs/tags/' + t];
      delete repo.refs['refs/tags/' + t];
      ctx.out.push(`Deleted tag '${t}' (was ${shortHash(h)})`);
    }
    return 0;
  }
  if (!o._.length || o['-l'] || o['--list']) {
    let list = tags;
    const pat = o['-l'] || o._[0];
    if (pat) { const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); list = list.filter(t => re.test(t)); }
    for (const t of list) {
      if (o['-n']) {
        const obj = w.objects.get(repo.refs['refs/tags/' + t]);
        ctx.out.push(`${t.padEnd(15)} ${obj.type === 'tag' ? obj.message : firstLine(w.commit(w.peel(repo.refs['refs/tags/' + t])).message)}`);
      } else ctx.out.push(t);
    }
    return 0;
  }
  const name = o._[0];
  if (!validRefName(name)) throw new GitError(`fatal: '${name}' is not a valid tag name.`);
  if (repo.refs['refs/tags/' + name] && !o['-f']) throw new GitError(`fatal: tag '${name}' already exists`);
  const target = resolveCommit(repo, o._[1] || 'HEAD');
  const msg = o['-m'] || o['--message'];
  if (o['-a'] || o['--annotate'] || msg) {
    if (!msg) {
      ctx.openEditor({ title: 'TAG_EDITMSG', content: `\n#\n# Write a message for tag:\n#   ${name}\n# Lines starting with '#' will be ignored.`, onSave: (text, c2) => {
        const m = cleanMessage(text);
        if (!m) { c2.out.push('fatal: no tag message?'); return 1; }
        const id = requireIdentity(repo); w.tick();
        repo.refs['refs/tags/' + name] = w.writeTag({ object: target, tag: name, tagger: { ...id, time: w.time }, message: m });
        return 0;
      } });
      return 0;
    }
    const id = requireIdentity(repo);
    w.tick();
    repo.refs['refs/tags/' + name] = w.writeTag({ object: target, tag: name, tagger: { ...id, time: w.time }, message: msg });
  } else repo.refs['refs/tags/' + name] = target;
  w.emit({ type: 'tag', name });
  return 0;
};

// ---------- inspection ----------

commands.reflog = (ctx, args) => {
  const repo = needRepo(ctx);
  const sub = args[0] && ['show', 'expire', 'delete'].includes(args[0]) ? args[0] : 'show';
  const rest = sub === args[0] ? args.slice(1) : args;
  const o = parseOpts(rest, { bool: ['--all', '--date=relative'], val: ['-n'] });
  const refArg = o._[0] || 'HEAD';
  const ref = refArg === 'HEAD' ? 'HEAD' : (repo.reflog['refs/heads/' + refArg] ? 'refs/heads/' + refArg : refArg);
  const log = repo.reflog[ref] || [];
  const n = o['-n'] ? Number(o['-n']) : log.length;
  log.slice(0, n).forEach((e, i) => {
    const label = refArg === 'HEAD' ? 'HEAD' : refArg;
    const decor = i === 0 && ref === 'HEAD' ? decorate(repo, e.new, refsByCommit(repo)) : '';
    ctx.out.push(`${C.yellow(shortHash(e.new))}${decor} ${label}@{${i}}: ${e.msg}`);
  });
  return 0;
};

commands.blame = (ctx, args) => {
  const repo = needRepo(ctx);
  const o = parseOpts(args, { bool: ['-s', '-e', '-w'], val: ['-L'] });
  const w = ctx.world;
  const file = o._.length === 2 ? o._[1] : (o._[0] || (o.paths || [])[0]);
  const rev = o._.length === 2 ? o._[0] : 'HEAD';
  if (!file) throw new GitError('usage: git blame [<options>] [<rev-opts>] [<rev>] [--] <file>', 129);
  const rel = relPath(ctx, file);
  const head = resolveCommit(repo, rev);
  if (!commitTreeFlat(repo, head).has(rel)) throw new GitError(`fatal: no such path '${rel}' in ${rev}`);
  const chain = revList(w, [head], [], { firstParent: true }).reverse();
  let lines = [], owners = [];
  let prevText = null;
  for (const h of chain) {
    const flat = commitTreeFlat(repo, h);
    const text = flat.has(rel) ? w.objects.get(flat.get(rel)).content : null;
    if (text === prevText) continue;
    if (text === null) { lines = []; owners = []; prevText = null; continue; }
    const nl = splitLines(text);
    const ops = diffLines(lines, nl);
    const nOwners = [];
    for (const op of ops) {
      if (op.op === '=') nOwners[op.b] = owners[op.a];
      else if (op.op === '+') nOwners[op.b] = h;
    }
    lines = nl; owners = nOwners; prevText = text;
  }
  let from = 1, to = lines.length;
  if (o['-L']) { const [a, b] = o['-L'].split(','); from = Number(a); to = b ? Number(b) : from; }
  const width = String(lines.length).length;
  for (let i = from - 1; i < to && i < lines.length; i++) {
    const c = w.commit(owners[i]);
    const who = o['-e'] ? `<${c.author.email}>` : c.author.name;
    ctx.out.push(o['-s']
      ? `${C.yellow(shortHash(owners[i]))} ${String(i + 1).padStart(width)}) ${lines[i]}`
      : `${C.yellow(shortHash(owners[i]))} (${who.padEnd(12)} ${isoDate(c.author.time)} ${String(i + 1).padStart(width)}) ${lines[i]}`);
  }
  return 0;
};

commands['cat-file'] = (ctx, args) => {
  const repo = needRepo(ctx);
  const o = parseOpts(args, { bool: ['-p', '-t', '-s', '-e'], val: [] });
  const w = ctx.world;
  const rev = o._[0];
  if (!rev) throw new GitError('usage: git cat-file (-t | -s | -e | -p | <type>) <object>', 129);
  let h;
  if (rev.includes(':')) {
    const [r, p] = rev.split(':');
    const flat = commitTreeFlat(repo, resolveCommit(repo, r || 'HEAD'));
    h = flat.get(p);
    if (!h) throw new GitError(`fatal: path '${p}' does not exist in '${r || 'HEAD'}'`);
  } else h = resolve(repo, rev, { peel: false });
  const obj = w.objects.get(h);
  if (!obj) throw new GitError(`fatal: Not a valid object name ${rev}`);
  if (o['-e']) return 0;
  if (o['-t']) { ctx.out.push(obj.type); return 0; }
  if (o['-s']) { ctx.out.push(String(obj.size)); return 0; }
  if (obj.type === 'blob') ctx.out.push(...splitLines(obj.content));
  else if (obj.type === 'tree') for (const e of obj.entries) ctx.out.push(`${e.mode.padStart(6, '0')} ${e.type} ${e.hash}\t${e.name}`);
  else ctx.out.push(...obj.raw.replace(/\n$/, '').split('\n'));
  return 0;
};

commands['hash-object'] = (ctx, args) => {
  const o = parseOpts(args, { bool: ['-w', '--stdin'], val: ['-t'] });
  const w = ctx.world;
  const contents = [];
  if (o['--stdin']) contents.push(ctx.stdin ?? '');
  for (const f of o._) {
    const abs = normPath(ctx.cwd + '/' + f);
    if (!w.files.has(abs)) throw new GitError(`fatal: could not open '${f}' for reading: No such file or directory`);
    contents.push(w.files.get(abs));
  }
  for (const c of contents) ctx.out.push(o['-w'] ? w.writeBlob(c) : w.blobHash(c));
  return 0;
};

commands['rev-parse'] = (ctx, args) => {
  const repo = ctx.repo;
  const o = parseOpts(args, { bool: ['--short', '--abbrev-ref', '--show-toplevel', '--git-dir', '--is-inside-work-tree', '--verify', '-q'], val: [] });
  if (o['--is-inside-work-tree']) { ctx.out.push(repo ? 'true' : 'false'); return repo ? 0 : 128; }
  needRepo(ctx);
  if (o['--show-toplevel']) { ctx.out.push(repo.root); return 0; }
  if (o['--git-dir']) { ctx.out.push('.git'); return 0; }
  for (const r of o._) {
    if (o['--abbrev-ref']) { ctx.out.push(r === 'HEAD' ? (currentBranch(repo) || 'HEAD') : r.replace(/^refs\/(heads|remotes)\//, '')); continue; }
    const h = resolve(repo, r, { peel: !r.includes('^{') ? true : true });
    ctx.out.push(o['--short'] ? shortHash(h) : h);
  }
  return 0;
};

commands['ls-files'] = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['-s', '--stage', '-o', '--others', '-m', '--modified', '-u', '--unmerged', '--exclude-standard', '-i', '--ignored', '-c', '--cached'], val: [] });
  const st = computeStatus(repo);
  if (o['-o'] || o['--others']) { for (const p of (o['-i'] || o['--ignored']) ? st.ignored : st.untracked) ctx.out.push(p); return 0; }
  if (o['-m'] || o['--modified']) { for (const s of st.unstaged) ctx.out.push(s.path); return 0; }
  if (o['-u'] || o['--unmerged']) {
    for (const [p, c] of repo.conflicts) { if (c.base) ctx.out.push(`100644 ${c.base} 1\t${p}`); if (c.ours) ctx.out.push(`100644 ${c.ours} 2\t${p}`); if (c.theirs) ctx.out.push(`100644 ${c.theirs} 3\t${p}`); }
    return 0;
  }
  for (const [p, h] of [...repo.index].sort()) ctx.out.push(o['-s'] || o['--stage'] ? `100644 ${h} 0\t${p}` : displayPath(ctx, p));
  return 0;
};

commands.clean = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['-n', '--dry-run', '-f', '--force', '-d', '-x', '-fd', '-nd', '-i', '-dn', '-df', '-fdx'], val: [] });
  const st = computeStatus(repo);
  const dry = o['-n'] || o['--dry-run'] || o['-nd'] || o['-dn'];
  const force = o['-f'] || o['--force'] || o['-fd'] || o['-df'] || o['-fdx'];
  const x = o['-x'] || o['-fdx'];
  if (!dry && !force) throw new GitError('fatal: clean.requireForce is true and -f not given: refusing to clean');
  const victims = [...st.untracked, ...(x ? st.ignored : [])];
  const withDirs = o['-d'] || o['-fd'] || o['-df'] || o['-nd'] || o['-dn'] || o['-fdx'];
  const shown = withDirs ? collapseUntracked(repo, victims) : victims.filter(p => !p.includes('/') || [...repo.index.keys()].some(k => k.startsWith(p.slice(0, p.lastIndexOf('/') + 1))));
  for (const p of shown) {
    ctx.out.push(`${dry ? 'Would remove' : 'Removing'} ${p}`);
    if (!dry) {
      if (p.endsWith('/')) for (const v of victims.filter(v => v.startsWith(p))) removeWork(repo, v);
      else removeWork(repo, p);
    }
  }
  if (!dry) ctx.world.pruneEmptyDirs(repo.root);
  return 0;
};

commands.shortlog = (ctx, args) => {
  const repo = needRepo(ctx);
  const o = parseOpts(args, { bool: ['-s', '-n', '-sn', '-ns', '-e'], val: [] });
  const w = ctx.world;
  const list = revList(w, [headCommit(repo)]);
  const by = new Map();
  for (const h of list) { const a = w.commit(h).author.name; if (!by.has(a)) by.set(a, []); by.get(a).push(firstLine(w.commit(h).message)); }
  let entries = [...by];
  if (o['-n'] || o['-sn'] || o['-ns']) entries.sort((a, b) => b[1].length - a[1].length);
  for (const [a, msgs] of entries) {
    if (o['-s'] || o['-sn'] || o['-ns']) ctx.out.push(`${String(msgs.length).padStart(6)}\t${a}`);
    else { ctx.out.push(`${a} (${msgs.length}):`); for (const m of msgs.reverse()) ctx.out.push('      ' + m); ctx.out.push(''); }
  }
  return 0;
};

commands.grep = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const o = parseOpts(args, { bool: ['-n', '-i', '-c', '-l'], val: [] });
  const pat = o._[0];
  if (!pat) throw new GitError('usage: git grep [<options>] [-e] <pattern> [<rev>...] [[--] <path>...]', 129);
  const re = new RegExp(pat.replace(/[.+^${}()|[\]\\]/g, '\\$&'), o['-i'] ? 'i' : '');
  const wt = worktree(repo);
  let any = false;
  for (const [p] of [...repo.index].sort()) {
    const lines = splitLines(wt.get(p) ?? '');
    const hits = lines.map((l, i) => [l, i]).filter(([l]) => re.test(l));
    if (!hits.length) continue;
    any = true;
    if (o['-l']) { ctx.out.push(C.magenta(p)); continue; }
    if (o['-c']) { ctx.out.push(`${C.magenta(p)}:${hits.length}`); continue; }
    for (const [l, i] of hits) ctx.out.push(`${C.magenta(p)}${C.cyan(':')}${o['-n'] ? C.green(String(i + 1)) + C.cyan(':') : ''}${l.replace(re, m => C.bold(C.red(m)))}`);
  }
  return any ? 0 : 1;
};

commands.bisect = (ctx, args) => {
  const repo = needWorkTree(ctx);
  const w = ctx.world;
  const sub = args[0];
  const b = repo.bisect;
  const next = () => {
    const bb = repo.bisect;
    if (!bb.bad || !bb.good.length) {
      if (!bb.bad) ctx.out.push(C.dim('status: waiting for both good and bad commits'));
      else ctx.out.push(C.dim(`status: waiting for good commit(s), bad commit known`));
      return 0;
    }
    const candidates = revList(w, [bb.bad], bb.good).filter(h => !bb.skip.includes(h));
    if (candidates.length === 1 || (candidates.length && candidates.every(h => h === bb.bad))) {
      const h = candidates[0];
      const c = w.commit(h);
      ctx.out.push(`${h} is the first bad commit`, C.yellow(`commit ${h}`), `Author: ${c.author.name} <${c.author.email}>`, `Date:   ${formatDate(c.author.time)}`, '', ...c.message.split('\n').map(l => '    ' + l), '');
      const before = c.parents[0] ? commitTreeFlat(repo, c.parents[0]) : new Map();
      ctx.out.push(...statLines(w, treePairs(before, commitTreeFlat(repo, h))));
      bb.found = h;
      w.emit({ type: 'bisect-found', hash: h });
      return 0;
    }
    // candidates are newest-first; pick the middle one
    const mid = candidates[Math.floor(candidates.length / 2)];
    const remaining = Math.floor(candidates.length / 2);
    checkoutTree(repo, commitTreeFlat(repo, mid), { force: true });
    switchHead(repo, mid, `checkout: moving to ${mid}`);
    const steps = Math.max(0, Math.ceil(Math.log2(candidates.length)) - 1);
    ctx.out.push(`Bisecting: ${remaining} revision${remaining === 1 ? '' : 's'} left to test after this (roughly ${steps} step${steps === 1 ? '' : 's'})`, `[${mid}] ${firstLine(w.commit(mid).message)}`);
    return 0;
  };
  if (sub === 'start') {
    repo.bisect = { good: [], bad: null, skip: [], startBranch: currentBranch(repo), startHead: headCommit(repo), found: null };
    const [bad, ...good] = args.slice(1).filter(a => a !== '--');
    if (bad) repo.bisect.bad = resolveCommit(repo, bad);
    for (const g of good) repo.bisect.good.push(resolveCommit(repo, g));
    if (bad || good.length) return next();
    ctx.out.push(C.dim('status: waiting for both good and bad commits'));
    return 0;
  }
  if (!b && sub !== 'reset') throw new GitError(`You need to start by "git bisect start"\n\nDo you want me to do it for you [Y/n]? (simulator: run "git bisect start")`, 1);
  if (sub === 'bad' || sub === 'new') { b.bad = resolveCommit(repo, args[1] || 'HEAD'); return next(); }
  if (sub === 'good' || sub === 'old') { b.good.push(resolveCommit(repo, args[1] || 'HEAD')); return next(); }
  if (sub === 'skip') { b.skip.push(resolveCommit(repo, args[1] || 'HEAD')); return next(); }
  if (sub === 'log') { if (b.bad) ctx.out.push(`# bad: [${b.bad}]`); for (const g of b.good) ctx.out.push(`# good: [${g}]`); return 0; }
  if (sub === 'reset') {
    if (!b) { ctx.out.push('We are not bisecting.'); return 0; }
    const target = b.startBranch ? 'refs/heads/' + b.startBranch : b.startHead;
    const th = b.startBranch ? repo.refs[target] : b.startHead;
    checkoutTree(repo, commitTreeFlat(repo, th), { force: true });
    switchHead(repo, target, `checkout: moving from ${shortHash(headCommit(repo))} to ${b.startBranch || th}`);
    repo.bisect = null;
    ctx.out.push(`Previous HEAD position was ${shortHash(th)}`, b.startBranch ? `Switched to branch '${b.startBranch}'` : `HEAD is now at ${shortHash(th)}`);
    return 0;
  }
  if (sub === 'run') {
    // git bisect run <cmd>: the simulator evaluates the command through the shell on each step
    const cmd = args.slice(1).join(' ');
    let guard = 0;
    while (!repo.bisect.found && guard++ < 40) {
      const code = ctx.runShell ? ctx.runShell(cmd) : 0;
      ctx.out.push(C.dim(`running '${cmd}' -> exit ${code}`));
      if (code === 0) repo.bisect.good.push(headCommit(repo)); else repo.bisect.bad = headCommit(repo);
      next();
    }
    ctx.out.push('bisect found first bad commit');
    return 0;
  }
  throw new GitError(`error: unknown subcommand '${sub}'`, 1);
};

commands.gc = (ctx) => { needRepo(ctx); ctx.out.push('Enumerating objects: done.', 'Counting objects: 100% done.', 'Nothing new to pack.'); return 0; };
commands.fsck = (ctx) => { needRepo(ctx); ctx.out.push('Checking object directories: 100% (256/256), done.'); return 0; };
commands.worktree = (ctx, args) => {
  const repo = needRepo(ctx);
  const w = ctx.world;
  const main = repo.mainRepo || repo;
  const sub = args[0];
  const linked = () => [...w.repos.values()].filter(r => r === main || r.mainRepo === main);
  if (sub === 'list' || !sub) {
    for (const r of linked()) ctx.out.push(`${r.root.padEnd(32)} ${shortHash(headCommit(r))} [${currentBranch(r) || 'detached HEAD'}]`);
    return 0;
  }
  if (sub === 'add') {
    const o = parseOpts(args.slice(1), { bool: ['-f', '--force', '--detach'], val: ['-b', '-B'] });
    const path = o._[0];
    if (!path) throw new GitError('usage: git worktree add [<options>] <path> [<commit-ish>]', 129);
    const abs = normPath(ctx.cwd + '/' + path);
    if (w.repos.has(abs) || [...w.files.keys()].some(f => f.startsWith(abs + '/'))) throw new GitError(`fatal: '${path}' already exists`);
    let branch = o['-b'] || o['-B'] || null;
    let start = o._[1] || null;
    if (!branch && start && main.refs['refs/heads/' + start]) { branch = start; start = null; }
    if (!branch && !start && !o['--detach']) { branch = path.split('/').pop(); }
    if (branch && !o['-b'] && !o['-B'] && !main.refs['refs/heads/' + branch]) {
      main.refs['refs/heads/' + branch] = resolveCommit(main, start || 'HEAD');
      ctx.out.push(`Preparing worktree (new branch '${branch}')`);
    } else if (o['-b'] || o['-B']) {
      if (main.refs['refs/heads/' + branch] && !o['-B']) throw new GitError(`fatal: a branch named '${branch}' already exists`);
      main.refs['refs/heads/' + branch] = resolveCommit(main, start || 'HEAD');
      ctx.out.push(`Preparing worktree (new branch '${branch}')`);
    } else ctx.out.push(`Preparing worktree (checking out '${branch || start}')`);
    if (branch) {
      const busy = linked().find(r => currentBranch(r) === branch);
      if (busy) throw new GitError(`fatal: '${branch}' is already used by worktree at '${busy.root}'`);
    }
    const wt = w.createRepo(abs);
    wt.mainRepo = main;
    wt.refs = main.refs;            // refs, config and objects are shared with the main worktree
    wt.config = main.config;
    wt.stash = main.stash;
    wt.HEAD = branch ? 'ref: refs/heads/' + branch : resolveCommit(main, start || 'HEAD');
    const tip = headCommit(wt);
    checkoutTree(wt, commitTreeFlat(wt, tip), { from: new Map(), force: true });
    ctx.out.push(`HEAD is now at ${describeCommit(w, tip)}`);
    w.emit({ type: 'worktree-add', path: abs, branch });
    return 0;
  }
  if (sub === 'remove') {
    const path = args.filter(a => !a.startsWith('-'))[1];
    const abs = normPath(ctx.cwd + '/' + path);
    const target = w.repos.get(abs);
    if (!target || target.mainRepo !== main) throw new GitError(`fatal: '${path}' is not a working tree`);
    if (!args.includes('--force') && !args.includes('-f')) {
      const st = computeStatus(target);
      if (st.staged.length || st.unstaged.length || st.untracked.length) throw new GitError(`fatal: '${path}' contains modified or untracked files, use --force to delete it`);
    }
    for (const f of [...w.files.keys()]) if (f.startsWith(abs + '/')) w.files.delete(f);
    for (const d of [...w.dirs]) if (d === abs || d.startsWith(abs + '/')) w.dirs.delete(d);
    w.repos.delete(abs);
    return 0;
  }
  if (sub === 'prune') return 0;
  throw new GitError(`usage: git worktree add | list | remove | prune`, 129);
};

commands.describe = (ctx, args) => {
  const repo = needRepo(ctx);
  const o = parseOpts(args, { bool: ['--tags', '--always'], val: [] });
  const w = ctx.world;
  const start = resolveCommit(repo, o._[0] || 'HEAD');
  const tagsAt = new Map();
  for (const [r, h] of Object.entries(repo.refs)) if (r.startsWith('refs/tags/') && (o['--tags'] || w.objects.get(h).type === 'tag')) tagsAt.set(w.peel(h), r.slice(10));
  const order = revList(w, [start]);
  for (let i = 0; i < order.length; i++) {
    if (tagsAt.has(order[i])) {
      const dist = revList(w, [start], [order[i]]).length;
      ctx.out.push(dist === 0 ? tagsAt.get(order[i]) : `${tagsAt.get(order[i])}-${dist}-g${shortHash(start)}`);
      return 0;
    }
  }
  if (o['--always']) { ctx.out.push(shortHash(start)); return 0; }
  throw new GitError('fatal: No names found, cannot describe anything.');
};

Object.assign(commands, remoteCommands({ parseOpts, needRepo, needWorkTree, mergeInto, commands, doRebase: (ctx, args) => commands.rebase(ctx, args), statLines, treePairs }));

// ---------- dispatcher ----------

export function runGit(ctx, args) {
  const w = ctx.world;
  if (!args.length) return commands.help(ctx);
  // global options
  while (args[0] && args[0].startsWith('-')) {
    if (args[0] === '--version' || args[0] === '-v') return commands.version(ctx);
    if (args[0] === '--help' || args[0] === '-h') return commands.help(ctx);
    if (args[0] === '-C') { ctx.cwd = normPath(ctx.cwd + '/' + args[1]); ctx.repo = w.findRepo(ctx.cwd); args = args.slice(2); continue; }
    if (args[0] === '-c') { args = args.slice(2); continue; }
    if (args[0] === '--no-pager') { args = args.slice(1); continue; }
    break;
  }
  let [cmd, ...rest] = args;
  const aliasVal = (ctx.repo && ctx.repo.config['alias.' + cmd]) || w.globalConfig['alias.' + cmd];
  if (aliasVal && !commands[cmd]) {
    const expanded = aliasVal.match(/"[^"]*"|'[^']*'|\S+/g).map(s => s.replace(/^["']|["']$/g, ''));
    if (expanded[0].startsWith('!')) { ctx.out.push(C.dim(`(shell alias: ${aliasVal.slice(1)})`)); return ctx.runShell ? ctx.runShell(aliasVal.slice(1)) : 0; }
    return runGit(ctx, [...expanded, ...rest]);
  }
  if (cmd === 'help') return commands.help(ctx);
  if (rest.includes('--help') || rest.includes('-h')) {
    ctx.out.push(C.dim(`(Manual pages are not bundled. Open the Field Guide in Git Conquest or run \`git help\` for the command list.)`));
    return 0;
  }
  const fn = commands[cmd];
  if (!fn) {
    const known = Object.keys(commands);
    const near = known.filter(k => levenshtein(k, cmd) <= 2).slice(0, 3);
    let msg = `git: '${cmd}' is not a git command. See 'git --help'.`;
    if (near.length) msg += `\n\nThe most similar command${near.length > 1 ? 's are' : ' is'}\n${near.map(n => '\t' + n).join('\n')}`;
    throw new GitError(msg, 1);
  }
  const code = fn(ctx, rest);
  return code;
}

export function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export { commands, identity };
