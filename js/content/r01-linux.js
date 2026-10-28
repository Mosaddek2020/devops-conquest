// Realm 1 · Linux Foundations: the shell, files, permissions, pipes, processes, packages.

const GB = 1073741824;
const hist = (t, re) => { let k = -1; t.history.forEach((l, i) => { if (re.test(l)) k = i; }); return k; };

// a deterministic access log: an attacker hammering /login, some 500s on /api/checkout
function accessLog() {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ips = ['10.1.4.21', '10.1.4.22', '172.16.8.3', '172.16.8.40', '192.0.2.15', '198.51.100.23', '198.51.100.24', '192.0.2.88'];
  const paths = ['/', '/events', '/events/42', '/search?q=jazz', '/api/cart', '/api/checkout', '/static/app.js', '/login'];
  const lines = [];
  for (let k = 0; k < 420; k++) {
    const attacker = k % 3 === 0;
    const ip = attacker ? '203.0.113.77' : ips[Math.floor(rnd() * ips.length)];
    const path = attacker ? '/login' : paths[Math.floor(rnd() * paths.length)];
    const method = attacker || (path === '/login' && rnd() < 0.5) || path.startsWith('/api/') ? 'POST' : 'GET';
    let status = 200;
    if (attacker) status = 401;
    else if (path === '/api/checkout' && rnd() < 0.45) status = 500;
    else if (path === '/api/cart' && rnd() < 0.08) status = 500;
    else if (rnd() < 0.04) status = 404;
    const mm = String(Math.floor(k / 7) % 60).padStart(2, '0'), ss = String((k * 13) % 60).padStart(2, '0');
    lines.push(`${ip} - - [01/Jan/2026:11:${mm}:${ss} +0000] "${method} ${path} HTTP/1.1" ${status} ${200 + Math.floor(rnd() * 5000)} "-" "${attacker ? 'python-requests/2.31' : 'Mozilla/5.0'}"`);
  }
  return lines.join('\n') + '\n';
}
const LOG = accessLog();
const LOG_LINES = LOG.trim().split('\n').map(l => l.split(' '));
const COUNT_500 = LOG_LINES.filter(f => f[8] === '500').length;
const CLIENTS = new Set(LOG_LINES.map(f => f[0])).size;
const ATTACKER_LINES = LOG_LINES.filter(f => f[0] === '203.0.113.77').length;

const HEALTHCHECK = `#!/bin/bash
# Checks the Lumen API health endpoint. Needs: curl, jq, and API_URL.
set -euo pipefail
: "\${API_URL:?set API_URL first, e.g. export API_URL=https://api.lumen.example.com}"
status=$(curl -s "$API_URL/health" | jq -r .status)
echo "API status: $status"
`;


// ---------- disks and mounts ----------
const thumbsDev = t => t.dev('web1', 'xvdg');
const thumbsInodes = t => { const u = t.fsUsage('web1', '/var/cache/thumbs'); return u ? u.inodesUsed / u.inodes : 1; };
const uploadsUuid = t => t.dev('web1', 'xvdf')?.uuid;
const fstabUploads = t => t.fstab('web1').find(e => e.file.replace(/\/$/, '') === '/srv/uploads');
// ---------- performance ----------
const procOn = (t, re) => [...t.host('app1').procs.values()].find(p => re.test(p.cmd)) || null;

export default {
  id: 'linux',
  n: 1,
  title: 'Linux Foundations',
  tagline: 'The shell, files, permissions, pipes, processes and packages',
  badge: 'Shell Dweller',
  intro: 'Almost every server, container and cloud machine runs **Linux**, and you drive it by typing. Learn to move around, work with files, control **permissions**, analyse logs with **pipes**, manage **processes**, and install software. Everything else in DevOps builds on this.',
  lessons: [
    {
      id: 'shell-basics',
      title: 'The shell and the filesystem',
      summary: 'Prompts, the directory tree, absolute and relative paths, ls, cd, Tab and history.',
      minutes: 18,
      lab: {
        cwd: '~',
        panels: ['files', 'system'],
        setup(H) {
          H.write('laptop', '/var/log/syslog', 'Jan  1 09:00:01 laptop systemd[1]: Started Daily apt download activities.\nJan  1 09:00:02 laptop CRON[811]: (root) CMD (run-parts /etc/cron.hourly)\n');
          H.write('laptop', '/var/log/nginx/access.log', '127.0.0.1 - - [01/Jan/2026:09:00:00 +0000] "GET / HTTP/1.1" 200 612\n');
          H.write('laptop', '/var/log/nginx/error.log', '');
          H.write('laptop', '/var/log/auth.log', 'Jan  1 08:59:59 laptop sudo:      dev : TTY=pts/0 ; PWD=/home/dev ; USER=root ; COMMAND=/usr/bin/apt update\n');
          H.write('laptop', '~/.bashrc', '# ~/.bashrc: executed by bash for interactive shells.\n\n# history settings\nHISTSIZE=1000\nHISTFILESIZE=2000\n\n# a few handy aliases\nalias ll="ls -alF"\nalias gs="git status"\n', { owner: 'dev' });
          H.write('laptop', '~/projects/lumen-api/README.md', '# lumen-api\n\nThe ticketing API. Logs go to /var/log/lumen/ on servers.\n', { owner: 'dev' });
          H.write('laptop', '~/projects/lumen-web/README.md', '# lumen-web\n\nThe public website.\n', { owner: 'dev' });
          for (const p of ['/home/dev/projects', '/home/dev/projects/lumen-api', '/home/dev/projects/lumen-web']) H.laptop.setMeta(p, { owner: 'dev', group: 'dev' });
        },
        suggestions: ['pwd', 'cd /var/log', 'ls -l'],
        tasks: [
          { title: 'Go to the system log folder with an absolute path: `cd /var/log`', solution: 'cd /var/log', check: t => t.cwd === '/var/log' },
          { title: 'List it in long format', hint: '`ls -l` shows permissions, owner, size and date.', solution: 'ls -l', check: t => t.ran(/^ls\b.*-[a-zA-Z]*l/) && t.cwd === '/var/log' },
          { title: 'Enter the nginx folder with a relative path (no leading `/`)', solution: 'cd nginx', check: t => t.cwd === '/var/log/nginx' && t.ran(/^cd\s+nginx\/?\s*$/) },
          { title: 'Go up two levels at once with `..`', hint: '`cd ../..` goes up two levels: from /var/log/nginx to /var.', solution: 'cd ../..', check: t => t.cwd === '/var' && t.ran(/^cd\s+\.\.\/\.\.\/?\s*$/) },
          { title: 'Go home and list everything, including hidden files', solution: 'cd ~ && ls -la', check: t => t.cwd === '/home/dev' && t.ran(/^(cd\b.*&&\s*)?ls\b.*-[a-zA-Z]*a/) },
          { title: 'Show the first 5 lines of your `.bashrc`', solution: 'head -n 5 ~/.bashrc', check: t => t.ran(/\bhead\b.*(-n\s*5|-5).*\.bashrc|\bhead\b.*\.bashrc.*(-n\s*5|-5)/) },
          { title: 'Read the README of the lumen-api project (use Tab to complete the path)', solution: 'cat ~/projects/lumen-api/README.md', check: t => t.ran(/\b(cat|less|head)\b.*lumen-api\/README\.md/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'In the prompt `ubuntu@web3:/var/log$`, what is `/var/log`?', choices: ['The user', 'The machine', 'The current directory', 'The last command'], answer: 2, explain: 'user@host:directory, then $ for a normal user (# for root).' },
        { type: 'mc', q: 'You are in /var/log. Which path refers to /var/log/nginx/error.log?', choices: ['/nginx/error.log', 'nginx/error.log', '../nginx/error.log', '~/nginx/error.log'], answer: 1, explain: 'A relative path starts from where you are.' },
        { type: 'predict', q: 'Where are you after these commands?', code: '$ cd /var/log/nginx\n$ cd ../..\n$ pwd', choices: ['/var/log', '/var', '/', '/var/log/nginx'], answer: 1, explain: 'Each .. goes up one level.' },
        { type: 'mc', q: 'Why might `ls` not show a file called .env?', choices: ['It is empty', 'Names starting with a dot are hidden; use ls -a', 'It is too big', 'Only root can list it'], answer: 1, explain: 'Dot files are hidden by convention.' },
        { type: 'mc', q: 'Where does Linux usually keep system configuration?', choices: ['/home', '/etc', '/tmp', '/bin'], answer: 1, explain: 'Logs in /var/log, config in /etc.' },
        { type: 'tf', q: 'On Linux, Readme.md and README.md can be two different files in the same folder.', answer: true, explain: 'File names are case-sensitive.' },
        { type: 'type', q: 'Type the command that takes you back to the directory you were in before.', accept: ['cd -'], model: 'cd -', explain: 'Handy for bouncing between two folders.' },
        { type: 'type', q: 'Type the command that lists all files in /etc, hidden ones included, in long format.', accept: ['ls -la /etc', 'ls -al /etc', 'ls -l -a /etc', 'ls -a -l /etc', 'ls -lA /etc', 'ls -Al /etc'], model: 'ls -la /etc', explain: '-l long, -a all.' },
      ],
    },
    {
      id: 'files-editors',
      title: 'Files, folders and editors',
      summary: 'mkdir -p, cp, mv, rm, wildcards (preview first!), reading files, and editing safely.',
      minutes: 18,
      lab: {
        cwd: '~',
        panels: ['files'],
        setup(H) {
          const d = '/home/dev/messy-project';
          H.mkdir('laptop', d, { owner: 'dev' });
          const files = { 'app.conf': '# Lumen API config\nport=8080\ntimeout=5\nlog_level=info\n', 'app.conf.bak': '# Lumen API config (old)\nport=8080\ntimeout=5\nlog_level=debug\n', 'notes.txt': 'TODO: organise this folder\n', 'debug-1.log': 'debug output 1\n', 'debug-2.log': 'debug output 2\n', 'debug-3.log': 'debug output 3\n', 'screenshot-1.png': 'PNG', 'screenshot-2.png': 'PNG', 'index.js': 'console.log("hello")\n' };
          for (const [n, c] of Object.entries(files)) H.write('laptop', `${d}/${n}`, c, { owner: 'dev' });
        },
        suggestions: ['cd ~/messy-project', 'ls -l'],
        tasks: [
          { title: 'Go into `~/messy-project` and look around', solution: 'cd ~/messy-project && ls -l', check: t => t.cwd === '/home/dev/messy-project' },
          { title: 'Create the folders `logs`, `config` and `docs/images` in one command', hint: '`mkdir -p` creates parent folders as needed and accepts several names.', solution: 'mkdir -p logs config docs/images', check: t => ['logs', 'config', 'docs/images'].every(d => t.stat('laptop', `/home/dev/messy-project/${d}`)?.type === 'dir') },
          { title: 'Preview which files `*.log` matches, then move them all into `logs/`', solution: 'ls *.log && mv *.log logs/', check: t => [1, 2, 3].every(n => t.exists('laptop', `/home/dev/messy-project/logs/debug-${n}.log`)) && !t.exists('laptop', '/home/dev/messy-project/debug-1.log') && t.ran(/^ls\b.*\*\.log/) },
          { title: 'Move the screenshots into `docs/images/`', solution: 'mv screenshot-*.png docs/images/', check: t => [1, 2].every(n => t.exists('laptop', `/home/dev/messy-project/docs/images/screenshot-${n}.png`)) },
          { title: 'Before editing, back up `app.conf` as `app.conf.orig`', solution: 'cp app.conf app.conf.orig', check: t => /timeout=5/.test(t.file('laptop', '/home/dev/messy-project/app.conf.orig') || '') },
          { title: 'Edit `app.conf` (the real one, not the .bak!) and change `timeout=5` to `timeout=30`', hint: '`nano app.conf`, change the line, Ctrl+S. Or `sed -i \'s/timeout=5/timeout=30/\' app.conf`.', solution: "sed -i 's/timeout=5/timeout=30/' app.conf", check: t => /timeout=30/.test(t.file('laptop', '/home/dev/messy-project/app.conf') || '') && /timeout=5/.test(t.file('laptop', '/home/dev/messy-project/app.conf.bak') || '') },
          { title: 'Delete the stale `app.conf.bak` (keep your `.orig` backup)', solution: 'rm app.conf.bak', check: t => !t.exists('laptop', '/home/dev/messy-project/app.conf.bak') && t.exists('laptop', '/home/dev/messy-project/app.conf.orig') },
          { title: 'Move `app.conf` and its backup into `config/`, then list the tree', solution: 'mv app.conf app.conf.orig config/ && ls -R', check: t => /timeout=30/.test(t.file('laptop', '/home/dev/messy-project/config/app.conf') || '') && t.exists('laptop', '/home/dev/messy-project/config/app.conf.orig') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does `mkdir -p a/b/c` do that `mkdir a/b/c` does not?', choices: ['Makes the folders private', 'Creates the missing parent folders a and a/b too', 'Prints the path', 'Deletes existing folders'], answer: 1, explain: '-p = parents, and no error if it exists.' },
        { type: 'mc', q: 'Who expands `*.log` in `rm *.log`?', choices: ['rm itself', 'The shell, before rm starts', 'The filesystem', 'Nobody: rm deletes a file literally named *.log'], answer: 1, explain: 'That is why you preview the same pattern with ls first.' },
        { type: 'multi', q: 'Which are good habits before deleting with a wildcard?', choices: ['Run ls with the same pattern first', 'Check pwd', 'Use rm -i if unsure', 'Add -f so it does not ask'], answer: [0, 1, 2], explain: '-f removes the last safety question.' },
        { type: 'mc', q: 'Which command renames notes.txt to README.md?', choices: ['cp notes.txt README.md', 'mv notes.txt README.md', 'rename README.md', 'ln notes.txt README.md'], answer: 1, explain: 'mv moves or renames.' },
        { type: 'tf', q: 'Files deleted with rm go to a recycle bin you can restore from.', answer: false, explain: 'No undo: backups and version control are your safety net.' },
        { type: 'mc', q: 'You want to see the last 50 lines of a big log. Which is best?', choices: ['cat app.log', 'tail -n 50 app.log', 'head -n 50 app.log', 'less -50 app.log'], answer: 1, explain: 'tail shows the end; head the beginning.' },
        { type: 'type', q: 'Type the command that copies the directory site/ (with everything inside) to site-backup/.', accept: ['cp -r site/ site-backup/', 'cp -r site site-backup', 'cp -R site/ site-backup/', 'cp -R site site-backup', 'cp -a site site-backup', 'cp -a site/ site-backup/', 'cp -r site/ site-backup', 'cp -r site site-backup/'], model: 'cp -r site/ site-backup/', explain: '-r (recursive) is required for directories.' },
      ],
    },
    {
      id: 'users-permissions',
      title: 'Users, groups and permissions',
      summary: 'rwx for owner, group and others; chmod, chown, sudo, useradd, groups and least privilege.',
      minutes: 22,
      lab: {
        cwd: '~',
        panels: ['files', 'system'],
        setup(H) {
          H.mkdir('laptop', '/srv/site', { owner: 'root' });
          H.write('laptop', '/srv/site/index.html', '<h1>Lumen events</h1>\n');
          H.write('laptop', '/srv/site/deploy.sh', '#!/bin/bash\necho "deploying site"\n');
        },
        suggestions: ['id', 'ls -l /srv/site'],
        tasks: [
          { title: 'Check who you are and which groups you belong to', solution: 'id', check: t => t.ran(/^(id|groups|whoami)\b/) },
          { title: 'Create a user `deploy` with a home folder and bash as its shell', hint: '`sudo useradd -m -s /bin/bash deploy`', solution: 'sudo useradd -m -s /bin/bash deploy', check: t => t.userExists('laptop', 'deploy') && t.exists('laptop', '/home/deploy') },
          { title: 'Create the group `webteam` and add both `deploy` and yourself (`dev`) to it', hint: 'groupadd, then `usermod -aG` (do not forget -a).', solution: 'sudo groupadd webteam && sudo usermod -aG webteam deploy && sudo usermod -aG webteam dev', check: t => t.inGroup('laptop', 'deploy', 'webteam') && t.inGroup('laptop', 'dev', 'webteam') && t.inGroup('laptop', 'dev', 'sudo') },
          { title: 'Give `/srv/site` and everything in it to owner `deploy`, group `webteam`', solution: 'sudo chown -R deploy:webteam /srv/site', check: t => ['/srv/site', '/srv/site/index.html', '/srv/site/deploy.sh'].every(p => t.owner('laptop', p) === 'deploy' && t.stat('laptop', p).group === 'webteam') },
          { title: 'Let the group write in the site folder too (others stay read-only)', hint: '`sudo chmod -R g+w /srv/site`', solution: 'sudo chmod -R g+w /srv/site', check: t => (t.mode('laptop', '/srv/site') & 0o020) && (t.mode('laptop', '/srv/site/index.html') & 0o020) && !(t.mode('laptop', '/srv/site/index.html') & 0o002) },
          { title: 'Make `deploy.sh` executable for owner and group only: mode 750', solution: 'sudo chmod 750 /srv/site/deploy.sh', check: t => (t.mode('laptop', '/srv/site/deploy.sh') & 0o777) === 0o750 },
          { title: 'Create `/srv/site/.env` with `DB_PASSWORD=…`, owned by `deploy`, readable only by its owner (600)', hint: 'Write it as deploy: `echo "DB_PASSWORD=s3cret" | sudo -u deploy tee /srv/site/.env`, then `sudo chmod 600 /srv/site/.env`.', solution: 'echo "DB_PASSWORD=s3cret" | sudo -u deploy tee /srv/site/.env > /dev/null && sudo chmod 600 /srv/site/.env', check: t => t.owner('laptop', '/srv/site/.env') === 'deploy' && (t.mode('laptop', '/srv/site/.env') & 0o777) === 0o600 && /DB_PASSWORD=/.test(t.file('laptop', '/srv/site/.env') || '') },
          { title: 'Prove it: `deploy` can read the secret, and you (dev) cannot', solution: 'sudo -u deploy cat /srv/site/.env; cat /srv/site/.env', test: ['sudo -u deploy cat /srv/site/.env', 'cat /srv/site/.env'], check: t => t.ran(/sudo\s+-u\s+deploy\s+cat\s+\/srv\/site\/\.env/) && t.ran(/^cat\s+\/srv\/site\/\.env/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does `-rw-r-----` mean for a file owned by alice, group ops?', choices: ['Everyone can read it', 'alice can read and write, ops members can read, others nothing', 'Only root can read it', 'alice can execute it'], answer: 1, explain: 'owner rw-, group r--, others ---: that is 640.' },
        { type: 'mc', q: 'Which mode suits an SSH private key or a .env file with passwords?', choices: ['777', '755', '644', '600'], answer: 3, explain: 'Owner read/write, nobody else.' },
        { type: 'mc', q: 'What does the x bit mean on a directory?', choices: ['You can run it as a program', 'You can enter it and reach the files inside', 'You can delete it', 'Nothing'], answer: 1, explain: 'Without x on every parent directory, even a 644 file is unreachable.' },
        { type: 'mc', q: 'What is wrong with `sudo usermod -G docker alice`?', choices: ['Nothing', 'Without -a it replaces all of alice\'s groups, possibly removing sudo', 'usermod cannot change groups', 'It needs chmod first'], answer: 1, explain: 'Use -aG to append.' },
        { type: 'mc', q: 'Uploads fail with "permission denied" after a deploy. Best fix?', choices: ['sudo chmod -R 777 /srv', 'Find which user the app runs as and give that user write access to the upload folder only', 'Run the app as root', 'Delete the folder'], answer: 1, explain: 'Least privilege: grant exactly what is needed.' },
        { type: 'predict', q: 'What happens?', code: '$ sudo echo "127.0.0.1 api.local" > /etc/hosts', choices: ['The line is written to /etc/hosts', 'Permission denied: the redirect runs in your shell, not as root', 'sudo asks which file to use', 'The file is deleted'], answer: 1, explain: 'Use: echo … | sudo tee -a /etc/hosts' },
        { type: 'type', q: 'Type the command that gives the user www-data ownership (user and group www-data) of /var/www/site and everything inside.', accept: ['sudo chown -R www-data:www-data /var/www/site', 'chown -R www-data:www-data /var/www/site', 'sudo chown -R www-data: /var/www/site'], model: 'sudo chown -R www-data:www-data /var/www/site', explain: '-R recursive, user:group.' },
        { type: 'tf', q: 'Running commands with sudo is safer than logging in as root, partly because each command is logged under your own name.', answer: true, explain: 'Accountability plus a smaller window of root power.' },
      ],
    },
    {
      id: 'pipes-text',
      title: 'Pipes, redirects and text tools',
      summary: 'stdin/stdout/stderr, |, >, >>, 2>&1, grep, awk, sort, uniq -c, cut, wc, sed: log analysis.',
      minutes: 25,
      lab: {
        cwd: '~/logs',
        panels: ['files'],
        setup(H) { H.write('laptop', '/home/dev/logs/access.log', LOG, { owner: 'dev' }); },
        suggestions: ['head -n 3 access.log', 'wc -l access.log'],
        tasks: [
          { title: 'Look at the first 3 lines to learn the format', detail: 'Fields: client IP, -, -, [time], "METHOD path protocol", **status** (field 9), bytes, referrer, user agent.', solution: 'head -n 3 access.log', check: t => t.ran(/\bhead\b.*access\.log/) },
          { title: 'How many requests are in the log?', solution: 'wc -l access.log', check: t => t.ran(/\bwc\b.*-l/) },
          { title: `Count the requests that returned **500**, and append the line \`500s: <number>\` to \`~/report.txt\``, hint: "`awk '$9 == 500' access.log | wc -l` (status is field 9). Then `echo \"500s: N\" >> ~/report.txt`.", solution: `echo "500s: $(awk '$9 == 500' access.log | wc -l)" >> ~/report.txt`, check: t => new RegExp(`500s:\\s*${COUNT_500}\\b`).test(t.file('laptop', '/home/dev/report.txt') || '') },
          { title: 'Find the IP that sent the most `POST /login` requests; append `attacker: <ip>` to the report', hint: "grep 'POST /login', then awk '{print $1}' | sort | uniq -c | sort -rn | head -1", solution: `echo "attacker: $(grep 'POST /login' access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')" >> ~/report.txt`, check: t => /attacker:\s*203\.0\.113\.77\b/.test(t.file('laptop', '/home/dev/report.txt') || '') },
          { title: 'Which path produced the most 500 errors? Append `worst path: <path>`', hint: "awk '$9 == 500 {print $7}' access.log | sort | uniq -c | sort -rn", solution: `echo "worst path: $(awk '$9 == 500 {print $7}' access.log | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')" >> ~/report.txt`, check: t => /worst path:\s*\/api\/checkout\b/.test(t.file('laptop', '/home/dev/report.txt') || '') },
          { title: 'Save every line from the attacker into `attacker.log` (for the security team)', solution: "grep '^203.0.113.77 ' access.log > attacker.log", check: t => { const f = t.file('laptop', '/home/dev/logs/attacker.log') || ''; const ls = f.trim().split('\n').filter(Boolean); return ls.length === ATTACKER_LINES && ls.every(l => l.startsWith('203.0.113.77 ')); } },
          { title: 'How many distinct client IPs were there? Append `clients: <number>`', hint: "awk '{print $1}' access.log | sort -u | wc -l", solution: `echo "clients: $(awk '{print $1}' access.log | sort -u | wc -l)" >> ~/report.txt`, check: t => new RegExp(`clients:\\s*${CLIENTS}\\b`).test(t.file('laptop', '/home/dev/report.txt') || '') },
          { title: 'Print the finished report', solution: 'cat ~/report.txt', check: t => t.ran(/\bcat\b.*report\.txt/) && (t.file('laptop', '/home/dev/report.txt') || '').trim().split('\n').length >= 4 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'In `cmd1 | cmd2`, what does cmd2 receive?', choices: ['cmd1\'s errors', 'cmd1\'s standard output', 'cmd1\'s exit code', 'Nothing until cmd1 is killed'], answer: 1, explain: 'stdout flows through the pipe; stderr still goes to the screen.' },
        { type: 'predict', q: 'What does this print?', code: "$ printf 'b\\na\\nb\\n' | uniq -c", choices: ['2 b, 1 a', '1 b, 1 a, 1 b', '1 a, 2 b', 'an error'], answer: 1, explain: 'uniq only merges adjacent duplicates. Sort first.' },
        { type: 'order', q: 'Order the stages to find the top 3 client IPs in access.log.', items: ["awk '{print $1}' access.log", 'sort', 'uniq -c', 'sort -rn', 'head -3'], explain: 'Extract, group, count, rank, cut.' },
        { type: 'mc', q: 'Which keeps both normal output and errors of deploy.sh in deploy.log?', choices: ['./deploy.sh > deploy.log', './deploy.sh 2> deploy.log', './deploy.sh > deploy.log 2>&1', './deploy.sh | deploy.log'], answer: 2, explain: '2>&1 sends stderr wherever stdout goes.' },
        { type: 'mc', q: 'What is wrong with `sort data.txt > data.txt`?', choices: ['Nothing', 'The shell truncates data.txt before sort reads it: you lose the data', 'sort cannot write files', 'It sorts in reverse'], answer: 1, explain: 'Write to a new file, then move it, or use sort -o.' },
        { type: 'mc', q: '`sort` puts 10 before 9. Why?', choices: ['A bug', 'It sorts as text by default; use sort -n', '10 is smaller', 'It sorts by file size'], answer: 1, explain: 'Text order compares character by character.' },
        { type: 'type', q: 'Type a command that counts the lines containing "ERROR" in app.log.', accept: ['grep -c ERROR app.log', 'grep -c "ERROR" app.log', "grep -c 'ERROR' app.log", 'grep ERROR app.log | wc -l', 'grep "ERROR" app.log | wc -l'], model: 'grep -c ERROR app.log', explain: '-c counts instead of printing.' },
        { type: 'type', q: 'Type the sed command that replaces every "staging" with "production" in config.yml, in place.', accept: ["sed -i 's/staging/production/g' config.yml", 'sed -i "s/staging/production/g" config.yml'], model: "sed -i 's/staging/production/g' config.yml", explain: '-i edits the file; g replaces every match on a line.' },
      ],
    },
    {
      id: 'processes',
      title: 'Processes, signals and jobs',
      summary: 'ps, top, load average, kill (TERM before KILL), background jobs and exit codes.',
      minutes: 18,
      lab: {
        cwd: '~',
        panels: ['system'],
        setup(H) {
          const lap = H.laptop;
          lap.cpus = 4;
          H.load('laptop', [3.97, 3.62, 2.10]);
          H.write('laptop', '~/tools/report.py', '# nightly report (has a bug: never stops)\nwhile True:\n    crunch()\n', { owner: 'dev' });
          const p = H.proc('laptop', { cmd: 'python3 /home/dev/tools/report.py', user: 'dev', mem: 310, cpu: 98.7, state: 'R' });
          p.ignoreTerm = true;
          H.proc('laptop', { cmd: '/usr/lib/firefox/firefox', user: 'dev', mem: 820, cpu: 2.1 });
          H.proc('laptop', { cmd: '/usr/bin/code --type=renderer', user: 'dev', mem: 410, cpu: 1.2 });
          H.uni.labData.runaway = p.pid;
        },
        events(ev, t) {
          if (ev.type === 'kill' && ev.ignored) t.say(`[system] process ${ev.pid} received SIGTERM but is stuck in a tight loop and did not exit.`);
          if (ev.type === 'proc-exit' && ev.pid === t.uni.labData.runaway) t.host('laptop').loadAvg = [0.42, 1.9, 1.8];
        },
        suggestions: ['uptime', 'ps aux --sort=-%cpu | head -5'],
        tasks: [
          { title: 'Check the load average (and compare it with the CPU count from `nproc`)', solution: 'uptime && nproc', check: t => t.ran(/\b(uptime|top|htop)\b/) },
          { title: 'Find the process using the most CPU', hint: '`ps aux --sort=-%cpu | head -5`, or `top`.', solution: 'ps aux --sort=-%cpu | head -5', check: t => t.ran(/\bps\b.*(--sort|aux)|^top\b|^htop\b/) },
          { title: 'Get its PID by name with `pgrep -a report`', solution: 'pgrep -a report', check: t => t.ran(/\bpgrep\b.*report/) },
          { title: 'Ask it to stop politely: `kill <PID>` (SIGTERM)', solution: 'kill $(pgrep -f report.py)', test: [t => `kill ${t.uni.labData.runaway}`], check: t => t.events('kill').some(e => e.pid === t.uni.labData.runaway && e.signal === 'TERM') },
          { title: 'It is stuck and ignored SIGTERM. Confirm it still runs, then force it with SIGKILL', solution: 'pgrep -a report && kill -9 $(pgrep -f report.py)', test: [t => `pgrep -a report`, t => `kill -9 ${t.uni.labData.runaway}`], check: t => !t.host('laptop').procs.has(t.uni.labData.runaway) && t.events('kill').some(e => e.signal === 'KILL') },
          { title: 'Start `sleep 600` in the background, then list your jobs', solution: 'sleep 600 & jobs', test: ['sleep 600 &', 'jobs'], check: t => t.procs('laptop', /^sleep 600/).length > 0 && t.ran(/^jobs\b/) },
          { title: 'See an exit code: run a command that fails, then `echo $?`', solution: 'ls /nonexistent; echo $?', check: t => t.ran(/echo\s+\$\?/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What is the difference between `kill PID` and `kill -9 PID`?', choices: ['None', 'The first sends SIGTERM (clean shutdown), the second SIGKILL (immediate, no cleanup)', 'The second is for root only', 'The first pauses the process'], answer: 1, explain: 'Always try TERM first.' },
        { type: 'mc', q: 'A server with 4 CPUs has a load average of 3.9. What does that suggest?', choices: ['Idle', 'Busy: nearly all CPUs are in use', 'Broken', 'Out of disk'], answer: 1, explain: 'Compare load with the CPU count.' },
        { type: 'predict', q: 'What is printed?', code: '$ ls /nope 2>/dev/null\n$ echo $?', choices: ['0', 'A non-zero number', 'Nothing', '/nope'], answer: 1, explain: 'A failed command returns a non-zero exit code.' },
        { type: 'predict', q: 'What is printed?', code: '$ false && echo A || echo B', choices: ['A', 'B', 'A and B', 'Nothing'], answer: 1, explain: 'false fails, so && skips A and || runs B.' },
        { type: 'mc', q: 'Why prefer `pgrep -a name` to `ps aux | grep name`?', choices: ['It is faster to type and does not match itself', 'grep is deprecated', 'ps cannot show names', 'pgrep kills the process'], answer: 0, explain: 'ps | grep also lists the grep process.' },
        { type: 'multi', q: 'A runaway nightly job filled the CPU. What belongs in the follow-up?', choices: ['Kill it (TERM, then KILL if needed)', 'Find why it looped and fix the bug', 'Stop the schedule from starting it again until fixed', 'Reboot the server every night'], answer: [0, 1, 2], explain: 'Mitigate, then fix the cause.' },
        { type: 'type', q: 'Type the command that sends SIGHUP to process 2231 (often "reload your config").', accept: ['kill -HUP 2231', 'kill -1 2231', 'kill -SIGHUP 2231', 'kill -s HUP 2231'], model: 'kill -HUP 2231', explain: 'nginx and many daemons reload on HUP.' },
      ],
    },
    {
      id: 'packages-env',
      title: 'Packages, PATH and the environment',
      summary: 'apt, which and PATH, export, .bashrc, and configuration through environment variables.',
      minutes: 20,
      lab: {
        cwd: '~',
        panels: ['files', 'system'],
        setup(H) {
          H.write('laptop', '~/tools/healthcheck.sh', HEALTHCHECK, { owner: 'dev', mode: 0o755 });
          H.site('api.lumen.example.com', { '/health': { body: JSON.stringify({ status: 'ok', version: '2.3.1' }) + '\n' } });
        },
        suggestions: ['bash ~/tools/healthcheck.sh', 'cat ~/tools/healthcheck.sh'],
        tasks: [
          { title: 'Run the teammate\'s script and read the error: `bash ~/tools/healthcheck.sh`', solution: 'bash ~/tools/healthcheck.sh', check: t => t.ran(/healthcheck/) },
          { title: 'It needs `API_URL`. Export it as `https://api.lumen.example.com` and run the script again', solution: 'export API_URL=https://api.lumen.example.com && bash ~/tools/healthcheck.sh', check: t => t.sh.e.vars.get('API_URL')?.exported && /api\.lumen\.example\.com/.test(t.sh.e.vars.get('API_URL').value) && hist(t, /healthcheck/) >= hist(t, /export\s+API_URL/) },
          { title: 'Now `jq` is missing. Install it with apt (refresh the package list first)', solution: 'sudo apt update && sudo apt install -y jq', check: t => t.pkg('laptop', 'jq') },
          { title: 'Run the script again: it should print `API status: ok`', solution: 'bash ~/tools/healthcheck.sh', check: t => t.after(e => e.type === 'pkg-install' && e.pkg === 'jq', e => e.type === 'http' && /api\.lumen\.example\.com\/health/.test(e.url) && e.status === 200) },
          { title: 'Make it a command: copy it to `~/bin/healthcheck` and make sure it is executable', solution: 'mkdir -p ~/bin && cp ~/tools/healthcheck.sh ~/bin/healthcheck && chmod +x ~/bin/healthcheck', check: t => t.exists('laptop', '/home/dev/bin/healthcheck') && (t.mode('laptop', '/home/dev/bin/healthcheck') & 0o100) },
          { title: 'Add `~/bin` to your PATH permanently in `~/.bashrc`, and reload it', hint: `echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`, solution: `echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`, check: t => /PATH=.*(\$HOME|~|\/home\/dev)\/bin/.test(t.file('laptop', '/home/dev/.bashrc') || '') && (t.sh.e.vars.get('PATH')?.value || '').split(':').includes('/home/dev/bin') },
          { title: 'Make `API_URL` permanent in `~/.bashrc` too', solution: `echo 'export API_URL=https://api.lumen.example.com' >> ~/.bashrc`, check: t => /export\s+API_URL=https:\/\/api\.lumen\.example\.com/.test(t.file('laptop', '/home/dev/.bashrc') || '') },
          { title: 'Run it by name from anywhere: `healthcheck`', solution: 'cd / && healthcheck', check: t => t.ran(/(^|&&\s*|;\s*)healthcheck\s*$/) && t.events('http').filter(e => /api\.lumen\.example\.com\/health/.test(e.url) && e.status === 200).length >= 2 },
        ],
      },
      quiz: [
        { type: 'mc', q: 'What does the shell do with PATH when you type `jq`?', choices: ['Downloads jq', 'Searches the listed directories, in order, for an executable called jq', 'Looks in the current folder only', 'Asks apt'], answer: 1, explain: '`which jq` shows the one it found.' },
        { type: 'mc', q: 'What is the difference between `NAME=x` and `export NAME=x`?', choices: ['None', 'export makes it part of the environment, inherited by programs you start', 'export makes it permanent across reboots', 'export only works for root'], answer: 1, explain: 'Permanent means writing it in a file like ~/.bashrc.' },
        { type: 'predict', q: 'What happens after this?', code: '$ export PATH=$HOME/bin\n$ ls', choices: ['ls works normally', 'ls: command not found, because PATH lost /usr/bin', 'It lists ~/bin', 'An error at export'], answer: 1, explain: 'Always append: export PATH="$HOME/bin:$PATH".' },
        { type: 'mc', q: 'You added a line to ~/.bashrc. How do you apply it to the current shell?', choices: ['Nothing, it is automatic', 'source ~/.bashrc', 'chmod +x ~/.bashrc', 'apt update'], answer: 1, explain: 'New shells read it automatically.' },
        { type: 'mc', q: 'Why do apps read settings like DATABASE_URL from the environment?', choices: ['It is faster', 'The same code runs in dev, staging and production with different settings, and secrets stay out of the code', 'Files are not allowed', 'Environment variables are encrypted'], answer: 1, explain: 'The Twelve-Factor principle: config in the environment.' },
        { type: 'tf', q: '`sudo apt install nginx` without `sudo apt update` first may install an outdated version or fail to find the package.', answer: true, explain: 'update refreshes the package lists.' },
        { type: 'type', q: 'Type the command that runs ./server.sh with PORT set to 9000 for that one command only.', accept: ['PORT=9000 ./server.sh'], model: 'PORT=9000 ./server.sh', explain: 'The variable applies only to that command.' },
      ],
    },
    {
      id: 'disks-mounts',
      title: 'Disks, filesystems and mounts',
      summary: 'Bytes versus inodes (df -h, df -i), cleaning safely with find -delete, block devices (lsblk, blkid), mkfs, mounting, cp -a, /etc/fstab by UUID with nofail, testing with mount -a, rebooting safely.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['system', 'files'],
        systemHost: 'web1',
        setup(H) {
          H.server('web1');
          H.authorize('laptop', 'dev', 'web1', 'ubuntu');
          H.console('web1');
          H.disk('web1', { name: 'xvdf', sizeGB: 50 });
          const g = H.disk('web1', { name: 'xvdg', sizeGB: 1, fs: 'ext4', mount: '/var/cache/thumbs' });
          H.user('web1', 'www-data');
          for (let i = 0; i < 1000; i++) { H.write('web1', `/var/cache/thumbs/t${i}.png`, 'PNG'.repeat(60), { owner: 'www-data' }); if (i < 900) H.age('web1', `/var/cache/thumbs/t${i}.png`, 20 + (i % 60)); }
          g.inodes = 1012;
          for (const [f, gb] of [['2025-q1.tar', 6], ['2025-q2.tar', 7], ['2025-q3.tar', 8]]) { H.write('web1', `/var/www/uploads/${f}`, '', { owner: 'www-data' }); H.fakeSize('web1', `/var/www/uploads/${f}`, gb * GB); }
          H.write('web1', '/var/www/uploads/logo.png', 'PNG logo', { owner: 'www-data' });
          for (let k = 0; k < 4; k++) H.log('web1', 'thumbs.service', `Error: ENOSPC: no space left on device, open '/var/cache/thumbs/t${1000 + k}.png'`, { prio: 'err', ago: 60 * (4 - k) });
        },
        suggestions: ['ssh ubuntu@web1', 'df -h'],
        tasks: [
          { title: 'On `web1`, thumbnails fail with "no space left on device" (`journalctl -u thumbs`), yet `df -h` shows plenty of space. Find out what is really full', hint: 'A filesystem can also run out of inodes: `df -i`.', solution: 'df -h && df -i', test: ['ssh ubuntu@web1', 'journalctl -u thumbs -n 5', 'df -h', 'df -i'], check: t => t.events('df').some(e => e.host === 'web1' && e.inodes) },
          { title: 'Free the inodes without touching recent thumbnails: delete the files in `/var/cache/thumbs` older than 7 days', hint: '`sudo find /var/cache/thumbs -type f -mtime +7 -delete` (preview it first without -delete).', solution: 'sudo find /var/cache/thumbs -type f -mtime +7 | wc -l && sudo find /var/cache/thumbs -type f -mtime +7 -delete && df -i /var/cache/thumbs', check: t => thumbsInodes(t) < 0.5 && t.exists('web1', '/var/cache/thumbs/t999.png') && t.exists('web1', '/var/cache/thumbs/t950.png') },
          { title: 'A new 50 GB volume is attached to web1. Find it with `lsblk`, and create an ext4 filesystem on it', hint: 'It is the 50G disk with no partitions and no mount point. Double-check the name before mkfs: it erases.', solution: 'lsblk && sudo mkfs.ext4 /dev/xvdf', check: t => t.events('lsblk').some(e => e.host === 'web1') && t.dev('web1', 'xvdf')?.fs === 'ext4' && !!thumbsDev(t) },
          { title: 'Mount it at `/srv/uploads` and copy the uploads from `/var/www/uploads` there, keeping owners and times', solution: 'sudo mkdir -p /srv/uploads && sudo mount /dev/xvdf /srv/uploads && sudo cp -a /var/www/uploads/. /srv/uploads/ && ls -l /srv/uploads && df -h /srv/uploads', check: t => t.mountedAt('web1', '/srv/uploads')?.dev === 'xvdf' && t.owner('web1', '/srv/uploads/logo.png') === 'www-data' && t.exists('web1', '/srv/uploads/2025-q3.tar') },
          { title: 'Make it permanent: add `/srv/uploads` to `/etc/fstab` by UUID, with `nofail`. Prove the entry works before any reboot: unmount, then `mount -a`', hint: '`echo "UUID=$(sudo blkid -s UUID -o value /dev/xvdf) /srv/uploads ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab`, then `sudo umount /srv/uploads && sudo mount -a && findmnt /srv/uploads`.', solution: 'echo "UUID=$(sudo blkid -s UUID -o value /dev/xvdf) /srv/uploads ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab && sudo umount /srv/uploads && sudo mount -a && findmnt /srv/uploads', check: t => { const e = fstabUploads(t); return !!e && e.spec === `UUID=${uploadsUuid(t)}` && e.options.includes('nofail') && t.after(ev => ev.type === 'umount' && ev.mount === '/srv/uploads', ev => ev.type === 'mount' && ev.all && ev.ok) && t.mountedAt('web1', '/srv/uploads')?.dev === 'xvdf'; } },
          { title: 'Reboot web1 (`sudo reboot`), log back in, and check that `/srv/uploads` came back with the files', solution: 'sudo reboot', test: ['sudo reboot', 'ssh ubuntu@web1', 'findmnt /srv/uploads && ls /srv/uploads'], check: t => t.events('reboot').some(e => e.host === 'web1' && !e.emergency) && t.mountedAt('web1', '/srv/uploads')?.dev === 'xvdf' && t.exists('web1', '/srv/uploads/logo.png') },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Writes fail with "No space left on device" but `df -h` shows 3% used. What do you check next?', choices: ['The network', '`df -i`: the filesystem may be out of inodes', 'The CPU', 'Nothing: it is a bug'], answer: 1, explain: 'Every file needs an inode; tiny files can use them all.' },
        { type: 'mc', q: 'Why reference a volume by UUID in /etc/fstab?', choices: ['It is shorter', 'Device names like /dev/xvdf can change between boots or attachments; the UUID belongs to the filesystem', 'UUIDs are faster', 'fstab requires it'], answer: 1, explain: 'blkid prints it.' },
        { type: 'mc', q: 'What does `nofail` do in an fstab entry?', choices: ['Retries the mount forever', 'Lets the system boot normally even if this filesystem cannot be mounted', 'Prevents unmounting', 'Checks the disk'], answer: 1, explain: 'Without it, a missing data volume can drop the server into emergency mode.' },
        { type: 'tf', q: '`mkfs.ext4` on a device that holds data asks for confirmation and keeps the files.', answer: false, explain: 'It may warn, but it erases everything. Check lsblk twice.' },
        { type: 'mc', q: 'You wrote files into /srv/uploads, then mounted a new volume there. Where are those files now?', choices: ['Deleted', 'Hidden under the mount, still on the root filesystem; they reappear when you unmount', 'Moved to the new volume', 'In /tmp'], answer: 1, explain: 'A mount covers whatever was in the directory.' },
        { type: 'order', q: 'Order the steps to put a new data volume into service.', items: ['Identify it with lsblk', 'Create a filesystem (mkfs)', 'Mount it and copy the data (cp -a)', 'Add it to /etc/fstab by UUID with nofail', 'Test with umount + mount -a', 'Reboot when convenient and check'], explain: 'Test fstab before the reboot, not after.' },
        { type: 'type', q: 'Type the command that shows inode usage for every mounted filesystem.', accept: ['df -i', 'df -ih', 'df -hi', 'df --inodes'], model: 'df -i', explain: 'IUse% at 100% means no new files, whatever df -h says.' },
      ],
    },
    {
      id: 'performance',
      title: 'Performance troubleshooting',
      summary: 'The USE method; load average versus CPUs; vmstat (r, b, wa, si/so); iostat -x and pidstat/iotop; renice and ionice; strace -p; tcpdump; the OOM killer in dmesg.',
      minutes: 35,
      lab: {
        cwd: '~',
        panels: ['system', 'network'],
        systemHost: 'app1',
        setup(H) {
          H.server('app1', { cpus: 4 });
          H.server('db1', { packages: ['postgresql'] });
          H.authorize('laptop', 'dev', 'app1', 'ubuntu');
          H.authorize('laptop', 'dev', 'db1', 'ubuntu');
          H.install('app1', 'sysstat', 'strace', 'tcpdump');
          H.write('db1', '/etc/postgresql/16/main/postgresql.conf', "listen_addresses = '*'\nport = 5432\n");
          H.run('sudo systemctl restart postgresql && sudo ufw allow OpenSSH && sudo ufw enable', { on: 'db1' });
          H.proc('app1', { cmd: '/usr/bin/node /opt/shop/server.js', user: 'ubuntu', cpu: 22, mem: 180 });
          const tar = H.proc('app1', { cmd: 'tar czf /backup/uploads-2026-01-01.tgz /var/www/uploads', user: 'root', cpu: 35, mem: 40, state: 'D' });
          tar.io = { r: 128000, w: 41000 };
          const w = H.proc('app1', { cmd: '/usr/bin/node /opt/worker/worker.js', user: 'ubuntu', cpu: 0.1, mem: 95 });
          w.connectsTo = { host: 'db1', port: 5432, label: 'jobs db connect' };
          H.write('app1', '/etc/cron.d/backup', '# nightly backup of uploads (normally done by 06:00)\n0 2 * * * root tar czf /backup/uploads-$(date +\\%F).tgz /var/www/uploads\n');
          H.perf('app1', { load: [8.4, 6.9, 3.7], kernel: [{ msg: 'Out of memory: Killed process 3112 (report-gen) total-vm:2894112kB, anon-rss:2311020kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:5012kB oom_score_adj:0', ago: 8 * 3600 }, { msg: 'oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/report-gen.service,task=report-gen,pid=3112,uid=1000', ago: 8 * 3600 }] });
        },
        suggestions: ['ssh ubuntu@app1', 'uptime'],
        tasks: [
          { title: 'The shop on `app1` is slow. Get the big picture: load average against the number of CPUs, then what the CPUs are doing (`vmstat 1 5`)', solution: 'uptime && nproc && vmstat 1 5', test: ['ssh ubuntu@app1', 'uptime && nproc && vmstat 1 5'], check: t => t.events('perf').some(e => e.host === 'app1' && e.tool === 'vmstat') && t.ran(/\b(uptime|top|htop)\b/) && t.ran(/\b(nproc|lscpu)\b/) },
          { title: 'High I/O wait and blocked tasks point at the disk. Which device is saturated, and which process is doing the I/O?', hint: '`iostat -x` shows %util per device; `pidstat -d` or `sudo iotop -o` shows I/O per process.', solution: 'iostat -x && pidstat -d', check: t => t.events('perf').some(e => e.host === 'app1' && e.tool === 'iostat' && e.x) && t.events('perf').some(e => e.host === 'app1' && ((e.tool === 'pidstat' && e.io) || e.tool === 'iotop')) },
          { title: 'It is the nightly backup, running late into business hours. Do not kill it: put its I/O in the idle class and lower its CPU priority, then check the disk recovers', hint: '`sudo ionice -c3 -p PID` and `sudo renice -n 10 -p PID` (`pgrep -f "tar czf"` finds the PID).', solution: 'sudo ionice -c3 -p $(pgrep -f "tar czf") && sudo renice -n 10 -p $(pgrep -f "tar czf") && iostat -x', check: t => { const p = procOn(t, /tar czf/); return !!p && p.ioClass === 'idle' && (p.nice || 0) >= 10 && t.perfNow('app1').util < 50 && t.after(e => e.type === 'ionice', e => e.type === 'perf' && e.tool === 'iostat'); } },
          { title: 'Orders are piling up: the queue worker (`worker.js`) uses no CPU and logs nothing. Attach `strace` to it. What is it waiting for?', solution: 'sudo strace -p $(pgrep -f worker.js)', check: t => t.events('strace').some(e => e.host === 'app1' && /worker\.js/.test(e.cmd)) },
          { title: 'Confirm with `tcpdump` what happens to its packets to db1:5432, then fix db1\'s firewall so that only app1 may connect to PostgreSQL. The worker connects again', hint: 'SYNs with no reply: a firewall drops them. On db1: `sudo ufw allow from <app1 IP> to any port 5432` (`hostname -I` on app1 prints its IP).', solution: 'sudo tcpdump -n -i eth0 port 5432 -c 4; exit; ssh ubuntu@db1 "sudo ufw allow from 10.0.0.11 to any port 5432"', test: ['sudo tcpdump -n -i eth0 port 5432 -c 4', t => `exit`, t => `ssh ubuntu@db1 "sudo ufw allow from ${t.host('app1').ip} to any port 5432"`, 'ssh ubuntu@app1 "sudo tcpdump -n port 5432 -c 3"'], check: t => t.events('tcpdump').some(e => e.host === 'app1' && e.port === 5432) && !t.reach('app1', 'db1', 5432).error && t.fw('db1').rules.some(r => (r.port === 5432 || (r.ports || []).includes(5432)) && r.action === 'allow' && r.from && r.from !== 'any' && r.from !== '0.0.0.0/0') },
          { title: 'Last night the report generator died without a word in its own logs. Find out in the kernel log what killed it, and why', hint: '`sudo dmesg -T | grep -i kill`, or `journalctl -k`.', solution: 'sudo dmesg -T | grep -i -A1 killed', test: ['ssh ubuntu@app1', 'sudo dmesg -T | grep -i -A1 killed'], check: t => t.events('dmesg').some(e => e.host === 'app1') || t.ran(/journalctl\b.*(-k|--dmesg)/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Load average is 8 on a 4-CPU machine and the CPUs are 70% idle. What is most likely?', choices: ['CPU-bound work', 'Tasks waiting on I/O (disk or network filesystem), which count towards load', 'A broken clock', 'Too much free memory'], answer: 1, explain: 'Load counts runnable and uninterruptible (D state) tasks.' },
        { type: 'mc', q: 'In `vmstat`, which columns point to a disk bottleneck?', choices: ['us and sy', 'b (blocked) and wa (I/O wait)', 'si and so', 'in and cs'], answer: 1, explain: 'si/so mean swapping; r > CPUs means a CPU queue.' },
        { type: 'mc', q: '`iostat -x` shows xvda at 99.8% %util with await 400 ms. What next?', choices: ['Add CPUs', 'Find the process doing the I/O with pidstat -d or iotop', 'Restart the app', 'Increase swap'], answer: 1, explain: 'Device first, then process, then what it is doing.' },
        { type: 'mc', q: 'What does `ionice -c3 -p PID` do?', choices: ['Kills the process', 'Puts its disk I/O in the idle class, so it only uses the disk when nobody else needs it', 'Doubles its I/O speed', 'Pins it to CPU 3'], answer: 1, explain: 'renice does the same for CPU time.' },
        { type: 'predict', q: 'strace on a stuck worker repeats this. What is wrong?', code: 'connect(12, {sin_port=htons(5432), sin_addr=inet_addr("10.0.0.12")}, 16) = -1 EINPROGRESS\npoll([{fd=12, events=POLLOUT}], 1, 5000) = 0 (Timeout)', choices: ['The disk is full', 'It cannot reach port 5432 on 10.0.0.12: packets are probably dropped by a firewall', 'Out of memory', 'A syntax error'], answer: 1, explain: 'A refused port would return ECONNREFUSED immediately.' },
        { type: 'tf', q: 'In tcpdump, a SYN answered by RST means a firewall is silently dropping packets.', answer: false, explain: 'RST = nothing listens (refused). Silence after SYN = dropped.' },
        { type: 'mc', q: 'Where do you find out that the OOM killer ended a process?', choices: ['In the process\'s own log', 'In the kernel log: dmesg -T or journalctl -k', 'In /etc/fstab', 'In the shell history'], answer: 1, explain: 'The killed process gets no chance to log anything.' },
        { type: 'order', q: 'Order a USE-style investigation.', items: ['Whole machine: load, vmstat', 'Saturated resource: iostat / top / free', 'Responsible process: pidstat / iotop', 'What it does: strace / tcpdump', 'Fix with the least damage, then verify'], explain: 'Measure from the outside in, before changing anything.' },
      ],
    },
    {
      id: 'linux-boss',
      title: 'Boss: The full disk at 3 AM',
      summary: 'Free space safely on a production server: du, find -mtime, truncate vs rm, held-open files, the journal.',
      minutes: 25,
      boss: true,
      lab: {
        startOn: { host: 'web2', user: 'ubuntu' },
        cwd: '~',
        panels: ['system', 'files'],
        setup(H) {
          const w = H.server('web2', { diskGB: 40, diskUsedGB: 5.9 });
          H.install('web2', 'nodejs');
          H.user('web2', 'lumen', { shell: '/usr/sbin/nologin', noHome: true });
          H.mkdir('web2', '/opt/lumen/node_modules/express', { owner: 'lumen' });
          H.write('web2', '/opt/lumen/server.js', "const express = require('express');\nconst app = express();\napp.get('/health', (req, res) => res.json({ status: 'ok' }));\napp.listen(process.env.PORT || 3000, () => console.log('lumen api listening'));\n", { owner: 'lumen' });
          H.mkdir('web2', '/var/log/lumen', { owner: 'lumen' });
          H.fakeSize('web2', '/var/log/lumen/app.log', 9 * GB);
          H.write('web2', '/var/log/lumen/audit.log', 'security audit trail: keep for 1 year\n', { owner: 'lumen' });
          H.service('web2', 'lumen-api', '[Unit]\nDescription=Lumen API\nAfter=network.target\n\n[Service]\nUser=lumen\nWorkingDirectory=/opt/lumen\nExecStart=/usr/bin/node server.js\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n');
          for (const p of w.procs.values()) if (p.unit === 'lumen-api.service') p.openFiles = ['/var/log/lumen/app.log'];
          H.mkdir('web2', '/var/backups/db');
          for (let d = 0; d < 18; d++) {
            const day = new Date((H.uni.time - d * 2 * 86400) * 1000).toISOString().slice(0, 10);
            const p = `/var/backups/db/lumen-${day}.sql.gz`;
            H.fakeSize('web2', p, Math.round(1.1 * GB));
            H.age('web2', p, d * 2);
          }
          H.fakeSize('web2', '/var/log/journal/a1b2c3/system.journal', 0.3 * GB);
          for (let k = 1; k <= 6; k++) H.fakeSize('web2', `/var/log/journal/a1b2c3/system@00${k}.journal`, 0.6 * GB);
          H.uni.labData.webHost = 'web2';
        },
        events(ev, t) {
          if (ev.type === 'file-remove' && /\/var\/log\/lumen\/audit\.log$|\/var\/log\/lumen$/.test(ev.path)) t.say('[Security team] The audit log is gone? We need that for compliance. Deleting evidence is never the fix for a full disk.');
        },
        suggestions: ['df -h', 'sudo du -sh /var/* | sort -h'],
        tasks: [
          { title: 'Confirm the problem with `df -h`', solution: 'df -h', check: t => t.ran(/^df\b/) },
          { title: 'Find which top-level folders under /var are biggest', hint: '`sudo du -sh /var/* | sort -h` (sudo, because some folders are root-only).', solution: 'sudo du -sh /var/* | sort -h', check: t => t.ran(/\bdu\b.*\/var/) },
          { title: 'Drill down into the biggest ones (/var/log and /var/backups)', solution: 'sudo du -sh /var/log/* /var/backups/* | sort -h', check: t => t.ran(/\bdu\b.*\/var\/(log|backups)/) },
          { title: 'Empty the 9 GB `app.log` safely. The API holds it open, so truncate it instead of deleting it', hint: '`sudo truncate -s 0 /var/log/lumen/app.log`. (If you already deleted it: `sudo lsof +L1` shows who holds it; restart that service to release the space.)', solution: 'sudo truncate -s 0 /var/log/lumen/app.log', check: t => { const h = t.host('web2'); return !h.fakeSizes.has('/var/log/lumen/app.log') && ![...h.procs.values()].some(p => p.deletedOpen?.length); } },
          { title: 'Delete database backups older than 7 days. Preview first, then delete', hint: '`find /var/backups/db -name "*.sql.gz" -mtime +7` lists them; add `-delete` once the list looks right (with sudo).', solution: 'sudo find /var/backups/db -name "*.sql.gz" -mtime +7 && sudo find /var/backups/db -name "*.sql.gz" -mtime +7 -delete', check: t => { const h = t.host('web2'); const left = [...h.files.keys()].filter(p => p.startsWith('/var/backups/db/')); return left.length >= 4 && left.every(p => (t.uni.time - h.stat(p).mtime) / 86400 <= 8) && t.ran(/\bfind\b[^&;|]*-mtime\s*\+7(?![^&;|]*-delete)/); } },
          { title: 'Shrink the systemd journal to 500M', solution: 'sudo journalctl --vacuum-size=500M', check: t => [...t.host('web2').fakeSizes].filter(([p]) => p.startsWith('/var/log/journal/')).reduce((s, [, n]) => s + n, 0) <= 0.6 * GB },
          { title: 'Verify: the disk is now below 80%', solution: 'df -h', check: t => { const h = t.host('web2'); return h.diskUsedGB / h.diskGB < 0.8 && hist(t, /^df\b/) > hist(t, /vacuum|truncate|-delete/); } },
          { title: 'Leave a note for the morning in `~/incident-notes.md`: what filled the disk and what you did', hint: 'Mention the app log and the backups; suggest log rotation and a backup retention policy.', solution: 'echo "web2 disk 97%: app.log 9G (truncated; needs logrotate), 18 DB backups (deleted >7 days; needs retention), journal vacuumed to 500M." > ~/incident-notes.md', check: t => { const f = t.file('web2', '/home/ubuntu/incident-notes.md') || ''; return /app\.log|log/i.test(f) && /backup/i.test(f); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'You deleted a 9 GB log with rm, but df still shows the disk full. Why?', choices: ['df is cached for an hour', 'A running process still holds the file open, so its space is not freed until it closes it', 'rm only moves files', 'The filesystem is corrupt'], answer: 1, explain: 'lsof +L1 finds such files; restart the process or truncate instead.' },
        { type: 'mc', q: 'Which empties a log that a running service is writing to, freeing the space immediately?', choices: ['rm app.log', 'truncate -s 0 app.log', 'mv app.log /tmp', 'chmod 000 app.log'], answer: 1, explain: 'Same file, zero length; the process keeps writing to it.' },
        { type: 'mc', q: 'What does `find /var/backups -mtime +7` list?', choices: ['Files modified in the last 7 days', 'Files modified more than 7 days ago', 'Exactly 7 files', 'Files bigger than 7 MB'], answer: 1, explain: '+N older than N days, -N newer.' },
        { type: 'order', q: 'Order a safe response to a full disk.', items: ['Confirm with df -h', 'Find what is big with du', 'Remove or shrink only what is safe', 'Verify with df -h', 'Write down the cause and a lasting fix (rotation, retention)'], explain: 'Measure, act narrowly, verify, prevent.' },
        { type: 'multi', q: 'Which are lasting fixes for this incident?', choices: ['logrotate for the app log', 'A retention policy that deletes old backups automatically', 'A disk-usage alert at 80%', 'sudo rm -rf /var/log every week'], answer: [0, 1, 2], explain: 'Prevention beats 3 a.m. heroics.' },
        { type: 'type', q: 'Type the command that shows the size of each item in the current folder, sorted from small to large.', accept: ['du -sh * | sort -h', 'du -sh ./* | sort -h', 'sudo du -sh * | sort -h'], model: 'du -sh * | sort -h', explain: 'sort -h understands human sizes like 2.1G.' },
      ],
    },
  ],
};
