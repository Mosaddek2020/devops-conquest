// Disks, mounts, fstab and reboots; performance tools on a modelled server.
import '../js/sim/index.js';
import { buildLabWorld } from '../js/lab.js';
import { stripAnsi } from '../js/git/world.js';

let fails = 0;
const verbose = process.argv.includes('-v');
function scenario(name, setup, steps) {
  console.log(`\n# ${name}`);
  const { uni, sh, H } = buildLabWorld({ setup, cwd: '~' });
  const run = (cmd, expect, not, answers) => {
    let r = sh.run(cmd);
    while (r.ask) r = sh.resolveAsk(r.ask, (answers || ['y']).shift() ?? 'y');
    const out = r.out.map(stripAnsi).join('\n');
    const ok = (!expect || (expect instanceof RegExp ? expect.test(out) : out.includes(expect))) && (!not || !(not instanceof RegExp ? not.test(out) : out.includes(not)));
    if (!ok) { fails++; console.log(`✗ ${cmd}\n${out.split('\n').map(l => '    ' + l).join('\n')}`); } else console.log(`✓ ${cmd.split('\n')[0]}`);
    if (verbose) console.log(out.split('\n').map(l => '    ' + l).join('\n'));
    return out;
  };
  steps({ run, uni, sh, H });
}

scenario('disks', H => {
  H.server('web1');
  H.authorize('laptop', 'dev', 'web1', 'ubuntu');
  H.disk('web1', { name: 'xvdf', sizeGB: 50 });
  H.disk('web1', { name: 'xvdg', sizeGB: 1, fs: 'ext4', inodes: 1024, mount: '/var/cache/thumbs' });
  for (let i = 0; i < 1000; i++) H.write('web1', `/var/cache/thumbs/t${i}.png`, 'x'.repeat(200), { owner: 'www-data' });
  for (let i = 0; i < 900; i++) H.age('web1', `/var/cache/thumbs/t${i}.png`, 30);
  H.write('web1', '/var/www/uploads/a.jpg', 'jpeg', { owner: 'www-data' });
  H.console('web1');
}, ({ run }) => {
  run('ssh ubuntu@web1', '');
  run('df -h', /\/dev\/xvda1\s+40G[\s\S]*\/dev\/xvdg\s+1\.0G/);
  run('df -i /var/cache/thumbs', /\/dev\/xvdg\s+1024\s+10\d\d\s+\d+\s+(99|100)% \/var\/cache\/thumbs/);
  run('sudo find /var/cache/thumbs -type f -mtime +7 -delete && df -i /var/cache/thumbs', /\s1[01]\d\s+\d+\s+1\d% /);
  run('lsblk', /xvdf\s+202:\d+\s+0\s+50G\s+0 disk\s*$/m);
  run('sudo mount /dev/xvdf /mnt', /wrong fs type/);
  run('sudo mkfs.ext4 /dev/xvdf', /Creating filesystem with 13107200 4k blocks/);
  run('sudo blkid /dev/xvdf', /UUID="[0-9a-f-]{36}" BLOCK_SIZE="4096" TYPE="ext4"/);
  run('sudo mkdir -p /srv/uploads && sudo mount /dev/xvdf /srv/uploads && df -h /srv/uploads', /\/dev\/xvdf\s+50G/);
  run('sudo cp -a /var/www/uploads/. /srv/uploads/ && ls -l /srv/uploads', /www-data.*a\.jpg/);
  run('sudo umount /srv/uploads && ls /srv/uploads | wc -l', /^0$/m);
  run('UUID=$(sudo blkid -s UUID -o value /dev/xvdf) && echo "UUID=$UUID /srv/uploads ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab && sudo mount -a && ls /srv/uploads', 'a.jpg');
  run('echo "UUID=00000000-dead-beef-0000-000000000000 /data ext4 defaults 0 2" | sudo tee -a /etc/fstab && sudo mkdir -p /data && sudo mount -a', /special device UUID=00000000-dead-beef-0000-000000000000 does not exist/);
  run('sudo reboot', /closed by remote host/);
  run('ssh -o ConnectTimeout=5 ubuntu@web1', /timed out/);
  run('console web1', 'console session');
  run('journalctl -b -p err | tail -3; sed -i "/dead-beef/d" /etc/fstab && reboot', /closed by remote host/);
  run('ssh ubuntu@web1', '');
  run('findmnt /srv/uploads && ls /srv/uploads', /\/srv\/uploads\s+\/dev\/xvdf[\s\S]*a\.jpg/);
});

scenario('perf', H => {
  const s = H.server('app1', { cpus: 4 });
  H.server('db1', { packages: ['postgresql'] });
  H.authorize('laptop', 'dev', 'app1', 'ubuntu');
  H.authorize('laptop', 'dev', 'db1', 'ubuntu');
  H.install('app1', 'sysstat', 'strace', 'tcpdump');
  const tar = H.proc('app1', { cmd: 'tar czf /backup/uploads-2026-01-01.tgz /var/www/uploads', user: 'root', cpu: 35, mem: 40, state: 'D' });
  tar.io = { r: 125000, w: 38000 };
  const w = H.proc('app1', { cmd: '/usr/bin/node /opt/worker/worker.js', user: 'ubuntu', cpu: 0.1, mem: 90 });
  w.connectsTo = { host: 'db1', port: 5432, label: 'db connect' };
  H.write('db1', '/etc/postgresql/16/main/postgresql.conf', "listen_addresses = '*'\nport = 5432\n");
  H.run('sudo systemctl restart postgresql && sudo ufw allow OpenSSH && sudo ufw enable', { on: 'db1' });
  H.perf('app1', { load: [7.9, 6.2, 3.1], kernel: [{ msg: 'Out of memory: Killed process 3112 (report-gen) total-vm:2894112kB, anon-rss:2311020kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:5012kB oom_score_adj:0', ago: 30000 }] });
  void s;
}, ({ run }) => {
  run('ssh ubuntu@app1', '');
  run('uptime && nproc', /load average: 7\.\d\d/);
  run('vmstat 1 3', /r\s+b\s+swpd[\s\S]*\n\s*\d+\s+[1-9]/);
  run('iostat -x', /xvda\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+99\.\d\d/);
  run('pidstat -d', /tar/);
  run('sudo iotop -o -b -n 1', /be\/4.*tar czf/);
  run('sudo ionice -c3 -p $(pgrep -f "tar czf") && sudo renice -n 10 -p $(pgrep -f "tar czf")', /new priority 10/);
  run('iostat -x', /xvda[\s\S]*\s([0-9]|[1-3][0-9])\.\d\d$/m);
  run('sudo strace -p $(pgrep -f worker.js)', /connect\(12, \{sa_family=AF_INET, sin_port=htons\(5432\)[\s\S]*Timeout/);
  run('sudo tcpdump -n -i eth0 port 5432 -c 4', /Flags \[S\][\s\S]*Flags \[S\]/, /Flags \[S\.\]/);
  run('sudo dmesg -T | grep -i "killed process"', /report-gen/);
  run('exit');
  run('ssh ubuntu@db1 "sudo ufw allow from 10.0.0.11 to any port 5432"', /Rule added/);
  run('ssh ubuntu@app1 "sudo tcpdump -n port 5432 -c 3"', /Flags \[S\.\]/);
});

process.on('exit', () => console.log(fails ? `\n${fails} failures` : '\nall storage scenarios passed'));
process.exitCode = 0;
setTimeout(() => { process.exitCode = fails ? 1 : 0; }, 0);
