## brief | Friday evening incident

19:52. The on-call chat lights up. Checkout is failing for a lot of customers. A deploy went out an hour ago. You have Prometheus, Alertmanager, logs and traces, and SSH to the servers. Lead the incident:

1. Get the alert to the on-call channel (it isn't wired up yet).
2. Quantify the impact with metrics: which route, how many errors, what latency.
3. Find the cause with logs and traces.
4. Mitigate, and prove with metrics that users are fine again (the alert resolves).

## recap | What the Observability realm gave you

- Metrics, logs and traces; golden signals; percentiles, not averages.
- Prometheus: scraping, exporters, `up`, config checks, reloads.
- PromQL: rate before sum, error ratios, histogram_quantile, topk.
- Dashboards that answer questions: RED and USE.
- Alerting on symptoms with `for`, runbooks, Alertmanager routing, grouping and silences.
- Structured logs and LogQL; traces, spans and propagation.
- SLIs, SLOs, error budgets and burn-rate alerts.

## lab | Incident commander

Prometheus and Alertmanager run on `mon`; the shop runs on `web1` and `web2`; `logcli` and `traces` are on your laptop. The shop's settings live in `/etc/shop/shop.env` on each web server.
