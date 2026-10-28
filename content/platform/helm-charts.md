## story | Seventeen copies of the same YAML

By its third year Lumen ran the shop, the menu, the reports service and a dozen more on Kubernetes. Every service had a folder of YAML copied from the shop's, with names changed by hand. When the platform team wanted every service to get a readiness probe, they opened seventeen pull requests. When someone needed Redis, they copied a 600-line StatefulSet from a blog post.

**Helm** is Kubernetes' package manager. A **chart** is a parameterised package of manifests: the shop's Deployment, Service and Ingress written once, with the parts that differ (image tag, replica count, hostname, resources) pulled out into **values**. You install a chart as a named **release**, upgrade it with new values, and roll it back when an upgrade goes wrong. Thousands of ready-made charts (databases, ingress controllers, Argo CD, Kyverno) install the same way.

## model | Charts, values and releases

```diagram
helm-release
```

- A **chart** is a directory: `Chart.yaml` (name, version, appVersion), `values.yaml` (the defaults) and `templates/` (manifests with Go-template placeholders like `{{ .Values.replicaCount }}`). Helpers in `_helpers.tpl` keep names and labels consistent.
- **Values** come from layers: the chart's `values.yaml`, then each `-f file.yaml` in order, then each `--set key=value`. Later layers win.
- `helm install NAME CHART` renders the templates and applies the result. That named, versioned installation is a **release**; Helm stores every revision as a Secret in the release's namespace.
- `helm upgrade` makes revision 2, 3… `helm history` lists them and `helm rollback NAME REV` re-applies an old revision (as a new one).
- `--wait` makes Helm wait until Deployments are ready; `--atomic` also **rolls back automatically** if they never get there. Without them, "deployed" only means "the API server accepted the YAML".
- **Chart repositories** (`helm repo add`) host published charts; `helm search repo` and `helm show values` tell you what you can configure before you install.

## commands | Everyday Helm

```term
$ helm repo add bitnami https://charts.bitnami.com/bitnami
$ helm search repo redis
$ helm show values bitnami/redis | less              # every knob, with comments
$ helm install cache bitnami/redis -n shop --create-namespace --set master.persistence.size=1Gi --wait
$ helm template shop ./charts/shop -f values-prod.yaml   # render locally, apply nothing
$ helm lint ./charts/shop
$ helm upgrade shop ./charts/shop -n shop -f values-prod.yaml --set image.tag=2.1 --atomic --timeout 2m
$ helm history shop -n shop
$ helm rollback shop 1 -n shop
$ helm get values shop -n shop                       # what was this release installed with?
$ helm list -A
```

A template, and what it renders to:

```yaml
# templates/deployment.yaml
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          {{- with .Values.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
```

## analogy | A recipe with blanks

A chart is a recipe card with blanks: "bake for ___ minutes, serves ___". Values fill in the blanks for tonight's dinner. The release is the meal you actually served, written in a logbook with what you put in the blanks, so you can cook the previous version again if tonight's goes wrong.

## team | Helm in a team

- **Keep values files in git**, one per environment (`values-staging.yaml`, `values-prod.yaml`), and upgrade with `-f`. A long `--set` command line in someone's shell history is not a record.
- **Pin chart versions** (`--version 20.2.1`) for third-party charts, and read the changelog before bumping them.
- **Always `--atomic` (or `--wait`) in pipelines**, so a broken release is rolled back instead of left half-done.
- **`helm template` in review**: render the chart in CI and look at the YAML diff, the same as any other change.
- Write your own chart when several services share a shape; for one-off apps, plain manifests with Kustomize are often simpler.

## traps | Helm traps

**`helm upgrade --set x=y` silently drops your other values.** An upgrade starts again from the chart's defaults plus what you pass *this time*. Pass the same `-f values-prod.yaml` every time, or use `--reuse-values` deliberately.

**"STATUS: deployed" without `--wait`.** It only means the manifests were accepted. Pods may be crash-looping.

**Secrets in values files.** Values are stored in the release Secret and often in git. Reference existing Secrets instead.

**Editing a Helm-managed object with kubectl.** The next upgrade overwrites your change, or fails because of it.

## lab | Package it, ship it, roll it back

Lumen's shop now has a Helm chart in `~/charts/shop` and production values in `~/values-prod.yaml`. Install a cache from a public chart, release the shop with the production values, survive a bad upgrade, and find out what `--set` alone does to a release.
