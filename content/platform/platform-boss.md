## brief | Launch day for loyalty

Lumen's growth team is launching **loyalty**, a points service, on the platform you have been building. It has to go the platform way, end to end:

1. **Golden path and GitOps.** Create the service from the `node-api` template for `team-growth`, and deploy it by merging the gitops pull request. Argo CD must report it `Synced` and `Healthy`.
2. **Secrets from Vault.** The database password lives at `secret/loyalty/db`. Only the `loyalty` service account may read it, through a Kubernetes auth role and a `loyalty-read` policy. An ExternalSecret in git produces the `loyalty-db` Secret.
3. **Public, but only through the front door.** `loyalty.lumen.dev` answers through the ingress. The namespace denies all other ingress, so a pod in `tools` cannot connect.
4. **Read-only humans.** The group `team-growth` can read the `loyalty` namespace (not Secrets), and cannot change anything by hand.
5. **Policies hold.** Every workload passes the cluster's enforced Kyverno policies, and the scorecard is 6/6.

Every change to the cluster goes through git and Argo CD, except the Vault setup. Vault is not managed by Kubernetes.

## recap | What the Platform realm gave you

- Helm charts, values layers, releases, `--atomic` upgrades and rollbacks.
- Kustomize bases and overlays, generators with content hashes, `kubectl diff -k`.
- GitOps with Argo CD: Applications, sync, self-heal, prune, refresh, revert to roll back, ApplicationSets.
- RBAC: service accounts, roles and bindings, `auth can-i`, least privilege for pipelines and people.
- NetworkPolicies: default deny, allow lists by labels and namespaces, pod ports.
- Policy as code with Kyverno: Audit, PolicyReports, Enforce, and the same check in CI.
- Secrets: Vault policies and Kubernetes auth, External Secrets, rotation, SOPS for git.
- Golden paths, service catalog, scorecards and DORA metrics.

## lab | Boss: launch loyalty

The platform is running: Argo CD (with a git webhook) deploys every folder under `apps/` in `lumen/gitops`; Kyverno enforces Lumen's policies; External Secrets is installed; Vault is at `http://vault.lumen.internal:8200`, and its admin token is in `~/vault-admin-token`. The `lumen` CLI is on your laptop.
