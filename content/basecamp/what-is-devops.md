## story | Two releases a year

In 2019, Lumen Tickets shipped software twice a year. Developers spent five months writing features, then handed a 400 MB zip file to the operations team with a 30-page installation guide. Release weekend meant pizza, panic and a 2 a.m. call: the new version needed a library the servers did not have, and nobody on the ops side knew which feature was causing the database to melt.

Developers were rewarded for shipping features. Operations was rewarded for stability. So developers pushed for change and operations pushed back against it. Both were doing their jobs, and the company lost either way.

Five years later, the same company deploys about 30 times a day. Each change is small, tested automatically, rolled out gradually and watched closely. When something breaks, the developer who wrote it is paged, has a dashboard showing what changed, and can roll back in one command. Outages still happen, but they are smaller, shorter and less frightening.

They did not just buy new tools. They changed **who owns what**, **how work flows**, and **how fast they learn**. That change is what people mean by **DevOps**.

## model | What DevOps is (and is not)

**DevOps** is a way of building and running software in which the same team owns the whole journey from idea to production, and uses automation and fast feedback to make that journey safe, quick and repeatable.

```diagram
wall-of-confusion
```

A useful checklist is **CALMS**:

| Pillar | Means | Looks like |
|---|---|---|
| **C**ulture | Shared ownership, no blame | "You build it, you run it"; blameless postmortems |
| **A**utomation | Machines do the repetitive, error-prone steps | Pipelines, infrastructure as code, auto-rollbacks |
| **L**ean | Small batches, limit waiting, remove waste | Small pull requests, deploys several times a day |
| **M**easurement | Decide with data | Delivery metrics, dashboards, service-level objectives |
| **S**haring | Knowledge flows between people and teams | Runbooks, docs, pairing, open postmortems |

The **Three Ways** describe the direction of travel:

1. **Flow**: make work move quickly and smoothly from idea to user (small batches, automation, fewer handoffs).
2. **Feedback**: see problems quickly and close to where they started (tests, monitoring, alerts that reach the right people).
3. **Continuous learning**: experiment, learn from failures, and get better every week.

And four numbers, the **DORA metrics**, tell you how well it works:

- **Deployment frequency**: how often you ship.
- **Lead time for changes**: from commit to running in production.
- **Change failure rate**: what share of deploys cause a problem.
- **Time to restore service**: how fast you recover when they do.

Elite teams score well on all four at once: speed and stability are not a trade-off.

## analogy | The pit crew

A Formula 1 pit stop takes about two seconds. Twenty people change four tyres, adjust the wing and send the car out. Nobody hands a form to another department; every person knows the whole sequence, the tools are laid out in advance, every move is rehearsed, and they review the footage afterwards to shave off another tenth.

Now imagine the tyres were changed by a separate company that only hears about the stop when the car arrives, with no rehearsal and a 30-page manual. That is the old dev-and-ops split. DevOps is building the pit crew.

## team | Who does DevOps?

Job titles vary, and they cause confusion:

- **Developers** write features and also tests, deployment configuration and dashboards for what they ship.
- **Site Reliability Engineers (SRE)** treat operations as a software problem: they set reliability targets, automate toil and lead incident response.
- **Platform engineers** build the internal "paved road": pipelines, templates and self-service tools so product teams can ship safely without being experts in everything.
- **"DevOps engineer"** usually means someone who builds and runs that automation. Useful, as long as it does not become a new wall between dev and ops.

Whatever the title, the skills overlap: Linux, networking, scripting, CI/CD, containers, cloud, observability, security and, increasingly, working well with AI tools. That is exactly the path ahead of you.

## traps | Common misunderstandings

**"DevOps is a tool."** Buying Kubernetes does not make you DevOps, just as buying running shoes does not make you a runner.

**"DevOps means developers do everything alone."** It means shared ownership with good tooling, not dumping ops work on developers without support.

**"DevOps is a team in the middle."** A separate "DevOps team" that receives tickets from dev and hands work to ops recreates the wall with a new name.

**"Moving fast means breaking things."** Small, automated, observable changes are *safer* than big, rare ones.

## lab | First contact

Welcome to **Lumen Tickets**. This is your laptop: a Linux machine with a terminal. Everything in the course happens in terminals like this one, connected to simulated servers, pipelines and clusters.

You do not need to know any commands yet. Each task tells you what to type, and the **Hint** and **Show a solution** buttons help when you are stuck. Watch the panels on the right change as you work.
