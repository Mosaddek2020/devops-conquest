## story | Nine people debugging, nobody talking to customers

When the shop went down one Saturday, nine engineers joined a call. Four restarted different things at the same time, two argued about the cause, and nobody updated the status page for 70 minutes, so support kept forwarding angry tickets. The fix took ten minutes once someone noticed the missing config file. The chaos took the other sixty.

**Incident response** is a practised process so that, under stress, everyone knows their job: one person coordinates, others investigate, someone keeps customers informed, and everything is written down.

## model | Severity, roles, mitigation first

```diagram
incident-roles
```

| Severity | Meaning | Response |
|---|---|---|
| SEV1 | customers broadly affected (shop down, data loss) | page now, all hands, public status updates |
| SEV2 | significant degradation for many | page, status update |
| SEV3 | limited impact | business hours |
| SEV4 | no customer impact | ticket |

- **Declare early**: declaring and downgrading costs nothing; a late declaration costs hours.
- **Incident commander (IC)**: coordinates, decides, delegates. Doesn't debug.
- **Mitigate first**: restore service (roll back, fail over, restore a file) before hunting the root cause.
- **Communicate on a cadence**: status page updates every 30 minutes, even "still investigating".
- **Keep a timeline**: what was seen, what was done, when. It powers the postmortem.
- Statuses: investigating → identified → mitigated → monitoring → resolved.

## commands | Running an incident

```term
$ incident declare --sev 1 --title "Shop returns 502 for all users"
$ incident role commander dev
$ incident update --public "We are investigating errors on the shop."
$ incident note "web1+web2: shop.service failed: Failed to load environment files"
$ incident status mitigated
$ incident timeline
$ curl -s status.lumen.dev
$ systemctl status shop · journalctl -u shop -n 30      # on the servers
```

## analogy | A fire brigade

At a fire, one officer commands: they don't hold a hose. Firefighters work the fire, someone keeps the public back and informs the neighbours, someone logs times and decisions. Saving the building comes first; investigating the cause comes after the fire is out.

## team | Incident habits

- **On-call rotation** with a runbook for every alert and a clear escalation path.
- **Incident drills** (game days) so the process is familiar before it matters.
- **One channel per incident**; decisions in writing.
- **Hand over explicitly** when the IC changes or a shift ends.

## traps | Incident traps

**Everyone debugging, no one coordinating.**

**Silent status page**: customers assume the worst.

**Fixing the root cause during the outage** when a rollback would restore service in a minute.

**Resolving too early**: watch the metrics for a while ("monitoring") first.

## lab | Saturday morning outage

The shop is returning errors. Run the incident properly: declare, lead, communicate, find the cause, mitigate, resolve.
