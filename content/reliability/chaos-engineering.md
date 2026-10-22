## story | The failover nobody had tried

Lumen had two app servers, a load balancer and a runbook titled "web server failure". Nobody had ever actually turned a server off. The first time one died for real, failover worked, but the load balancer's own health check timeout was so long that every request waited 30 seconds first. It would have taken five minutes on a quiet Tuesday to find that out.

**Chaos engineering** is breaking things on purpose, carefully, to learn how the system really behaves before an outage teaches you.

## model | Experiments, not vandalism

```diagram
chaos-loop
```

- **Steady state**: a measurable sign of health (e.g. `ab` shows 0 failed requests; error ratio < 0.5%).
- **Hypothesis**: "If we stop the shop on one web server, users see no errors."
- **Blast radius**: start small (one instance, staging first, a few minutes) and have an **abort plan**.
- **Inject** a real failure: stop a process, kill a node, add latency, fill a disk, block a dependency.
- **Observe** the steady-state metric; **learn**: either confidence, or a finding to fix.
- **Game days**: scheduled sessions where the team runs experiments and practises incident response together.
- Tools: Chaos Mesh, Litmus, AWS Fault Injection Service, or simply `systemctl stop` with a plan.

## commands | A small game day

```term
$ ab -n 200 -c 10 http://shop.lumen.dev/          # steady state
$ ssh ubuntu@web2 sudo systemctl stop shop          # inject
$ ab -n 200 -c 10 http://shop.lumen.dev/          # observe
$ ssh ubuntu@web2 sudo systemctl start shop         # restore
```

## analogy | A fire drill

Schools don't wait for a fire to discover that a door is locked or the alarm can't be heard in the gym. They run drills, find the problems, and fix them while nothing is burning.

## team | Chaos habits

- **Write the hypothesis and abort conditions down** before you start.
- **Tell people**: game days are planned, never surprises for on-call.
- **Graduate**: staging first, then production with a small blast radius.
- **Every finding becomes an action item.**

## traps | Chaos traps

**No steady-state metric**: you can't tell whether anything broke.

**Big blast radius first** ("let's turn off the database").

**No restore step**: the experiment becomes an incident.

**Findings that never get fixed.**

## lab | Game day

Run a small game day on the shop: define steady state and a hypothesis, test it, then find the failure the current design cannot survive.
