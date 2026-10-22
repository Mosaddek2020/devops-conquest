## story | The restart that took the shop down

Lumen's runbook for "shop is leaking memory" said: *SSH into each web server and restart the shop.* At 2 a.m. a tired engineer restarted both servers at the same moment. For forty seconds both were starting up and the shop returned 502 to everyone. The runbook was right, but a human executing it under stress was not.

**Runbooks** document how to handle known situations. The best ones are **automated**: scripts that encode the safe way (one server at a time, check health before continuing, stop on the first problem) and can be dry-run first. Repetitive manual operational work that could be automated is called **toil**.

## model | Safe operational automation

- **Idempotent**: running it twice is safe.
- **One at a time** (rolling) with a **health check** between steps; **stop on failure** (`set -euo pipefail`).
- **Dry-run mode** (`--dry-run`) prints what would happen, changes nothing.
- **Bounded waits**: retry health checks with a limit, then fail loudly.
- **Logged**: say what you do, so the incident timeline writes itself.
- In the age of AI, assistants are great at drafting such scripts and terrible at knowing your blast radius: you own the safety checks.

```term
#!/usr/bin/env bash
set -euo pipefail
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
for host in web1 web2; do
  echo "restarting shop on $host"
  if (( DRY )); then continue; fi
  ssh "ubuntu@$host" sudo systemctl restart shop
  for i in $(seq 1 30); do
    curl -sf "http://$host:3000/health" >/dev/null && break
    [[ $i == 30 ]] && { echo "$host did not become healthy" >&2; exit 1; }
    sleep 1
  done
  echo "$host healthy"
done
```

## commands | Building runbooks

```term
$ bash -n runbooks/rolling-restart.sh            # syntax check
$ bash runbooks/rolling-restart.sh --dry-run
$ bash runbooks/rolling-restart.sh
$ ab -n 200 http://shop.lumen.dev/               # did users notice?
```

## analogy | A pre-flight checklist that flies the plane

A checklist stops a pilot from skipping steps; an autopilot that follows the checklist itself, and refuses to continue when a check fails, is even safer at 2 a.m. Automation turns a fragile human procedure into a reliable one.

## team | Toil habits

- **Measure toil** and budget time to remove it (Google SRE suggests keeping it under half of ops time).
- **Runbooks live in git**, next to the alerts that link to them.
- **Automate the boring and the dangerous first.**
- **Review AI-drafted scripts** like code from a new colleague: test the failure paths.

## traps | Automation traps

**No `set -e`**: the script carries on after a failed restart.

**Restarting everything at once** "to be quick".

**Infinite waits** with no timeout.

**Automation nobody can stop**: always a dry-run and an abort path.

## lab | A rolling restart you can trust

Write a rolling-restart runbook for the shop with a dry-run mode and health checks, and prove it keeps the shop up.
