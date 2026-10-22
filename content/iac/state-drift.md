## story | Two applies at once

Priya and Kofi both ran `terraform apply` on the events infrastructure on the same afternoon, each from their own laptop with their own `terraform.tfstate`. Kofi's state didn't know about Priya's new load balancer, so his apply tried to create a second one, then failed half-way. Later, someone opened port 22 to the world in the console "for five minutes" and forgot. The code said one thing, the cloud another, and the two state files a third.

**State** is Terraform's memory. It must live in one shared place, be locked while someone changes it, and be compared with reality on every plan.

## model | State, backends, locking and drift

```diagram
tf-triangle
```

- The **state file** maps each resource address to a real object ID and its last known attributes. It often contains **secrets** (passwords, keys) in plain text.
- A **remote backend** keeps one shared state, for example in an S3 bucket:

```term
terraform {
  backend "s3" {
    bucket         = "lumen-tfstate"
    key            = "events/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "tf-locks"     # (or use_lockfile = true)
    encrypt        = true
  }
}
```

- `terraform init` moves existing local state into the new backend (it asks first).
- **Locking**: an apply takes a lock; a second apply waits or fails with "Error acquiring the state lock". `force-unlock` is only for locks you know are stale (the other person's run crashed), never to "get past" a colleague.
- **Drift**: every plan refreshes state from the real world. Changes made outside Terraform appear as "Objects have changed outside of Terraform". Then you decide: **revert** (apply the code) or **adopt** (change the code to match, then apply shows no changes).
- **`terraform import`** adopts an existing, hand-made resource into state. Write the resource block first; the next plan shows how far the code is from reality.
- Fix state with `terraform state mv` / `state rm`, never by editing the JSON.

## commands | State operations

```term
$ terraform init                                 # configure/migrate the backend
$ terraform state list
$ terraform state show aws_security_group.web
$ terraform plan                                 # refresh shows drift
$ terraform apply -refresh-only                  # accept reality into state only
$ terraform import aws_s3_bucket.assets lumen-assets-legacy
$ terraform state mv aws_instance.web aws_instance.app
$ terraform state rm aws_instance.old            # forget, don't destroy
$ terraform force-unlock <LOCK_ID>               # only for a stale lock
```

## analogy | A shared ledger

A shop's stock ledger must be one book, on one desk, written by one person at a time. If two clerks keep their own copies, the counts diverge. And if someone takes goods off the shelf without writing it down, the next stock-take (refresh) reveals the gap: you either restock (revert) or update the ledger (adopt).

## team | State habits

- **Remote state with locking from day one**, encrypted, with versioning on the bucket.
- **State access = production access**: restrict it, it contains secrets.
- **Drift is a signal**: find out who changed what and why (CloudTrail), then fix the process, not just the resource.
- **Scheduled `plan` runs** that alert on drift.

## traps | State traps

**Local state on a laptop**: lost laptop, lost infrastructure knowledge.

**`force-unlock` while a colleague's apply is running**: two writers, corrupted state.

**Reverting drift without asking**: the console change might have been an emergency fix.

**`terraform destroy` to "clean up" an imported resource**: it really deletes it.

## lab | Shared state and a surprise change

Move the events state to the shared S3 backend, wait out a colleague's lock properly, then detect and resolve a change someone made in the console, and adopt a hand-made bucket.
