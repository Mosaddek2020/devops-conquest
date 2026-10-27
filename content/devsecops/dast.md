## story | The .env file on the website

A marketing site was deployed by copying the whole project folder into nginx's web root. The code was fine. But `https://lumen.dev/.env` returned the database password and `/.git/config` let anyone download the full source history. No source-code scanner would have found it, because the problem was not in the code: it was in how the code was served.

**Dynamic application security testing (DAST)** checks the *running* application from the outside, as any visitor sees it: response headers, cookies, version banners and files that should never be served.

## model | What DAST checks

- **OWASP ZAP** is the common open-source DAST tool. `zap-baseline.py` spiders the site and checks responses passively (safe to run against production). `zap-full-scan.py` adds active checks (in this course: requests for well-known files such as `/.env` and `/.git/config`; the real tool goes much further). Run active scans only against environments you own, ideally staging.
- **Security headers** tell browsers to protect users:
  - `X-Content-Type-Options: nosniff`: do not guess content types.
  - `X-Frame-Options: DENY` or CSP `frame-ancestors 'none'`: no clickjacking.
  - `Content-Security-Policy`: where scripts may load from, the main XSS defence.
  - `Strict-Transport-Security`: always use HTTPS (only meaningful over HTTPS).
- **Information leaks**: `Server: nginx/1.24.0 (Ubuntu)` tells attackers exactly which CVEs to try. `server_tokens off;` hides the version.
- **Never serve dotfiles**: `location ~ /\. { deny all; }`, and deploy built artifacts rather than the project folder.
- ZAP results are **WARN** (fix soon) or **FAIL** (fix now); a rules file (`-c`) lets a team decide per rule, with reasons.

## commands | Scan, harden, re-scan

```term
$ curl -sI http://shop.lumen.dev/
$ zap-baseline.py -t http://shop.lumen.dev/
$ zap-full-scan.py -t http://shop.lumen.dev/ -r report.html
$ sudo nginx -t && sudo systemctl reload nginx
```

## analogy | Testing the locks from outside

SAST reads the building's blueprints. DAST is the inspector who walks around the finished building checking every door and window is locked. Both find things the other cannot.

## team | DAST in the pipeline

- **Baseline scan on every deploy to staging**, full scan nightly or weekly.
- **Fail on FAIL, track WARN**, and review the rule configuration like code.
- **Scan what users reach**: through the load balancer and CDN, with real hostnames.
- **Get permission** before scanning anything you do not own: an active scan looks exactly like an attack.

## traps | DAST traps

**Active scans against production** without warning the team or the hosting provider.

**Headers added in one place only** (one `location` or one server block) while other paths stay unprotected.

**Fixing the scanner, not the site**: ignoring a rule because it is noisy instead of setting the header.

**Copying the whole repo into the web root**, `.env` and `.git` included.

## lab | Harden the shop's front door

The shop is served by nginx on `web1`. Scan it with ZAP, close the leaks it finds (exposed files, version banner, missing headers), and prove it with a clean re-scan.
