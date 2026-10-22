// A simulated AI assistant for the terminal: `ai "question"`, `ai explain "<command>"`,
// `ai fix` (looks at your last failed command). Labs script its answers through
// uni.ai.rules, including plausible-but-flawed suggestions, so learners practise the most
// important AI skill in operations: reading and verifying before running.

import { def } from './registry.js';
import { C } from '../git/world.js';

const FLAGS = {
  rm: { '-r': 'recursive: deletes directories and everything inside', '-R': 'recursive', '-f': 'force: never asks, ignores missing files', '-i': 'asks before each removal', '-v': 'prints each removal' },
  chmod: { '-R': 'recursive: changes every file below too', '777': 'everyone (owner, group, others) can read, write and execute', '755': 'owner rwx, everyone else r-x', '644': 'owner rw, everyone else read-only', '600': 'only the owner can read and write', '+x': 'adds execute permission' },
  chown: { '-R': 'recursive' },
  curl: { '-k': 'insecure: skips TLS certificate checks', '--insecure': 'skips TLS certificate checks', '-s': 'silent', '-S': 'still show errors when silent', '-f': 'fail (exit non-zero) on HTTP 4xx/5xx', '-L': 'follow redirects', '-I': 'headers only', '-i': 'include response headers', '-v': 'verbose: show the whole conversation', '-o': 'write the body to a file', '-X': 'set the HTTP method', '-d': 'send a request body (implies POST)', '-H': 'add a header' },
  tar: { '-c': 'create an archive', '-x': 'extract', '-z': 'gzip compression', '-f': 'archive file name follows', '-v': 'verbose', '-t': 'list contents', '-C': 'change to this directory first' },
  kill: { '-9': 'SIGKILL: forces the process to die instantly, no cleanup', '-15': 'SIGTERM: asks the process to stop cleanly (default)', '-HUP': 'SIGHUP: many daemons reload their config' },
  ssh: { '-i': 'use this private key file', '-p': 'connect to this port', '-v': 'verbose: shows why authentication fails', '-L': 'forward a local port through the connection', '-J': 'jump through a bastion host' },
  grep: { '-r': 'search directories recursively', '-i': 'ignore case', '-v': 'show lines that do NOT match', '-n': 'show line numbers', '-c': 'count matching lines', '-E': 'extended regular expressions', '-o': 'print only the matching part', '-l': 'list matching file names only' },
  find: { '-name': 'match file names (quote the pattern)', '-type': 'f = files, d = directories', '-mtime': 'modified N days ago (+N older, -N newer)', '-size': 'file size, e.g. +100M', '-delete': 'deletes everything it matches: run without it first', '-exec': 'runs a command for each match' },
  systemctl: { start: 'start the service now', stop: 'stop it now', restart: 'stop then start', reload: 'ask it to re-read config without stopping', enable: 'start it at boot', disable: 'do not start at boot', status: 'show state and recent logs', 'daemon-reload': 're-read unit files after you edit them', '--now': 'with enable/disable: also start/stop immediately' },
  apt: { install: 'install packages', remove: 'remove packages (keeps config)', purge: 'remove packages and their config', update: 'refresh the package lists', upgrade: 'upgrade installed packages', '-y': 'answer yes to prompts automatically' },
  docker: { run: 'create and start a container', '-d': 'detached: run in the background', '-p': 'publish a port host:container', '-v': 'mount a volume host:container', '-e': 'set an environment variable', '--rm': 'remove the container when it exits', '--privileged': 'gives the container almost full control of the host', 'system': 'housekeeping commands', 'prune': 'delete unused things', '-a': 'all (with prune: also images not used by running containers)', '--volumes': 'with prune: ALSO deletes unused volumes, i.e. data' },
  kubectl: { delete: 'deletes the resource', '-n': 'namespace', '--all': 'every resource of that kind', '--force': 'skip graceful deletion', '--grace-period=0': 'kill immediately', apply: 'create or update from a file', '-f': 'file', rollout: 'manage rollouts', undo: 'roll back to the previous revision', scale: 'change the replica count' },
  terraform: { apply: 'make the real infrastructure match the code', destroy: 'delete everything this configuration manages', '-auto-approve': 'skip the confirmation prompt', plan: 'show what would change, change nothing', '-target': 'only touch one resource (an escape hatch, not a habit)' },
  git: { push: 'send commits to the remote', '--force': 'overwrite the remote branch (can destroy others\' work)', '-f': 'force', reset: 'move the branch pointer', '--hard': 'also discards uncommitted changes', clean: 'deletes untracked files', '-fd': 'force, including directories' },
  ufw: { enable: 'turn the firewall on (make sure SSH is allowed first!)', allow: 'open a port', deny: 'block a port', status: 'show rules', default: 'set the default policy' },
  journalctl: { '-u': 'only this unit (service)', '-f': 'follow new lines', '-n': 'last N lines', '--since': 'time window', '-p': 'priority, e.g. err', '--vacuum-size=': 'delete old journal files until the journal is under this size', '--vacuum-time=': 'delete journal entries older than this' },
};

const RISKS = [
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r)\b[^|;&]*\s\/(\s|$|\*|var\/log\/\*)/, 'HIGH', 'recursive force-delete of a system path: there is no undo'],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+.*\*/, 'HIGH', 'recursive delete with a wildcard: check exactly what the * expands to first'],
  [/chmod\s+(-R\s+)?777/, 'HIGH', 'world-writable: any user or compromised process can modify these files'],
  [/curl[^|]*\|\s*(sudo\s+)?(ba)?sh/, 'HIGH', 'runs code from the internet without reading it'],
  [/\bdd\b.*of=\/dev\//, 'HIGH', 'writes raw bytes over a disk device'],
  [/mkfs/, 'HIGH', 'formats a filesystem: all data on it is lost'],
  [/kill\s+-9\s+1\b/, 'HIGH', 'kills init: the machine goes down'],
  [/--no-preserve-root/, 'HIGH', 'disables the safety net against deleting /'],
  [/(-k|--insecure)\b/, 'MEDIUM', 'turns off certificate checks: fine for a quick test, never in scripts'],
  [/kill\s+-9/, 'MEDIUM', 'no graceful shutdown: in-flight work is lost; try plain kill first'],
  [/push\s+.*(--force|-f)\b(?!-with-lease)/, 'HIGH', 'overwrites the remote branch; use --force-with-lease'],
  [/reset\s+--hard/, 'MEDIUM', 'discards uncommitted work'],
  [/terraform\s+(apply|destroy).*-auto-approve/, 'HIGH', 'changes real infrastructure without showing you the plan'],
  [/terraform\s+destroy/, 'HIGH', 'deletes managed infrastructure'],
  [/kubectl\s+delete\s+(ns|namespace)\b/, 'HIGH', 'deletes a namespace and everything in it'],
  [/kubectl\s+delete\b.*--all/, 'HIGH', 'deletes every resource of that kind'],
  [/docker\s+system\s+prune.*--volumes/, 'HIGH', 'deletes unused volumes, i.e. databases\' data'],
  [/ufw\s+enable/, 'MEDIUM', 'if SSH is not allowed first, you lock yourself out'],
  [/--privileged/, 'HIGH', 'container can take over the host'],
  [/0\.0\.0\.0\/0/, 'MEDIUM', 'open to the whole internet'],
  [/DROP\s+(TABLE|DATABASE)/i, 'HIGH', 'destroys data'],
  [/\bsudo\b/, 'LOW', 'runs with root privileges: double-check the rest of the line'],
];

export function riskOf(cmd) {
  const hits = RISKS.filter(([re]) => re.test(cmd)).map(([, level, why]) => ({ level, why }));
  const order = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  hits.sort((a, b) => order[b.level] - order[a.level]);
  return hits;
}

export function explainCommand(cmd) {
  const parts = cmd.trim().split(/\s*(\|\||&&|\||;)\s*/);
  const lines = [];
  for (const p of parts) {
    if (['|', '&&', '||', ';'].includes(p)) { lines.push(C.dim({ '|': '  | pipes the output into the next command', '&&': '  && runs the next command only if this one succeeded', '||': '  || runs the next command only if this one failed', ';': '  ; runs the next command regardless' }[p])); continue; }
    const words = p.split(/\s+/).filter(Boolean);
    let k = 0;
    if (words[0] === 'sudo') { lines.push(`  ${C.bold('sudo')}  run what follows as root`); k = 1; }
    const name = words[k];
    if (!name) continue;
    lines.push(`  ${C.bold(name)}  ${CMD_DESC[name] || '(a command; try `' + name + ' --help`)'}`);
    const table = FLAGS[name] || {};
    for (const w of words.slice(k + 1)) {
      const key = Object.keys(table).find(f => w === f || (f.endsWith('=') && w.startsWith(f)));
      if (key) lines.push(`    ${C.cyan(w)}  ${table[key]}`);
      else if (/^-[a-zA-Z]{2,}$/.test(w) && table) {
        const each = w.slice(1).split('').map(ch => table['-' + ch] ? `-${ch}: ${table['-' + ch]}` : null).filter(Boolean);
        if (each.length) lines.push(`    ${C.cyan(w)}  ${each.join('; ')}`);
        else lines.push(`    ${C.cyan(w)}  flags`);
      } else if (/[*?]/.test(w)) lines.push(`    ${C.yellow(w)}  a wildcard: the shell expands it to matching names BEFORE ${name} runs`);
      else lines.push(`    ${w}  ${w.startsWith('-') ? 'an option' : 'an argument'}`);
    }
  }
  return lines;
}

const CMD_DESC = {
  rm: 'removes files and directories (permanently)', chmod: 'changes permission bits', chown: 'changes owner and group', curl: 'transfers data from or to a URL', tar: 'packs or unpacks archives', kill: 'sends a signal to a process', ssh: 'opens a remote shell', grep: 'searches text', find: 'finds files', systemctl: 'controls systemd services', apt: 'installs and manages packages', docker: 'manages containers and images', kubectl: 'talks to a Kubernetes cluster', terraform: 'plans and applies infrastructure changes', git: 'version control', ufw: 'manages the firewall', journalctl: 'reads the systemd journal (logs)', ls: 'lists files', cat: 'prints files', du: 'measures disk usage', df: 'shows free disk space per filesystem', sort: 'sorts lines', uniq: 'collapses adjacent duplicate lines', awk: 'processes columns of text', sed: 'edits text streams', head: 'shows the first lines', tail: 'shows the last lines', ps: 'lists processes', mkdir: 'creates directories', mv: 'moves or renames', cp: 'copies', echo: 'prints its arguments', tee: 'writes input to a file and to the screen', xargs: 'turns input into command arguments', dd: 'copies raw bytes between files and devices', mkfs: 'creates a filesystem (erases the device)', nginx: 'the web server (-t tests config)', certbot: 'gets TLS certificates', helm: 'Kubernetes package manager',
};

function box(c, lines, { title = 'assistant (simulated AI, may be wrong)' } = {}) {
  c.print(C.magenta(`╭─ ${title}`));
  for (const l of lines) c.print(C.magenta('│ ') + l);
  c.print(C.magenta('╰─') + C.dim(' check before you run: ai explain "<command>"'));
}

def(['ai', 'copilot', 'assistant'], c => {
  const args = c.args;
  const uni = c.uni;
  if (!args.length || args[0] === 'help' || args[0] === '--help') {
    c.print('usage:', '  ai "how do I …?"          ask for help (the answer may be wrong: verify it)', '  ai explain "<command>"     break a command down and rate its risk', '  ai fix                     suggest a fix for your last failed command');
    return 0;
  }
  if (args[0] === 'explain') {
    const cmd = args.slice(1).join(' ').replace(/^["']|["']$/g, '');
    if (!cmd) return c.fail('ai explain: give me a command, e.g. ai explain "rm -rf /tmp/build"', 1);
    const risks = riskOf(cmd);
    const lines = [`${C.bold('Command:')} ${cmd}`, ...explainCommand(cmd), ''];
    if (risks.length) for (const r of risks) lines.push(`${r.level === 'HIGH' ? C.red('RISK HIGH') : r.level === 'MEDIUM' ? C.yellow('RISK MEDIUM') : C.dim('risk low')}: ${r.why}`);
    else lines.push(C.green('No obvious danger signs. Still: run it somewhere safe first if unsure.'));
    box(c, lines, { title: 'assistant · explain' });
    uni.emit({ type: 'ai-explain', host: c.host.name, cmd, risk: risks[0]?.level || 'NONE' });
    return 0;
  }
  if (args[0] === 'fix') {
    const last = c.sh.lastFailure;
    if (!last) { box(c, ['Your last command succeeded, so there is nothing to fix.']); return 0; }
    const rule = (uni.ai?.rules || []).find(r => r.fix && r.when.test(last.line + '\n' + last.out));
    const lines = rule ? rule.reply : genericFix(last);
    box(c, lines);
    uni.emit({ type: 'ai-fix', host: c.host.name, line: last.line, suggestions: rule?.suggest || [] });
    return 0;
  }
  const q = args.join(' ').replace(/^["']|["']$/g, '');
  const rule = (uni.ai?.rules || []).find(r => !r.fix && r.when.test(q));
  const lines = rule ? rule.reply : genericAnswer(q);
  box(c, lines);
  uni.emit({ type: 'ai-ask', host: c.host.name, q, rule: rule?.id || null, suggestions: rule?.suggest || [] });
  return 0;
}, { always: true });

function genericFix(last) {
  const out = last.out;
  if (/command not found/.test(out)) return [`"${last.line.split(' ')[0]}" is not installed or not on your PATH.`, 'Check with: which <command>, then install it with apt if needed.'];
  if (/Permission denied/.test(out)) return ['You lack permission. Check ownership and mode with ls -l.', 'If it is a system file you are meant to change, use sudo. Do not chmod 777 it.'];
  if (/Connection refused/.test(out)) return ['Nothing is listening on that port (or only on 127.0.0.1).', 'On the server: ss -tlnp and systemctl status <service>.'];
  if (/timed out|Timeout/i.test(out)) return ['Packets are being dropped: usually a firewall or security group.', 'Check: sudo ufw status, and the cloud firewall rules.'];
  if (/Could not resolve/.test(out)) return ['The name does not resolve. Check: dig +short <name> and /etc/hosts.'];
  return ['I am not sure what went wrong. Read the error message line by line, then look at the logs:', '  journalctl -xe   or   journalctl -u <service> -n 50'];
}

function genericAnswer(q) {
  const t = q.toLowerCase();
  if (/disk|space|full/.test(t)) return ['Find what uses space first:', '  df -h', '  sudo du -sh /var/log/* | sort -h', 'Then clean the right thing (old logs, journal, old releases).'];
  if (/port|listen/.test(t)) return ['See which process listens where:', '  sudo ss -tlnp'];
  if (/log/.test(t)) return ['Service logs: journalctl -u <service> -n 50', 'Files: /var/log/ (e.g. /var/log/nginx/error.log)'];
  if (/memory|ram|oom/.test(t)) return ['Check: free -h, then ps aux --sort=-%mem | head', 'And look for the OOM killer: journalctl -k | grep -i oom'];
  if (/restart|service/.test(t)) return ['sudo systemctl restart <service>, then systemctl status <service>'];
  return ['I can help with commands and debugging. Tell me what you are trying to do, what you ran, and the exact error.', 'Good prompts include context: which machine, which service, what changed recently.'];
}
