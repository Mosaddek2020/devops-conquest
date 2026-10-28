// systemd for simulated hosts: unit files under /etc/systemd/system and /lib/systemd/system,
// systemctl (start/stop/restart/reload/enable/disable/status/is-active/daemon-reload/cat/
// list-units), journalctl, Restart= policies with a start limit, and a cron daemon.

import { def, opts } from './registry.js';
import { launch } from './runtime.js';
import { Nginx } from './nginx.js';
import { SimError, normPath } from './host.js';
import { C } from '../git/world.js';
import { fmtDate } from './cmd/core.js';

const UNIT_DIRS = ['/etc/systemd/system', '/lib/systemd/system', '/usr/lib/systemd/system'];

export function parseUnit(text) {
  const u = { sections: {} };
  let sec = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(/^\[(\w+)\]$/);
    if (m) { sec = u.sections[m[1]] = u.sections[m[1]] || {}; continue; }
    const kv = line.match(/^([A-Za-z]+)\s*=\s*(.*)$/);
    if (!kv || !sec) { u.error = `Invalid line: ${line}`; continue; }
    const k = kv[1];
    if (k === 'Environment' || k === 'ExecStartPre' || k === 'EnvironmentFile' || k === 'After' || k === 'Requires' || k === 'Wants') (sec[k] = sec[k] || []).push(kv[2]);
    else sec[k] = kv[2];
  }
  return u;
}

function findUnitFile(host, name) {
  for (const d of UNIT_DIRS) { const p = `${d}/${name}`; if (host.files.has(p)) return p; }
  return null;
}

// drop-ins: /etc/systemd/system/<unit>.d/*.conf, applied after the unit file
export function dropinFiles(host, name) { const d = `/etc/systemd/system/${name}.d/`; return [...host.files.keys()].filter(p => p.startsWith(d) && p.endsWith('.conf') && !p.slice(d.length).includes('/')).sort(); }
export function dropinText(host, name) { return dropinFiles(host, name).map(p => host.files.get(p)).join('\n'); }
const effective = (host, st) => parseUnit((st.loadedText ?? '') + '\n' + (st.loadedDropins ?? dropinText(host, st.name)));
export const sizeMB = v => { const m = String(v || '').match(/^([\d.]+)\s*([KMGT]?)$/i); if (!m) return null; return Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024, T: 1048576 }[m[2].toUpperCase()] ?? 1 / 1048576); };
const changedOnDisk = (host, st, path) => st.loadedText !== null && st.loadedText !== undefined && (host.files.get(path) !== st.loadedText || (st.loadedDropins !== undefined && st.loadedDropins !== dropinText(host, st.name)));

function unitName(n) { return /\.(service|timer|socket|target)$/.test(n) ? n : n + '.service'; }

export function unitState(host, name) {
  if (!host.units.has(name)) host.units.set(name, { name, active: 'inactive', sub: 'dead', enabled: false, pid: null, since: host.time, restarts: [], loadedText: null, result: 'success' });
  return host.units.get(name);
}

function envFromUnit(host, svc) {
  const env = { ...host.env };
  for (const e of svc.Environment || []) {
    for (const m of e.matchAll(/"?([A-Za-z_]\w*)=((?:"[^"]*")|[^\s"]*)"?/g)) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  for (const f of svc.EnvironmentFile || []) {
    const path = f.replace(/^-/, '');
    const text = host.files.get(path);
    if (text === undefined) { if (!f.startsWith('-')) return { error: `Failed to load environment files: No such file or directory` }; continue; }
    for (const line of text.split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  }
  return { env };
}

// start a unit; returns { ok, msg }
export function startUnit(host, uni, name, { quiet = false } = {}) {
  const st = unitState(host, name);
  const path = findUnitFile(host, name);
  if (!path) return { ok: false, msg: `Failed to start ${name}: Unit ${name} not found.`, code: 5 };
  if (st.active === 'active') return { ok: true };
  const text = host.files.get(path);
  st.loadedText = st.loadedText ?? text;
  st.loadedDropins = st.loadedDropins ?? dropinText(host, name);
  const unit = effective(host, st);
  const svc = unit.sections.Service || {};
  st.memoryMax = sizeMB(svc.MemoryMax);
  const exec = svc.ExecStart;
  if (!exec) { st.active = 'failed'; return { ok: false, msg: `Failed to start ${name}: Unit ${name} has a bad unit file setting.`, code: 1 }; }
  const user = svc.User || 'root';
  const cwd = svc.WorkingDirectory || '/';
  const envr = envFromUnit(host, svc);
  const short = name.replace(/\.service$/, '');
  const fail = (lines, code = 1) => {
    for (const l of lines) host.log(name, l, 'err');
    host.log(name, `${name}: Main process exited, code=exited, status=${code}/FAILURE`, 'warning');
    host.log(name, `${name}: Failed with result 'exit-code'.`, 'warning');
    st.active = 'failed'; st.sub = 'failed'; st.result = 'exit-code'; st.pid = null; st.since = host.time; st.exitCode = code;
    uni.emit({ type: 'unit-failed', host: host.name, unit: name });
    scheduleRestart(host, uni, name, svc);
    return { ok: false, code: 1, msg: `Job for ${name} failed because the control process exited with error code.\nSee "systemctl status ${name}" and "journalctl -xeu ${name}" for details.` };
  };
  if (envr.error) return fail([envr.error]);
  if (!host.users.has(user)) return fail([`${name}: Failed to determine user credentials: No such process`, `${name}: Failed at step USER spawning ${exec.split(/\s+/)[0]}: No such process`], 217);
  if (!host.isDir(cwd)) return fail([`${name}: Changing to the requested working directory failed: No such file or directory`, `${name}: Failed at step CHDIR spawning ${exec.split(/\s+/)[0]}: No such file or directory`], 200);
  const argv = exec.replace(/^[-@+!]+/, '').split(/\s+/);
  const bin = argv[0];
  if (bin.startsWith('/') && !host.files.has(bin) && !['/usr/bin/node', '/usr/bin/python3', '/usr/sbin/nginx', '/usr/bin/redis-server', '/usr/bin/npm', '/usr/local/bin/node'].includes(bin) && !host.binPaths?.has(bin)) return fail([`${name}: Failed to locate executable ${bin}: No such file or directory`, `${name}: Failed at step EXEC spawning ${bin}: No such file or directory`], 203);
  host.log(name, `Started ${unit.sections.Unit?.Description || name}.`, 'info');
  let r;
  if (bin.endsWith('nginx')) {
    const prog = new Nginx({ host, uni });
    const s = prog.start();
    if (!s.ok) return fail(s.logs);
    const proc = host.addProc({ cmd: 'nginx: master process /usr/sbin/nginx -g daemon on; master_process on;', user: 'root', mem: 6, unit: name, program: prog });
    prog.proc = proc;
    host.addProc({ cmd: 'nginx: worker process', user: 'www-data', mem: 6, unit: name, ppid: proc.pid });
    for (const p of s.ports) { try { host.listen(p.port, proc.pid, { addr: p.addr, program: prog }); } catch { host.killProc(proc.pid); return fail([`nginx: [emerg] bind() to 0.0.0.0:${p.port} failed (98: Address already in use)`, 'nginx: [emerg] still could not bind()']); } }
    r = { ok: true, proc, logs: [] };
  } else {
    const yes = v => /^(yes|true|1|on)$/i.test(String(v || ''));
    const sandbox = svc.ProtectSystem || yes(svc.ProtectHome) || svc.ReadWritePaths ? { protectSystem: yes(svc.ProtectSystem) ? 'yes' : (svc.ProtectSystem || '').toLowerCase(), protectHome: yes(svc.ProtectHome) || /read-only|tmpfs/.test(svc.ProtectHome || ''), rw: String(svc.ReadWritePaths || '').split(/\s+/).filter(Boolean).map(x => x.replace(/^-/, '')), privateTmp: yes(svc.PrivateTmp) } : null;
    r = launch(host, argv, { uni, user, env: envr.env, cwd, unit: name, logSink: line => host.log(name, line), sandbox });
    if (!r.ok) {
      // the process started and then exited: for Type=simple, `systemctl start` still succeeds;
      // the failure shows up in status and the journal (and Restart= kicks in)
      const f = fail(r.logs, r.code);
      return /^(forking|oneshot|notify)$/.test(svc.Type || '') ? f : { ok: true, crashed: true };
    }
  }
  for (const l of r.logs) host.log(name, l);
  st.active = 'active'; st.sub = r.oneShot ? 'exited' : 'running'; st.pid = r.proc?.pid || null; st.since = host.time; st.result = 'success';
  if (r.proc) r.proc.unit = name;
  uni.emit({ type: 'unit-started', host: host.name, unit: name });
  void short; void quiet;
  return { ok: true };
}

function scheduleRestart(host, uni, name, svc) {
  const policy = svc.Restart || 'no';
  if (!['always', 'on-failure', 'on-abnormal'].includes(policy)) return;
  const st = unitState(host, name);
  const sec = Number(String(svc.RestartSec || '0.1').replace(/s$/, '')) || 0.1;
  const now = host.time;
  st.restarts = st.restarts.filter(t => now - t < 10).concat(now);
  if (st.restarts.length > 5) {
    host.log(name, `${name}: Start request repeated too quickly.`, 'warning');
    host.log(name, `${name}: Failed with result '${st.result === 'oom-kill' ? 'oom-kill' : 'exit-code'}'.`, 'warning');
    st.result = 'start-limit-hit';
    st.pendingRestart = null;
    return;
  }
  st.active = 'activating'; st.sub = 'auto-restart';
  st.pendingRestart = now + sec;
  host.log(name, `${name}: Scheduled restart job, restart counter is at ${(st.counter = (st.counter || 0) + 1)}.`, 'info');
}

export function stopUnit(host, uni, name) {
  const st = unitState(host, name);
  for (const p of [...host.procs.values()]) if (p.unit === name) host.killProc(p.pid);
  if (st.active !== 'inactive') host.log(name, `Stopped ${name}.`);
  st.active = 'inactive'; st.sub = 'dead'; st.pid = null; st.since = host.time; st.pendingRestart = null; st.counter = 0;
  uni.emit({ type: 'unit-stopped', host: host.name, unit: name });
}

// the systemd "ticker": restarts crashed services, notices processes that died
export function installSystemdTicker(uni) {
  uni.tickers.push((step = 2) => {
    for (const host of uni.hosts.values()) {
      for (const st of host.units.values()) {
        // a leaking service grows; past MemoryMax= the cgroup's OOM killer ends it
        const lp = st.active === 'active' && st.pid && host.leaks?.[st.name] ? host.procs.get(st.pid) : null;
        if (lp) {
          lp.mem = (lp.mem || 30) + host.leaks[st.name] * step;
          const hostFull = host.memUsedMB() > host.memMB * 0.97;
          if ((st.memoryMax && lp.mem > st.memoryMax) || hostFull) {
            const cg = !!st.memoryMax && lp.mem > st.memoryMax;
            host.journal.push({ time: host.time, unit: 'kernel', prio: 'err', msg: cg ? `Memory cgroup out of memory: Killed process ${lp.pid} (${lp.cmd.split(' ')[0].split('/').pop()}) total-vm:${Math.round(lp.mem * 3200)}kB, anon-rss:${Math.round(lp.mem * 1024)}kB, file-rss:0kB, shmem-rss:0kB, UID:${host.users.get(lp.user)?.uid ?? 0} pgtables:1124kB oom_score_adj:0` : `Out of memory: Killed process ${lp.pid} (${lp.cmd.split(' ')[0].split('/').pop()}) total-vm:${Math.round(lp.mem * 3200)}kB, anon-rss:${Math.round(lp.mem * 1024)}kB, file-rss:0kB, shmem-rss:0kB, UID:${host.users.get(lp.user)?.uid ?? 0} pgtables:5012kB oom_score_adj:0` });
            host.log(st.name, `${st.name}: A process of this unit has been killed by the OOM killer.`, 'warning');
            host.log(st.name, `${st.name}: Main process exited, code=killed, status=9/KILL`, 'warning');
            host.log(st.name, `${st.name}: Failed with result 'oom-kill'.`, 'warning');
            host.killProc(lp.pid, 'KILL');
            st.active = 'failed'; st.sub = 'failed'; st.result = 'oom-kill'; st.lastPid = st.pid; st.pid = null; st.since = host.time; st.oomKills = (st.oomKills || 0) + 1;
            uni.emit({ type: 'oom-kill', host: host.name, unit: st.name, cgroup: cg });
            scheduleRestart(host, uni, st.name, effective(host, st).sections.Service || {});
          }
        }
        if (st.active === 'active' && st.pid && !host.procs.has(st.pid) && st.sub === 'running') {
          host.log(st.name, `${st.name}: Main process exited, code=killed, status=9/KILL`, 'warning');
          st.active = 'failed'; st.sub = 'failed'; st.result = 'signal'; st.pid = null; st.since = host.time;
          scheduleRestart(host, uni, st.name, effective(host, st).sections.Service || {});
        }
        if (st.pendingRestart && host.time >= st.pendingRestart) {
          st.pendingRestart = null;
          st.active = 'inactive';
          st.nRestarts = (st.nRestarts || 0) + 1;
          startUnit(host, uni, st.name);
        }
      }
      for (const p of [...host.procs.values()]) if (p.expires && host.time >= p.expires) host.killProc(p.pid, 'EXIT');
      runCron(host, uni);
    }
  });
}

// ---------- cron ----------
function cronMatch(field, v) {
  return field.split(',').some(part => {
    const [range, step] = part.split('/');
    const st = Number(step || 1);
    if (range === '*') return v % st === 0;
    const [a, b] = range.split('-').map(Number);
    if (b === undefined) return step ? v >= a && (v - a) % st === 0 : v === a;
    return v >= a && v <= b && (v - a) % st === 0;
  });
}

function runCron(host, uni) {
  if (!host.cronEnabled) return;
  const minute = Math.floor(host.time / 60);
  if (host.lastCronMinute === undefined) { host.lastCronMinute = minute; return; }
  while (host.lastCronMinute < minute) {
    host.lastCronMinute++;
    const d = new Date(host.lastCronMinute * 60000);
    const vals = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
    const entries = [];
    for (const [user, text] of host.crontabs) for (const line of text.split('\n')) entries.push([user, line]);
    for (const f of [...host.files.keys()].filter(p => p.startsWith('/etc/cron.d/'))) for (const line of host.files.get(f).split('\n')) { const parts = line.trim().split(/\s+/); if (parts.length > 6 && !line.trim().startsWith('#')) entries.push([parts[5], parts.slice(0, 5).concat(parts.slice(6)).join(' ')]); }
    for (const [user, raw] of entries) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || /^\w+=/.test(line)) continue;
      let fields, cmd;
      const special = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@reboot': null };
      if (line.startsWith('@')) { const [k, ...rest] = line.split(/\s+/); if (!special[k]) continue; fields = special[k].split(' '); cmd = rest.join(' '); }
      else { const parts = line.split(/\s+/); fields = parts.slice(0, 5); cmd = parts.slice(5).join(' '); }
      if (fields.length < 5 || !cmd) continue;
      if (fields.every((f, k) => cronMatch(f, vals[k]))) {
        host.log('cron.service', `(${user}) CMD (${cmd})`);
        uni.emit({ type: 'cron-run', host: host.name, user, cmd });
        uni.cronRunner?.(host, user, cmd);
      }
    }
  }
}

// ---------- commands ----------
function needRoot(c, what) {
  if (c.user === 'root') return null;
  return c.fail(`Failed to ${what}: Access denied\nSee system logs and 'systemctl status' for details.`, 1);
}

function statusText(host, uni, name) {
  const st = unitState(host, name);
  const path = findUnitFile(host, name);
  if (!path) return null;
  const unit = st.loadedText !== null && st.loadedText !== undefined ? effective(host, st) : parseUnit(host.files.get(path) + '\n' + dropinText(host, name));
  const dot = st.active === 'active' ? C.green('●') : st.active === 'failed' ? C.red('×') : st.active === 'activating' ? C.yellow('●') : '○';
  const act = st.active === 'active' ? C.green(C.bold(`active (${st.sub})`)) : st.active === 'failed' ? C.red(C.bold(`failed`)) + ` (Result: ${st.result})` : st.active === 'activating' ? C.yellow(`activating (${st.sub})`) : `inactive (dead)`;
  const lines = [
    `${dot} ${name} - ${unit.sections.Unit?.Description || name}`,
    `     Loaded: loaded (${path}; ${st.enabled ? C.green('enabled') : 'disabled'}; preset: enabled)`,
    ...(dropinFiles(host, name).length ? [`    Drop-In: /etc/systemd/system/${name}.d`, ...dropinFiles(host, name).map((p, i, a) => `             ${i === a.length - 1 ? '└─' : '├─'}${p.split('/').pop()}`)] : []),
    `     Active: ${act} since ${fmtDate(st.since, '%a %F %T')} UTC; ${Math.max(1, Math.round((host.time - st.since) / 60))}min ago`,
  ];
  if (changedOnDisk(host, st, path)) lines.splice(2, 0, `     ${C.yellow('Warning:')} The unit file, source configuration file or drop-ins of ${name} changed on disk. Run 'systemctl daemon-reload' to reload units.`);
  if (st.pid && host.procs.has(st.pid)) {
    const p = host.procs.get(st.pid);
    lines.push(`   Main PID: ${st.pid} (${p.cmd.split(' ')[0].split('/').pop().replace(':', '')})`, `      Tasks: ${1 + [...host.procs.values()].filter(x => x.ppid === st.pid).length}`, `     Memory: ${(p.mem || 10).toFixed(1)}M${st.memoryMax ? ` (max: ${st.memoryMax.toFixed(1)}M available: ${Math.max(0, st.memoryMax - (p.mem || 10)).toFixed(1)}M)` : ''}`, `     CGroup: /system.slice/${name}`, `             └─${st.pid} ${p.cmd}`);
  } else if (st.active === 'failed') lines.push(`    Process: ${st.lastPid || 4242} ExecStart=${unit.sections.Service?.ExecStart} (code=exited, status=${st.exitCode ?? 1}/FAILURE)`, `   Main PID: ${st.lastPid || 4242} (code=exited, status=${st.exitCode ?? 1}/FAILURE)`);
  const logs = host.journal.filter(j => j.unit === name).slice(-10);
  if (logs.length) { lines.push(''); for (const j of logs) lines.push(journalLine(host, j)); }
  return lines;
}

function journalLine(host, j) {
  const pid = j.unit === 'kernel' ? '' : '[4242]';
  const ident = j.unit === 'kernel' ? 'kernel' : j.unit.replace(/\.service$/, '');
  const text = `${fmtDate(j.time, '%b %d %T')} ${host.name} ${ident}${pid}: ${j.msg}`;
  return j.prio === 'err' ? C.red(C.bold(text)) : j.prio === 'warning' ? C.yellow(text) : text;
}

def('systemctl', c => {
  const o = opts(c.args, { bool: ['--now', '--failed', '--all', '-a', '--no-pager', '-l', '--quiet', '-q', '--full', '--user', '--value'], val: ['--type', '-t', '--state', '-p', '--property'] });
  const [sub, ...rest] = o._;
  const host = c.host, uni = c.uni;
  if (host.kind === 'container') return c.fail('System has not been booted with systemd as init system (PID 1). Can\'t operate.\nFailed to connect to bus: Host is down', 1);
  const names = rest.map(unitName);
  switch (sub) {
    case undefined: case 'list-units': {
      let units = [...host.units.values()].filter(u => findUnitFile(host, u.name));
      if (o['--failed'] || o['--state'] === 'failed') units = units.filter(u => u.active === 'failed');
      else if (!o['--all'] && !o['-a']) units = units.filter(u => u.active !== 'inactive');
      c.print(`  ${'UNIT'.padEnd(28)} LOAD   ACTIVE   SUB     DESCRIPTION`);
      for (const u of units) {
        const desc = parseUnit(host.files.get(findUnitFile(host, u.name))).sections.Unit?.Description || '';
        const line = `${u.active === 'failed' ? C.red('●') : ' '} ${u.name.padEnd(28)} loaded ${u.active.padEnd(8)} ${u.sub.padEnd(7)} ${desc}`;
        c.print(u.active === 'failed' ? C.red(line) : line);
      }
      c.print('', `${units.length} loaded units listed.`);
      return 0;
    }
    case 'list-unit-files': {
      c.print(`${'UNIT FILE'.padEnd(30)} STATE`);
      for (const d of UNIT_DIRS) if (host.isDir(d)) for (const [n, k] of host.listDir(d)) if (k === 'file' && n.endsWith('.service')) c.print(`${n.padEnd(30)} ${unitState(host, n).enabled ? 'enabled' : 'disabled'}`);
      return 0;
    }
    case 'daemon-reload':
      if (needRoot(c, 'reload daemon') !== null) return 1;
      for (const st of host.units.values()) { const p = findUnitFile(host, st.name); if (p) { st.loadedText = host.files.get(p); st.loadedDropins = dropinText(host, st.name); } }
      uni.emit({ type: 'daemon-reload', host: host.name });
      return 0;
    case 'start': case 'stop': case 'restart': case 'reload': case 'try-restart': case 'reload-or-restart': {
      if (!names.length) return c.fail(`Too few arguments.`, 1);
      if (c.user !== 'root') return c.fail(`Failed to ${sub} ${names[0]}: Interactive authentication required.\nSee system logs and 'systemctl status ${names[0]}' for details.`, 1);
      let code = 0;
      for (const n of names) {
        if (!findUnitFile(host, n)) { c.eprint(`Failed to ${sub} ${n}: Unit ${n} not found.`); code = 5; continue; }
        const st = unitState(host, n);
        const fileText = host.files.get(findUnitFile(host, n));
        void fileText;
        if (changedOnDisk(host, st, findUnitFile(host, n))) c.eprint(`${C.yellow('Warning:')} The unit file, source configuration file or drop-ins of ${n} changed on disk. Run 'systemctl daemon-reload' to reload units.`);
        if (sub === 'stop') { stopUnit(host, uni, n); continue; }
        if (sub === 'reload') {
          const proc = st.pid && host.procs.get(st.pid);
          if (!proc) { c.eprint(`${n} is not active, cannot reload.`); code = 1; continue; }
          if (proc.program?.reload) { try { proc.program.reload(); host.log(n, `Reloaded ${n}.`); } catch (e) { host.log(n, e.message, 'err'); c.eprint(`Job for ${n} failed.\nSee "systemctl status ${n}" and "journalctl -xeu ${n}" for details.`); code = 1; } }
          continue;
        }
        if (sub === 'restart' || sub === 'try-restart' || sub === 'reload-or-restart') stopUnit(host, uni, n);
        st.counter = 0; st.restarts = [];
        const r = startUnit(host, uni, n);
        if (!r.ok) { c.eprint(r.msg); code = r.code || 1; }
      }
      return code;
    }
    case 'enable': case 'disable': {
      if (c.user !== 'root') return c.fail(`Failed to ${sub} unit: Access denied`, 1);
      let code = 0;
      for (const n of names) {
        const p = findUnitFile(host, n);
        if (!p) { c.eprint(`Failed to ${sub} unit: Unit file ${n} does not exist.`); code = 1; continue; }
        const st = unitState(host, n);
        const wanted = parseUnit(host.files.get(p)).sections.Install?.WantedBy;
        if (sub === 'enable' && !wanted) c.eprint(`The unit files have no installation config (WantedBy=, RequiredBy=, Also=,\nAlias= settings in the [Install] section, and DefaultInstance= for template\nunits). This means they are not meant to be enabled or disabled using systemctl.`);
        else if (sub === 'enable' && !st.enabled) c.print(`Created symlink /etc/systemd/system/${wanted}.wants/${n} → ${p}.`);
        else if (sub === 'disable' && st.enabled) c.print(`Removed "/etc/systemd/system/${wanted || 'multi-user.target'}.wants/${n}".`);
        if (wanted || sub === 'disable') st.enabled = sub === 'enable';
        if (o['--now']) { if (sub === 'enable') { const r = startUnit(host, uni, n); if (!r.ok) { c.eprint(r.msg); code = 1; } } else stopUnit(host, uni, n); }
      }
      return code;
    }
    case 'status': {
      if (!names.length) { c.print(`${C.green('●')} ${host.name}`, `    State: ${[...host.units.values()].some(u => u.active === 'failed') ? C.red('degraded') : C.green('running')}`, `    Units: ${host.units.size} loaded`, `   Failed: ${[...host.units.values()].filter(u => u.active === 'failed').length} units`); return 0; }
      let code = 0;
      names.forEach((n, k) => {
        const lines = statusText(host, uni, n);
        if (!lines) { c.eprint(`Unit ${n} could not be found.`); code = 4; return; }
        if (k) c.print('');
        c.print(...lines);
        if (unitState(host, n).active !== 'active') code = 3;
      });
      return code;
    }
    case 'is-active': { let code = 0; for (const n of names) { const st = unitState(host, n); if (!o['--quiet'] && !o['-q']) c.print(st.active); if (st.active !== 'active') code = 3; } return code; }
    case 'is-enabled': { const st = unitState(host, names[0]); c.print(findUnitFile(host, names[0]) ? (st.enabled ? 'enabled' : 'disabled') : 'not-found'); return st.enabled ? 0 : 1; }
    case 'is-failed': { const st = unitState(host, names[0]); c.print(st.active === 'failed' ? 'failed' : st.active); return st.active === 'failed' ? 0 : 1; }
    case 'cat': {
      for (const n of names) { const p = findUnitFile(host, n); if (!p) return c.fail(`No files found for ${n}.`, 1); c.print(C.blue(`# ${p}`), ...host.files.get(p).replace(/\n$/, '').split('\n')); for (const d of dropinFiles(host, n)) c.print('', C.blue(`# ${d}`), ...host.files.get(d).replace(/\n$/, '').split('\n')); }
      return 0;
    }
    case 'show': {
      const st = unitState(host, names[0]);
      const svc = (findUnitFile(host, names[0]) ? (st.loadedText !== null && st.loadedText !== undefined ? effective(host, st) : parseUnit(host.files.get(findUnitFile(host, names[0])) + '\n' + dropinText(host, names[0]))) : { sections: {} }).sections.Service || {};
      const p = st.pid && host.procs.get(st.pid);
      const props = { Id: names[0], ActiveState: st.active, SubState: st.sub, Result: st.result, MainPID: st.pid || 0, UnitFileState: st.enabled ? 'enabled' : 'disabled', User: svc.User || '', Restart: svc.Restart || 'no', RestartUSec: svc.RestartSec ? `${parseFloat(svc.RestartSec)}s` : '100ms', NRestarts: st.nRestarts || 0, MemoryCurrent: p ? Math.round((p.mem || 10) * 1048576) : '[not set]', MemoryMax: st.memoryMax ?? sizeMB(svc.MemoryMax) ? Math.round((st.memoryMax ?? sizeMB(svc.MemoryMax)) * 1048576) : 'infinity', CPUQuotaPerSecUSec: svc.CPUQuota ? `${parseFloat(svc.CPUQuota) * 10}ms` : 'infinity', NoNewPrivileges: /^(yes|true)$/i.test(svc.NoNewPrivileges || '') ? 'yes' : 'no', ProtectSystem: svc.ProtectSystem || 'no', ProtectHome: svc.ProtectHome || 'no', PrivateTmp: /^(yes|true)$/i.test(svc.PrivateTmp || '') ? 'yes' : 'no', ReadWritePaths: svc.ReadWritePaths || '', DropInPaths: dropinFiles(host, names[0]).join(' ') };
      const want = (o['-p'] || o['--property'] || '').split(',').filter(Boolean);
      const keys = want.length ? want : Object.keys(props);
      for (const k of keys) c.print(o['--value'] ? String(props[k] ?? '') : `${k}=${props[k] ?? ''}`);
      uni.emit({ type: 'systemctl-show', host: host.name, unit: names[0], props: keys });
      return 0;
    }
    case 'edit': {
      if (!names.length) return c.fail('Too few arguments.', 1);
      if (c.user !== 'root') return c.fail('Failed to edit unit: Access denied', 1);
      const n = names[0];
      if (!findUnitFile(host, n)) return c.fail(`No files found for ${n}.`, 1);
      const path = `/etc/systemd/system/${n}.d/override.conf`;
      const cur = host.files.get(path) || '';
      const body = host.files.get(findUnitFile(host, n)).replace(/\n$/, '').split('\n').map(l => `# ${l}`).join('\n');
      c.result.editor = {
        title: `/etc/systemd/system/${n}.d/.#override.conf`,
        content: `### Editing ${path}\n### Anything between here and the comment below will become the contents of the drop-in file\n\n${cur.replace(/\n$/, '')}\n\n### Edits below this comment will be discarded\n\n### ${findUnitFile(host, n)}\n${body}\n`,
        onSave(text, { io }) {
          const keep = text.split('### Edits below this comment will be discarded')[0].split('\n').filter(l => !l.startsWith('###')).join('\n').trim();
          if (!keep) { io.out(''); return 0; }
          host.mkdirMeta(`/etc/systemd/system/${n}.d`, 'root');
          host.writeSys(path, keep + '\n');
          const st = unitState(host, n);
          st.loadedText = host.files.get(findUnitFile(host, n)); st.loadedDropins = dropinText(host, n);
          uni.emit({ type: 'systemctl-edit', host: host.name, unit: n, text: keep });
          return 0;
        },
      };
      return 0;
    }
    case 'reboot': case 'poweroff': return c.fail(C.dim('(rebooting is disabled in the simulator)'), 1);
  }
  return c.fail(`Unknown command verb '${sub}'.`, 1);
});

// systemd-analyze security: how much of the system a service could reach if it were compromised
const HARDENING = [
  ['User=/DynamicUser=', svc => svc.User && svc.User !== 'root' || /^(yes|true)$/i.test(svc.DynamicUser || ''), 2.0, 'Service runs as root user', 'Service runs under a static non-root user identity'],
  ['NoNewPrivileges=', svc => /^(yes|true)$/i.test(svc.NoNewPrivileges || ''), 1.0, 'Service processes may acquire new privileges', 'Service processes cannot acquire new privileges'],
  ['ProtectSystem=', svc => /^(strict)$/i.test(svc.ProtectSystem || '') ? 1 : /^(full|yes|true)$/i.test(svc.ProtectSystem || '') ? 0.6 : 0, 1.5, 'Service has full access to the OS file hierarchy', 'Service has strict read-only access to the OS file hierarchy'],
  ['ProtectHome=', svc => /^(yes|true|read-only|tmpfs)$/i.test(svc.ProtectHome || ''), 0.8, 'Service has full access to home directories', 'Service has no access to home directories'],
  ['PrivateTmp=', svc => /^(yes|true)$/i.test(svc.PrivateTmp || ''), 0.6, 'Service has access to other software\'s temporary files', 'Service has no access to other software\'s temporary files'],
  ['PrivateDevices=', svc => /^(yes|true)$/i.test(svc.PrivateDevices || ''), 0.6, 'Service potentially has access to hardware devices', 'Service has no access to hardware devices'],
  ['ProtectKernelTunables=', svc => /^(yes|true)$/i.test(svc.ProtectKernelTunables || ''), 0.5, 'Service may alter kernel tunables', 'Service cannot alter kernel tunables (/proc/sys, …)'],
  ['ProtectKernelModules=', svc => /^(yes|true)$/i.test(svc.ProtectKernelModules || ''), 0.5, 'Service may load or read kernel modules', 'Service cannot load or read kernel modules'],
  ['ProtectControlGroups=', svc => /^(yes|true)$/i.test(svc.ProtectControlGroups || ''), 0.4, 'Service may modify the control group file system', 'Service cannot modify the control group file system'],
  ['RestrictSUIDSGID=', svc => /^(yes|true)$/i.test(svc.RestrictSUIDSGID || ''), 0.3, 'Service may create SUID/SGID files', 'SUID/SGID file creation by service is restricted'],
  ['CapabilityBoundingSet=', svc => svc.CapabilityBoundingSet !== undefined && !/CAP_SYS_ADMIN/.test(svc.CapabilityBoundingSet), 0.8, 'Service may hold any capability (CAP_SYS_ADMIN, CAP_NET_ADMIN, …)', 'Service has a restricted capability bounding set'],
];
export function exposure(svc) { let got = 0; for (const [, test, w] of HARDENING) got += Number(test(svc)) * w; return Math.max(0.6, +(9.6 - got).toFixed(1)); }
const levelOf = x => x < 2 ? 'OK 🙂' : x < 5 ? 'MEDIUM 😐' : x < 7 ? 'EXPOSED 🙁' : 'UNSAFE 😨';

def('systemd-analyze', c => {
  const [sub, unit] = c.args.filter(a => !a.startsWith('-'));
  const host = c.host;
  if (sub !== 'security') return c.fail(C.dim('(the simulator implements systemd-analyze security [UNIT])'), 1);
  const svcOf = n => { const st = unitState(host, n); const p = findUnitFile(host, n); if (!p) return null; return (st.loadedText !== null && st.loadedText !== undefined ? effective(host, st) : parseUnit(host.files.get(p) + '\n' + dropinText(host, n))).sections.Service || {}; };
  if (!unit) {
    c.print('UNIT                                 EXPOSURE PREDICATE HAPPY');
    for (const st of host.units.values()) { const svc = svcOf(st.name); if (!svc || !st.name.endsWith('.service')) continue; const x = exposure(svc); c.print(`${st.name.padEnd(36)} ${x.toFixed(1).padStart(8)} ${levelOf(x).split(' ')[0].padEnd(9)} ${levelOf(x).split(' ')[1]}`); }
    return 0;
  }
  const n = unitName(unit);
  const svc = svcOf(n);
  if (!svc) return c.fail(`Failed to get unit file state for ${n}: No such file or directory`, 1);
  c.print('  NAME                         DESCRIPTION                                                        EXPOSURE');
  for (const [name, test, w, bad, good] of HARDENING) { const v = Number(test(svc)); c.print(`${v >= 1 ? C.green('✓') : C.red('✗')} ${name.padEnd(28)} ${(v >= 1 ? good : bad).padEnd(66)} ${v >= 1 ? '' : (w * (1 - v)).toFixed(1)}`.trimEnd()); }
  const x = exposure(svc);
  c.print('', `→ Overall exposure level for ${n}: ${x.toFixed(1)} ${levelOf(x)}`);
  c.uni.emit({ type: 'systemd-analyze', host: host.name, unit: n, exposure: x });
  return 0;
}, { always: true });

def('service', c => {
  const [name, action] = c.args;
  if (!name || !action) return c.fail('Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]', 1);
  return c.sh.runArgv(['systemctl', action, name], c.e, c.io, c.result, {});
});

def('journalctl', c => {
  const o = opts(c.args, { bool: ['-f', '-x', '-e', '-xe', '--no-pager', '-r', '-k', '-b', '--follow', '-q'], val: ['-u', '--unit', '-n', '--lines', '--since', '--until', '-p', '--priority', '-t', '-o'], alias: { '--unit': '-u', '--lines': '-n', '--priority': '-p', '--follow': '-f' } });
  const host = c.host;
  const vac = c.args.find(a => a.startsWith('--vacuum-size') || a.startsWith('--vacuum-time'));
  if (vac) {
    if (c.user !== 'root') return c.fail('Failed to open journal directory: Permission denied', 1);
    const files = [...(host.fakeSizes || new Map())].filter(([p]) => p.startsWith('/var/log/journal/'));
    const total = files.reduce((t, [, n]) => t + n, 0);
    const m = vac.match(/=(\d+(?:\.\d+)?)([KMG])?/);
    const target = vac.startsWith('--vacuum-size') && m ? Number(m[1]) * ({ K: 1024, M: 1048576, G: 1073741824 }[m[2] || 'M']) : total * 0.08;
    let freed = 0;
    for (const [p, n] of files.sort((a, b) => a[0].localeCompare(b[0]))) {
      if (total - freed <= target) break;
      if (p.endsWith('/system.journal')) continue;
      c.print(`Deleted archived journal ${p} (${(n / 1073741824).toFixed(1)}G).`);
      host.fakeSizes.delete(p); Map.prototype.delete.call(host.files, p); freed += n;
    }
    c.print(`Vacuuming done, freed ${(freed / 1073741824).toFixed(1)}G of archived journals from /var/log/journal/${'a1b2c3d4e5f6'}.`);
    c.uni.emit({ type: 'journal-vacuum', host: host.name, freed });
    return 0;
  }
  if (c.args.includes('--disk-usage')) { const tot = [...(host.fakeSizes || new Map())].filter(([p]) => p.startsWith('/var/log/journal/')).reduce((t, [, n]) => t + n, 0); c.print(`Archived and active journals take up ${(tot / 1073741824).toFixed(1)}G in the file system.`); return 0; }
  if (c.user !== 'root' && !host.userGroups(c.user).some(g => ['adm', 'systemd-journal', 'sudo'].includes(g))) c.eprint('Hint: You are currently not seeing messages from other users and the system.\n      Users in groups \'adm\', \'systemd-journal\' can see all messages.');
  let entries = host.journal;
  const units = c.args.reduce((acc, a, k) => (a === '-u' || a === '--unit') ? acc.concat(unitName(c.args[k + 1])) : acc, []);
  if (units.length) entries = entries.filter(j => units.includes(j.unit));
  if (o['-k']) entries = entries.filter(j => j.unit === 'kernel');
  if (o['-p']) { const order = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']; const max = order.indexOf(o['-p'] === '3' ? 'err' : o['-p']); entries = entries.filter(j => order.indexOf(j.prio) <= max); }
  if (o['--since']) {
    const s = o['--since'];
    let since = null, m;
    if ((m = s.match(/^(\d+)\s*(min|minutes?|m|hours?|h|days?|d)\s+ago$/))) since = host.time - Number(m[1]) * (m[2].startsWith('h') ? 3600 : m[2].startsWith('d') ? 86400 : 60);
    else if (s === 'today') since = host.time - (host.time % 86400);
    else if (s === 'yesterday') since = host.time - (host.time % 86400) - 86400;
    else if (/^-\d+[mhd]?$/.test(s)) since = host.time - Number(s.slice(1).replace(/\D/g, '')) * (s.endsWith('h') ? 3600 : s.endsWith('d') ? 86400 : 60);
    if (since !== null) entries = entries.filter(j => j.time >= since);
  }
  if (o['-n'] !== undefined) entries = entries.slice(-Number(o['-n']));
  else if (o['-e'] || o['-xe']) entries = entries.slice(-30);
  if (o['-r']) entries = [...entries].reverse();
  if (!entries.length) { c.print('-- No entries --'); return 0; }
  for (const j of entries) c.print(o['-o'] === 'cat' ? j.msg : journalLine(host, j));
  if (o['-f']) c.eprint(C.dim('(journalctl -f keeps following in a real terminal; the simulator shows what is there now)'));
  return 0;
});

def('crontab', c => {
  const o = opts(c.args, { bool: 'lre', val: ['-u'] });
  const user = o['-u'] || c.user;
  if (o['-u'] && c.user !== 'root') return c.fail(`must be privileged to use -u`, 1);
  const host = c.host;
  if (o['-l']) { const t = host.crontabs.get(user); if (!t) return c.fail(`no crontab for ${user}`, 1); c.out(t.endsWith('\n') ? t : t + '\n'); return 0; }
  if (o['-r']) { host.crontabs.delete(user); return 0; }
  if (o['-e']) {
    const cur = host.crontabs.get(user) ?? '# Edit this file to introduce tasks to be run by cron.\n#\n# m h  dom mon dow   command\n';
    c.result.editor = {
      title: `crontab (${user})`, content: cur, file: true, hint: 'Each line: minute hour day-of-month month day-of-week command',
      onSave(text, { io }) {
        for (const line of text.split('\n')) {
          const l = line.trim();
          if (!l || l.startsWith('#') || /^\w+=/.test(l)) continue;
          const parts = l.split(/\s+/);
          const ok = l.startsWith('@') ? ['@reboot', '@hourly', '@daily', '@midnight', '@weekly', '@monthly', '@yearly', '@annually'].includes(parts[0]) && parts.length > 1 : parts.length >= 6 && parts.slice(0, 5).every(f => /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/.test(f));
          if (!ok) { io.err(`crontab: installing new crontab\n"/tmp/crontab.xyz":${text.split('\n').indexOf(line) + 1}: bad minute\nerrors in crontab file, can't install.\n`); return 1; }
        }
        host.crontabs.set(user, text);
        host.cronEnabled = true;
        io.out('crontab: installing new crontab\n');
        c.uni.emit({ type: 'crontab', host: host.name, user, text });
        return 0;
      },
    };
    return 0;
  }
  const file = o._[0];
  if (file) { const t = file === '-' ? c.stdin : host.files.get(c.resolve(file)); if (t === undefined) return c.fail(`crontab: ${file}: No such file or directory`, 1); host.crontabs.set(user, t); host.cronEnabled = true; c.uni.emit({ type: 'crontab', host: host.name, user, text: t }); return 0; }
  return c.fail('usage:\tcrontab [-u user] file\n\tcrontab [-u user] [ -e | -l | -r ]', 1);
});

export { findUnitFile, unitName, journalLine };
