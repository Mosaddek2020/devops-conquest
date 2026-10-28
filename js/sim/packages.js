// apt and the package catalog. Installing a package makes its commands available and
// lays down what the real package would: config files, a systemd unit (started and
// enabled, as Ubuntu does), users and default content.

import { def, opts, meta } from './registry.js';
import { startUnit, unitState } from './systemd.js';
import { DEFAULT_NGINX_CONF, DEFAULT_SITE, WELCOME_PAGE } from './nginx.js';
import { C } from '../git/world.js';

const unit = (desc, exec, { user, after = 'network.target', restart = 'on-failure', type } = {}) => `[Unit]\nDescription=${desc}\nAfter=${after}\n\n[Service]\n${type ? `Type=${type}\n` : ''}ExecStart=${exec}\n${user ? `User=${user}\n` : ''}Restart=${restart}\n\n[Install]\nWantedBy=multi-user.target\n`;

export const CATALOG = {
  nginx: {
    version: '1.24.0-2ubuntu7.1', size: '552 kB', bins: ['nginx'],
    install(h, uni) {
      h.addGroup('www-data', 33);
      if (!h.users.has('www-data')) h.addUser('www-data', { uid: 33, gid: 33, home: '/var/www', shell: '/usr/sbin/nologin', noHome: true });
      h.writeSys('/etc/nginx/nginx.conf', DEFAULT_NGINX_CONF);
      h.writeSys('/etc/nginx/mime.types', 'types {\n    text/html html;\n    text/css css;\n    application/javascript js;\n}\n');
      h.writeSys('/etc/nginx/sites-available/default', DEFAULT_SITE);
      h.writeSys('/etc/nginx/sites-enabled/default', DEFAULT_SITE);
      h.mkdirMeta('/etc/nginx/conf.d');
      h.mkdirMeta('/var/www/html');
      h.writeSys('/var/www/html/index.nginx-debian.html', WELCOME_PAGE);
      h.mkdirMeta('/var/log/nginx', 'root', 0o755);
      h.writeSys('/var/log/nginx/access.log', '', { owner: 'www-data', mode: 0o640 });
      h.writeSys('/var/log/nginx/error.log', '', { owner: 'www-data', mode: 0o640 });
      h.writeSys('/lib/systemd/system/nginx.service', unit('A high performance web server and a reverse proxy server', '/usr/sbin/nginx -g \'daemon on; master_process on;\'', { type: 'forking' }));
      return ['nginx.service'];
    },
  },
  'redis-server': {
    version: '5:7.0.15-1build2', size: '76 kB', bins: ['redis-server', 'redis-cli'],
    install(h) {
      h.writeSys('/etc/redis/redis.conf', '# Redis configuration file\nbind 127.0.0.1 -::1\nport 6379\nprotected-mode yes\n# requirepass foobared\nmaxmemory-policy noeviction\n');
      h.writeSys('/lib/systemd/system/redis-server.service', unit('Advanced key-value store', '/usr/bin/redis-server /etc/redis/redis.conf', { user: 'redis' }));
      if (!h.users.has('redis')) h.addUser('redis', { shell: '/usr/sbin/nologin', noHome: true });
      return ['redis-server.service'];
    },
  },
  postgresql: {
    version: '16+257build1', size: '11.2 kB', bins: ['psql', 'pg_dump', 'pg_restore', 'createdb'], deps: ['postgresql-client'],
    install(h) {
      h.writeSys('/etc/postgresql/16/main/postgresql.conf', "# PostgreSQL configuration\nlisten_addresses = 'localhost'\nport = 5432\nmax_connections = 100\n");
      h.writeSys('/etc/postgresql/16/main/pg_hba.conf', '# TYPE  DATABASE  USER  ADDRESS  METHOD\nlocal   all       postgres         peer\nhost    all       all   127.0.0.1/32  scram-sha-256\n');
      h.writeSys('/lib/systemd/system/postgresql.service', unit('PostgreSQL RDBMS', '/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main', { user: 'postgres' }));
      h.binPaths = h.binPaths || new Set(); h.binPaths.add('/usr/lib/postgresql/16/bin/postgres');
      if (!h.users.has('postgres')) h.addUser('postgres', { home: '/var/lib/postgresql' });
      return ['postgresql.service'];
    },
  },
  nodejs: { version: '18.19.1+dfsg-6ubuntu5', size: '11.7 MB', bins: ['node', 'nodejs'] },
  npm: { version: '9.2.0~ds1-2', size: '2,170 kB', bins: ['npm', 'npx'], deps: ['nodejs'] },
  'python3-pip': { version: '24.0+dfsg-1ubuntu1', size: '1,317 kB', bins: ['pip', 'pip3'] },
  'python3-flask': { version: '3.0.2-1ubuntu1', size: '94 kB', bins: [] },
  'docker.io': {
    version: '24.0.7-0ubuntu4.1', size: '28.9 MB', bins: ['docker'],
    install(h, uni) {
      h.addGroup('docker');
      h.writeSys('/lib/systemd/system/docker.service', unit('Docker Application Container Engine', '/usr/bin/dockerd -H fd://', { after: 'network-online.target' }));
      uni.dockerInstall?.(h);
      return ['docker.service'];
    },
  },
  'docker-compose-v2': { version: '2.24.6+ds1-0ubuntu2', size: '7,856 kB', bins: [] },
  jq: { version: '1.7.1-3build1', size: '65.7 kB', bins: ['jq'] },
  tree: { version: '2.1.1-2ubuntu3', size: '47.6 kB', bins: ['tree'] },
  htop: { version: '3.3.0-4build1', size: '171 kB', bins: ['htop'] },
  curl: { version: '8.5.0-2ubuntu10.4', size: '226 kB', bins: ['curl'] },
  wget: { version: '1.21.4-1ubuntu4.1', size: '334 kB', bins: ['wget'] },
  git: { version: '1:2.43.0-1ubuntu7.1', size: '3,679 kB', bins: ['git'] },
  ufw: { version: '0.36.2-6', size: '169 kB', bins: ['ufw'] },
  certbot: { version: '2.9.0-1', size: '10.3 kB', bins: ['certbot'] },
  'python3-certbot-nginx': { version: '2.9.0-1', size: '35.7 kB', bins: [], deps: ['certbot'] },
  awscli: { version: '2.15.30-1', size: '42.1 MB', bins: ['aws'] },
  unzip: { version: '6.0-28ubuntu4', size: '174 kB', bins: ['unzip'] },
  'net-tools': { version: '2.10-0.1ubuntu4', size: '204 kB', bins: ['netstat', 'ifconfig', 'route'] },
  dnsutils: { version: '1:9.18.28-0ubuntu0.24.04.1', size: '3,468 B', bins: ['dig', 'nslookup', 'host'] },
  'bind9-dnsutils': { version: '1:9.18.28-0ubuntu0.24.04.1', size: '160 kB', bins: ['dig', 'nslookup', 'host'] },
  traceroute: { version: '1:2.1.5-1', size: '45.9 kB', bins: ['traceroute'] },
  'netcat-openbsd': { version: '1.226-1ubuntu2', size: '44.4 kB', bins: ['nc', 'netcat'] },
  'redis-tools': { version: '5:7.0.15-1build2', size: '1,034 kB', bins: ['redis-cli'] },
  'postgresql-client': { version: '16+257build1', size: '10.9 kB', bins: ['psql', 'pg_dump', 'pg_isready'] },
  ansible: { version: '9.2.0+dfsg-0ubuntu5', size: '17.1 MB', bins: ['ansible', 'ansible-playbook', 'ansible-inventory', 'ansible-galaxy', 'ansible-vault', 'ansible-lint'] },
  terraform: { version: '1.9.8-1', size: '27.4 MB', bins: ['terraform'] },
  kubectl: { version: '1.31.2-1.1', size: '11.2 MB', bins: ['kubectl'] },
  helm: { version: '3.16.2-1', size: '16.4 MB', bins: ['helm'] },
  argocd: { version: '2.13.0', size: '152 MB', bins: ['argocd'] },
  kustomize: { version: '5.4.3', size: '15.2 MB', bins: ['kustomize'] },
  kyverno: { version: '1.13.0', size: '98.4 MB', bins: ['kyverno'] },
  vault: { version: '1.18.1-1', size: '137 MB', bins: ['vault'] },
  sops: { version: '3.9.1', size: '36.8 MB', bins: ['sops'] },
  age: { version: '1.1.1-1', size: '3,105 kB', bins: ['age', 'age-keygen'] },
  infracost: { version: '0.10.39', size: '61.2 MB', bins: ['infracost'] },
  make: { version: '4.3-4.1build2', size: '180 kB', bins: ['make'] },
  sysstat: { version: '12.6.1-2', size: '486 kB', bins: ['iostat', 'mpstat', 'pidstat', 'sar'] },
  strace: { version: '6.8-0ubuntu2', size: '1,353 kB', bins: ['strace'] },
  tcpdump: { version: '4.99.4-3ubuntu4', size: '481 kB', bins: ['tcpdump'] },
  nmap: { version: '7.94+git20230807.3be01efb1+dfsg-3build2', size: '1,698 kB', bins: ['nmap'] },
  'apache2-utils': { version: '2.4.58-1ubuntu8.4', size: '96.2 kB', bins: ['ab', 'htpasswd'] },
  stress: { version: '1.0.7-1', size: '19.8 kB', bins: ['stress'] },
  'fail2ban': { version: '1.0.2-3ubuntu0.1', size: '409 kB', bins: ['fail2ban-client'] },
  'prometheus-node-exporter': {
    version: '1.7.0-1ubuntu0.2', size: '3,712 kB', bins: [],
    install(h) { h.writeSys('/lib/systemd/system/prometheus-node-exporter.service', unit('Prometheus exporter for machine metrics', '/usr/bin/prometheus-node-exporter')); h.binPaths = h.binPaths || new Set(); h.binPaths.add('/usr/bin/prometheus-node-exporter'); return ['prometheus-node-exporter.service']; },
  },
  vim: { version: '2:9.1.0016-1ubuntu7.3', size: '1,882 kB', bins: ['vim', 'vi'] },
  nano: { version: '7.2-2build1', size: '284 kB', bins: ['nano'] },
  'openssh-server': { version: '1:9.6p1-3ubuntu13.5', size: '510 kB', bins: ['sshd'] },
  cron: { version: '3.0pl1-184ubuntu2', size: '85.0 kB', bins: ['crontab'] },
  lynis: { version: '3.0.9-1', size: '1,602 kB', bins: ['lynis'] },
  gitleaks: { version: '8.21.2', size: '22.1 MB', bins: ['gitleaks'] },
  trivy: { version: '0.56.2', size: '146 MB', bins: ['trivy'] },
  semgrep: { version: '1.95.0', size: '112 MB', bins: ['semgrep'] },
  syft: { version: '1.16.0', size: '74.0 MB', bins: ['syft'] },
  cosign: { version: '2.4.1', size: '109 MB', bins: ['cosign'] },
  zaproxy: { version: '2.15.0', size: '212 MB', bins: ['zap-baseline.py', 'zap-full-scan.py'] },
  shellcheck: { version: '0.10.0-1', size: '2,511 kB', bins: ['shellcheck'] },
  'unattended-upgrades': { version: '2.9.1+nmu4ubuntu1', size: '51.1 kB', bins: [] },
};

// commands that only exist once their package is installed
const PKG_OF = {};
for (const [pkg, p] of Object.entries(CATALOG)) for (const b of p.bins || []) if (!PKG_OF[b]) PKG_OF[b] = pkg;
PKG_OF.dig = 'dnsutils'; PKG_OF.nslookup = 'dnsutils'; PKG_OF.host = 'dnsutils'; PKG_OF['redis-cli'] = 'redis-tools'; PKG_OF.psql = 'postgresql-client';
export function wirePackages() {
  for (const [bin, pkg] of Object.entries(PKG_OF)) if (meta[bin] && !['curl', 'git', 'crontab', 'nano', 'vim', 'vi', 'nc', 'netcat', 'ufw', 'sshd'].includes(bin)) meta[bin].pkg = pkg;
}

export const UBUNTU_BASE = ['curl', 'wget', 'git', 'ufw', 'openssh-server', 'cron', 'nano', 'vim', 'netcat-openbsd', 'python3', 'tar', 'gzip', 'sudo', 'less', 'iproute2', 'iputils-ping'];

export const pkgBytes = size => { const m = String(size || '2 MB').match(/([\d.,]+)\s*(kB|MB|B)/); return m ? Number(m[1].replace(',', '')) * (m[2] === 'MB' ? 1e6 : m[2] === 'kB' ? 1e3 : 1) : 2e6; };
// packages every Ubuntu machine has; in a slim container image they may be missing
const BASE_BINS = { python3: ['python3'], 'iputils-ping': ['ping'], iproute2: ['ip', 'ss'], sudo: ['sudo'], less: ['less'], tar: ['tar'], gzip: ['gzip', 'gunzip'], 'ca-certificates': [], 'build-essential': ['make', 'gcc', 'g++'], procps: ['ps', 'top', 'free', 'pkill', 'pgrep', 'uptime'] };
for (const [n, bins] of Object.entries(BASE_BINS)) if (!CATALOG[n]) CATALOG[n] = { version: '1.0', size: n === 'build-essential' ? '250 MB' : n === 'python3' ? '28 MB' : '400 kB', bins };

function installPkg(host, uni, name, out) {
  const p = CATALOG[name];
  if (host.packages.has(name)) return [];
  for (const d of p.deps || []) installPkg(host, uni, d, out);
  host.packages.set(name, p.version);
  if (host.binaries) {
    // inside a container: no systemd, just the files and commands
    for (const b of p.bins || []) host.binaries.add(b);
    host.fakeSizes = host.fakeSizes || new Map();
    host.writeSys(`/usr/share/doc/${name}/copyright`, `${name} ${p.version}\n`);
    host.fakeSizes.set(`/usr/share/doc/${name}/copyright`, pkgBytes(p.size) * 3);
    out.push(`Setting up ${name} (${p.version}) ...`);
    if (name !== 'docker.io') p.install?.(host, uni);
    for (const u of [...host.units.keys()]) host.units.delete(u);
    uni.emit({ type: 'pkg-install', host: host.name, pkg: name });
    return [];
  }
  const units = p.install?.(host, uni) || [];
  out.push(`Setting up ${name} (${p.version}) ...`);
  for (const u of units) {
    const st = unitState(host, u);
    st.enabled = true;
    out.push(`Created symlink /etc/systemd/system/multi-user.target.wants/${u} → /lib/systemd/system/${u}.`);
    const r = startUnit(host, uni, u);
    if (!r.ok) out.push(`Job for ${u} failed because the control process exited with error code.`, `See "systemctl status ${u}" and "journalctl -xeu ${u}" for details.`, `invoke-rc.d: initscript ${u.replace('.service', '')}, action "start" failed.`);
  }
  uni.emit({ type: 'pkg-install', host: host.name, pkg: name });
  return units;
}

def(['apt', 'apt-get'], c => {
  const o = opts(c.args, { bool: ['-y', '--yes', '-q', '-qq', '--no-install-recommends', '--purge', '--installed', '--upgradable', '-f'], val: [] });
  const [sub, ...names] = o._;
  const host = c.host, uni = c.uni;
  const needRoot = () => c.user === 'root' ? null : c.fail(`E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?`, 100);
  switch (sub) {
    case 'update': {
      if (c.user !== 'root') return c.fail('Reading package lists... Done\nE: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/', 100);
      c.print('Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease', 'Get:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]', 'Get:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]', 'Fetched 252 kB in 1s (310 kB/s)', 'Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done', '12 packages can be upgraded. Run \'apt list --upgradable\' to see them.');
      host.aptUpdated = true;
      if (host.binaries) { host.fakeSizes = host.fakeSizes || new Map(); host.writeSys('/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble_main_binary-amd64_Packages', 'Package: …\n'); host.fakeSizes.set('/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble_main_binary-amd64_Packages', 42e6); }
      return 0;
    }
    case 'upgrade': case 'full-upgrade': case 'dist-upgrade': {
      if (needRoot() !== null) return 100;
      c.print('Reading package lists... Done', 'Building dependency tree... Done', 'Calculating upgrade... Done', '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.');
      return 0;
    }
    case 'install': {
      if (needRoot() !== null) return 100;
      if (!names.length) { c.print('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'); return 0; }
      c.print('Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done');
      if (host.binaries && !host.aptUpdated) return c.fail(`E: Unable to locate package ${names[0]}`, 100);
      const missing = names.filter(n => !CATALOG[n] && !UBUNTU_BASE.includes(n));
      if (missing.length) return c.fail(`E: Unable to locate package ${missing[0]}`, 100);
      const todo = names.filter(n => CATALOG[n] && !host.packages.has(n) && !(host.binaries && (CATALOG[n].bins || []).length && CATALOG[n].bins.every(b => host.binaries.has(b))));
      for (const n of names.filter(n => !todo.includes(n))) c.print(`${n} is already the newest version (${CATALOG[n]?.version || 'installed'}).`);
      if (!todo.length) { c.print('0 upgraded, 0 newly installed, 0 to remove and 12 not upgraded.'); return 0; }
      const all = new Set();
      const add = n => { if (host.packages.has(n) || all.has(n)) return; for (const d of CATALOG[n].deps || []) add(d); all.add(n); };
      todo.forEach(add);
      c.print('The following NEW packages will be installed:', '  ' + [...all].join(' '), `0 upgraded, ${all.size} newly installed, 0 to remove and 12 not upgraded.`);
      const out = [];
      for (const n of all) c.print(`Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 ${n} amd64 ${CATALOG[n].version} [${CATALOG[n].size}]`);
      for (const n of all) out.push(`Selecting previously unselected package ${n}.`, `Unpacking ${n} (${CATALOG[n].version}) ...`);
      for (const n of todo) installPkg(host, uni, n, out);
      c.print(...out);
      c.print('Processing triggers for man-db (2.12.0-4build2) ...');
      return 0;
    }
    case 'remove': case 'purge': case 'autoremove': {
      if (needRoot() !== null) return 100;
      for (const n of names) {
        if (!host.packages.has(n)) { c.print(`Package '${n}' is not installed, so not removed`); continue; }
        host.packages.delete(n);
        for (const u of [...host.units.keys()]) if (u.startsWith(n.replace('-server', ''))) { for (const p of [...host.procs.values()]) if (p.unit === u) host.killProc(p.pid); host.units.delete(u); }
        c.print(`Removing ${n} (${CATALOG[n]?.version}) ...`);
      }
      return 0;
    }
    case 'list': {
      if (o['--installed']) { c.print('Listing... Done'); for (const [n, v] of [...host.packages].sort()) c.print(`${C.green(n)}/noble,now ${v} amd64 [installed]`); return 0; }
      if (o['--upgradable']) { c.print('Listing... Done', `${C.green('openssl')}/noble-updates 3.0.13-0ubuntu3.4 amd64 [upgradable from: 3.0.13-0ubuntu3.1]`); return 0; }
      c.print('Listing... Done'); for (const n of Object.keys(CATALOG).filter(n => !names[0] || n.includes(names[0]))) c.print(`${C.green(n)}/noble ${CATALOG[n].version} amd64`);
      return 0;
    }
    case 'search': { for (const n of Object.keys(CATALOG).filter(n => n.includes(names[0] || ''))) c.print(`${C.green(n)}/noble ${CATALOG[n].version} amd64`); return 0; }
    case 'show': case 'policy': {
      const n = names[0];
      if (!CATALOG[n]) return c.fail(`N: Unable to locate package ${n}`, 100);
      c.print(`Package: ${n}`, `Version: ${CATALOG[n].version}`, `Installed: ${host.packages.has(n) ? CATALOG[n].version : '(none)'}`);
      return 0;
    }
  }
  return c.fail(`E: Invalid operation ${sub || ''}`, 100);
});

// Alpine's package manager (busybox images)
const APK_NAMES = { nodejs: 'nodejs', npm: 'npm', python3: 'python3', 'py3-pip': 'python3-pip', redis: 'redis-server', postgresql: 'postgresql', 'postgresql-client': 'postgresql-client', bind: 'dnsutils', 'bind-tools': 'dnsutils', 'build-base': 'build-essential', openssh: 'openssh-server', 'openssh-client': 'openssh-server' };
def('apk', c => {
  const [sub, ...rest] = c.args;
  const host = c.host;
  if (c.user !== 'root') return c.fail('ERROR: Unable to lock database: Permission denied\nERROR: Failed to open apk database: Permission denied', 99);
  const noCache = rest.includes('--no-cache');
  const names = rest.filter(a => !a.startsWith('-'));
  if (sub === 'update') { c.print('fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz', 'v3.20.3 [https://dl-cdn.alpinelinux.org/alpine/v3.20/main]', 'OK: 24165 distinct packages available'); host.apkIndex = true; host.fakeSizes = host.fakeSizes || new Map(); host.writeSys('/var/cache/apk/APKINDEX.tar.gz', 'index'); host.fakeSizes.set('/var/cache/apk/APKINDEX.tar.gz', 2.4e6); return 0; }
  if (sub === 'add') {
    if (!names.length) return c.fail('ERROR: no packages given', 1);
    if (!noCache && !host.apkIndex) { c.print('WARNING: opening from cache https://dl-cdn.alpinelinux.org/alpine/v3.20/main: No such file or directory'); return c.fail(`ERROR: unable to select packages:\n  ${names[0]} (no such package):\n    required by: world[${names[0]}]`, 1); }
    let k = 0;
    for (const n of names) {
      const deb = APK_NAMES[n] || n;
      const p = CATALOG[deb];
      const bins = p?.bins?.length ? p.bins : [n];
      k++;
      c.print(`(${k}/${names.length}) Installing ${n} (${p?.version?.replace(/^\d+:/, '').split(/[-+~]/)[0] || '1.0'}-r0)`);
      for (const b of bins) host.binaries?.add(b);
      host.packages.set(deb, p?.version || '1.0');
      host.fakeSizes = host.fakeSizes || new Map();
      host.writeSys(`/usr/share/apk/${n}.list`, n + '\n');
      host.fakeSizes.set(`/usr/share/apk/${n}.list`, pkgBytes(p?.size || '1 MB') * 2);
      if (!noCache) { host.writeSys(`/var/cache/apk/${n}.apk`, n); host.fakeSizes.set(`/var/cache/apk/${n}.apk`, pkgBytes(p?.size || '1 MB')); }
      c.uni.emit({ type: 'pkg-install', host: host.name, pkg: deb, apk: true });
    }
    c.print(`OK: ${(7 + names.length * 3.1).toFixed(0)} MiB in ${14 + names.length * 4} packages`);
    return 0;
  }
  if (sub === 'del') { for (const n of names) { const deb = APK_NAMES[n] || n; host.packages.delete(deb); for (const b of CATALOG[deb]?.bins || [n]) host.binaries?.delete(b); c.print(`(1/1) Purging ${n}`); } return 0; }
  if (sub === 'info') { for (const n of host.packages.keys()) c.print(n); return 0; }
  return c.fail(`apk-tools 2.14.4, compiled for x86_64.\n\nusage: apk [<OPTIONS>...] COMMAND [<ARGUMENTS>...]`, 1);
}, { pkg: 'apk-tools' });

def('dpkg', c => {
  if (c.args[0] === '-l' || c.args[0] === '--list') { c.print('||/ Name           Version'); for (const [n, v] of c.host.packages) if (!c.args[1] || n.includes(c.args[1].replace(/\*/g, ''))) c.print(`ii  ${n.padEnd(14)} ${v}`); return 0; }
  return c.fail('dpkg: use apt to install packages in the simulator', 2);
});

export { installPkg };
