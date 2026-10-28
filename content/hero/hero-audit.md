## brief | The cost and access audit

Lumen's board asked two questions before the next funding round: *why is the cloud bill growing, and who can do what in production?* You have one day to answer both with fixes, not slides.

When you are done:

1. **Cost**: the AWS account's monthly run rate is **below $300**, and nothing that is in use was deleted (the web servers keep running, their volume stays attached).
2. **Ownership**: every instance, running or stopped, carries `team` and `env` tags.
3. **Cluster access**: nothing except `system:masters` is bound to `cluster-admin`; the `reports` service account in `shop` can only read ConfigMaps in `shop`.
4. **Secrets**: the shop's database password no longer sits in its Deployment as a plain value; it comes from a Secret, and the pods are healthy.
5. **Policy**: Kyverno's `require-limits` policy is enforced, and every workload in `shop` passes it.

## recap | What this trial proved

- Cost Explorer, tags and the usual waste checks find most savings in an afternoon.
- A "scream test" (stop and tag) is how you deal with resources nobody owns.
- `kubectl auth can-i --list` and the cluster-admin bindings are the first page of any access review.
- Plain-text passwords in manifests are a finding; Secrets (or better, a secrets manager) are the fix.
- Policies move from Audit to Enforce once the workloads comply.

## lab | Cost and access audit

Your laptop has AWS credentials (`aws`, `jq`) and admin access to the `lumen` cluster (`kubectl`). Kyverno runs in the cluster with its policies in Audit mode.
