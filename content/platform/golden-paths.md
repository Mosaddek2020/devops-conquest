## story | Six weeks to "hello world"

A new Lumen team wanted to ship a small receipts service. They filed tickets for a repository, a CI pipeline, a container registry, a namespace, a database password and DNS. Six weeks later the service was live, without health checks, limits or an owner in any list, because nobody had asked for those. Meanwhile the platform team, buried in tickets, had no time to improve anything.

**Platform engineering** treats the internal platform as a **product** for developers. Instead of tickets, it offers **golden paths**: supported, self-service ways to do common things (create a service, add a database) that are *already* secure, observable and deployable. The easy way becomes the right way. A **developer portal** (often Backstage) or CLI is the front door; a **service catalog** knows every service and its owner; **scorecards** show which services meet the standards; and **DORA metrics** measure whether delivery is actually getting better.

## model | Paved roads and how to measure them

```diagram
golden-path
```

- A **golden path template** creates a repository with CI, a Dockerfile, health endpoints and a **catalog entry** (`catalog-info.yaml`: owner, lifecycle, runbook), builds the first image, and opens a pull request to the **GitOps repo** with manifests that already have probes, limits and a network policy.
- An **ApplicationSet** turns every `apps/<name>/` folder into an Argo CD application, so merging that pull request deploys the service. No ticket.
- **Scorecards** check each service against the standards (owner, runbook, CI on pull requests, probes, limits, network policy). They show legacy services what to fix, without a meeting.
- The four **DORA metrics** (from the DevOps Research and Assessment program) measure delivery:
  - **Deployment frequency**: how often you deploy to production;
  - **Lead time for changes**: from commit to running in production;
  - **Change failure rate**: share of deploys that cause a failure needing a fix or rollback;
  - **Time to restore service**: how long recovering from a failure takes.
  Speed and stability move together: the best teams deploy often *and* fail rarely, because small changes are easy to check and to undo.
- Golden paths are **optional but attractive**: teams can leave the road for good reasons, but then they own the extra work.

## commands | The platform from a developer's chair

```term
$ lumen templates                       # the golden paths on offer
$ lumen create receipts --template node-api --owner team-payments
✓ Created repository lumen/receipts from template node-api
✓ First CI build pushed ghcr.io/lumen/receipts:0.1.0
✓ Opened lumen/gitops#1: "Add receipts". Review and merge it to deploy.
$ lumen catalog                         # every service, owner, score
$ lumen scorecard billing               # what this service is missing
$ lumen dora shop --days 30             # delivery metrics, with DORA bands
```

`lumen` is Lumen's in-house platform CLI; in your company the same jobs are done by a Backstage portal, a set of templates, or `gh repo create --template` plus a GitOps pull request.

## analogy | Paved paths across the lawn

Planners pave the routes people actually walk. You can still cut across the grass, but the paved path is shorter, lit at night, and cleared of snow. Golden paths work the same way: people take them because they are better, not because they are forced to.

## team | Running a platform as a product

- **Talk to your users** (the developers): measure time to first deploy, onboarding pain, ticket volume.
- **Start with the most common journey** (new service, new environment), make it excellent, then the next.
- **Templates evolve**: when the standard changes, scorecards show which existing services lag behind.
- **Use DORA metrics for learning, not for ranking teams.** A low score is a question ("what makes billing's lead time nine days?"), never a target to game.
- **Keep an exit**: teams with special needs can step off the path, as long as they meet the same standards.

## traps | Platform traps

**A portal on top of the same ticket queue.** If "create service" still waits for a human, it is not self-service.

**Golden cages**: forcing everything through one template that fits nobody well.

**Building a platform nobody asked for.** Solve the developers' biggest pain first.

**Measuring only speed.** Deployment frequency without change failure rate rewards reckless deploys.

**Dashboards without action**: a scorecard is only useful if someone fixes the red checks.

## lab | Paved road to production

Lumen's platform team offers golden paths through the `lumen` CLI. Create the new receipts service and get it running in minutes, bring the legacy billing service up to the platform's standards, and use DORA metrics to see how differently two teams deliver.
