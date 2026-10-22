// Sandbox starting points. Later simulators add more (containers, clusters, cloud).

export const SCENARIOS = {
  laptop: {
    title: 'Just your laptop',
    note: 'A Linux laptop with your home folder. Try: ls -la, cat /etc/os-release, echo $PATH, ps aux',
    setup(H) {
      H.write('laptop', '~/notes.txt', 'Things to learn:\n- the shell\n- networking\n- containers\n', { owner: 'dev' });
      H.write('laptop', '~/scripts/hello.sh', '#!/bin/bash\necho "Hello, $USER! Today is $(date +%A)."\n', { owner: 'dev', mode: 0o755 });
    },
    panels: ['system', 'files'],
  },
  server: {
    title: 'One Ubuntu server',
    note: 'web1 is a fresh Ubuntu server and your SSH key is already authorized. Try: ssh ubuntu@web1, then sudo apt install -y nginx',
    setup(H) {
      H.server('web1', { fqdn: ['web1.example.com'] });
      H.authorize('laptop', 'dev', 'web1', 'ubuntu');
      H.dns('web1.example.com', 'web1');
    },
    panels: ['network', 'system', 'files'],
  },
  webstack: {
    title: 'Web app + database',
    note: 'shop.example.com: nginx and a Node app on web1, PostgreSQL on db1. Try: curl -i http://shop.example.com/health, then ssh in and explore',
    setup(H) {
      const web = H.server('web1', { fqdn: ['shop.example.com'] });
      const db = H.server('db1');
      H.authorize('laptop', 'dev', 'web1', 'ubuntu');
      H.authorize('laptop', 'dev', 'db1', 'ubuntu');
      H.install('db1', 'postgresql');
      H.write('db1', '/etc/postgresql/16/main/postgresql.conf', "listen_addresses = '*'\nport = 5432\n");
      H.run('sudo systemctl restart postgresql', { on: 'db1' });
      H.install('web1', 'nginx', 'nodejs', 'npm');
      H.mkdir('web1', '/opt/shop', { owner: 'ubuntu' });
      H.write('web1', '/opt/shop/server.js', "const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || 3000;\nconst db = connect(process.env.DATABASE_URL);\n\napp.get('/health', (req, res) => res.json({ status: 'ok', version: process.env.VERSION || 'dev' }));\napp.get('/', (req, res) => res.send('Welcome to the shop'));\n\napp.listen(PORT, () => console.log(`shop listening on port ${PORT}`));\n", { owner: 'ubuntu' });
      H.mkdir('web1', '/opt/shop/node_modules/express', { owner: 'ubuntu' });
      H.service('web1', 'shop', '[Unit]\nDescription=Shop web app\nAfter=network.target\n\n[Service]\nUser=ubuntu\nWorkingDirectory=/opt/shop\nEnvironment=PORT=3000\nEnvironment=VERSION=1.4.2\nEnvironment=DATABASE_URL=postgres://db1:5432/shop\nExecStart=/usr/bin/node server.js\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n');
      H.write('web1', '/etc/nginx/sites-available/shop', 'server {\n    listen 80;\n    server_name shop.example.com;\n\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}\n');
      H.run('sudo ln -s /etc/nginx/sites-available/shop /etc/nginx/sites-enabled/shop && sudo rm /etc/nginx/sites-enabled/default && sudo systemctl reload nginx', { on: 'web1' });
      H.dns('shop.example.com', 'web1');
      void web; void db;
    },
    panels: ['network', 'system', 'files'],
  },
  docker: {
    title: 'Docker playground',
    note: 'Docker is installed and you are in the docker group; a small Node app is in ~/app. Try: docker run -d -p 8080:80 nginx, curl localhost:8080, then write a Dockerfile for ~/app and docker build -t app .',
    setup(H) {
      H.docker('laptop');
      H.write('laptop', '~/app/server.js', "const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || 3000;\napp.get('/', (req, res) => res.send('Hello from a container'));\napp.get('/health', (req, res) => res.json({ status: 'ok' }));\napp.listen(PORT, () => console.log(`app listening on ${PORT}`));\n", { owner: 'dev' });
      H.write('laptop', '~/app/package.json', '{\n  "name": "app",\n  "version": "1.0.0",\n  "dependencies": { "express": "^4.21.1" }\n}\n', { owner: 'dev' });
      H.write('laptop', '~/app/package-lock.json', '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "packages": { "node_modules/express": { "version": "4.21.1" } }\n}\n', { owner: 'dev' });
      H.pull('laptop', 'nginx', 'alpine', 'node:20-alpine');
    },
    panels: ['docker', 'files', 'system'],
  },
};
