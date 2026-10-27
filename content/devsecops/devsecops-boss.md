## brief | The leaked key

Saturday, 06:40. A billing alert: Lumen's AWS spend jumped from 40 dollars a day to 900 overnight. Someone is using the company's credentials. You are on call.

1. Declare an incident and take command.
2. Find which credential is being abused and where it leaked from.
3. Stop the abuse: kill the credential and the attacker's resources, without breaking production.
4. Remove the leak, and make sure the next one is caught automatically.
5. Write a blameless postmortem.

## recap | What the DevSecOps realm gave you

- Threat modelling: attack surface, STRIDE, least privilege, defence in depth.
- Secrets: scanning history, rotating first, pre-commit and CI guard rails.
- SAST: finding injection in code, fixing it with parameterized queries, custom rules.
- DAST: scanning the running site, security headers, no exposed files.
- Supply chain: SBOMs, dependency fixes, signing and verifying images by digest.
- Misconfiguration scanning and accepted risk written down with reasons.
- Kubernetes pod security standards and securityContext.
- Security gates in CI that block on what matters.

## lab | The leaked key

Your laptop has admin credentials for the AWS account (`aws`), and the `lumen/data-sync` repository on GitHub. CloudTrail is on.
