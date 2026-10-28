## story | The wiki page nobody read

Lumen's platform wiki had a page called "Kubernetes rules": always set memory limits, never deploy `:latest`, every workload needs a team label. A node ran out of memory because a new service had no limits. A rollback "rolled back" to a different image because `:latest` had moved. Every rule was on the wiki; none of them was checked.

**Policy as code** writes those rules as files in git and makes machines enforce them. **Kyverno** (or OPA Gatekeeper) runs inside the cluster as an **admission controller**: every create or update passes through it, and it can deny, warn or record. The same policy files run in CI with the `kyverno` CLI, so a pull request learns it breaks a rule minutes after it is opened, not when it reaches the cluster.

## model | Policies at the gate and in the pipeline

```diagram
admission-flow
```

- A Kyverno **ClusterPolicy** (or namespaced **Policy**) holds **rules**. Each rule **matches** resources (kinds, namespaces, labels), optionally **excludes** some, and **validates** them with a **pattern** (or mutates or generates objects).
- Patterns look like the resource: `memory: "?*"` means "must be set to something"; `image: "!*:latest"` means "must not end in :latest"; `=(key)` means "if present, must match".
- Rules written for **Pods** automatically cover Deployments, StatefulSets and Jobs (Kyverno's **autogen**), checking their pod templates.
- **`validationFailureAction: Audit`** lets the request through and records the result in a **PolicyReport**. **`Enforce`** denies it with the rule's message.
- Roll out new rules in **Audit** first, read the reports, fix what is already running, then switch to **Enforce**.
- **Shift left**: `kyverno apply policies/ --resource k8s/` runs the same checks on files and exits non-zero on failures, so CI can block a pull request.

## commands | Write, test, enforce

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-limits
spec:
  validationFailureAction: Audit      # later: Enforce
  rules:
    - name: check-limits
      match:
        any:
          - resources:
              kinds: [Pod]
      validate:
        message: "CPU and memory limits are required."
        pattern:
          spec:
            containers:
              - resources:
                  limits:
                    memory: "?*"
                    cpu: "?*"
```

```term
$ helm install kyverno kyverno/kyverno -n kyverno --create-namespace
$ kyverno apply policies/ --resource k8s/      # test files, no cluster needed
$ kubectl apply -f policies/
$ kubectl get policyreport -A                  # Audit results for what is running
$ kubectl get clusterpolicy
```

A denied request reads like this:

```term
Error from server: error when creating "debug.yaml": admission webhook "validate.kyverno.svc-fail" denied the request:

resource Deployment/default/debug was blocked due to the following policies

disallow-latest-tag:
  autogen-require-image-tag: 'validation error: An image tag is required and it must not be latest. ...'
```

## analogy | Building codes and inspectors

A building code is written down once. The architect's software checks the plans against it before construction (CI), and the inspector checks the building on site (admission). Nobody relies on every builder having read the code.

## team | Policy in a team

- **Policies live in git and go through review**, like any code. Platform and security teams own them; application teams can read why a rule exists in its message.
- **Messages explain the fix**, not just the failure: "Set resources.limits.memory; see the sizing guide".
- **Audit, measure, then enforce.** Turning on Enforce for a rule that half the workloads break is an outage.
- **Exceptions are explicit and expire**: exclude a namespace or a named resource in the policy, with a ticket and a date, never by turning the policy off.
- **One rule set for CI and cluster**, so passing CI means passing admission.

## traps | Policy traps

**Enforce on day one** blocks deploys (including rollbacks during an incident).

**Policies only in the cluster**: developers find out at deploy time, after review and merge.

**Forgetting autogen.** Writing rules for Deployments and missing StatefulSets, Jobs and bare Pods; write for Pods and let autogen cover the controllers.

**Excluding too much.** `exclude: namespaces: ["*"]` has happened. Review exclusions like code.

## lab | Rules that check themselves

Lumen's rules (limits on every container, no `:latest`) are now files in `~/policies`, and the shop's manifests are in `~/k8s`. Install Kyverno, test the manifests against the policies, run the policies in Audit mode, fix the workloads, switch to Enforce, and add the same check to the deployment repository's CI.
