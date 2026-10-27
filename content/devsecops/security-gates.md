## story | The scanner nobody ran

Lumen's security wiki listed five excellent tools. Each developer was supposed to run them before pushing. In practice nobody did, the wiki page was two years old, and the leaked key from last month went straight from a laptop to GitHub.

A check that depends on memory is not a control. **Security gates** run the scanners automatically in CI on every push and pull request, and block merges when they find something serious.

## model | Gates that help instead of annoy

- A **security workflow** runs in parallel with the tests:
  - **gitleaks**: secrets in the pushed commits.
  - **semgrep**: code patterns such as injection.
  - **trivy fs**: vulnerable dependencies.
  - **trivy config**: misconfigured infrastructure.
- **Fail on what matters**: `--severity HIGH,CRITICAL --exit-code 1`, or `--error` for semgrep. Report the rest without failing.
- **Required status checks** on `main` make the gate a real gate: no green check, no merge.
- **Secure the pipeline itself** (from the CI/CD realm):
  - actions pinned to full commit SHAs;
  - `permissions: contents: read`;
  - secrets only in the jobs that need them.
- **Fast feedback wins**: a gate that takes 30 minutes gets bypassed. Most scanners take seconds.
- **Exceptions are code**: `.gitleaksignore`, `.trivyignore` and `nosemgrep` comments go through review like everything else.

## commands | A minimal security workflow

```term
$ cat .github/workflows/security.yml
$ git push
$ gh run view
$ gh run view --log-failed
```

## analogy | Airport security

Security at the airport works because everyone goes through it, every time, and it is fast enough that people do not look for a side door. A gate that is optional, or slow, is a side door.

## team | Owning the gates

- **Developers own fixing findings**; a security team owns the rules and the exceptions process.
- **Measure**: time to fix, number of open exceptions, how often the gate blocks.
- **Pair gates with education**: link each finding to how to fix it.
- **AI can explain a finding and propose a fix in the PR**; the same gate re-checks the fix.

## traps | Gate traps

**`continue-on-error: true`** on the scan step "just for now".

**Gating on every LOW finding** until people learn to ignore red.

**Unpinned third-party actions** in the very workflow meant to protect you.

**Gates only on `main`**: findings should appear on the pull request, before merge.

## lab | Turn the wiki into a workflow

The `lumen/checkout` repository has no security checks. Add a security workflow with pinned actions that blocks on secrets, injection and vulnerable dependencies, watch it catch real problems, and fix them until it is green.
