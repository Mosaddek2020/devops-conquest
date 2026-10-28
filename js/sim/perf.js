// Performance troubleshooting tools. Processes can carry an I/O rate, a CPU share, a state
// (R running, D waiting on disk), a nice value and an I/O class, and a network peer they
// keep trying to reach. From that the simulator derives what vmstat, iostat, pidstat and
// top report (run queue, blocked tasks, I/O wait, %util, load average), what strace shows
// a process doing, what tcpdump sees on the wire, and the kernel log for dmesg.

import { def, opts } from './registry.js';
import { C } from '../git/world.js';
import { connect } from './net.js';

const DISK_KBS = 140000; // what the simulated disk sustains, KB/s

// the live picture of a machine with a performance model
export function perfStats(h) {
  const procs = [...h.procs.values()];
  const ioWeight = p => (p.ioClass === 'idle' ? 0.04 : p.ioClass === 'be-low' ? 0.5 : 1);
  const demand = procs.reduce((s, p) => s + ((p.io?.r || 0) + (p.io?.w || 0)) * ioWeight(p), 0);
  const util = Math.min(99.8, demand / DISK_KBS * 100);
  const cpuDemand = procs.reduce((s, p) => s + (p.cpu || 0) * (p.nice > 0 ? 1 - Math.min(0.6, p.nice / 30) : 1), 0);
  const cpus = h.cpus || 2;
  const us = Math.min(98, cpuDemand / cpus);
  const blocked = procs.filter(p => p.state === 'D' && ioWeight(p) >= 0.5).length + (util > 90 ? Math.round((util - 90) / 2) : 0);
  const running = Math.max(1, Math.round(cpuDemand / 100));
  const wa = util > 85 ? Math.min(60 - us / 3, 38 + (util - 85)) : util * 0.15;
  const awaitMs = util > 90 ? 180 + (util - 90) * 30 : 2 + util / 10;
  return { util, demand, us, sy: Math.min(12, 2 + us / 10), wa: Math.max(0, wa), id: Math.max(0, 100 - us - wa - 3), r: running, b: blocked, awaitMs, cpus, rkBs: procs.reduce((s, p) => s + (p.io?.r || 0) * ioWeight(p), 0), wkBs: procs.reduce((s, p) => s + (p.io?.w || 0) * ioWeight(p), 0) };
}

// load average follows the instant demand (run queue + blocked tasks), smoothed like the kernel's
export function installPerfTicker(uni) {
  if (uni.perfTicker) return;
  uni.perfTicker = true;
  uni.tickers.push(step => {
    for (const h of uni.hosts.values()) {
      if (!h.perfModel) continue;
      const st = perfStats(h);
      const inst = st.r + st.b;
      h.loadAvg = h.loadAvg.map((l, i) => { const k = Math.exp(-step / [60, 300, 900][i]); return l * k + inst * (1 - k); });
      for (const p of h.procs.values()) if (p.connectsTo) {
        const r = connect(uni, h, p.connectsTo.host, p.connectsTo.port);
        p.peerState = r.error || 'ESTABLISHED';
        if (!r.error && p.onConnected && !p.connectedOnce) { p.connectedOnce = true; p.onConnected(p); }
      }
    }
  });
}

// lab helper: make a host's processes behave
export function perfHost(uni, h, { load = null, kernel = [] } = {}) {
  installPerfTicker(uni);
  h.perfModel = true;
  if (load) h.loadAvg = load;
  for (const k of kernel) h.journal.push({ time: uni.time - (k.ago || 0), unit: 'kernel', prio: k.prio || 'err', msg: k.msg });
  h.perfStats = () => perfStats(h);
  return h;
}

const pad = (v, n) => String(Math.round(v)).padStart(n);
const jitter = (seed, k) => ((seed * 9301 + k * 49297) % 233280) / 233280 - 0.5;

def('vmstat', c => {
  const h = c.host;
  const nums = c.args.filter(a => /^\d+$/.test(a)).map(Number);
  const count = nums.length >= 2 ? Math.min(nums[1], 10) : nums.length === 1 ? 5 : 1;
  const st = h.perfStats ? h.perfStats() : { r: 1, b: 0, us: Math.min(98, h.cpuBusy() / (h.cpus || 2)), sy: 1, wa: 0.1, id: 97, rkBs: 4, wkBs: 12 };
  const mem = h.memMB, used = Math.min(mem, h.memUsedMB());
  c.print('procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------', ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st');
  for (let i = 0; i < count; i++) {
    const j = k => 1 + jitter(c.uni.time + i, k) * 0.12;
    const us = Math.min(99, st.us * j(1)), wa = Math.min(99 - us, st.wa * j(2)), sy = st.sy;
    c.print(`${pad(i === 0 && count > 1 ? st.r : st.r * j(3), 2)} ${pad(st.b * (i === 0 ? 1 : j(4)), 2)} ${pad((h.swapUsedMB || 0) * 1024, 6)} ${pad((mem - used) * 1024 * 0.4, 6)} ${pad(mem * 30, 6)} ${pad(mem * 1024 * 0.18, 6)} ${pad(h.swapping ? 820 * j(5) : 0, 4)} ${pad(h.swapping ? 1400 * j(6) : 0, 4)} ${pad(st.rkBs * j(7), 5)} ${pad(st.wkBs * j(8), 5)} ${pad(900 * j(9), 4)} ${pad(1800 * j(10), 4)} ${pad(us, 2)} ${pad(sy, 2)} ${pad(Math.max(0, 100 - us - sy - wa), 2)} ${pad(wa, 2)}  0`);
  }
  if (count > 1) c.uni.advance(Math.min(30, (nums[0] || 1) * (count - 1)));
  c.uni.emit({ type: 'perf', host: h.name, tool: 'vmstat', wa: st.wa, b: st.b });
  return 0;
}, { always: true });

def('iostat', c => {
  const h = c.host;
  const o = opts(c.args, { bool: ['-x', '-d', '-c', '-z', '-m', '-k', '-t', '-xz'], val: [] });
  const st = h.perfStats ? h.perfStats() : { util: 0.6, rkBs: 4, wkBs: 12, awaitMs: 1.2, us: 2, sy: 1, wa: 0.1, id: 97 };
  const devs = (h.blockDevices || [{ name: 'xvda' }]).map(d => d.name);
  c.print(`Linux 6.8.0-1015-aws (${h.name}) \t${new Date(c.uni.time * 1000).toISOString().slice(0, 10)} \t_x86_64_\t(${h.cpus || 2} CPU)`, '');
  if (!o['-d']) c.print('avg-cpu:  %user   %nice %system %iowait  %steal   %idle', `          ${st.us.toFixed(2).padStart(6)}    0.00 ${st.sy.toFixed(2).padStart(7)} ${st.wa.toFixed(2).padStart(7)}    0.00 ${st.id.toFixed(2).padStart(7)}`, '');
  if (o['-x'] || o['-xz']) {
    c.print('Device            r/s     rkB/s   r_await     w/s     wkB/s   w_await  aqu-sz  %util');
    devs.forEach((d, i) => { const main = i === 0; c.print(`${d.padEnd(12)} ${(main ? st.rkBs / 64 : 0).toFixed(2).padStart(8)} ${(main ? st.rkBs : 0).toFixed(2).padStart(9)} ${(main ? st.awaitMs : 0).toFixed(2).padStart(9)} ${(main ? st.wkBs / 64 : 0.2).toFixed(2).padStart(7)} ${(main ? st.wkBs : 1.1).toFixed(2).padStart(9)} ${(main ? st.awaitMs * 1.3 : 0.6).toFixed(2).padStart(9)} ${(main ? st.util / 12 : 0).toFixed(2).padStart(7)} ${(main ? st.util : 0.1).toFixed(2).padStart(6)}`); });
  } else {
    c.print('Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn');
    devs.forEach((d, i) => c.print(`${d.padEnd(12)} ${(i === 0 ? (st.rkBs + st.wkBs) / 64 : 0.2).toFixed(2).padStart(8)} ${(i === 0 ? st.rkBs : 0).toFixed(2).padStart(12)} ${(i === 0 ? st.wkBs : 1).toFixed(2).padStart(12)} ${String(Math.round(st.rkBs * 3600)).padStart(10)} ${String(Math.round(st.wkBs * 3600)).padStart(10)}`));
  }
  c.uni.emit({ type: 'perf', host: h.name, tool: 'iostat', util: st.util, x: !!(o['-x'] || o['-xz']) });
  return 0;
}, { pkg: 'sysstat' });

def(['pidstat', 'iotop'], c => {
  const h = c.host;
  const io = c.name === 'iotop' || c.args.some(a => /^-\w*d/.test(a));
  const mem = c.args.some(a => /^-\w*r/.test(a));
  const procs = [...h.procs.values()].filter(p => p.pid !== 1);
  const w = p => (p.ioClass === 'idle' ? 0.04 : 1);
  if (c.name === 'iotop' && c.user !== 'root') return c.fail('iotop requires root or the CAP_NET_ADMIN capability', 1);
  if (c.name === 'iotop') {
    const st = h.perfStats ? h.perfStats() : { rkBs: 0, wkBs: 0 };
    c.print(`Total DISK READ:     ${(st.rkBs / 1024).toFixed(2)} M/s | Total DISK WRITE:     ${(st.wkBs / 1024).toFixed(2)} M/s`, '    TID  PRIO  USER     DISK READ  DISK WRITE  SWAPIN     IO>    COMMAND');
    for (const p of procs.filter(p => (p.io?.r || 0) + (p.io?.w || 0) > 0).sort((a, b) => ((b.io.r + b.io.w) * w(b)) - ((a.io.r + a.io.w) * w(a)))) c.print(`${String(p.pid).padStart(7)} ${(p.ioClass === 'idle' ? 'idle' : 'be/4').padEnd(5)} ${p.user.padEnd(8)} ${((p.io.r * w(p)) / 1024).toFixed(2).padStart(7)} M/s ${((p.io.w * w(p)) / 1024).toFixed(2).padStart(7)} M/s  0.00 % ${(p.ioClass === 'idle' ? 3.1 : 92.4).toFixed(2).padStart(6)} % ${p.cmd}`);
    c.uni.emit({ type: 'perf', host: h.name, tool: 'iotop' });
    return 0;
  }
  c.print(`Linux 6.8.0-1015-aws (${h.name}) \t${new Date(c.uni.time * 1000).toISOString().slice(0, 10)} \t_x86_64_\t(${h.cpus || 2} CPU)`, '');
  const t = new Date(c.uni.time * 1000).toISOString().slice(11, 19);
  if (io) { c.print(`${t}      UID       PID   kB_rd/s   kB_wr/s kB_ccwr/s iodelay  Command`); for (const p of procs) c.print(`${t} ${String(h.users.get(p.user)?.uid ?? 0).padStart(8)} ${String(p.pid).padStart(9)} ${((p.io?.r || 0) * w(p)).toFixed(2).padStart(9)} ${((p.io?.w || 0) * w(p)).toFixed(2).padStart(9)}      0.00 ${String(p.state === 'D' ? Math.round(80 * w(p)) : 0).padStart(7)}  ${p.cmd.split(' ')[0].split('/').pop()}`); }
  else if (mem) { c.print(`${t}      UID       PID  minflt/s  majflt/s     VSZ     RSS   %MEM  Command`); for (const p of procs) c.print(`${t} ${String(h.users.get(p.user)?.uid ?? 0).padStart(8)} ${String(p.pid).padStart(9)} ${'12.00'.padStart(9)} ${'0.00'.padStart(9)} ${String(Math.round((p.mem || 1) * 3200)).padStart(7)} ${String(Math.round((p.mem || 1) * 1024)).padStart(7)} ${((p.mem || 1) / h.memMB * 100).toFixed(2).padStart(6)}  ${p.cmd.split(' ')[0].split('/').pop()}`); }
  else { c.print(`${t}      UID       PID    %usr %system  %guest   %wait    %CPU   CPU  Command`); for (const p of procs) c.print(`${t} ${String(h.users.get(p.user)?.uid ?? 0).padStart(8)} ${String(p.pid).padStart(9)} ${(p.cpu || 0).toFixed(2).padStart(7)} ${((p.cpu || 0) / 8).toFixed(2).padStart(7)}    0.00 ${(p.state === 'D' ? 30 : 0).toFixed(2).padStart(7)} ${((p.cpu || 0) * 1.12).toFixed(2).padStart(7)} ${String(p.pid % (h.cpus || 2)).padStart(5)}  ${p.cmd.split(' ')[0].split('/').pop()}`); }
  c.uni.emit({ type: 'perf', host: h.name, tool: 'pidstat', io, mem });
  return 0;
}, { pkg: 'sysstat' });

def('renice', c => {
  const o = opts(c.args, { bool: [], val: ['-n', '-p'] });
  const n = Number(o['-n'] ?? o._.shift());
  const pids = [...(o['-p'] ? [o['-p']] : []), ...o._].map(Number).filter(Boolean);
  if (Number.isNaN(n) || !pids.length) return c.fail('renice: usage: renice [-n] <priority> [-p] <pid>...', 1);
  for (const pid of pids) {
    const p = c.host.procs.get(pid);
    if (!p) { c.eprint(`renice: failed to get priority for ${pid} (process ID): No such process`); continue; }
    if (c.user !== 'root' && (p.user !== c.user || n < (p.nice || 0))) { c.eprint(`renice: failed to set priority for ${pid} (process ID): Permission denied`); continue; }
    c.print(`${pid} (process ID) old priority ${p.nice || 0}, new priority ${n}`);
    p.nice = n;
    c.uni.emit({ type: 'renice', host: c.host.name, pid, cmd: p.cmd, nice: n });
  }
  return 0;
}, { always: true });

def('ionice', c => {
  const o = opts(c.args, { bool: [], val: ['-c', '-n', '-p'] });
  const pid = Number(o['-p'] || 0);
  const p = pid ? c.host.procs.get(pid) : null;
  if (pid && !p) return c.fail(`ionice: ioprio_get failed: No such process`, 1);
  if (!o['-c']) { if (p) c.print(p.ioClass === 'idle' ? 'idle' : `best-effort: prio ${o['-n'] || 4}`); return 0; }
  if (c.user !== 'root' && p && p.user !== c.user) return c.fail('ionice: ioprio_set failed: Operation not permitted', 1);
  const cls = { 1: 'rt', 2: o['-n'] && Number(o['-n']) >= 6 ? 'be-low' : 'be', 3: 'idle', realtime: 'rt', 'best-effort': 'be', idle: 'idle' }[o['-c']];
  if (!cls) return c.fail(`ionice: unknown scheduling class: '${o['-c']}'`, 1);
  if (!p) return c.fail(C.dim('(ionice COMMAND is not simulated; set an existing process with ionice -c3 -p PID)'), 1);
  p.ioClass = cls;
  c.uni.emit({ type: 'ionice', host: c.host.name, pid, cmd: p.cmd, cls });
  return 0;
}, { always: true });

def('strace', c => {
  const o = opts(c.args, { bool: ['-f', '-tt', '-T', '-c', '-y'], val: ['-p', '-e', '-s', '-o'] });
  if (c.user !== 'root') return c.fail(`strace: attach: ptrace(PTRACE_SEIZE, ${o['-p'] || '?'}): Operation not permitted`, 1);
  if (!o['-p']) return c.fail(C.dim('(the simulator traces running processes: strace -p PID)'), 1);
  const p = c.host.procs.get(Number(o['-p']));
  if (!p) return c.fail(`strace: attach: ptrace(PTRACE_SEIZE, ${o['-p']}): No such process`, 1);
  const lines = [`strace: Process ${p.pid} attached`];
  const ts = k => o['-tt'] ? `${new Date((c.uni.time + k) * 1000).toISOString().slice(11, 19)}.${String(123456 + k * 7919).slice(0, 6)} ` : '';
  if (p.connectsTo) {
    const r = connect(c.uni, c.host, p.connectsTo.host, p.connectsTo.port);
    const ip = c.uni.resolveName(p.connectsTo.host, c.host) || p.connectsTo.host;
    const sa = `{sa_family=AF_INET, sin_port=htons(${p.connectsTo.port}), sin_addr=inet_addr("${ip}")}`;
    for (let k = 0; k < 2; k++) {
      lines.push(`${ts(k * 6)}socket(AF_INET, SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK, IPPROTO_TCP) = 12`);
      if (r.error === 'ETIMEDOUT') lines.push(`${ts(k * 6)}connect(12, ${sa}, 16) = -1 EINPROGRESS (Operation now in progress)`, `${ts(k * 6)}poll([{fd=12, events=POLLOUT}], 1, 5000) = 0 (Timeout)${o['-T'] ? ' <5.004917>' : ''}`, `${ts(k * 6 + 5)}close(12)                               = 0`, `${ts(k * 6 + 5)}write(2, "${p.connectsTo.label || 'connect'} timeout, retrying\\n", ${(p.connectsTo.label || 'connect').length + 18}) = ${(p.connectsTo.label || 'connect').length + 18}`, `${ts(k * 6 + 5)}nanosleep({tv_sec=1, tv_nsec=0}, NULL) = 0`);
      else if (r.error) lines.push(`${ts(k * 6)}connect(12, ${sa}, 16) = -1 ${r.error === 'ECONNREFUSED' ? 'ECONNREFUSED (Connection refused)' : 'EHOSTUNREACH (No route to host)'}`, `${ts(k * 6)}close(12)                               = 0`, `${ts(k * 6)}nanosleep({tv_sec=1, tv_nsec=0}, NULL) = 0`);
      else { lines.push(`${ts(k)}connect(12, ${sa}, 16) = -1 EINPROGRESS (Operation now in progress)`, `${ts(k)}poll([{fd=12, events=POLLOUT}], 1, 5000) = 1 ([{fd=12, revents=POLLOUT}])`, `${ts(k)}sendto(12, "Q\\0\\0\\0+SELECT id, payload FROM jobs WHERE "..., 44, MSG_NOSIGNAL, NULL, 0) = 44`, `${ts(k)}recvfrom(12, "T\\0\\0\\0\\33\\0\\2id\\0\\0\\0@\\4\\0\\1\\0\\0\\0\\27"..., 16384, 0, NULL, NULL) = 211`); break; }
    }
  } else if (p.trace) lines.push(...p.trace.map((l, k) => ts(k) + l));
  else if ((p.io?.r || 0) + (p.io?.w || 0) > 0) for (let k = 0; k < 4; k++) lines.push(`${ts(k)}read(4, "\\x89PNG\\r\\n\\x1a\\n\\0\\0\\0\\rIHDR\\0\\0\\4"..., 65536) = 65536${o['-T'] ? ' <0.084213>' : ''}`, `${ts(k)}write(3, "\\x1f\\x8b\\b\\0\\0\\0\\0\\0\\0\\3\\354\\275"..., 65536) = 65536${o['-T'] ? ' <0.061932>' : ''}`);
  else lines.push(`${ts(0)}epoll_wait(5, [], 1024, 1000)          = 0`, `${ts(1)}epoll_wait(5, [{events=EPOLLIN, data={u32=10, u64=10}}], 1024, 1000) = 1`, `${ts(1)}accept4(10, {sa_family=AF_INET, sin_port=htons(51522), sin_addr=inet_addr("10.0.1.4")}, [16], SOCK_CLOEXEC|SOCK_NONBLOCK) = 13`, `${ts(1)}read(13, "GET /health HTTP/1.1\\r\\nHost: app1"..., 65536) = 78`, `${ts(1)}write(13, "HTTP/1.1 200 OK\\r\\nContent-Type: a"..., 156) = 156`);
  lines.push('^Cstrace: Process ' + p.pid + ' detached');
  c.print(...lines);
  c.eprint(C.dim('(strace keeps printing until you press Ctrl-C in a real terminal; this is a few seconds of it)'));
  c.uni.emit({ type: 'strace', host: c.host.name, pid: p.pid, cmd: p.cmd, peer: p.connectsTo ? p.peerState : null });
  return 0;
}, { pkg: 'strace' });

def('tcpdump', c => {
  const o = opts(c.args, { bool: ['-n', '-nn', '-v', '-q', '-l'], val: ['-i', '-c', '-w', '-s'] });
  if (c.user !== 'root') return c.fail(`tcpdump: ${o['-i'] || 'eth0'}: You don't have permission to perform this capture on that device\n(socket: Operation not permitted)`, 1);
  const filter = o._.join(' ');
  const port = Number((filter.match(/port (\d+)/) || [])[1]) || null;
  const hostF = (filter.match(/host (\S+)/) || [])[1] || null;
  const count = Number(o['-c'] || 8);
  const h = c.host;
  c.eprint(`tcpdump: verbose output suppressed, use -v[v]... for full protocol decode`, `listening on ${o['-i'] || 'eth0'}, link-type EN10MB (Ethernet), snapshot length 262144 bytes`);
  const lines = [];
  const t0 = c.uni.time;
  const stamp = s => { const d = new Date((t0 + s) * 1000); return `${d.toISOString().slice(11, 19)}.${String(Math.round((s % 1) * 1e6)).padStart(6, '0')}`; };
  let sport = 44120;
  for (const p of h.procs.values()) {
    if (!p.connectsTo) continue;
    const ip = c.uni.resolveName(p.connectsTo.host, h) || p.connectsTo.host;
    if (port && p.connectsTo.port !== port) continue;
    if (hostF && hostF !== ip && hostF !== p.connectsTo.host) continue;
    const r = connect(c.uni, h, p.connectsTo.host, p.connectsTo.port);
    const pk = (s, from, to, flags, extra = '') => lines.push(`${stamp(s)} IP ${from} > ${to}: Flags [${flags}], ${extra}length 0`);
    const me = `${h.ip}.${sport}`, them = `${ip}.${p.connectsTo.port}`;
    if (r.error === 'ETIMEDOUT') { [0, 1.02, 3.06, 7.14].forEach((s, k) => pk(s, `${h.ip}.${sport + (k > 1 ? 1 : 0)}`, them, 'S', `seq ${2093117 + k}, win 64240, options [mss 1460,sackOK,TS val 10${k} ecr 0,nop,wscale 7], `)); }
    else if (r.error === 'ECONNREFUSED') { pk(0, me, them, 'S', 'seq 2093117, win 64240, '); pk(0.0004, them, me, 'R.', 'seq 0, ack 2093118, win 0, '); }
    else if (!r.error) { pk(0, me, them, 'S', 'seq 2093117, win 64240, '); pk(0.0005, them, me, 'S.', 'seq 991021, ack 2093118, win 65160, '); pk(0.0006, me, them, '.', 'ack 1, win 502, '); lines.push(`${stamp(0.0011)} IP ${me} > ${them}: Flags [P.], seq 1:45, ack 1, win 502, length 44`, `${stamp(0.0019)} IP ${them} > ${me}: Flags [P.], seq 1:212, ack 45, win 509, length 211`); }
    sport += 2;
  }
  if (!port || port === 22) lines.push(`${stamp(0.4)} IP ${h.ip}.22 > 10.0.0.5.51022: Flags [P.], seq 1:229, ack 1, win 501, length 228`);
  if (!lines.length) lines.push(C.dim('(no packets matched the filter during the capture)'));
  lines.sort();
  c.print(...lines.slice(0, count));
  c.eprint(`${Math.min(count, lines.length)} packets captured`, `${Math.min(count, lines.length)} packets received by filter`, '0 packets dropped by kernel');
  c.uni.advance(8);
  c.uni.emit({ type: 'tcpdump', host: h.name, filter, port });
  return 0;
}, { pkg: 'tcpdump' });

def('dmesg', c => {
  const h = c.host;
  if (c.user !== 'root' && !h.dmesgOpen) return c.fail('dmesg: read kernel buffer failed: Operation not permitted', 1);
  const human = c.args.some(a => a === '-T' || a === '-H' || a === '--ctime');
  const boot = h.bootTime ?? (c.uni.time - 86400 * 12);
  const lines = h.journal.filter(j => j.unit === 'kernel').map(j => human ? `[${new Date(j.time * 1000).toUTCString().replace(' GMT', '')}] ${j.msg}` : `[${String(((j.time - boot) / 1).toFixed(6)).padStart(12)}] ${j.msg}`);
  if (!lines.length) lines.push(human ? `[${new Date(boot * 1000).toUTCString().replace(' GMT', '')}] Linux version 6.8.0-1015-aws (buildd@lcy02-amd64-073) #16-Ubuntu SMP` : '[    0.000000] Linux version 6.8.0-1015-aws (buildd@lcy02-amd64-073) #16-Ubuntu SMP');
  c.print(...lines);
  c.uni.emit({ type: 'dmesg', host: h.name });
  return 0;
}, { always: true });

export { DISK_KBS };
