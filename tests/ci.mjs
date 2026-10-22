// CI/CD on real simulated runners: test, deploy over SSH with a secret key, smoke test.
import '../js/sim/index.js';
import { Session } from '../js/sim/session.js';
import { newUniverse, addServer, addLaptop, authorizeKey } from '../js/sim/machines.js';
import { seedRemote } from '../js/git/github.js';
import { stripAnsi } from '../js/git/world.js';

const uni = newUniverse();
const laptop = addLaptop(uni, 'laptop', { packages: [] });
const web = addServer(uni, 'web1', { ip: '10.0.0.11' });
// deploy user with a dedicated key pair; the private key lives on the laptop for now
authorizeKey(uni, laptop, 'dev', web, 'ubuntu');
const files = {
  'package.json': '{"name":"hello","version":"1.0.0","scripts":{"test":"jest"}}\n',
  'index.html': '<h1>hello v1</h1>\n',
  '.github/workflows/deploy.yml': `name: Deploy
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy over SSH
        env:
          SSH_KEY: \${{ secrets.DEPLOY_KEY }}
        run: |
          mkdir -p ~/.ssh
          echo "$SSH_KEY" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          scp index.html ubuntu@web1:/tmp/index.html
          ssh ubuntu@web1 "sudo cp /tmp/index.html /var/www/html/index.html"
      - name: Smoke test
        run: curl -sf http://web1/ | grep -q hello
`,
};
seedRemote(uni, 'you', 'hello', [{ message: 'init', files }], { collaborators: ['you'] });
uni.host('web1');
const s = new Session(uni, laptop);
const w = new Session(uni, web, { user: 'ubuntu' });
w.run('sudo apt install -y nginx');
let fails = 0;
const run = (sess, cmd, expect) => { const r = sess.run(cmd); const out = r.out.map(stripAnsi).join('\n'); const ok = !expect || expect.test(out); if (!ok) { fails++; console.log(`✗ ${cmd}\n${out}`); } else console.log(`✓ ${cmd}`); return out; };
run(s, 'git clone -q https://github.com/you/hello.git && cd hello && ls');
run(s, 'gh secret set DEPLOY_KEY < ~/.ssh/id_ed25519', /Set Actions secret DEPLOY_KEY/);
run(s, 'echo "<h1>hello v2</h1>" > index.html && git commit -qam "v2" && git push -q');
const out = run(s, 'gh run view', /✓ deploy|deploy/);
console.log(out.split('\n').slice(0, 40).join('\n'));
run(s, 'curl -s http://web1/', /hello v2/);
console.log(fails ? `${fails} failures` : 'ci scenario passes');
process.exit(fails ? 1 : 0);
