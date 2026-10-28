## brief | The GitOps migration

Lumen's tickets service is deployed the old way: its CI workflow runs `kubectl apply` with a kubeconfig stored as a repository secret, and that kubeconfig's service account is **cluster-admin**. The security review gave you two weeks to fix it. You will finish today.

When you are done:

1. `lumen/gitops` holds the tickets service as a **Kustomize base** with **staging** and **prod** overlays (namespaces `tickets-staging` and `tickets-prod`; prod runs 3 replicas).
2. **Argo CD** deploys both, as applications `tickets-staging` and `tickets-prod`, automated with self-heal and prune, Synced and Healthy.
3. Release **1.1.0** to staging first; then **promote it to prod through a pull request** in `lumen/gitops`.
4. CI **no longer has cluster credentials**: the `KUBECONFIG_DATA` secret is gone, the workflow no longer runs kubectl, the `ci-admin` binding is deleted, and the old copy in namespace `tickets` is removed.
5. Prove it: a manual change in prod is reverted.

## recap | What this trial proved

- Kustomize overlays keep environments small and reviewable.
- Argo CD pulls from git: the cluster's credentials never leave the cluster.
- Promotion is a pull request that changes one line in the prod overlay.
- Removing CI's admin access is part of the migration, not an afterthought.
- Self-heal turns "someone fixed it by hand" into a visible, reverted event.

## lab | The GitOps migration

Argo CD runs in the `lumen` cluster with a git webhook (it sees pushes immediately). `~/tickets` and `~/gitops` are clones of `lumen/tickets` and `lumen/gitops`. The image `ghcr.io/lumen/tickets` has tags `1.0.0` and `1.1.0`.
