## story | Deleted is not gone

A developer committed `.env` with an AWS key, noticed ten minutes later, deleted the file and pushed again. The key was still in the repository's history. Bots that scrape public GitHub found it in four minutes and started crypto-mining instances in a region nobody at the company used. The bill arrived before anyone noticed.

Secrets leak through git history, CI logs, Docker image layers, screenshots and chat. The only safe assumption after a leak: **the secret is already in an attacker's hands.**

```diagram
leak-response
```

## model | Detect, rotate, prevent

- **Scanners** such as **gitleaks** and trivy look for known key formats (AWS `AKIA…`, GitHub `ghp_…`, Stripe `sk_live_…`, private keys) and high-entropy strings next to words like `password` or `token`.
- Scan the **whole history**, not just the current files: `gitleaks git` reads every commit.
- **Rotate first, clean up second.** Deactivate the leaked credential, issue a new one, deploy it, then delete the old one. Rewriting git history is optional hygiene; it does not un-leak anything.
- **Prevent**: `.gitignore` for `.env`, a committed `.env.example` with placeholders, a **pre-commit hook** that runs `gitleaks protect --staged`, and the same scan in CI for anyone who skips the hook.
- **False positives** (test fixtures, documentation examples) are recorded in `.gitleaksignore` by fingerprint, with a reason, not by turning the scanner off.
- Secrets belong in a secrets manager or the platform (Actions secrets, Kubernetes Secrets with encryption, Vault), injected at runtime.

## commands | Find, rotate, prevent

```term
$ gitleaks git -v                    # every commit in history
$ gitleaks dir .                     # just the files on disk
$ aws iam update-access-key --access-key-id AKIA… --status Inactive
$ aws iam create-access-key
$ aws configure set aws_access_key_id AKIA…
$ aws iam delete-access-key --access-key-id AKIA…
$ gitleaks protect --staged          # in .git/hooks/pre-commit
```

## analogy | Lost house keys

If you lose your keys, you change the locks. Finding the keys later, or asking the finder to forget the address, does not make the house safe again. Rotating a credential is changing the locks.

## team | Secret hygiene

- **Short-lived credentials** (OIDC from CI to the cloud, instance roles) leave nothing long-lived to leak.
- **One secret per purpose** so rotating one does not break everything.
- **A leak runbook** everyone knows: who to tell, how to rotate each kind of key, how to check usage (CloudTrail).
- **Never paste secrets into AI chats or tickets.** Treat that as a leak too.

## traps | Secret traps

**Deleting the file and calling it fixed.** It is still in history, forks, clones and caches.

**Rewriting history before rotating.** The attacker already has the key.

**Deleting the old key before the new one is deployed**, causing an outage on top of the leak.

**Ignoring scanner findings wholesale** (`--no-verify`, disabling the rule) instead of fingerprinting the one false positive.

## lab | The key in the history

The `lumen/payments` repository once had a `.env` with a live AWS key. Find it with gitleaks, rotate the key in IAM without breaking your own access, and add guard rails so it cannot happen again.
