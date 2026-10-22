## brief | Pipeline from scratch

Lumen's new **tickets** service has code, tests and servers, but no pipeline: people still `scp` files by hand. Build the whole delivery pipeline:

1. Lint and test on every pull request, required before merging.
2. On `main`: build once, upload the artifact, deploy it to **staging1**, smoke test.
3. On a `v*` tag: deploy the same build to **prod1** after approval, smoke test.
4. Prove it works end to end, including a release.

## recap | What the CI/CD realm gave you

- Workflows, events, jobs, steps and runners; `needs:`; required checks; `npm ci`.
- Build once: artifacts, version stamps, passing files between jobs.
- Continuous delivery: environments, approvals, tags, smoke tests.
- Release strategies: rolling, blue-green, canary, feature flags, one-step rollback.
- Pipeline security: pinned actions, least-privilege permissions, secrets hygiene, dependency audits.

## lab | Ship tickets

The repository is `lumen/tickets` (you can push; `main` is protected). The secret `DEPLOY_KEY` is already set: its public key is authorised for `deploy@staging1` and `deploy@prod1`. Each server's site lives in `/var/www/html`, writable by `deploy`.
