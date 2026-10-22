## story | "It works when I run it"

A developer asked an AI assistant for a Kubernetes Deployment for the notes API, pasted the YAML, ran `kubectl apply`, and got `deployment.apps/notes created`. Success, they thought. An hour later the API was still down. `kubectl get pods` said `ImagePullBackOff`: the image name had a typo. After fixing that, `CrashLoopBackOff`: the app needed an environment variable. Each problem was spelled out by Kubernetes in plain words. They just had not known where to look.

"Created" only means the cluster **accepted your desired state**. Whether it can be achieved is a separate question, answered by pod status, `describe` and events.

## model | Manifests, labels and pod states

```term
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notes
  labels: { app: notes }
spec:
  replicas: 2
  selector:
    matchLabels: { app: notes }        # which pods this Deployment manages…
  template:                            # …and the pods it creates
    metadata:
      labels: { app: notes }           # must match the selector
    spec:
      containers:
        - name: notes
          image: ghcr.io/lumen/notes:1.2.0
          ports:
            - containerPort: 3000
          env:
            - name: NOTES_DB
              value: /data/notes.db
```

- Every object has `apiVersion`, `kind`, `metadata` (name, namespace, **labels**) and `spec` (what you want). The cluster adds `status` (what is).
- **Labels** are key/value tags; **selectors** find objects by label. A Deployment's selector must match its template's labels.
- `kubectl apply -f` is **declarative**: run it again after editing the file and only the differences change.

| Pod status | Means | Look at |
|---|---|---|
| `Pending` | not scheduled yet (no node has room, or a constraint fails) | `describe` → Events: `FailedScheduling` |
| `ContainerCreating` | pulling the image, mounting volumes | wait, then `describe` |
| `ErrImagePull` / `ImagePullBackOff` | image name/tag wrong, or a private registry without credentials | `describe` → the pull error |
| `CreateContainerConfigError` | a referenced Secret/ConfigMap or key is missing | `describe` |
| `Running` but `0/1` ready | the container runs, readiness probe fails | `describe`, `logs` |
| `CrashLoopBackOff` | the container keeps exiting; Kubernetes waits longer between restarts | `logs --previous` |
| `OOMKilled` | exceeded its memory limit | `describe` → Last State |

## commands | Apply and debug

```term
$ kubectl apply -f notes.yaml
$ kubectl get pods                         # STATUS and RESTARTS
$ kubectl describe pod <pod>               # the Events section at the bottom explains most problems
$ kubectl logs <pod>                       # what the app printed
$ kubectl logs <pod> --previous            # the run that crashed
$ kubectl logs deploy/notes                # any pod of the deployment
$ kubectl get events --sort-by=.lastTimestamp
$ kubectl exec -it <pod> -- sh             # look around inside
$ kubectl create deployment x --image=y --dry-run=client -o yaml > x.yaml   # generate a starting manifest
```

## analogy | Placing an order

`kubectl apply` is placing an order: the shop says "order received". That does not mean the item was in stock. Pod status is the tracking page, and `describe` is the detailed delivery log that tells you the parcel is stuck at customs because the address was wrong.

## team | Habits

- **Generate, then edit**: `--dry-run=client -o yaml` gives a correct skeleton; AI or memory gives plausible-looking mistakes.
- **One file per app** (or a folder), applied by CI.
- **Debug top-down**: `get` (what state?) → `describe` (why?) → `logs` (what did the app say?).
- **Pin image tags**; never deploy `:latest` to a cluster.

## traps | Manifest traps

**Selector and template labels that differ**: the API rejects the Deployment.

**Indentation**: YAML lists under `containers:` need the `-`, and a wrong indent silently moves a field.

**`apiVersion` from old tutorials** (`extensions/v1beta1`): rejected by modern clusters with "no matches for kind".

**Fixing a crash by deleting the pod**: the replacement crashes the same way. Read the logs.

## lab | Deploy the notes API

Write a Deployment for `ghcr.io/lumen/notes` and fix everything that keeps it from running, using what the cluster tells you.
