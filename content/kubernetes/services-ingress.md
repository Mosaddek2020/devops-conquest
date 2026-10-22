## story | The IP address that kept changing

The first version of Lumen's frontend on Kubernetes called the API at `10.244.1.7:3000`, the API pod's IP, copied from `kubectl get pods -o wide`. It worked until the API was redeployed: new pods, new IPs, broken frontend. The next attempt listed all three pod IPs in a config file. That broke on the next scale-up.

Pods come and go; their IPs are not an address you can rely on. A **Service** gives a set of pods one stable name and virtual IP and spreads traffic across whichever of them are ready right now. An **Ingress** then routes outside HTTP traffic by hostname and path to the right Service.

## model | Services, DNS and Ingress

```diagram
k8s-objects
```

- A **Service** selects pods by label and gets a stable **ClusterIP** and a DNS name: `shop` (same namespace), `shop.payments` (another namespace), `shop.payments.svc.cluster.local` (fully qualified).
- `port` is what clients connect to on the Service; `targetPort` is the container's port (a number or a named port).
- The Service's **endpoints** are the IPs of matching, **ready** pods. No endpoints → connections fail. A typo in a selector is the classic cause.

| Service type | Reachable from | Typical use |
|---|---|---|
| `ClusterIP` (default) | inside the cluster only | almost everything |
| `NodePort` | every node's IP on a port 30000-32767 | quick tests, bare-metal |
| `LoadBalancer` | a cloud load balancer with an external IP | exposing one service directly |

An **Ingress** is HTTP routing for many services behind one entry point (an ingress controller such as ingress-nginx): `shop.lumen.dev/` → `shop`, `shop.lumen.dev/api` → `api`. TLS certificates usually terminate there too.

`kubectl port-forward` tunnels a local port to a pod or service: perfect for a quick look, not a way to serve users.

## commands | Connecting things

```term
$ kubectl expose deployment shop --port=80 --target-port=3000
$ kubectl get svc,endpoints shop
$ kubectl describe svc shop                  # Selector, TargetPort, Endpoints
$ kubectl run tmp --image=curlimages/curl --rm -it --restart=Never -- curl -s http://shop
$ kubectl port-forward svc/shop 8080:80      # then curl localhost:8080 on your machine
$ kubectl get ingress
$ kubectl describe ingress shop              # rules and their backends
$ curl -H "Host: shop.lumen.dev" http://<ingress-ip>/
```

## analogy | A company switchboard

You don't call employees' desk phones directly; they move desks. You call the department's number (the Service) and the switchboard connects you to whoever is at their desk and available (ready endpoints). The receptionist in the lobby (the Ingress) reads the name on your visitor badge (the Host header) and sends you to the right department.

## team | Networking habits

- **Services call each other by DNS name**, never by pod IP.
- **One Ingress controller per cluster**, with TLS; very few `LoadBalancer` services (each costs money).
- **Label conventions** (`app`, `component`, `version`) so selectors stay readable.
- **NetworkPolicies** to restrict which pods may talk to which (by default everything can).

## traps | Networking traps

**Selector typo** (`app: shop` vs `app: shop-api`): the Service has no endpoints, clients see refused connections or 503s.

**`targetPort` wrong**: endpoints exist, but connections are refused or reset.

**`curl <ClusterIP>` from your laptop**: cluster IPs only route inside the cluster. Use `port-forward` or the Ingress.

**Forgetting the Host header** when testing an Ingress by IP: you get the controller's 404.

## lab | Wire up the menu service

The menu app is running, but nothing can reach it. Give it a Service, test it from inside the cluster and from your laptop, and route `menu.lumen.dev` to it through the Ingress.
