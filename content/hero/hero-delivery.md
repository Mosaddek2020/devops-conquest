## brief | Commit to cluster

Lumen's new notification service, `notify`, works on a laptop. Your job is to take it all the way to production on Kubernetes, then make sure nobody ever has to deploy it by hand again.

This is a trial: the tasks say **what** must be true, not which commands to type. Use everything from the CI/CD, Containers, Kubernetes and DevSecOps realms. The Field Guide and `ai explain` are allowed; so is resetting the lab.

1. An image that passes the security gate: small, non-root, no HIGH or CRITICAL vulnerabilities.
2. A first deployment by hand, with probes, resources and an Ingress, so you know what "good" looks like.
3. A pipeline that builds, scans, pushes and deploys every commit to `main`.
4. A change shipped through the pipeline only.
5. A teammate's broken release, handled without an outage.

## recap | What this trial proved

- You can turn source code into a hardened image and prove it with a scanner.
- You can write a production-shaped Deployment (probes, resources, pull secrets) with a Service and Ingress.
- You can build a pipeline that tags images by commit, gates on vulnerabilities and rolls out with `rollout status`.
- Readiness probes plus rolling updates keep a bad release from taking the site down; reverting in git is the clean fix.

## lab | Commit to cluster

The repository `lumen/notify` is cloned in `~/notify`. The cluster `lumen` has an ingress controller; `notify.lumen.dev` points at it. The private registry is `registry.lumen.dev` (user `ci`, token in `~/registry-token.txt`), and the repository already has the secrets `REGISTRY_TOKEN` and `KUBECONFIG_DATA` for CI.
