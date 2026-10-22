// Field Guide: searchable cheat sheet, undo map and glossary.

import { h, clear } from '../ui/dom.js';
import { renderInline } from '../ui/markdown.js';
import { renderDiagram } from '../ui/diagrams.js';

const SHEET = [
  ['Set up', [
    ['git config --global user.name "Ada Lovelace"', 'Set the name stamped on your commits.'],
    ['git config --global user.email "ada@example.com"', 'Set the email stamped on your commits (use the one on your GitHub account).'],
    ['git config --global init.defaultBranch main', 'Name the first branch of new repositories `main`.'],
    ['git config --global core.editor "code --wait"', 'Choose the editor git opens for messages.'],
    ['git config --global pull.rebase true', 'Make `git pull` rebase instead of merge when branches diverge.'],
    ['git config --list --show-origin', 'Show every setting and the file it comes from.'],
    ['git config --global alias.lg "log --oneline --graph --all"', 'Create a shortcut: `git lg`.'],
  ]],
  ['Start a repository', [
    ['git init', 'Turn the current folder into a repository (creates `.git`).'],
    ['git clone <url> [folder]', 'Copy a remote repository, with its full history, to your machine.'],
    ['gh repo create <name> --public --source=. --push', 'Create a GitHub repository from the current project and push it.'],
  ]],
  ['Stage and commit', [
    ['git status', 'What changed, what is staged, what is untracked. Run it constantly.'],
    ['git status -sb', 'The same, in two columns: staged (left) and unstaged (right).'],
    ['git add <file>', 'Stage a file: copy its current content into the next commit.'],
    ['git add .', 'Stage every change in this folder and below.'],
    ['git add -p', 'Stage individual hunks interactively (real git).'],
    ['git commit -m "Message"', 'Record the staged snapshot with a message.'],
    ['git commit -am "Message"', 'Stage every tracked, modified file and commit. Does not add new files.'],
    ['git commit --amend', 'Replace the last commit (new message and/or newly staged changes). Only before pushing.'],
    ['git rm <file>', 'Delete a file and stage the deletion.'],
    ['git rm --cached <file>', 'Stop tracking a file but keep it on disk.'],
    ['git mv <old> <new>', 'Rename a file and stage the rename.'],
  ]],
  ['Inspect', [
    ['git diff', 'Changes in the working directory that are not staged yet.'],
    ['git diff --staged', 'Changes that are staged and will go into the next commit.'],
    ['git diff main..feature', 'What differs between two branches.'],
    ['git log --oneline --graph --all', 'Every branch as a compact graph.'],
    ['git log -p <file>', 'The full history of one file, with diffs.'],
    ['git log --author="Ada" --since="2 weeks ago"', 'Filter history by person or time.'],
    ['git log -S "function_name"', 'Find commits that added or removed a piece of text.'],
    ['git show <commit>', 'One commit: metadata plus its diff.'],
    ['git show <commit>:<path>', 'A file exactly as it was in that commit.'],
    ['git blame <file>', 'Who last changed each line, and in which commit.'],
    ['git shortlog -sn', 'Commit counts per author.'],
  ]],
  ['Branch', [
    ['git branch', 'List local branches; `*` marks the current one.'],
    ['git branch -vv', 'Branches with their last commit and upstream (ahead/behind).'],
    ['git switch <branch>', 'Move to another branch.'],
    ['git switch -c <branch>', 'Create a branch here and switch to it.'],
    ['git switch -', 'Go back to the previous branch.'],
    ['git branch -m <new-name>', 'Rename the current branch.'],
    ['git branch -d <branch>', 'Delete a branch that is fully merged.'],
    ['git branch -D <branch>', 'Force-delete a branch, merged or not.'],
    ['git branch --merged', 'Branches already merged into the current one (safe to delete).'],
  ]],
  ['Merge, rebase, pick', [
    ['git merge <branch>', 'Bring another branch\'s work into the current branch.'],
    ['git merge --no-ff <branch>', 'Always create a merge commit, even if a fast-forward is possible.'],
    ['git merge --abort', 'Give up on a conflicted merge and return to before it.'],
    ['git rebase main', 'Replay your branch\'s commits on top of main.'],
    ['git rebase -i HEAD~3', 'Edit the last three commits: reorder, squash, reword, drop.'],
    ['git rebase --continue | --abort | --skip', 'Drive a rebase that stopped for a conflict.'],
    ['git cherry-pick <commit>', 'Copy one commit onto the current branch.'],
    ['git checkout --ours <file> / --theirs <file>', 'During a conflict, take one side\'s version of a file.'],
  ]],
  ['Undo', [
    ['git restore <file>', 'Throw away unstaged edits to a file.'],
    ['git restore --staged <file>', 'Unstage a file but keep the edit.'],
    ['git restore --source=HEAD~2 <file>', 'Bring back a file as it was two commits ago.'],
    ['git reset --soft HEAD~1', 'Undo the last commit, keep its changes staged.'],
    ['git reset HEAD~1', 'Undo the last commit, keep its changes unstaged (mixed).'],
    ['git reset --hard HEAD~1', 'Undo the last commit and delete its changes. Dangerous.'],
    ['git revert <commit>', 'Add a new commit that undoes an old one. Safe on shared branches.'],
    ['git reflog', 'Everywhere HEAD has been. Your safety net for "lost" commits.'],
    ['git clean -n / git clean -fd', 'Preview / delete untracked files and folders.'],
  ]],
  ['Stash', [
    ['git stash', 'Shelve uncommitted changes and clean the working directory.'],
    ['git stash -u -m "note"', 'Stash including untracked files, with a description.'],
    ['git stash list', 'Show all stashes.'],
    ['git stash pop', 'Reapply the newest stash and remove it from the list.'],
    ['git stash apply stash@{1}', 'Reapply a specific stash and keep it in the list.'],
  ]],
  ['Remotes', [
    ['git remote -v', 'List remotes and their URLs.'],
    ['git remote add origin <url>', 'Connect a local repository to a remote.'],
    ['git fetch', 'Download new commits; updates `origin/*` but not your branches.'],
    ['git pull', 'Fetch, then merge (or rebase) the upstream into the current branch.'],
    ['git pull --rebase', 'Fetch, then replay your local commits on top.'],
    ['git push', 'Upload your commits to the branch\'s upstream.'],
    ['git push -u origin <branch>', 'Push a new branch and remember it as the upstream.'],
    ['git push --force-with-lease', 'Overwrite the remote branch only if nobody else pushed since you fetched.'],
    ['git push origin --delete <branch>', 'Delete a branch on the remote.'],
    ['git fetch --prune', 'Fetch and remove remote-tracking branches deleted on the server.'],
  ]],
  ['Tags and releases', [
    ['git tag', 'List tags.'],
    ['git tag -a v1.2.0 -m "Release 1.2.0"', 'Create an annotated tag at HEAD.'],
    ['git push origin --tags', 'Publish your tags.'],
    ['gh release create v1.2.0 --generate-notes', 'Publish a GitHub release with notes generated from merged PRs.'],
  ]],
  ['GitHub CLI', [
    ['gh auth login', 'Sign in to GitHub from the terminal.'],
    ['gh repo fork owner/repo --clone', 'Fork a repository to your account and clone your fork.'],
    ['gh issue create --title "…" --body "…"', 'Open an issue.'],
    ['gh pr create --fill', 'Open a pull request for the current branch.'],
    ['gh pr checkout 42', 'Check out pull request #42 locally to test it.'],
    ['gh pr review 42 --approve', 'Approve a pull request (not your own).'],
    ['gh pr merge 42 --squash --delete-branch', 'Merge a pull request and clean up its branch.'],
    ['gh run list / gh run view', 'See GitHub Actions runs and their logs.'],
  ]],
  ['Delivery & deploys', [
    ['gh secret set DEPLOY_TOKEN --body "…"', 'Store a credential that workflows read as ${{ secrets.DEPLOY_TOKEN }}.'],
    ['gh run rerun <id> --failed', 'Re-run only the failed jobs of a run (for example after adding a missing secret).'],
    ['gh workflow run release.yml --ref v1.1.0', 'Start a workflow by hand on any branch or tag. Needs a workflow_dispatch trigger. This is how a rollback redeploys an old tag.'],
    ['gh workflow list', 'List the workflows in the repository.'],
    ['git tag -a v1.2.0 -m "…" && git push origin v1.2.0', 'Cut a release: pushing a v* tag starts a tag-triggered release workflow.'],
    ['curl -i https://app.example/', 'See what users see, status line first. Add -f in pipelines so 4xx/5xx fails the job.'],
    ['curl https://app.example/health', 'Ask a deployed app which version and commit it runs.'],
  ]],
  ['Power tools', [
    ['git bisect start; git bisect bad; git bisect good <commit>', 'Binary-search history for the commit that introduced a bug.'],
    ['git bisect run npm test', 'Let a test script drive the bisect automatically.'],
    ['git cat-file -p <object>', 'Print any object: commit, tree, blob or tag.'],
    ['git hash-object <file>', 'Compute the id git would give a file\'s content.'],
    ['git worktree add ../hotfix main', 'A second working folder for another branch, sharing one repository (real git).'],
    ['git submodule add <url> libs/x', 'Embed another repository at a fixed commit (real git).'],
  ]],
];

const GLOSSARY = [
  ['Repository (repo)', 'A project plus its entire history, stored in the hidden `.git` folder.'],
  ['Working directory', 'The files you see and edit. Also called the working tree.'],
  ['Staging area', 'The draft of your next commit. Also called the index.'],
  ['Commit', 'A saved snapshot of the staged files, with author, time, message and a link to its parent commit.'],
  ['Hash / SHA', 'The 40-character id of an object, computed from its content. The first 7 characters are usually enough.'],
  ['Branch', 'A movable label pointing at a commit. New commits move the current branch forward.'],
  ['HEAD', 'Where you are now: usually a pointer to the current branch, sometimes directly to a commit (detached HEAD).'],
  ['Detached HEAD', 'HEAD points at a commit instead of a branch. Fine for looking around; commits made here need a branch to survive.'],
  ['Merge', 'Combine the histories of two branches. Fast-forward if one is ahead of the other, otherwise a merge commit with two parents.'],
  ['Merge conflict', 'Both sides changed the same lines differently, so git asks you to choose.'],
  ['Rebase', 'Replay commits on top of another base, creating new commits with new ids.'],
  ['Cherry-pick', 'Copy the change from one commit onto the current branch as a new commit.'],
  ['Remote', 'A named link to another copy of the repository, usually on GitHub. The default name is `origin`.'],
  ['origin', 'The conventional name of the remote you cloned from (or your fork).'],
  ['upstream', 'Two meanings: the branch a local branch tracks (`origin/main`), or the original repository you forked.'],
  ['Remote-tracking branch', 'A read-only local bookmark like `origin/main` recording where the remote branch was at your last fetch.'],
  ['Fetch', 'Download new data from a remote without changing your branches.'],
  ['Pull', 'Fetch and then integrate (merge or rebase) into the current branch.'],
  ['Push', 'Upload your commits to a remote branch.'],
  ['Fast-forward', 'Moving a branch label forward along existing commits, no new commit needed.'],
  ['Force push', 'Overwriting a remote branch even though it loses commits. Use `--force-with-lease` if you must.'],
  ['Fork', 'Your own server-side copy of someone else\'s repository on GitHub.'],
  ['Pull request (PR)', 'A GitHub request to merge one branch into another, with discussion, review and checks.'],
  ['Code review', 'Teammates reading a PR and approving it or requesting changes before it merges.'],
  ['Issue', 'A GitHub ticket for a bug, task or idea. "Fixes #12" in a PR closes issue 12 on merge.'],
  ['Stash', 'A stack of shelved, uncommitted changes.'],
  ['Tag', 'A permanent label on a commit, usually a release version like `v1.4.0`.'],
  ['Reflog', 'A local log of every position HEAD and your branches have had. Used to recover lost work.'],
  ['.gitignore', 'A file listing patterns git should never track, like `node_modules/` or `.env`.'],
  ['Blob', 'The object that stores one file\'s content.'],
  ['Tree', 'The object that stores one folder: names pointing at blobs and other trees.'],
  ['Hook', 'A script git runs automatically at certain moments, like before a commit.'],
  ['GitHub Actions', 'GitHub\'s automation: workflows that run jobs on events like push or pull_request.'],
  ['CI (continuous integration)', 'Automatically building and testing every change before it merges.'],
  ['Continuous delivery', 'Every change that passes the pipeline is ready to release; releasing is one safe, deliberate step.'],
  ['Continuous deployment', 'Every change that passes the pipeline goes to production automatically.'],
  ['Environment', 'A place the app runs, like staging or production. On GitHub it can require approval and limit which refs deploy to it.'],
  ['Rollback', 'Restoring service by redeploying the last known-good release.'],
  ['Smoke test', 'A quick check after a deploy that the most important user path works, e.g. curl -f on the home page.'],
  ['Feature flag', 'A switch that turns a feature on or off without deploying, separating deploy from release.'],
  ['Protected branch', 'A branch with rules, such as requiring a reviewed PR and passing checks before merging.'],
  ['Squash merge', 'Merging a PR as one single new commit on the base branch.'],
  ['Semantic versioning', 'MAJOR.MINOR.PATCH version numbers that signal breaking changes, features and fixes.'],
  ['Conventional Commits', 'A message format like `feat: add search` or `fix(api): handle timeouts`.'],
];

export function renderGuide(section) {
  const page = h('div', { class: 'page' });
  page.append(h('p', { class: 'eyebrow' }, 'Field Guide'), h('h1', { style: { fontSize: 'var(--step-4)', fontWeight: 800, letterSpacing: '-.025em' } }, 'Every command, in one place'),
    h('p', { class: 'lede' }, 'A searchable reference to keep open while you work. Every command here also runs in the Sandbox.'));
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search commands and terms, e.g. "undo", "rebase", "stash"', 'aria-label': 'Search the field guide', id: 'guide-search' });
  const nav = h('nav', { class: 'guide-nav', 'aria-label': 'Guide sections' });
  const body = h('div');
  page.append(h('div', { style: { margin: '20px 0' } }, search), h('div', { class: 'guide-grid' }, nav, body));
  for (const [title] of SHEET) nav.append(h('a', { href: `#/guide/${slug(title)}` }, title));
  nav.append(h('a', { href: '#/guide/undo-map' }, 'Undo map'), h('a', { href: '#/guide/glossary' }, 'Glossary'));

  const draw = (q = '') => {
    clear(body);
    const ql = q.toLowerCase();
    for (const [title, rows] of SHEET) {
      const hits = rows.filter(([c, d]) => !ql || c.toLowerCase().includes(ql) || d.toLowerCase().includes(ql) || title.toLowerCase().includes(ql));
      if (!hits.length) continue;
      const table = h('table', { class: 'cheat' }, h('tbody', {}, hits.map(([c, d]) => { const td = h('td'); td.innerHTML = renderInline(d); return h('tr', {}, h('td', {}, c), td); })));
      body.append(h('section', { id: `g-${slug(title)}`, style: { marginBottom: '32px' } }, h('h2', { style: { fontSize: 'var(--step-2)', marginBottom: '8px' } }, title), h('div', { style: { overflowX: 'auto' } }, table)));
    }
    if (!ql || 'undo reset revert restore mistake'.includes(ql)) {
      body.append(h('section', { id: 'g-undo-map', style: { marginBottom: '32px' } }, h('h2', { style: { fontSize: 'var(--step-2)', marginBottom: '8px' } }, 'Undo map'), renderDiagram('undo-map')));
    }
    const gl = GLOSSARY.filter(([t, d]) => !ql || t.toLowerCase().includes(ql) || d.toLowerCase().includes(ql));
    if (gl.length) {
      const dl = h('dl', { style: { display: 'grid', gap: '10px', margin: 0 } });
      for (const [t, d] of gl) { const dd = h('dd', { style: { margin: 0, color: 'var(--text-2)' } }); dd.innerHTML = renderInline(d); dl.append(h('div', {}, h('dt', { style: { fontWeight: 700 } }, t), dd)); }
      body.append(h('section', { id: 'g-glossary' }, h('h2', { style: { fontSize: 'var(--step-2)', marginBottom: '8px' } }, 'Glossary'), dl));
    }
    if (!body.children.length) body.append(h('p', { style: { color: 'var(--muted)' } }, `Nothing matches "${q}".`));
  };
  search.addEventListener('input', () => draw(search.value.trim()));
  draw();
  if (section) setTimeout(() => document.getElementById(`g-${section}`)?.scrollIntoView({ block: 'start' }), 30);
  return page;
}

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
