## story | Twelve servers and a spreadsheet

By its second year Lumen ran 40 containers on 12 servers, placed by hand. A spreadsheet said which container ran where. When `app4` died at night, someone had to read the spreadsheet, find space on other servers, start the containers there and update the load balancer. Deploys meant SSH-ing into each server in turn. Scaling up for a sale took an afternoon.

**Kubernetes** replaces the spreadsheet and the night shift with a control loop. You declare *what* should run (three copies of the shop, each with 256 MB of memory, reachable as `shop`), and the cluster decides *where*, watches it, and fixes any difference: a crashed container is restarted, a dead node's pods are rescheduled elsewhere, a deploy rolls out gradually.

Kubernetes is now the default platform for running containers at scale, offered by every cloud (EKS, GKE, AKS) and runnable on a laptop (kind, minikube). It is also where AI-generated YAML most often goes subtly wrong, so you need to read it fluently.

## model | Desired state and the control loop

```diagram
k8s-architecture
```

- The **control plane** stores **objects**: records of desired state, like "a Deployment called shop with 3 replicas of image shop:1.4".
- **Controllers** loop forever: *observe* actual state, *compare* with desired, *act* to close the gap. That is why deleting a pod does not reduce the count: the controller sees 2 of 3 and creates a new one.
- The **scheduler** picks a node for each new pod, based on the resources it requests.
- On every worker node, the **kubelet** starts the pod's containers through the container runtime and reports back.
- A **Pod** is the smallest unit: one or more containers sharing an IP. Pods are disposable; you rarely create them directly. A **Deployment** manages identical, replaceable pods for you.
- **kubectl** is the CLI. It talks to the API server using `~/.kube/config` (which cluster, which user, which namespace).
- **Namespaces** divide one cluster into named areas (`shop`, `payments`, `monitoring`).

## commands | First contact

```term
$ kubectl cluster-info                          # which cluster am I talking to?
$ kubectl get nodes                             # the machines
$ kubectl create deployment web --image=nginx:1.27 --replicas=3
$ kubectl get deployments                       # desired vs ready
$ kubectl get pods -o wide                      # pods, their IPs and nodes
$ kubectl delete pod <name>                     # …and watch a replacement appear
$ kubectl scale deployment web --replicas=5
$ kubectl get pods -n kube-system               # the cluster's own components
$ kubectl get all                               # the main objects in this namespace
```

```replay
title: Watch the control loop
scenario: k8s
show: cluster
step: kubectl create deployment web --image=nginx:1.27 --replicas=3 | You state the desired state: three nginx pods.
step: sleep 5; kubectl get pods -o wide | The scheduler spread them over the two worker nodes; each pod has its own IP.
step: kubectl delete pod $(kubectl get pods -o name | head -1 | cut -d/ -f2) | Delete one…
step: kubectl get pods | …and the ReplicaSet controller has already created a replacement with a new name. Desired: 3. Actual: 3.
step: kubectl scale deployment web --replicas=5 | Change the desired state…
step: sleep 4; kubectl get deploy web | …and the cluster converges on it.
```

## analogy | A thermostat

You don't switch the heating on and off yourself; you set 21 °C and the thermostat keeps checking and correcting. Kubernetes is a thermostat for software: you set "3 replicas, this image, this much memory" and it keeps correcting reality towards that, whatever happens to individual pods or machines.

## team | Kubernetes in a team

- **Everything is a YAML object in git.** Changes go through pull requests and are applied by a pipeline (or a GitOps tool like Argo CD), not typed into production by hand.
- **Namespaces per team or app**, with quotas and access rules.
- **Kubernetes is a platform, not a requirement.** For a handful of containers, Compose on a VM or a managed container service is simpler. Adopt it when you need its scheduling, self-healing and rollout machinery.

## traps | First-day traps

**Treating pods as pets.** A pod can be deleted and replaced at any time, with a new name and IP. Never depend on a specific pod.

**Working in the wrong cluster or namespace.** Check `kubectl config current-context` and the namespace before you change anything.

**`kubectl create` for everything.** Fine for exploring; real systems use files and `kubectl apply -f`.

## lab | Meet your cluster

Lumen gave you access to a small cluster called `lumen`. Explore it, run nginx on it, and see the control loop heal and scale your app.
