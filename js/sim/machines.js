// Helpers that build typical machines: a developer laptop and Ubuntu servers.

import { Universe } from './host.js';
import { installSystemdTicker, unitState } from './systemd.js';
import { UBUNTU_BASE, installPkg } from './packages.js';
import { Session } from './session.js';
import { installRunner } from './runner.js';
import { privateKeyFor } from './cmd/system.js';

export function newUniverse(opts = {}) {
  const uni = new Universe(opts);
  installSystemdTicker(uni);
  installRunner(uni, addServer);
  uni.cronRunner = (host, user, cmd) => {
    const s = new Session(uni, host, { user });
    s.advancePerCommand = 0;
    const r = s.run(cmd, { record: false });
    if (r.out.length) {
      const mail = `/var/mail/${user}`;
      host.writeFile(mail, (host.files.get(mail) || '') + `From cron\nSubject: Cron <${user}@${host.name}> ${cmd}\n\n${r.out.join('\n')}\n\n`, user);
    }
  };
  return uni;
}

const sshUnit = '[Unit]\nDescription=OpenBSD Secure Shell server\nAfter=network.target\n\n[Service]\nExecStart=/usr/sbin/sshd -D\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n';

export function addServer(uni, name, { user = 'ubuntu', ip, fqdn, packages = [], memMB = 2048, cpus = 2, diskGB = 40, diskUsedGB = 5.1, env = {} } = {}) {
  const base = Object.fromEntries(UBUNTU_BASE.map(p => [p, 'ubuntu']));
  const h = uni.addHost(name, { user, ip, fqdn, packages: base, memMB, cpus, diskGB, diskUsedGB, env });
  h.writeSys('/lib/systemd/system/ssh.service', sshUnit);
  const ssh = unitState(h, 'ssh.service');
  ssh.enabled = true; ssh.active = 'active'; ssh.sub = 'running';
  ssh.pid = [...h.procs.values()].find(p => p.cmd.includes('sshd'))?.pid;
  h.writeSys('/lib/systemd/system/cron.service', '[Unit]\nDescription=Regular background program processing daemon\n\n[Service]\nExecStart=/usr/sbin/cron -f\n\n[Install]\nWantedBy=multi-user.target\n');
  h.cronEnabled = true;
  h.addGroup('adm', 4);
  h.addToGroup(user, 'adm');
  for (const p of packages) installPkg(h, uni, p, []);
  return h;
}

export function addLaptop(uni, name = 'laptop', { user = 'dev', packages = [] } = {}) {
  const base = Object.fromEntries(UBUNTU_BASE.map(p => [p, 'ubuntu']));
  const h = uni.addHost(name, { user, packages: base, kind: 'laptop', memMB: 16384, cpus: 8 });
  for (const p of packages) installPkg(h, uni, p, []);
  return h;
}

// give `fromUser@from` key access to `toUser@to` (what cloud-init does with your key)
export function authorizeKey(uni, from, fromUser, to, toUser) {
  const home = from.users.get(fromUser).home;
  const keyPath = `${home}/.ssh/id_ed25519`;
  if (!from.files.has(keyPath)) {
    from.mkdirMeta(`${home}/.ssh`, fromUser, 0o700);
    const pubKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${fromUser}${from.name}key ${fromUser}@${from.name}\n`;
    from.writeFile(keyPath, privateKeyFor(pubKey), fromUser);
    from.setMeta(keyPath, { mode: 0o600 });
    from.writeFile(keyPath + '.pub', pubKey, fromUser);
  }
  const pub = from.files.get(keyPath + '.pub');
  const th = to.users.get(toUser).home;
  to.mkdirMeta(`${th}/.ssh`, toUser, 0o700);
  const ak = `${th}/.ssh/authorized_keys`;
  to.writeFile(ak, (to.files.get(ak) || '') + pub, toUser);
  to.setMeta(ak, { mode: 0o600, owner: toUser, group: toUser });
}
