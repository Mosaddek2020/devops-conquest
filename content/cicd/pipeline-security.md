## story | The action that stole the secrets

In March 2025, a widely used third-party GitHub Action (`tj-actions/changed-files`) was compromised. Attackers changed what its version tags pointed to, and the new code printed CI secrets into the build logs. Thousands of repositories that referenced it by tag ran the malicious version automatically. Those that had **pinned the action to a full commit SHA** were not affected.

Your pipeline holds the keys to production: deploy keys, cloud credentials, registry tokens. It is one of the most attractive targets in your whole system, and it deserves the same care as production itself.

## model | Threats and defences

| Threat | Defence |
|---|---|
| A third-party action is changed to malicious code | **Pin actions to a full commit SHA**, use few, well-known actions, let Dependabot propose updates |
| Secrets leak into logs | Never `echo` secrets; GitHub masks known secret values, but transformations (base64, substrings) escape masking |
| Over-powerful tokens | `permissions:` at the top of the workflow: read-only by default, write only where needed |
| Long-lived cloud keys in secrets | **OIDC**: the cloud trusts GitHub to mint short-lived credentials per run, nothing stored |
| Vulnerable dependencies shipped | `npm audit` / dependency scanning in CI, failing on high severity |
| Untrusted pull requests reading secrets | Secrets are not given to `pull_request` runs from forks; avoid `pull_request_target` with untrusted code |
| Anyone can change the pipeline | Protect `main`, require review for changes to `.github/workflows/` (CODEOWNERS) |

```term
permissions:
  contents: read            # the default GITHUB_TOKEN can only read

steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683   # v4.2.2, pinned
  - run: npm ci
  - run: npm audit --audit-level=high
```

## commands | Auditing a pipeline

```term
$ grep -rn "uses:" .github/workflows/      # which actions? pinned to SHAs?
$ grep -rn "secrets\." .github/workflows/  # where do secrets go?
$ npm audit                                 # known vulnerable dependencies
$ npm audit --audit-level=high              # exit non-zero only for high/critical
$ gh secret list                            # what secrets exist (values are never shown)
```

## analogy | The bank's cash van

The pipeline is the cash van between the bank and the shops. You check the driver's identity every day (pinned, reviewed actions), the van carries only what today's route needs (least-privilege tokens), the cash is in sealed bags nobody opens on the way (secrets never printed), and the route is approved by two people (protected workflow changes).

## team | Pipeline security habits

- **Treat workflow changes like production changes**: reviewed, owned, audited.
- **Rotate deploy credentials** regularly and immediately when someone with access leaves.
- **Prefer OIDC** over stored cloud keys where your provider supports it.
- **Scan dependencies and images** on every build, and decide what severity blocks a release.

## traps | Pipeline security traps

**`uses: some/action@main`.** You run whatever that branch contains today.

**`echo $SECRET` "to debug".** Even masked, it is a habit that leaks in transformed form.

**Write permissions everywhere.** A compromised step can then push code or create releases.

**Ignoring audit output** until it is too long to read.

## lab | Harden the pipeline

`lumen/web`'s workflow works, but a security review flagged it. Fix what the reviewer found: a secret printed in the logs, an unpinned third-party action, missing `permissions`, and a vulnerable dependency that the pipeline should catch.
