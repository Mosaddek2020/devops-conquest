## story | Two minutes of downtime, every deploy

Lumen's API restarted in place on every deploy. For about two minutes per deploy, some requests failed. At two deploys a week nobody cared. At twenty deploys a day it added up to forty minutes of errors daily, and the support team noticed.

They moved to **blue-green**: run the new version next to the old one, check it, then switch traffic in one step. Deploys stopped causing errors, and rollback became "switch back", which took one second instead of one redeploy.

## model | Ways to release safely

```diagram
blue-green
```

| Strategy | How | Strength | Cost |
|---|---|---|---|
| **Recreate** | stop old, start new | simple | downtime |
| **Rolling** | replace instances one at a time behind a load balancer | no downtime, no extra capacity | old and new run side by side for a while |
| **Blue-green** | full new copy, switch all traffic at once | instant switch and rollback | double capacity during the switch |
| **Canary** | send a small share of traffic (1-5%) to the new version, watch, then widen | limits the blast radius of a bad release | needs good metrics and routing |
| **Feature flags** | deploy code switched off, turn it on per user group | separates *deploy* from *release* | flag debt if never cleaned up |

Whatever the strategy, the safety net is the same: **know the last good version and be able to go back in one step**, then fix forward calmly.

In nginx, blue-green can be one included file that names the live backend:

```term
# /etc/nginx/conf.d/live.conf
upstream api_live { server 127.0.0.1:3001; }   # blue

# site
location / { proxy_pass http://api_live; }
```

Switching to green is editing that one line to `3002`, `nginx -t`, `reload`. Rolling back is editing it back.

## commands | A manual blue-green switch

```term
$ curl -s localhost:3002/health                  # green is up and healthy?
$ sudo sed -i 's/3001/3002/' /etc/nginx/conf.d/live.conf
$ sudo nginx -t && sudo systemctl reload nginx   # switch
$ curl -s https://api.lumen.example.com/health   # users now get green
$ sudo sed -i 's/3002/3001/' /etc/nginx/conf.d/live.conf && sudo systemctl reload nginx   # rollback
```

## analogy | Changing the river's course

You do not rebuild a bridge while traffic is on it. You build a new bridge next to it, test it, then redirect traffic with one barrier. If the new bridge creaks, you move the barrier back. A canary is letting one lane of traffic onto the new bridge first.

## team | Choosing a strategy

- **Stateless web apps**: rolling or blue-green, usually provided by your platform (Kubernetes does rolling updates by default).
- **Risky changes**: canary plus metrics that automatically stop the rollout.
- **Database changes**: make them backward compatible (expand, migrate, contract) so old and new versions can run at the same time.
- **Feature flags** for product launches, so marketing can pick the moment without a deploy.

## traps | Release traps

**Blue-green with a shared database migration** that the old version cannot read: rollback then fails.

**Switching before checking green.** Always health-check the new side first.

**Canaries without metrics.** If you are not watching error rates, 5% is just a smaller outage.

## lab | Switch blue to green

The API on **api1** runs as two services: `api-blue` (port 3001, version 1.4, live) and `api-green` (port 3002). Deploy 1.5 to green, check it, switch traffic, and roll back when users report a problem.
