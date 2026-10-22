## story | The Friday deploy freeze

Lumen used to have a rule: no deploys on Fridays. It existed because deploys were manual, big and scary. The rule did not make Fridays safe; it made Mondays dangerous, with a week of changes going out at once.

After they automated delivery (every merge to `main` deployed to staging within minutes, a version tag deployed the same artifact to production after one approval, and a smoke test checked the real site after every deploy), deploys became small and boring. The Friday rule quietly disappeared, because a ten-line change with a one-command rollback is not scary on any day.

## model | Continuous delivery with environments

| Practice | Every change… | Production releases… |
|---|---|---|
| Continuous integration | is built and tested | (not covered) |
| **Continuous delivery** | is always ready to release | happen with one deliberate step (tag, approval) |
| Continuous deployment | goes all the way automatically | happen on every green merge |

An **environment** is where software runs: `staging` (a production-like rehearsal) and `production` (real users). In GitHub, a job can target an environment, which can have **protection rules**: required reviewers who must approve, and limits on which branches or tags may deploy there. A job targeting a protected environment waits for approval.

A typical setup:

- `push` to `main` → test → build → deploy to **staging** → smoke test.
- `push` of a tag `v*` → test → build → **approval** → deploy to **production** → smoke test.

```term
on:
  push:
    tags: ['v*']
jobs:
  deploy-production:
    environment: production        # waits for a reviewer
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/deploy.sh prod1
        env:
          SSH_KEY: ${{ secrets.DEPLOY_KEY }}
      - run: curl -sf https://lumen.example.com/health
```

A **smoke test** is a quick check that the main path works after a deploy: `curl -f` fails the job on HTTP errors.

## commands | Releases from the terminal

```term
$ git tag -a v1.5.0 -m "Release 1.5.0"
$ git push origin v1.5.0                  # starts the production workflow
$ gh run list --workflow=release.yml
$ gh run view                             # "waiting for review: production"
# approve in the GitHub tab: Review deployments → Approve and deploy
$ curl -s https://lumen.example.com/health
```

## analogy | Dress rehearsal and opening night

Staging is the dress rehearsal: same stage, same costumes, same lights, an empty theatre. The approval is the director saying "curtain up". The smoke test is the stage manager checking that the curtain actually rose. Nobody rewrites the play between rehearsal and opening night.

## team | Delivery habits

- **Staging mirrors production** in software and configuration shape, with separate data and secrets.
- **Deploy keys per environment**, stored as environment secrets, with only the access the deploy needs.
- **Small, frequent releases**, each tagged.
- **Measure**: deployment frequency and lead time go up; change failure rate and time to restore go down.

## traps | Delivery traps

**Same secret for staging and production.** A staging leak then becomes a production incident.

**No smoke test.** "The deploy job is green" only means the commands ran.

**Approvals as rubber stamps.** If nobody looks at what is being approved, the step adds delay without safety.

## lab | Staging on merge, production on tag

The events site deploys by hand today. Build the delivery pipeline: every push to `main` goes to **staging1**, every `v*` tag goes to **prod1** after your approval, both with smoke tests.
