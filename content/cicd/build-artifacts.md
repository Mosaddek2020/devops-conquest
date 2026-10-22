## story | The build that was different in production

A bug report came in for Lumen's website: a price showed in dollars instead of euros. The developers could not reproduce it. Staging was fine. It turned out the production server ran its own `npm run build` during deploy, half an hour after staging had built its copy, and in that half hour a dependency had published a new minor version with a changed default.

Staging and production were running different code built from the same commit. The fix was a principle: **build once, deploy many**. The pipeline builds one artifact, tags it with the commit, stores it, and every environment deploys those exact bytes.

## model | Artifacts and passing work between jobs

A **build artifact** is the output of the build step: a bundle of static files, a compiled binary, a tarball, or (in the next realm) a container image. Good artifacts are:

- **Built once**, in CI, from a specific commit.
- **Versioned**: named or stamped with the version and/or commit SHA (`GITHUB_SHA`), so "what is running?" has an exact answer.
- **Immutable**: never rebuilt or edited after testing. Promote the same artifact from staging to production.

Each job runs on a fresh runner, so files do not travel between jobs on their own. Pass them explicitly:

```term
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build             # writes dist/
      - uses: actions/upload-artifact@v4
        with:
          name: site
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: site
          path: dist
      - run: scp -r dist/* deploy@staging:/srv/site/
```

**Caching** (for example `actions/setup-node` with `cache: npm`) makes repeated dependency installs fast. A cache speeds things up; an artifact is the product. Do not confuse them.

## commands | Version stamps and inspection

```term
$ echo "$GITHUB_SHA" > dist/VERSION         # inside the pipeline: stamp the build
$ curl -s https://staging.example.com/VERSION   # which commit is running?
$ git log --oneline -1                      # compare with your commit
$ gh run view                               # see the upload/download steps
```

## analogy | A sealed shipping container

A factory packs goods into a container, seals it and stamps a serial number. The container travels by truck, ship and train without being opened; the customs officer and the customer see the same seal. Rebuilding for production is like unpacking at the port and repacking from memory.

## team | Artifacts in practice

- **One build job**, then test and deploy jobs that consume its output.
- **Stamp everything** with version and commit, and show it in a `/health` or `/VERSION` endpoint.
- **Keep artifacts for a while** so you can redeploy an old one for a rollback without rebuilding.
- **Never build on production servers.**

## traps | Artifact traps

**Rebuilding per environment.** Different time, different dependencies, different bytes.

**Expecting files to survive between jobs.** Each job starts on an empty runner; use artifacts.

**No version stamp.** Debugging "which version has the bug?" becomes archaeology.

## lab | Build once, deploy the same bytes

The Lumen events site is a static site. Make the pipeline build it once, stamp it with the commit, pass it to a deploy job as an artifact, and deploy it to the staging server over SSH.
