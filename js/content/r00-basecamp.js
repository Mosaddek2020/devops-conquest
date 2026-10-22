// Realm 0 · Base Camp: what DevOps is, the delivery loop, and DevOps in the age of AI.

const RELEASES = Array.from({ length: 31 }, (_, k) => {
  const h = 8 + Math.floor(k / 3), m = (k * 17) % 60;
  const ver = `2026.01.01-${String(k + 1).padStart(2, '0')}`;
  const who = ['amira', 'jonas', 'priya', 'samir', 'lee'][k % 5];
  return `2026-01-01 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}  ${ver}  deployed by ${who}  (${3 + (k % 6)} min, ${k === 17 ? 'rolled back' : 'ok'})`;
}).join('\n') + '\n';

const FEATURE_LOG = `2026-01-05 09:12  idea     PM opens ticket #4521 "Add to calendar button"
2026-01-07 14:30  wait     ticket waits in the backlog
2026-01-12 10:02  code     developer starts coding
2026-01-13 17:45  code     pull request #812 opened
2026-01-13 17:46  wait     waiting for code review
2026-01-19 11:20  review   review done, two comments fixed
2026-01-19 15:00  wait     waiting for the next manual test cycle
2026-01-28 09:00  test     manual testing starts
2026-01-30 16:10  test     manual testing passed
2026-01-30 16:15  wait     waiting for the monthly release window
2026-02-21 22:00  release  release weekend starts
2026-02-23 03:40  deploy   deployed to production
2026-02-26 12:00  verify   feature verified, ticket closed
`;

const GB = 1073741824;
const hist = (t, re) => { let k = -1; t.history.forEach((l, i) => { if (re.test(l)) k = i; }); return k; };

export default {
  id: 'basecamp',
  n: 0,
  title: 'Base Camp',
  tagline: 'What DevOps is, the delivery loop, and AI as your co-pilot',
  badge: 'Base Camp Graduate',
  intro: 'Start here. Learn what **DevOps** really means (and what it does not), how software flows from an idea to users, and how **AI assistants** fit into modern operations work. Along the way you will type your first commands.',
  lessons: [
    {
      id: 'what-is-devops',
      title: 'What DevOps really is',
      summary: 'Culture, automation and fast feedback: CALMS, the Three Ways and the DORA metrics.',
      minutes: 15,
      lab: {
        cwd: '~',
        panels: ['files', 'network'],
        setup(H) {
          H.write('laptop', '~/welcome.txt', 'Welcome to Lumen Tickets!\n\nWe sell concert and theatre tickets online. Our platform team keeps\nlumen.example.com fast, safe and boringly reliable.\n\nThings to know:\n- We deploy many times a day (see releases.log).\n- You build it, you run it: teams own their services in production.\n- Blameless postmortems: we ask "what allowed this?", never "who did this?".\n\nYour first task: say hello to the terminal.\n', { owner: 'dev' });
          H.write('laptop', '~/releases.log', RELEASES, { owner: 'dev' });
          H.server('www');
          H.install('www', 'nginx');
          H.write('www', '/var/www/html/index.html', '<!doctype html>\n<title>Lumen Tickets</title>\n<h1>Lumen Tickets</h1>\n<p>Concerts, theatre and comedy near you.</p>\n');
          H.dns('lumen.example.com', 'www');
        },
        suggestions: ['pwd', 'ls', 'cat welcome.txt'],
        tasks: [
          { title: 'Find out where you are: type `pwd` and press Enter', hint: '`pwd` means "print working directory": the folder your terminal is in.', solution: 'pwd', check: t => t.ran(/^pwd\b/) },
          { title: 'List the files in this folder with `ls`', solution: 'ls', check: t => t.ran(/^ls\b/) },
          { title: 'Read the onboarding note with `cat welcome.txt`', hint: '`cat` prints a file. Tab completes file names: type `cat we` then press Tab.', solution: 'cat welcome.txt', check: t => t.ran(/\bcat\s+(~\/)?welcome\.txt/) },
          { title: 'Ask the company website if it is up: `curl http://lumen.example.com`', hint: '`curl` makes a web request from the terminal and prints what the server sends back.', solution: 'curl http://lumen.example.com', check: t => t.events('http').some(e => /lumen\.example\.com/.test(e.url) && e.status === 200) },
          { title: 'Show the three most recent deploys: `tail -n 3 releases.log`', hint: '`tail` shows the end of a file; `-n 3` asks for 3 lines.', solution: 'tail -n 3 releases.log', check: t => t.ran(/\btail\b.*releases\.log/) },
          { title: 'Count today\'s deploys: `wc -l releases.log` counts the lines', solution: 'wc -l releases.log', check: t => t.ran(/\bwc\b.*-l.*releases\.log|\bwc\b.*releases\.log.*-l/) },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Which statement best describes DevOps?', choices: ['A job title for people who maintain servers', 'A tool you install to automate deployments', 'Shared ownership of the whole journey from idea to production, using automation and fast feedback', 'A team that sits between developers and operations'], answer: 2, explain: 'DevOps is a way of working; tools and titles support it.' },
        { type: 'multi', q: 'Which are pillars of CALMS?', choices: ['Culture', 'Automation', 'Licensing', 'Measurement', 'Sharing'], answer: [0, 1, 3, 4], explain: 'Culture, Automation, Lean, Measurement, Sharing.' },
        { type: 'order', q: 'Put the Three Ways in order.', items: ['Flow: work moves quickly from idea to user', 'Feedback: problems are seen fast, close to their source', 'Continuous learning: experiment and improve every week'], explain: 'Flow first, then feedback loops, then a culture of learning.' },
        { type: 'multi', q: 'Which are DORA metrics?', choices: ['Deployment frequency', 'Lines of code per developer', 'Lead time for changes', 'Change failure rate', 'Time to restore service'], answer: [0, 2, 3, 4], explain: 'Lines of code measures activity, not outcomes.' },
        { type: 'tf', q: 'Research on DevOps shows that teams must choose between deploying often and being stable.', answer: false, explain: 'High performers are both fast and stable: small, automated changes are safer.' },
        { type: 'mc', q: 'A company creates a "DevOps team" that receives tickets from developers and passes them to operations. What is the risk?', choices: ['None, this is DevOps', 'It recreates the wall between dev and ops with a new name', 'It makes deploys too fast', 'It removes the need for testing'], answer: 1, explain: 'Handoffs and queues are exactly what DevOps tries to remove.' },
        { type: 'mc', q: 'What does "you build it, you run it" mean?', choices: ['Developers must buy their own servers', 'The team that writes a service also operates it in production', 'Operations teams write the code', 'Nobody is on call'], answer: 1, explain: 'Ownership creates feedback: you build things that are easier to run.' },
        { type: 'type', q: 'Type the command that prints the folder you are currently in.', accept: ['pwd'], model: 'pwd', explain: 'Print working directory.' },
      ],
    },
    {
      id: 'delivery-loop',
      title: 'The delivery loop and value stream',
      summary: 'Plan → code → build → test → release → deploy → operate → monitor, and why most lead time is waiting.',
      minutes: 15,
      lab: {
        cwd: '~',
        panels: ['files'],
        setup(H) { H.write('laptop', '~/feature-4521.log', FEATURE_LOG, { owner: 'dev' }); },
        suggestions: ['cat feature-4521.log'],
        tasks: [
          { title: 'Read the whole journey: `cat feature-4521.log`', solution: 'cat feature-4521.log', check: t => t.ran(/\bcat\b.*feature-4521\.log/) },
          { title: 'How many steps were recorded? Count the lines with `wc -l feature-4521.log`', solution: 'wc -l feature-4521.log', check: t => t.ran(/\bwc\b.*feature-4521\.log/) },
          { title: 'Show only the waiting steps: `grep wait feature-4521.log`', hint: '`grep word file` prints only the lines that contain the word.', solution: 'grep wait feature-4521.log', check: t => t.ran(/\bgrep\b.*\bwait\b.*feature-4521/) },
          { title: 'Count the waits instead of printing them: add `-c` to grep', solution: 'grep -c wait feature-4521.log', check: t => t.ran(/\bgrep\b.*-c.*wait|grep\b.*wait.*-c/) },
          { title: 'Which wait was the longest? Look at the dates, then append your answer to `findings.txt` with echo and `>>`', detail: 'For example: `echo "longest wait: the monthly release window (22 days)" >> findings.txt`', hint: '`>>` appends the output of a command to a file (and creates the file if needed).', solution: 'echo "longest wait: the monthly release window (22 days)" >> findings.txt', check: t => /release/i.test(t.file('laptop', '~/findings.txt') || '') },
          { title: 'Add one improvement idea to the same file, then print it with `cat findings.txt`', detail: 'For example: `echo "idea: deploy continuously instead of monthly" >> findings.txt`', solution: 'echo "idea: deploy continuously instead of monthly" >> findings.txt && cat findings.txt', check: t => (t.file('laptop', '~/findings.txt') || '').trim().split('\n').length >= 2 && t.ran(/\bcat\b.*findings\.txt/) },
        ],
      },
      quiz: [
        { type: 'order', q: 'Order the phases of the DevOps loop, starting with Plan.', items: ['Plan', 'Code', 'Build', 'Test', 'Release', 'Deploy', 'Operate', 'Monitor'], explain: 'And Monitor feeds back into Plan.' },
        { type: 'mc', q: 'A feature took 47 days to reach users but only 10 days of work. What is the best first move?', choices: ['Ask developers to code faster', 'Remove the biggest queues, such as the monthly release window', 'Hire more testers', 'Add more features per release'], answer: 1, explain: 'Most lead time was waiting; remove the waits.' },
        { type: 'mc', q: 'What is "lead time for changes"?', choices: ['Time a developer spends typing', 'Time from a code change to it running in production', 'Time between two releases', 'Time to write the plan'], answer: 1, explain: 'One of the four DORA metrics.' },
        { type: 'multi', q: 'Which practices shrink waiting in a value stream?', choices: ['Smaller batches of change', 'Limiting work in progress', 'Automating handoffs with pipelines', 'Bundling more changes into each release'], answer: [0, 1, 2], explain: 'Bigger batches make queues and risk worse.' },
        { type: 'tf', q: 'Monitoring is the end of the delivery process.', answer: false, explain: 'It is a loop: what you learn in production feeds the next plan.' },
        { type: 'predict', q: 'notes.txt does not exist. What does it contain after these two commands?', code: '$ echo "a" >> notes.txt\n$ echo "b" >> notes.txt', choices: ['Only b', 'a then b, on two lines', 'An error: the file does not exist', 'Only a'], answer: 1, explain: '`>>` creates the file if needed and appends.' },
        { type: 'type', q: 'Type the command that counts the lines of report.txt.', accept: ['wc -l report.txt', 'wc -l < report.txt', 'cat report.txt | wc -l'], model: 'wc -l report.txt', explain: 'wc = word count; -l = lines.' },
      ],
    },
    {
      id: 'ai-era',
      title: 'DevOps in the age of AI',
      summary: 'What AI assistants are good and bad at, hallucinations, and the verify-before-you-run habit.',
      minutes: 18,
      lab: {
        cwd: '~',
        panels: ['system', 'files'],
        setup(H) {
          const lap = H.laptop;
          lap.diskGB = 64; lap.baseDiskGB = 41;
          H.mkdir('laptop', '/home/dev/.cache', { owner: 'dev' });
          H.fakeSize('laptop', '/home/dev/.cache/pip/wheels.bin', 6 * GB);
          H.fakeSize('laptop', '/home/dev/.cache/npm/_cacache.bin', 9 * GB);
          for (const d of ['2025-10', '2025-11', '2025-12']) H.fakeSize('laptop', `/home/dev/logs/old/build-${d}.log`, 1 * GB);
          H.write('laptop', '~/logs/build-today.log', 'build 1 started\nbuild 1 failed: No space left on device\n', { owner: 'dev' });
          H.write('laptop', '~/projects/lumen-app/notes.md', '# WIP\nUncommitted design notes for the new seat picker. Not pushed anywhere yet!\n', { owner: 'dev' });
          H.write('laptop', '~/projects/lumen-app/seat-picker.js', 'export function pickSeat(row, col) {\n  // half-finished\n}\n', { owner: 'dev' });
          for (const p of ['/home/dev/.cache', '/home/dev/.cache/pip', '/home/dev/.cache/npm', '/home/dev/logs', '/home/dev/logs/old', '/home/dev/projects', '/home/dev/projects/lumen-app']) lap.setMeta(p, { owner: 'dev', group: 'dev' });
          H.uni.ai = {
            rules: [
              { id: 'disk', when: /disk|space|full|delete|clean/i, suggest: ['rm -rf ~/.cache ~/logs/* ~/projects/*'], reply: ['Your disk is nearly full. The fastest fix is to clear caches, logs and', 'old projects in one go:', '', '    rm -rf ~/.cache ~/logs/* ~/projects/*', '', 'That will free a lot of space immediately.'] },
            ],
          };
        },
        events(ev, t) {
          if (ev.type === 'file-remove' && /\/home\/dev\/projects(\/lumen-app)?$/.test(ev.path)) t.say('[Amira, team lead] Wait, ~/projects? Your seat-picker notes were not pushed anywhere. In real life they would be gone for good. (Here you can press "reset lab".)');
        },
        suggestions: ['df -h', 'ai "my disk is almost full, what can I delete?"'],
        tasks: [
          { title: 'Check how full the disk is: `df -h`', hint: '`df` shows disk free space; `-h` prints human-readable sizes (G, M).', solution: 'df -h', check: t => t.ran(/^df\b/) },
          { title: 'Ask the assistant for help: `ai "my disk is almost full, what can I delete?"`', solution: 'ai "my disk is almost full, what can I delete?"', check: t => t.events('ai-ask').some(e => e.rule === 'disk') },
          { title: 'Before running anything, have its command explained: `ai explain "rm -rf ~/.cache ~/logs/* ~/projects/*"`', hint: 'Read the risk lines. What does -r do? -f? What is in ~/projects?', solution: 'ai explain "rm -rf ~/.cache ~/logs/* ~/projects/*"', check: t => t.events('ai-explain').some(e => /rm\s+-rf/.test(e.cmd) && e.risk === 'HIGH') },
          { title: 'Measure first: see what actually uses the space with `du -sh ~/.cache ~/logs ~/projects`', hint: '`du` = disk usage; `-s` summarises each argument; `-h` human sizes.', solution: 'du -sh ~/.cache ~/logs ~/projects', check: t => t.ran(/\bdu\b/) },
          { title: 'Delete only what is safe: the caches (they re-download) and the old logs. Keep ~/projects and today\'s log', hint: 'Be specific: `rm -rf ~/.cache ~/logs/old`', solution: 'rm -rf ~/.cache ~/logs/old', check: t => !t.exists('laptop', '/home/dev/.cache') && !t.exists('laptop', '/home/dev/logs/old') && t.exists('laptop', '/home/dev/projects/lumen-app/notes.md') && t.exists('laptop', '/home/dev/logs/build-today.log') },
          { title: 'Verify the result with `df -h` again', solution: 'df -h', check: t => hist(t, /^df\b/) > hist(t, /\brm\b/) },
        ],
      },
      quiz: [
        { type: 'multi', q: 'Which tasks are AI assistants generally good at?', choices: ['Explaining an unfamiliar error message', 'Knowing which of your servers was patched last week', 'Drafting a script or runbook for you to review', 'Summarising a long log file'], answer: [0, 2, 3], explain: 'They do not know your systems\' current state or history.' },
        { type: 'mc', q: 'What is a "hallucination"?', choices: ['A bug in the terminal', 'A confident AI answer that is simply made up, like a flag that does not exist', 'An AI refusing to answer', 'A slow response'], answer: 1, explain: 'Confidence and correctness are unrelated.' },
        { type: 'order', q: 'Put the safe way to use an AI-suggested command in order.', items: ['Ask, with context', 'Read and understand every part', 'Test it somewhere safe', 'Apply it in a small step', 'Observe the result'], explain: 'The AI drafts, you decide.' },
        { type: 'mc', q: 'An AI suggests `sudo rm -rf /var/log/*` to fix a full disk on a production server. Best response?', choices: ['Run it: the AI is usually right', 'Find what is actually using space first, and remove only what is safe; logs may be needed for security and audits', 'Run it on all servers at once', 'Reboot the server instead'], answer: 1, explain: 'Measure, understand, then act narrowly. Logs can be evidence.' },
        { type: 'multi', q: 'Which should never go into a prompt for a public AI tool?', choices: ['Database passwords', 'API tokens', 'Customer personal data', 'The text of a public error message from an open-source tool'], answer: [0, 1, 2], explain: 'Secrets and personal data leak; a generic error message is fine.' },
        { type: 'tf', q: 'If you can use an AI assistant, you no longer need to understand Linux fundamentals.', answer: false, explain: 'You cannot verify what you do not understand.' },
        { type: 'mc', q: 'An AI agent will be allowed to run commands on servers. Which safeguard matters most?', choices: ['A friendly name', 'Least privilege plus human approval for risky actions, with an audit log', 'Letting it use the root password so it never fails', 'Turning off logging to save space'], answer: 1, explain: 'Limit what it can do, approve what is risky, record what it did.' },
      ],
    },
    {
      id: 'basecamp-boss',
      title: 'Boss: First day at Lumen',
      summary: 'Investigate a "checkout is broken" report with evidence, follow a runbook, and write a clear incident note.',
      minutes: 20,
      boss: true,
      lab: {
        cwd: '~',
        panels: ['files', 'network'],
        setup(H) {
          H.site('status.lumen.example.com', { '/api': { body: JSON.stringify({ web: 'operational', search: 'operational', checkout: 'degraded', since: '2026-01-01T08:41:00Z' }, null, 2) + '\n' }, '/': { body: '<h1>Lumen status</h1><p>Checkout: degraded</p>' } });
          H.site('lumen.example.com', { '/': { body: '<h1>Lumen Tickets</h1>' }, '/checkout/health': { status: 503, body: JSON.stringify({ status: 'unhealthy', dependency: 'paystream-payments', error: 'timeout after 5000ms' }) + '\n' } });
          H.site('status.paystream.example.com', { '/': { body: 'Paystream status\n\nEU region: PARTIAL OUTAGE since 08:35 UTC.\nCard payments may time out. Our engineers are working on it.\n' } });
          H.write('laptop', '~/docs/onboarding.md', '# Onboarding\n\nRunbooks live in ~/docs/runbooks/.\n', { owner: 'dev' });
          H.write('laptop', '~/docs/runbooks/search-runbook.md', '# Search runbook\n\n1. Check https://lumen.example.com/search/health\n', { owner: 'dev' });
          H.write('laptop', '~/docs/runbooks/checkout-runbook.md', '# Checkout runbook\n\nIf checkout is degraded:\n\n1. Check the checkout health endpoint:\n   https://lumen.example.com/checkout/health\n2. If it names a dependency, check that dependency\'s status page.\n   Payment provider (Paystream): https://status.paystream.example.com\n3. Write an incident note with: what is broken, the evidence\n   (status codes, error messages), and the suspected cause.\n', { owner: 'dev' });
          for (const p of ['/home/dev/docs', '/home/dev/docs/runbooks']) H.laptop.setMeta(p, { owner: 'dev', group: 'dev' });
        },
        suggestions: ['curl -s https://status.lumen.example.com/api'],
        tasks: [
          { title: 'Check Lumen\'s status API: `curl -s https://status.lumen.example.com/api`', solution: 'curl -s https://status.lumen.example.com/api', check: t => t.events('http').some(e => /status\.lumen\.example\.com/.test(e.url) && e.status === 200) },
          { title: 'Find the checkout runbook somewhere under your home folder', hint: '`find ~ -name "*checkout*"` searches by name. Quote the pattern.', solution: 'find ~ -name "*checkout*"', check: t => t.ran(/\bfind\b.*checkout|\bfind\b.*runbook|ls\b.*runbooks/) },
          { title: 'Read the runbook', solution: 'cat ~/docs/runbooks/checkout-runbook.md', check: t => t.ran(/\b(cat|less|more|head|tail)\b.*checkout-runbook/) },
          { title: 'Follow step 1 and record what the health endpoint says (status code and error)', hint: '`curl -i` shows the status line too.', solution: 'curl -i https://lumen.example.com/checkout/health', check: t => t.events('http').some(e => /checkout\/health/.test(e.url) && e.status === 503) },
          { title: 'Follow step 2: check the status page of the dependency it names', solution: 'curl https://status.paystream.example.com', check: t => t.events('http').some(e => /status\.paystream\.example\.com/.test(e.url)) },
          { title: 'Write `~/incident.md`: what is broken, the evidence (the 503 and the error) and the suspected cause', hint: 'Use `nano ~/incident.md` and save with Ctrl+S, or several `echo "…" >> ~/incident.md` lines.', solution: 'echo "Checkout degraded. /checkout/health returns 503: timeout after 5000ms calling paystream-payments. Paystream reports a partial outage in the EU since 08:35 UTC. Suspected cause: payment provider outage." > ~/incident.md', check: t => { const f = t.file('laptop', '~/incident.md') || ''; return /checkout/i.test(f) && /503/.test(f) && /paystream|payment/i.test(f); } },
        ],
      },
      quiz: [
        { type: 'mc', q: 'Your first day, an incident starts and the experts are busy. What is most useful?', choices: ['Restart every server', 'Collect evidence calmly and write a clear note: what is broken, the evidence, the suspected cause', 'Stay quiet until someone asks', 'Ask an AI to fix production for you'], answer: 1, explain: 'Clear evidence speeds everyone up.' },
        { type: 'mc', q: 'What does HTTP status 503 mean?', choices: ['Not found', 'Service unavailable (often a dependency or overload problem)', 'Permission denied', 'Everything is fine'], answer: 1, explain: '5xx means the server side failed; 503 means it cannot serve right now.' },
        { type: 'multi', q: 'Which belong in a good incident note?', choices: ['What is broken, from the user\'s point of view', 'The evidence: status codes, error messages, times', 'The suspected cause and what you checked', 'Who is to blame'], answer: [0, 1, 2], explain: 'Blameless: facts, not fault.' },
        { type: 'type', q: 'Type a command that finds files whose names contain "backup" anywhere under your home folder.', accept: ['find ~ -name "*backup*"', "find ~ -name '*backup*'", 'find ~/ -name "*backup*"', 'find $HOME -name "*backup*"', 'find ~ -iname "*backup*"'], model: 'find ~ -name "*backup*"', explain: 'Quote the pattern so the shell does not expand it first.' },
        { type: 'mc', q: 'Which DORA metric does a runbook mostly improve?', choices: ['Deployment frequency', 'Time to restore service', 'Lines of code', 'Lead time for changes'], answer: 1, explain: 'Good runbooks shorten recovery.' },
        { type: 'tf', q: '"You build it, you run it" means teams own their services in production, including being paged for them.', answer: true, explain: 'Shared ownership creates fast feedback.' },
      ],
    },
  ],
};
