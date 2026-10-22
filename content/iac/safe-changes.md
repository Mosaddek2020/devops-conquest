## story | "Plan: 1 to add, 0 to change, 1 to destroy"

A one-line change, renaming a database's `identifier` "to match our naming standard", produced a plan with `1 to destroy`. The reviewer skimmed it ("just a rename") and the pipeline applied it. Terraform replaced the database. The new one was empty. Restoring from backup took the evening.

The plan told the truth: `# forces replacement`. Nobody read it. Terraform gives you powerful brakes (plans you can save, lifecycle rules, targeted runs) but they only work if your process uses them.

## model | Reading plans and putting brakes on

- **Read the summary first**: any `destroy`? Then find each `-/+` and its `# forces replacement` line.
- **Saved plans**: `terraform plan -out=tfplan` then `terraform apply tfplan` applies exactly what was reviewed. If anything changed in between, Terraform refuses ("Saved plan is stale").
- **Lifecycle rules** in the resource:

```term
lifecycle {
  prevent_destroy       = true    # plan fails instead of deleting it
  create_before_destroy = true    # new one up before the old one goes
  ignore_changes        = [tags]  # someone else manages this attribute
}
```

- **`-target`** limits a run to some resources. It exists for emergencies; routine use leaves the rest of the config un-applied and drifting.
- **`-replace=ADDR`** deliberately re-creates one resource (instead of the old `taint`).
- **Review AI-written config** like any other code: least-privilege security groups (`0.0.0.0/0` on 22 or a database port is a red flag), no secrets in code, no `-auto-approve` for humans, sensible sizes.
- **In CI**: plan on every pull request and post it for review; apply only after merge, from the reviewed plan.

## commands | Safe workflow

```term
$ terraform plan -out=tfplan
$ terraform show tfplan                    # (real Terraform) review again
$ terraform apply tfplan
$ terraform plan -destroy                  # what would a destroy remove?
$ terraform apply -replace=aws_instance.web
$ ai explain "terraform apply -auto-approve"
```

## analogy | A pilot's checklist

Pilots don't skip the pre-flight checklist because they've flown the route a hundred times. The checklist (read the plan, check destroys, save the plan) catches the one time something is different. `prevent_destroy` is the guard over the eject button.

## team | Change policy

- **No `-auto-approve` on a human's terminal**; pipelines use saved plans.
- **Protected resources** (databases, state buckets, DNS zones) get `prevent_destroy`.
- **Two-person review** for plans that destroy or replace anything stateful.
- **Policy as code** (OPA, Sentinel, tfsec/trivy) to block known-bad patterns automatically.

## traps | Change traps

**"It's just a rename"**: renames often force replacement.

**Plans you didn't save**: the apply re-plans and may do something different.

**`-target` as a habit**: hides problems and leaves drift.

**Removing `prevent_destroy` "to unblock the pipeline"** without asking why it was there.

## lab | Review before you apply

A teammate (with help from an AI assistant) opened a change to the events infrastructure. Review its plan, catch the dangerous parts, protect what matters and apply only what was reviewed.
