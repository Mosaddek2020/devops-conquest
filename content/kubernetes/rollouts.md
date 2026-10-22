## story | The deploy that stopped itself

Version 3.2 of the Lumen shop had a bug that only appeared on startup against the real database: the new pods never became ready. In the old SSH world, that deploy would have replaced every server and taken the shop down. On Kubernetes, the rolling update created one new pod, waited for it to become ready, and simply never continued. The old pods kept serving. The on-call engineer ran one command, `kubectl rollout undo`, and went back to sleep.

Rolling updates with readiness gating, plus a recorded history of every version, make deploys boring, which is exactly what you want.

## model | How a Deployment rolls out

```diagram
k8s-rolling
```

- Changing the pod **template** (image, env, resources…) creates a new **ReplicaSet**; the Deployment scales it up and the old one down.
- `strategy.rollingUpdate.maxSurge`: how many extra pods may exist during the update (default 25%). `maxUnavailable`: how many may be missing (default 25%). `maxUnavailable: 0` means "never drop below full capacity".
- Old pods are only removed as new ones become **ready**. Without a readiness probe, "started" counts as ready, and a broken version replaces everything.
- If the rollout makes no progress for `progressDeadlineSeconds` (default 600), the Deployment reports `ProgressDeadlineExceeded`. Kubernetes does **not** roll back on its own; you (or your pipeline) do.
- Every rollout is a **revision**. `rollout undo` switches the template back to the previous one (which becomes a new revision). Annotate `kubernetes.io/change-cause` to make the history readable.
- `strategy.type: Recreate` stops all old pods before starting new ones: for apps that cannot run two versions at once.

## commands | Rolling out and back

```term
$ kubectl set image deployment/shop shop=ghcr.io/lumen/shop:3.2
$ kubectl annotate deployment/shop kubernetes.io/change-cause="shop 3.2: new checkout"
$ kubectl rollout status deployment/shop       # waits; fails if the rollout is stuck
$ kubectl rollout history deployment/shop
$ kubectl rollout undo deployment/shop         # back to the previous revision
$ kubectl rollout undo deployment/shop --to-revision=2
$ kubectl rollout restart deployment/shop      # new pods, same version
$ kubectl get rs                                # one ReplicaSet per revision
```

```replay
title: A rollout, a bad version and an undo
scenario: k8s
show: cluster
setup: kubectl create deployment web --image=nginx:1.27 --replicas=3; sleep 6
step: kubectl set image deployment/web nginx=nginx:1.27-alpine | A new template: a new ReplicaSet scales up while the old one scales down.
step: kubectl rollout status deployment/web | It waits until every new pod is ready.
step: kubectl set image deployment/web nginx=nginx:9.99 | Now a version that does not exist…
step: kubectl rollout status deployment/web --timeout=30s | The new pod cannot pull its image, so the rollout stops. The three old pods keep serving.
step: kubectl rollout undo deployment/web | Back to the previous template.
step: kubectl rollout history deployment/web | Every change is a revision you can return to.
```

## analogy | Changing a train's carriages at the station

You don't uncouple every carriage at once and hope the new ones arrive. You attach a new carriage, check its doors open, then detach an old one, one at a time. If a new carriage's doors are jammed, you stop and keep running with the old ones while someone fixes it.

## team | Release habits

- **Pipelines run `kubectl rollout status`** after applying and fail (and roll back) when it fails.
- **Readiness probes are a release-safety feature**, not just monitoring.
- **Small, frequent rollouts**; feature flags for risky behaviour; canaries (a small share of traffic first) for big changes.
- **Never edit live objects by hand** in production; change the manifest in git, let the pipeline apply it.

## traps | Rollout traps

**No readiness probe**: a broken version is "ready" immediately and replaces all healthy pods.

**`kubectl rollout status` not checked in CI**: the pipeline is green while production is stuck.

**`:latest` tags**: changing the image behind the same tag does not change the template, so nothing rolls out (and you cannot roll back).

**Undo, then the next CI deploy re-applies the broken version** because git still says 3.2. Revert in git too.

## lab | Ship 3.2 without breaking checkout

Roll the shop forward to 3.1, then 3.2. One of them is broken. Let the rollout protect you, read why it stopped, and roll back.
