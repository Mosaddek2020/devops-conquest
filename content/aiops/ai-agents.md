## story | "pg_wal is just old logs"

An engineer gave an ops agent a simple task: *free disk space on the database server*. The agent looked around, found 16 GB in `/var/lib/postgresql/16/main/pg_wal`, reasoned that "WAL files are transaction logs and safe to delete", and deleted them. PostgreSQL would not start again. The last good backup was nine hours old.

Agents are assistants that **act**: they plan commands and run them. That turns every wrong guess into a change on a real system. The answer is not to avoid agents but to run them like any powerful automation: **least privilege, approvals, guard rails and an audit log**.

```diagram
agent-guardrails
```

## model | Policies for agents

- **Plan before acting**: look at what the agent intends to run (`agent plan`), like `terraform plan`.
- **Allow** read-only commands (`df`, `du`, `ls`, `journalctl`, `systemctl status`) to run freely: investigation is where agents save the most time.
- **Ask** for anything that changes state; a human approves each step with its reason in view.
- **Deny** what must never happen without a human typing it: recursive deletes, `terraform destroy`, `kubectl delete ns`, touching database data directories.
- **Deny beats allow**: order matters, and the default for unknown commands should be *ask*, not *auto*.
- **Audit log**: every proposed, approved, rejected and denied command, with time and host, for the postmortem.
- **Scope the identity**: the agent's user and cloud role should only reach the systems for its task.

## commands | Plan, constrain, run, review

```term
$ agent plan "free disk space on db1"
$ nano ~/.agent/policy.yaml
$ agent policy
$ agent run "free disk space on db1"
$ agent log
```

## analogy | A new on-call engineer

On their first week, a new on-call engineer can look at anything, must ask before restarting or deleting, and is never given the command that drops the database. Their actions are in the incident log. An agent deserves the same onboarding, every day.

## team | Agents in operations

- **Start read-only**: an agent that only investigates and proposes is already valuable.
- **Policies in git**, reviewed like code; one per environment (stricter in production).
- **Break-glass, not default**: wider permissions only for a time-boxed task, with a ticket.
- **Review the audit log** in postmortems and when tuning the policy.

## traps | Agent traps

**Default mode "auto"**: every plan step runs, including the wrong ones.

**Allow-listing by command name only** (`sudo` allows everything).

**Approving without reading** because the first five steps were fine.

**No audit log**, so nobody can tell later what the agent changed.

## lab | Free the disk, keep the database

`db1` is almost out of disk. An ops agent is installed on your laptop. Look at its plan before it runs anything, write a policy that lets it investigate freely, asks before changes and never touches PostgreSQL's data, then let it do the job and review the log.
