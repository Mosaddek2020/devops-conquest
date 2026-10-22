# DevOps Conquest

A self-paced, mastery-based DevOps course for the age of AI: zero to hero, hands-on in a
simulated Linux world that runs entirely in the browser (no backend, progress in
localStorage).

Each lesson teaches through several lenses (story, mental model, commands, analogy, team
practice, traps), then a hands-on lab graded from the simulator's real state, then a quiz.
You unlock the next lesson by passing it.

## Realms

| # | Realm | Lessons |
|---|---|---|
| 0 | Base Camp: what DevOps is, the delivery loop, working with AI | 4 |
| 1 | Linux: shell, files, permissions, pipes, processes, packages | 7 |
| 2 | Networking: IP/DNS, HTTP, SSH keys, firewalls, TLS | 6 |
| 3 | Servers & Services: systemd, nginx, releases, logs and cron | 5 |
| 4 | Scripting & Automation: robust bash, graded by running your scripts | 4 |
| 5 | CI/CD: GitHub Actions on simulated runners that build, deploy over SSH and smoke-test | 6 |
| 6 | Containers: Docker images, Dockerfiles, small safe images, volumes, networks, Compose, registries | 8 |

## How it works

- `js/sim/` is the simulator: hosts with real filesystems, users and processes, a bash
  interpreter, networking (DNS, ports, firewalls, TLS), systemd, nginx, apt, git and GitHub
  Actions, Docker (`docker.js`, `docker-images.js`: builds run each `RUN` step in a build
  container, layers are cached, containers are small hosts with their own IPs) and a
  simulated AI assistant (`ai`) whose scripted answers are sometimes wrong on purpose.
- `js/content/rNN-*.js` defines each realm's labs (setup, tasks with checks and reference
  solutions) and quizzes; `content/<realm>/<lesson>.md` holds the lesson text.
- `js/ui/` has the terminal, panels (System, Files, Network, GitHub, Docker), diagrams and
  step-through replays; `js/views/` the pages, including the three.js map.

## Develop

```sh
node tools/build-content.mjs   # bundle lesson Markdown into js/content/text.js
node tools/build.mjs           # build dist/
node tests/labs.mjs            # every lab's reference solution passes, no premature passes
node tests/quizzes.mjs         # quiz structure
node tests/shell.mjs && node tests/ops.mjs && node tests/ci.mjs && node tests/docker.mjs
```
