## story | The deploy job that could delete the cluster

Lumen's CI deployed with a service account bound to `cluster-admin`, because "it kept getting forbidden errors". During a security review, someone noticed that any pull request able to change the CI workflow could read every Secret in the cluster (payment keys included) and delete any namespace. Nothing bad had happened yet; it was only a matter of time.

Kubernetes **RBAC** (role-based access control) decides what each identity may do. People, CI jobs and controllers all authenticate as *someone*; RBAC rules grant that someone specific **verbs** (get, list, create, patch, delete…) on specific **resources** (pods, deployments, secrets…), in a namespace or cluster-wide. Everything else is denied.

## model | Subjects, roles and bindings

```diagram
rbac-model
```

- **Subjects**: a **User** or **Group** (from the cluster's authentication: certificates, OIDC/SSO), or a **ServiceAccount** (an identity for software, `system:serviceaccount:<ns>:<name>`).
- A **Role** lists rules in one namespace: `apiGroups` (`""` core, `apps`, `networking.k8s.io`…), `resources`, `verbs`, optionally `resourceNames`. A **ClusterRole** is the same, cluster-wide (or reusable in many namespaces).
- A **RoleBinding** grants a Role (or a ClusterRole) to subjects **in one namespace**. A **ClusterRoleBinding** grants a ClusterRole everywhere.
- Built-in ClusterRoles: `view` (read, but not Secrets), `edit` (change workloads), `admin` (also RBAC in the namespace), `cluster-admin` (everything, everywhere).
- RBAC is **additive, deny by default**: there are no "deny" rules, only grants.
- **Check, don't guess**: `kubectl auth can-i VERB RESOURCE -n NS --as SUBJECT` answers yes/no; `--list` shows everything a subject can do; `kubectl auth whoami` tells you who you are.

## commands | Least privilege for a deployer

```term
$ kubectl create serviceaccount shop-deployer -n shop
$ kubectl create role deployer -n shop --verb=get,list,watch,create,update,patch --resource=deployments.apps,services,configmaps
$ kubectl create rolebinding shop-deployer -n shop --role=deployer --serviceaccount=shop:shop-deployer
$ kubectl auth can-i patch deployments -n shop --as system:serviceaccount:shop:shop-deployer
yes
$ kubectl auth can-i get secrets -n shop --as system:serviceaccount:shop:shop-deployer
no
$ kubectl create token shop-deployer -n shop --duration=1h       # a short-lived token for CI
$ kubectl get clusterrolebindings -o wide | grep cluster-admin     # who has the keys?
$ kubectl create rolebinding samir-view -n shop --clusterrole=view --user=samir
```

## analogy | Keycards, not master keys

A hotel gives each guest a keycard for one room and the gym, and staff cards for the floors they clean. Nobody gets the master key "because it is easier". A Role is the list of doors; a binding hands that list to a person or a machine.

## team | Access in a team

- **One service account per workload or pipeline**, never `default`, and never shared.
- **Bind groups from your identity provider**, not individual users: joining or leaving the team then needs no cluster change.
- **Read access for humans, write access for automation** (CI or, better, GitOps). Break-glass admin access is time-limited and logged.
- **Review `cluster-admin` bindings** regularly; each one needs a reason.
- **Short-lived tokens** (`kubectl create token --duration`) or cloud workload identity, not long-lived token Secrets.

## traps | RBAC traps

**`cluster-admin` to silence a forbidden error.** Read the error: it names the user, verb, resource and API group you need. Grant exactly that.

**Forgetting the API group.** `deployments` live in `apps`; a rule with `apiGroups: [""]` will not match them.

**`list secrets` is "read all secrets".** Listing returns the values. Grant it rarely.

**RoleBinding to a ClusterRole is fine** (it is scoped to the namespace); a ClusterRoleBinding to the same role is not.

**`pods/exec` is shell access** to everything the pod can reach.

## lab | Keys for the deploy job

The CI service account `ci/deployer` is cluster-admin. Measure what that means, build a deployer identity that can only manage the shop's workloads, deploy with it from its own kubeconfig context, prove what it cannot do, then remove the dangerous binding and give Samir read-only access.
