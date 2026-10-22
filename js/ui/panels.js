// Side panels for labs and the sandbox: the three areas, files, and the GitHub view.

import { h, clear } from './dom.js';
import { computeStatus, headCommit, worktree, branchNames, currentBranch, revList } from '../git/core.js';
import { shortHash, relativeTime, stripAnsi } from '../git/world.js';
import { prStatus, mergePR, checksFor, approveDeployment, currentDeployment } from '../git/github.js';
import { GraphView } from './graph.js';

export class AreasView {
  constructor() { this.el = h('div', { class: 'areas' }); }

  render(repo) {
    clear(this.el);
    if (!repo || repo.bare) { this.el.append(h('div', { class: 'graph-empty', style: { gridColumn: '1 / -1' } }, 'Not inside a git repository yet.')); return; }
    const w = repo.world;
    const st = computeStatus(repo);
    const staged = new Map(st.staged.map(s => [s.path, s]));
    const unstaged = new Map(st.unstaged.map(s => [s.path, s]));
    const conflicts = new Set(st.conflicts.map(c => c.path));
    const untracked = new Set(st.untracked);
    const ignored = new Set(st.ignored);

    const wdItems = [];
    for (const p of [...st.wt.keys()].sort()) {
      let cls = 's-clean', note = '';
      if (conflicts.has(p)) { cls = 's-conflict'; note = 'conflict'; }
      else if (untracked.has(p)) { cls = 's-untracked'; note = 'untracked'; }
      else if (ignored.has(p)) { cls = 's-ignored'; note = 'ignored'; }
      else if (unstaged.has(p)) { cls = 's-modified'; note = 'modified'; }
      wdItems.push(h('li', { class: cls, title: `${p}${note ? ' — ' + note : ''}` }, p + (note ? `  · ${note}` : '')));
    }
    for (const [p, s] of unstaged) if (s.kind === 'deleted') wdItems.push(h('li', { class: 's-deleted', title: `${p} — deleted, not staged` }, `${p}  · deleted`));

    const idxItems = [];
    for (const [p] of [...repo.index].sort()) {
      const s = staged.get(p);
      idxItems.push(h('li', { class: s ? 's-staged' : 's-clean', title: s ? `${p} — staged (${s.kind})` : `${p} — same as last commit` }, p + (s ? `  · ${s.kind === 'new file' ? 'new' : s.kind}` : '')));
    }
    for (const s of st.staged) if (s.kind === 'deleted') idxItems.push(h('li', { class: 's-deleted s-staged', title: `${s.path} — deletion staged` }, `${s.path}  · deleted`));
    for (const p of conflicts) idxItems.push(h('li', { class: 's-conflict', title: `${p} — unmerged` }, `${p}  · unmerged`));

    const head = headCommit(repo);
    const repoItems = [];
    if (head) {
      const c = w.commit(head);
      for (const [p] of [...w.readTreeFlat(c.tree)].sort()) repoItems.push(h('li', { class: 's-clean', title: p }, p));
    }
    const col = (title, sub, items, empty) => h('section', { class: 'area' },
      h('h4', {}, title, h('small', {}, sub)),
      items.length ? h('ul', {}, items) : h('div', { class: 'empty' }, empty));
    this.el.append(
      col('Working directory', `${st.wt.size} file${st.wt.size === 1 ? '' : 's'}`, wdItems, 'Empty folder'),
      col('Staging area', `${staged.size} staged`, idxItems, 'Nothing in the index yet'),
      col('Repository', head ? `HEAD ${shortHash(head)}` : 'no commits', repoItems, head ? 'Last commit is empty' : 'No commits yet'));
  }
}

export class FilesView {
  constructor() { this.el = h('div', { class: 'files' }); }

  render(repo, shell) {
    clear(this.el);
    const w = shell.world;
    let entries;
    if (repo && !repo.bare) entries = [...worktree(repo)].sort();
    else {
      const pre = shell.cwd === '/' ? '/' : shell.cwd + '/';
      entries = [...w.files].filter(([p]) => p.startsWith(pre)).map(([p, c]) => [p.slice(pre.length), c]).sort();
    }
    if (!entries.length) { this.el.append(h('div', { class: 'graph-empty' }, 'No files here yet. Create one with echo "text" > file.txt or touch file.txt')); return; }
    for (const [p, content] of entries.slice(0, 40)) {
      const pre = h('pre');
      let state = 'ours';
      for (const line of content.split('\n')) {
        if (/^<<<<<<< /.test(line)) { pre.append(h('span', { class: 'conf-mark' }, line)); state = 'ours'; continue; }
        if (/^=======$/.test(line)) { pre.append(h('span', { class: 'conf-mark' }, line)); state = 'theirs'; continue; }
        if (/^>>>>>>> /.test(line)) { pre.append(h('span', { class: 'conf-mark' }, line)); state = null; continue; }
        const inConflict = pre.querySelector('.conf-mark') && state;
        if (inConflict) pre.append(h('span', { class: state === 'ours' ? 'conf-ours' : 'conf-theirs' }, line));
        else pre.append(line + '\n');
      }
      if (!content) pre.append(h('span', { style: { color: 'var(--muted)' } }, '(empty file)'));
      this.el.append(h('article', { class: 'file-card' }, h('header', {}, h('span', {}, p), h('span', { style: { color: 'var(--muted)' } }, `${content.split('\n').filter(Boolean).length} lines`)), pre));
    }
  }
}

export class GitHubView {
  constructor({ onAction } = {}) {
    this.el = h('div', { class: 'gh' });
    this.selected = null;
    this.graph = new GraphView({ showOrphans: false, emptyText: 'This repository is empty.' });
    this.onAction = onAction;
  }

  render(repo, shell) {
    clear(this.el);
    const w = shell.world;
    const remotes = [...w.remotes.values()];
    if (!remotes.length) {
      this.el.append(h('div', { class: 'gh-empty' }, 'No GitHub repositories exist in this world yet. Create one with ', h('code', {}, 'gh repo create'), '.'));
      return;
    }
    // prefer the repo origin points at
    if (!this.selected || !w.remotes.has(this.selected)) {
      const originUrl = repo?.config['remote.origin.url'];
      const o = originUrl && w.remoteByUrl(originUrl);
      this.selected = o ? o.meta.url : remotes[0].meta.url;
    }
    const bare = w.remotes.get(this.selected);
    const meta = bare.meta;
    const select = h('select', { class: 'gh-select', 'aria-label': 'Choose a GitHub repository', id: 'gh-repo-select', onchange: e => { this.selected = e.target.value; this.render(repo, shell); } },
      remotes.map(r => h('option', { value: r.meta.url, selected: r.meta.url === this.selected }, `${r.meta.owner}/${r.meta.name}`)));
    this.el.append(h('div', { class: 'gh-repo' },
      h('span', { class: 'name' }, `${meta.owner} / ${meta.name}`),
      h('span', { class: 'vis' }, meta.visibility),
      meta.forkOf ? h('span', { class: 'pill' }, 'fork of ' + meta.forkOf.replace('https://github.com/', '').replace(/\.git$/, '')) : null,
      remotes.length > 1 ? select : null));
    if (meta.description) this.el.append(h('p', { style: { margin: 0, color: 'var(--text-2)' } }, meta.description));

    // branches
    const branches = Object.keys(bare.refs).filter(r => r.startsWith('refs/heads/')).map(r => r.slice(11));
    const def = bare.HEAD.replace('ref: refs/heads/', '');
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `Branches (${branches.length})`),
      branches.length ? h('ul', { class: 'gh-list' }, branches.map(b => {
        const hh = bare.refs['refs/heads/' + b];
        const c = w.commit(hh);
        const prot = meta.protected?.[b];
        return h('li', {}, h('div', { class: 'row' },
          h('span', {}, h('strong', {}, b), b === def ? h('span', { class: 'pill', style: { marginLeft: '8px' } }, 'default') : null, prot ? h('span', { class: 'pill pill-warn', style: { marginLeft: '6px' } }, 'protected') : null),
          h('span', { class: 'meta mono' }, shortHash(hh))),
          h('span', { class: 'meta' }, `${c.message.split('\n')[0]} · ${c.author.name} · ${relativeTime(c.committer.time, w.time)}`));
      })) : h('div', { class: 'gh-empty' }, 'Empty repository. Push a branch to it: git push -u origin main')));

    // PRs
    const prs = meta.prs.slice().reverse();
    this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `Pull requests (${prs.filter(p => p.state === 'open').length} open)`),
      prs.length ? h('ul', { class: 'gh-list' }, prs.map(pr => this.prItem(w, bare, pr, repo, shell))) : h('div', { class: 'gh-empty' }, 'No pull requests yet.')));

    // issues
    if (meta.issues.length) {
      this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, `Issues (${meta.issues.filter(i => i.state === 'open').length} open)`),
        h('ul', { class: 'gh-list' }, meta.issues.slice().reverse().map(i => h('li', {}, h('div', { class: 'row' },
          h('span', {}, h('strong', {}, `#${i.number} `), i.title),
          h('span', { class: 'pill ' + (i.state === 'open' ? 'pill-ok' : '') }, i.state === 'open' ? 'Open' : i.closedBy ? `Closed by #${i.closedBy}` : 'Closed')),
          i.labels.length ? h('span', { class: 'meta' }, i.labels.join(', ')) : null)))));
    }
    // environments
    const envs = Object.values(meta.environments || {});
    if (envs.length) {
      this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Environments'),
        h('ul', { class: 'gh-list' }, envs.map(e => {
          const d = currentDeployment(bare, e.name);
          return h('li', {}, h('div', { class: 'row' },
            h('span', {}, h('strong', {}, e.name), e.reviewers?.length ? h('span', { class: 'pill pill-warn', style: { marginLeft: '6px' } }, 'requires approval') : null),
            h('span', { class: 'meta mono' }, d ? d.version : 'nothing deployed')),
            h('span', { class: 'meta' }, [e.url || 'no URL', d ? ` · deployed ${relativeTime(d.time, w.time)}${d.by ? ' by ' + d.by : ''}` : ''].join('')));
        }))));
    }
    // actions
    if (meta.runs.length) {
      const icon = r => r.status === 'waiting' ? ['◷ ', 'var(--warn)'] : r.conclusion === 'success' ? ['✓ ', 'var(--ok)'] : ['✗ ', 'var(--bad)'];
      this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Actions'),
        h('ul', { class: 'gh-list' }, meta.runs.slice(0, 6).map(r => {
          const [ic, col] = icon(r);
          const waiting = r.jobs.filter(j => j.status === 'waiting');
          return h('li', {},
            h('div', { class: 'row' }, h('span', {}, h('strong', { style: { color: col } }, ic), `${r.workflow} · ${r.event} #${r.id}`), h('span', { class: 'meta mono' }, `${r.branch} ${shortHash(r.hash)}`)),
            h('span', { class: 'meta' }, r.jobs.map(j => `${j.conclusion === 'success' ? '✓' : j.conclusion === 'failure' ? '✗' : j.conclusion === 'skipped' ? '–' : j.status === 'waiting' ? '◷' : '·'} ${j.id}`).join('  ')),
            r.conclusion === 'failure' ? h('span', { class: 'meta' }, r.jobs.flatMap(j => j.log).filter(l => /FAIL|error|✕|Invalid|not set|rejected|not allowed/i.test(l)).slice(0, 2).join(' · ')) : null,
            waiting.length ? h('div', { class: 'gh-review' },
              h('span', {}, `Review deployments: ${waiting.map(j => j.envName).join(', ')} is waiting for approval`),
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => this.review(w, bare, r, true) }, 'Approve and deploy'),
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => this.review(w, bare, r, false) }, 'Reject'))) : null);
        }))));
    }
    if (meta.releases.length) {
      this.el.append(h('section', { class: 'gh-section' }, h('h5', {}, 'Releases'),
        h('ul', { class: 'gh-list' }, meta.releases.map((r, i) => h('li', {}, h('div', { class: 'row' }, h('strong', {}, r.title), i === 0 ? h('span', { class: 'pill pill-ok' }, 'Latest') : null), h('span', { class: 'meta mono' }, r.tag))))));
    }
    // remote graph
    const gs = h('section', { class: 'gh-section' }, h('h5', {}, 'Commits on GitHub'));
    this.graph.render(bare);
    gs.append(this.graph.el);
    this.el.append(gs);
  }

  review(w, bare, run, approve) {
    try {
      approveDeployment(w, bare, run.id, { by: w.github.user, approve });
      const envs = run.jobs.filter(j => j.envName).map(j => j.envName).join(', ');
      this.onAction?.(approve ? `Approved deployment to ${envs} (run #${run.id} → ${run.status === 'waiting' ? 'waiting' : run.conclusion})` : `Rejected deployment to ${envs} (run #${run.id})`, !approve || run.conclusion === 'failure');
    } catch (e) { this.onAction?.(e.message, true); }
  }

  prItem(w, bare, pr, repo, shell) {
    const st = pr.state === 'open' ? prStatus(w, bare, pr) : null;
    const pill = pr.state === 'merged' ? h('span', { class: 'pill', style: { color: 'var(--remote)' } }, 'Merged')
      : pr.state === 'closed' ? h('span', { class: 'pill pill-bad' }, 'Closed')
        : st.conflicts.length ? h('span', { class: 'pill pill-bad' }, 'Conflicts')
          : st.blockers.length ? h('span', { class: 'pill pill-warn' }, 'Blocked')
            : h('span', { class: 'pill pill-ok' }, 'Ready to merge');
    const li = h('li', {},
      h('div', { class: 'row' }, h('span', {}, h('strong', {}, `#${pr.number} `), pr.title), pill),
      h('span', { class: 'meta' }, `${pr.headOwner === bare.meta.owner ? pr.head : pr.headOwner + ':' + pr.head} → ${pr.base} · by ${pr.author}${pr.reviews.length ? ' · ' + pr.reviews.map(r => `${r.author}: ${r.state.toLowerCase().replace('_', ' ')}`).join(', ') : ''}`));
    if (st) {
      const checks = checksFor(bare, st.head);
      if (checks.length) li.append(h('span', { class: 'meta' }, checks.map(c => `${c.conclusion === 'success' ? '✓' : '✗'} ${c.workflow}`).join('  ')));
      if (st.blockers.length) li.append(h('span', { class: 'meta', style: { color: 'var(--warn)' } }, st.blockers.join(' · ')));
      {
        const methodSel = h('select', { class: 'gh-select', 'aria-label': 'Merge method', id: `merge-method-${pr.number}` },
          h('option', { value: 'merge' }, 'Create a merge commit'), h('option', { value: 'squash' }, 'Squash and merge'), h('option', { value: 'rebase' }, 'Rebase and merge'));
        const btn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: !!st.blockers.length, onclick: () => {
          try {
            mergePR(w, bare, pr, methodSel.value);
            this.onAction?.(`Merged pull request #${pr.number} on GitHub (${methodSel.value})`);
          } catch (e) { this.onAction?.(stripAnsi(e.message), true); }
          this.render(repo, shell);
        } }, 'Merge pull request');
        li.append(h('div', { class: 'row', style: { justifyContent: 'flex-start' } }, methodSel, btn));
      }
    }
    return li;
  }
}

export { branchNames, currentBranch, revList };
