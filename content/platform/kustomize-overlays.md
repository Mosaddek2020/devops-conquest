## story | "Just change the namespace and replicas"

Lumen's staging and production manifests started as one copy-paste. A year later they differed in 140 lines, and nobody knew which differences were deliberate. A memory limit added to staging during an incident never reached production. Production's replica count was edited by hand and lost on the next deploy.

**Kustomize** keeps one **base** of plain manifests and a small **overlay** per environment that says only what differs: the namespace, the replica count, the image tag, a resource limit, a config value. There is no templating language: the base is valid YAML you can apply on its own, and the overlay is a list of patches. It is built into kubectl (`kubectl apply -k`).

## model | A base and overlays

```diagram
kustomize-overlays
```

- A directory with a **`kustomization.yaml`** is a kustomization. `resources:` lists manifests or other kustomizations (`../../base`).
- An **overlay** builds on the base and transforms it:
  - `namespace:` puts everything in one namespace; `namePrefix:` renames objects (and fixes references).
  - `replicas:` and `images:` (`newTag`, `newName`, `digest`) change counts and images without touching the Deployment.
  - `patches:` merge a partial manifest into matching objects (strategic merge), or apply JSON patch operations (`op: add`, `path: …`).
  - `labels:` adds labels to every object.
- **`configMapGenerator`** builds a ConfigMap from literals or files and appends a **hash of its content** to the name (`shop-config-5bk8g7c2m4`). Every reference is rewritten. Change a value, and the name changes, so the Deployment's pod template changes and **pods roll automatically** to pick up the new config.
- `kubectl kustomize DIR` prints the result; `kubectl diff -k DIR` compares it with the cluster; `kubectl apply -k DIR` applies it.

## commands | Build, diff, apply

```term
$ kubectl kustomize overlays/prod             # what would be applied
$ kubectl diff -k overlays/prod               # what would change in the cluster
$ kubectl apply -k overlays/prod
$ cd overlays/staging && kustomize edit set image ghcr.io/lumen/shop:2.1   # how CI bumps a tag
```

```yaml
# overlays/prod/kustomization.yaml
namespace: shop-prod
resources:
  - ../../base
replicas:
  - name: shop
    count: 3
images:
  - name: ghcr.io/lumen/shop
    newTag: "2.0"
configMapGenerator:
  - name: shop-config
    behavior: merge
    literals:
      - LOG_LEVEL=warn
patches:
  - path: limits.yaml
```

## analogy | Tracing paper

The base is a drawing; each overlay is a sheet of tracing paper on top with a few changes pencilled in. You never redraw the whole picture for each environment, and you can always lift the sheet to see which marks are environment-specific.

## team | Kustomize in a team

- **The base must work on its own** (for a laptop or a test cluster). Overlays hold only the differences, so a review of `overlays/prod` shows everything special about production.
- **Review the rendered output.** CI runs `kubectl kustomize` (or `kubectl diff -k` against staging) and posts the result on the pull request.
- **Let CI bump image tags** with `kustomize edit set image` and commit, rather than editing YAML with sed.
- **Helm or Kustomize?** Kustomize for your own services (plain YAML, small patches), Helm for installing third-party software. They combine: Argo CD can render either.

## traps | Kustomize traps

**Editing generated names by hand.** `shop-config-5bk8g7c2m4` changes on every config change: refer to `shop-config` and let Kustomize fill in the suffix.

**Overlays that copy the base.** If an overlay repeats a whole Deployment, the copy drifts; patch only the fields that differ.

**`commonLabels` changes selectors.** Adding a label to selectors of an existing Deployment is an immutable-field error; prefer `labels:` without `includeSelectors`.

**Forgetting the generator's `behavior: merge`** in an overlay creates a second ConfigMap instead of changing the base's.

## lab | One base, two environments

The shop's manifests live in `~/shop-k8s` as a base plus a staging overlay. Build them, create the production overlay, preview and apply it, change production's configuration and watch the pods roll, and move staging to the new image while production stays put.
