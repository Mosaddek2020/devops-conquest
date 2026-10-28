## story | Who changed production?

Lumen's pipeline ran `kubectl apply` against production with a cluster-admin token stored in CI. One Friday the shop ran 6 replicas instead of 3, an old image, and a ConfigMap nobody recognised. Three people had "fixed" things by hand during an incident; the pipeline had deployed twice since. There was no way to say what production *should* be, except "whatever is running".

**GitOps** turns that around. The desired state of every environment lives in a **git repository**; the only way to change it is a commit (usually through a reviewed pull request). An agent in the cluster, **Argo CD** (or Flux), **pulls** that state, compares it with what is running, and makes the cluster match. Drift becomes visible, rollback is `git revert`, and CI no longer needs credentials for production at all.

## model | Desired state in git, an agent that reconciles

```diagram
gitops-loop
```

- An Argo CD **Application** says: take this **source** (repo URL, revision, path) and keep this **destination** (cluster, namespace) in sync with it. The path may hold plain YAML, a kustomization or a Helm chart.
- **Sync status**: `Synced` (live matches git) or `OutOfSync` (something differs: a new commit, or someone's manual change). **Health**: `Healthy`, `Progressing`, `Degraded`, `Missing`.
- **Sync** applies git's version. With an **automated** sync policy it happens on its own when git changes; **self-heal** also reverts manual drift; **prune** deletes objects that were removed from git (otherwise they are left behind, marked OutOfSync).
- Argo CD **polls** git every 3 minutes. A **webhook** from the git host, or `argocd app get --refresh`, makes it look immediately.
- **History and rollback**: every sync is recorded with its git revision. With automated sync, the GitOps rollback is a **revert commit**; `argocd app rollback` only works for apps synced by hand.
- An **ApplicationSet** generates Applications from a template, for example one per folder under `apps/`: adding a service becomes adding a folder.

## commands | Argo CD from the CLI

```term
$ kubectl port-forward svc/argocd-server -n argocd 8080:443 &
$ argocd admin initial-password -n argocd
$ argocd login localhost:8080 --username admin --password '<pw>' --insecure
$ argocd app create shop --repo https://github.com/lumen/gitops.git --path apps/shop \
    --dest-server https://kubernetes.default.svc --dest-namespace shop \
    --sync-policy automated --self-heal --auto-prune --sync-option CreateNamespace=true
$ argocd app get shop                 # sync + health, per resource
$ argocd app diff shop                # what differs between git and the cluster
$ argocd app sync shop                # sync now (manual policy)
$ argocd app get shop --refresh       # re-read git now instead of waiting for the poll
$ argocd app history shop
```

The same Application as YAML (in git, so Argo CD can manage itself: "app of apps"):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shop
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/lumen/gitops.git
    targetRevision: HEAD
    path: apps/shop
  destination:
    server: https://kubernetes.default.svc
    namespace: shop
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true]
```

## analogy | A thermostat that reads the plan

Kubernetes already keeps pods matching a Deployment. Argo CD does the same one level up: the plan is the git repository. Turn the heating up by hand and the thermostat turns it back down; to change the temperature for good, you change the plan.

## team | GitOps in a team

- **Everything through pull requests**: review, CI checks (render, lint, policy) and an audit trail come for free. `git log` *is* the deploy log.
- **Separate app code from deployment config.** The app repo's CI builds and pushes an image, then opens a pull request (or commits) that bumps the tag in the GitOps repo.
- **Nobody needs write access to production clusters** for routine work; humans get read access and Argo CD holds the write permission.
- **Break-glass changes still happen**, but they go back into git right after, or self-heal reverts them.
- **Promote between environments** by changing the overlay or values for the next environment, not by rebuilding.

## traps | GitOps traps

**Fixing production with kubectl while self-heal is on**: your change is reverted within seconds. Commit it instead (or pause sync deliberately).

**Waiting for a deploy that Argo CD has not seen yet**: without a webhook it can take up to 3 minutes. Refresh, or set up the webhook.

**Prune off forever**: deleted manifests leave orphans running. Turn prune on once you trust the repo.

**Secrets in the GitOps repo in plain text.** Use a secrets manager (External Secrets) or encrypt them (SOPS).

**One giant repo-wide Application.** Split by service and environment so a broken manifest blocks one app, not all of them.

## lab | Production, from git

Argo CD runs in the `lumen` cluster and the desired state lives in `lumen/gitops`. Log in, hand the shop over to Argo CD, ship a release by pushing a commit, watch it undo a manual "hotfix", recover from a bad release with `git revert`, and let it clean up what you delete from git.
