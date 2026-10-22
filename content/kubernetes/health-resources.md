## story | Healthy, said Kubernetes. Down, said the users.

Black Friday morning: Lumen's shop pods were all `Running`, but checkout returned errors. The app had started, but its connection pool to the database was exhausted and it answered every request with 500. Kubernetes saw a running process and kept sending traffic. Meanwhile, one node was out of memory: the shop had no memory limits, a cache grew without bound, and the kernel killed the payments service sharing that node.

Kubernetes only knows what you tell it. **Probes** tell it how to judge health. **Requests and limits** tell it how much CPU and memory each container needs and may use.

## model | Probes, requests and limits

```diagram
k8s-probes
```

```term
containers:
  - name: shop
    image: ghcr.io/lumen/shop:2.0
    resources:
      requests: { cpu: 100m, memory: 128Mi }   # reserved: used by the scheduler
      limits:   { memory: 256Mi }              # ceiling: above this → OOMKilled
    readinessProbe:
      httpGet: { path: /ready, port: 3000 }
      periodSeconds: 5
    livenessProbe:
      httpGet: { path: /health, port: 3000 }
      initialDelaySeconds: 10
      failureThreshold: 3
```

- **readinessProbe**: may this pod receive traffic *now*? Failing pods are taken out of the Service's endpoints but keep running.
- **livenessProbe**: is it stuck beyond recovery? After `failureThreshold` failures the container is restarted. Keep it simple and local (no database checks).
- **requests**: what the scheduler reserves on a node. A pod whose requests fit nowhere stays `Pending` (`Insufficient memory`).
- **limits**: the maximum. Over the memory limit the container is killed (`OOMKilled`, exit code 137). Over the CPU limit it is slowed down (throttled), not killed.
- `1000m` = 1 CPU core; `Mi`/`Gi` are mebibytes/gibibytes.

## commands | Checking health and capacity

```term
$ kubectl describe pod <pod>              # probe failures and OOMKilled show here
$ kubectl get pods                        # READY 0/1 = readiness failing
$ kubectl get endpoints shop              # which pods receive traffic
$ kubectl top pods                        # actual CPU and memory use
$ kubectl top nodes
$ kubectl describe node <node>            # Allocated resources: requests vs capacity
$ kubectl get events --field-selector type=Warning
```

## analogy | A restaurant kitchen

Readiness is the chef saying "I can take orders" (or "give me five minutes, I'm out of tomatoes"); orders stop coming while they restock. Liveness is the manager checking the chef isn't passed out; if they are, someone else takes over the station. Requests are the counter space reserved for each station; limits are the size of the pot. Overfill the pot and it boils over.

## team | Resource habits

- **Every container has requests, and a memory limit.** Base them on `kubectl top` measurements, not guesses.
- **Readiness on every service that takes traffic.** Separate `/ready` (dependencies OK) from `/health` (process OK).
- **Watch restarts and OOMKills** in monitoring; a slowly rising restart count is an early warning.

## traps | Health traps

**Liveness that checks the database**: a database hiccup restarts every pod at once and turns a blip into an outage.

**No readiness probe**: pods get traffic the moment the process starts, before they are warmed up.

**Limits far below real usage**: an OOMKilled crash loop that looks like an application bug.

**Huge requests "to be safe"**: pods stay Pending and the cluster looks full while nodes sit idle.

## lab | Make the shop honest about its health

The shop deployment has no probes and no resources. Add them, and use them to diagnose a pod that is quietly broken and another that keeps dying.
