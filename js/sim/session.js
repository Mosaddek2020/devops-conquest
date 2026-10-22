// The interactive shell session: runs parsed bash against a host, as a user, in a cwd.
// Keeps a stack of login contexts so `ssh`, `sudo -i` and `docker exec -it … sh` can
// enter another machine (or user) and `exit` comes back.

import { parse, evalArith, globToRegex, ExitSignal } from './bash.js';
import { SimError, normPath, dirname, basename } from './host.js';
import { C, stripAnsi } from '../git/world.js';
import { registry, commandAvailable, suggestPackage } from './registry.js';

class ReturnSignal { constructor(code) { this.code = code; } }
class LoopSignal { constructor(kind, n) { this.kind = kind; this.n = n; } }
class ErrexitSignal { constructor(code) { this.code = code; } }

const IFS_WS = /[ \t\n]+/;

export function access(host, user, path, want) {
  if (user === 'root') return host.stat(path) ? true : false;
  // every ancestor directory needs x
  let d = dirname(path);
  const chain = [];
  while (true) { chain.push(d); if (d === '/') break; d = dirname(d); }
  for (const a of chain) { if (host.stat(a) && !host.can(user, a, 'x')) return false; }
  return host.can(user, path, want);
}

function newEnv(host, user, cwd, base = {}) {
  const u = host.users.get(user);
  const vars = new Map();
  const set = (k, v, exported = true) => vars.set(k, { value: v, exported });
  set('HOME', u?.home || '/root');
  set('USER', user);
  set('LOGNAME', user);
  set('SHELL', '/bin/bash');
  set('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  set('HOSTNAME', host.name, false);
  set('PWD', cwd);
  set('TERM', 'xterm-256color');
  for (const [k, v] of Object.entries(host.env || {})) set(k, v);
  for (const [k, v] of Object.entries(base)) set(k, v);
  set('PS1', '\\u@\\h:\\w\\$ ', false);
  set('IFS', ' \t\n', false);
  return { host, user, cwd, vars, functions: new Map(), positional: [], scriptName: 'bash', opts: { e: false, u: false, x: false, pipefail: false }, locals: [], depth: 0, interactive: true, lastBg: '' };
}

function cloneEnv(e, { child = false } = {}) {
  const vars = new Map();
  for (const [k, v] of e.vars) if (!child || v.exported) vars.set(k, { ...v, value: Array.isArray(v.value) ? [...v.value] : v.value });
  return { ...e, vars, functions: child ? new Map() : new Map(e.functions), positional: [...e.positional], opts: { ...e.opts }, locals: [], depth: e.depth + 1 };
}

export class Session {
  constructor(uni, host, { user, cwd } = {}) {
    this.uni = uni;
    user = user || host.defaultUser;
    const home = host.users.get(user)?.home || '/root';
    this.e = newEnv(host, user, cwd || home);
    this.stack = [];          // saved contexts for ssh / sudo -i / exec
    this.history = [];
    this.lastCode = 0;
    this.jobs = [];
    this.extraCommands = {};  // labs can add commands
    this.lineHooks = [];      // fn(line, result) after each top-level command
    this.pendingAsync = [];   // output from background jobs, shown after the next command
    this.advancePerCommand = 2;
  }

  get host() { return this.e.host; }
  get user() { return this.e.user; }
  get cwd() { return this.e.cwd; }
  set cwd(v) { this.e.cwd = v; this.setVar(this.e, 'PWD', v); }
  get world() { return this.e.host; }       // git-sim compatibility
  get repo() { return this.e.host.findRepo(this.e.cwd); }

  prompt() {
    const e = this.e;
    const home = e.vars.get('HOME')?.value || '/';
    const path = e.cwd === home ? '~' : e.cwd.startsWith(home + '/') ? '~/' + e.cwd.slice(home.length + 1) : e.cwd;
    let branch = null;
    try {
      const repo = this.repo;
      if (repo && !repo.bare) {
        const ref = repo.HEAD.startsWith('ref: refs/heads/') ? repo.HEAD.slice(16) : repo.HEAD.slice(0, 7);
        branch = ref;
      }
    } catch { /* ignore */ }
    return { user: e.user, host: e.host.promptName || e.host.name, path, branch, state: null, dirty: false, root: e.user === 'root' };
  }

  resolvePath(p, e = this.e) {
    if (!p) return e.cwd;
    const home = this.getVar(e, 'HOME') || '/';
    if (p === '~') return home;
    if (p.startsWith('~/')) return normPath(home + '/' + p.slice(2));
    return p.startsWith('/') ? normPath(p) : normPath(e.cwd + '/' + p);
  }

  // ---------- variables ----------
  getVar(e, name) {
    if (/^\d+$/.test(name)) return name === '0' ? e.scriptName : e.positional[Number(name) - 1];
    switch (name) {
      case '?': return String(e.lastStatus ?? this.lastCode ?? 0);
      case '#': return String(e.positional.length);
      case '@': case '*': return e.positional.join(' ');
      case '$': return String(4242 + e.depth);
      case '!': return String(e.lastBg || '');
      case 'RANDOM': return String(Math.floor(Math.random() * 32768));
      case 'SECONDS': return String(this.uni.time % 100000);
      case 'EUID': case 'UID': return String(e.host.users.get(e.user)?.uid ?? 0);
    }
    const v = e.vars.get(name);
    if (!v) return undefined;
    return Array.isArray(v.value) ? (v.value[0] ?? '') : v.value;
  }

  setVar(e, name, value, { exported, array = false } = {}) {
    const cur = e.vars.get(name);
    if (cur?.readonly) throw new SimError(`bash: ${name}: readonly variable`, 1);
    e.vars.set(name, { value: array ? value : String(value), exported: exported ?? cur?.exported ?? false, readonly: cur?.readonly });
  }

  exportedEnv(e, extra = {}) {
    const out = {};
    for (const [k, v] of e.vars) if (v.exported) out[k] = Array.isArray(v.value) ? v.value[0] ?? '' : v.value;
    return { ...out, ...extra };
  }

  // ---------- entry points ----------
  run(line, { record = true } = {}) {
    const result = { out: [], code: 0, editor: null, clear: false, ask: null };
    if (/(^|[^\\])!!|!\$/.test(line) && this.history.length) {
      const prev = this.history[this.history.length - 1];
      line = line.replace(/!!/g, prev).replace(/!\$/g, prev.trim().split(/\s+/).pop());
      result.expanded = line;
    }
    if (record && line.trim()) this.history.push(line);
    if (!line.trim()) return result;
    const chunks = [];
    const io = { in: null, out: s => chunks.push(s), err: s => chunks.push(s) };
    let code = 0;
    try {
      const prog = parse(line);
      code = this.execList(prog, this.e, io, result);
    } catch (e) {
      code = this.handleTop(e, io);
    }
    this.lastCode = code;
    this.e.lastStatus = code;
    result.code = code;
    if (result.expanded) chunks.unshift(result.expanded + '\n');
    if (code !== 0 && !/^\s*ai\b/.test(line)) this.lastFailure = { line, out: stripAnsi(chunks.join('')), code };
    else if (code === 0 && !/^\s*ai\b/.test(line)) this.lastFailure = null;
    if (this.pendingAsync.length) chunks.push(this.pendingAsync.splice(0).join('\n') + '\n');
    result.out = toLines(chunks);
    if (this.advancePerCommand) this.uni.advance(this.advancePerCommand);
    for (const h of this.lineHooks) { try { h(line, result); } catch (err) { console.error(err); } }
    return result;
  }

  handleTop(e, io) {
    if (e instanceof ExitSignal || e instanceof ErrexitSignal) {
      if (e instanceof ExitSignal) { this.logout(io); return e.code; }
      return e.code;
    }
    if (e instanceof ReturnSignal) return e.code;
    if (e instanceof LoopSignal) return 0;
    if (e instanceof SimError) { if (e.message) io.err(C.red(e.message) + '\n'); return e.code; }
    console.error(e);
    io.err(C.red(`simulator error: ${e.message}`) + '\n');
    return 1;
  }

  logout(io) {
    if (!this.stack.length) { io.out(C.dim('(this is your own machine: there is nothing to exit to)') + '\n'); return; }
    const prev = this.stack.pop();
    const how = this.e.loginKind;
    try { this.e.onExit?.(); } catch (err) { console.error(err); }
    if (how === 'ssh') io.out(`logout\nConnection to ${this.e.host.name} closed.\n`);
    else if (how === 'exec') io.out('exit\n');
    else io.out('logout\n');
    this.e = prev;
  }

  // enter another machine or user (ssh, sudo -i, docker exec -it)
  enter(host, user, { kind = 'ssh', cwd, env = {} } = {}) {
    this.stack.push(this.e);
    const home = host.users.get(user)?.home || '/root';
    const e = newEnv(host, user, cwd || home, env);
    e.loginKind = kind;
    this.e = e;
  }

  resolveEditor(req, text) {
    const result = { out: [], code: 0, editor: null };
    const chunks = [];
    const io = { in: null, out: s => chunks.push(s), err: s => chunks.push(s) };
    try { result.code = req.onSave(text, { io, sh: this, e: this.e }) ?? 0; } catch (e) { result.code = this.handleTop(e, io); }
    result.out = toLines(chunks);
    return result;
  }

  resolveAsk(req, answer) {
    const result = { out: [], code: 0, editor: null, ask: null };
    const chunks = [];
    const io = { in: null, out: s => chunks.push(s), err: s => chunks.push(s) };
    try { result.code = req.onAnswer(answer, { io, sh: this, e: this.e, result }) ?? 0; } catch (e) { result.code = this.handleTop(e, io); }
    result.out = toLines(chunks);
    if (this.advancePerCommand) this.uni.advance(this.advancePerCommand);
    for (const h of this.lineHooks) { try { h(answer, result); } catch (err) { console.error(err); } }
    return result;
  }

  // run a script file's text as a child process (new variable scope, exported env only)
  runScript(text, e, io, { args = [], name = 'bash', result, source = false } = {}) {
    let prog;
    try { prog = parse(text); } catch (err) { io.err(`${name}: ${err.message.replace(/^bash: /, '')}\n`); return 2; }
    if (source) {
      const saved = e.positional; const savedName = e.scriptName;
      if (args.length) e.positional = args;
      try { return this.execList(prog, e, io, result); }
      catch (err) { if (err instanceof ReturnSignal) return err.code; throw err; }
      finally { e.positional = saved; e.scriptName = savedName; }
    }
    const ce = cloneEnv(e, { child: true });
    ce.positional = args; ce.scriptName = name; ce.interactive = false;
    try { return this.execList(prog, ce, io, result); }
    catch (err) {
      if (err instanceof ExitSignal || err instanceof ErrexitSignal) return err.code;
      if (err instanceof ReturnSignal) return err.code;
      if (err instanceof SimError) { io.err(`${name}: ${err.message.replace(/^bash: /, '')}\n`); return err.code || 1; }
      throw err;
    }
  }

  // ---------- execution ----------
  execList(list, e, io, result, { cond = false } = {}) {
    let code = 0;
    for (const item of list) {
      if (item.bg) { code = this.execAndOr(item, e, io, result, { cond, bg: true }); continue; }
      code = this.execAndOr(item, e, io, result, { cond });
      if (result?.editor || result?.ask) return code;
    }
    return code;
  }

  execAndOr(item, e, io, result, { cond = false, bg = false } = {}) {
    let code = this.execPipeline(item.first, e, io, result, { cond: cond || item.rest.length > 0, bg });
    for (let k = 0; k < item.rest.length; k++) {
      const { op, pipeline } = item.rest[k];
      if ((op === '&&' && code !== 0) || (op === '||' && code === 0)) continue;
      const last = k === item.rest.length - 1;
      code = this.execPipeline(pipeline, e, io, result, { cond: cond || !last, bg });
    }
    e.lastStatus = code;
    return code;
  }

  execPipeline(pl, e, io, result, { cond = false, bg = false } = {}) {
    let code;
    if (pl.cmds.length === 1) {
      code = this.execCommand(pl.cmds[0], e, io, result, { cond: cond || pl.negate, bg });
    } else {
      let input = io.in;
      const codes = [];
      for (let k = 0; k < pl.cmds.length; k++) {
        const last = k === pl.cmds.length - 1;
        const buf = [];
        const sub = cloneEnv(e);
        const stageIo = { in: input, out: last ? io.out : (s => buf.push(s)), err: pl.cmds[k].stderrToPipe && !last ? (s => buf.push(s)) : io.err };
        let c;
        try { c = this.execCommand(pl.cmds[k], sub, stageIo, result, { cond: true, bg, inPipe: true }); }
        catch (err) { if (err instanceof ExitSignal || err instanceof ErrexitSignal) c = err.code; else throw err; }
        codes.push(c);
        input = { text: buf.join('') };
      }
      code = e.opts.pipefail ? ([...codes].reverse().find(c => c !== 0) ?? 0) : codes[codes.length - 1];
    }
    if (pl.negate) code = code === 0 ? 1 : 0;
    e.lastStatus = code;
    if (code !== 0 && e.opts.e && !cond && !pl.negate) throw new ErrexitSignal(code);
    return code;
  }

  execCommand(node, e, io, result, flags = {}) {
    switch (node.kind) {
      case 'simple': return this.execSimple(node, e, io, result, flags);
      case 'funcdef': e.functions.set(node.name, node.body); return 0;
      default: {
        let rio;
        try { rio = this.applyRedirs(node.redirs || [], e, io); } catch (err) { if (err instanceof SimError) { io.err(err.message + '\n'); return 1; } throw err; }
        try { return this.execCompound(node, e, rio.io, result, flags); }
        finally { rio.flush(); }
      }
    }
  }

  execCompound(node, e, io, result, flags) {
    switch (node.kind) {
      case 'group': return this.execList(node.body, e, io, result, { cond: flags.cond });
      case 'subshell': {
        const sub = cloneEnv(e);
        try { return this.execList(node.body, sub, io, result, { cond: flags.cond }); }
        catch (err) { if (err instanceof ExitSignal || err instanceof ErrexitSignal) return err.code; throw err; }
      }
      case 'arith': {
        const v = this.arith(node.expr, e);
        return v !== 0 ? 0 : 1;
      }
      case 'if': {
        for (const cl of node.clauses) {
          const c = this.execList(cl.cond, e, io, result, { cond: true });
          if (c === 0) return this.execList(cl.body, e, io, result, { cond: flags.cond });
        }
        return node.elseBody ? this.execList(node.elseBody, e, io, result, { cond: flags.cond }) : 0;
      }
      case 'while': {
        let code = 0, guard = 0;
        while (true) {
          if (++guard > 2000) { io.err(C.red('bash: loop stopped after 2000 iterations (the simulator has no Ctrl+C for loops)') + '\n'); return 130; }
          const c = this.execList(node.cond, e, io, result, { cond: true });
          if (node.until ? c === 0 : c !== 0) break;
          try { code = this.execList(node.body, e, io, result, { cond: flags.cond }); }
          catch (err) { if (err instanceof LoopSignal) { if (err.n > 1) { err.n--; throw err; } if (err.kind === 'break') break; continue; } throw err; }
        }
        return code;
      }
      case 'for': {
        const items = node.items === null ? [...e.positional] : node.items.flatMap(w => this.expandWord(w, e));
        let code = 0;
        for (const it of items) {
          this.setVar(e, node.name, it);
          try { code = this.execList(node.body, e, io, result, { cond: flags.cond }); }
          catch (err) { if (err instanceof LoopSignal) { if (err.n > 1) { err.n--; throw err; } if (err.kind === 'break') break; continue; } throw err; }
        }
        return code;
      }
      case 'cfor': {
        let code = 0, guard = 0;
        if (node.init) this.arith(node.init, e);
        while (true) {
          if (++guard > 2000) { io.err(C.red('bash: loop stopped after 2000 iterations') + '\n'); return 130; }
          if (node.cond && this.arith(node.cond, e) === 0) break;
          try { code = this.execList(node.body, e, io, result, { cond: flags.cond }); }
          catch (err) { if (err instanceof LoopSignal) { if (err.n > 1) { err.n--; throw err; } if (err.kind === 'break') break; } else throw err; }
          if (node.step) this.arith(node.step, e);
        }
        return code;
      }
      case 'case': {
        const word = this.expandString(node.word, e);
        for (let k = 0; k < node.arms.length; k++) {
          const arm = node.arms[k];
          if (arm.pats.some(p => globToRegex(this.expandPattern(p, e)).test(word))) {
            let code = this.execList(arm.body, e, io, result, { cond: flags.cond });
            while (arm.fall && node.arms[k + 1]) { k++; code = this.execList(node.arms[k].body, e, io, result, { cond: flags.cond }); }
            return code;
          }
        }
        return 0;
      }
    }
    return 0;
  }

  arith(expr, e) {
    const expanded = this.expandString(expr, e, { arith: true });
    return evalArith(expanded, n => this.getVar(e, n) ?? '', (n, v) => this.setVar(e, n, String(v)));
  }

  // ---------- simple commands ----------
  execSimple(node, e, io, result, flags) {
    e.__subStatus = undefined;
    // expand words
    let argv = [];
    try {
      if (node.dbracket) argv = ['[[', ...node.words.slice(1, -1).map(w => ({ raw: w })), ']]'];
      else for (const w of node.words) argv.push(...this.expandWord(w, e));
    } catch (err) {
      if (err instanceof SimError) { io.err(err.message + '\n'); if (!e.interactive) throw new ExitSignal(1); return 1; }
      throw err;
    }
    // assignments
    const assigns = [];
    for (const a of node.assigns) {
      const m = a.match(/^([A-Za-z_]\w*)(\[([^\]]*)\])?(\+?)=([\s\S]*)$/);
      let val;
      if (m[5].startsWith('(') && m[5].endsWith(')') && !m[2]) {
        const inner = m[5].slice(1, -1);
        val = { array: inner.trim() ? inner.trim().split(/\s+/).flatMap(w => this.expandWord(w, e)) : [] };
      } else val = this.expandString(m[5], e, { assign: true });
      assigns.push({ name: m[1], idx: m[3], append: m[4] === '+', val });
    }
    if (this.pendingErr?.length) io.err(this.pendingErr.splice(0).join(''));
    if (!argv.length) {
      for (const a of assigns) this.assign(e, a);
      // an assignment's status is that of its last command substitution (so set -e sees failures)
      if (e.__subStatus !== undefined) { const st = e.__subStatus; e.__subStatus = undefined; if (node.redirs.length) { try { const r = this.applyRedirs(node.redirs, e, io); r.flush(); } catch (err) { if (err instanceof SimError) { io.err(err.message + '\n'); return 1; } throw err; } } return st; }
      if (node.redirs.length) { try { const r = this.applyRedirs(node.redirs, e, io); r.flush(); } catch (err) { if (err instanceof SimError) { io.err(err.message + '\n'); return 1; } throw err; } }
      return 0;
    }
    if (e.opts.x) io.err('+ ' + argv.map(a => typeof a === 'string' ? (/\s/.test(a) ? `'${a}'` : a) : a.raw).join(' ') + '\n');
    let rio;
    try { rio = this.applyRedirs(node.redirs, e, io); } catch (err) { if (err instanceof SimError) { io.err(err.message + '\n'); e.lastStatus = 1; return 1; } throw err; }
    try {
      const tempEnv = {};
      for (const a of assigns) tempEnv[a.name] = typeof a.val === 'string' ? a.val : a.val.array.join(' ');
      const code = this.invoke(argv, e, rio.io, result, { ...flags, tempEnv });
      e.lastStatus = code;
      return code;
    } finally { rio.flush(); }
  }

  assign(e, a) {
    if (typeof a.val === 'object') { this.setVar(e, a.name, a.append ? [...this.getArray(e, a.name), ...a.val.array] : a.val.array, { array: true }); return; }
    if (a.idx !== undefined) {
      const arr = this.getArray(e, a.name);
      const i = Number(this.arith(a.idx, e));
      arr[i] = a.val;
      this.setVar(e, a.name, arr, { array: true });
      return;
    }
    const cur = this.getVar(e, a.name) ?? '';
    this.setVar(e, a.name, a.append ? cur + a.val : a.val);
  }

  getArray(e, name) {
    const v = e.vars.get(name);
    if (!v) return [];
    return Array.isArray(v.value) ? [...v.value] : [v.value];
  }

  invoke(argv, e, io, result, flags = {}) {
    const [name, ...args] = argv;
    if (typeof name !== 'string') return 0;
    // aliases (simple: only the command word)
    if (e.aliases?.[name] && !flags.noAlias) return this.runIn(e.aliases[name] + ' ' + args.map(a => /[\s'"$]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a).join(' '), e, io, result);
    // shell functions
    if (e.functions.has(name)) return this.callFunction(name, args, e, io, result);
    // shell builtins (need the env)
    const sb = SHELL_BUILTINS[name];
    if (sb) return sb.call(this, args, e, io, result, flags);
    // scripts and binaries given by path
    if (name.includes('/')) return this.execPath(name, args, e, io, result, flags);
    // labs' extra commands
    const extra = this.extraCommands[name];
    if (extra) return this.callCommand(extra, name, args, e, io, result, flags);
    // executable files on PATH (user scripts in /usr/local/bin …)
    const onPath = this.findOnPath(name, e);
    const cmd = registry[name];
    if (onPath && (!cmd || onPath.startsWith('/usr/local/'))) return this.execPath(onPath, args, e, io, result, flags);
    if (cmd && commandAvailable(e.host, name)) return this.callCommand(cmd, name, args, e, io, result, flags);
    const pkg = suggestPackage(name);
    if (pkg && cmd) io.err(`Command '${name}' not found, but can be installed with:\n  sudo apt install ${pkg}\n`);
    else io.err(`${name}: command not found\n`);
    return 127;
  }

  findOnPath(name, e) {
    const path = (this.getVar(e, 'PATH') || '').split(':');
    for (const d of path) {
      const p = normPath(d + '/' + name);
      if (e.host.files.has(p)) return p;
    }
    return null;
  }

  callFunction(name, args, e, io, result) {
    const body = e.functions.get(name);
    const saved = e.positional;
    e.positional = args;
    e.locals.push(new Map());
    try { return this.execCommand(body, e, io, result, {}); }
    catch (err) { if (err instanceof ReturnSignal) return err.code; throw err; }
    finally {
      const frame = e.locals.pop();
      for (const [k, v] of frame) { if (v === undefined) e.vars.delete(k); else e.vars.set(k, v); }
      e.positional = saved;
    }
  }

  callCommand(fn, name, args, e, io, result, flags = {}) {
    const self = this;
    const c = {
      name, args, sh: this, e, uni: this.uni, host: e.host, user: e.user, cwd: e.cwd, result,
      get stdin() { if (this._stdin === undefined) { this._stdin = io.in ? io.in.text : null; if (io.in) io.in.text = ''; } return this._stdin; },
      bg: !!flags.bg, inPipe: !!flags.inPipe,
      env: this.exportedEnv(e, flags.tempEnv || {}),
      out: s => io.out(s),
      err: s => io.err(s),
      print: (...lines) => { for (const l of lines) io.out(String(l) + '\n'); },
      eprint: (...lines) => { for (const l of lines) io.err(String(l) + '\n'); },
      fail: (msg, code = 1) => { if (msg) io.err(String(msg) + '\n'); return code; },
      resolve: p => self.resolvePath(p, e),
      runLine: (line, opts = {}) => self.runIn(line, opts.e || e, opts.io || io, result),
      io,
    };
    try { return fn(c) ?? 0; }
    catch (err) {
      if (err instanceof SimError) { if (err.message) io.err(err.message + '\n'); return err.code; }
      if (err instanceof ExitSignal || err instanceof ErrexitSignal || err instanceof ReturnSignal || err instanceof LoopSignal) throw err;
      console.error(err);
      io.err(C.red(`simulator error in ${name}: ${err.message}`) + '\n');
      return 1;
    }
  }

  // run a command line inside a given env (used by sudo, xargs, find -exec, watch, ssh host cmd)
  runIn(line, e, io, result) {
    let prog;
    try { prog = parse(line); } catch (err) { io.err(err.message + '\n'); return 2; }
    try { return this.execList(prog, e, io, result); }
    catch (err) {
      if (err instanceof ExitSignal || err instanceof ErrexitSignal) return err.code;
      if (err instanceof SimError) { io.err(err.message + '\n'); return err.code; }
      throw err;
    }
  }

  runArgv(argv, e, io, result, flags) { return this.invoke(argv, e, io, result, flags); }

  execPath(path, args, e, io, result, flags = {}) {
    const abs = this.resolvePath(path, e);
    const host = e.host;
    const s = host.stat(abs);
    if (!s) { io.err(`bash: ${path}: No such file or directory\n`); return 127; }
    if (s.type === 'dir') { io.err(`bash: ${path}: Is a directory\n`); return 126; }
    if (!access(host, e.user, abs, 'x')) { io.err(`bash: ${path}: Permission denied\n`); return 126; }
    if (!access(host, e.user, abs, 'r')) { io.err(`bash: ${path}: Permission denied\n`); return 126; }
    const text = host.files.get(abs);
    const first = text.split('\n')[0];
    if (first.startsWith('#!')) {
      const interp = first.slice(2).trim();
      if (/\b(bash|sh|zsh|dash)\b/.test(interp)) return this.runScript(text, withTemp(e, flags.tempEnv), io, { args, name: path, result });
      const prog = interp.split(/\s+/).pop().split('/').pop();
      const cmd = registry[prog];
      if (cmd && commandAvailable(host, prog)) return this.callCommand(cmd, prog, [abs, ...args], e, io, result, flags);
      io.err(`bash: ${path}: ${interp}: bad interpreter: No such file or directory\n`);
      return 126;
    }
    return this.runScript(text, withTemp(e, flags.tempEnv), io, { args, name: path, result });
  }

  // ---------- redirections ----------
  applyRedirs(redirs, e, io) {
    let out = io.out, err = io.err, stdin = io.in;
    const flushes = [];
    const host = e.host;
    const openWrite = (target, append) => {
      if (target === '/dev/null') return () => {};
      if (target === '/dev/stderr') return err;
      if (target === '/dev/stdout') return out;
      const abs = this.resolvePath(target, e);
      const st = host.stat(abs);
      if (st?.type === 'dir') throw new SimError(`bash: ${target}: Is a directory`, 1);
      if (st) { if (!access(host, e.user, abs, 'w')) throw new SimError(`bash: ${target}: Permission denied`, 1); }
      else {
        const parent = dirname(abs);
        if (!host.isDir(parent)) throw new SimError(`bash: ${target}: No such file or directory`, 1);
        if (!access(host, e.user, parent, 'w')) throw new SimError(`bash: ${target}: Permission denied`, 1);
      }
      if (!append || !st) { host.writeFile(abs, append && st ? host.files.get(abs) : '', e.user); if (!append) host.fakeSizes?.delete(host.realPath(abs)); }
      const buf = [];
      flushes.push(() => { const cur = host.files.get(abs) ?? ''; host.writeFile(abs, cur + stripAnsi(buf.join('')), e.user); host.uni.emit({ type: 'file-write', host: host.name, path: abs }); });
      const w = s => buf.push(s);
      w.path = abs;
      return w;
    };
    for (const r of redirs) {
      const fd = r.fd;
      switch (r.op) {
        case '>': case '>|': case '>>': {
          const target = this.expandString(r.target, e);
          const w = openWrite(target, r.op === '>>');
          if (fd === 2) err = w; else out = w;
          break;
        }
        case '&>': case '&>>': { const w = openWrite(this.expandString(r.target, e), r.op === '&>>'); out = w; err = w; break; }
        case '>&': {
          const t = r.target;
          if (t === '1') { if (fd === 2) err = out; }
          else if (t === '2') { if (fd === 2) { /* no-op */ } else out = err; }
          else if (t === '-') { /* close: ignore */ }
          else { const w = openWrite(this.expandString(t, e), false); out = w; err = w; }
          break;
        }
        case '<': {
          const target = this.expandString(r.target, e);
          if (target === '/dev/null') { stdin = { text: '' }; break; }
          const abs = this.resolvePath(target, e);
          if (!host.files.has(abs)) throw new SimError(`bash: ${target}: No such file or directory`, 1);
          if (!access(host, e.user, abs, 'r')) throw new SimError(`bash: ${target}: Permission denied`, 1);
          stdin = { text: host.files.get(abs) };
          break;
        }
        case '<<': stdin = { text: r.quoted ? r.body : this.expandString(r.body, e, { heredoc: true }) }; break;
        case '<<<': stdin = { text: this.expandString(r.target, e) + '\n' }; break;
        case '<&': break;
      }
    }
    return { io: { in: stdin, out, err }, flush: () => { for (const f of flushes) f(); } };
  }

  // ---------- expansion ----------
  // Returns a list of fields (strings) after expansion, splitting and globbing.
  expandWord(raw, e) {
    const pieces = this.expandPieces(raw, e);
    // field splitting
    const fields = [];
    let cur = null; // { text, pattern, glob, quoted }
    const start = () => { if (!cur) cur = { text: '', pattern: '', glob: false, quoted: false }; };
    for (const pc of pieces) {
      if (pc.fields) { // "$@"
        if (!pc.fields.length) { continue; }
        pc.fields.forEach((f, k) => {
          if (k > 0) { fields.push(cur); cur = null; }
          start(); cur.text += f; cur.pattern += escapeGlob(f); cur.quoted = true;
        });
        continue;
      }
      if (pc.split) {
        const ifs = this.getVar(e, 'IFS') ?? ' \t\n';
        const parts = ifs === '' ? [pc.text] : pc.text.split(IFS_WS);
        parts.forEach((part, k) => {
          if (k > 0) { if (cur && (cur.text !== '' || cur.quoted)) fields.push(cur); cur = null; }
          if (part === '') return;
          start(); cur.text += part; cur.pattern += part; if (/[*?[]/.test(part)) cur.glob = true;
        });
        continue;
      }
      start();
      cur.text += pc.text;
      if (pc.quoted) { cur.quoted = true; cur.pattern += escapeGlob(pc.text); }
      else { cur.pattern += pc.text; if (/[*?[]/.test(pc.text)) cur.glob = true; }
    }
    if (cur && (cur.text !== '' || cur.quoted)) fields.push(cur);
    const out = [];
    for (const f of fields) {
      if (f.glob) {
        const matches = this.glob(f.pattern, e);
        if (matches.length) { out.push(...matches); continue; }
        out.push(unescapeGlob(f.pattern));
        continue;
      }
      out.push(f.text);
    }
    return out;
  }

  // expand without splitting or globbing (assignments, redirect targets, here-docs, case words)
  expandString(raw, e, { heredoc = false, assign = false, arith = false } = {}) {
    return this.expandPieces(raw, e, { heredoc, assign, arith }).map(p => p.fields ? p.fields.join(' ') : p.text).join('');
  }

  expandPattern(raw, e) {
    return this.expandPieces(raw, e).map(p => p.quoted ? escapeGlob(p.text) : p.fields ? p.fields.join(' ') : p.text).join('');
  }

  expandPieces(raw, e, { heredoc = false, assign = false, arith = false } = {}) {
    const pieces = [];
    const lit = (text, quoted) => pieces.push({ text, quoted });
    let i = 0;
    const n = raw.length;
    // tilde
    if (!heredoc && !arith && raw[0] === '~') {
      const m = raw.match(/^~([a-z_][\w-]*)?(?=\/|$|:)/);
      if (m) {
        const home = m[1] ? e.host.users.get(m[1])?.home : this.getVar(e, 'HOME');
        if (home) { lit(home, true); i = m[0].length; }
      }
    }
    let buf = '';
    const flush = (quoted = false) => { if (buf) { lit(buf, quoted); buf = ''; } };
    while (i < n) {
      const c = raw[i];
      if (!heredoc && c === "'" ) {
        if (arith) { buf += c; i++; continue; }
        flush(); const j = raw.indexOf("'", i + 1); lit(raw.slice(i + 1, j), true); i = j + 1; continue;
      }
      if (!heredoc && c === '$' && raw[i + 1] === "'") {
        flush(); const j = raw.indexOf("'", i + 2); lit(ansiC(raw.slice(i + 2, j)), true); i = j + 1; continue;
      }
      if (!heredoc && c === '"') {
        flush();
        const j = findDoubleEnd(raw, i);
        const inner = raw.slice(i + 1, j);
        const sub = this.expandDouble(inner, e);
        if (sub.length === 0) lit('', true);
        else pieces.push(...sub);
        i = j + 1; continue;
      }
      if (c === '\\') {
        if (heredoc) { const nx = raw[i + 1]; if ('$`\\'.includes(nx)) { buf += nx; i += 2; continue; } buf += c; i++; continue; }
        flush(); lit(raw[i + 1] ?? '', true); i += 2; continue;
      }
      if (c === '$' || c === '`') {
        const r = this.expandDollar(raw, i, e, !heredoc && !assign);
        if (r) { flush(); if (heredoc) r.piece.split = false; if (assign) r.piece.split = false; pieces.push(r.piece); i = r.end; continue; }
      }
      buf += c; i++;
    }
    flush(false);
    if (heredoc) for (const p of pieces) { p.quoted = true; p.split = false; }
    return pieces;
  }

  expandDouble(inner, e) {
    const pieces = [];
    let buf = '';
    let i = 0;
    const flush = () => { if (buf) { pieces.push({ text: buf, quoted: true }); buf = ''; } };
    while (i < inner.length) {
      const c = inner[i];
      if (c === '\\' && '$`"\\\n'.includes(inner[i + 1])) { buf += inner[i + 1] === '\n' ? '' : inner[i + 1]; i += 2; continue; }
      if (c === '$' || c === '`') {
        if (inner.startsWith('$@', i) || inner.startsWith('${@}', i)) { flush(); pieces.push({ fields: [...e.positional], quoted: true }); i += inner.startsWith('$@', i) ? 2 : 4; continue; }
        const m = inner.slice(i).match(/^\$\{(\w+)\[@\]\}/);
        if (m) { flush(); pieces.push({ fields: this.getArray(e, m[1]), quoted: true }); i += m[0].length; continue; }
        const r = this.expandDollar(inner, i, e, false);
        if (r) { flush(); r.piece.quoted = true; r.piece.split = false; pieces.push(r.piece); i = r.end; continue; }
      }
      buf += c; i++;
    }
    flush();
    return pieces;
  }

  // expand $… or `…` at raw[i]; returns { piece, end } or null
  expandDollar(raw, i, e, splittable) {
    if (raw[i] === '`') {
      const j = raw.indexOf('`', i + 1);
      return { piece: { text: this.cmdSub(raw.slice(i + 1, j), e), split: splittable }, end: j + 1 };
    }
    const nx = raw[i + 1];
    if (nx === '(' && raw[i + 2] === '(') {
      const j = findArithEnd(raw, i + 1);
      if (j !== -1) {
        const v = this.arith(raw.slice(i + 3, j - 1), e);
        return { piece: { text: String(v), split: splittable }, end: j + 1 };
      }
    }
    if (nx === '(') {
      const j = findParenEnd(raw, i + 1);
      return { piece: { text: this.cmdSub(raw.slice(i + 2, j), e), split: splittable }, end: j + 1 };
    }
    if (nx === '{') {
      const j = findBraceEnd(raw, i + 1);
      const inner = raw.slice(i + 2, j);
      return { piece: this.paramExpand(inner, e, splittable), end: j + 1 };
    }
    const m = raw.slice(i + 1).match(/^([A-Za-z_]\w*|\d|[?#@*$!])/);
    if (!m) return null;
    const name = m[1];
    if (name === '@' || name === '*') return { piece: splittable ? { text: e.positional.join(' '), split: true } : { text: e.positional.join(' '), split: false }, end: i + 1 + name.length };
    const v = this.getVar(e, name);
    if (v === undefined && e.opts.u && !/^[?#@*$!0]$/.test(name)) throw new SimError(`bash: ${name}: unbound variable`, 1);
    return { piece: { text: v ?? '', split: splittable }, end: i + 1 + name.length };
  }

  paramExpand(inner, e, splittable) {
    const piece = text => ({ text, split: splittable });
    let m;
    if ((m = inner.match(/^#(\w+)\[[@*]\]$/))) return piece(String(this.getArray(e, m[1]).length));
    if ((m = inner.match(/^#(\w+|[@*])$/))) {
      if (m[1] === '@' || m[1] === '*') return piece(String(e.positional.length));
      return piece(String((this.getVar(e, m[1]) ?? '').length));
    }
    if ((m = inner.match(/^(\w+)\[([@*])\]$/))) return { text: this.getArray(e, m[1]).join(' '), split: splittable };
    if ((m = inner.match(/^(\w+)\[([^\]]+)\]$/))) { const arr = this.getArray(e, m[1]); return piece(arr[this.arith(m[2], e)] ?? ''); }
    if ((m = inner.match(/^!(\w+)$/))) return piece(this.getVar(e, this.getVar(e, m[1]) ?? '') ?? '');
    m = inner.match(/^(\w+|[@*#?$!])([\s\S]*)$/);
    if (!m) throw new SimError(`bash: \${${inner}}: bad substitution`, 1);
    const [, name, rest] = m;
    const val = this.getVar(e, name);
    const unset = val === undefined;
    const empty = unset || val === '';
    const word = s => this.expandString(s, e);
    if (rest === '') {
      if (unset && e.opts.u && !/^[@*#?$!]$/.test(name)) throw new SimError(`bash: ${name}: unbound variable`, 1);
      return piece(val ?? '');
    }
    let r;
    if ((r = rest.match(/^(:?)([-=?+])([\s\S]*)$/))) {
      const test = r[1] ? empty : unset;
      switch (r[2]) {
        case '-': return piece(test ? word(r[3]) : val);
        case '=': if (test) { const v = word(r[3]); this.setVar(e, name, v); return piece(v); } return piece(val);
        case '?': if (test) throw new SimError(`bash: ${name}: ${word(r[3]) || 'parameter null or not set'}`, 1); return piece(val);
        case '+': return piece(test ? '' : word(r[3]));
      }
    }
    const v = val ?? '';
    if ((r = rest.match(/^:(-?\d+|\s*-\d+|[^:]+)(?::([^]*))?$/)) && !/^[-=?+]/.test(rest.slice(1))) {
      let off = this.arith(r[1], e);
      if (off < 0) off = Math.max(0, v.length + off);
      const len = r[2] !== undefined ? this.arith(r[2], e) : undefined;
      return piece(len === undefined ? v.slice(off) : len < 0 ? v.slice(off, v.length + len) : v.substr(off, len));
    }
    if ((r = rest.match(/^(##?|%%?)([\s\S]*)$/))) {
      const pat = this.expandPattern(r[2], e);
      const re = globToRegex(pat);
      if (r[1] === '#' || r[1] === '##') {
        const lens = [...Array(v.length + 1).keys()];
        if (r[1] === '##') lens.reverse();
        for (const k of lens) if (re.test(v.slice(0, k))) return piece(v.slice(k));
        return piece(v);
      }
      const lens = [...Array(v.length + 1).keys()];
      if (r[1] === '%') lens.reverse();
      for (const k of lens) if (re.test(v.slice(k))) return piece(v.slice(0, k));
      return piece(v);
    }
    if ((r = rest.match(/^\/(\/?)([^/]*)(?:\/([\s\S]*))?$/))) {
      const all = r[1] === '/';
      const pat = this.expandPattern(r[2], e);
      const rep = r[3] !== undefined ? word(r[3]) : '';
      const re = new RegExp(globToRegex(pat, { anchored: false }).source, all ? 'g' : '');
      return piece(v.replace(re, () => rep));
    }
    if (rest === '^^') return piece(v.toUpperCase());
    if (rest === ',,') return piece(v.toLowerCase());
    if (rest === '^') return piece(v.charAt(0).toUpperCase() + v.slice(1));
    if (rest === ',') return piece(v.charAt(0).toLowerCase() + v.slice(1));
    throw new SimError(`bash: \${${inner}}: bad substitution`, 1);
  }

  cmdSub(src, e) {
    const chunks = [];
    const sub = cloneEnv(e);
    const io = { in: null, out: s => chunks.push(s), err: s => this.pendingErr?.push(s) };
    this.pendingErr = this.pendingErr || [];
    let code = 0;
    try { code = this.execList(parse(src), sub, io, { editor: null }); }
    catch (err) {
      if (err instanceof ExitSignal || err instanceof ErrexitSignal) code = err.code;
      else if (err instanceof SimError) { this.pendingErr.push(err.message + '\n'); code = err.code; }
      else throw err;
    }
    e.lastStatus = code;
    e.__subStatus = code;
    return stripAnsi(chunks.join('')).replace(/\n+$/, '');
  }

  glob(pattern, e) {
    const abs = pattern.startsWith('/');
    const base = abs ? '/' : e.cwd;
    const segs = pattern.split('/').filter((s, k) => s !== '' || k === 0);
    let paths = [abs ? '' : null];
    const host = e.host;
    for (let k = 0; k < segs.length; k++) {
      const seg = segs[k];
      if (seg === '' && k === 0) continue;
      const next = [];
      for (const p of paths) {
        const dirAbs = p === null ? base : (p === '' ? '/' : (p.startsWith('/') ? p : normPath(base + '/' + p)));
        if (!/[*?[]/.test(seg)) { const cand = p === null ? seg : p + '/' + seg; const candAbs = cand.startsWith('/') ? cand : normPath(base + '/' + cand); if (host.stat(candAbs)) next.push(cand.replace(/^\/\//, '/')); continue; }
        if (!host.isDir(dirAbs)) continue;
        const re = globToRegex(seg, { dotAll: false });
        for (const [nm] of host.listDir(dirAbs)) {
          if (nm.startsWith('.') && !seg.startsWith('.')) continue;
          if (re.test(nm)) next.push(p === null ? nm : (p === '' ? '/' + nm : p + '/' + nm));
        }
      }
      paths = next;
    }
    return paths.filter(p => p !== null).map(p => p.replace(/\\(.)/g, '$1')).sort();
  }
}

function withTemp(e, tempEnv) {
  if (!tempEnv || !Object.keys(tempEnv).length) return e;
  const c = { ...e, vars: new Map(e.vars) };
  for (const [k, v] of Object.entries(tempEnv)) c.vars.set(k, { value: v, exported: true });
  return c;
}

function toLines(chunks) {
  const text = chunks.join('');
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const escapeGlob = s => s.replace(/[*?[\]\\]/g, '\\$&');
const unescapeGlob = s => s.replace(/\\(.)/g, '$1');

function ansiC(s) {
  return s.replace(/\\(n|t|r|e|\\|'|"|0)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', e: '\x1b', '\\': '\\', "'": "'", '"': '"', 0: '\0' })[c]);
}

function findDoubleEnd(s, i) {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '"') return j;
    if (s[j] === '$' && s[j + 1] === '(') { j = findParenEnd(s, j + 1) + 1; continue; }
    if (s[j] === '`') { j = s.indexOf('`', j + 1) + 1; continue; }
    j++;
  }
  return s.length;
}
function findParenEnd(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { const k = s.indexOf("'", j + 1); if (k !== -1) j = k; continue; }
    if (c === '"') { j = findDoubleEnd(s, j); continue; }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (depth === 0) return j; }
  }
  return s.length;
}
function findArithEnd(s, i) {
  // s[i] === '(' and s[i+1] === '('; find matching '))'
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '(') depth++;
    if (s[j] === ')') { depth--; if (depth === 0) return s[j - 1] === ')' ? j : -1; }
  }
  return -1;
}
function findBraceEnd(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return j; }
  }
  return s.length;
}

// ---------------------------------------------------------------- shell builtins

function parseTest(args, sh, e) {
  // returns boolean; supports [ ] test [[ ]] semantics
  const host = e.host;
  const abs = p => sh.resolvePath(p, e);
  let i = 0;
  const peek = () => args[i];
  function primary() {
    const a = args[i];
    if (a === '!') { i++; return !primary(); }
    if (a === '(') { i++; const v = or(); if (args[i] === ')') i++; return v; }
    const unary = { '-e': p => !!host.stat(abs(p)), '-f': p => host.stat(abs(p))?.type === 'file', '-d': p => host.stat(abs(p))?.type === 'dir', '-s': p => (host.stat(abs(p))?.size || 0) > 0 && host.stat(abs(p))?.type === 'file', '-r': p => access(host, e.user, abs(p), 'r'), '-w': p => access(host, e.user, abs(p), 'w'), '-x': p => access(host, e.user, abs(p), 'x'), '-L': () => false, '-h': () => false, '-z': s => s === '', '-n': s => s !== '', '-v': n => e.vars.has(n) };
    if (unary[a] && i + 1 < args.length && !['=', '==', '!=', '-eq', '-ne', '-lt', '-gt', '-le', '-ge', '=~'].includes(args[i + 1])) { i += 2; return unary[a](args[i - 1]); }
    const l = args[i++];
    const op = args[i];
    const bin = ['=', '==', '!=', '-eq', '-ne', '-lt', '-gt', '-le', '-ge', '<', '>', '=~', '-nt', '-ot'];
    if (bin.includes(op)) {
      i++;
      const r = args[i++] ?? '';
      const num = x => { if (!/^\s*-?\d+\s*$/.test(x)) throw new SimError(`bash: [: ${x}: integer expression expected`, 2); return Number(x); };
      switch (op) {
        case '=': case '==': return e.__dbl ? globToRegex(r).test(l) : l === r;
        case '!=': return e.__dbl ? !globToRegex(r).test(l) : l !== r;
        case '-eq': return num(l) === num(r); case '-ne': return num(l) !== num(r);
        case '-lt': return num(l) < num(r); case '-gt': return num(l) > num(r);
        case '-le': return num(l) <= num(r); case '-ge': return num(l) >= num(r);
        case '<': return l < r; case '>': return l > r;
        case '=~': { const m = l.match(new RegExp(r)); if (m) sh.setVar(e, 'BASH_REMATCH', [...m], { array: true }); return !!m; }
      }
    }
    return l !== undefined && l !== '';
  }
  function and() { let v = primary(); while (args[i] === '-a' || args[i] === '&&') { i++; const r = primary(); v = v && r; } return v; }
  function or() { let v = and(); while (args[i] === '-o' || args[i] === '||') { i++; const r = and(); v = v || r; } return v; }
  if (!args.length) return false;
  const v = or();
  void peek;
  return v;
}

const SHELL_BUILTINS = {
  ':'() { return 0; },
  true() { return 0; },
  false() { return 1; },
  echo(args, e, io) {
    let nl = true, esc = false;
    while (args[0] && /^-[neE]+$/.test(args[0])) { if (args[0].includes('n')) nl = false; if (args[0].includes('e')) esc = true; if (args[0].includes('E')) esc = false; args = args.slice(1); }
    let s = args.join(' ');
    if (esc) s = ansiC(s);
    io.out(s + (nl ? '\n' : ''));
    return 0;
  },
  printf(args, e, io) {
    if (args[0] === '--') args = args.slice(1);
    if (!args.length) { io.err('printf: usage: printf format [arguments]\n'); return 2; }
    let [fmt, ...rest] = args;
    if (fmt === '-v') { const name = rest[0]; const out = formatPrintf(rest[1], rest.slice(2)); this.setVar(e, name, out); return 0; }
    io.out(formatPrintf(fmt, rest));
    return 0;
  },
  cd(args, e, io) {
    let target = args.filter(a => a !== '--')[0];
    if (target === undefined) target = this.getVar(e, 'HOME');
    if (target === '-') { target = this.getVar(e, 'OLDPWD') || e.cwd; io.out(target + '\n'); }
    const abs = this.resolvePath(target, e);
    const st = e.host.stat(abs);
    if (!st) { io.err(`bash: cd: ${target}: No such file or directory\n`); return 1; }
    if (st.type !== 'dir') { io.err(`bash: cd: ${target}: Not a directory\n`); return 1; }
    if (!access(e.host, e.user, abs, 'x')) { io.err(`bash: cd: ${target}: Permission denied\n`); return 1; }
    this.setVar(e, 'OLDPWD', e.cwd, { exported: true });
    e.cwd = abs;
    this.setVar(e, 'PWD', abs, { exported: true });
    return 0;
  },
  pwd(args, e, io) { io.out(e.cwd + '\n'); return 0; },
  export(args, e, io) {
    if (!args.length || args[0] === '-p') { for (const [k, v] of [...e.vars].filter(([, v]) => v.exported).sort()) io.out(`declare -x ${k}="${Array.isArray(v.value) ? v.value.join(' ') : v.value}"\n`); return 0; }
    for (const a of args) {
      if (a === '-n') continue;
      const m = a.match(/^([A-Za-z_]\w*)(?:=([\s\S]*))?$/);
      if (!m) { io.err(`bash: export: \`${a}': not a valid identifier\n`); return 1; }
      const cur = e.vars.get(m[1]);
      this.setVar(e, m[1], m[2] !== undefined ? m[2] : (cur ? cur.value : ''), { exported: true, array: cur && Array.isArray(cur.value) && m[2] === undefined });
    }
    return 0;
  },
  unset(args, e) { for (const a of args.filter(x => !x.startsWith('-'))) { e.vars.delete(a); e.functions.delete(a); } return 0; },
  readonly(args, e) { for (const a of args) { const m = a.match(/^(\w+)(?:=(.*))?$/); if (!m) continue; if (m[2] !== undefined) this.setVar(e, m[1], m[2]); const v = e.vars.get(m[1]) || { value: '', exported: false }; v.readonly = true; e.vars.set(m[1], v); } return 0; },
  local(args, e, io) {
    const frame = e.locals[e.locals.length - 1];
    if (!frame) { io.err('bash: local: can only be used in a function\n'); return 1; }
    for (const a of args) {
      if (a.startsWith('-')) continue;
      const m = a.match(/^([A-Za-z_]\w*)(?:=([\s\S]*))?$/);
      if (!m) continue;
      if (!frame.has(m[1])) frame.set(m[1], e.vars.get(m[1]));
      e.vars.set(m[1], { value: m[2] ?? '', exported: false });
    }
    return 0;
  },
  declare(args, e, io) {
    const flags = args.filter(a => a.startsWith('-')).join('');
    const names = args.filter(a => !a.startsWith('-'));
    if (!names.length) { for (const [k, v] of [...e.vars].sort()) io.out(`${k}=${Array.isArray(v.value) ? '(' + v.value.join(' ') + ')' : v.value}\n`); return 0; }
    for (const a of names) {
      const m = a.match(/^([A-Za-z_]\w*)(?:=([\s\S]*))?$/);
      if (!m) continue;
      const frame = e.locals[e.locals.length - 1];
      if (frame && !flags.includes('g') && !frame.has(m[1])) frame.set(m[1], e.vars.get(m[1]));
      if (flags.includes('a')) this.setVar(e, m[1], m[2] ? m[2].replace(/^\(|\)$/g, '').split(/\s+/).filter(Boolean) : [], { array: true });
      else this.setVar(e, m[1], m[2] ?? '', { exported: flags.includes('x') });
      if (flags.includes('r')) e.vars.get(m[1]).readonly = true;
    }
    return 0;
  },
  typeset(args, e, io, r) { return SHELL_BUILTINS.declare.call(this, args, e, io, r); },
  set(args, e, io) {
    if (!args.length) { for (const [k, v] of [...e.vars].sort()) io.out(`${k}=${Array.isArray(v.value) ? v.value.join(' ') : v.value}\n`); return 0; }
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { e.positional = args.slice(i + 1); break; }
      if (a === '-o' || a === '+o') { const opt = args[++i]; const on = a === '-o'; if (opt === 'pipefail') e.opts.pipefail = on; else if (opt === 'errexit') e.opts.e = on; else if (opt === 'nounset') e.opts.u = on; else if (opt === 'xtrace') e.opts.x = on; continue; }
      if (/^[-+][euxvo]+$/.test(a)) {
        const on = a[0] === '-';
        for (const f of a.slice(1)) {
          if (f === 'o') { const opt = args[++i]; if (opt === 'pipefail') e.opts.pipefail = on; else if (opt === 'errexit') e.opts.e = on; else if (opt === 'nounset') e.opts.u = on; else if (opt === 'xtrace') e.opts.x = on; continue; }
          if (f in e.opts) e.opts[f] = on;
        }
        continue;
      }
      e.positional = args.slice(i); break;
    }
    return 0;
  },
  shift(args, e) { const k = Number(args[0] || 1); if (k > e.positional.length) return 1; e.positional = e.positional.slice(k); return 0; },
  return(args, e) { throw new ReturnSignal(args[0] !== undefined ? Number(args[0]) : (e.lastStatus || 0)); },
  exit(args, e) { throw new ExitSignal(args[0] !== undefined ? (Number(args[0]) & 255) : (e.lastStatus || 0)); },
  logout(args, e) { throw new ExitSignal(0); },
  break(args) { throw new LoopSignal('break', Number(args[0] || 1)); },
  continue(args) { throw new LoopSignal('continue', Number(args[0] || 1)); },
  test(args, e, io) { try { return parseTest(args, this, e) ? 0 : 1; } catch (err) { io.err(err.message + '\n'); return 2; } },
  '['(args, e, io) {
    if (args[args.length - 1] !== ']') { io.err("bash: [: missing `]'\n"); return 2; }
    try { return parseTest(args.slice(0, -1), this, e) ? 0 : 1; } catch (err) { io.err(err.message + '\n'); return 2; }
  },
  '[['(args, e, io) {
    // args are raw tokens; expand each without splitting/globbing; right side of == stays a pattern
    const raw = args.slice(0, -1).map(a => a.raw ?? a);
    const vals = [];
    for (let k = 0; k < raw.length; k++) {
      const t = raw[k];
      const prev = raw[k - 1];
      if (['&&', '||', '(', ')', '!'].includes(t)) { vals.push(t); continue; }
      if (prev === '==' || prev === '=' || prev === '!=') vals.push(this.expandPattern(t, e));
      else if (prev === '=~') vals.push(this.expandString(t, e));
      else vals.push(this.expandString(t, e));
    }
    const ee = Object.create(e); ee.__dbl = true;
    try { return parseTest(vals, this, Object.assign(ee, { vars: e.vars })) ? 0 : 1; } catch (err) { io.err(err.message.replace('[:', '[[:') + '\n'); return 2; }
  },
  source(args, e, io, result) {
    const p = this.resolvePath(args[0], e);
    if (!e.host.files.has(p)) { io.err(`bash: ${args[0]}: No such file or directory\n`); return 1; }
    return this.runScript(e.host.files.get(p), e, io, { args: args.slice(1), name: args[0], result, source: true });
  },
  '.'(args, e, io, result) { return SHELL_BUILTINS.source.call(this, args, e, io, result); },
  read(args, e, io) {
    let raw = false, prompt = null, arr = null;
    const names = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-r') raw = true;
      else if (args[i] === '-p') prompt = args[++i];
      else if (args[i] === '-a') arr = args[++i];
      else if (args[i] === '-s' || args[i] === '-e') continue;
      else names.push(args[i]);
    }
    if (prompt) io.err(prompt);
    const input = io.in ? io.in.text : null;
    if (input === null || input === undefined || input === '') {
      if (input === null && e.interactive) io.err(C.dim('(read: the simulator terminal cannot pause for input; pipe it in, e.g. echo yes | read answer)') + '\n');
      for (const n of names.length ? names : ['REPLY']) this.setVar(e, n, '');
      return 1;
    }
    const nl = input.indexOf('\n');
    let line = nl === -1 ? input : input.slice(0, nl);
    io.in.text = nl === -1 ? '' : input.slice(nl + 1);
    if (!raw) line = line.replace(/\\(.)/g, '$1');
    if (arr) { this.setVar(e, arr, line.trim().split(/\s+/), { array: true }); return 0; }
    const targets = names.length ? names : ['REPLY'];
    const parts = line.trim().split(/\s+/);
    targets.forEach((n, k) => this.setVar(e, n, k === targets.length - 1 ? parts.slice(k).join(' ') : (parts[k] ?? '')));
    return 0;
  },
  type(args, e, io) {
    let code = 0;
    for (const a of args) {
      if (e.functions.has(a)) io.out(`${a} is a function\n`);
      else if (SHELL_BUILTINS[a]) io.out(`${a} is a shell builtin\n`);
      else if (registry[a] && commandAvailable(e.host, a)) io.out(`${a} is /usr/bin/${a}\n`);
      else { io.err(`bash: type: ${a}: not found\n`); code = 1; }
    }
    return code;
  },
  command(args, e, io, result, flags) {
    if (args[0] === '-v') { const a = args[1]; if (SHELL_BUILTINS[a] || e.functions.has(a)) { io.out(a + '\n'); return 0; } const p = this.findOnPath(a, e); if (p) { io.out(p + '\n'); return 0; } if (registry[a] && commandAvailable(e.host, a)) { io.out(`/usr/bin/${a}\n`); return 0; } return 1; }
    return this.invoke(args, e, io, result, flags);
  },
  eval(args, e, io, result) { return this.runIn(args.join(' '), e, io, result); },
  alias(args, e, io) { e.aliases = e.aliases || {}; if (!args.length) { for (const [k, v] of Object.entries(e.aliases)) io.out(`alias ${k}='${v}'\n`); return 0; } for (const a of args) { const m = a.match(/^(\w[\w-]*)=(.*)$/); if (m) e.aliases[m[1]] = m[2]; } return 0; },
  history(args, e, io) { this.history.forEach((h, k) => io.out(`${String(k + 1).padStart(5)}  ${h}\n`)); return 0; },
  wait() { return 0; },
  trap() { return 0; },
  umask(args, e, io) { if (!args.length) io.out('0022\n'); return 0; },
  jobs(args, e, io) { this.jobs.forEach((j, k) => { const alive = e.host.procs.has(j.pid); if (!alive && j.reported) return; io.out(`[${k + 1}]${k === this.jobs.length - 1 ? '+' : '-'}  ${alive ? 'Running' : 'Done   '}                 ${j.cmd}${alive ? ' &' : ''}${args.includes('-l') ? '  (pid ' + j.pid + ')' : ''}\n`); if (!alive) j.reported = true; }); return 0; },
  clear(args, e, io, result) { if (result) result.clear = true; return 0; },
  reset(args, e, io, result) { if (result) result.clear = true; return 0; },
};

export function formatPrintf(fmt, args) {
  let out = '';
  let ai = 0;
  const f = ansiC(fmt);
  const once = () => {
    let s = '';
    for (let i = 0; i < f.length; i++) {
      const c = f[i];
      if (c !== '%') { s += c; continue; }
      const m = f.slice(i).match(/^%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdifxXoceEgGb%])/);
      if (!m) { s += c; continue; }
      i += m[0].length - 1;
      const [, flags, width, prec, conv] = m;
      if (conv === '%') { s += '%'; continue; }
      let a = args[ai++] ?? '';
      let v;
      switch (conv) {
        case 's': case 'b': v = conv === 'b' ? ansiC(a) : a; if (prec !== undefined) v = v.slice(0, Number(prec)); break;
        case 'd': case 'i': v = String(Math.trunc(Number(a) || 0)); if (flags.includes('+') && Number(a) >= 0) v = '+' + v; break;
        case 'f': case 'e': case 'E': case 'g': case 'G': v = (Number(a) || 0).toFixed(prec !== undefined ? Number(prec) : 6); break;
        case 'x': v = (Math.trunc(Number(a)) || 0).toString(16); break;
        case 'X': v = (Math.trunc(Number(a)) || 0).toString(16).toUpperCase(); break;
        case 'o': v = (Math.trunc(Number(a)) || 0).toString(8); break;
        case 'c': v = String(a).charAt(0); break;
      }
      if (width) { const w = Number(width); v = flags.includes('-') ? v.padEnd(w) : v.padStart(w, flags.includes('0') && conv !== 's' ? '0' : ' '); }
      s += v;
    }
    return s;
  };
  out += once();
  const usesArgs = /%[-+ 0#]*\d*(?:\.\d+)?[sdifxXoceEgGb]/.test(f);
  while (usesArgs && ai < args.length) out += once();
  return out;
}

export { SHELL_BUILTINS, ExitSignal, cloneEnv };
