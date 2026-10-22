// Named illustrations used by lessons (```diagram fences). All colours come from theme tokens.

import { svg, h } from './dom.js';

const T = { text: 'var(--text)', muted: 'var(--muted)', line: 'var(--line-strong)', surface: 'var(--surface)', s2: 'var(--surface-2)', main: 'var(--main)', feat: 'var(--feat)', remote: 'var(--remote)', info: 'var(--info)', accent: 'var(--accent)', ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)' };

function defs(id) {
  return svg('defs', {}, ...['text', 'main', 'feat', 'remote', 'info', 'accent', 'muted', 'ok', 'bad'].map(k =>
    svg('marker', { id: `${id}-${k}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      svg('path', { d: 'M0 0 L10 5 L0 10 z', fill: T[k] }))));
}

function mk(width, height, label) {
  const id = 'd' + Math.random().toString(36).slice(2, 7);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, role: 'img', 'aria-label': label, style: 'width:100%;height:auto' });
  root.append(defs(id));
  const api = {
    root, id,
    box(x, y, w, hgt, title, { sub = null, color = 'line', fill = 'surface', r = 10, dash = null, titleSize = 15, subSize = 12.5, align = 'middle' } = {}) {
      root.append(svg('rect', { x, y, width: w, height: hgt, rx: r, fill: T[fill] || fill, stroke: T[color] || color, 'stroke-width': 1.6, 'stroke-dasharray': dash }));
      const tx = align === 'start' ? x + 14 : x + w / 2;
      if (title) root.append(svg('text', { x: tx, y: sub ? y + hgt / 2 - 4 : y + hgt / 2 + 5, 'text-anchor': align, fill: T.text, 'font-family': 'var(--font-display)', 'font-weight': 700, 'font-size': titleSize, text: title }));
      if (sub) {
        const lines = sub.split('\n');
        lines.forEach((l, i) => root.append(svg('text', { x: tx, y: y + hgt / 2 + 14 + i * 15, 'text-anchor': align, fill: T.muted, 'font-family': 'var(--font-body)', 'font-size': subSize, text: l })));
      }
    },
    text(x, y, s, { size = 13, color = 'text', anchor = 'middle', weight = 400, font = 'body', italic = false } = {}) {
      root.append(svg('text', { x, y, 'text-anchor': anchor, fill: T[color] || color, 'font-size': size, 'font-weight': weight, 'font-family': font === 'mono' ? 'var(--font-mono)' : font === 'display' ? 'var(--font-display)' : 'var(--font-body)', 'font-style': italic ? 'italic' : null, text: s }));
    },
    arrow(x1, y1, x2, y2, { color = 'text', label = null, dy = -8, curve = 0, dash = null, width = 2, size = 12.5, labelColor = null, lx = null, ly = null } = {}) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const d = curve ? `M${x1} ${y1} Q${mx} ${my + curve} ${x2} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`;
      root.append(svg('path', { d, fill: 'none', stroke: T[color], 'stroke-width': width, 'marker-end': `url(#${id}-${color})`, 'stroke-dasharray': dash }));
      if (label) root.append(svg('text', { x: lx ?? mx, y: ly ?? (my + (curve ? curve / 2 : 0) + dy), 'text-anchor': 'middle', fill: T[labelColor || color], 'font-family': 'var(--font-mono)', 'font-size': size, 'font-weight': 600, text: label }));
    },
    line(x1, y1, x2, y2, { color = 'line', width = 2, dash = null } = {}) {
      root.append(svg('path', { d: `M${x1} ${y1} L${x2} ${y2}`, stroke: T[color] || color, 'stroke-width': width, fill: 'none', 'stroke-dasharray': dash }));
    },
    path(d, { color = 'line', width = 2.4, dash = null, fill = 'none' } = {}) {
      root.append(svg('path', { d, stroke: T[color] || color, 'stroke-width': width, fill, 'stroke-dasharray': dash }));
    },
    commit(x, y, { color = 'main', label = null, r = 9, hollow = false, below = false, size = 12 } = {}) {
      root.append(svg('circle', { cx: x, cy: y, r, fill: hollow ? T.surface : T[color], stroke: T[color], 'stroke-width': 2.5 }));
      if (label) root.append(svg('text', { x, y: below ? y + r + 16 : y - r - 8, 'text-anchor': 'middle', fill: T.muted, 'font-family': 'var(--font-mono)', 'font-size': size, text: label }));
    },
    tag(x, y, s, { color = 'main', solid = false, anchor = 'start' } = {}) {
      const w = s.length * 7.4 + 16;
      const x0 = anchor === 'middle' ? x - w / 2 : x;
      root.append(svg('rect', { x: x0, y: y - 11, width: w, height: 22, rx: 11, fill: solid ? T[color] : T.surface, stroke: T[color], 'stroke-width': 1.5 }));
      root.append(svg('text', { x: x0 + w / 2, y: y + 4.5, 'text-anchor': 'middle', fill: solid ? T.surface : T[color], 'font-family': 'var(--font-mono)', 'font-size': 12, 'font-weight': 600, text: s }));
      return w;
    },
  };
  return api;
}

function figure(d, caption) {
  return h('figure', { class: 'figure', style: { margin: 0 } }, d.root, caption ? h('figcaption', {}, caption) : null);
}

const D = {};
export { D, mk, figure, T };

// ---------- Realm 0: Base Camp ----------
D['devops-loop'] = () => {
  const d = mk(720, 300, 'The DevOps infinity loop: plan, code, build, test on the Dev side; release, deploy, operate, monitor on the Ops side');
  const cx = 360, cy = 150, a = 250;
  const pts = [];
  for (let k = 0; k <= 200; k++) { const t = k / 200 * Math.PI * 2; const den = 1 + Math.sin(t) ** 2; pts.push([cx + a * Math.cos(t) / den, cy + a * Math.sin(t) * Math.cos(t) / den * 1.35]); }
  d.path('M' + pts.map(p => p.map(v => v.toFixed(1)).join(' ')).join(' L'), { color: 'accent', width: 5 });
  const phases = [['PLAN', 0.62], ['CODE', 0.7], ['BUILD', 0.8], ['TEST', 0.9], ['RELEASE', 0.12], ['DEPLOY', 0.2], ['OPERATE', 0.3], ['MONITOR', 0.4]];
  for (const [name, u] of phases) {
    const t = u * Math.PI * 2; const den = 1 + Math.sin(t) ** 2;
    const x = cx + a * Math.cos(t) / den, y = cy + a * Math.sin(t) * Math.cos(t) / den * 1.35;
    d.box(x - 46, y - 15, 92, 30, name, { r: 15, fill: 'surface', color: u > 0.5 ? 'main' : 'feat', titleSize: 12.5 });
  }
  d.text(130, 285, 'Dev: build the right thing well', { color: 'main', weight: 700, size: 13 });
  d.text(590, 285, 'Ops: run it reliably', { color: 'feat', weight: 700, size: 13 });
  d.box(cx - 38, cy - 16, 76, 32, 'AI', { r: 16, color: 'remote', fill: 's2', titleSize: 13 });
  return figure(d, 'One loop, one team. Every phase feeds the next, and what you learn in production feeds the next plan. AI now assists in every phase, but people stay accountable for each one.');
};

D['wall-of-confusion'] = () => {
  const d = mk(720, 230, 'Before: developers throw releases over a wall to operations. After: one team owns the whole loop');
  d.text(190, 26, 'Before: the wall of confusion', { weight: 700, font: 'display', size: 15 });
  d.box(20, 66, 120, 60, 'Dev', { sub: 'wants change', color: 'main' });
  d.box(240, 66, 120, 60, 'Ops', { sub: 'wants stability', color: 'feat' });
  d.line(190, 62, 190, 130, { color: 'bad', width: 5 });
  d.arrow(142, 82, 236, 82, { color: 'text', label: 'release.zip', lx: 190, ly: 52, size: 11 });
  d.arrow(236, 110, 142, 110, { color: 'bad', label: '"it broke"', lx: 190, ly: 150, size: 11 });
  d.text(190, 182, 'Slow handoffs, blame, big risky releases.', { size: 12.5, color: 'muted' });
  d.text(540, 26, 'After: one team, shared goals', { weight: 700, font: 'display', size: 15 });
  d.box(420, 55, 240, 80, 'Product team', { sub: 'builds it · ships it · runs it\nautomation in between', color: 'accent' });
  d.text(540, 175, 'Small changes, fast feedback, shared on-call.', { size: 12.5, color: 'muted' });
  return figure(d, '"You build it, you run it": when the people who write the code also feel the 3 a.m. pager, they build software that is easier to run.');
};

D['ai-verify'] = () => {
  const d = mk(720, 210, 'Working with an AI assistant: ask, read and question the answer, test it safely, then act and observe');
  const steps = [['Ask', 'with context and\nconstraints', 'remote'], ['Read', 'every line; what does\neach flag do?', 'info'], ['Test safely', 'dry run, staging,\n--help, a copy', 'main'], ['Act', 'small step,\none change', 'accent'], ['Observe', 'logs, metrics,\nis it fixed?', 'feat']];
  steps.forEach(([t, sub, c], k) => { d.box(20 + k * 140, 60, 120, 84, t, { sub, color: c }); if (k) d.arrow(20 + k * 140 - 18, 102, 20 + k * 140 - 2, 102, { color: 'text' }); });
  d.text(360, 30, 'Trust, but verify: the AI drafts, you decide', { weight: 700, font: 'display', size: 15 });
  d.text(360, 185, 'Never paste a command you cannot explain into a production shell.', { size: 12.5, color: 'bad' });
  return figure(d, 'AI assistants are fast and often right, and sometimes confidently wrong: an invented flag, a deprecated API, a command that deletes more than you meant. Your job is the judgment in the middle.');
};

// ---------- Realm 1: Linux ----------
D['fs-tree'] = () => {
  const d = mk(720, 270, 'The Linux filesystem tree and what lives where');
  d.box(320, 14, 80, 32, '/', { r: 8, color: 'accent', titleSize: 16 });
  const kids = [['/etc', 'configuration'], ['/home', 'users\' files'], ['/var', 'logs, data\n(/var/log)'], ['/opt', 'add-on apps'], ['/usr/bin', 'programs'], ['/tmp', 'scratch,\ncleared on boot'], ['/root', 'root\'s home']];
  kids.forEach(([n, sub], k) => { const x = 10 + k * 101; d.box(x, 110, 94, 74, n, { sub, color: 'main', titleSize: 13, subSize: 11 }); d.path(`M360 46 C 360 80, ${x + 47} 80, ${x + 47} 110`, { color: 'line', width: 1.6 }); });
  d.text(360, 220, 'Everything is a file under one root, even devices (/dev) and processes (/proc).', { size: 12.5, color: 'muted' });
  d.text(360, 245, 'Absolute paths start at / ; relative paths start where you are (pwd).', { size: 12.5, color: 'muted' });
  return figure(d, 'Knowing the map pays off when something breaks: config in /etc, logs in /var/log, apps often in /opt or /srv, your stuff in /home.');
};

D['permissions'] = () => {
  const d = mk(720, 250, 'Reading a permission string: file type, then owner, group and others, each with read write execute');
  d.text(360, 28, '-rwxr-x---  1  deploy  www-data  2048  app.sh', { font: 'mono', size: 17, weight: 600 });
  const groups = [['-', 92, 'type', 'muted'], ['rwx', 128, 'owner (deploy)', 'main'], ['r-x', 175, 'group (www-data)', 'info'], ['---', 222, 'others', 'feat']];
  groups.forEach(([s, x, label, c], k) => { d.arrow(x, 40, 60 + k * 170, 92, { color: c }); d.box(10 + k * 170, 95, 150, 56, label, { sub: s === '-' ? 'file (d = directory)' : s.split('').map((ch, i) => ch === '-' ? 'no ' + 'rwx'[i] : ch).join(' '), color: c, titleSize: 13 }); });
  d.text(360, 182, 'r = 4   w = 2   x = 1      rwx = 7   r-x = 5   --- = 0      →  chmod 750 app.sh', { font: 'mono', size: 13.5, color: 'accent' });
  d.text(360, 214, 'On a directory: r = list names, w = create/delete inside, x = enter it (cd) and reach files.', { size: 12.5, color: 'muted' });
  return figure(d, 'Linux checks permissions in one order: are you the owner? then the group? then everyone else. The first match wins. root skips the check.');
};

D['pipes'] = () => {
  const d = mk(720, 210, 'A pipeline: each command reads stdin and writes stdout into the next; stderr goes to the terminal');
  const cmds = ['cat access.log', 'grep " 500 "', 'awk \'{print $1}\'', 'sort | uniq -c'];
  cmds.forEach((c, k) => { d.box(14 + k * 178, 70, 156, 48, c, { color: 'main', titleSize: 12.5 }); if (k) d.arrow(14 + k * 178 - 20, 94, 14 + k * 178 - 2, 94, { color: 'accent', label: '|', dy: -8 }); });
  d.text(360, 40, 'stdout of one becomes stdin of the next', { size: 13, color: 'accent', weight: 700 });
  d.arrow(92, 120, 92, 168, { color: 'bad', label: 'stderr → screen', ly: 186, dy: 0, size: 11 });
  d.text(600, 175, '> file   >> append   2> errors   2>&1 both', { font: 'mono', size: 12, color: 'muted' });
  return figure(d, 'Small tools, each doing one job, joined with pipes: this is how you turn a 2 GB log into "which IPs caused the 500 errors" in one line.');
};

D['signals'] = () => {
  const d = mk(720, 220, 'Process signals: SIGTERM asks politely, SIGKILL forces, SIGHUP often reloads configuration');
  d.box(260, 70, 200, 76, 'process  (pid 4312)', { sub: 'node server.js', color: 'main' });
  d.arrow(40, 60, 256, 86, { color: 'ok', label: 'kill PID  (SIGTERM 15)', lx: 120, ly: 50 });
  d.arrow(40, 110, 256, 108, { color: 'bad', label: 'kill -9 PID  (SIGKILL)', lx: 130, ly: 124 });
  d.arrow(40, 160, 256, 130, { color: 'info', label: 'kill -HUP PID  (reload)', lx: 130, ly: 176 });
  d.text(590, 76, 'TERM: finish requests, close files, exit', { size: 12.5, color: 'ok' });
  d.text(590, 106, 'KILL: gone instantly, no cleanup', { size: 12.5, color: 'bad' });
  d.text(590, 136, 'HUP: many daemons re-read config', { size: 12.5, color: 'info' });
  return figure(d, 'Always try SIGTERM first. kill -9 cannot be caught, so the program cannot save state or finish in-flight requests.');
};

// ---------- Realm 2: Networking ----------
D['request-path'] = () => {
  const d = mk(720, 230, 'The path of one web request: DNS, firewall, nginx, app, database');
  const hops = [['browser', 'you'], ['DNS', 'name → IP'], ['firewall', 'port 443 open?'], ['nginx :443', 'TLS, proxy'], ['app :3000', 'your code'], ['db :5432', 'data']];
  hops.forEach(([t, sub], k) => { d.box(8 + k * 119, 80, 104, 62, t, { sub, color: k === 0 ? 'accent' : k === 5 ? 'remote' : 'main', titleSize: 13 }); if (k) d.arrow(8 + k * 119 - 13, 111, 8 + k * 119 - 1, 111, { color: 'text' }); });
  d.text(360, 40, 'Every arrow is a place where it can break', { weight: 700, font: 'display', size: 15 });
  d.text(60, 175, 'could not resolve', { size: 11.5, color: 'bad' });
  d.text(180, 175, 'timed out', { size: 11.5, color: 'warn' });
  d.text(298, 175, 'refused / cert error', { size: 11.5, color: 'bad' });
  d.text(417, 175, '502 Bad Gateway', { size: 11.5, color: 'bad' });
  d.text(536, 175, '500 / crash', { size: 11.5, color: 'bad' });
  d.text(655, 175, 'connection errors', { size: 11.5, color: 'bad' });
  d.text(360, 210, 'The error message tells you which hop failed: learn to read it.', { size: 12.5, color: 'muted' });
  return figure(d, 'Debug from the outside in: does the name resolve, can you reach the port, is the process listening, what do its logs say?');
};

D['bind-address'] = () => {
  const d = mk(720, 210, 'Listening on 127.0.0.1 is reachable only from the same machine; 0.0.0.0 accepts connections from the network');
  d.box(250, 30, 440, 150, null, { color: 'line', dash: '5 4' });
  d.text(470, 52, 'server web1 (10.0.0.11)', { weight: 700, size: 13 });
  d.box(280, 70, 180, 46, 'app on 127.0.0.1:3000', { color: 'muted', titleSize: 12 });
  d.box(480, 70, 190, 46, 'app on 0.0.0.0:8080', { color: 'ok', titleSize: 12 });
  d.box(380, 128, 140, 40, 'curl on web1', { color: 'info', titleSize: 12 });
  d.arrow(420, 128, 380, 118, { color: 'ok' });
  d.arrow(480, 128, 540, 118, { color: 'ok' });
  d.box(20, 80, 150, 50, 'your laptop', { color: 'accent', titleSize: 13 });
  d.arrow(172, 96, 276, 96, { color: 'bad', label: 'refused', dy: -8, size: 11 });
  d.arrow(172, 112, 476, 108, { color: 'ok', label: 'ok', ly: 136, dy: 0, size: 11, curve: 40 });
  return figure(d, 'Databases and admin interfaces often listen on 127.0.0.1 on purpose. A web app that must be reachable listens on 0.0.0.0 (or sits behind nginx).');
};

D['ssh-keys'] = () => {
  const d = mk(720, 220, 'SSH key authentication: the private key stays on your laptop, the public key goes into authorized_keys on the server');
  d.box(30, 50, 250, 130, 'your laptop', { color: 'accent' });
  d.box(60, 110, 190, 30, '~/.ssh/id_ed25519', { r: 6, color: 'bad', titleSize: 12 });
  d.box(60, 146, 190, 26, '~/.ssh/id_ed25519.pub', { r: 6, color: 'ok', titleSize: 12 });
  d.text(155, 100, 'private: never share (chmod 600)', { size: 11.5, color: 'bad' });
  d.box(440, 50, 250, 130, 'server', { color: 'main' });
  d.box(460, 120, 210, 30, '~/.ssh/authorized_keys', { r: 6, color: 'ok', titleSize: 12 });
  d.arrow(252, 158, 456, 136, { color: 'ok', label: 'copy the .pub once', dy: -8, size: 11 });
  d.text(360, 205, 'At login the server sends a challenge only the matching private key can sign.', { size: 12.5, color: 'muted' });
  return figure(d, 'Keys beat passwords: nothing secret crosses the network, and you can revoke one key without touching anyone else\'s.');
};

D['tls'] = () => {
  const d = mk(720, 220, 'TLS: the server proves its identity with a certificate signed by a trusted authority, then traffic is encrypted');
  d.box(20, 60, 140, 90, 'client', { sub: 'trusts a list\nof authorities', color: 'accent' });
  d.box(560, 60, 140, 90, 'server', { sub: 'has a certificate\n+ private key', color: 'main' });
  d.arrow(162, 76, 556, 76, { color: 'text', label: '1. hello, I want shop.example.com', dy: -8, size: 11 });
  d.arrow(556, 104, 162, 104, { color: 'info', label: '2. certificate: CN shop.example.com, signed by R11, valid until …', dy: -8, size: 11 });
  d.arrow(162, 134, 556, 134, { color: 'ok', label: '3. checks pass → encrypted session', dy: -8, size: 11 });
  d.text(360, 185, 'Checks: trusted issuer? not expired? name matches? Fail any → "SSL certificate problem".', { size: 12.5, color: 'muted' });
  return figure(d, "Most HTTPS outages are expired certificates. Automate renewal (certbot does) and monitor expiry dates.");
};

// ---------- Realm 3: Services ----------
D['systemd'] = () => {
  const d = mk(720, 230, 'systemd: a unit file describes a service; systemctl controls it; the journal keeps its logs; Restart= brings it back');
  d.box(20, 50, 200, 120, 'shop.service', { sub: '[Service]\nUser=shop\nExecStart=/usr/bin/node …\nRestart=always', color: 'info', align: 'start', subSize: 11.5 });
  d.box(280, 60, 160, 50, 'systemd (PID 1)', { color: 'accent', titleSize: 13 });
  d.box(500, 50, 200, 60, 'node server.js', { sub: 'running as shop', color: 'main', titleSize: 13 });
  d.box(500, 140, 200, 50, 'journal', { sub: 'journalctl -u shop', color: 'remote', titleSize: 13 });
  d.arrow(222, 86, 276, 86, { color: 'text', label: 'reads', dy: -8, size: 11 });
  d.arrow(442, 80, 496, 80, { color: 'ok', label: 'starts', dy: -8, size: 11 });
  d.arrow(600, 112, 600, 136, { color: 'remote' });
  d.path('M600 50 C 600 10, 360 10, 360 58', { color: 'warn', width: 1.8, dash: '5 4' });
  d.text(480, 22, 'crashed? Restart= starts it again', { size: 11.5, color: 'warn' });
  d.box(280, 140, 160, 46, 'systemctl', { sub: 'start · enable · status', color: 'text', titleSize: 13 });
  d.arrow(360, 138, 360, 112, { color: 'text' });
  return figure(d, 'A service is not "a program you started once in a terminal": it is declared, survives logouts and reboots, restarts on failure and logs to one place.');
};

D['reverse-proxy'] = () => {
  const d = mk(720, 220, 'nginx as a reverse proxy: one public entry point routes requests to apps listening privately');
  d.box(20, 80, 120, 56, 'clients', { color: 'accent' });
  d.box(220, 60, 170, 96, 'nginx :80 / :443', { sub: 'TLS · routing\nstatic files · limits', color: 'main' });
  d.box(480, 30, 210, 46, 'shop app 127.0.0.1:3000', { color: 'info', titleSize: 12 });
  d.box(480, 90, 210, 46, 'api 127.0.0.1:4000', { color: 'info', titleSize: 12 });
  d.box(480, 150, 210, 46, '/var/www/html (static)', { color: 'muted', titleSize: 12 });
  d.arrow(142, 108, 216, 108, { color: 'text' });
  d.arrow(392, 90, 476, 54, { color: 'text', label: 'location /', dy: -6, size: 11 });
  d.arrow(392, 108, 476, 112, { color: 'text', label: '/api/', dy: -6, size: 11 });
  d.arrow(392, 126, 476, 170, { color: 'text', label: '/static/', dy: 14, size: 11 });
  return figure(d, 'Apps stay on localhost; only nginx faces the internet. If an app is down, nginx answers 502 Bad Gateway: the proxy is fine, the thing behind it is not.');
};

D['releases-symlink'] = () => {
  const d = mk(720, 230, 'Atomic deploys with releases folders and a current symlink that is switched in one step');
  d.text(150, 28, '/opt/shop/', { font: 'mono', size: 14, weight: 700 });
  d.box(40, 50, 220, 40, 'releases/2026-01-10/  (v1.4)', { color: 'muted', titleSize: 12 });
  d.box(40, 100, 220, 40, 'releases/2026-01-14/  (v1.5)', { color: 'main', titleSize: 12 });
  d.box(40, 150, 220, 40, 'shared/  (.env, uploads)', { color: 'info', titleSize: 12 });
  d.box(420, 90, 160, 50, 'current →', { color: 'accent', titleSize: 15 });
  d.arrow(418, 115, 264, 120, { color: 'accent', label: 'ln -sfn releases/… current', dy: -10, size: 11 });
  d.arrow(418, 104, 264, 72, { color: 'line', dash: '5 4' });
  d.text(500, 180, 'the service runs from /opt/shop/current', { size: 12, color: 'muted' });
  d.text(500, 200, 'rollback = point current back, restart', { size: 12, color: 'ok' });
  return figure(d, 'Upload the new release next to the old one, then switch one symlink. There is never a half-copied app, and rolling back takes a second.');
};

// ---------- Realm 4: Scripting ----------
D['script-anatomy'] = () => {
  const d = mk(720, 260, 'Anatomy of a robust bash script');
  const lines = [['#!/usr/bin/env bash', 'which interpreter runs it', 'muted'], ['set -euo pipefail', 'stop on errors, unset vars, failed pipes', 'bad'], ['APP="${1:?usage: deploy.sh <app>}"', 'arguments with checks', 'info'], ['log() { echo "[$(date +%T)] $*"; }', 'small functions', 'main'], ['trap \'log "failed on line $LINENO"\' ERR', 'say where it broke', 'warn'], ['if systemctl is-active --quiet "$APP"; then …', 'decide with exit codes', 'accent'], ['exit 0', '0 = success for whoever calls you', 'ok']];
  lines.forEach(([code, note, c], k) => { d.text(24, 34 + k * 32, code, { anchor: 'start', font: 'mono', size: 13 }); d.text(470, 34 + k * 32, '← ' + note, { anchor: 'start', size: 12.5, color: c }); });
  return figure(d, 'A script is a program. Treat it like one: fail loudly, check inputs, log what you do, and make it safe to run twice.');
};

// ---------- Realm 5: CI/CD ----------
D['pipeline'] = () => {
  const d = mk(720, 250, 'A CI/CD pipeline: every push is tested and built once; the same artifact goes to staging, then to production after approval');
  const stages = [['push / PR', 'git', 'accent'], ['lint + test', 'CI', 'info'], ['build', 'artifact v1.4.2', 'main'], ['staging', 'auto deploy\n+ smoke test', 'feat'], ['production', 'tag + approval', 'ok']];
  stages.forEach(([t, sub, c], k) => { d.box(10 + k * 142, 70, 124, 70, t, { sub, color: c, titleSize: 13.5 }); if (k) d.arrow(10 + k * 142 - 16, 105, 10 + k * 142 - 2, 105, { color: 'text' }); });
  d.text(360, 34, 'CI: integrate and verify every change', { weight: 700, font: 'display', size: 14, color: 'info' });
  d.line(146, 46, 430, 46, { color: 'info', width: 2 });
  d.text(570, 34, 'CD: deliver the same artifact', { weight: 700, font: 'display', size: 14, color: 'ok' });
  d.line(436, 46, 704, 46, { color: 'ok', width: 2 });
  d.text(360, 180, 'Fail fast: a red stage stops everything after it.', { size: 12.5, color: 'muted' });
  d.text(360, 202, 'Build once: staging and production get the exact bytes that passed the tests.', { size: 12.5, color: 'muted' });
  return figure(d, 'Each stage is a gate. The further right a change gets, the more confident you are, and the cheaper it is to ship small changes often.');
};

D['blue-green'] = () => {
  const d = mk(720, 230, 'Blue-green deployment: two complete environments, a router switches all traffic from blue to green and back');
  d.box(20, 80, 130, 60, 'users', { color: 'accent' });
  d.box(220, 80, 140, 60, 'router', { sub: 'nginx / LB', color: 'text' });
  d.box(450, 30, 230, 64, 'blue  v1.4 (live)', { sub: 'keeps running, ready for rollback', color: 'info' });
  d.box(450, 130, 230, 64, 'green v1.5 (new)', { sub: 'deployed and tested first', color: 'ok' });
  d.arrow(152, 110, 216, 110, { color: 'text' });
  d.arrow(362, 100, 446, 62, { color: 'info', dash: '5 4', label: 'before', dy: -6, size: 11 });
  d.arrow(362, 120, 446, 162, { color: 'ok', label: 'after the switch', dy: 18, size: 11 });
  d.text(360, 220, 'Switch = one config change. Rollback = switch back. Canary = send 5% to green first.', { size: 12.5, color: 'muted' });
  return figure(d, 'The new version is fully running before anyone sees it, and the old one stays warm until you are sure.');
};


// ---------- Realm 6: Containers ----------
D['vm-vs-container'] = () => {
  const d = mk(720, 270, 'Virtual machines each carry a whole operating system; containers share the host kernel and carry only the app and its files');
  d.text(170, 24, 'Virtual machines', { weight: 700, font: 'display', size: 14 });
  d.text(540, 24, 'Containers', { weight: 700, font: 'display', size: 14 });
  [0, 1, 2].forEach(k => { d.box(20 + k * 102, 40, 94, 40, `app ${'ABC'[k]}`, { color: 'main', titleSize: 13 }); d.box(20 + k * 102, 84, 94, 40, 'guest OS', { sub: '~1 GB', color: 'muted', titleSize: 12, subSize: 11 }); });
  d.box(20, 130, 298, 38, 'hypervisor', { color: 'info', titleSize: 13 });
  d.box(20, 174, 298, 38, 'host OS + kernel', { color: 'text', titleSize: 13 });
  d.box(20, 218, 298, 38, 'hardware', { color: 'muted', titleSize: 13 });
  [0, 1, 2].forEach(k => { d.box(390 + k * 104, 40, 96, 40, `app ${'ABC'[k]}`, { color: 'main', titleSize: 13 }); d.box(390 + k * 104, 84, 96, 40, 'libs + files', { sub: '5–200 MB', color: 'feat', titleSize: 12, subSize: 11 }); });
  d.box(390, 130, 304, 38, 'container runtime (Docker)', { color: 'info', titleSize: 13 });
  d.box(390, 174, 304, 38, 'host OS + ONE shared kernel', { color: 'text', titleSize: 13 });
  d.box(390, 218, 304, 38, 'hardware', { color: 'muted', titleSize: 13 });
  return figure(d, 'A container is not a small VM: it is an ordinary process the kernel fences off with namespaces (what it can see) and cgroups (what it can use). That is why it starts in milliseconds.');
};

D['image-layers'] = () => {
  const d = mk(720, 270, 'A Dockerfile builds an image as a stack of read-only layers; a container adds one thin writable layer on top');
  const rows = [['FROM node:20-slim', 'base layers · 196 MB', 'muted'], ['WORKDIR /app', '0 B', 'muted'], ['COPY package*.json ./', '2 kB', 'info'], ['RUN npm ci --omit=dev', 'dependencies · 38 MB', 'info'], ['COPY . .', 'your code · 40 kB', 'main']];
  rows.slice().reverse().forEach(([ins, size, c], k) => { d.box(40, 52 + k * 40, 300, 34, ins, { color: c, titleSize: 12.5, align: 'start' }); d.text(352, 74 + k * 40, size, { anchor: 'start', size: 12, color: 'muted' }); });
  d.box(40, 14, 300, 32, 'container: writable layer', { color: 'warn', dash: '5 4', titleSize: 12.5, align: 'start' });
  d.text(560, 70, 'Layers are cached.', { weight: 700, font: 'display', size: 13.5 });
  d.text(560, 92, 'Change a line → that layer and', { size: 12.5, color: 'muted' });
  d.text(560, 110, 'every layer above it rebuild.', { size: 12.5, color: 'muted' });
  d.text(560, 150, 'So: rarely-changing things first,', { size: 12.5, color: 'ok' });
  d.text(560, 168, 'your code last.', { size: 12.5, color: 'ok' });
  d.text(560, 208, 'The writable layer dies with the', { size: 12.5, color: 'bad' });
  d.text(560, 226, 'container. Data goes in volumes.', { size: 12.5, color: 'bad' });
  return figure(d, 'docker history shows these layers and their sizes. Ten containers from one image share its layers on disk; each only adds its own thin writable layer.');
};

D['container-ports'] = () => {
  const d = mk(720, 250, 'Port publishing: docker-proxy on the host forwards host port 8080 to port 80 inside the container, on the container\'s own IP');
  d.box(14, 90, 120, 56, 'browser', { sub: 'localhost:8080', color: 'accent', titleSize: 13 });
  d.box(180, 20, 520, 214, '', { color: 'text', dash: '6 4' });
  d.text(196, 42, 'your machine (the Docker host)', { anchor: 'start', size: 12.5, color: 'muted' });
  d.box(200, 90, 150, 56, ':8080 docker-proxy', { sub: '-p 8080:80', color: 'info', titleSize: 12.5 });
  d.box(410, 60, 270, 150, '', { color: 'main' });
  d.text(424, 82, 'container web · 172.17.0.2', { anchor: 'start', size: 12.5, weight: 700 });
  d.box(430, 100, 230, 40, 'nginx listening on 0.0.0.0:80', { color: 'ok', titleSize: 12 });
  d.box(430, 154, 230, 40, 'app on 127.0.0.1:3000', { color: 'bad', titleSize: 12, sub: null });
  d.arrow(136, 118, 196, 118, { color: 'text' });
  d.arrow(352, 118, 426, 120, { color: 'ok', label: '→ :80', dy: -8, size: 11 });
  d.text(545, 226, '127.0.0.1 inside = unreachable from outside', { size: 11.5, color: 'bad' });
  return figure(d, 'Inside a container, localhost means the container itself. An app must listen on 0.0.0.0 to be reachable through a published port; otherwise curl gets "connection reset".');
};

D['container-network'] = () => {
  const d = mk(720, 240, 'On a user-defined network, containers find each other by name through Docker\'s DNS; on the default bridge they cannot');
  d.box(20, 30, 330, 190, '', { color: 'ok', dash: '6 4' });
  d.text(36, 52, 'network: shop_default  (names resolve)', { anchor: 'start', size: 12.5, weight: 700, color: 'ok' });
  d.box(40, 74, 130, 54, 'api', { sub: 'REDIS_URL=redis://cache', color: 'main', titleSize: 13, subSize: 10.5 });
  d.box(200, 74, 130, 54, 'cache', { sub: 'redis :6379', color: 'info', titleSize: 13 });
  d.box(120, 150, 130, 54, 'db', { sub: 'postgres :5432', color: 'info', titleSize: 13 });
  d.arrow(172, 101, 196, 101, { color: 'ok' });
  d.arrow(110, 130, 160, 148, { color: 'ok' });
  d.box(390, 30, 310, 190, '', { color: 'muted', dash: '6 4' });
  d.text(406, 52, 'default bridge  (IP only, no names)', { anchor: 'start', size: 12.5, weight: 700, color: 'muted' });
  d.box(410, 90, 120, 54, 'app1', { color: 'main', titleSize: 13 });
  d.box(560, 90, 120, 54, 'cache', { color: 'info', titleSize: 13 });
  d.arrow(532, 117, 556, 117, { color: 'bad', dash: '4 4' });
  d.text(545, 176, 'getaddrinfo ENOTFOUND cache', { size: 12, color: 'bad', font: 'mono' });
  return figure(d, 'docker compose creates a network per project for you, which is why service names "just work" there. Only publish the ports humans need; services talk over the private network.');
};

D['compose'] = () => {
  const d = mk(720, 230, 'docker compose turns one YAML file into networks, volumes and containers, started in dependency order');
  d.box(20, 50, 190, 140, 'compose.yaml', { sub: 'services:\n  api  (build: .)\n  cache (redis)\n  db   (postgres)\nvolumes: pgdata', color: 'accent', titleSize: 14, subSize: 12 });
  d.arrow(214, 120, 280, 120, { color: 'text', label: 'up -d', dy: -8 });
  d.box(290, 30, 410, 180, '', { color: 'text', dash: '6 4' });
  d.text(306, 52, 'project "shop"', { anchor: 'start', size: 12.5, weight: 700 });
  d.box(310, 66, 110, 46, 'db', { sub: '1 · healthy', color: 'info', titleSize: 13 });
  d.box(440, 66, 110, 46, 'cache', { sub: '2 · healthy', color: 'info', titleSize: 13 });
  d.box(570, 66, 110, 46, 'api', { sub: '3 · started', color: 'main', titleSize: 13 });
  d.box(310, 130, 170, 40, 'network shop_default', { color: 'ok', titleSize: 12 });
  d.box(500, 130, 180, 40, 'volume shop_pgdata', { color: 'warn', titleSize: 12 });
  d.text(495, 196, 'depends_on + healthchecks decide the order', { size: 12, color: 'muted' });
  return figure(d, 'The file is the documentation: anyone can clone the repo and run the whole stack with one command. down removes containers and the network; only down -v deletes volumes.');
};

D['registry-flow'] = () => {
  const d = mk(720, 210, 'Build once, tag, push to a registry, and every environment pulls the same image by tag or digest');
  d.box(14, 70, 130, 64, 'build', { sub: 'app:1.4.2', color: 'main', titleSize: 13 });
  d.box(196, 70, 170, 64, 'registry', { sub: 'ghcr.io/lumen/app\n:1.4.2  :sha-3f9c2e1', color: 'accent', titleSize: 13, subSize: 11 });
  d.box(430, 20, 130, 56, 'staging', { sub: 'pull :1.4.2', color: 'feat', titleSize: 13 });
  d.box(430, 128, 130, 56, 'production', { sub: 'pull @sha256:…', color: 'ok', titleSize: 13 });
  d.box(600, 70, 110, 64, 'CI', { sub: 'docker login\n--password-stdin', color: 'info', titleSize: 13, subSize: 10.5 });
  d.arrow(146, 102, 192, 102, { color: 'text', label: 'push', dy: -8 });
  d.arrow(368, 92, 426, 52, { color: 'text', label: 'pull', dy: -4, size: 11 });
  d.arrow(368, 112, 426, 154, { color: 'text', label: 'pull', dy: 14, size: 11 });
  d.text(300, 200, ':latest is a moving label. Version tags and digests are what you deploy.', { size: 12.5, color: 'muted' });
  return figure(d, 'A tag is a name you can move; a digest (sha256:…) names exact bytes. Deploy immutable tags so "what is running" always has one answer.');
};


// ---------- Realm 7: Kubernetes ----------
D['k8s-architecture'] = () => {
  const d = mk(720, 280, 'A Kubernetes cluster: kubectl talks to the API server on the control plane; controllers and the scheduler act on stored desired state; a kubelet on each worker node runs the pods');
  d.box(14, 110, 110, 56, 'kubectl', { sub: 'you', color: 'accent', titleSize: 13 });
  d.box(160, 20, 250, 240, '', { color: 'info', dash: '6 4' });
  d.text(176, 42, 'control plane', { anchor: 'start', size: 12.5, weight: 700, color: 'info' });
  d.box(180, 56, 210, 40, 'API server', { color: 'info', titleSize: 13 });
  d.box(180, 106, 100, 40, 'etcd', { sub: 'desired state', color: 'muted', titleSize: 12, subSize: 10 });
  d.box(290, 106, 100, 40, 'scheduler', { color: 'muted', titleSize: 12 });
  d.box(180, 156, 210, 40, 'controllers', { sub: 'deployment, replicaset…', color: 'muted', titleSize: 12, subSize: 10 });
  d.text(285, 226, 'compare desired vs actual,', { size: 11.5, color: 'muted' });
  d.text(285, 242, 'act, repeat forever', { size: 11.5, color: 'muted' });
  [0, 1].forEach(k => {
    const y = 30 + k * 125;
    d.box(460, y, 246, 105, '', { color: 'text' });
    d.text(474, y + 20, `worker node ${k + 1}`, { anchor: 'start', size: 12, weight: 700 });
    d.box(474, y + 30, 70, 30, 'kubelet', { color: 'feat', titleSize: 11 });
    d.box(552, y + 30, 70, 30, 'pod', { color: 'ok', titleSize: 11 });
    d.box(630, y + 30, 64, 30, 'pod', { color: 'ok', titleSize: 11 });
    d.box(474, y + 66, 220, 28, 'container runtime (containerd)', { color: 'muted', titleSize: 10.5 });
  });
  d.arrow(126, 138, 176, 82, { color: 'accent', label: 'apply', dy: -6, size: 11 });
  d.arrow(392, 76, 456, 60, { color: 'info' });
  d.arrow(392, 90, 456, 186, { color: 'info' });
  return figure(d, 'You never start containers yourself. You write desired state to the API server; controllers and kubelets keep making reality match it, which is why a deleted pod comes back.');
};

D['k8s-objects'] = () => {
  const d = mk(720, 260, 'How the main objects connect: a Deployment owns ReplicaSets, which own Pods; a Service finds Pods by label; an Ingress routes HTTP to Services');
  d.box(20, 30, 150, 50, 'Deployment', { sub: 'replicas: 3, template', color: 'main', titleSize: 13, subSize: 10.5 });
  d.box(20, 110, 150, 50, 'ReplicaSet', { sub: 'one per template version', color: 'feat', titleSize: 13, subSize: 10.5 });
  [0, 1, 2].forEach(k => d.box(220 + k * 96, 190, 86, 50, 'Pod', { sub: 'app=shop', color: 'ok', titleSize: 13, subSize: 10.5 }));
  d.arrow(95, 82, 95, 106, { color: 'text', label: 'owns', dy: 0, lx: 128, size: 11 });
  d.arrow(120, 162, 250, 188, { color: 'text', label: 'owns', dy: -4, size: 11 });
  d.box(330, 100, 150, 50, 'Service shop', { sub: 'selector app=shop', color: 'info', titleSize: 13, subSize: 10.5 });
  d.arrow(405, 152, 360, 186, { color: 'info', dash: '5 4' });
  d.arrow(405, 152, 410, 186, { color: 'info', dash: '5 4' });
  d.arrow(405, 152, 455, 186, { color: 'info', dash: '5 4', label: 'matches labels', dy: -2, lx: 520, size: 11 });
  d.box(330, 20, 150, 50, 'Ingress', { sub: 'shop.lumen.dev/ → shop:80', color: 'accent', titleSize: 13, subSize: 10 });
  d.arrow(405, 72, 405, 96, { color: 'accent' });
  d.box(540, 20, 160, 50, 'ConfigMap / Secret', { sub: 'env or files', color: 'warn', titleSize: 12, subSize: 10.5 });
  d.arrow(560, 72, 520, 186, { color: 'warn', dash: '4 4', label: 'injected into', dy: 0, lx: 600, ly: 130, size: 11 });
  return figure(d, 'Labels are the glue. A Service has no list of pods: it selects whatever pods carry its labels right now, and only the ready ones get traffic.');
};

D['k8s-rolling'] = () => {
  const d = mk(720, 230, 'A rolling update: new pods are added and must pass readiness before old pods are removed, so capacity never drops below the minimum');
  const steps = [['start', [0, 0, 0], []], ['surge', [0, 0, 0], [1]], ['ready → swap', [0, 0], [1, 1]], ['…', [0], [1, 1, 1]], ['done', [], [1, 1, 1]]];
  steps.forEach(([t, olds, news], k) => {
    const x = 20 + k * 140;
    d.text(x + 55, 30, t, { size: 12, weight: 700 });
    olds.forEach((_, i) => d.box(x + 8, 44 + i * 36, 96, 28, 'v1', { color: 'info', titleSize: 11 }));
    news.forEach((ok, i) => d.box(x + 8, 44 + (olds.length + i) * 36, 96, 28, k === 1 ? 'v2 (starting)' : 'v2', { color: k === 1 ? 'warn' : 'ok', titleSize: 11, dash: k === 1 ? '4 3' : null }));
    if (k) d.arrow(x - 18, 100, x - 4, 100, { color: 'text' });
  });
  d.text(360, 214, 'A v2 pod that never becomes ready stops the rollout here, with v1 still serving: then `kubectl rollout undo`.', { size: 12, color: 'muted' });
  return figure(d, 'maxSurge sets how many extra pods may exist during the update; maxUnavailable how many may be missing. Readiness probes are what make this safe.');
};

D['k8s-probes'] = () => {
  const d = mk(720, 220, 'Readiness and liveness probes: readiness controls traffic, liveness controls restarts');
  d.box(20, 40, 210, 140, 'readinessProbe', { sub: '"can you take traffic now?"\n\nfail → removed from the\nService endpoints\n(pod keeps running)', color: 'info', titleSize: 14, subSize: 11.5 });
  d.box(255, 40, 210, 140, 'livenessProbe', { sub: '"are you stuck?"\n\nfail N times → kubelet\nkills and restarts the\ncontainer', color: 'warn', titleSize: 14, subSize: 11.5 });
  d.box(490, 40, 210, 140, 'resources', { sub: 'requests: reserved for\nscheduling\nlimits: the ceiling\nmemory over limit →\nOOMKilled (exit 137)', color: 'bad', titleSize: 14, subSize: 11.5 });
  d.text(360, 208, 'Do not point liveness at a check that depends on the database: a DB blip would restart every pod at once.', { size: 12, color: 'muted' });
  return figure(d, 'Probes and resources are how you tell Kubernetes what "healthy" and "enough" mean for your app. Without them it can only guess.');
};


// ---------- Realm 8: Infrastructure as Code ----------
D['tf-triangle'] = () => {
  const d = mk(720, 260, 'Terraform compares three things: your configuration, its state file, and the real infrastructure');
  d.box(250, 16, 220, 60, 'configuration (*.tf)', { sub: 'what you want', color: 'main', titleSize: 13 });
  d.box(40, 170, 220, 60, 'state (terraform.tfstate)', { sub: 'what Terraform last did', color: 'info', titleSize: 12.5 });
  d.box(460, 170, 220, 60, 'real infrastructure', { sub: 'what actually exists', color: 'ok', titleSize: 13 });
  d.arrow(300, 80, 170, 166, { color: 'main', label: 'plan: diff', dy: -4, lx: 200, ly: 120, size: 11.5 });
  d.arrow(264, 200, 456, 200, { color: 'info', label: 'refresh: read real values', dy: -10, size: 11.5 });
  d.arrow(420, 80, 560, 166, { color: 'ok', label: 'apply: change', dy: -4, lx: 540, ly: 120, size: 11.5 });
  d.text(360, 252, 'Drift = reality changed outside Terraform (a console click). Refresh shows it; the next apply undoes it unless you put it in the code.', { size: 11.5, color: 'muted' });
  return figure(d, 'Plan is safe: it only reads. Apply changes the real world and then records the result in state. Never edit state by hand.');
};

D['tf-graph'] = () => {
  const d = mk(720, 230, 'Terraform builds a dependency graph from references: resources that refer to others are created after them, in parallel where possible');
  d.box(20, 30, 170, 50, 'aws_key_pair.dev', { color: 'info', titleSize: 12 });
  d.box(20, 140, 170, 50, 'aws_security_group.web', { color: 'info', titleSize: 11.5 });
  d.box(275, 85, 170, 50, 'aws_instance.web', { color: 'main', titleSize: 12 });
  d.box(530, 30, 170, 50, 'aws_route53_record.www', { color: 'feat', titleSize: 11 });
  d.box(530, 140, 170, 50, 'output.public_ip', { color: 'muted', titleSize: 12 });
  d.arrow(192, 60, 271, 102, { color: 'text', label: 'key_name', dy: -6, size: 10.5 });
  d.arrow(192, 162, 271, 120, { color: 'text', label: 'vpc_security_group_ids', dy: 16, size: 10.5 });
  d.arrow(447, 102, 526, 62, { color: 'text', label: 'public_ip', dy: -6, size: 10.5 });
  d.arrow(447, 120, 526, 160, { color: 'text' });
  d.text(360, 222, 'Destroy walks the same graph backwards: the record and instance go before the security group.', { size: 12, color: 'muted' });
  return figure(d, 'You rarely need depends_on: a reference like aws_security_group.web.id is both the value and the ordering.');
};

D['provision-configure'] = () => {
  const d = mk(720, 230, 'Provisioning creates the machines and network; configuration management sets up what runs on them');
  d.box(20, 40, 320, 150, '', { color: 'main', dash: '6 4' });
  d.text(36, 62, 'Terraform: provision', { anchor: 'start', weight: 700, size: 13.5, color: 'main' });
  ['VPC, subnets, gateways', 'security groups', 'instances, key pairs', 'DNS records, buckets'].forEach((t, k) => d.text(40, 92 + k * 22, '• ' + t, { anchor: 'start', size: 12.5 }));
  d.box(380, 40, 320, 150, '', { color: 'feat', dash: '6 4' });
  d.text(396, 62, 'Ansible: configure', { anchor: 'start', weight: 700, size: 13.5, color: 'feat' });
  ['packages (nginx, node)', 'files and templates', 'users, services, firewall', 'app releases'].forEach((t, k) => d.text(400, 92 + k * 22, '• ' + t, { anchor: 'start', size: 12.5 }));
  d.arrow(342, 115, 376, 115, { color: 'text', label: 'IPs → inventory', dy: -10, size: 11 });
  d.text(360, 220, 'Both are declarative and idempotent: describe the end state, run it again safely. With containers, the image replaces most of the right-hand box.', { size: 11.5, color: 'muted' });
  return figure(d, 'Terraform talks to cloud APIs. Ansible talks to machines over SSH. Together they rebuild an environment from git.');
};

D['ansible-flow'] = () => {
  const d = mk(720, 230, 'Ansible pushes from a control node over SSH; each task checks the current state and only changes what differs');
  d.box(20, 80, 170, 70, 'control node', { sub: 'playbook + inventory', color: 'accent', titleSize: 13 });
  [0, 1, 2].forEach(k => d.box(330, 20 + k * 68, 150, 52, `web${k + 1}`, { sub: 'ssh · python3', color: 'info', titleSize: 13 }));
  d.arrow(192, 115, 326, 46, { color: 'text' });
  d.arrow(192, 115, 326, 114, { color: 'text', label: 'SSH', dy: -6 });
  d.arrow(192, 115, 326, 182, { color: 'text' });
  d.box(530, 30, 170, 170, '', { color: 'ok', dash: '5 4' });
  d.text(615, 52, 'each task', { weight: 700, size: 12.5 });
  ['1. check state', '2. change if needed', '3. report ok/changed', '4. notify handlers'].forEach((t, k) => d.text(545, 80 + k * 26, t, { anchor: 'start', size: 12 }));
  return figure(d, 'No agent to install: SSH plus Python on the target. Run the same playbook twice and the second run should report changed=0.');
};

export function renderDiagram(name) {
  const fn = D[name];
  if (!fn) return h('div', { class: 'figure' }, `Missing diagram: ${name}`);
  return fn();
}

export const diagramNames = Object.keys(D);
