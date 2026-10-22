// git and gh inside any simulated host, backed by the Git Conquest engine.

import { def } from '../registry.js';
import { runGit } from '../../git/git.js';
import { runGh } from '../../git/github.js';
import { GitError, C } from '../../git/world.js';

function gitCtx(c, out) {
  const host = c.host;
  const ctx = {
    world: host, cwd: c.cwd, repo: host.findRepo(c.cwd), out, stdin: c.stdin,
    openEditor(req) {
      c.result.editor = {
        ...req,
        onSave(text, { io }) {
          const o2 = [];
          let code;
          try { code = req.onSave(text, { ...ctx, out: o2 }) ?? 0; }
          catch (e) { if (e instanceof GitError) { o2.push(...e.message.split('\n')); code = e.code; } else throw e; }
          if (o2.length) io.out(o2.join('\n') + '\n');
          return code;
        },
      };
    },
    runHook(repo, name, gctx, message) {
      const script = repo.hooks[name];
      if (!script) return 0;
      if (!repo.hookExec?.[name]) { gctx.out.push(C.yellow(`hint: The '.git/hooks/${name}' hook was ignored because it's not set as executable.`)); return 0; }
      const chunks = [];
      const e2 = { ...c.e, cwd: repo.root, vars: new Map(c.e.vars), positional: [] };
      const code = c.sh.runScript(script, e2, { in: null, out: s => chunks.push(s), err: s => chunks.push(s) }, { args: message !== undefined ? [repo.root + '/.git/COMMIT_EDITMSG'] : [], name: `.git/hooks/${name}`, result: c.result });
      if (message !== undefined) repo.lastMessage = message;
      gctx.out.push(...chunks.join('').replace(/\n$/, '').split('\n').filter(x => x !== ''));
      return code;
    },
    runShell(line) { return c.runLine(line); },
  };
  return ctx;
}

def('git', c => {
  const out = [];
  let code;
  try { code = runGit(gitCtx(c, out), c.args); }
  catch (e) { if (e instanceof GitError) { for (const l of e.message.split('\n')) out.push(/^(fatal|error):/.test(l) ? C.red(l) : /^hint:/.test(l) ? C.yellow(l) : l); code = e.code; } else throw e; }
  if (out.length) (code ? c.eprint : c.print)(...out);
  c.uni.emit({ type: 'git', host: c.host.name, args: c.args, code });
  return code ?? 0;
}, { always: true });

def('gh', c => {
  const out = [];
  let code;
  const ctx = gitCtx(c, out);
  try { code = runGh(ctx, c.args, (cc, a) => runGit({ ...gitCtx(c, cc.out), cwd: cc.cwd || c.cwd, repo: cc.repo || c.host.findRepo(cc.cwd || c.cwd) }, a)); }
  catch (e) { if (e instanceof GitError) { out.push(...e.message.split('\n')); code = e.code; } else throw e; }
  if (out.length) (code ? c.eprint : c.print)(...out);
  return code ?? 0;
});

def('ssh_github', c => {
  if (!c.uni.github.sshKeys.length) return c.fail('git@github.com: Permission denied (publickey).', 255);
  c.eprint(`Hi ${c.uni.github.user}! You've successfully authenticated, but GitHub does not provide shell access.`);
  return 1;
});
