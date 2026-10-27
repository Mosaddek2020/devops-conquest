## story | Root in a container is still root

A team ran a third-party image as root with `privileged: true` "because it needed to read a device". A vulnerability in that image let an attacker escape to the node, and from the node read every Secret mounted into every pod on it, including the database password of an unrelated service.

Kubernetes runs whatever you ask it to, with whatever privileges you give it. **Pod Security Standards** decide, per namespace, how much a pod may ask for.

```diagram
pod-security
```

## model | Pod Security Standards and securityContext

- Three standard levels:
  - **privileged**: anything goes.
  - **baseline**: blocks known escalations (privileged containers, hostPath volumes, host namespaces).
  - **restricted**: hardened best practice for normal apps.
- **Pod Security Admission** enforces them with namespace labels: `pod-security.kubernetes.io/enforce=restricted`. You can also `warn` and `audit` before enforcing.
- Under **restricted**, every container needs a `securityContext` with:
  - `allowPrivilegeEscalation: false`
  - `capabilities: { drop: ["ALL"] }`
  - `runAsNonRoot: true` (and an image or `runAsUser` that is not root)
  - `seccompProfile: { type: RuntimeDefault }`
- **Enforcement happens when pods are created.** A Deployment that violates the policy is accepted, but its ReplicaSet cannot create pods: look for `FailedCreate` events.
- `readOnlyRootFilesystem: true`, resource limits and `automountServiceAccountToken: false` make a compromised pod far less useful to an attacker.
- **RBAC** gives each service account only the API permissions it needs; `kubectl auth can-i` checks them.

## commands | Enforce, debug, fix

```term
$ kubectl label ns shop pod-security.kubernetes.io/enforce=restricted
$ kubectl -n shop get deploy,rs,pods
$ kubectl -n shop get events --field-selector reason=FailedCreate
$ kubectl -n shop apply -f api.yaml
$ kubectl -n shop rollout status deploy/api
```

## analogy | House rules for guests

A namespace label is the house rule ("no shoes inside"). Guests who follow it come in; guests who do not are stopped at the door, however politely their host invited them.

## team | Rolling out pod security

- **Start with `warn`** on existing namespaces, fix the warnings, then switch to `enforce`.
- **Default new namespaces to restricted**; exceptions are separate namespaces with a reason.
- **Build images to run as non-root** (a numeric `USER` in the Dockerfile), so the securityContext is not a fight.
- **Scan manifests in CI** (trivy config) so violations are found before the cluster refuses them.

## traps | Pod security traps

**Thinking `kubectl apply` succeeded means it is running.** Check the ReplicaSet's events.

**`runAsNonRoot: true` on an image that runs as root**: the container fails with `CreateContainerConfigError` until the image or `runAsUser` changes.

**Labelling the namespace `privileged` to make the error go away.**

**Forgetting init containers and sidecars**: they need a securityContext too.

## lab | A restricted namespace

The `shop` namespace must run only restricted pods. Turn enforcement on, see what it refuses and why, and fix the API's manifest so it runs, and stays hardened.
