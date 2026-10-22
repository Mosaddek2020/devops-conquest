// A pretend GitHub: repositories, forks, pull requests, reviews, issues, releases,
// branch protection and a tiny Actions runner. Also the `gh` CLI that drives it.

import { GitError, C, shortHash, relativeTime } from './world.js';
import { isAncestor, mergeBase, mergeTrees, revList, commitTreeFlat, ancestors } from './core.js';
import { unifiedHunks } from './diff.js';
import { parseWorkflow, simulateRun, runWorkflows, approveDeployment, rerun, runIcon, currentDeployment, ensureEnvironment } from './actions.js';

export function protectionFor(bare, branch) {
  return bare.meta.protected?.[branch] || null;
}

// ---------- teammates & scripted events ----------

export function teammateCommit(world, url, { branch = 'main', files = {}, remove = [], message, author = { name: 'Priya Sharma', email: 'priya@example.com' } }) {
  const bare = world.remotes.get(url);
  const parent = bare.refs['refs/heads/' + branch] || null;
  const flat = parent ? world.readTreeFlat(world.commit(parent).tree) : new Map();
  for (const [p, content] of Object.entries(files)) flat.set(p, world.writeBlob(content));
  for (const p of remove) flat.delete(p);
  world.tick(11);
  const sig = { ...author, time: world.time };
  const h = world.writeCommit({ tree: world.writeTree(flat), parents: parent ? [parent] : [], message, author: sig, committer: sig });
  bare.refs['refs/heads/' + branch] = h;
  runWorkflows(world, bare, 'push', branch, h, null, { actor: author.name });
  world.emit({ type: 'teammate-commit', url, branch, hash: h, message, author: author.name });
  return h;
}

export function seedRemote(world, owner, name, commits, meta = {}) {
  // commits: [{message, files, remove?, author?, branch?}] applied in order
  const bare = world.createRemoteRepo(owner, name, meta);
  for (const c of commits) teammateCommit(world, bare.meta.url, { branch: c.branch || 'main', files: c.files || {}, remove: c.remove || [], message: c.message, author: c.author || { name: meta.authorName || 'Ada Okafor', email: meta.authorEmail || 'ada@example.com' } });
  bare.HEAD = 'ref: refs/heads/main';
  return bare;
}

// ---------- Actions (see actions.js) ----------

export { parseWorkflow, simulateRun, runWorkflows };

export function checksFor(bare, hash) {
  return bare.meta.runs.filter(r => r.hash === hash);
}

// ---------- pull requests ----------

function headOf(world, pr) {
  const repo = world.remotes.get(pr.headRepo);
  return repo?.refs['refs/heads/' + pr.head] || pr.headHash || null;
}

export function prStatus(world, bare, pr) {
  const head = headOf(world, pr);
  const base = bare.refs['refs/heads/' + pr.base];
  if (!head || !base) return { mergeable: false, reason: 'missing branch' };
  const mb = mergeBase(world, base, head);
  const merge = mergeTrees(world, commitTreeFlat(bareView(bare), mb), commitTreeFlat(bareView(bare), base), commitTreeFlat(bareView(bare), head), {});
  const commits = revList(world, [head], [base]).reverse();
  const rule = protectionFor(bare, pr.base);
  const approvals = pr.reviews.filter(r => r.state === 'APPROVED' && r.author !== pr.author).length;
  const changesRequested = pr.reviews.some(r => r.state === 'CHANGES_REQUESTED' && !pr.reviews.some(x => x.author === r.author && x.state === 'APPROVED' && x.time > r.time));
  const checks = checksFor(bare, head);
  const failingChecks = checks.filter(c => c.conclusion !== 'success');
  const blockers = [];
  if (pr.draft) blockers.push('This pull request is still a draft (gh pr ready)');
  if (merge.conflicts.length) blockers.push('This branch has conflicts that must be resolved');
  if (rule?.requiredReviews && approvals < rule.requiredReviews) blockers.push(`At least ${rule.requiredReviews} approving review is required by reviewers with write access`);
  if (changesRequested) blockers.push('Changes requested');
  if (rule?.requireChecks && (failingChecks.length || !checks.length)) blockers.push(checks.length ? 'Required status checks failed' : 'Required status checks have not run');
  if (rule?.requireUpToDate && !isAncestor(world, base, head)) blockers.push('This branch is out-of-date with the base branch (rebase or merge the latest base)');
  return { head, base, mb, merge, commits, approvals, checks, conflicts: merge.conflicts.map(c => c.path), blockers, mergeable: !blockers.length };
}

function bareView(bare) { return { world: bare.world }; }

export function mergePR(world, bare, pr, method = 'merge', { admin = false } = {}) {
  const st = prStatus(world, bare, pr);
  if (pr.state !== 'open') throw new GitError(`X Pull request #${pr.number} is already ${pr.state}`, 1);
  if (st.conflicts.length) throw new GitError(`X Pull request #${pr.number} is not mergeable: the merge commit cannot be cleanly created.\nTo have the pull request merged after all the requirements have been met, add the \`--auto\` flag.\nRun the following to resolve the merge conflicts locally:\n  gh pr checkout ${pr.number} && git fetch origin ${pr.base} && git merge origin/${pr.base}`, 1);
  if (st.blockers.length && !admin) throw new GitError(`X Pull request #${pr.number} is not mergeable: the base branch policy prohibits the merge.\n${st.blockers.map(b => '  - ' + b).join('\n')}`, 1);
  const me = world.github.user;
  world.tick(3);
  const sig = { name: me, email: `${me}@users.noreply.github.com`, time: world.time };
  const ghSig = { name: 'GitHub', email: 'noreply@github.com', time: world.time };
  const tree = world.writeTree(st.merge.result);
  let newHead;
  if (method === 'merge') {
    newHead = world.writeCommit({ tree, parents: [st.base, st.head], message: `Merge pull request #${pr.number} from ${pr.headOwner}/${pr.head}\n\n${pr.title}`, author: sig, committer: ghSig });
  } else if (method === 'squash') {
    const body = st.commits.map(h => '* ' + world.commit(h).message.split('\n')[0]).join('\n');
    newHead = world.writeCommit({ tree, parents: [st.base], message: `${pr.title} (#${pr.number})\n\n${body}`, author: { ...world.commit(st.head).author, time: world.time }, committer: ghSig });
  } else {
    let cur = st.base;
    for (const h of st.commits) {
      const c = world.commit(h);
      const m = mergeTrees(world, world.readTreeFlat(world.commit(c.parents[0]).tree), world.readTreeFlat(world.commit(cur).tree), world.readTreeFlat(c.tree), {});
      if (m.conflicts.length) throw new GitError(`X Pull request #${pr.number} cannot be rebased cleanly.`, 1);
      world.tick(1);
      cur = world.writeCommit({ tree: world.writeTree(m.result), parents: [cur], message: c.message, author: c.author, committer: ghSig });
    }
    newHead = cur;
  }
  bare.refs['refs/heads/' + pr.base] = newHead;
  pr.state = 'merged';
  pr.mergedAs = newHead;
  pr.mergeMethod = method;
  pr.mergedAt = world.time;
  // closing keywords
  const text = `${pr.title}\n${pr.body}`;
  for (const m of text.matchAll(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
    const issue = bare.meta.issues.find(i => i.number === Number(m[3]));
    if (issue && issue.state === 'open') { issue.state = 'closed'; issue.closedBy = pr.number; }
  }
  runWorkflows(world, bare, 'push', pr.base, newHead);
  world.emit({ type: 'pr-merged', url: bare.meta.url, number: pr.number, method });
  return newHead;
}

export function createPR(world, bare, { title, body = '', head, headRepo, base = 'main', author, draft = false }) {
  const number = bare.meta.nextNumber++;
  const headRepoObj = world.remotes.get(headRepo);
  const pr = { number, title, body, head, headRepo, headOwner: headRepoObj.meta.owner, base, author: author || world.github.user, state: 'open', draft, reviews: [], comments: [], time: world.time, headHash: headRepoObj.refs['refs/heads/' + head] };
  bare.meta.prs.push(pr);
  const hh = headRepoObj.refs['refs/heads/' + head];
  if (hh) runWorkflows(world, bare, 'pull_request', head, hh, number);
  world.emit({ type: 'pr-created', url: bare.meta.url, number });
  return pr;
}

export function reviewPR(world, bare, number, { state, body = '', author }) {
  const pr = bare.meta.prs.find(p => p.number === number);
  world.tick(2);
  pr.reviews.push({ state, body, author, time: world.time });
  world.emit({ type: 'pr-review', url: bare.meta.url, number, state, author });
  return pr;
}

// ---------- gh CLI ----------

function ghOpts(args, { bool = [], val = [], alias = {} }) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    let a = alias[args[i]] || args[i];
    if (a.startsWith('--') && a.includes('=')) { const k = a.slice(0, a.indexOf('=')); o[alias[k] || k] = a.slice(a.indexOf('=') + 1); continue; }
    if (val.includes(a)) { o[a] = args[++i]; continue; }
    if (bool.includes(a)) { o[a] = true; continue; }
    if (a.startsWith('-') && a.length > 1) throw new GitError(`unknown flag: ${a}\n\nUsage: see 'gh --help'`, 1);
    o._.push(a);
  }
  return o;
}

function contextRepo(ctx, { upstreamFirst = true } = {}) {
  const w = ctx.world;
  const repo = ctx.repo;
  if (!repo) throw new GitError('failed to determine base repo: not a git repository (or any of the parent directories): .git', 1);
  const names = ['upstream', 'origin'];
  if (!upstreamFirst) names.reverse();
  for (const n of names) {
    const url = repo.config[`remote.${n}.url`];
    if (!url) continue;
    const bare = w.remoteByUrl(url);
    if (bare) return { bare, remoteName: n };
  }
  throw new GitError(`none of the git remotes configured for this repository point to a known GitHub host.\nTo tell gh about a new GitHub host, please use \`gh auth login\``, 1);
}

function findPR(bare, ref) {
  const n = Number(String(ref).replace(/^#/, ''));
  const pr = bare.meta.prs.find(p => p.number === n);
  if (!pr) throw new GitError(`GraphQL: Could not resolve to a PullRequest with the number of ${ref}. (repository.pullRequest)`, 1);
  return pr;
}

export function runGh(ctx, args, git) {
  const w = ctx.world;
  const me = w.github.user;
  const [group, sub, ...rest] = args;
  const out = ctx.out;
  if (group === '--version' || group === 'version') { out.push('gh version 2.63.0 (git-conquest simulator)'); return 0; }
  if (!group || group === '--help' || group === 'help') {
    out.push('Work seamlessly with GitHub from the command line.', '', 'USAGE', '  gh <command> <subcommand> [flags]', '', 'CORE COMMANDS',
      '  auth:        Authenticate gh and git with GitHub', '  browse:      Open repositories, issues, pull requests in the browser',
      '  issue:       Manage issues', '  pr:          Manage pull requests', '  release:     Manage releases', '  repo:        Manage repositories',
      '  run:         View details about workflow runs', '  secret:      Manage Actions secrets', '  ssh-key:     Manage SSH keys', '  workflow:    List and run workflows');
    return 0;
  }
  if (!w.github.authed && !(group === 'auth')) throw new GitError('To get started with GitHub CLI, please run:  gh auth login', 4);

  if (group === 'auth') {
    if (sub === 'login') { w.github.authed = true; out.push(`! First copy your one-time code: 4F2A-9C1B`, `✓ Authentication complete.`, `- gh config set -h github.com git_protocol https`, `✓ Configured git protocol`, `✓ Logged in as ${me}`); w.emit({ type: 'gh-login' }); return 0; }
    if (sub === 'logout') { w.github.authed = false; out.push(`✓ Logged out of github.com account ${me}`); return 0; }
    if (sub === 'status') {
      if (!w.github.authed) { out.push('You are not logged into any GitHub hosts. To log in, run: gh auth login'); return 1; }
      out.push('github.com', `  ✓ Logged in to github.com account ${me} (keyring)`, '  - Active account: true', '  - Git operations protocol: https', `  - Token: gho_************************************`, `  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`);
      return 0;
    }
  }

  if (group === 'ssh-key') {
    if (sub === 'add') {
      const o = ghOpts(rest, { val: ['--title', '-t'] });
      const path = o._[0];
      if (!path) throw new GitError('error: public key file missing', 1);
      const abs = path.startsWith('/') ? path : (path.startsWith('~') ? w.home + path.slice(1) : ctx.cwd + '/' + path);
      const content = w.files.get(abs.replace(/\/+/g, '/'));
      if (!content) throw new GitError(`open ${path}: no such file or directory`, 1);
      if (!content.startsWith('ssh-')) throw new GitError('HTTP 422: Validation Failed (https://api.github.com/user/keys)\nkey is invalid. You must supply a key in OpenSSH public key format', 1);
      w.github.sshKeys.push({ title: o['--title'] || o['-t'] || 'dev-laptop', key: content.trim() });
      out.push(`✓ Public key added to your account`);
      w.emit({ type: 'ssh-key-added' });
      return 0;
    }
    if (sub === 'list') { for (const k of w.github.sshKeys) out.push(`${k.title}\t${k.key.slice(0, 40)}...`); return 0; }
  }

  if (group === 'repo') {
    if (sub === 'create') {
      const o = ghOpts(rest, { bool: ['--public', '--private', '--push', '--clone', '-c'], val: ['--source', '-s', '--remote', '-r', '--description', '-d'], alias: { '-s': '--source', '-r': '--remote', '-d': '--description', '-c': '--clone' } });
      const name = o._[0] || (o['--source'] ? (ctx.repo?.root || ctx.cwd).split('/').pop() : null);
      if (!name) throw new GitError('name argument required when not running interactively', 1);
      const [owner, nm] = name.includes('/') ? name.split('/') : [me, name];
      if (w.remotes.has(`https://github.com/${owner}/${nm}.git`)) throw new GitError(`GraphQL: Name already exists on this account (createRepository)`, 1);
      const bare = w.createRemoteRepo(owner, nm, { visibility: o['--private'] ? 'private' : 'public', description: o['--description'] || '' });
      out.push(`✓ Created repository ${owner}/${nm} on GitHub`, `  https://github.com/${owner}/${nm}`);
      if (o['--source']) {
        const remoteName = o['--remote'] || 'origin';
        const r = ctx.repo;
        if (!r) throw new GitError(`current directory is not a git repository. Run \`git init\` to initialize it`, 1);
        if (r.config[`remote.${remoteName}.url`]) throw new GitError(`Unable to add remote "${remoteName}"`, 1);
        r.config[`remote.${remoteName}.url`] = bare.meta.url;
        r.config[`remote.${remoteName}.fetch`] = `+refs/heads/*:refs/remotes/${remoteName}/*`;
        out.push(`✓ Added remote ${bare.meta.url}`);
        if (o['--push']) {
          const sub2 = { ...ctx, out: [] };
          const code = git(sub2, ['push', '-u', remoteName, 'HEAD']);
          out.push(...sub2.out);
          if (code === 0) out.push(`✓ Pushed commits to ${bare.meta.url}`);
        }
      } else if (o['--clone']) {
        return git(ctx, ['clone', bare.meta.url]);
      }
      w.emit({ type: 'gh-repo-create', url: bare.meta.url });
      return 0;
    }
    if (sub === 'clone') {
      const o = ghOpts(rest, {});
      let target = o._[0];
      if (!target) throw new GitError('cannot clone: repository argument required', 1);
      if (!target.includes('/')) target = `${me}/${target}`;
      const c = git(ctx, ['clone', `https://github.com/${target.replace(/\.git$/, '')}.git`, ...o._.slice(1)]);
      // gh adds an upstream remote for forks
      const bare = w.remoteByUrl(target);
      if (c === 0 && bare?.meta.forkOf) {
        const root = ctx.cwd.replace(/\/$/, '') + '/' + (o._[1] || bare.meta.name);
        const r = w.repos.get(root);
        if (r) { r.config['remote.upstream.url'] = bare.meta.forkOf; r.config['remote.upstream.fetch'] = '+refs/heads/*:refs/remotes/upstream/*'; }
      }
      return c;
    }
    if (sub === 'fork') {
      const o = ghOpts(rest, { bool: ['--clone', '--remote'], val: ['--fork-name'] });
      let src;
      if (o._[0]) src = w.remoteByUrl(o._[0].includes('/') ? o._[0] : `${me}/${o._[0]}`);
      else src = contextRepo(ctx).bare;
      if (!src) throw new GitError(`GraphQL: Could not resolve to a Repository with the name '${o._[0]}'. (repository)`, 1);
      const name = o['--fork-name'] || src.meta.name;
      const forkUrl = `https://github.com/${me}/${name}.git`;
      let fork = w.remotes.get(forkUrl);
      if (src.meta.owner === me) throw new GitError(`failed to fork: ${me}/${name} cannot be forked by its owner`, 1);
      if (!fork) {
        fork = w.createRemoteRepo(me, name, { forkOf: src.meta.url, description: src.meta.description });
        fork.refs = { ...src.refs };
        fork.HEAD = src.HEAD;
        out.push(`✓ Created fork ${me}/${name}`);
      } else out.push(`! ${me}/${name} already exists`);
      w.emit({ type: 'fork', from: src.meta.url, url: forkUrl });
      if (o['--remote'] && ctx.repo) {
        const r = ctx.repo;
        if (r.config['remote.origin.url'] && w.remoteByUrl(r.config['remote.origin.url']) === src) {
          git({ ...ctx, out: [] }, ['remote', 'rename', 'origin', 'upstream']);
          out.push(`✓ Renamed remote origin to upstream`);
        }
        r.config['remote.origin.url'] = forkUrl;
        r.config['remote.origin.fetch'] = '+refs/heads/*:refs/remotes/origin/*';
        out.push(`✓ Added remote origin`);
        git({ ...ctx, out: [] }, ['fetch', 'origin']);
      }
      if (o['--clone']) {
        const code = git(ctx, ['clone', forkUrl]);
        const root = ctx.cwd.replace(/\/$/, '') + '/' + name;
        const r = w.repos.get(root);
        if (code === 0 && r) {
          r.config['remote.upstream.url'] = src.meta.url;
          r.config['remote.upstream.fetch'] = '+refs/heads/*:refs/remotes/upstream/*';
          git({ ...ctx, cwd: root, repo: r, out: [] }, ['fetch', 'upstream']);
          out.push(`✓ Cloned fork`, `! Repository ${src.meta.owner}/${src.meta.name} set as the default repository. To learn more or change this selection, see: gh repo set-default`);
        }
      }
      return 0;
    }
    if (sub === 'view') {
      const o = ghOpts(rest, { bool: ['--web', '-w'], val: [] });
      const bare = o._[0] ? w.remoteByUrl(o._[0]) : contextRepo(ctx, { upstreamFirst: false }).bare;
      if (!bare) throw new GitError(`GraphQL: Could not resolve to a Repository with the name '${o._[0]}'.`, 1);
      out.push(C.bold(`${bare.meta.owner}/${bare.meta.name}`), bare.meta.description || C.dim('No description provided'), '');
      if (bare.meta.forkOf) out.push(C.dim(`forked from ${bare.meta.forkOf.replace('https://github.com/', '').replace(/\.git$/, '')}`), '');
      const head = bare.refs[bare.HEAD.slice(5)];
      const readme = head && [...w.readTreeFlat(w.commit(head).tree)].find(([p]) => /^readme(\.md)?$/i.test(p));
      if (readme) out.push(...w.objects.get(readme[1]).content.split('\n'));
      else out.push(C.dim('This repository does not have a README'));
      out.push('', C.dim(`View this repository on GitHub: https://github.com/${bare.meta.owner}/${bare.meta.name}`));
      return 0;
    }
    if (sub === 'list') {
      for (const r of w.remotes.values()) if (r.meta.owner === me) out.push(`${me}/${r.meta.name}\t${r.meta.description || ''}\t${r.meta.visibility}${r.meta.forkOf ? ', fork' : ''}`);
      return 0;
    }
    if (sub === 'sync') {
      const { bare } = contextRepo(ctx, { upstreamFirst: false });
      if (!bare.meta.forkOf) throw new GitError('this repository is not a fork', 1);
      const parent = w.remotes.get(bare.meta.forkOf);
      const b = bare.HEAD.replace('ref: refs/heads/', '');
      const ph = parent.refs['refs/heads/' + b], fh = bare.refs['refs/heads/' + b];
      if (fh && !isAncestor(w, fh, ph)) throw new GitError(`can't sync because there are diverging changes; use \`--force\` to overwrite`, 1);
      bare.refs['refs/heads/' + b] = ph;
      out.push(`✓ Synced the "${me}:${b}" branch from "${parent.meta.owner}:${b}"`);
      return 0;
    }
  }

  if (group === 'pr') {
    const { bare } = contextRepo(ctx);
    if (sub === 'create') {
      const o = ghOpts(rest, { bool: ['--fill', '-f', '--draft', '-d', '--web'], val: ['--title', '-t', '--body', '-b', '--base', '-B', '--head', '-H', '--reviewer', '-r', '--assignee', '-a', '--label', '-l'], alias: { '-t': '--title', '-b': '--body', '-B': '--base', '-H': '--head', '-f': '--fill', '-d': '--draft', '-r': '--reviewer' } });
      const repo = ctx.repo;
      const cur = repo.HEAD.startsWith('ref: refs/heads/') ? repo.HEAD.slice(16) : null;
      let headSpec = o['--head'] || cur;
      if (!headSpec) throw new GitError('could not determine the current branch', 1);
      let headOwner = null, headBranch = headSpec;
      if (headSpec.includes(':')) [headOwner, headBranch] = headSpec.split(':');
      const originBare = repo.config['remote.origin.url'] ? w.remoteByUrl(repo.config['remote.origin.url']) : null;
      let headRepo;
      if (headOwner) headRepo = headOwner === bare.meta.owner ? bare : w.remotes.get(`https://github.com/${headOwner}/${bare.meta.name}.git`);
      else if (originBare && originBare !== bare && originBare.refs['refs/heads/' + headBranch]) headRepo = originBare;
      else if (bare.refs['refs/heads/' + headBranch]) headRepo = bare;
      else headRepo = originBare || bare;
      headOwner = headRepo ? headRepo.meta.owner : me;
      if (!headRepo || !headRepo.refs['refs/heads/' + headBranch]) {
        throw new GitError(`aborted: you must first push the current branch to a remote, or use the --head flag`, 1);
      }
      const base = o['--base'] || bare.HEAD.replace('ref: refs/heads/', '');
      if (headRepo === bare && headBranch === base) throw new GitError(`GraphQL: No commits between ${base} and ${headBranch} (createPullRequest)`, 1);
      const existing = bare.meta.prs.find(p => p.state === 'open' && p.head === headBranch && p.headRepo === headRepo.meta.url);
      if (existing) throw new GitError(`a pull request for branch "${headBranch}" into branch "${base}" already exists:\nhttps://github.com/${bare.meta.owner}/${bare.meta.name}/pull/${existing.number}`, 1);
      const headHash = headRepo.refs['refs/heads/' + headBranch];
      const baseHash = bare.refs['refs/heads/' + base];
      if (baseHash && isAncestor(w, headHash, baseHash)) throw new GitError(`GraphQL: No commits between ${base} and ${headBranch} (createPullRequest)`, 1);
      let title = o['--title'], body = o['--body'] || '';
      if (o['--fill'] || !title) {
        const commits = revList(w, [headHash], baseHash ? [baseHash] : []);
        if (!title) title = commits.length === 1 ? w.commit(commits[0]).message.split('\n')[0] : headBranch.replace(/[-_/]/g, ' ');
        if (!body) body = commits.map(h => '- ' + w.commit(h).message.split('\n')[0]).join('\n');
      }
      const pr = createPR(w, bare, { title, body, head: headBranch, headRepo: headRepo.meta.url, base, draft: !!o['--draft'] });
      if (o['--reviewer']) pr.requestedReviewers = o['--reviewer'].split(',');
      out.push('', `Creating pull request for ${headOwner === bare.meta.owner ? '' : headOwner + ':'}${headBranch} into ${base} in ${bare.meta.owner}/${bare.meta.name}`, '', `https://github.com/${bare.meta.owner}/${bare.meta.name}/pull/${pr.number}`);
      return 0;
    }
    if (sub === 'list') {
      const o = ghOpts(rest, { val: ['--state', '-s'], alias: { '-s': '--state' } });
      const state = o['--state'] || 'open';
      const list = bare.meta.prs.filter(p => state === 'all' || p.state === state).slice().reverse();
      if (!list.length) { out.push(`no ${state === 'all' ? '' : state + ' '}pull requests match your search in ${bare.meta.owner}/${bare.meta.name}`); return 0; }
      out.push('', `Showing ${list.length} of ${list.length} ${state === 'all' ? '' : state + ' '}pull request${list.length === 1 ? '' : 's'} in ${bare.meta.owner}/${bare.meta.name}`, '');
      for (const p of list) out.push(`${C.green('#' + p.number)}  ${p.title.padEnd(36)}  ${C.cyan(p.headOwner === bare.meta.owner ? p.head : p.headOwner + ':' + p.head)}  ${p.state.toUpperCase()}`);
      return 0;
    }
    if (sub === 'view' || sub === 'status' || sub === 'checks' || sub === 'diff') {
      const o = ghOpts(rest, { bool: ['--comments', '-c', '--web'], val: [] });
      let pr;
      if (o._[0]) pr = findPR(bare, o._[0]);
      else {
        const cur = ctx.repo.HEAD.startsWith('ref: refs/heads/') ? ctx.repo.HEAD.slice(16) : null;
        pr = bare.meta.prs.find(p => p.head === cur && p.state === 'open');
        if (!pr) { out.push(sub === 'status' ? 'Current branch\n  There is no pull request associated with [' + cur + ']' : `no pull requests found for branch "${cur}"`); return sub === 'status' ? 0 : 1; }
      }
      const st = prStatus(w, bare, pr);
      if (sub === 'diff') {
        const mbFlat = commitTreeFlat({ world: w }, st.mb), headFlat = commitTreeFlat({ world: w }, st.head);
        for (const p of [...new Set([...mbFlat.keys(), ...headFlat.keys()])].sort()) {
          if (mbFlat.get(p) === headFlat.get(p)) continue;
          out.push(C.bold(`diff --git a/${p} b/${p}`));
          for (const l of unifiedHunks(mbFlat.has(p) ? w.objects.get(mbFlat.get(p)).content : '', headFlat.has(p) ? w.objects.get(headFlat.get(p)).content : '')) out.push(l.startsWith('+') ? C.green(l) : l.startsWith('-') ? C.red(l) : l.startsWith('@@') ? C.cyan(l) : l);
        }
        return 0;
      }
      if (sub === 'checks') {
        if (!st.checks.length) { out.push(`no checks reported on the '${pr.head}' branch`); return 1; }
        for (const r of st.checks) for (const j of r.jobs) out.push(`${jobIcon(j)}  ${r.workflow} / ${j.id}  (${r.event})${j.conclusion === 'skipped' ? C.dim('  skipped') : ''}`);
        return st.checks.every(c => c.conclusion === 'success') ? 0 : 8;
      }
      out.push(C.bold(`${pr.title} #${pr.number}`));
      out.push(`${pr.state === 'open' ? C.green('Open') : pr.state === 'merged' ? C.magenta('Merged') : C.red('Closed')} • ${pr.author} wants to merge ${pl2(st.commits.length, 'commit')} into ${pr.base} from ${pr.headOwner === bare.meta.owner ? pr.head : pr.headOwner + ':' + pr.head}`);
      if (pr.reviews.length) out.push(`Reviews: ${pr.reviews.map(r => `${r.author} (${r.state.replace('_', ' ').toLowerCase()})`).join(', ')}`);
      if (st.checks.length) out.push(`Checks: ${st.checks.map(c => `${statusIcon(c)} ${c.workflow}`).join('  ')}`);
      out.push('', pr.body || C.dim('No description provided'), '');
      if (pr.state === 'open') {
        if (st.conflicts.length) out.push(C.red(`This branch has conflicts that must be resolved: ${st.conflicts.join(', ')}`));
        else if (st.blockers.length) out.push(C.yellow(`Merging is blocked:`), ...st.blockers.map(b => C.yellow('  - ' + b)));
        else out.push(C.green('✓ This branch has no conflicts with the base branch and can be merged.'));
      }
      if (o['--comments'] || o['-c']) for (const r of [...pr.reviews, ...pr.comments]) out.push('', C.bold(r.author) + C.dim(` • ${relativeTime(r.time, w.time)}`) + (r.state ? ` • ${r.state}` : ''), r.body);
      out.push('', C.dim(`View this pull request on GitHub: https://github.com/${bare.meta.owner}/${bare.meta.name}/pull/${pr.number}`));
      return 0;
    }
    if (sub === 'checkout') {
      const pr = findPR(bare, rest[0]);
      const headRepo = w.remotes.get(pr.headRepo);
      const r = ctx.repo;
      const remoteName = Object.keys(r.config).find(k => /^remote\..+\.url$/.test(k) && w.remoteByUrl(r.config[k]) === headRepo)?.split('.')[1];
      if (remoteName) {
        git({ ...ctx, out: [] }, ['fetch', remoteName]);
        if (r.refs['refs/heads/' + pr.head]) return git(ctx, ['switch', pr.head]);
        return git(ctx, ['switch', '-c', pr.head, '--track', `${remoteName}/${pr.head}`]);
      }
      const h = headRepo.refs['refs/heads/' + pr.head];
      r.refs[`refs/heads/${pr.head}`] = h;
      return git(ctx, ['switch', pr.head]);
    }
    if (sub === 'review') {
      const o = ghOpts(rest, { bool: ['--approve', '-a', '--request-changes', '-r', '--comment', '-c'], val: ['--body', '-b'], alias: { '-a': '--approve', '-r': '--request-changes', '-c': '--comment', '-b': '--body' } });
      const pr = findPR(bare, o._[0] || bare.meta.prs.filter(p => p.state === 'open').slice(-1)[0]?.number);
      if (pr.author === me && (o['--approve'] || o['--request-changes'])) throw new GitError(`failed to create review: GraphQL: Review Can not ${o['--approve'] ? 'approve' : 'request changes on'} your own pull request (addPullRequestReview)`, 1);
      const state = o['--approve'] ? 'APPROVED' : o['--request-changes'] ? 'CHANGES_REQUESTED' : 'COMMENTED';
      if (state !== 'APPROVED' && !o['--body']) throw new GitError('body cannot be blank for comment and request-changes reviews', 1);
      reviewPR(w, bare, pr.number, { state, body: o['--body'] || '', author: me });
      out.push(`${state === 'APPROVED' ? C.green('✓ Approved') : state === 'CHANGES_REQUESTED' ? C.red('+ Requested changes to') : '- Reviewed'} pull request ${bare.meta.owner}/${bare.meta.name}#${pr.number}`);
      return 0;
    }
    if (sub === 'comment') {
      const o = ghOpts(rest, { val: ['--body', '-b'], alias: { '-b': '--body' } });
      const pr = findPR(bare, o._[0]);
      pr.comments.push({ author: me, body: o['--body'] || '', time: w.time });
      out.push(`https://github.com/${bare.meta.owner}/${bare.meta.name}/pull/${pr.number}#issuecomment-1`);
      return 0;
    }
    if (sub === 'merge') {
      const o = ghOpts(rest, { bool: ['--merge', '-m', '--squash', '-s', '--rebase', '-r', '--delete-branch', '-d', '--admin', '--auto'], val: ['--subject', '-t', '--body', '-b'], alias: { '-m': '--merge', '-s': '--squash', '-r': '--rebase', '-d': '--delete-branch' } });
      const pr = findPR(bare, o._[0] || bare.meta.prs.find(p => p.state === 'open' && ctx.repo.HEAD === 'ref: refs/heads/' + p.head)?.number);
      const method = o['--squash'] ? 'squash' : o['--rebase'] ? 'rebase' : o['--merge'] ? 'merge' : null;
      if (!method) throw new GitError('--merge, --rebase, or --squash required when not running interactively', 1);
      if (bare.meta.allowedMerge && !bare.meta.allowedMerge.includes(method)) throw new GitError(`X Pull request #${pr.number} is not mergeable: ${method} merges are not allowed on this repository`, 1);
      mergePR(w, bare, pr, method, { admin: o['--admin'] });
      out.push(`${C.magenta('✓')} ${method === 'squash' ? 'Squashed and merged' : method === 'rebase' ? 'Rebased and merged' : 'Merged'} pull request ${bare.meta.owner}/${bare.meta.name}#${pr.number} (${pr.title})`);
      if (o['--delete-branch']) {
        const headRepo = w.remotes.get(pr.headRepo);
        delete headRepo.refs['refs/heads/' + pr.head];
        out.push(`${C.red('✓')} Deleted remote branch ${pr.head}`);
        const r = ctx.repo;
        const base = pr.base;
        if (r.HEAD === 'ref: refs/heads/' + pr.head && r.refs['refs/heads/' + base]) {
          const c2 = { ...ctx, out: [] };
          git(c2, ['switch', base]);
          git(c2, ['pull', '--ff-only']);
          git(c2, ['branch', '-D', pr.head]);
          out.push(`${C.red('✓')} Deleted local branch ${pr.head} and switched to branch ${base}`);
        }
      }
      return 0;
    }
    if (sub === 'close' || sub === 'reopen') {
      const pr = findPR(bare, rest[0]);
      pr.state = sub === 'close' ? 'closed' : 'open';
      out.push(`${sub === 'close' ? C.red('✓ Closed') : C.green('✓ Reopened')} pull request ${bare.meta.owner}/${bare.meta.name}#${pr.number} (${pr.title})`);
      return 0;
    }
    if (sub === 'ready') {
      const cur = ctx.repo.HEAD.startsWith('ref: refs/heads/') ? ctx.repo.HEAD.slice(16) : null;
      const pr = rest[0] ? findPR(bare, rest[0]) : bare.meta.prs.find(p => p.state === 'open' && p.head === cur);
      if (!pr) throw new GitError(`no pull requests found for branch "${cur}"`, 1);
      pr.draft = false; out.push(`✓ Pull request ${bare.meta.owner}/${bare.meta.name}#${pr.number} is marked as "ready for review"`); return 0; }
    if (sub === 'edit') {
      const o = ghOpts(rest, { val: ['--title', '-t', '--body', '-b', '--add-reviewer', '--base', '-B', '--add-label'], alias: { '-t': '--title', '-b': '--body', '-B': '--base' } });
      const pr = findPR(bare, o._[0]);
      if (o['--title']) pr.title = o['--title'];
      if (o['--body']) pr.body = o['--body'];
      if (o['--base']) pr.base = o['--base'];
      if (o['--add-reviewer']) { pr.requestedReviewers = [...(pr.requestedReviewers || []), ...o['--add-reviewer'].split(',')]; w.emit({ type: 'review-requested', url: bare.meta.url, number: pr.number, reviewers: o['--add-reviewer'].split(',') }); }
      out.push(`https://github.com/${bare.meta.owner}/${bare.meta.name}/pull/${pr.number}`);
      return 0;
    }
  }

  if (group === 'issue') {
    const { bare } = contextRepo(ctx);
    if (sub === 'create') {
      const o = ghOpts(rest, { val: ['--title', '-t', '--body', '-b', '--label', '-l', '--assignee', '-a'], alias: { '-t': '--title', '-b': '--body', '-l': '--label', '-a': '--assignee' } });
      if (!o['--title']) throw new GitError('must provide `--title` and `--body` when not running interactively', 1);
      const issue = { number: bare.meta.nextNumber++, title: o['--title'], body: o['--body'] || '', labels: o['--label'] ? o['--label'].split(',') : [], state: 'open', author: me, assignee: o['--assignee'] === '@me' ? me : o['--assignee'], comments: [], time: w.time };
      bare.meta.issues.push(issue);
      out.push('', `Creating issue in ${bare.meta.owner}/${bare.meta.name}`, '', `https://github.com/${bare.meta.owner}/${bare.meta.name}/issues/${issue.number}`);
      w.emit({ type: 'issue-created', url: bare.meta.url, number: issue.number });
      return 0;
    }
    if (sub === 'list') {
      const o = ghOpts(rest, { val: ['--state', '-s', '--label', '-l'], alias: { '-s': '--state', '-l': '--label' } });
      const state = o['--state'] || 'open';
      const list = bare.meta.issues.filter(i => (state === 'all' || i.state === state) && (!o['--label'] || i.labels.includes(o['--label']))).slice().reverse();
      if (!list.length) { out.push(`no ${state} issues match your search in ${bare.meta.owner}/${bare.meta.name}`); return 0; }
      out.push('', `Showing ${list.length} of ${list.length} ${state} issue${list.length === 1 ? '' : 's'} in ${bare.meta.owner}/${bare.meta.name}`, '');
      for (const i of list) out.push(`${i.state === 'open' ? C.green('#' + i.number) : C.magenta('#' + i.number)}  ${i.title.padEnd(40)}  ${i.labels.map(l => C.yellow(l)).join(', ')}`);
      return 0;
    }
    if (sub === 'view') {
      const n = Number(String(rest[0]).replace('#', ''));
      const i = bare.meta.issues.find(x => x.number === n);
      if (!i) throw new GitError(`GraphQL: Could not resolve to an issue or pull request with the number of ${n}.`, 1);
      out.push(C.bold(`${i.title} #${i.number}`), `${i.state === 'open' ? C.green('Open') : C.magenta('Closed')} • ${i.author} opened • ${i.comments.length} comments`, i.labels.length ? `Labels: ${i.labels.join(', ')}` : '', '', i.body || C.dim('No description provided'));
      if (i.closedBy) out.push('', C.dim(`Closed by pull request #${i.closedBy}`));
      return 0;
    }
    if (sub === 'close' || sub === 'reopen') {
      const n = Number(String(rest[0]).replace('#', ''));
      const i = bare.meta.issues.find(x => x.number === n);
      if (!i) throw new GitError(`GraphQL: Could not resolve to an issue with the number of ${n}.`, 1);
      i.state = sub === 'close' ? 'closed' : 'open';
      out.push(`${sub === 'close' ? C.magenta('✓ Closed') : C.green('✓ Reopened')} issue ${bare.meta.owner}/${bare.meta.name}#${n} (${i.title})`);
      return 0;
    }
    if (sub === 'comment') {
      const o = ghOpts(rest, { val: ['--body', '-b'], alias: { '-b': '--body' } });
      const i = bare.meta.issues.find(x => x.number === Number(String(o._[0]).replace('#', '')));
      i.comments.push({ author: me, body: o['--body'] || '', time: w.time });
      out.push(`https://github.com/${bare.meta.owner}/${bare.meta.name}/issues/${i.number}#issuecomment-1`);
      return 0;
    }
  }

  if (group === 'release') {
    const { bare } = contextRepo(ctx, { upstreamFirst: false });
    if (sub === 'create') {
      const o = ghOpts(rest, { bool: ['--generate-notes', '--draft', '--prerelease', '--latest'], val: ['--title', '-t', '--notes', '-n', '--target'], alias: { '-t': '--title', '-n': '--notes' } });
      const tag = o._[0];
      if (!tag) throw new GitError('could not create: no tag name provided', 1);
      if (!bare.refs['refs/tags/' + tag]) {
        const target = bare.refs['refs/heads/' + (o['--target'] || bare.HEAD.replace('ref: refs/heads/', ''))];
        bare.refs['refs/tags/' + tag] = target;
      }
      let notes = o['--notes'] || '';
      if (o['--generate-notes']) {
        const prev = bare.meta.releases[0];
        const merged = bare.meta.prs.filter(p => p.state === 'merged' && (!prev || p.mergedAt > prev.time));
        notes = `## What's Changed\n${merged.map(p => `* ${p.title} by @${p.author} in #${p.number}`).join('\n') || '* Initial release'}\n\n**Full Changelog**: ${prev ? `${prev.tag}...${tag}` : `commits/${tag}`}`;
      }
      bare.meta.releases.unshift({ tag, title: o['--title'] || tag, notes, time: w.time, draft: !!o['--draft'], prerelease: !!o['--prerelease'] });
      out.push(`https://github.com/${bare.meta.owner}/${bare.meta.name}/releases/tag/${tag}`);
      w.emit({ type: 'release', url: bare.meta.url, tag });
      return 0;
    }
    if (sub === 'list') {
      bare.meta.releases.forEach((r, i) => out.push(`${r.title.padEnd(20)} ${i === 0 && !r.prerelease ? C.green('Latest') : r.prerelease ? C.yellow('Pre-release') : ''}\t${r.tag}`));
      return 0;
    }
    if (sub === 'view') {
      const r = rest[0] ? bare.meta.releases.find(x => x.tag === rest[0]) : bare.meta.releases[0];
      if (!r) throw new GitError('release not found', 1);
      out.push(C.bold(r.title), r.tag, '', ...r.notes.split('\n'));
      return 0;
    }
  }

  if (group === 'secret') {
    const { bare } = contextRepo(ctx, { upstreamFirst: false });
    bare.meta.secrets = bare.meta.secrets || {};
    if (sub === 'set') {
      const o = ghOpts(rest, { val: ['--body', '-b'], alias: { '-b': '--body' } });
      const name = o._[0];
      if (!name) throw new GitError('secret name required', 1);
      if (!o['--body']) throw new GitError('no secret value provided: use --body', 1);
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new GitError('secret names can only contain letters, numbers and _', 1);
      bare.meta.secrets[name.toUpperCase()] = { updated: w.time, value: String(o['--body']) };
      out.push(`✓ Set Actions secret ${name.toUpperCase()} for ${bare.meta.owner}/${bare.meta.name}`);
      w.emit({ type: 'secret-set', name: name.toUpperCase() });
      return 0;
    }
    if (sub === 'list') {
      const names = Object.keys(bare.meta.secrets);
      if (!names.length) { out.push('no secrets found'); return 0; }
      for (const n of names) out.push(`${n.padEnd(20)} Updated ${relativeTime(bare.meta.secrets[n].updated, w.time)}`);
      return 0;
    }
    if (sub === 'delete') { delete bare.meta.secrets[(rest[0] || '').toUpperCase()]; out.push(`✓ Deleted secret ${rest[0]}`); return 0; }
  }

  if (group === 'run') {
    const { bare } = contextRepo(ctx, { upstreamFirst: false });
    const findRun = (args) => { const id = args.find(x => /^\d+$/.test(x)); const r = id ? bare.meta.runs.find(x => x.id === Number(id)) : bare.meta.runs[0]; if (!r) throw new GitError(id ? `could not find any workflow run with ID ${id}` : 'no runs found', 1); return r; };
    if (sub === 'list' || sub === 'ls') {
      const o = ghOpts(rest, { val: ['--workflow', '-w', '--branch', '-b', '--limit', '-L'], alias: { '-w': '--workflow', '-b': '--branch', '-L': '--limit' } });
      let runs = bare.meta.runs;
      if (o['--workflow']) runs = runs.filter(r => r.file === o['--workflow'] || r.workflow === o['--workflow']);
      if (o['--branch']) runs = runs.filter(r => r.branch === o['--branch']);
      if (!runs.length) { out.push('no runs found'); return 0; }
      out.push(C.dim(`${'STATUS'.padEnd(12)}${'WORKFLOW'.padEnd(16)}${'EVENT'.padEnd(19)}${'REF'.padEnd(16)}COMMIT   ID`));
      for (const r of runs.slice(0, Number(o['--limit']) || 10)) out.push(`${statusIcon(r)}  ${statusWord(r).padEnd(9)}${r.workflow.padEnd(16)}${r.event.padEnd(19)}${r.branch.padEnd(16)}${shortHash(r.hash)}  #${r.id}`);
      return 0;
    }
    if (sub === 'view' || sub === 'watch') {
      const r = findRun(rest);
      if (sub === 'watch' && r.status === 'completed') out.push(C.dim(`Run ${r.workflow} (#${r.id}) has already completed with '${r.conclusion}'`), '');
      out.push(`${statusIcon(r)} ${r.branch} ${r.workflow} · #${r.id}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ''}`, `Triggered via ${r.event} by ${r.actor || 'you'}`, '');
      out.push(C.bold('JOBS'));
      for (const j of r.jobs) {
        out.push(`${jobIcon(j)} ${j.id}${j.envName ? C.dim(` (environment: ${j.envName})`) : ''}${j.conclusion === 'skipped' ? C.dim(' skipped') : j.status === 'waiting' ? C.yellow(' waiting for approval') : j.status === 'queued' ? C.dim(' pending') : ''}`);
        for (const l of j.log) out.push('  ' + l);
      }
      if (r.status === 'waiting') out.push('', C.yellow('This run is waiting for a deployment review.'), C.dim('Approve or reject it under "Review deployments" on the run page (the GitHub tab on the right).'));
      else if (r.conclusion === 'failure') out.push('', C.dim(`To re-run the failed jobs: gh run rerun ${r.id} --failed`));
      return r.conclusion === 'failure' && sub === 'watch' && rest.includes('--exit-status') ? 1 : 0;
    }
    if (sub === 'rerun') {
      const r = findRun(rest);
      if (r.status !== 'completed') throw new GitError(`run ${r.id} cannot be rerun; it is still ${r.status}`, 1);
      try { rerun(w, bare, r, { failedOnly: rest.includes('--failed') }); } catch (e) { throw new GitError(e.message, 1); }
      out.push(`${C.green('✓')} Requested rerun${rest.includes('--failed') ? ' (failed jobs)' : ''} of run ${r.id}`);
      out.push(r.status === 'waiting' ? C.yellow(`  → run #${r.id} is waiting for a deployment review`) : `  → run #${r.id} ${r.conclusion === 'success' ? C.green('succeeded') : C.red('failed')}`);
      return 0;
    }
  }

  if (group === 'workflow') {
    const { bare } = contextRepo(ctx, { upstreamFirst: false });
    const def = bare.meta.defaultBranch || 'main';
    const listAt = (hash) => { const flat = w.readTreeFlat(w.commit(hash).tree); return [...flat.keys()].filter(p => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).map(p => ({ path: p, file: p.split('/').pop(), wf: parseWorkflow(w.objects.get(flat.get(p)).content) })); };
    const defHead = bare.refs['refs/heads/' + def];
    if (sub === 'list' || sub === 'ls') {
      const list = defHead ? listAt(defHead) : [];
      if (!list.length) { out.push('no workflows found'); return 0; }
      for (const x of list) out.push(`${(x.wf.name || x.file).padEnd(18)} active  ${x.file}`);
      return 0;
    }
    if (sub === 'run') {
      const o = ghOpts(rest, { val: ['--ref', '-r', '-f', '--field', '-F', '--raw-field'], alias: { '-r': '--ref', '--field': '-f', '-F': '-f', '--raw-field': '-f' } });
      const name = o._[0];
      if (!name) throw new GitError('workflow name, ID, or filename required', 1);
      const ref = o['--ref'] || def;
      const isTag = !!bare.refs['refs/tags/' + ref] && !bare.refs['refs/heads/' + ref];
      const raw = isTag ? bare.refs['refs/tags/' + ref] : bare.refs['refs/heads/' + ref];
      if (!raw) throw new GitError(`could not create workflow dispatch event: HTTP 422: No ref found for: ${ref}`, 1);
      const hash = w.peel(raw);
      const x = listAt(hash).find(y => y.file === name || y.wf.name === name);
      if (!x) throw new GitError(`could not find any workflows named ${name}`, 1);
      if (!('workflow_dispatch' in x.wf.triggers)) throw new GitError(`could not create workflow dispatch event: HTTP 422: Workflow does not have 'workflow_dispatch' trigger`, 1);
      const inputs = {};
      if (o['-f']) { const [k, ...v] = String(o['-f']).split('='); inputs[k] = v.join('='); }
      w.tick(2);
      const [r] = runWorkflows(w, bare, 'workflow_dispatch', ref, hash, null, { refType: isTag ? 'tag' : 'branch', only: x.path, inputs });
      out.push(`${C.green('✓')} Created workflow_dispatch event for ${x.file} at ${ref}`, '', `To see runs for this workflow, try: gh run list --workflow=${x.file}`);
      if (r) out.push(r.status === 'waiting' ? C.yellow(`  → run #${r.id} is waiting for a deployment review`) : `  → run #${r.id} ${r.conclusion === 'success' ? C.green('succeeded') : C.red('failed')}`);
      return 0;
    }
  }

  if (group === 'browse') {
    const { bare } = contextRepo(ctx, { upstreamFirst: false });
    out.push(`Opening https://github.com/${bare.meta.owner}/${bare.meta.name} in your browser.`, C.dim('(In Git Conquest, open the GitHub tab on the right to see the repository.)'));
    return 0;
  }

  throw new GitError(`unknown command "${[group, sub].filter(Boolean).join(' ')}" for "gh"\n\nRun 'gh --help' for usage.`, 1);
}

function statusIcon(r) {
  const k = runIcon(r);
  return k === 'success' ? C.green('✓') : k === 'failure' ? C.red('X') : k === 'waiting' ? C.yellow('◷') : C.yellow('*');
}
function statusWord(r) { const k = runIcon(r); return k === 'success' ? 'pass' : k === 'failure' ? 'fail' : k; }
function jobIcon(j) { return j.conclusion === 'success' ? C.green('✓') : j.conclusion === 'failure' ? C.red('X') : j.conclusion === 'skipped' ? C.dim('-') : j.status === 'waiting' ? C.yellow('◷') : C.dim('*'); }

export { approveDeployment, currentDeployment, ensureEnvironment };

function pl2(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }

export { ancestors };
