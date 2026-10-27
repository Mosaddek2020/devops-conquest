## story | One line of Terraform

A pull request opened SSH to the world "temporarily, for debugging": `cidr_blocks = ["0.0.0.0/0"]` on port 22. It was approved because the diff was one line in a 400-line plan. Six months later the server was brute-forced through a forgotten test account.

Most cloud breaches are not clever exploits; they are **misconfigurations**: open security groups, public buckets, unencrypted disks, containers running as root. Because infrastructure is now code, those mistakes can be caught the same way as code bugs.

## model | Scanning infrastructure as code

- **Misconfiguration scanners** (trivy config, Checkov, KICS, tfsec) check Terraform, Kubernetes manifests and Dockerfiles against hundreds of rules, each with an ID (for example `AVD-AWS-0107`: ingress from `/0`), a severity and a fix.
- **Fix the high-severity findings**, and **accept** the rest explicitly. An accepted risk is written next to the code with a reason:
  `#trivy:ignore:AVD-AWS-0107 public HTTPS for the website, reviewed 2026-03`
  so reviewers see it and it is revisited.
- **Common fixes:**
  - SSH from your office or VPN CIDR only (or no SSH at all: use SSM or a bastion).
  - S3 buckets with encryption, versioning and a public access block.
  - EC2 with IMDSv2 required (`http_tokens = "required"`) and encrypted root volumes.
  - Dockerfiles with a pinned base, a non-root `USER`, and no secrets in `ENV`.
- **Policy as code** goes further: your own rules (in Rego for OPA/conftest, or Kyverno policies in a cluster) such as "every resource has an owner tag".

## commands | Scan, fix, accept with a reason

```term
$ trivy config .
$ trivy config --severity HIGH,CRITICAL infra/
$ terraform validate && terraform plan
$ trivy config --exit-code 1 --severity HIGH,CRITICAL .
```

## analogy | A building inspector for blueprints

Inspecting a finished building finds problems that are expensive to fix. An inspector who checks the blueprints catches the missing fire exit while it is still a line on paper.

## team | Making misconfig scanning stick

- **Scan in the pull request**, where the one-line change is visible and cheap to fix.
- **Gate on HIGH and CRITICAL**, report the rest, and tighten over time.
- **Every ignore has a reason, a reviewer and a date**: accepted risk expires.
- **Scan the plan, not just the code**, when modules or variables decide the real values.

## traps | Misconfiguration traps

**Ignoring a whole rule globally** because one resource legitimately needs it.

**"Temporary" exceptions** without an expiry date.

**Fixing in the console** instead of the code: the next apply reverts it (drift).

**Hundreds of LOW findings** drowning the one CRITICAL.

## lab | The infrastructure review

The `infra/` folder holds Terraform for the shop and a Kubernetes manifest and Dockerfile for its API. Scan it, fix the dangerous findings, and accept one risk the right way.
