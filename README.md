# DevOps Conquest

A self-paced, mastery-based DevOps course for the age of AI: zero to hero, hands-on in a
simulated Linux world that runs entirely in the browser (no backend, progress in
localStorage).

Each lesson teaches through several lenses (story, mental model, commands, analogy, team
practice, traps), then a hands-on lab graded from the simulator's real state, then a quiz.
You unlock the next lesson by passing it.

Live at **https://mosaddek2020.github.io/devops-conquest/** (every push to `main` is
tested, built and deployed by `.github/workflows/pages.yml`).

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
| 7 | Kubernetes: desired state, debugging pods, Services and Ingress, config and Secrets, probes and resources, rollouts, HPA and StatefulSets | 8 |
| 8 | Infrastructure as Code: Terraform (plans, state, drift, modules, safe changes) and Ansible (playbooks, templates, handlers, vault) | 8 |
| 9 | Observability: golden signals, Prometheus, PromQL, dashboards, alerting, logs, traces, SLOs | 9 |
| 10 | Reliability: redundancy and failover, incident response, runbook automation, blameless postmortems, backups and restores, game days | 7 |
| 11 | DevSecOps: threat modelling and hardening, secrets and key rotation, SAST, DAST, SBOMs and image signing, IaC scanning, pod security, CI security gates | 9 |
| 12 | AI-assisted DevOps: prompting with context (and without secrets), reviewing AI-written scripts and Terraform, prompt injection and bot permissions, agents under guardrail policies, operating LLM services | 7 |
| 13 | Hero Trials: commit to cluster, trust but verify (SBOMs and signed digests), platform from code, the on-call week | 4 |

## How it works

- `js/sim/` is the simulator: hosts with real filesystems, users and processes, a bash
  interpreter, networking (DNS, ports, firewalls, TLS), systemd, nginx, apt, git and GitHub
  Actions, Docker (`docker.js`, `docker-images.js`: builds run each `RUN` step in a build
  container, layers are cached, containers are small hosts with their own IPs), Kubernetes
  (`k8s.js` controllers, scheduler, kubelet with probes and back-off, Services, Ingress, HPA,
  StatefulSets; `kubectl.js` the CLI), an AWS-like cloud (`cloud.js`: instances run cloud-init,
  security groups and VPC routes really filter traffic), Terraform (`hcl.js` parser/evaluator,
  `terraform.js` plan/apply/state/backends, `tfproviders.js`), Ansible (`ansible.js`), observability (`obs.js`: traffic-driven app metrics, node_exporter,
  Prometheus scraping/rules/alerts, Alertmanager into a team chat, LogQL logs, traces;
  `promql.js` the query engine), reliability tools (`reliability.js`: `ab` load tests, an
  `incident` CLI with a status page, `pg_dump`), security tools (`security.js`: gitleaks,
  semgrep, trivy, syft, OWASP ZAP baseline/full scans, lynis, cosign, all of which inspect the
  simulated world so a finding only goes away when the problem is fixed), AI-ops tools
  (`aiops.js`: shellcheck, an ops `agent` with allow/ask/deny policies and an audit log, an AI
  review-bot action, an LLM gateway with token and cost metrics) and a
  simulated AI assistant (`ai`) whose scripted answers are sometimes wrong on purpose.
- `js/content/rNN-*.js` defines each realm's labs (setup, tasks with checks and reference
  solutions) and quizzes; `content/<realm>/<lesson>.md` holds the lesson text.
- `js/ui/` has the terminal, panels (System, Files, Network, GitHub, Docker, Cluster, Cloud, Observe), diagrams and
  step-through replays; `js/views/` the pages, including the three.js map.

## Develop

```sh
node tools/build-content.mjs   # bundle lesson Markdown into js/content/text.js
node tools/build.mjs           # build dist/
node tests/labs.mjs            # every lab's reference solution passes, no premature passes
node tests/quizzes.mjs         # quiz structure
node tests/modules.mjs          # every module imports (catches what node --check misses)
node tests/shell.mjs && node tests/ops.mjs && node tests/ci.mjs && node tests/docker.mjs
```
