## story | "Works on my machine" at scale

Lumen's API team had six developers and one rule: run the tests before you merge. Everyone agreed. Nobody always did. Tests that passed on one laptop failed on another because of different Node versions, and a broken `main` blocked everyone for half a day about once a week.

They added a pipeline: every push and every pull request runs lint and tests on a fresh machine with a pinned Node version, and `main` only accepts pull requests whose checks are green. The arguments stopped. "Does it pass CI?" became the only question, and the answer was always the same for everyone.

## model | Workflows, jobs, steps, runners

**Continuous integration (CI)** means every change is integrated into the main line often and verified automatically.

```diagram
pipeline
```

In GitHub Actions:

- A **workflow** is a YAML file in `.github/workflows/`, triggered by **events** (`push`, `pull_request`, a tag, a schedule, a manual dispatch).
- A workflow has **jobs**. Each job runs on a fresh **runner** (a clean VM, here a simulated Ubuntu machine): nothing carries over between jobs unless you pass it.
- A job has **steps**: `uses:` runs a reusable action (like `actions/checkout`, which copies your repository onto the runner), `run:` runs shell commands with `bash -e` (the step stops at the first failing command).
- Jobs run **in parallel** unless you order them with `needs:`.
- Every run reports a **status check** on the commit. Branch protection can make checks **required**, so nothing reaches `main` red.

```term
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint
      - run: npm test
```

`npm ci` (not `npm install`) installs exactly what `package-lock.json` says, so every run uses the same dependency versions.

## commands | Driving CI from the terminal

```term
$ mkdir -p .github/workflows && nano .github/workflows/ci.yml
$ git add .github && git commit -m "ci: lint and test" && git push
$ gh run list                     # recent runs
$ gh run view                     # jobs, steps and logs of the latest run
$ gh run view --log-failed        # (on real gh) just the failing step's log
$ gh pr checks                    # checks on the current branch's PR
$ gh run rerun 12 --failed        # re-run only failed jobs
```

## analogy | Airport security

Every passenger goes through the same scanner, whoever they are and however confident they feel. The scanner is boring, consistent and fast, and because everyone goes through it, the plane is safe. CI is the scanner for code: same checks, same machine, every change.

## team | CI people trust

- **Fast** (minutes, not hours): split slow suites, cache dependencies.
- **Reliable**: a flaky test that fails at random trains people to ignore red. Fix or quarantine it.
- **Reproducible locally**: the same `npm test` developers run on their laptops.
- **Required**: protect `main` so red checks block merges, for everyone including admins.

## traps | CI traps

**Jobs run in parallel by default.** A "deploy" job without `needs: test` can ship code whose tests are still running.

**`npm install` in CI** can pick up newer dependency versions than you tested with; use `npm ci`.

**Tab characters in YAML.** YAML indentation must be spaces; the run fails with a parse error.

**Testing only on push to main.** Then you discover failures after merging. Run on `pull_request` too.

## lab | Green before merge

`lumen/api` has no CI and `main` requires a passing check. Add a workflow that lints and tests every pull request, get your first PR through it, and watch what happens when a change breaks lint.
