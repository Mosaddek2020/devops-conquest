## story | Flat networks

A vulnerable image library let an attacker run commands in Lumen's `reports` pod, a low-value internal tool. From there they could reach every pod in the cluster: the shop's internal API, the payments service, Redis without a password. In Kubernetes, by default, **every pod can talk to every other pod**, in every namespace.

**NetworkPolicies** are firewall rules for pods, enforced by the cluster's network plugin (Calico, Cilium…). You select pods by label and list who may connect to them (ingress) and where they may connect (egress). The usual pattern is *zero trust*: deny everything in a namespace, then allow the few paths the application actually needs.

## model | Default deny, then allow what is needed

```diagram
netpol-model
```

- A NetworkPolicy **selects pods** in its namespace with `podSelector` (`{}` = all pods).
- `policyTypes: [Ingress]` and/or `[Egress]` say which directions it governs. Once **any** policy selects a pod for a direction, that direction becomes **deny by default** for the pod; only traffic some policy allows gets through.
- **Ingress rules** list `from` peers and `ports`:
  - `podSelector`: pods with these labels *in the policy's namespace*;
  - `namespaceSelector`: any pod in namespaces with these labels (every namespace has `kubernetes.io/metadata.name: <name>`);
  - both in **one** entry: those pods in those namespaces (AND); two separate entries: either (OR);
  - `ipBlock`: addresses outside the cluster.
- **Ports are the pod's ports** (the `targetPort`, or the container port's name), not the Service's port.
- Policies are **additive**: there is no order and no deny rule; the union of all allows applies.
- Denied packets are **dropped**, so connections time out instead of being refused.

## commands | Lock down a namespace

```yaml
# 1. default deny: no ingress to any pod in shop
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: shop
spec:
  podSelector: {}
  policyTypes: [Ingress]
---
# 2. only web may call api, on its http port
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-from-web
  namespace: shop
spec:
  podSelector:
    matchLabels: { app: api }
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: web }
      ports:
        - port: http
```

```term
$ kubectl apply -f netpol/
$ kubectl get netpol -n shop
$ kubectl describe netpol api-from-web -n shop
$ kubectl exec -n shop deploy/web -- curl -s -m 2 http://api        # allowed
$ kubectl exec -n tools deploy/debug -- curl -s -m 2 http://api.shop # times out
```

## analogy | Doors inside the office

The building's front door (the ingress) is not enough: inside, the server room, the finance office and the kitchen have their own locks. Your badge opens the doors your job needs. A visitor who got past reception still cannot walk into the server room.

## team | Network policy in a team

- **Default deny in every application namespace**, created with the namespace (a golden path or a policy engine can generate it).
- **Name the allowed flows after the architecture**: `api-from-web`, `db-from-api`. The policies become documentation of who talks to whom.
- **Test the matrix**: a small script that curls each path and expects success or timeout, run after every change.
- **Remember egress**: blocking pods from calling the internet stops data exfiltration and surprise dependencies. Allow DNS (port 53) when you deny egress.

## traps | Network policy traps

**A plugin that ignores them.** Policies only work if the CNI enforces them (Calico, Cilium do; some simple plugins do not). Test.

**Using the Service port.** `port: 80` on the policy does not match a pod listening on 5678.

**`podSelector` in another namespace.** Without a `namespaceSelector`, a podSelector only matches pods in the policy's own namespace.

**Default deny without allowing the ingress controller**: the whole site times out.

**AND versus OR.** `- namespaceSelector… podSelector…` in one list item is AND; two list items is OR. One dash changes the meaning.

## lab | Zero trust for the shop

In the `shop` namespace, `web` serves the site through the ingress controller and calls `api`; `reports` is an internal tool; `tools/debug` is a pod anyone can exec into. Right now everything can reach everything. Lock the namespace down and keep the site working.
