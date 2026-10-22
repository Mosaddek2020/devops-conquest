## story | The password in the image

Lumen's first Kubernetes manifests had `DATABASE_URL: postgres://shop:hunter2@db/shop` written straight into the Deployment, in git, readable by every developer and every CI log. When the database password had to be rotated, the team discovered it was also baked into two images and a Helm values file nobody remembered.

Configuration changes between environments and secrets need tighter control than code. Kubernetes separates them from the image and from the Deployment: **ConfigMaps** for ordinary settings and **Secrets** for sensitive ones, injected into pods as environment variables or files.

## model | ConfigMaps, Secrets and how pods see them

```term
apiVersion: v1
kind: ConfigMap
metadata: { name: menu-config }
data:
  LOG_LEVEL: info
  FEATURE_SPECIALS: "true"
---
apiVersion: v1
kind: Secret
metadata: { name: menu-db }
type: Opaque
stringData:                     # written as plain text, stored base64-encoded in data:
  url: postgres://menu:s3cret@db:5432/menu
```

```term
containers:
  - name: menu
    envFrom:
      - configMapRef: { name: menu-config }      # every key becomes an env var
    env:
      - name: DATABASE_URL
        valueFrom:
          secretKeyRef: { name: menu-db, key: url }
    volumeMounts:
      - name: config
        mountPath: /etc/menu                     # or as files
volumes:
  - name: config
    configMap: { name: menu-config }
```

- **base64 is encoding, not encryption.** Anyone who can read the Secret object can decode it. Protect Secrets with access control (RBAC), encryption at rest, and keep them out of git (or encrypt them there with Sealed Secrets / SOPS, or pull them from a vault).
- Environment variables are read **when the container starts**. After changing a ConfigMap or Secret used as env, restart the pods: `kubectl rollout restart deployment/menu`.
- A pod referencing a missing Secret or key does not start: `CreateContainerConfigError`.

## commands | Managing configuration

```term
$ kubectl create configmap menu-config --from-literal=LOG_LEVEL=info --from-file=menu.json
$ kubectl create secret generic menu-db --from-literal=url='postgres://…'
$ kubectl get secret menu-db -o jsonpath='{.data.url}' | base64 -d
$ kubectl describe secret menu-db              # shows keys and sizes, not values
$ kubectl rollout restart deployment/menu      # pick up new env values
$ kubectl exec deploy/menu -- printenv LOG_LEVEL
$ kubectl create secret docker-registry regcred --docker-server=… --docker-username=… --docker-password=…
```

## analogy | Keys at the front desk

A hotel does not engrave room codes into the doors (the image). The front desk (Kubernetes) hands each guest the right key card (Secret) and the welcome letter with Wi-Fi details (ConfigMap) at check-in (container start). Change the Wi-Fi password and guests already in their rooms still hold the old letter until they check in again (restart).

## team | Configuration habits

- **Same image everywhere; environments differ only in ConfigMaps and Secrets.**
- **Secrets never in git in plain text**, never in images, never in logs.
- **Least privilege**: most people need to read Deployments, few need to read Secrets.
- **Rotate** credentials on a schedule and whenever someone with access leaves.

## traps | Configuration traps

**"It's in a Secret, so it's encrypted."** It is base64.

**Changing a ConfigMap and expecting running pods to notice** env changes. They don't until restarted.

**Typos in key names**: `CreateContainerConfigError: couldn't find key`.

**An AI assistant "helpfully" putting the real password into the YAML it writes for you.**

## lab | Configure the menu service

Move the menu service's settings into a ConfigMap and its database password into a Secret, then change a setting and roll it out.
