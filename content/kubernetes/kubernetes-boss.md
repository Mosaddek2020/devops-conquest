## brief | Move the tickets service to Kubernetes

Lumen's tickets service (the image you built in the Containers realm, now in the registry) must move onto the `lumen` cluster, in its own namespace, production-ready:

1. A `tickets` namespace with the database password in a Secret and settings in a ConfigMap.
2. Postgres as a StatefulSet with persistent storage and a Service.
3. The API as a Deployment with 2 replicas, probes, resources and the private-registry credentials it needs; a Service; and an Ingress for `tickets.lumen.dev`.
4. A safe release of version 1.1 that turns out to be broken: detect it, roll back, and prove nothing was lost.

## recap | What the Kubernetes realm gave you

- Desired state, controllers and the reconcile loop; nodes, pods, namespaces; kubectl and kubeconfig.
- Deployments, ReplicaSets, labels and selectors; reading pod states, describe, events and logs.
- Services, DNS names, endpoints, port-forward and Ingress routing.
- ConfigMaps and Secrets as env vars and files; base64 is not encryption; restarts to pick up env changes.
- Readiness and liveness probes, requests and limits, OOMKilled and Pending.
- Rolling updates gated by readiness, rollout status, history and undo.
- HPAs, StatefulSets and PersistentVolumeClaims.

## lab | Ship tickets to the cluster

Images: `registry.lumen.dev/team/tickets:1.0.0` and `:1.1.0` (private: user `ci`, token in `~/registry-token.txt`). The ingress controller answers for `tickets.lumen.dev`. Write your manifests in `~/k8s/`.
