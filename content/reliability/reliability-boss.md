## brief | The game day that turned real

Lumen planned a quiet game day for Friday afternoon. At 14:02, before it started, the support channel lit up: some customers get errors, and the orders page is empty. Real incident. Lead it:

1. Declare and run the incident (commander, public updates).
2. Bring the failing web server back.
3. Recover the lost orders from the off-site backups.
4. Prove the shop is healthy under load and resolve the incident.
5. Write a blameless postmortem with owned, dated actions.

## recap | What the Reliability realm gave you

- Designing for failure: SPOFs, redundancy, timeouts, retries with backoff, graceful degradation.
- Incident response: severity, roles, mitigation first, communication, timelines.
- Runbooks as safe automation: rolling, health-checked, dry-run, stop on failure.
- Blameless postmortems with contributing factors and owned actions.
- Backups that are off-site, monitored and restore-tested; RPO and RTO.
- Chaos engineering: steady state, hypothesis, small blast radius, learn.

## lab | Incident commander, again

The shop runs on `web1` and `web2` behind `lb` (shop.lumen.dev); orders live in PostgreSQL on `db1`; backups go to `s3://lumen-backups/db1/`. Your SSH key works on all servers.
