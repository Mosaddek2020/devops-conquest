// The chart repositories the simulated internet serves. Each chart is a real chart layout
// (Chart.yaml, values.yaml, templates/). Operator charts (Argo CD, Kyverno, External
// Secrets, ingress-nginx) install their CRDs through templates and register a hook that
// starts the operator itself in the cluster.

export const CHART_HOOKS = {};   // 'argo/argo-cd' -> { after(cl, rel), uninstall(cl, rel) }

const chartYaml = (name, version, appVersion, description) => `apiVersion: v2\nname: ${name}\ndescription: ${description}\ntype: application\nversion: ${version}\nappVersion: "${appVersion}"\n`;
export function crdYaml({ kind, group, plural, singular, shortNames = [], scope = 'Namespaced', versions = ['v1alpha1'] }) {
  return [`apiVersion: apiextensions.k8s.io/v1`, `kind: CustomResourceDefinition`, `metadata:`, `  name: ${plural}.${group}`, `spec:`, `  group: ${group}`, `  names:`, `    kind: ${kind}`, `    plural: ${plural}`, `    singular: ${singular || kind.toLowerCase()}`, ...(shortNames.length ? [`    shortNames: [${shortNames.join(', ')}]`] : []), `  scope: ${scope}`, `  versions:`, ...versions.flatMap((v, i) => [`    - name: ${v}`, `      served: true`, `      storage: ${i === versions.length - 1}`])].join('\n') + '\n';
}

const chart = (name, version, appVersion, description, values, templates, extra = {}) => ({ meta: { apiVersion: 'v2', name, version, appVersion, description }, files: { 'Chart.yaml': chartYaml(name, version, appVersion, description), 'values.yaml': values, ...Object.fromEntries(Object.entries(templates).map(([k, v]) => [`templates/${k}`, v])), ...extra } });

// ---------------------------------------------------------------- bitnami/redis
const REDIS_VALUES = `## Redis(R) architecture: standalone or replication
architecture: standalone

auth:
  ## Enable password authentication
  enabled: true
  ## Leave empty to generate a random password (stored in a Secret)
  password: ""

image:
  repository: redis
  tag: "7"

master:
  resources: {}
  persistence:
    enabled: true
    size: 8Gi

replica:
  replicaCount: 3
`;
const REDIS_HELPERS = `{{- define "redis.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{ else }}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{ end }}
{{- end }}
{{- define "redis.labels" -}}
app.kubernetes.io/name: redis
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
`;
const REDIS = chart('redis', '20.2.1', '7.4.1', 'Redis(R) is an open source, advanced key-value store.', REDIS_VALUES, {
  '_helpers.tpl': REDIS_HELPERS,
  'secret.yaml': `{{- if .Values.auth.enabled }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "redis.fullname" . }}
  labels:
    {{- include "redis.labels" . | nindent 4 }}
type: Opaque
data:
  redis-password: {{ default (randAlphaNum 10) .Values.auth.password | b64enc | quote }}
{{- end }}
`,
  'master.yaml': `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "redis.fullname" . }}-master
  labels:
    {{- include "redis.labels" . | nindent 4 }}
    app.kubernetes.io/component: master
spec:
  replicas: 1
  serviceName: {{ include "redis.fullname" . }}-headless
  selector:
    matchLabels:
      {{- include "redis.labels" . | nindent 6 }}
      app.kubernetes.io/component: master
  template:
    metadata:
      labels:
        {{- include "redis.labels" . | nindent 8 }}
        app.kubernetes.io/component: master
    spec:
      containers:
        - name: redis
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
            - name: redis
              containerPort: 6379
          {{- if .Values.auth.enabled }}
          env:
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ include "redis.fullname" . }}
                  key: redis-password
          {{- end }}
          {{- with .Values.master.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
  {{- if .Values.master.persistence.enabled }}
  volumeClaimTemplates:
    - metadata:
        name: redis-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.master.persistence.size | quote }}
  {{- end }}
`,
  'replicas.yaml': `{{- if eq .Values.architecture "replication" }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "redis.fullname" . }}-replicas
  labels:
    {{- include "redis.labels" . | nindent 4 }}
    app.kubernetes.io/component: replica
spec:
  replicas: {{ .Values.replica.replicaCount }}
  serviceName: {{ include "redis.fullname" . }}-headless
  selector:
    matchLabels:
      {{- include "redis.labels" . | nindent 6 }}
      app.kubernetes.io/component: replica
  template:
    metadata:
      labels:
        {{- include "redis.labels" . | nindent 8 }}
        app.kubernetes.io/component: replica
    spec:
      containers:
        - name: redis
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
            - name: redis
              containerPort: 6379
{{- end }}
`,
  'services.yaml': `apiVersion: v1
kind: Service
metadata:
  name: {{ include "redis.fullname" . }}-master
  labels:
    {{- include "redis.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  ports:
    - name: tcp-redis
      port: 6379
      targetPort: redis
  selector:
    {{- include "redis.labels" . | nindent 4 }}
    app.kubernetes.io/component: master
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "redis.fullname" . }}-headless
  labels:
    {{- include "redis.labels" . | nindent 4 }}
spec:
  clusterIP: None
  ports:
    - name: tcp-redis
      port: 6379
      targetPort: redis
  selector:
    {{- include "redis.labels" . | nindent 4 }}
`,
  'NOTES.txt': `CHART NAME: {{ .Chart.Name }}
CHART VERSION: {{ .Chart.Version }}
APP VERSION: {{ .Chart.AppVersion }}

** Please be patient while the chart is being deployed **

Redis can be accessed via port 6379 on the following DNS name from within your cluster:

    {{ include "redis.fullname" . }}-master.{{ .Release.Namespace }}.svc.cluster.local
{{- if .Values.auth.enabled }}

To get your password run:

    export REDIS_PASSWORD=$(kubectl get secret --namespace {{ .Release.Namespace }} {{ include "redis.fullname" . }} -o jsonpath="{.data.redis-password}" | base64 -d)
{{- end }}
`,
}, { 'README.md': '# Redis(R) packaged by Bitnami\n\nRedis(R) is an open source, advanced key-value store.\n\n## Parameters\n\n| Name | Description | Value |\n|------|-------------|-------|\n| architecture | standalone or replication | standalone |\n| auth.enabled | Enable password authentication | true |\n| auth.password | Redis password (empty: generated) | "" |\n| master.persistence.size | Size of the data volume | 8Gi |\n| replica.replicaCount | Number of replicas (replication mode) | 3 |\n' });

// ---------------------------------------------------------------- operator charts
const ops = (name, version, appVersion, description, values, crds, extraTemplates = {}) => chart(name, version, appVersion, description, values, { ...Object.fromEntries(crds.map(c => [`crds/${c.plural}.yaml`, crdYaml(c)])), ...extraTemplates });

export const ARGO_CRDS = [
  { kind: 'Application', group: 'argoproj.io', plural: 'applications', shortNames: ['app', 'apps'] },
  { kind: 'ApplicationSet', group: 'argoproj.io', plural: 'applicationsets', shortNames: ['appset', 'appsets'] },
  { kind: 'AppProject', group: 'argoproj.io', plural: 'appprojects', shortNames: ['appproj', 'appprojs'] },
];
export const KYVERNO_CRDS = [
  { kind: 'ClusterPolicy', group: 'kyverno.io', plural: 'clusterpolicies', shortNames: ['cpol'], scope: 'Cluster', versions: ['v1'] },
  { kind: 'Policy', group: 'kyverno.io', plural: 'policies', shortNames: ['pol'], versions: ['v1'] },
  { kind: 'PolicyReport', group: 'wgpolicyk8s.io', plural: 'policyreports', shortNames: ['polr'], versions: ['v1alpha2'] },
  { kind: 'ClusterPolicyReport', group: 'wgpolicyk8s.io', plural: 'clusterpolicyreports', shortNames: ['cpolr'], scope: 'Cluster', versions: ['v1alpha2'] },
];
export const ESO_CRDS = [
  { kind: 'ExternalSecret', group: 'external-secrets.io', plural: 'externalsecrets', shortNames: ['es'], versions: ['v1beta1'] },
  { kind: 'SecretStore', group: 'external-secrets.io', plural: 'secretstores', shortNames: ['ss'], versions: ['v1beta1'] },
  { kind: 'ClusterSecretStore', group: 'external-secrets.io', plural: 'clustersecretstores', shortNames: ['css'], scope: 'Cluster', versions: ['v1beta1'] },
];

const ARGO = ops('argo-cd', '7.7.0', 'v2.13.0', 'A Helm chart for Argo CD, a declarative, GitOps continuous delivery tool for Kubernetes.', `## Argo CD configuration
global:
  domain: argocd.example.com

configs:
  params:
    # Run the API server without TLS (put it behind an ingress that terminates TLS)
    server.insecure: false

server:
  replicas: 1

controller:
  # How often Argo CD polls git for changes (a webhook makes it immediate)
  timeout.reconciliation: 180s
`, ARGO_CRDS, { 'NOTES.txt': `In order to access the server UI you have the following options:

1. kubectl port-forward service/{{ .Release.Name }}-server -n {{ .Release.Namespace }} 8080:443

    and then open the browser on http://localhost:8080 and accept the certificate

After reaching the UI the first time you can login with username: admin and the random password generated during the installation. You can find the password by running:

kubectl -n {{ .Release.Namespace }} get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d

(You should delete the initial secret afterwards as suggested by the Getting Started Guide: https://argo-cd.readthedocs.io/en/stable/getting_started/#4-login-using-the-cli)
` });
const KYVERNO = ops('kyverno', '3.3.0', 'v1.13.0', 'Kubernetes Native Policy Management', `admissionController:
  replicas: 1
backgroundController:
  enabled: true
reportsController:
  enabled: true
`, KYVERNO_CRDS, { 'NOTES.txt': `Chart version: {{ .Chart.Version }}
Kyverno version: {{ .Chart.AppVersion }}

Thank you for installing kyverno! Your release is named {{ .Release.Name }}.

The following components have been installed in your cluster:
- CRDs
- Admission controller
- Reports controller
- Background controller

⚠️  WARNING: Setting the admission controller replica count below 2 means Kyverno is not running in high availability mode.

💡 Note: There is a trade-off when deciding which approach to take regarding Namespace exclusions. Please see the documentation at https://kyverno.io/docs/installation/#security-vs-operability to understand the risks.
` });
const ESO = ops('external-secrets', '0.10.5', 'v0.10.5', 'External secret management for Kubernetes', `installCRDs: true
replicaCount: 1
`, ESO_CRDS, { 'NOTES.txt': `external-secrets has been deployed successfully in namespace {{ .Release.Namespace }}!

In order to begin using ExternalSecrets, you will need to set up a SecretStore
or ClusterSecretStore resource (for example, by creating a 'vault' SecretStore).

More information on the different types of SecretStores and how to configure them
can be found in our Github: https://github.com/external-secrets/external-secrets
` });
const INGRESS = chart('ingress-nginx', '4.11.3', '1.11.3', 'Ingress controller for Kubernetes using NGINX as a reverse proxy and load balancer', `controller:
  replicaCount: 1
  service:
    type: LoadBalancer
`, { 'NOTES.txt': `The ingress-nginx controller has been installed.
It may take a few minutes for the load balancer IP to be available.
You can watch the status by running 'kubectl get service --namespace {{ .Release.Namespace }} {{ .Release.Name }}-controller --output wide --watch'
` });

export const REPOS = {
  bitnami: { key: 'bitnami', url: 'https://charts.bitnami.com/bitnami', charts: { redis: REDIS } },
  argo: { key: 'argo', url: 'https://argoproj.github.io/argo-helm', charts: { 'argo-cd': ARGO } },
  kyverno: { key: 'kyverno', url: 'https://kyverno.github.io/kyverno', charts: { kyverno: KYVERNO } },
  'external-secrets': { key: 'external-secrets', url: 'https://charts.external-secrets.io', charts: { 'external-secrets': ESO } },
  'ingress-nginx': { key: 'ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx', charts: { 'ingress-nginx': INGRESS } },
};

CHART_HOOKS['ingress-nginx/ingress-nginx'] = { after(cl) { cl.installIngress(); } };
