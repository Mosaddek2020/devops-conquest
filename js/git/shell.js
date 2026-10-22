// A small POSIX-ish shell over the simulated world: quoting, globbing, pipes, && || ;,
// redirection, `if … then … fi` (enough for git hooks), and a handful of builtins.

import { GitError, C, normPath, dirname, basename, stripAnsi, shortHash } from './world.js';
import { runGit, levenshtein } from './git.js';
import { runGh, simulateRun } from './github.js';
import { httpGet } from './actions.js';
import { currentBranch, headCommit, computeStatus, worktree, headRef } from './core.js';
import { splitLines } from './diff.js';

const OPS = ['&&', '||', ';;', ';', '|', '>>', '>', '<', '\n'];

export function tokenize(line, env = {}) {
  const tokens = [];
  let i = 0;
  let cur = null; // {text, quoted, glob}
  const push = () => { if (cur) { tokens.push({ type: 'word', ...cur }); cur = null; } };
  const ensure = () => { if (!cur) cur = { text: '', quoted: false, glob: false }; };
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#' && !cur) { while (i < line.length && line[i] !== '\n') i++; continue; }
    if (ch === ' ' || ch === '\t') { push(); i++; continue; }
    const op = OPS.find(o => line.startsWith(o, i));
    if (op && !(op === '>' && cur && /^\d$/.test(cur.text) && false)) {
      if (op === '>' && cur && cur.text === '2' && !cur.quoted) { cur = null; tokens.push({ type: 'op', value: '2>' }); i += 1; continue; }
      push(); tokens.push({ type: 'op', value: op === '\n' ? ';' : op }); i += op.length; continue;
    }
    if (ch === '&' && line[i + 1] === '>') { push(); tokens.push({ type: 'op', value: '>' }); i += 2; continue; }
    if (ch === "'") {
      ensure(); cur.quoted = true;
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new GitError('bash: unexpected EOF while looking for matching `\'\'', 2);
      cur.text += line.slice(i + 1, end); i = end + 1; continue;
    }
    if (ch === '"') {
      ensure(); cur.quoted = true;
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) { cur.text += line[i + 1]; i += 2; continue; }
        if (line[i] === '$') { const [val, len] = expandVar(line, i, env); cur.text += val; i += len; continue; }
        cur.text += line[i]; i++;
      }
      if (i >= line.length) throw new GitError('bash: unexpected EOF while looking for matching `"\'', 2);
      i++; continue;
    }
    if (ch === '\\' && i + 1 < line.length) { ensure(); cur.text += line[i + 1]; i += 2; continue; }
    if (ch === '$') { ensure(); const [val, len] = expandVar(line, i, env); cur.text += val; i += len; continue; }
    if (ch === '~' && !cur && (line[i + 1] === undefined || line[i + 1] === '/' || line[i + 1] === ' ')) { ensure(); cur.text += env.HOME || '/home/dev'; i++; continue; }
    ensure();
    if (ch === '*' || ch === '?') cur.glob = true;
    cur.text += ch; i++;
  }
  push();
  return tokens;
}

function expandVar(line, i, env) {
  if (line[i + 1] === '{') { const end = line.indexOf('}', i); const name = line.slice(i + 2, end); return [env[name] ?? '', end - i + 1]; }
  if (line[i + 1] === '?') return [String(env['?'] ?? 0), 2];
  const m = line.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*|^\d/);
  if (!m) return ['$', 1];
  return [env[m[0]] ?? '', m[0].length + 1];
}

// Parse tokens into a list of {kind:'cmd'|'if', ..., next:'&&'|'||'|';'}
function parseList(tokens, pos, stopWords) {
  const items = [];
  while (pos < tokens.length) {
    const t = tokens[pos];
    if (t.type === 'op' && t.value === ';') { pos++; continue; }
    if (t.type === 'word' && !t.quoted && stopWords.includes(t.text)) break;
    if (t.type === 'word' && !t.quoted && t.text === 'if') {
      const cond = parseList(tokens, pos + 1, ['then']);
      if (tokens[cond.pos]?.text !== 'then') throw new GitError("bash: syntax error: expected 'then'", 2);
      const body = parseList(tokens, cond.pos + 1, ['else', 'elif', 'fi']);
      let elseBody = { items: [], pos: body.pos };
      if (tokens[body.pos]?.text === 'else') elseBody = parseList(tokens, body.pos + 1, ['fi']);
      if (tokens[elseBody.pos]?.text !== 'fi') throw new GitError("bash: syntax error: expected 'fi'", 2);
      pos = elseBody.pos + 1;
      const item = { kind: 'if', cond: cond.items, then: body.items, else: elseBody.items, next: ';' };
      if (tokens[pos]?.type === 'op' && ['&&', '||'].includes(tokens[pos].value)) { item.next = tokens[pos].value; pos++; }
      items.push(item);
      continue;
    }
    // pipeline
    const pipeline = [];
    let cmd = { argv: [], redirects: [] };
    while (pos < tokens.length) {
      const tk = tokens[pos];
      if (tk.type === 'op' && (tk.value === ';' || tk.value === '&&' || tk.value === '||')) break;
      if (tk.type === 'word' && !tk.quoted && cmd.argv.length === 0 && stopWords.includes(tk.text)) break;
      if (tk.type === 'op' && tk.value === '|') { pipeline.push(cmd); cmd = { argv: [], redirects: [] }; pos++; continue; }
      if (tk.type === 'op' && ['>', '>>', '<', '2>'].includes(tk.value)) {
        const target = tokens[pos + 1];
        if (!target || target.type !== 'word') throw new GitError(`bash: syntax error near unexpected token \`newline'`, 2);
        cmd.redirects.push({ op: tk.value, target: target.text });
        pos += 2; continue;
      }
      cmd.argv.push(tk);
      pos++;
    }
    pipeline.push(cmd);
    const item = { kind: 'pipe', pipeline, next: ';' };
    if (tokens[pos]?.type === 'op' && ['&&', '||'].includes(tokens[pos].value)) { item.next = tokens[pos].value; pos++; }
    if (pipeline.some(c => c.argv.length || c.redirects.length)) items.push(item);
  }
  return { items, pos };
}

class ExitSignal { constructor(code) { this.code = code; } }

export class Shell {
  constructor(world, { cwd } = {}) {
    this.world = world;
    this.cwd = cwd || world.home;
    this.history = [];
    this.env = { HOME: world.home, USER: 'dev', SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin' };
    this.lastCode = 0;
    this.pendingEditor = null;
    this.extraCommands = {};   // labs can add commands
  }

  get repo() { return this.world.findRepo(this.cwd); }

  prompt() {
    const repo = this.repo;
    const home = this.world.home;
    const path = this.cwd === home ? '~' : this.cwd.startsWith(home + '/') ? '~/' + this.cwd.slice(home.length + 1) : this.cwd;
    let branch = null, state = null, dirty = false;
    if (repo && !repo.bare) {
      branch = currentBranch(repo) || (headCommit(repo) ? `(${shortHash(headCommit(repo))}...)` : null);
      if (repo.state?.type === 'merge') state = 'MERGING';
      if (repo.state?.type === 'rebase') { const done = repo.state.origTodo ? '' : ''; state = 'REBASE' + done; }
      if (repo.state?.type === 'cherry-pick') state = 'CHERRY-PICKING';
      if (repo.state?.type === 'revert') state = 'REVERTING';
      if (repo.bisect) state = 'BISECTING';
      try { const s = computeStatus(repo); dirty = !!(s.staged.length || s.unstaged.length || s.conflicts.length); } catch { /* ignore */ }
    }
    return { user: 'dev', host: 'conquest', path, branch, state, dirty };
  }

  resolvePath(p) {
    if (!p) return this.cwd;
    if (p === '~') return this.world.home;
    if (p.startsWith('~/')) return normPath(this.world.home + '/' + p.slice(2));
    return p.startsWith('/') ? normPath(p) : normPath(this.cwd + '/' + p);
  }

  // ---------- virtual .git directory ----------
  gitPath(abs) {
    const m = abs.match(/^(.*)\/\.git(\/.*)?$/);
    if (!m) return null;
    const repo = this.world.repos.get(m[1]);
    if (!repo) return null;
    return { repo, sub: (m[2] || '').replace(/^\//, '') };
  }

  readVirtual(abs) {
    const g = this.gitPath(abs);
    if (!g) return undefined;
    const { repo, sub } = g;
    const w = this.world;
    if (sub === 'HEAD') return repo.HEAD + '\n';
    if (sub === 'ORIG_HEAD' && repo.origHead) return repo.origHead + '\n';
    if (sub === 'MERGE_HEAD' && repo.state?.mergeHead) return repo.state.mergeHead + '\n';
    if (sub === 'COMMIT_EDITMSG') return (repo.lastMessage || '') + '\n';
    if (sub === 'description') return "Unnamed repository; edit this file 'description' to name the repository.\n";
    if (sub === 'config') {
      const sections = {};
      const add = (sec, key, val) => { (sections[sec] = sections[sec] || []).push(`\t${key} = ${val}`); };
      add('core', 'repositoryformatversion', '0'); add('core', 'filemode', 'true'); add('core', 'bare', 'false');
      for (const [k, v] of Object.entries(repo.config)) {
        const parts = k.split('.');
        const key = parts.pop();
        const sec = parts.length > 1 ? `${parts[0]} "${parts.slice(1).join('.')}"` : parts[0];
        add(sec, key, v);
      }
      return Object.entries(sections).map(([s, l]) => `[${s}]\n${l.join('\n')}`).join('\n') + '\n';
    }
    if (sub.startsWith('refs/')) { const h = repo.refs[sub]; return h ? h + '\n' : undefined; }
    if (sub.startsWith('hooks/')) { const name = sub.slice(6); return repo.hooks[name] ?? (name.endsWith('.sample') ? '#!/bin/sh\n# sample hook\n' : undefined); }
    if (sub === 'logs/HEAD') return (repo.reflog.HEAD || []).slice().reverse().map(e => `${e.old || '0'.repeat(40)} ${e.new} Dev Learner <dev@example.com> ${e.time} +0000\t${e.msg}`).join('\n') + '\n';
    const om = sub.match(/^objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/);
    if (om) { const o = w.objects.get(om[1] + om[2]); return o ? `(zlib-compressed ${o.type} object, ${o.size} bytes — use: git cat-file -p ${om[1] + om[2]})\n` : undefined; }
    if (sub === 'index') return `(binary index file: ${repo.index.size} entries — use: git ls-files --stage)\n`;
    return undefined;
  }

  listVirtual(abs) {
    const g = this.gitPath(abs);
    if (!g) return null;
    const { repo, sub } = g;
    const w = this.world;
    if (sub === '') {
      const items = [['HEAD', 'file'], ['config', 'file'], ['description', 'file'], ['hooks', 'dir'], ['index', 'file'], ['info', 'dir'], ['logs', 'dir'], ['objects', 'dir'], ['refs', 'dir']];
      if (repo.origHead) items.push(['ORIG_HEAD', 'file']);
      if (repo.state?.mergeHead) items.push(['MERGE_HEAD', 'file']);
      if (repo.lastMessage) items.push(['COMMIT_EDITMSG', 'file']);
      return items.sort((a, b) => a[0].localeCompare(b[0]));
    }
    if (sub === 'refs') return [['heads', 'dir'], ['remotes', 'dir'], ['tags', 'dir']];
    if (sub.startsWith('refs/')) {
      const pre = sub + '/';
      const names = new Map();
      for (const r of Object.keys(repo.refs)) {
        if (!r.startsWith(pre)) continue;
        const rest = r.slice(pre.length);
        names.set(rest.split('/')[0], rest.includes('/') ? 'dir' : 'file');
      }
      return [...names].sort();
    }
    if (sub === 'hooks') {
      const names = ['applypatch-msg.sample', 'commit-msg.sample', 'pre-commit.sample', 'pre-push.sample', 'pre-rebase.sample', 'prepare-commit-msg.sample', ...Object.keys(repo.hooks)];
      return [...new Set(names)].sort().map(n => [n, 'file']);
    }
    if (sub === 'objects') {
      const dirs = new Set();
      for (const h of this.reachableObjects(repo)) dirs.add(h.slice(0, 2));
      return [...[...dirs].sort().map(d => [d, 'dir']), ['info', 'dir'], ['pack', 'dir']];
    }
    const od = sub.match(/^objects\/([0-9a-f]{2})$/);
    if (od) return [...this.reachableObjects(repo)].filter(h => h.startsWith(od[1])).sort().map(h => [h.slice(2), 'file']);
    if (sub === 'logs') return [['HEAD', 'file'], ['refs', 'dir']];
    if (sub === 'info') return [['exclude', 'file']];
    void w;
    return [];
  }

  reachableObjects(repo) {
    const w = this.world;
    const seen = new Set();
    const visit = (h) => {
      if (!h || seen.has(h)) return;
      const o = w.objects.get(h);
      if (!o) return;
      seen.add(h);
      if (o.type === 'commit') { visit(o.tree); o.parents.forEach(visit); }
      else if (o.type === 'tree') o.entries.forEach(e => visit(e.hash));
      else if (o.type === 'tag') visit(o.object);
    };
    Object.values(repo.refs).forEach(visit);
    for (const h of repo.index.values()) visit(h);
    for (const e of Object.values(repo.reflog).flat()) visit(e.new);
    if (repo.extraObjects) for (const h of repo.extraObjects) visit(h);
    return seen;
  }

  readFile(abs) {
    const v = this.readVirtual(abs);
    if (v !== undefined) return v;
    return this.world.files.get(abs);
  }

  writeFile(abs, content) {
    const g = this.gitPath(abs);
    if (g) {
      if (g.sub.startsWith('hooks/')) { g.repo.hooks[g.sub.slice(6)] = content; return; }
      if (g.sub === 'HEAD') { g.repo.HEAD = content.trim(); return; }
      if (g.sub.startsWith('refs/')) { g.repo.refs[g.sub] = content.trim(); return; }
      if (g.sub === 'info/exclude') { g.repo.exclude = content; return; }
      throw new GitError(`bash: ${abs}: Simulator keeps .git internals read-only (except hooks/, HEAD and refs/)`, 1);
    }
    if (this.world.isDir(abs) && !this.world.files.has(abs)) throw new GitError(`bash: ${abs}: Is a directory`, 1);
    const parent = dirname(abs);
    if (!this.world.isDir(parent) && parent !== '/') throw new GitError(`bash: ${abs}: No such file or directory`, 1);
    this.world.writeFile(abs, content);
  }

  // ---------- execution ----------

  run(line, { record = true } = {}) {
    const out = [];
    if (record && line.trim()) this.history.push(line);
    const result = { out, code: 0, editor: null, clear: false };
    if (!line.trim()) return result;
    let items;
    try {
      items = parseList(tokenize(line, this.env), 0, []).items;
    } catch (e) {
      out.push(C.red(e.message)); result.code = 2; return result;
    }
    try {
      result.code = this.execList(items, out, result);
    } catch (e) {
      if (e instanceof ExitSignal) result.code = e.code;
      else throw e;
    }
    this.lastCode = result.code;
    this.env['?'] = result.code;
    return result;
  }

  execList(items, out, result, stdinForFirst = null) {
    let code = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const prev = items[idx - 1];
      if (prev && ((prev.next === '&&' && code !== 0) || (prev.next === '||' && code === 0))) continue;
      if (item.kind === 'if') {
        const c = this.execList(item.cond, [], result);
        code = c === 0 ? this.execList(item.then, out, result) : this.execList(item.else, out, result);
      } else code = this.execPipeline(item.pipeline, out, result, idx === 0 ? stdinForFirst : null);
      this.env['?'] = code;
      if (result.editor) return code;
    }
    return code;
  }

  expandArgs(argvTokens) {
    const args = [];
    for (const t of argvTokens) {
      if (t.glob && !t.quoted) {
        const matches = this.glob(t.text);
        if (matches.length) { args.push(...matches); continue; }
      }
      args.push(t.text);
    }
    return args;
  }

  glob(pattern) {
    const absPattern = this.resolvePath(pattern);
    const dir = dirname(absPattern);
    const namePat = basename(absPattern);
    if (!this.world.isDir(dir)) return [];
    const re = new RegExp('^' + namePat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const names = this.world.listDir(dir).map(([n]) => n).filter(n => re.test(n) && (!n.startsWith('.') || namePat.startsWith('.')));
    const prefix = pattern.includes('/') ? pattern.slice(0, pattern.lastIndexOf('/') + 1) : '';
    return names.map(n => prefix + n);
  }

  execPipeline(pipeline, out, result, stdin = null) {
    let negate = false;
    const first = pipeline[0]?.argv[0];
    if (first && !first.quoted && first.text === '!') {
      negate = true;
      pipeline = [{ ...pipeline[0], argv: pipeline[0].argv.slice(1) }, ...pipeline.slice(1)];
    }
    const code = this.runPipeline(pipeline, out, result, stdin);
    return negate ? (code === 0 ? 1 : 0) : code;
  }

  runPipeline(pipeline, out, result, stdin = null) {
    let input = stdin;
    let code = 0;
    for (let k = 0; k < pipeline.length; k++) {
      const cmd = pipeline[k];
      const args = this.expandArgs(cmd.argv);
      const buf = [];
      const errBuf = [];
      for (const r of cmd.redirects) if (r.op === '<') {
        const c = this.readFile(this.resolvePath(r.target));
        if (c === undefined) { out.push(`bash: ${r.target}: No such file or directory`); return 1; }
        input = c;
      }
      code = this.execCommand(args, buf, input, result, errBuf);
      if (result.editor) { out.push(...buf); return code; }
      const redirectOut = cmd.redirects.find(r => r.op === '>' || r.op === '>>');
      const redirectErr = cmd.redirects.find(r => r.op === '2>');
      if (redirectErr) {
        if (redirectErr.target !== '/dev/null') { try { this.writeFile(this.resolvePath(redirectErr.target), errBuf.join('\n') + (errBuf.length ? '\n' : '')); } catch (e) { out.push(C.red(e.message)); } }
      } else if (k === pipeline.length - 1 && !cmd.redirects.some(r => r.op === '>' || r.op === '>>')) buf.push(...errBuf);
      else out.push(...errBuf);
      if (redirectOut) {
        if (redirectOut.target === '/dev/null') { input = null; continue; }
        const abs = this.resolvePath(redirectOut.target);
        const text = buf.map(stripAnsi).join('\n') + (buf.length && !buf.noTrailingNewline ? '\n' : '');
        try {
          if (redirectOut.op === '>>') this.writeFile(abs, (this.readFile(abs) ?? '') + text);
          else this.writeFile(abs, text);
        } catch (e) { out.push(C.red(e.message)); code = 1; }
        input = '';
        if (k === pipeline.length - 1) break;
        continue;
      }
      if (k === pipeline.length - 1) out.push(...buf);
      else input = buf.map(stripAnsi).join('\n') + (buf.length ? '\n' : '');
    }
    return code;
  }

  execCommand(args, out, stdin, result, err = out) {
    if (!args.length) return 0;
    const [name, ...rest] = args;
    // VAR=value assignments
    if (/^[A-Za-z_]\w*=/.test(name) && !rest.length) { const i = name.indexOf('='); this.env[name.slice(0, i)] = name.slice(i + 1); return 0; }
    try {
      if (name === 'git') return this.git(rest, out, stdin, result);
      if (name === 'gh') return this.gh(rest, out, result);
      if (this.extraCommands[name]) return this.extraCommands[name](rest, out, this, stdin) ?? 0;
      const fn = builtins[name];
      if (!fn) {
        const near = Object.keys(builtins).find(b => levenshtein(b, name) <= 1);
        out.push(`bash: ${name}: command not found${near ? C.dim(`  (did you mean '${near}'?)`) : ''}`);
        if (name.startsWith('git') && name.length > 3) out.push(C.dim(`hint: put a space after git, like: git ${name.slice(3)}`));
        return 127;
      }
      return fn.call(this, rest, out, stdin, result) ?? 0;
    } catch (e) {
      if (e instanceof ExitSignal) throw e;
      if (e instanceof GitError) { for (const l of e.message.split('\n')) err.push(colorErr(l)); return e.code; }
      console.error(e);
      err.push(C.red(`simulator error: ${e.message}`));
      return 1;
    }
  }

  makeCtx(out, result) {
    const self = this;
    const ctx = {
      world: this.world,
      cwd: this.cwd,
      repo: this.world.findRepo(this.cwd),
      out,
      openEditor(req) { result.editor = req; },
      runHook: (repo, name, c2, message) => this.runHook(repo, name, c2, message),
      runShell: (line) => { const r = self.run(line, { record: false }); return r.code; },
    };
    return ctx;
  }

  git(args, out, stdin, result) {
    const ctx = this.makeCtx(out, result);
    ctx.stdin = stdin;
    const code = runGit(ctx, args);
    // a commit records the message for .git/COMMIT_EDITMSG
    const repo = this.world.findRepo(this.cwd);
    if (repo && repo.bare === false && headCommit(repo)) {
      try { repo.lastMessage = this.world.commit(headCommit(repo)).message; } catch { /* ignore */ }
    }
    return code;
  }

  gh(args, out, result) {
    const ctx = this.makeCtx(out, result);
    return runGh(ctx, args, (c, a) => runGit({ ...this.makeCtx(c.out, result), cwd: c.cwd || this.cwd, repo: c.repo || this.world.findRepo(c.cwd || this.cwd) }, a));
  }

  // Called by the UI when the user saves the editor. Returns another run result.
  resolveEditor(req, text) {
    const out = [];
    const result = { out, code: 0, editor: null };
    const ctx = this.makeCtx(out, result);
    try {
      result.code = req.onSave(text, ctx) ?? 0;
    } catch (e) {
      if (e instanceof GitError) { for (const l of e.message.split('\n')) out.push(colorErr(l)); result.code = e.code; }
      else throw e;
    }
    return result;
  }

  runHook(repo, name, ctx, message) {
    const script = repo.hooks[name];
    if (!script) return 0;
    if (!repo.hookExec?.[name]) {
      ctx.out.push(C.yellow(`hint: The '.git/hooks/${name}' hook was ignored because it's not set as executable.`), C.yellow(`hint: You can disable this warning with \`git config advice.ignoredHook false\`.`));
      return 0;
    }
    const savedCwd = this.cwd;
    this.cwd = repo.root;
    const savedEnv = { ...this.env };
    if (message !== undefined) { repo.lastMessage = message; this.env['1'] = repo.root + '/.git/COMMIT_EDITMSG'; }
    const body = script.split('\n').filter(l => !l.startsWith('#!')).join('\n');
    const r = this.run(body, { record: false });
    this.cwd = savedCwd;
    this.env = savedEnv;
    ctx.out.push(...r.out);
    return r.code;
  }
}

function colorErr(l) {
  if (/^(fatal|error):/.test(l)) return C.red(l);
  if (/^hint:/.test(l)) return C.yellow(l);
  return l;
}

// ---------- builtins ----------

const builtins = {
  help(args, out) {
    out.push(C.bold('Shell commands in this simulator'),
      '  ls [-a] [-l]   cd <dir>   pwd   cat <file>   echo <text> [> file | >> file]',
      '  touch <file>   mkdir [-p] <dir>   rm [-r] <path>   mv <a> <b>   cp <a> <b>',
      '  edit <file>    (also: nano, vim, code) opens a file in the editor',
      '  tree   grep   head   tail   wc   sed -i   clear   history   chmod +x',
      '  ssh-keygen   ssh -T git@github.com   npm test   npm run lint',
      '', C.bold('Version control'), '  git <command>   (try: git help)', '  gh <command>    (GitHub CLI; try: gh help)');
    return 0;
  },
  pwd(args, out) { out.push(this.cwd); return 0; },
  whoami(args, out) { out.push('dev'); return 0; },
  date(args, out) { out.push(new Date(this.world.time * 1000).toUTCString()); return 0; },
  true() { return 0; },
  false() { return 1; },
  ':'() { return 0; },
  exit(args) { throw new ExitSignal(Number(args[0] || 0)); },
  clear(args, out, stdin, result) { result.clear = true; return 0; },
  history(args, out) { this.history.forEach((h, i) => out.push(`${String(i + 1).padStart(5)}  ${h}`)); return 0; },
  export(args) { for (const a of args) { const i = a.indexOf('='); if (i > 0) this.env[a.slice(0, i)] = a.slice(i + 1); } return 0; },
  cd(args, out) {
    const target = this.resolvePath(args[0] || '~');
    if (this.gitPath(target) || this.world.isDir(target) || target === '/') { this.cwd = target; return 0; }
    if (this.world.files.has(target)) { out.push(`bash: cd: ${args[0]}: Not a directory`); return 1; }
    out.push(`bash: cd: ${args[0]}: No such file or directory`); return 1;
  },
  ls(args, out) {
    const flags = args.filter(a => a.startsWith('-')).join('');
    const all = flags.includes('a'), long = flags.includes('l'), one = flags.includes('1') || long;
    const targets = args.filter(a => !a.startsWith('-'));
    if (!targets.length) targets.push('.');
    let code = 0;
    for (const t of targets) {
      const abs = this.resolvePath(t);
      let entries = this.listVirtual(abs);
      if (!entries) {
        if (this.world.files.has(abs)) { out.push(t); continue; }
        if (!this.world.isDir(abs) && abs !== '/') { out.push(`ls: cannot access '${t}': No such file or directory`); code = 2; continue; }
        entries = this.world.listDir(abs);
      }
      if (targets.length > 1) out.push(`${t}:`);
      const shown = entries.filter(([n]) => all || !n.startsWith('.'));
      if (all) shown.unshift(['.', 'dir'], ['..', 'dir']);
      const fmt = ([n, kind]) => kind === 'dir' ? C.bold(C.blue(n)) + (one ? '' : '') : n;
      if (one) {
        for (const e of shown) {
          if (long) {
            const p = abs + '/' + e[0];
            const size = e[1] === 'file' ? (this.readFile(p) ?? '').length : 4096;
            out.push(`${e[1] === 'dir' ? 'd' : '-'}rw-r--r-- 1 dev dev ${String(size).padStart(5)} Jan  1 09:00 ${fmt(e)}`);
          } else out.push(fmt(e));
        }
      } else if (shown.length) out.push(shown.map(fmt).join('  '));
    }
    return code;
  },
  tree(args, out) {
    const abs = this.resolvePath(args.find(a => !a.startsWith('-')) || '.');
    const all = args.includes('-a');
    let dirs = 0, files = 0;
    const walk = (dir, prefix) => {
      const entries = this.world.listDir(dir).filter(([n]) => n !== '.git' && (all || !n.startsWith('.')));
      entries.forEach(([n, kind], i) => {
        const last = i === entries.length - 1;
        out.push(prefix + (last ? '└── ' : '├── ') + (kind === 'dir' ? C.bold(C.blue(n)) : n));
        if (kind === 'dir') { dirs++; walk(dir + '/' + n, prefix + (last ? '    ' : '│   ')); } else files++;
      });
    };
    out.push(C.bold(C.blue('.')));
    walk(abs, '');
    out.push('', `${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}`);
    return 0;
  },
  cat(args, out, stdin) {
    const files = args.filter(a => a !== '-n');
    const number = args.includes('-n');
    if (!files.length) { if (stdin != null) out.push(...splitLines(stdin)); return 0; }
    let code = 0;
    for (const f of files) {
      const abs = this.resolvePath(f);
      const c = this.readFile(abs);
      if (c === undefined) {
        out.push(this.world.isDir(abs) ? `cat: ${f}: Is a directory` : `cat: ${f}: No such file or directory`);
        code = 1; continue;
      }
      const lines = splitLines(c);
      out.push(...(number ? lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`) : lines));
      if (c && !c.endsWith('\n')) out.noTrailingNewline = true;
    }
    return code;
  },
  echo(args, out) {
    let nl = true, esc = false;
    while (args[0] === '-n' || args[0] === '-e') { if (args[0] === '-n') nl = false; else esc = true; args = args.slice(1); }
    let text = args.join(' ');
    if (esc) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    out.push(...text.split('\n'));
    if (!nl) out.noTrailingNewline = true;
    return 0;
  },
  printf(args, out) {
    const fmt = (args[0] || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    let i = 1;
    const text = fmt.replace(/%s/g, () => args[i++] ?? '');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); else out.noTrailingNewline = true;
    out.push(...lines);
    return 0;
  },
  touch(args, out) {
    for (const f of args.filter(a => !a.startsWith('-'))) {
      const abs = this.resolvePath(f);
      if (this.readFile(abs) === undefined) {
        try { this.writeFile(abs, ''); } catch (e) { out.push(`touch: cannot touch '${f}': No such file or directory`); return 1; }
      }
    }
    return 0;
  },
  mkdir(args, out) {
    const p = args.includes('-p');
    for (const d of args.filter(a => !a.startsWith('-'))) {
      const abs = this.resolvePath(d);
      if (this.world.isDir(abs) || this.world.files.has(abs)) { if (!p) { out.push(`mkdir: cannot create directory '${d}': File exists`); return 1; } continue; }
      if (!p && !this.world.isDir(dirname(abs))) { out.push(`mkdir: cannot create directory '${d}': No such file or directory`); return 1; }
      let cur = abs;
      while (cur !== '/' && !this.world.dirs.has(cur)) { this.world.dirs.add(cur); cur = dirname(cur); }
    }
    return 0;
  },
  rm(args, out) {
    const flags = args.filter(a => a.startsWith('-')).join('');
    const rec = /r|R/.test(flags), force = flags.includes('f');
    let code = 0;
    for (const t of args.filter(a => !a.startsWith('-'))) {
      const abs = this.resolvePath(t);
      if (abs.endsWith('/.git') && this.world.repos.has(dirname(abs))) {
        if (!rec) { out.push(`rm: cannot remove '${t}': Is a directory`); code = 1; continue; }
        this.world.repos.delete(dirname(abs));
        continue;
      }
      if (this.world.files.has(abs)) { this.world.removeFile(abs); continue; }
      if (this.world.isDir(abs)) {
        if (!rec) { out.push(`rm: cannot remove '${t}': Is a directory`); code = 1; continue; }
        for (const f of [...this.world.files.keys()]) if (f.startsWith(abs + '/')) this.world.files.delete(f);
        for (const d of [...this.world.dirs]) if (d === abs || d.startsWith(abs + '/')) this.world.dirs.delete(d);
        for (const r of [...this.world.repos.keys()]) if (r === abs || r.startsWith(abs + '/')) this.world.repos.delete(r);
        if (this.cwd === abs || this.cwd.startsWith(abs + '/')) this.cwd = dirname(abs);
        continue;
      }
      if (!force) { out.push(`rm: cannot remove '${t}': No such file or directory`); code = 1; }
    }
    return code;
  },
  mv(args, out) {
    const [a, b] = args.filter(x => !x.startsWith('-'));
    if (!a || !b) { out.push('mv: missing file operand'); return 1; }
    const src = this.resolvePath(a);
    let dst = this.resolvePath(b);
    if (this.world.isDir(dst) && !this.world.files.has(dst)) dst = dst + '/' + basename(src);
    if (this.world.files.has(src)) { this.world.writeFile(dst, this.world.files.get(src)); this.world.removeFile(src); return 0; }
    if (this.world.isDir(src)) {
      for (const f of [...this.world.files.keys()]) if (f.startsWith(src + '/')) { this.world.writeFile(dst + f.slice(src.length), this.world.files.get(f)); this.world.files.delete(f); }
      for (const d of [...this.world.dirs]) if (d === src || d.startsWith(src + '/')) { this.world.dirs.delete(d); this.world.dirs.add(dst + d.slice(src.length)); }
      if (this.world.repos.has(src)) { const r = this.world.repos.get(src); this.world.repos.delete(src); r.root = dst; this.world.repos.set(dst, r); }
      return 0;
    }
    out.push(`mv: cannot stat '${a}': No such file or directory`); return 1;
  },
  cp(args, out) {
    const rec = args.some(a => /^-.*r/i.test(a));
    const [a, b] = args.filter(x => !x.startsWith('-'));
    const src = this.resolvePath(a);
    let dst = this.resolvePath(b);
    if (this.world.isDir(dst) && !this.world.files.has(dst)) dst = dst + '/' + basename(src);
    if (this.world.files.has(src)) { this.world.writeFile(dst, this.world.files.get(src)); return 0; }
    if (this.world.isDir(src)) {
      if (!rec) { out.push(`cp: -r not specified; omitting directory '${a}'`); return 1; }
      for (const f of [...this.world.files.keys()]) if (f.startsWith(src + '/')) this.world.writeFile(dst + f.slice(src.length), this.world.files.get(f));
      this.world.dirs.add(dst);
      return 0;
    }
    out.push(`cp: cannot stat '${a}': No such file or directory`); return 1;
  },
  chmod(args, out) {
    const target = args.find(a => !a.startsWith('+') && !a.startsWith('-') && !/^\d+$/.test(a));
    const abs = this.resolvePath(target || '');
    const g = this.gitPath(abs);
    if (g && g.sub.startsWith('hooks/')) { g.repo.hookExec = g.repo.hookExec || {}; g.repo.hookExec[g.sub.slice(6)] = true; return 0; }
    if (this.readFile(abs) === undefined) { out.push(`chmod: cannot access '${target}': No such file or directory`); return 1; }
    return 0;
  },
  grep(args, out, stdin) {
    const flags = new Set();
    const rest = [];
    for (const a of args) { if (/^-[a-zA-Z]+$/.test(a)) for (const c of a.slice(1)) flags.add(c); else rest.push(a); }
    const [pattern, ...files] = rest;
    if (pattern === undefined) { out.push('Usage: grep [OPTION]... PATTERNS [FILE]...'); return 2; }
    let re;
    try { re = new RegExp(pattern, flags.has('i') ? 'i' : ''); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags.has('i') ? 'i' : ''); }
    const sources = [];
    if (!files.length) sources.push([null, stdin ?? '']);
    for (const f of files) {
      const abs = this.resolvePath(f);
      if (flags.has('r') && this.world.isDir(abs)) {
        for (const [p, c] of this.world.files) if (p.startsWith(abs + '/') && !p.includes('/.git/')) sources.push([p.slice(this.cwd.length + 1), c]);
        continue;
      }
      const c = this.readFile(abs);
      if (c === undefined) { if (!flags.has('s')) out.push(`grep: ${f}: No such file or directory`); continue; }
      sources.push([f, c]);
    }
    let count = 0;
    const multi = sources.length > 1 || flags.has('r');
    for (const [name, text] of sources) {
      let n = 0;
      splitLines(text).forEach((l, i) => {
        const hit = re.test(l) !== flags.has('v');
        if (!hit) return;
        n++; count++;
        if (flags.has('q') || flags.has('c') || flags.has('l')) return;
        out.push(`${multi && name ? C.magenta(name) + C.cyan(':') : ''}${flags.has('n') ? C.green(String(i + 1)) + C.cyan(':') : ''}${flags.has('v') ? l : l.replace(re, m => C.bold(C.red(m)))}`);
      });
      if (flags.has('c')) out.push(`${multi && name ? name + ':' : ''}${n}`);
      if (flags.has('l') && n) out.push(name);
    }
    return count ? 0 : 1;
  },
  head(args, out, stdin) { return headTail.call(this, args, out, stdin, true); },
  tail(args, out, stdin) { return headTail.call(this, args, out, stdin, false); },
  wc(args, out, stdin) {
    const files = args.filter(a => !a.startsWith('-'));
    const text = files.length ? (this.readFile(this.resolvePath(files[0])) ?? '') : (stdin ?? '');
    const lines = (text.match(/\n/g) || []).length;
    if (args.includes('-l')) out.push(`${lines}${files[0] ? ' ' + files[0] : ''}`);
    else out.push(`${lines} ${text.split(/\s+/).filter(Boolean).length} ${text.length}${files[0] ? ' ' + files[0] : ''}`);
    return 0;
  },
  sort(args, out, stdin) { out.push(...splitLines(stdin ?? '').sort()); return 0; },
  sed(args, out, stdin) {
    const inPlace = args.includes('-i');
    const rest = args.filter(a => a !== '-i' && a !== '-e');
    const [expr, file] = rest;
    const m = expr && expr.match(/^s(.)(.*?)\1(.*?)\1(g?)$/);
    if (!m) { out.push(`sed: -e expression #1, char 1: unknown command: \`${expr?.[0] || ''}'`); return 1; }
    const re = new RegExp(m[2], m[4] ? 'g' : '');
    const apply = t => splitLines(t).map(l => l.replace(re, m[3])).join('\n') + (t.endsWith('\n') ? '\n' : '');
    if (file) {
      const abs = this.resolvePath(file);
      const c = this.readFile(abs);
      if (c === undefined) { out.push(`sed: can't read ${file}: No such file or directory`); return 2; }
      if (inPlace) { this.writeFile(abs, apply(c)); return 0; }
      out.push(...splitLines(apply(c)));
      return 0;
    }
    out.push(...splitLines(apply(stdin ?? '')));
    return 0;
  },
  edit(args, out, stdin, result) {
    const f = args.filter(a => !a.startsWith('-') && !a.startsWith('+'))[0];
    if (!f) { out.push('usage: edit <file>'); return 1; }
    const abs = this.resolvePath(f);
    if (this.world.isDir(abs) && !this.world.files.has(abs) && !this.gitPath(abs)) { out.push(`edit: ${f}: Is a directory`); return 1; }
    const content = this.readFile(abs) ?? '';
    result.editor = {
      title: f, content, file: abs,
      hint: 'Edit the file, then press Save (Ctrl+S). Cancel leaves it unchanged.',
      onSave: (text, ctx) => {
        try { this.writeFile(abs, text); } catch (e) { ctx.out.push(C.red(e.message)); return 1; }
        return 0;
      },
    };
    return 0;
  },
  'ssh-keygen'(args, out) {
    const o = {}; for (let i = 0; i < args.length; i++) if (args[i].startsWith('-')) o[args[i]] = args[i + 1];
    const type = o['-t'] || 'ed25519';
    const path = this.resolvePath(o['-f'] || `~/.ssh/id_${type}`);
    const comment = o['-C'] || 'dev@conquest';
    const rand = Array.from({ length: 43 }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[(i * 37 + this.world.time) % 64]).join('');
    this.world.dirs.add(dirname(path));
    this.world.writeFile(path, `-----BEGIN OPENSSH PRIVATE KEY-----\n(private key — never share this file)\n-----END OPENSSH PRIVATE KEY-----\n`);
    this.world.writeFile(path + '.pub', `ssh-${type} AAAAC3NzaC1lZDI1NTE5AAAAI${rand} ${comment}\n`);
    out.push(`Generating public/private ${type} key pair.`, `Your identification has been saved in ${path}`, `Your public key has been saved in ${path}.pub`, 'The key fingerprint is:', `SHA256:${rand.slice(0, 43)} ${comment}`);
    this.world.emit({ type: 'ssh-keygen' });
    return 0;
  },
  ssh(args, out) {
    if (args.includes('-T') && args.some(a => a.includes('github.com'))) {
      if (!this.world.github.sshKeys.length) { out.push('git@github.com: Permission denied (publickey).'); return 255; }
      out.push(`Hi ${this.world.github.user}! You've successfully authenticated, but GitHub does not provide shell access.`);
      return 1;
    }
    out.push('ssh: connect to host: Connection refused (the simulator only supports: ssh -T git@github.com)'); return 255;
  },
  npm(args, out) {
    const repo = this.repo;
    const script = args[0] === 'run' ? args[1] : args[0];
    if (!repo) { out.push('npm ERR! enoent Could not read package.json'); return 254; }
    const wt = worktree(repo);
    const flat = new Map([...wt].map(([p, c]) => [p, this.world.writeBlob(c)]));
    if (!script || script === 'install' || script === 'i' || script === 'ci') { out.push('added 142 packages, and audited 143 packages in 2s', 'found 0 vulnerabilities'); return 0; }
    const r = simulateRun(`npm ${args.join(' ')}`, flat, this.world);
    out.push(`> ${script}`, ...r.log.map(l => (r.ok ? l : C.red(l))));
    return r.ok ? 0 : 1;
  },
  curl(args, out) {
    const url = args.find(a => !a.startsWith('-'));
    if (!url) { out.push('curl: try \'curl --help\' for more information'); return 2; }
    const flags = args.filter(a => a.startsWith('-')).join(' ');
    const fail = /(^|\s)-[a-zA-Z]*f|--fail/.test(flags), head = /(^|\s)-[a-zA-Z]*I\b|--head/.test(flags), incl = /(^|\s)-[a-zA-Z]*i\b|--include/.test(flags);
    const r = httpGet(this.world, url);
    this.world.emit({ type: 'http', url, status: r?.status ?? null });
    if (!r) { out.push(`curl: (6) Could not resolve host: ${url.replace(/^https?:\/\//, '').split('/')[0]}`); return 6; }
    const reason = { 200: 'OK', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' }[r.status] || '';
    if (head || incl) out.push(`HTTP/2 ${r.status} ${reason}`.trim(), `content-type: ${/^[{[]/.test(r.body) ? 'application/json' : 'text/html'}`, '');
    if (fail && r.status >= 400) { out.push(`curl: (22) The requested URL returned error: ${r.status}`); return 22; }
    if (!head) out.push(...String(r.body).split('\n'));
    return 0;
  },
  node(args, out) { out.push(C.dim('(node is not available in the simulator)')); return 0; },
  open(args, out) { out.push(C.dim('(the simulator cannot open a browser; use the panels on the right)')); return 0; },
  man(args, out) { out.push(C.dim(`(no manual pages here; try the Field Guide, or \`git help\`)`)); return 0; },
  which(args, out) { for (const a of args) out.push(builtins[a] || a === 'git' || a === 'gh' ? `/usr/bin/${a}` : `${a} not found`); return 0; },
};
builtins.nano = builtins.edit;
builtins.vim = builtins.edit;
builtins.vi = builtins.edit;
builtins.code = builtins.edit;
builtins.ll = function (args, out) { return builtins.ls.call(this, ['-la', ...args], out); };

function headTail(args, out, stdin, head) {
  let n = 10; const files = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '-n') n = Number(args[++i]); else if (/^-\d+$/.test(args[i])) n = Number(args[i].slice(1)); else files.push(args[i]); }
  const text = files.length ? this.readFile(this.resolvePath(files[0])) : stdin;
  if (text === undefined) { out.push(`${head ? 'head' : 'tail'}: cannot open '${files[0]}' for reading: No such file or directory`); return 1; }
  const lines = splitLines(text ?? '');
  out.push(...(head ? lines.slice(0, n) : lines.slice(-n)));
  return 0;
}

export { builtins, headRef };
