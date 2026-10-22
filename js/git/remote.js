// remote, fetch, push, pull, clone, ls-remote

import { GitError, C, shortHash, normPath, basename } from './world.js';
import {
  headRef, currentBranch, headCommit, updateRef, setHeadCommit, switchHead, upstreamOf, resolve, resolveCommit,
  isAncestor, revList, commitTreeFlat, checkoutTree, computeStatus, mergeBase, mergeTrees,
} from './core.js';
import { runWorkflows, protectionFor } from './github.js';

export function accessRemote(ctx, url, { write = false } = {}) {
  const w = ctx.world;
  const canon = w.canonicalUrl(url);
  if (!canon) throw new GitError(`fatal: '${url}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  if (canon.ssh && !w.github.sshKeys.length) {
    throw new GitError(`git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  }
  const bare = w.remotes.get(canon.url);
  if (!bare || (bare.meta.visibility === 'private' && bare.meta.owner !== w.github.user && !bare.meta.collaborators.includes(w.github.user))) {
    throw new GitError(`remote: Repository not found.\nfatal: repository '${canon.url.replace(/\.git$/, '')}.git/' not found`);
  }
  if (write) {
    if (!canon.ssh && !w.github.authed) {
      throw new GitError(`remote: Support for password authentication was removed on August 13, 2021.\nremote: Please see https://docs.github.com/get-started/getting-started-with-git/about-remote-repositories#cloning-with-https-urls for information on currently recommended modes of authentication.\nfatal: Authentication failed for '${canon.url.replace(/\.git$/, '')}/'`);
    }
    if (bare.meta.owner !== w.github.user && !bare.meta.collaborators.includes(w.github.user)) {
      throw new GitError(`remote: Permission to ${bare.meta.owner}/${bare.meta.name}.git denied to ${w.github.user}.\nfatal: unable to access '${canon.url.replace(/\.git$/, '')}.git/': The requested URL returned error: 403`);
    }
  }
  return { bare, canon };
}

function displayUrl(url) {
  return url;
}

export function remoteCommands({ parseOpts, needRepo, needWorkTree, mergeInto, commands, statLines, treePairs }) {
  const cmds = {};

  const remoteNames = (repo) => [...new Set(Object.keys(repo.config).filter(k => /^remote\.[^.]+\.url$/.test(k)).map(k => k.split('.')[1]))];

  cmds.remote = (ctx, args) => {
    const repo = needRepo(ctx);
    const sub = args[0] && !args[0].startsWith('-') ? args[0] : null;
    const o = parseOpts(sub ? args.slice(1) : args, { bool: ['-v', '--verbose', '-f'], val: ['-t'] });
    const names = remoteNames(repo);
    if (!sub) {
      for (const n of names) {
        if (o['-v'] || o['--verbose']) {
          ctx.out.push(`${n}\t${repo.config[`remote.${n}.url`]} (fetch)`);
          ctx.out.push(`${n}\t${repo.config[`remote.${n}.pushurl`] || repo.config[`remote.${n}.url`]} (push)`);
        } else ctx.out.push(n);
      }
      return 0;
    }
    if (sub === 'add') {
      const [name, url] = o._;
      if (!name || !url) throw new GitError('usage: git remote add [<options>] <name> <url>', 129);
      if (names.includes(name)) throw new GitError(`error: remote ${name} already exists.`, 3);
      repo.config[`remote.${name}.url`] = url;
      repo.config[`remote.${name}.fetch`] = `+refs/heads/*:refs/remotes/${name}/*`;
      ctx.world.emit({ type: 'remote-add', name, url });
      if (o['-f']) return cmds.fetch(ctx, [name]);
      return 0;
    }
    if (sub === 'remove' || sub === 'rm') {
      const name = o._[0];
      if (!names.includes(name)) throw new GitError(`error: No such remote: '${name}'`, 2);
      for (const k of Object.keys(repo.config)) if (k.startsWith(`remote.${name}.`)) delete repo.config[k];
      for (const r of Object.keys(repo.refs)) if (r.startsWith(`refs/remotes/${name}/`)) delete repo.refs[r];
      for (const k of Object.keys(repo.config)) if (/^branch\..*\.remote$/.test(k) && repo.config[k] === name) { delete repo.config[k]; delete repo.config[k.replace(/remote$/, 'merge')]; }
      return 0;
    }
    if (sub === 'rename') {
      const [from, to] = o._;
      if (!names.includes(from)) throw new GitError(`error: No such remote: '${from}'`, 2);
      if (names.includes(to)) throw new GitError(`error: remote ${to} already exists.`, 3);
      for (const k of Object.keys(repo.config)) {
        if (k.startsWith(`remote.${from}.`)) { repo.config[k.replace(`remote.${from}.`, `remote.${to}.`)] = repo.config[k].replace(`refs/remotes/${from}/`, `refs/remotes/${to}/`); delete repo.config[k]; }
        else if (/^branch\..*\.remote$/.test(k) && repo.config[k] === from) repo.config[k] = to;
      }
      for (const r of Object.keys(repo.refs)) if (r.startsWith(`refs/remotes/${from}/`)) { repo.refs[r.replace(`refs/remotes/${from}/`, `refs/remotes/${to}/`)] = repo.refs[r]; delete repo.refs[r]; }
      ctx.world.emit({ type: 'remote-rename', from, to });
      return 0;
    }
    if (sub === 'set-url' || sub === 'get-url') {
      const [name, url] = o._;
      if (!names.includes(name)) throw new GitError(`error: No such remote '${name}'`, 2);
      if (sub === 'get-url') { ctx.out.push(repo.config[`remote.${name}.url`]); return 0; }
      repo.config[`remote.${name}.url`] = url;
      ctx.world.emit({ type: 'remote-set-url', name, url });
      return 0;
    }
    if (sub === 'show') {
      const name = o._[0] || 'origin';
      if (!names.includes(name)) throw new GitError(`fatal: '${name}' does not appear to be a git repository`);
      const url = repo.config[`remote.${name}.url`];
      ctx.out.push(`* remote ${name}`, `  Fetch URL: ${url}`, `  Push  URL: ${url}`);
      try {
        const { bare } = accessRemote(ctx, url);
        ctx.out.push(`  HEAD branch: ${bare.HEAD.replace('ref: refs/heads/', '')}`, '  Remote branches:');
        for (const r of Object.keys(bare.refs).filter(x => x.startsWith('refs/heads/'))) {
          const b = r.slice(11);
          ctx.out.push(`    ${b.padEnd(16)} ${repo.refs[`refs/remotes/${name}/${b}`] ? 'tracked' : 'new (next fetch will store in remotes/' + name + ')'}`);
        }
        for (const r of Object.keys(repo.refs).filter(x => x.startsWith(`refs/remotes/${name}/`))) {
          const b = r.slice(`refs/remotes/${name}/`.length);
          if (b !== 'HEAD' && !bare.refs['refs/heads/' + b]) ctx.out.push(`    refs/remotes/${name}/${b} stale (use 'git remote prune' to remove)`);
        }
      } catch (e) { ctx.out.push(`  (could not reach ${url})`); }
      return 0;
    }
    if (sub === 'prune') return cmds.fetch(ctx, [o._[0] || 'origin', '--prune']);
    throw new GitError(`error: unknown subcommand: \`${sub}'`, 129);
  };

  function fetchOne(ctx, repo, name, { prune = false, quiet = false, tags = true } = {}) {
    const w = ctx.world;
    const url = repo.config[`remote.${name}.url`];
    if (!url) {
      throw new GitError(`fatal: '${name}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
    }
    const { bare } = accessRemote(ctx, url);
    const lines = [];
    const heads = Object.keys(bare.refs).filter(r => r.startsWith('refs/heads/')).sort();
    let newObjects = 0;
    for (const r of heads) {
      const b = r.slice(11);
      const local = `refs/remotes/${name}/${b}`;
      const old = repo.refs[local];
      const nu = bare.refs[r];
      if (old === nu) continue;
      newObjects += old ? revList(w, [nu], [old]).length : revList(w, [nu]).length;
      if (!old) lines.push(` * [new branch]      ${b.padEnd(10)} -> ${name}/${b}`);
      else if (isAncestor(w, old, nu)) lines.push(`   ${shortHash(old)}..${shortHash(nu)}  ${b.padEnd(10)} -> ${name}/${b}`);
      else lines.push(` + ${shortHash(old)}...${shortHash(nu)} ${b.padEnd(10)} -> ${name}/${b}  (forced update)`);
      repo.refs[local] = nu;
    }
    const defaultBranch = bare.HEAD.replace('ref: refs/heads/', '');
    if (bare.refs['refs/heads/' + defaultBranch]) repo.refs[`refs/remotes/${name}/HEAD`] = bare.refs['refs/heads/' + defaultBranch];
    if (tags) {
      for (const r of Object.keys(bare.refs).filter(x => x.startsWith('refs/tags/'))) {
        if (repo.refs[r]) continue;
        repo.refs[r] = bare.refs[r];
        lines.push(` * [new tag]         ${r.slice(10).padEnd(10)} -> ${r.slice(10)}`);
      }
    }
    if (prune) {
      for (const r of Object.keys(repo.refs).filter(x => x.startsWith(`refs/remotes/${name}/`))) {
        const b = r.slice(`refs/remotes/${name}/`.length);
        if (b === 'HEAD') continue;
        if (!bare.refs['refs/heads/' + b]) { delete repo.refs[r]; lines.push(` - [deleted]         (none)     -> ${name}/${b}`); }
      }
    }
    const cur = currentBranch(repo);
    const up = cur && upstreamOf(repo, cur);
    repo.fetchHead = up && up.remote === name ? repo.refs[up.ref] : bare.refs['refs/heads/' + defaultBranch];
    if (lines.length && !quiet) {
      if (newObjects) ctx.out.push(`remote: Enumerating objects: ${newObjects * 3}, done.`, `remote: Counting objects: 100% (${newObjects * 3}/${newObjects * 3}), done.`, `Unpacking objects: 100% (${newObjects * 3}/${newObjects * 3}), done.`);
      ctx.out.push(`From ${url.replace(/\.git$/, '')}`, ...lines);
    }
    w.emit({ type: 'fetch', remote: name });
    return lines.length;
  }

  cmds.fetch = (ctx, args) => {
    const repo = needRepo(ctx);
    const o = parseOpts(args, { bool: ['--all', '--prune', '-p', '-q', '--quiet', '--tags', '-v'], val: [] });
    const names = remoteNames(repo);
    if (!names.length) throw new GitError(`fatal: No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.`);
    const targets = o['--all'] ? names : [o._[0] || (currentBranch(repo) && upstreamOf(repo, currentBranch(repo))?.remote) || (names.includes('origin') ? 'origin' : names[0])];
    for (const t of targets) {
      if (o['--all']) ctx.out.push(`Fetching ${t}`);
      fetchOne(ctx, repo, t, { prune: o['--prune'] || o['-p'] || repo.config['fetch.prune'] === 'true' || ctx.world.globalConfig['fetch.prune'] === 'true', quiet: o['-q'] || o['--quiet'] });
    }
    return 0;
  };

  cmds['ls-remote'] = (ctx, args) => {
    const repo = ctx.repo;
    const target = args.find(a => !a.startsWith('-')) || 'origin';
    const url = repo && repo.config[`remote.${target}.url`] ? repo.config[`remote.${target}.url`] : target;
    const { bare } = accessRemote(ctx, url);
    const head = bare.refs[bare.HEAD.slice(5)];
    if (head) ctx.out.push(`${head}\tHEAD`);
    for (const [r, h] of Object.entries(bare.refs).sort()) ctx.out.push(`${h}\t${r}`);
    return 0;
  };

  cmds.push = (ctx, args) => {
    const repo = needRepo(ctx);
    const w = ctx.world;
    const o = parseOpts(args, {
      bool: ['-u', '--set-upstream', '-f', '--force', '--force-with-lease', '--tags', '-d', '--delete', '--all', '--dry-run', '-n', '-q', '--follow-tags', '--no-verify'],
      val: [], alias: { '--set-upstream': '-u', '--force': '-f', '--delete': '-d', '--dry-run': '-n' },
    });
    const names = remoteNames(repo);
    const cur = currentBranch(repo);
    const up = cur && upstreamOf(repo, cur);
    if (!names.length) {
      throw new GitError(`fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>\n`);
    }
    let remote = o._[0] || (up && up.remote) || (names.length === 1 ? names[0] : 'origin');
    if (!names.includes(remote)) {
      throw new GitError(`fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
    }
    let specs = o._.slice(1);
    const url = repo.config[`remote.${remote}.url`];
    if (!specs.length && !o['--tags'] && !o['--all']) {
      if (!cur) throw new GitError(`fatal: You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    git push ${remote} HEAD:<name-of-remote-branch>\n`);
      const autoSetup = repo.config['push.autoSetupRemote'] === 'true' || w.globalConfig['push.autosetupremote'] === 'true' || w.globalConfig['push.autoSetupRemote'] === 'true';
      if (!up && !o['-u'] && !autoSetup) {
        throw new GitError(`fatal: The current branch ${cur} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${remote} ${cur}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in 'git help config'.\n`);
      }
      if (!up && autoSetup) o['-u'] = true;
      specs = [up && !o._[0] ? `${cur}:${up.branch}` : cur];
    }
    if (o['--all']) specs = Object.keys(repo.refs).filter(r => r.startsWith('refs/heads/')).map(r => r.slice(11));
    const { bare } = accessRemote(ctx, url, { write: true });
    if (!headCommit(repo) && specs.some(s => s === cur)) {
      throw new GitError(`error: src refspec ${cur} does not match any\nerror: failed to push some refs to '${url}'`);
    }
    const results = [];
    let failed = false;
    let pushedCommits = 0;
    const newBranches = [];
    const toPush = [];
    for (let spec of specs) {
      let force = o['-f'];
      if (spec.startsWith('+')) { force = true; spec = spec.slice(1); }
      let [src, dst] = spec.includes(':') ? spec.split(':') : [spec, spec];
      if (src === 'HEAD') { src = cur || 'HEAD'; if (!spec.includes(':')) dst = cur; }
      if (o['-d'] || src === '') {
        const name = (dst || src).replace(/^refs\/heads\//, '');
        if (!bare.refs['refs/heads/' + name] && !bare.refs['refs/tags/' + name]) { results.push(` ! [remote rejected] ${name} (remote ref does not exist)`); failed = true; continue; }
        if (protectionFor(bare, name)) { results.push(` ! [remote rejected] ${name} (refusing to delete a protected branch)`); failed = true; continue; }
        const key = bare.refs['refs/heads/' + name] ? 'refs/heads/' + name : 'refs/tags/' + name;
        toPush.push(() => { delete bare.refs[key]; delete repo.refs[`refs/remotes/${remote}/${name}`]; });
        results.push(` - [deleted]         ${name}`);
        continue;
      }
      const isTag = !!repo.refs['refs/tags/' + src] && !repo.refs['refs/heads/' + src];
      const hash = isTag ? repo.refs['refs/tags/' + src] : resolve(repo, src, { quiet: true });
      if (!hash) { results.push(`error: src refspec ${src} does not match any`); failed = true; continue; }
      dst = dst.replace(/^refs\/heads\//, '');
      const remoteRef = isTag ? 'refs/tags/' + dst : 'refs/heads/' + dst;
      const old = bare.refs[remoteRef];
      if (old === hash) { results.push(null); continue; }
      const commitHash = w.peel(hash);
      if (!isTag) {
        const rule = protectionFor(bare, dst);
        if (rule && rule.requirePR) {
          results.push(`remote: error: GH006: Protected branch update failed for refs/heads/${dst}.`, `remote: error: Changes must be made through a pull request.`, ` ! [remote rejected] ${src} -> ${dst} (protected branch hook declined)`);
          failed = true; continue;
        }
        if (rule && old && !isAncestor(w, old, commitHash) && !rule.allowForce) {
          results.push(`remote: error: GH006: Protected branch update failed for refs/heads/${dst}.`, `remote: error: Cannot force-push to this branch`, ` ! [remote rejected] ${src} -> ${dst} (protected branch hook declined)`);
          failed = true; continue;
        }
      }
      if (old && !isTag && !isAncestor(w, old, commitHash)) {
        const lease = o['--force-with-lease'];
        if (lease) {
          const expected = repo.refs[`refs/remotes/${remote}/${dst}`];
          if (expected !== old) { results.push(` ! [rejected]        ${src} -> ${dst} (stale info)`); failed = true; continue; }
        } else if (!force) {
          const known = repo.refs[`refs/remotes/${remote}/${dst}`] === old || w.objects.has(old) && isAncestor(w, old, headCommit(repo) || commitHash);
          results.push(` ! [rejected]        ${src} -> ${dst} (${known ? 'non-fast-forward' : 'fetch first'})`);
          failed = known ? 'nonff' : 'fetch';
          continue;
        }
        results.push(` + ${shortHash(old)}...${shortHash(commitHash)} ${src} -> ${dst} (forced update)`);
      } else if (old && !isTag) {
        results.push(`   ${shortHash(old)}..${shortHash(commitHash)}  ${src} -> ${dst}`);
      } else {
        results.push(` * [new ${isTag ? 'tag' : 'branch'}]      ${src} -> ${dst}`);
        if (!isTag) newBranches.push(dst);
      }
      if (!isTag) pushedCommits += old ? revList(w, [commitHash], [old]).length : revList(w, [commitHash], Object.values(bare.refs).filter(Boolean).map(h => w.peel(h))).length;
      toPush.push(() => {
        bare.refs[remoteRef] = hash;
        if (!isTag) repo.refs[`refs/remotes/${remote}/${dst}`] = commitHash;
        if (!isTag && Object.keys(bare.refs).filter(r => r.startsWith('refs/heads/')).length === 1) bare.HEAD = 'ref: refs/heads/' + dst;
        if (o['-u'] && !isTag && repo.refs['refs/heads/' + src]) {
          repo.config[`branch.${src}.remote`] = remote;
          repo.config[`branch.${src}.merge`] = 'refs/heads/' + dst;
        }
        if (!isTag) {
          runWorkflows(w, bare, 'push', dst, commitHash);
          // pull_request workflows re-run when a PR's head branch is pushed
          for (const target of w.remotes.values()) {
            for (const pr of target.meta.prs || []) {
              if (pr.state === 'open' && pr.headRepo === bare.meta.url && pr.head === dst) runWorkflows(w, target, 'pull_request', dst, commitHash, pr.number);
            }
          }
        } else {
          runWorkflows(w, bare, 'push', dst, commitHash, null, { refType: 'tag' });
        }
        w.emit({ type: 'push', remote, url: bare.meta.url, branch: dst, hash: commitHash, tag: isTag });
      });
    }
    if (o['--tags'] || o['--follow-tags']) {
      for (const r of Object.keys(repo.refs).filter(x => x.startsWith('refs/tags/'))) {
        if (bare.refs[r] === repo.refs[r]) continue;
        const t = r.slice(10);
        if (o['--follow-tags'] && w.objects.get(repo.refs[r]).type !== 'tag') continue;
        results.push(` * [new tag]         ${t} -> ${t}`);
        toPush.push(() => { bare.refs[r] = repo.refs[r]; runWorkflows(w, bare, 'push', t, w.peel(repo.refs[r]), null, { refType: 'tag' }); w.emit({ type: 'push', tag: true, name: t, url: bare.meta.url }); });
      }
    }
    const shown = results.filter(Boolean);
    if (o['-n'] || o['--dry-run']) { ctx.out.push(`To ${displayUrl(url)}`, ...shown); return 0; }
    if (!shown.length) { ctx.out.push('Everything up-to-date'); return 0; }
    // pre-push hook
    if (repo.hooks['pre-push'] && !o['--no-verify'] && ctx.runHook) {
      const code = ctx.runHook(repo, 'pre-push', ctx);
      if (code !== 0) { ctx.out.push(`error: failed to push some refs to '${url}'`); return 1; }
    }
    const quiet = o['-q'] && !failed;
    if (pushedCommits && !quiet) ctx.out.push(`Enumerating objects: ${pushedCommits * 3}, done.`, `Counting objects: 100% (${pushedCommits * 3}/${pushedCommits * 3}), done.`, `Writing objects: 100% (${pushedCommits * 3}/${pushedCommits * 3}), done.`, `Total ${pushedCommits * 3} (delta 0), reused 0 (delta 0), pack-reused 0`);
    for (const fn of toPush) fn();
    for (const b of quiet ? [] : newBranches) {
      if (b === (bare.meta.defaultBranch || 'main')) continue;
      ctx.out.push('remote: ', `remote: Create a pull request for '${b}' on GitHub by visiting:`, `remote:      https://github.com/${bare.meta.owner}/${bare.meta.name}/pull/new/${b}`, 'remote: ');
    }
    if (!quiet) ctx.out.push(`To ${displayUrl(url)}`, ...shown.map(l => l.startsWith(' !') ? C.red(l) : l));
    if (o['-u']) for (const s of specs) { const b = s.split(':')[0].replace(/^\+/, '').replace(/^HEAD$/, cur); if (repo.refs['refs/heads/' + b] && !shown.some(l => l.includes('rejected') && l.includes(b))) ctx.out.push(`branch '${b}' set up to track '${remote}/${s.includes(':') ? s.split(':')[1] : b}'.`); }
    if (failed) {
      ctx.out.push(C.red(`error: failed to push some refs to '${url}'`));
      if (failed === 'fetch') ctx.out.push(C.yellow(`hint: Updates were rejected because the remote contains work that you do not`), C.yellow(`hint: have locally. This is usually caused by another repository pushing to`), C.yellow(`hint: the same ref. If you want to integrate the remote changes, use`), C.yellow(`hint: 'git pull' before pushing again.`), C.yellow(`hint: See the 'Note about fast-forwards' in 'git push --help' for details.`));
      if (failed === 'nonff') ctx.out.push(C.yellow(`hint: Updates were rejected because the tip of your current branch is behind`), C.yellow(`hint: its remote counterpart. If you want to integrate the remote changes,`), C.yellow(`hint: use 'git pull' before pushing again.`), C.yellow(`hint: See the 'Note about fast-forwards' in 'git push --help' for details.`));
      w.emit({ type: 'push-rejected' });
      return 1;
    }
    return 0;
  };

  cmds.pull = (ctx, args) => {
    const repo = needWorkTree(ctx);
    const w = ctx.world;
    const o = parseOpts(args, { bool: ['--rebase', '-r', '--no-rebase', '--ff-only', '--ff', '--no-ff', '-q', '--autostash'], val: [] });
    const cur = currentBranch(repo);
    let remote = o._[0], branch = o._[1];
    if (!remote) {
      const up = cur && upstreamOf(repo, cur);
      if (!up) {
        throw new GitError(`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=origin/<branch> ${cur || '<branch>'}\n`, 1);
      }
      remote = up.remote; branch = up.branch;
    }
    if (!branch) {
      const up = cur && upstreamOf(repo, cur);
      if (up && up.remote === remote) branch = up.branch;
      else throw new GitError(`You asked to pull from the remote '${remote}', but did not specify\na branch. Because this is not the default configured remote\nfor your current branch, you must specify a branch on the command line.`, 1);
    }
    fetchOne(ctx, repo, remote, {});
    const theirs = repo.refs[`refs/remotes/${remote}/${branch}`];
    if (!theirs) throw new GitError(`fatal: couldn't find remote ref ${branch}`);
    const ours = headCommit(repo);
    if (ours && isAncestor(w, theirs, ours)) { ctx.out.push('Already up to date.'); return 0; }
    const cfg = repo.config['pull.rebase'] ?? w.globalConfig['pull.rebase'];
    const ffOnlyCfg = (repo.config['pull.ff'] ?? w.globalConfig['pull.ff']) === 'only';
    const rebase = o['--rebase'] || o['-r'] || (!o['--no-rebase'] && cfg === 'true');
    const label = `${remote}/${branch}`;
    if (!ours || isAncestor(w, ours, theirs)) {
      if (rebase) return commands.rebase(ctx, [label]);
      return mergeInto(ctx, label, { label: `${remote}/${branch}` });
    }
    if (o['--ff-only'] || (ffOnlyCfg && !rebase && !o['--no-rebase'])) throw new GitError('fatal: Not possible to fast-forward, aborting.');
    if (rebase) {
      let stashed = false;
      if (o['--autostash']) {
        const st = computeStatus(repo);
        if (st.staged.length || st.unstaged.length) { commands.stash(ctx, ['push', '-m', 'autostash']); stashed = true; }
      }
      const code = commands.rebase(ctx, [label]);
      if (stashed && code === 0) commands.stash(ctx, ['pop']);
      return code;
    }
    if (cfg === undefined && !o['--no-rebase'] && !o['--no-ff'] && !o['--ff']) {
      throw new GitError(`hint: You have divergent branches and need to specify how to reconcile them.
hint: You can do so by running one of the following commands sometime before
hint: your next pull:
hint:
hint:   git config pull.rebase false  # merge
hint:   git config pull.rebase true   # rebase
hint:   git config pull.ff only       # fast-forward only
hint:
hint: You can replace "git config" with "git config --global" to set a default
hint: preference for all repositories. You can also pass --rebase, --no-rebase,
hint: or --ff-only on the command line to override the configured default per
hint: invocation.
fatal: Need to specify how to reconcile divergent branches.`);
    }
    const url = repo.config[`remote.${remote}.url`];
    return mergeInto(ctx, label, { label: `${remote}/${branch}`, message: `Merge branch '${branch}' of ${url.replace(/\.git$/, '')}${cur && cur !== branch ? ` into ${cur}` : ''}`, noFF: o['--no-ff'] });
  };

  cmds.clone = (ctx, args) => {
    const w = ctx.world;
    const o = parseOpts(args, { bool: ['-q', '--bare', '--depth=1', '--single-branch'], val: ['-b', '--branch', '-o', '--origin', '--depth'] });
    const url = o._[0];
    if (!url) throw new GitError('fatal: You must specify a repository to clone.', 129);
    const { bare, canon } = accessRemote(ctx, url);
    const dirName = o._[1] || basename(canon.url).replace(/\.git$/, '');
    const root = normPath(ctx.cwd + '/' + dirName);
    if (w.repos.has(root) || [...w.files.keys()].some(f => f.startsWith(root + '/'))) {
      throw new GitError(`fatal: destination path '${dirName}' already exists and is not an empty directory.`);
    }
    ctx.out.push(`Cloning into '${dirName}'...`);
    const repo = w.createRepo(root);
    const remoteName = o['-o'] || o['--origin'] || 'origin';
    repo.config[`remote.${remoteName}.url`] = url;
    repo.config[`remote.${remoteName}.fetch`] = `+refs/heads/*:refs/remotes/${remoteName}/*`;
    const heads = Object.keys(bare.refs).filter(r => r.startsWith('refs/heads/'));
    if (!heads.length) {
      ctx.out.push('warning: You appear to have cloned an empty repository.');
      repo.HEAD = 'ref: refs/heads/main';
      w.emit({ type: 'clone', root, url: canon.url });
      return 0;
    }
    const n = revList(w, heads.map(h => bare.refs[h])).length * 3;
    ctx.out.push(`remote: Enumerating objects: ${n}, done.`, `remote: Counting objects: 100% (${n}/${n}), done.`, `remote: Total ${n} (delta 0), reused ${n} (delta 0), pack-reused 0`, `Receiving objects: 100% (${n}/${n}), done.`);
    for (const r of heads) repo.refs[`refs/remotes/${remoteName}/${r.slice(11)}`] = bare.refs[r];
    for (const r of Object.keys(bare.refs).filter(x => x.startsWith('refs/tags/'))) repo.refs[r] = bare.refs[r];
    const def = o['-b'] || o['--branch'] || bare.HEAD.replace('ref: refs/heads/', '');
    repo.refs[`refs/remotes/${remoteName}/HEAD`] = bare.refs['refs/heads/' + bare.HEAD.replace('ref: refs/heads/', '')];
    const start = bare.refs['refs/heads/' + def];
    if (!start) throw new GitError(`fatal: Remote branch ${def} not found in upstream ${remoteName}`);
    repo.HEAD = 'ref: refs/heads/' + def;
    updateRef(repo, 'refs/heads/' + def, start, `clone: from ${url}`);
    repo.config[`branch.${def}.remote`] = remoteName;
    repo.config[`branch.${def}.merge`] = 'refs/heads/' + def;
    checkoutTree(repo, commitTreeFlat(repo, start), { from: new Map(), force: true });
    w.emit({ type: 'clone', root, url: canon.url });
    return 0;
  };

  return cmds;
}

export { mergeBase, mergeTrees, switchHead, setHeadCommit, headRef, resolveCommit };
