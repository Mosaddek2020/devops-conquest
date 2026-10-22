## story | The sale that scaled itself

The year before, Lumen's Black Friday team watched dashboards all day and ran `kubectl scale` by hand whenever latency climbed, a little too late each time. This year a **HorizontalPodAutoscaler** watched CPU for them and added pods within a minute of the spike. The database, however, could not be scaled that way: it needed its data to survive pod restarts and its identity to stay stable.

Stateless services scale **horizontally** (more identical pods). Stateful ones need stable names and **persistent volumes**.

## model | Autoscaling and stateful workloads

**HorizontalPodAutoscaler (HPA)**

```term
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: shop }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: shop }
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 60 }
```

- Utilization is measured **relative to the CPU request**. No request → the HPA cannot compute it (`<unknown>`) and does nothing.
- It scales up quickly and scales down slowly (a stabilization window, 5 minutes by default) to avoid flapping.
- Needs a metrics source (metrics-server) and pods that can start fast.

**StatefulSets and PersistentVolumeClaims**

- A **PersistentVolumeClaim** (PVC) asks for storage ("1Gi, ReadWriteOnce"); the cluster binds a volume to it. Data on it survives pod restarts and rescheduling.
- A **StatefulSet** gives pods **stable names** (`db-0`, `db-1`), starts them in order, and creates one PVC per pod from `volumeClaimTemplates`. Paired with a Service, `db-0.db` is a stable DNS name.
- Many teams run production databases as managed cloud services and keep StatefulSets for things like caches, queues and dev/test databases.

## commands | Scaling and storage

```term
$ kubectl autoscale deployment shop --min=2 --max=10 --cpu-percent=60
$ kubectl get hpa                            # TARGETS shows current/target utilization
$ kubectl describe hpa shop                  # scaling events and reasons
$ kubectl top pods
$ kubectl get statefulset,pvc
$ kubectl exec db-0 -- psql -U postgres -c "SELECT 1"
$ kubectl delete pod db-0                    # comes back as db-0, same volume
```

## analogy | Checkout lanes and safety-deposit boxes

When the queue grows, a supermarket opens more checkout lanes; any cashier can serve any customer (stateless pods, HPA). The bank's safety-deposit boxes are different: box 17 always belongs to the same customer, and if the clerk changes, the box and its contents stay put (StatefulSet with its PVC).

## team | Scaling habits

- **Load-test** to find a sensible CPU target and max replicas before relying on the HPA.
- **Requests must be set** for anything autoscaled.
- **Back up volumes** and practise restores; a PVC is durable, not backed up.
- **Prefer managed databases** for production data unless you have strong reasons and skills to run them.

## traps | Scaling traps

**HPA on a Deployment without CPU requests**: TARGETS stays `<unknown>`.

**Setting `replicas:` in the manifest and also using an HPA**: every apply resets the replica count. Leave `replicas` out once an HPA owns it.

**Database as a Deployment with no volume**: data lost on every reschedule.

**Deleting a namespace "to clean up"**: its PVCs, and the data on them, go too.

## lab | Ready for the sale

Give the shop's database stable storage, prove it survives a restart, then let the shop scale itself under load.
