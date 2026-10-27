## brief | The on-call week

This week you carry the pager for the Lumen shop: two web servers behind a TLS load balancer, Prometheus and Alertmanager on `mon`, alerts into the team chat. Nobody tells you what is wrong; alerts, dashboards, logs and the occasional email do. Each fix should leave the system better than you found it.

1. Monday: a page about disk space on a web server.
2. Make sure it cannot happen again, on every server.
3. Tuesday: errors on the shop after a change.
4. Wednesday: an email about a certificate.
5. Friday: the on-call report for the team.

## recap | What this trial proved

- Alerts lead you to the right machine; metrics, logs and the system itself tell you why.
- A fix is not finished until the alert resolves, and the cause cannot simply come back (log rotation, automated renewal).
- Incidents that hurt customers get declared, communicated and resolved, even when the fix is quick.
- A good on-call report turns a week of interruptions into concrete, owned improvements.

## lab | The on-call week

Your laptop can reach every server (`ssh ubuntu@web1`, `web2`, `lb`, `mon`). Prometheus is at `http://mon:9090` (alerts at `/api/v1/alerts`), and `promtool` and `logcli` are installed. The Observe panel shows alerts and the team chat. The incident CLI from the Reliability realm is available.
