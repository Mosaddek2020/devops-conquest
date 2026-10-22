// System commands: editors, sudo/su, user and group management, processes (ps, top,
// kill), running programs from the shell (node, python3, npm, nginx…), npm/pip installs,
// and ssh/scp/ssh-keygen between hosts.

import { def, opts, registry, commandAvailable } from '../registry.js';
import { fsx, normPath, dirname, basename, humanSize } from '../fsx.js';
import { SimError } from '../host.js';
import { access } from '../session.js';
import { launch } from '../runtime.js';
import { Nginx, loadConfig } from '../nginx.js';
import { simulateRun } from '../../git/actions.js';
import { C } from '../../git/world.js';
import { fmtDate, lsTime } from './core.js';
import { connect } from '../net.js';

// ---------- editors ----------
def(['nano', 'vim', 'vi', 'code', 'edit', 'emacs', 'pico', 'gedit', 'subl'], c => {
  const file = c.args.filter(a => !a.startsWith('-') && !a.startsWith('+'))[0];
  if (!file) return c.fail(`${c.name}: the simulator needs a file name: ${c.name} <file>`, 1);
  const f = fsx(c);
  const abs = f.abs(file);
  const st = c.host.stat(abs);
  if (st?.type === 'dir') return c.fail(`"${file}" is a directory`, 1);
  if (st && !access(c.host, c.user, abs, 'r')) return c.fail(`[ Error reading ${file}: Permission denied ]`, 1);
  if (!c.host.isDir(dirname(abs))) return c.fail(`[ Directory '${dirname(abs)}' does not exist ]`, 1);
  const readonly = st ? !access(c.host, c.user, abs, 'w') : !access(c.host, c.user, dirname(abs), 'w');
  const host = c.host, user = c.user, uni = c.uni;
  c.result.editor = {
    title: abs.replace(/^\/home\/[^/]+/, '~'), content: st ? host.files.get(abs) : '', file: true,
    hint: readonly ? `This file is read-only for ${user}. Saving will fail (try: sudo ${c.name} ${file})` : (c.name === 'vim' || c.name === 'vi' ? 'A plain editor (no modes): type, then Ctrl+S to save and quit.' : null),
    onSave(text, { io }) {
      const exists = !!host.stat(abs);
      if (exists ? !access(host, user, abs, 'w') : !access(host, user, dirname(abs), 'w')) { io.err(`[ Error writing ${file}: Permission denied ]\n`); return 1; }
      host.writeFile(abs, text, user);
      uni.emit({ type: 'file-write', host: host.name, path: abs, by: 'editor' });
      return 0;
    },
  };
  return 0;
}, { always: true });

// ---------- sudo / su ----------
function canSudo(host, user) { return user === 'root' || host.userGroups(user).some(g => g === 'sudo' || g === 'wheel' || g === 'admin'); }

function asUser(c, user, { login = false } = {}) {
  const host = c.host;
  const u = host.users.get(user);
  const vars = new Map(c.e.vars);
  vars.set('USER', { value: user, exported: true });
  vars.set('LOGNAME', { value: user, exported: true });
  vars.set('HOME', { value: u?.home || '/root', exported: true });
  vars.set('PATH', { value: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin', exported: true });
  return { ...c.e, user, vars, cwd: login ? (u?.home || '/root') : c.e.cwd, locals: [], positional: [...c.e.positional] };
}

def('sudo', c => {
  const a = [...c.args];
  let target = 'root', login = false, shell = false, keepEnv = false;
  while (a.length && a[0].startsWith('-')) {
    const f = a.shift();
    if (f === '-u') target = a.shift();
    else if (f === '-i') login = true;
    else if (f === '-s') shell = true;
    else if (f === '-E') keepEnv = true;
    else if (f === '-iu' || f === '-ui') { login = true; target = a.shift(); }
    else if (f === '-k' || f === '-v' || f === '-n') continue;
    else if (f === '-l') { c.print(`User ${c.user} may run the following commands on ${c.host.name}:`, canSudo(c.host, c.user) ? '    (ALL : ALL) ALL' : '    (none)'); return 0; }
    else if (f === '--') break;
    else return c.fail(`sudo: unknown option -- ${f.replace(/^-+/, '')}`, 1);
  }
  if (!canSudo(c.host, c.user)) { c.uni.emit({ type: 'sudo-denied', host: c.host.name, user: c.user }); return c.fail(`${c.user} is not in the sudoers file.`, 1); }
  if (!c.host.users.has(target)) return c.fail(`sudo: unknown user ${target}\nsudo: error initializing audit plugin sudoers_audit`, 1);
  if (!a.length || (a[0] === 'su' && (!a[1] || a[1] === '-' || a[1] === 'root'))) {
    if (!a.length && !login && !shell) return c.fail('usage: sudo -h | -K | -k | -V\nusage: sudo [-u user] command', 1);
    c.sh.enter(c.host, target, { kind: 'sudo', cwd: login || a[0] === 'su' ? undefined : c.cwd });
    return 0;
  }
  if (a[0] === 'su' && a[1] === '-' && a[2]) { c.sh.enter(c.host, a[2], { kind: 'sudo' }); return 0; }
  c.uni.emit({ type: 'sudo', host: c.host.name, user: c.user, cmd: a.join(' ') });
  const e2 = asUser(c, target, { login });
  if (keepEnv) for (const [k, v] of c.e.vars) if (v.exported && !['USER', 'HOME', 'LOGNAME'].includes(k)) e2.vars.set(k, v);
  return c.sh.runArgv(a, e2, c.io, c.result, {});
}, { always: true });

def('su', c => {
  const a = c.args.filter(x => x !== '-' && x !== '-l' && x !== '--login');
  const target = a[0] || 'root';
  if (a[0] === '-c' || a[1] === '-c') { if (c.user !== 'root') return c.fail('su: Authentication failure', 1); return c.sh.runIn(a[a.indexOf('-c') + 1], asUser(c, target), c.io, c.result); }
  if (!c.host.users.has(target)) return c.fail(`su: user ${target} does not exist or the user entry does not contain all the required fields`, 1);
  if (c.user !== 'root') return c.fail(`Password: \nsu: Authentication failure\n${C.dim('(the simulator has no passwords: use sudo -iu ' + target + ' instead)')}`, 1);
  const u = c.host.users.get(target);
  if (/nologin|false/.test(u.shell)) return c.fail('This account is currently not available.', 1);
  c.sh.enter(c.host, target, { kind: 'su' });
  return 0;
}, { always: true });

// ---------- users & groups ----------
const rootOnly = (c, what = c.name) => c.user === 'root' ? null : c.fail(`${what}: Permission denied.\n${what}: cannot lock /etc/passwd; try again later.`, 1);

def(['useradd', 'adduser'], c => {
  if (rootOnly(c) !== null) return 1;
  const o = opts(c.args, { bool: ['-m', '-r', '--system', '--disabled-password', '-M', '--gecos', '--no-create-home', '--create-home'], val: ['-s', '--shell', '-G', '--groups', '-d', '--home', '-g', '-u', '-c', '--comment', '--ingroup'], alias: { '--shell': '-s', '--groups': '-G', '--home': '-d' } });
  const name = o._[o._.length - 1];
  if (!name) return c.fail(`Usage: ${c.name} [options] LOGIN`, 2);
  if (c.host.users.has(name)) return c.fail(`${c.name}: user '${name}' already exists`, 9);
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) return c.fail(`${c.name}: invalid user name '${name}': use --badname to ignore`, 3);
  const isAdd = c.name === 'adduser';
  const system = o['-r'] || o['--system'];
  const groups = o['-G'] ? o['-G'].split(',') : [];
  for (const g of groups) if (!c.host.groups.has(g)) return c.fail(`useradd: group '${g}' does not exist`, 6);
  c.host.addUser(name, { shell: o['-s'] || (system ? '/usr/sbin/nologin' : (isAdd ? '/bin/bash' : '/bin/sh')), home: o['-d'], noHome: !(o['-m'] || isAdd) || system, groups });
  if (isAdd) c.print(`info: Adding user \`${name}' ...`, `info: Adding new group \`${name}' (${c.host.users.get(name).gid}) ...`, `info: Adding new user \`${name}' (${c.host.users.get(name).uid}) with group \`${name} (${c.host.users.get(name).gid})' ...`, `info: Creating home directory \`/home/${name}' ...`, `info: Copying files from \`/etc/skel' ...`);
  c.uni.emit({ type: 'useradd', host: c.host.name, user: name });
  return 0;
});
def('usermod', c => {
  if (rootOnly(c) !== null) return 1;
  const o = opts(c.args, { bool: ['-a', '-L', '-U'], val: ['-G', '-g', '-s', '-d', '-l'] });
  const name = o._[0];
  if (!c.host.users.has(name)) return c.fail(`usermod: user '${name}' does not exist`, 6);
  if (o['-G']) {
    const gs = o['-G'].split(',');
    for (const g of gs) if (!c.host.groups.has(g)) return c.fail(`usermod: group '${g}' does not exist`, 6);
    if (!o['-a']) { for (const g of c.host.groups.values()) if (g.members.has(name)) g.members.delete(name); c.host.users.get(name).groups.clear(); }
    for (const g of gs) c.host.addToGroup(name, g);
  }
  if (o['-s']) c.host.users.get(name).shell = o['-s'];
  c.host.syncPasswd();
  c.uni.emit({ type: 'usermod', host: c.host.name, user: name, groups: o['-G'] });
  return 0;
});
def(['userdel', 'deluser'], c => {
  if (rootOnly(c) !== null) return 1;
  const name = c.args.filter(a => !a.startsWith('-'))[0];
  if (!c.host.users.has(name)) return c.fail(`userdel: user '${name}' does not exist`, 6);
  const home = c.host.users.get(name).home;
  c.host.users.delete(name);
  for (const g of c.host.groups.values()) g.members.delete(name);
  if (c.args.includes('-r') || c.args.includes('--remove-home')) fsx({ ...c, user: 'root' }).remove(home, { recursive: true, force: true });
  c.host.syncPasswd();
  return 0;
});
def(['groupadd', 'addgroup'], c => {
  if (rootOnly(c) !== null) return 1;
  const name = c.args.filter(a => !a.startsWith('-'))[0];
  if (c.host.groups.has(name)) return c.fail(`groupadd: group '${name}' already exists`, 9);
  c.host.addGroup(name); c.host.syncPasswd();
  return 0;
});
def('gpasswd', c => {
  if (rootOnly(c) !== null) return 1;
  const [flag, user, group] = c.args;
  if (flag === '-a') { c.host.addToGroup(user, group); c.print(`Adding user ${user} to group ${group}`); return 0; }
  if (flag === '-d') { c.host.groups.get(group)?.members.delete(user); c.host.users.get(user)?.groups.delete(group); c.host.syncPasswd(); c.print(`Removing user ${user} from group ${group}`); return 0; }
  return c.fail('Usage: gpasswd [option] GROUP', 2);
});
def(['passwd', 'chpasswd'], c => {
  const target = c.args.find(a => !a.startsWith('-')) || c.user;
  if (target !== c.user && c.user !== 'root') return c.fail(`passwd: You may not view or modify password information for ${target}.`, 1);
  if (c.args.includes('-l')) { c.print(`passwd: password changed.`); return 0; }
  c.print(C.dim('(the simulator does not store passwords)'), 'passwd: password updated successfully');
  return 0;
});
def('chage', c => { c.print('Last password change\t\t\t\t\t: Jan 01, 2026', 'Password expires\t\t\t\t\t: never'); return 0; });
def(['w', 'who', 'users', 'last'], c => {
  if (c.name === 'last') { c.print(`${c.user.padEnd(9)}pts/0        10.0.0.1         ${fmtDate(c.uni.time - 600, '%a %b %d %H:%M')}   still logged in`, '', 'wtmp begins Thu Jan  1 00:00:00 2026'); return 0; }
  if (c.name === 'users') { c.print(c.user); return 0; }
  c.print(`${c.user.padEnd(9)}pts/0        ${fmtDate(c.uni.time - 600, '%F %H:%M')} (10.0.0.1)`);
  return 0;
});

// ---------- processes ----------
function procRows(host) {
  return [...host.procs.values()].sort((a, b) => a.pid - b.pid);
}
const memPct = (host, p) => ((p.mem || 0) / host.memMB) * 100;

def('ps', c => {
  const raw = c.args.join(' ');
  const host = c.host;
  let rows = procRows(host);
  const o = opts(c.args, { bool: ['-e', '-f', '-A', '-l', '-H'], val: ['-u', '-p', '-o', '-C', '--sort', '--pid', '-U'] });
  if (!/a/.test(raw.replace(/-[a-zA-Z]*/g, m => m.includes('a') ? 'a' : '')) && !o['-e'] && !o['-A'] && !/\baux\b|\bax\b|\-ef\b|aux/.test(raw) && !o['-u'] && !o['-p'] && !o['-C']) rows = rows.filter(p => p.user === c.user && !p.unit);
  if (o['-u'] || o['-U']) rows = rows.filter(p => p.user === (o['-u'] || o['-U']));
  if (o['-p'] || o['--pid']) { const ids = String(o['-p'] || o['--pid']).split(',').map(Number); rows = rows.filter(p => ids.includes(p.pid)); }
  if (o['-C']) rows = rows.filter(p => p.cmd.split(' ')[0].split('/').pop().replace(':', '') === o['-C']);
  if (o['--sort']) {
    const k = o['--sort'];
    const desc = k.startsWith('-');
    const key = k.replace(/^[-+]/, '');
    const val = p => key.includes('mem') || key === 'rss' ? p.mem : key.includes('cpu') ? p.cpu : key === 'pid' ? p.pid : p.start;
    rows.sort((a, b) => desc ? val(b) - val(a) : val(a) - val(b));
  }
  const time = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (o['-o']) {
    const cols = o['-o'].split(',').map(x => x.replace(/=.*$/, ''));
    const hdr = { pid: 'PID', ppid: 'PPID', user: 'USER', cmd: 'CMD', command: 'COMMAND', args: 'COMMAND', comm: 'COMMAND', '%mem': '%MEM', '%cpu': '%CPU', rss: 'RSS', etime: 'ELAPSED', stat: 'STAT' };
    if (!o['-o'].includes('=')) c.print(cols.map(k => (hdr[k] || k.toUpperCase()).padStart(k === 'cmd' || k === 'command' || k === 'args' || k === 'comm' ? 0 : 6)).join(' '));
    for (const p of rows) c.print(cols.map(k => ({ pid: String(p.pid).padStart(6), ppid: String(p.ppid).padStart(6), user: p.user.padStart(6), cmd: p.cmd, command: p.cmd, args: p.cmd, comm: p.cmd.split(' ')[0].split('/').pop(), '%mem': memPct(host, p).toFixed(1).padStart(6), '%cpu': (p.cpu || 0).toFixed(1).padStart(6), rss: String(Math.round((p.mem || 1) * 1024)).padStart(6), etime: time(host.time - p.start).padStart(6), stat: (p.state || 'S').padStart(6) })[k] ?? '').join(' '));
    return 0;
  }
  if (/\-ef|\-e -f|\-f -e/.test(raw) || (o['-e'] && o['-f'])) {
    c.print('UID          PID    PPID  C STIME TTY          TIME CMD');
    for (const p of rows) c.print(`${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)}  0 ${fmtDate(p.start, '%H:%M')} ?        00:00:0${Math.min(9, Math.round(p.cpu || 0))} ${p.cmd}`);
    return 0;
  }
  if (/aux|\bax\b|\-aux|\-ax/.test(raw) || o['-e'] || o['-A']) {
    c.print('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND');
    for (const p of rows) c.print(`${p.user.slice(0, 8).padEnd(8)} ${String(p.pid).padStart(7)} ${(p.cpu || 0).toFixed(1).padStart(4)} ${memPct(host, p).toFixed(1).padStart(4)} ${String(Math.round((p.mem || 1) * 3200)).padStart(6)} ${String(Math.round((p.mem || 1) * 1024)).padStart(5)} ${p.unit ? '?' : 'pts/0'}        ${p.state || 'S'}    ${fmtDate(p.start, '%H:%M')}   ${time(Math.round(p.cpu || 0))} ${p.cmd}`);
    return 0;
  }
  c.print('    PID TTY          TIME CMD', `   4242 pts/0    00:00:00 bash`);
  for (const p of rows) c.print(`${String(p.pid).padStart(7)} pts/0    00:00:00 ${p.cmd.split(' ')[0].split('/').pop()}`);
  c.print(`   4243 pts/0    00:00:00 ps`);
  return 0;
}, { always: true });

def(['top', 'htop'], c => {
  const host = c.host;
  const rows = procRows(host).sort((a, b) => (b.cpu || 0) - (a.cpu || 0) || (b.mem || 0) - (a.mem || 0));
  const used = Math.min(host.memMB, host.memUsedMB());
  const busy = Math.min(100 * host.cpus, host.cpuBusy());
  c.print(`top - ${fmtDate(c.uni.time, '%T')} up 12 days,  3:04,  1 user,  load average: ${host.loadAvg.map(x => x.toFixed(2)).join(', ')}`,
    `Tasks: ${rows.length + 40} total,   1 running, ${rows.length + 39} sleeping,   0 stopped,   ${rows.filter(p => p.state === 'Z').length} zombie`,
    `%Cpu(s): ${(busy / host.cpus).toFixed(1).padStart(4)} us,  0.7 sy,  0.0 ni, ${Math.max(0, 100 - busy / host.cpus).toFixed(1)} id,  0.1 wa,  0.0 hi,  0.0 si,  0.0 st`,
    `MiB Mem : ${host.memMB.toFixed(1).padStart(7)} total, ${Math.max(0, host.memMB - used).toFixed(1).padStart(7)} free, ${used.toFixed(1).padStart(7)} used, ${(host.memMB * 0.12).toFixed(1).padStart(7)} buff/cache`,
    `MiB Swap: ${(host.swapMB || 0).toFixed(1).padStart(7)} total, ${((host.swapMB || 0) - (host.swapUsedMB || 0)).toFixed(1).padStart(7)} free, ${(host.swapUsedMB || 0).toFixed(1).padStart(7)} used. ${Math.max(0, host.memMB - used).toFixed(1).padStart(7)} avail Mem`,
    '',
    C.bold('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND'));
  for (const p of rows.slice(0, 15)) c.print(`${String(p.pid).padStart(7)} ${p.user.slice(0, 8).padEnd(8)}  20   0 ${String(Math.round((p.mem || 1) * 3200)).padStart(7)} ${String(Math.round((p.mem || 1) * 1024)).padStart(6)}  12048 ${p.state || 'S'} ${(p.cpu || 0).toFixed(1).padStart(5)} ${memPct(host, p).toFixed(1).padStart(5)}   0:0${Math.min(9, Math.round(p.cpu || 0))}.12 ${p.cmd.split(' ')[0].split('/').pop()}`);
  c.eprint(C.dim(`(${c.name} refreshes live in a real terminal; this is one snapshot. Press q in real ${c.name} to quit.)`));
  return 0;
}, { always: true });
registry.htop && (registry.htop.pkgName = 'htop');

function signalOf(a) { const m = String(a).match(/^-(?:s\s*)?(\d+|[A-Z]+)$/); if (!m) return null; const s = m[1]; return /^\d+$/.test(s) ? ({ 9: 'KILL', 15: 'TERM', 1: 'HUP', 2: 'INT' })[s] || s : s.replace(/^SIG/, ''); }

function deliver(c, p, sig) {
  if (c.user !== 'root' && p.user !== c.user) return `kill: (${p.pid}) - Operation not permitted`;
  if (sig === 'HUP' && p.program?.reload) { try { p.program.reload(); } catch (e) { return e.message; } return null; }
  if (sig === '0') return null;
  if (p.ignoreTerm && ['TERM', 'INT', 'HUP'].includes(sig)) { c.uni.emit({ type: 'kill', host: c.host.name, pid: p.pid, cmd: p.cmd, signal: sig, ignored: true }); return null; }
  c.host.killProc(p.pid, sig);
  c.uni.emit({ type: 'kill', host: c.host.name, pid: p.pid, cmd: p.cmd, signal: sig });
  return null;
}

def('kill', c => {
  let sig = 'TERM';
  const args = [];
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i];
    if (a === '-l') { c.print(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t15) SIGTERM'); return 0; }
    if (a === '-s') { sig = c.args[++i].replace(/^SIG/, ''); continue; }
    const s = signalOf(a);
    if (s) { sig = s; continue; }
    args.push(a);
  }
  if (!args.length) return c.fail('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', 2);
  let code = 0;
  for (const a of args) {
    const pid = a.startsWith('%') ? c.sh.jobs[Number(a.slice(1)) - 1]?.pid : Number(a);
    const p = c.host.procs.get(pid);
    if (!p) { c.eprint(`bash: kill: (${a}) - No such process`); code = 1; continue; }
    const err = deliver(c, p, sig);
    if (err) { c.eprint(`bash: ${err}`); code = 1; }
  }
  return code;
}, { always: true });

def(['pkill', 'killall', 'pgrep', 'pidof'], c => {
  let sig = 'TERM';
  const o = opts(c.args.filter(a => { const s = signalOf(a); if (s && c.name !== 'pgrep') { sig = s; return false; } return true; }), { bool: ['-f', '-a', '-l', '-x', '-n', '-o'], val: ['-u', '-s', '--signal'] });
  if (o['-s'] || o['--signal']) sig = (o['-s'] || o['--signal']).replace(/^SIG/, '');
  const pat = o._[0];
  if (!pat) return c.fail(`${c.name}: no matching criteria specified`, 2);
  let re;
  try { re = new RegExp(c.name === 'killall' || o['-x'] ? `^${pat}$` : pat); } catch { return c.fail(`${c.name}: invalid regex`, 2); }
  let matches = [...c.host.procs.values()].filter(p => p.pid !== 1 && (o['-f'] || c.name === 'pidof' && false ? re.test(p.cmd) : re.test(p.cmd.split(' ')[0].split('/').pop().replace(/:$/, ''))));
  if (o['-u']) matches = matches.filter(p => p.user === o['-u']);
  if (!matches.length) { if (c.name === 'killall') c.eprint(`${pat}: no process found`); return 1; }
  if (c.name === 'pgrep') { for (const p of matches) c.print(o['-a'] || o['-l'] ? `${p.pid} ${o['-a'] ? p.cmd : p.cmd.split(' ')[0]}` : String(p.pid)); return 0; }
  if (c.name === 'pidof') { c.print(matches.map(p => p.pid).join(' ')); return 0; }
  let code = 0;
  for (const p of matches) { const err = deliver(c, p, sig); if (err) { c.eprint(`${c.name}: killing pid ${p.pid} failed: Operation not permitted`); code = 1; } }
  return code;
}, { always: true });

def('lsof', c => {
  if (c.args.includes('+L1') || c.args.join(' ').includes('deleted')) {
    if (c.user !== 'root') return 1;
    const rows = [...c.host.procs.values()].flatMap(p => (p.deletedOpen || []).map(d => [p, d]));
    if (!rows.length) return 1;
    c.print('COMMAND    PID   USER   FD   TYPE DEVICE   SIZE/OFF NLINK  NODE NAME');
    for (const [p, d] of rows) c.print(`${p.cmd.split(' ')[0].split('/').pop().slice(0, 9).padEnd(9)} ${String(p.pid).padStart(5)} ${p.user.padStart(6)}    3w   REG  252,1 ${String(d.bytes).padStart(10)}     0 131075 ${d.path} (deleted)`);
    return 0;
  }
  const iArg = c.args.find(a => a.startsWith('-i'));
  const port = iArg ? Number((iArg.match(/:(\d+)/) || c.args.join(' ').match(/:(\d+)/) || [])[1]) : null;
  if (c.user !== 'root') { if (port) return 1; }
  c.print('COMMAND    PID     USER   FD   TYPE DEVICE SIZE/OFF NODE NAME');
  let any = false;
  for (const [pt, l] of c.host.listening) {
    if (port && pt !== port) continue;
    const p = c.host.procs.get(l.pid);
    if (!p) continue;
    any = true;
    c.print(`${p.cmd.split(' ')[0].split('/').pop().replace(':', '').slice(0, 9).padEnd(9)} ${String(p.pid).padStart(6)} ${p.user.padStart(8)}    6u  IPv4  31337      0t0  TCP ${l.addr === '0.0.0.0' ? '*' : l.addr}:${pt} (LISTEN)`);
  }
  return any ? 0 : 1;
});

// ---------- running programs from the shell ----------
export function runProgram(c, argv) {
  const host = c.host;
  const outPath = c.io.out?.path || null;
  const sink = c.bg ? (outPath ? line => { host.writeFile(outPath, (host.files.get(outPath) || '') + line + '\n', c.user); } : line => c.sh.pendingAsync?.push(line)) : null;
  const r = launch(host, argv, { uni: c.uni, user: c.user, env: c.env, cwd: c.cwd, logSink: sink });
  if (r.notProgram) return null;
  if (!r.ok) { for (const l of r.logs) c.eprint(l); return r.code; }
  if (r.script !== undefined) {
    // a plain script: run its print() lines
    for (const m of r.script.matchAll(/^\s*print\(\s*(['"f])([\s\S]*?)['"]\s*\)\s*$/gm)) c.print(m[2].replace(/^['"]/, ''));
    return 0;
  }
  if (r.oneShot) { for (const l of r.logs) c.print(l); return 0; }
  if (c.bg) {
    const job = c.sh.jobs.push({ pid: r.proc.pid, cmd: argv.join(' ') });
    c.e.lastBg = r.proc.pid;
    c.eprint(`[${job}] ${r.proc.pid}`);
    for (const l of r.logs) (sink ? sink(l) : c.print(l));
    return 0;
  }
  for (const l of r.logs) c.print(l);
  c.print('^C');
  c.eprint(C.dim(`(${argv[0]} kept running in the foreground, which would block this terminal, so the simulator stopped it.`), C.dim(` To keep it running: add & at the end (background), or better, run it as a systemd service.)`));
  host.killProc(r.proc.pid, 'INT');
  return 130;
}

def(['node', 'nodejs'], c => {
  if (c.args[0] === '-v' || c.args[0] === '--version') { c.print(c.host.nodeVersion || 'v20.18.0'); return 0; }
  if (c.args[0] === '-e' || c.args[0] === '-p') { const v = c.args[1] || ''; const m = v.match(/console\.log\((.*)\)/); c.print(m ? m[1].replace(/^['"`]|['"`]$/g, '') : ''); return 0; }
  return runProgram(c, [c.name, ...c.args]) ?? 0;
});
def(['python3', 'python'], c => {
  if (c.args[0] === '--version' || c.args[0] === '-V') { c.print('Python 3.12.3'); return 0; }
  if (c.args[0] === '-c') { const m = (c.args[1] || '').match(/print\((.*)\)/); if (m) c.print(m[1].replace(/^['"]|['"]$/g, '')); return 0; }
  if (c.args[0] === '-m' && c.args[1] === 'venv') { const d = c.resolve(c.args[2] || 'venv'); c.host.mkdirMeta(d, c.user); c.host.writeFile(d + '/bin/activate', '# venv activate\nexport VIRTUAL_ENV=' + d + '\n', c.user); c.host.writeFile(d + '/pyvenv.cfg', 'home = /usr/bin\n', c.user); return 0; }
  if (c.args[0] === '-m' && c.args[1] === 'pip') return registry.pip({ ...c, name: 'pip', args: c.args.slice(2) });
  return runProgram(c, [c.name, ...c.args]) ?? 0;
});
def(['gunicorn', 'uvicorn'], c => runProgram(c, [c.name, ...c.args]) ?? 0);
def('redis-server', c => runProgram(c, ['redis-server', ...c.args]) ?? 0);

def(['pip', 'pip3'], c => {
  const [sub, ...rest] = c.args;
  if (sub === 'install') {
    const pkgs = rest.includes('-r') ? (c.host.files.get(c.resolve(rest[rest.indexOf('-r') + 1])) || '').split('\n').map(l => l.trim()).filter(Boolean) : rest.filter(a => !a.startsWith('-'));
    if (!c.env.VIRTUAL_ENV && c.user !== 'root' && !rest.includes('--user') && !rest.includes('--break-system-packages')) return c.fail(`error: externally-managed-environment\n\n× This environment is externally managed\n╰─> To install Python packages system-wide, try apt install\n    python3-xyz, where xyz is the package you are trying to\n    install.\n\n    If you wish to install a non-Debian-packaged Python package,\n    create a virtual environment using python3 -m venv path/to/venv.`, 1);
    for (const p of pkgs) { c.print(`Collecting ${p.split(/[=<>]/)[0]}`, `  Downloading ${p.split(/[=<>]/)[0]}-3.0.3-py3-none-any.whl (101 kB)`); if (/flask/i.test(p)) c.host.flaskInstalled = true; }
    c.print(`Successfully installed ${pkgs.map(p => p.split(/[=<>]/)[0] + '-3.0.3').join(' ')}`);
    return 0;
  }
  if (sub === 'freeze' || sub === 'list') { if (c.host.flaskInstalled) c.print('Flask==3.0.3', 'Werkzeug==3.0.4'); return 0; }
  if (sub === '--version' || sub === '-V') { c.print('pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.12)'); return 0; }
  return c.fail(`ERROR: unknown command "${sub}"`, 1);
});

def(['npm', 'npx', 'yarn', 'pnpm'], c => {
  const [sub, ...rest] = c.args;
  const host = c.host;
  if (sub === '-v' || sub === '--version') { c.print('10.8.2'); return 0; }
  const pkgPath = c.resolve('package.json');
  const readPkg = () => { const t = host.files.get(pkgPath); if (t === undefined) throw new SimError(`npm error code ENOENT\nnpm error syscall open\nnpm error path ${pkgPath}\nnpm error errno -2\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${pkgPath}'`, 254); try { return JSON.parse(t); } catch (e) { throw new SimError(`npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json: ${e.message}`, 1); } };
  if (sub === 'init') { if (!host.files.has(pkgPath)) fsx(c).write('package.json', JSON.stringify({ name: basename(c.cwd), version: '1.0.0', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' } }, null, 2) + '\n'); c.print(`Wrote to ${pkgPath}`); return 0; }
  if (['install', 'i', 'ci', 'add'].includes(sub) || (c.name === 'yarn' && !sub)) {
    const pkg = readPkg();
    const adds = rest.filter(a => !a.startsWith('-'));
    if (sub === 'ci' && !host.files.has(c.resolve('package-lock.json'))) return c.fail('npm error code EUSAGE\nnpm error\nnpm error The `npm ci` command can only install with an existing package-lock.json or\nnpm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or\nnpm error later to generate a package-lock.json file, then try again.', 1);
    const dev = rest.includes('-D') || rest.includes('--save-dev');
    if (adds.length) { const key = dev ? 'devDependencies' : 'dependencies'; pkg[key] = pkg[key] || {}; for (const a of adds) pkg[key][a.split('@')[0] || a] = '^' + (a.split('@')[1] || '4.21.1'); fsx(c).write('package.json', JSON.stringify(pkg, null, 2) + '\n'); }
    const deps = { ...(pkg.dependencies || {}), ...((rest.includes('--omit=dev') || rest.includes('--production')) ? {} : (pkg.devDependencies || {})) };
    const nm = c.resolve('node_modules');
    if (!access(host, c.user, c.cwd, 'w')) return c.fail(`npm error code EACCES\nnpm error syscall mkdir\nnpm error path ${nm}\nnpm error errno -13\nnpm error Error: EACCES: permission denied, mkdir '${nm}'`, 243);
    host.mkdirMeta(nm, c.user);
    for (const d of Object.keys(deps)) { host.mkdirMeta(`${nm}/${d}`, c.user); host.writeFile(`${nm}/${d}/package.json`, JSON.stringify({ name: d, version: String(deps[d]).replace(/^\^|~/, '') }) + '\n', c.user); }
    if (!host.files.has(c.resolve('package-lock.json'))) host.writeFile(c.resolve('package-lock.json'), JSON.stringify({ name: pkg.name, lockfileVersion: 3, requires: true, packages: Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: String(v).replace(/^\^|~/, '') }])) }, null, 2) + '\n', c.user);
    const n = Object.keys(deps).length * 31 + 7;
    c.print('', `added ${n} packages, and audited ${n + 1} packages in 2s`, '', `${Math.ceil(n / 9)} packages are looking for funding`, '  run `npm fund` for details', '', host.labNpmVulns ? `${C.yellow(host.labNpmVulns + ' high severity vulnerabilities')}\n\nTo address all issues, run:\n  npm audit fix` : 'found 0 vulnerabilities');
    c.uni.emit({ type: 'npm-install', host: host.name, dir: c.cwd });
    return 0;
  }
  if (sub === 'start' || (sub === 'run' && rest[0] === 'start') || (sub === 'run' && rest[0] && readPkg().scripts?.[rest[0]] && /\b(node|nodemon|ts-node)\b/.test(readPkg().scripts[rest[0]]))) {
    const r = runProgram(c, ['npm', sub === 'start' ? 'start' : 'run', ...(sub === 'start' ? [] : rest)]);
    return r ?? 0;
  }
  if (sub === 'test' || sub === 't' || sub === 'run' || sub === 'audit') {
    const pkg = readPkg();
    const script = sub === 'run' ? rest[0] : sub === 'audit' ? 'audit' : 'test';
    if (sub === 'audit') {
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const found = auditDeps(deps);
      if (found.length) {
        c.print('# npm audit report', '');
        for (const v of found) c.print(`${v.name}  ${v.range}`, `Severity: ${v.severity}`, `${v.title} - ${v.url}`, `fix available via \`npm audit fix\` (upgrade to ${v.fixed} or later)`, '');
        const high = found.filter(v => /high|critical/.test(v.severity)).length;
        c.print(`${found.length} vulnerabilit${found.length === 1 ? 'y' : 'ies'} (${high} high)`);
        const level = (rest.find(a => a.startsWith('--audit-level=')) || '--audit-level=low').split('=')[1];
        const order = ['low', 'moderate', 'high', 'critical'];
        return found.some(v => order.indexOf(v.severity) >= order.indexOf(level)) ? 1 : 0;
      }
      c.print('found 0 vulnerabilities');
      return 0;
    }
    if (sub === 'audit_legacy') { if (host.labNpmVulns) { c.print(`# npm audit report\n\n${host.labNpmAudit || 'lodash  <4.17.21\nSeverity: high\nPrototype Pollution in lodash - https://github.com/advisories/GHSA-p6mc-m468-83gw\nfix available via `npm audit fix`'}\n\n${host.labNpmVulns} high severity vulnerabilities`); return 1; } c.print('found 0 vulnerabilities'); return 0; }
    if (!pkg.scripts?.[script]) { if (sub === 'run' && !rest[0]) { c.print(`Lifecycle scripts included in ${pkg.name}:`, ...Object.entries(pkg.scripts || {}).map(([k, v]) => `  ${k}\n    ${v}`)); return 0; } return c.fail(`npm error Missing script: "${script}"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run`, 1); }
    c.print('', `> ${pkg.name}@${pkg.version || '1.0.0'} ${script}`, `> ${pkg.scripts[script]}`, '');
    if (!/\b(jest|mocha|vitest|eslint|tsc|pytest|ava|tap|standard|prettier)\b/.test(pkg.scripts[script])) {
      // a plain shell script: run it for real, with node_modules/.bin on PATH like npm does
      return c.runLine(pkg.scripts[script]);
    }
    const files = new Map();
    const root = c.cwd;
    for (const [p, txt] of host.files) if (p.startsWith(root + '/') && !p.includes('/node_modules/')) files.set(p.slice(root.length + 1), host.uni.writeBlob(txt));
    const w = Object.assign(Object.create(host.uni), { testRule: c.uni.testRule, objects: host.uni.objects });
    const r = simulateRun(`npm ${sub === 'run' ? 'run ' + script : script}`, files, w, { env: c.env });
    c.print(...r.log.map(l => r.ok ? l : C.red(l)));
    return r.ok ? 0 : 1;
  }
  if (c.name === 'npx') return c.fail(`npm error could not determine executable to run`, 1);
  return c.fail(`Unknown command: "${sub}"\n\nTo see a list of supported npm commands, run:\n  npm help`, 1);
});

def('nginx', c => {
  const host = c.host;
  const o = opts(c.args, { bool: ['-t', '-T', '-v', '-V', '-q'], val: ['-s', '-c', '-g'] });
  if (o['-v'] || o['-V']) { c.eprint('nginx version: nginx/1.24.0 (Ubuntu)'); return 0; }
  if (o['-t'] || o['-T']) {
    if (c.user !== 'root') c.eprint(`nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)`);
    try {
      const conf = loadConfig(host, o['-c'] || '/etc/nginx/nginx.conf');
      if (c.user !== 'root') { c.eprint('nginx: [emerg] open() "/run/nginx.pid" failed (13: Permission denied)', 'nginx: configuration file /etc/nginx/nginx.conf test failed'); return 1; }
      c.eprint('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok', 'nginx: configuration file /etc/nginx/nginx.conf test is successful');
      if (o['-T']) for (const f of conf.files) c.print(`# configuration file ${f}:`, ...host.files.get(f).replace(/\n$/, '').split('\n'), '');
      c.uni.emit({ type: 'nginx-test', host: host.name, ok: true });
      return 0;
    } catch (e) {
      c.eprint(e.message, 'nginx: configuration file /etc/nginx/nginx.conf test failed');
      c.uni.emit({ type: 'nginx-test', host: host.name, ok: false });
      return 1;
    }
  }
  if (o['-s']) {
    const master = [...host.procs.values()].find(p => p.program instanceof Nginx);
    if (!master) return c.fail('nginx: [error] invalid PID number "" in "/run/nginx.pid"', 1);
    if (c.user !== 'root') return c.fail('nginx: [alert] kill(4242, 1) failed (1: Operation not permitted)', 1);
    if (o['-s'] === 'reload') { try { master.program.reload(); } catch (e) { c.eprint(e.message); return 1; } c.uni.emit({ type: 'nginx-reload', host: host.name }); return 0; }
    if (o['-s'] === 'stop' || o['-s'] === 'quit') { for (const p of [...host.procs.values()]) if (p.cmd.startsWith('nginx')) host.killProc(p.pid); return 0; }
    return 0;
  }
  if (c.user !== 'root') return c.fail('nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)\nnginx: [emerg] bind() to 0.0.0.0:80 failed (13: Permission denied)', 1);
  return c.fail(C.dim('(start nginx through systemd: sudo systemctl start nginx)'), 1);
});

// a tiny advisory database for npm audit (real advisories)
const ADVISORIES = [
  { name: 'lodash', below: '4.17.21', severity: 'high', title: 'Command Injection in lodash', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm' },
  { name: 'minimist', below: '1.2.6', severity: 'critical', title: 'Prototype Pollution in minimist', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h' },
  { name: 'express', below: '4.19.2', severity: 'moderate', title: 'Express.js Open Redirect in malformed URLs', url: 'https://github.com/advisories/GHSA-rv95-896h-c2vc' },
  { name: 'axios', below: '1.6.0', severity: 'moderate', title: 'Axios Cross-Site Request Forgery Vulnerability', url: 'https://github.com/advisories/GHSA-wf5p-g6vw-rhxx' },
  { name: 'jsonwebtoken', below: '9.0.0', severity: 'high', title: 'jsonwebtoken unrestricted key type could lead to legacy keys usage', url: 'https://github.com/advisories/GHSA-8cf7-32gw-wr33' },
];
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
export function auditDeps(deps) {
  const out = [];
  for (const [name, spec] of Object.entries(deps || {})) {
    const v = String(spec).replace(/^[\^~>=<\s]+/, '');
    for (const a of ADVISORIES) if (a.name === name && /^\d+\.\d+/.test(v) && cmpVer(v, a.below) < 0) out.push({ ...a, range: `<${a.below}`, fixed: a.below });
  }
  return out;
}

// ---------- the cloud provider's web console (lab feature) ----------
def('console', c => {
  const name = c.args[0];
  if (!name) return c.fail('usage: console <machine>   (the cloud provider\'s browser console)', 1);
  if (!c.uni.consoleHosts?.includes(name) || !c.uni.host(name)) return c.fail(`console: no cloud console available for "${name}"`, 1);
  const target = c.uni.host(name);
  c.print(C.dim(`Connecting to the serial console of ${name} through the cloud provider (no SSH, no firewall in the way)…`), '', `Ubuntu 24.04 LTS ${name} ttyS0`, '', `${name} login: root (console session)`);
  c.uni.emit({ type: 'console', host: name });
  c.sh.enter(target, 'root', { kind: 'console' });
  return 0;
}, { always: true });

// ---------- ssh ----------
function keyFiles(host, user) {
  const home = host.users.get(user)?.home || '/root';
  return ['id_ed25519', 'id_rsa', 'id_ecdsa'].map(k => `${home}/.ssh/${k}`).filter(p => host.files.has(p));
}

// simulated private keys carry their public half (as real OpenSSH keys do), base64 encoded
export function privateKeyFor(pub) {
  return `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n${btoa('pub:' + pub.trim())}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
function pubFromPrivate(text) {
  for (const line of String(text || '').split('\n')) { try { const d = atob(line.trim()); if (d.startsWith('pub:')) return d.slice(4); } catch { /* not base64 */ } }
  return null;
}

function sshAuth(c, target, tuser, identity) {
  const src = c.host;
  const keys = identity ? [c.resolve(identity)] : keyFiles(src, c.user);
  for (const k of keys) {
    if (!src.files.has(k)) { c.eprint(`Warning: Identity file ${identity} not accessible: No such file or directory.`); continue; }
    const st = src.stat(k);
    if ((st.mode & 0o077) !== 0) {
      c.eprint('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @', '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', `Permissions 0${(st.mode & 0o777).toString(8)} for '${k}' are too open.`, 'It is required that your private key files are NOT accessible by others.', 'This private key will be ignored.', `Load key "${k}": bad permissions`);
      continue;
    }
    const pub = src.files.get(k + '.pub') || pubFromPrivate(src.files.get(k));
    const tu = target.users.get(tuser);
    if (!tu) continue;
    const ak = `${tu.home}/.ssh/authorized_keys`;
    const akText = target.files.get(ak);
    if (!akText || !pub) continue;
    const akSt = target.stat(ak);
    const sshDir = target.stat(`${tu.home}/.ssh`);
    if ((akSt.mode & 0o022) || (sshDir && (sshDir.mode & 0o022)) || akSt.owner !== tuser) { target.log('ssh.service', `Authentication refused: bad ownership or modes for file ${ak}`, 'err'); continue; }
    const body = pub.trim().split(/\s+/).slice(0, 2).join(' ');
    if (akText.split('\n').some(l => l.includes(body))) return true;
  }
  return false;
}

def('ssh', c => {
  const o = opts(c.args, { bool: ['-T', '-v', '-A', '-N', '-t', '-q', '-4'], val: ['-i', '-p', '-o', '-L', '-J', '-l'] });
  const [dest, ...cmd] = o._;
  if (!dest) return c.fail('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n           [-i identity_file] [-J destination] [-L address]\n           [-l login_name] [-p port] destination [command [argument ...]]', 255);
  if (/github\.com$/.test(dest)) return registry.ssh_github ? registry.ssh_github(c) : c.fail(`git@github.com: Permission denied (publickey).`, 255);
  let [tuser, hostName] = dest.includes('@') ? dest.split('@') : [o['-l'] || c.user, dest];
  // ~/.ssh/config Host aliases
  const cfg = c.host.files.get(`${c.host.users.get(c.user)?.home}/.ssh/config`) || '';
  let identity = o['-i'];
  let port = Number(o['-p'] || 22);
  for (const block of cfg.split(/^Host\s+/m).slice(1)) {
    const [names, ...lines] = block.split('\n');
    if (!names.trim().split(/\s+/).includes(hostName)) continue;
    for (const l of lines) {
      const m = l.trim().match(/^(\w+)\s+(.+)$/);
      if (!m) continue;
      if (m[1] === 'HostName') hostName = m[2];
      if (m[1] === 'User' && !dest.includes('@')) tuser = m[2];
      if (m[1] === 'IdentityFile' && !identity) identity = m[2].replace(/^~/, c.host.users.get(c.user)?.home);
      if (m[1] === 'Port' && !o['-p']) port = Number(m[2]);
    }
  }
  const conn = connect(c.uni, c.host, hostName, port);
  if (conn.error === 'ENOTFOUND') return c.fail(`ssh: Could not resolve hostname ${hostName}: Name or service not known`, 255);
  if (conn.error === 'ETIMEDOUT') return c.fail(`ssh: connect to host ${hostName} port ${port}: Connection timed out`, 255);
  if (conn.error) return c.fail(`ssh: connect to host ${hostName} port ${port}: Connection refused`, 255);
  const target = conn.host;
  const home = c.host.users.get(c.user)?.home || '/root';
  const kh = `${home}/.ssh/known_hosts`;
  const known = c.host.files.get(kh) || '';
  const fp = target.hostKeyFp || 'SHA256:' + btoa(target.name + target.ip).replace(/=/g, '').slice(0, 43);
  const entry = known.split('\n').find(l => l.split(' ')[0].split(',').includes(hostName));
  if (entry && !entry.includes(fp)) {
    return c.fail(['@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @', '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', 'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!', 'Someone could be eavesdropping on you right now (man-in-the-middle attack)!', 'It is also possible that a host key has just been changed.', `The fingerprint for the ED25519 key sent by the remote host is\n${fp}.`, `Offending ED25519 key in ${kh}:${known.split('\n').indexOf(entry) + 1}`, `Host key verification failed.`].join('\n'), 255);
  }
  if (target === c.host && hostName !== 'localhost') { /* fine */ }
  if (!target.users.has(tuser)) return c.fail(`${tuser}@${hostName}: Permission denied (publickey).`, 255);
  if (!sshAuth(c, target, tuser, identity)) {
    c.uni.emit({ type: 'ssh-denied', from: c.host.name, to: target.name, user: tuser });
    target.log('ssh.service', `Connection closed by authenticating user ${tuser} ${c.host.ip} port 51234 [preauth]`);
    return c.fail(`${tuser}@${hostName}: Permission denied (publickey).`, 255);
  }
  if (!entry) { c.host.mkdirMeta(`${home}/.ssh`, c.user, 0o700); c.host.writeFile(kh, known + `${hostName} ssh-ed25519 ${fp}\n`, c.user); c.eprint(`Warning: Permanently added '${hostName}' (ED25519) to the list of known hosts.`); }
  target.log('ssh.service', `Accepted publickey for ${tuser} from ${c.host.ip} port 51234 ssh2: ED25519 ${fp}`);
  c.uni.emit({ type: 'ssh', from: c.host.name, to: target.name, user: tuser, cmd: cmd.join(' ') });
  if (cmd.length) {
    const e2 = { ...c.e, host: target, user: tuser, cwd: target.users.get(tuser).home, vars: new Map(c.e.vars), locals: [], positional: [] };
    e2.vars.set('HOME', { value: target.users.get(tuser).home, exported: true });
    e2.vars.set('USER', { value: tuser, exported: true });
    return c.sh.runIn(cmd.join(' '), e2, c.io, c.result);
  }
  c.print(`Welcome to ${target.os} (GNU/Linux 6.8.0-45-generic x86_64)`, '', ` * Documentation:  https://help.ubuntu.com`, '', `  System load:  ${target.loadAvg[0].toFixed(2)}               Processes:             ${target.procs.size + 90}`, `  Usage of /:   ${Math.round((target.diskUsedGB / target.diskGB) * 100)}.0% of ${target.diskGB}GB   Users logged in:       0`, `  Memory usage: ${Math.round((target.memUsedMB() / target.memMB) * 100)}%                 IPv4 address for eth0: ${target.ip}`, '', `Last login: ${fmtDate(c.uni.time - 86400, '%a %b %d %T %Y')} from 10.0.0.1`);
  if (target.motd) c.print(target.motd);
  c.sh.enter(target, tuser, { kind: 'ssh' });
  return 0;
});

def('ssh-keygen', c => {
  const o = opts(c.args, { bool: ['-q', '-l', '-y'], val: ['-t', '-f', '-N', '-C', '-b', '-R', '-E'] });
  const home = c.host.users.get(c.user)?.home || '/root';
  if (o['-R']) { const kh = `${home}/.ssh/known_hosts`; const t = c.host.files.get(kh) || ''; c.host.writeFile(kh, t.split('\n').filter(l => !l.split(' ')[0].split(',').includes(o['-R'])).join('\n'), c.user); c.print(`# Host ${o['-R']} found: line 1`, `${kh} updated.`, `Original contents retained as ${kh}.old`); return 0; }
  const type = o['-t'] || 'ed25519';
  const file = o['-f'] ? c.resolve(o['-f']) : `${home}/.ssh/id_${type}`;
  if (o['-l']) { const t = c.host.files.get(file.endsWith('.pub') ? file : file + '.pub'); if (!t) return c.fail(`${file} is not a public key file.`, 255); c.print(`256 SHA256:${btoa(t).slice(10, 53)} ${t.split(' ')[2] || ''} (${type.toUpperCase()})`); return 0; }
  if (c.host.files.has(file)) return c.fail(`${file} already exists.\nOverwrite (y/n)? n`, 1);
  c.host.mkdirMeta(dirname(file), c.user, 0o700);
  const id = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  const comment = o['-C'] || `${c.user}@${c.host.name}`;
  const pub = `ssh-${type === 'rsa' ? 'rsa' : type} AAAAC3NzaC1lZDI1NTE5AAAAI${btoa(id).replace(/=/g, '')}${'x'.repeat(4)} ${comment}\n`;
  c.host.writeFile(file, privateKeyFor(pub), c.user);
  c.host.setMeta(file, { mode: 0o600 });
  c.host.writeFile(file + '.pub', pub, c.user);
  c.host.setMeta(file + '.pub', { mode: 0o644 });
  if (!o['-q']) c.print(`Generating public/private ${type} key pair.`, `Your identification has been saved in ${file}`, `Your public key has been saved in ${file}.pub`, 'The key fingerprint is:', `SHA256:${btoa(id).slice(0, 43)} ${comment}`, 'The key\'s randomart image is:', '+--[ED25519 256]--+', '|      .o+*=o.    |', '|     . =+.o.     |', '|      o.o+ .     |', '|       oo.+      |', '|      . S+ .     |', '+----[SHA256]-----+');
  c.uni.emit({ type: 'ssh-keygen', host: c.host.name, user: c.user, file });
  return 0;
}, { always: true });

def('ssh-copy-id', c => {
  const dest = c.args.filter(a => !a.startsWith('-')).pop();
  if (!dest) return c.fail('Usage: /usr/bin/ssh-copy-id [-h|-?|-f|-n|-s|-x] [-i [identity_file]] [-p port] [[-o <ssh -o options>] ...] [user@]hostname', 1);
  const [tuser, hn] = dest.includes('@') ? dest.split('@') : [c.user, dest];
  const conn = connect(c.uni, c.host, hn, 22);
  if (conn.error) return c.fail(`ssh: connect to host ${hn} port 22: ${conn.error === 'ENOTFOUND' ? 'Name or service not known' : conn.error === 'ETIMEDOUT' ? 'Connection timed out' : 'Connection refused'}`, 1);
  const target = conn.host;
  if (!target.passwordAuth) return c.fail(`/usr/bin/ssh-copy-id: ERROR: ${tuser}@${hn}: Permission denied (publickey).\n${C.dim('(this server only accepts keys: someone with access must add your public key to ~/.ssh/authorized_keys)')}`, 1);
  const pub = c.host.files.get(keyFiles(c.host, c.user)[0] + '.pub');
  if (!pub) return c.fail('/usr/bin/ssh-copy-id: ERROR: No identities found', 1);
  const tu = target.users.get(tuser);
  target.mkdirMeta(`${tu.home}/.ssh`, tuser, 0o700);
  const ak = `${tu.home}/.ssh/authorized_keys`;
  target.writeFile(ak, (target.files.get(ak) || '') + pub, tuser);
  target.setMeta(ak, { mode: 0o600, owner: tuser });
  c.print(`/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys`, '', 'Number of key(s) added: 1', '', `Now try logging into the machine, with:   "ssh '${dest}'"`, 'and check to make sure that only the key(s) you wanted were added.');
  return 0;
});

def(['scp', 'rsync'], c => {
  const o = opts(c.args, { bool: ['-r', '-a', '-v', '-z', '-P', '-q', '--delete', '-n', '--dry-run', '-avz', '-av'], val: ['-i', '-e', '-p'] });
  const raw = c.args.filter(a => !a.startsWith('-') && a !== o['-i'] && a !== o['-e']);
  if (raw.length < 2) return c.fail(`usage: ${c.name} [-r] [-i identity_file] source ... target`, 1);
  const dst = raw.pop();
  const parse = s => { const m = s.match(/^(?:([^@:/]+)@)?([^:/][^:]*):(.*)$/); return m ? { user: m[1] || c.user, host: m[2], path: m[3] || '' } : { local: s }; };
  const D = parse(dst);
  const endpoint = (x) => {
    if (x.local !== undefined) return { host: c.host, user: c.user, path: c.resolve(x.local) };
    const cfg = c.host.files.get(`${c.host.users.get(c.user)?.home}/.ssh/config`) || '';
    for (const block of cfg.split(/^Host\s+/m).slice(1)) {
      const [names, ...lines] = block.split('\n');
      if (!names.trim().split(/\s+/).includes(x.host)) continue;
      for (const l of lines) { const m = l.trim().match(/^(\w+)\s+(.+)$/); if (!m) continue; if (m[1] === 'HostName') x.host = m[2]; if (m[1] === 'User' && x.user === c.user) x.user = m[2]; }
    }
    const conn = connect(c.uni, c.host, x.host, 22);
    if (conn.error) throw new SimError(`ssh: connect to host ${x.host} port 22: ${conn.error === 'ENOTFOUND' ? 'Could not resolve hostname' : conn.error === 'ETIMEDOUT' ? 'Connection timed out' : 'Connection refused'}\n${c.name === 'scp' ? 'scp: Connection closed' : 'rsync: connection unexpectedly closed'}`, 255);
    if (!sshAuth(c, conn.host, x.user, o['-i'])) throw new SimError(`${x.user}@${x.host}: Permission denied (publickey).\n${c.name === 'scp' ? 'scp: Connection closed' : 'rsync: connection unexpectedly closed (0 bytes received so far) [sender]'}`, 255);
    const home = conn.host.users.get(x.user)?.home || '/root';
    return { host: conn.host, user: x.user, path: x.path.startsWith('/') ? normPath(x.path) : normPath(home + '/' + x.path) };
  };
  let code = 0;
  try {
    const d = endpoint(D);
    for (const s of raw) {
      const S = endpoint(parse(s));
      const st = S.host.stat(S.path);
      if (!st) { c.eprint(`${c.name}: ${S.path}: No such file or directory`); code = 1; continue; }
      if (!access(S.host, S.user, S.path, 'r')) { c.eprint(`${c.name}: ${S.path}: Permission denied`); code = 1; continue; }
      const recursive = o['-r'] || o['-a'] || c.args.some(a => /^-[a-z]*a/.test(a));
      if (st.type === 'dir' && !recursive) { c.eprint(`${c.name}: ${S.path}: not a regular file`); code = 1; continue; }
      let target = d.host.stat(d.path)?.type === 'dir' ? normPath(d.path + '/' + basename(S.path)) : d.path;
      if (c.name === 'rsync' && s.endsWith('/') && st.type === 'dir') target = d.path;
      const files = st.type === 'dir' ? [...S.host.files.keys()].filter(p => p.startsWith(S.path + '/')).map(p => [p, normPath(target + p.slice(S.path.length))]) : [[S.path, target]];
      if (!files.length && st.type === 'dir') d.host.mkdirMeta(target, d.user);
      for (const [from, to] of files) {
        const parent = dirname(to);
        if (!d.host.isDir(parent)) { if (st.type === 'dir') d.host.mkdirMeta(parent, d.user); else { c.eprint(`${c.name}: ${to}: No such file or directory`); code = 1; continue; } }
        if (!(d.host.stat(to) ? access(d.host, d.user, to, 'w') : access(d.host, d.user, dirname(to), 'w'))) { c.eprint(`${c.name}: ${to}: Permission denied`); code = 1; continue; }
        d.host.writeFile(to, S.host.files.get(from), d.user);
        if (o['-v'] || c.name === 'rsync') c.print(to.slice(target.length + 1) || basename(to));
      }
      c.uni.emit({ type: 'copy', tool: c.name, from: S.host.name, to: d.host.name, src: S.path, dst: target });
    }
    if (c.name === 'rsync') c.print('', `sent 1,284 bytes  received 35 bytes  2,638.00 bytes/sec`, `total size is 4,091  speedup is 3.10`);
  } catch (e) { if (e instanceof SimError) return c.fail(e.message, e.code); throw e; }
  return code;
});

export { canSudo };
