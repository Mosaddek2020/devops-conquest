## story | 312 alerts a day

Lumen's first alerting setup fired on everything: CPU over 70%, any single 500, disk at 60%. The chat channel received 312 alerts a day. People muted it. When the payment provider went down on a Saturday, the real alert was alert number 47 that morning, and nobody saw it for two hours.

Good alerts are **few, actionable and about user pain**. Every page should mean "a human must act now", with enough context to start.

## model | Rules, Alertmanager and noise control

```term
# /etc/prometheus/rules.yml
groups:
  - name: shop
    rules:
      - alert: ShopHighErrorRate
        expr: |
          sum(rate(http_requests_total{job="shop",status=~"5.."}[5m]))
            / sum(rate(http_requests_total{job="shop"}[5m])) > 0.05
        for: 5m
        labels:
          severity: page
        annotations:
          summary: "Shop error rate is {{ $value | humanizePercentage }}"
          runbook: "https://wiki.lumen.dev/runbooks/shop-errors"
```

- **`expr`** is a PromQL condition; every resulting series is an alert instance.
- **`for`**: it must be true for this long (state `pending` → `firing`), so blips don't page anyone.
- **labels** (like `severity`) drive routing; **annotations** carry the human context: summary, runbook link.
- **Alertmanager** receives firing alerts, **groups** them (one message for 20 servers, not 20 messages), **routes** them by labels to receivers (chat, pager, email), and lets you **silence** them during maintenance.
- Alert on **symptoms** (errors, latency, `up == 0` for critical targets, disks about to fill: `predict_linear`), not on every cause.

```term
# /etc/alertmanager/alertmanager.yml
route:
  receiver: team-chat
  group_by: [alertname]
  routes:
    - matchers: [ 'severity="page"' ]
      receiver: oncall
receivers:
  - name: team-chat
    webhook_configs: [ { url: http://chat.lumen.dev/hooks/team } ]
  - name: oncall
    webhook_configs: [ { url: http://chat.lumen.dev/hooks/oncall } ]
```

## commands | Alerting

```term
$ promtool check rules /etc/prometheus/rules.yml
$ sudo systemctl reload prometheus
$ curl -s localhost:9090/api/v1/alerts | jq '.data.alerts[] | {alert: .labels.alertname, state}'
$ amtool alert query
$ amtool silence add alertname=ShopHighErrorRate --duration=1h --comment="planned payments maintenance"
$ amtool silence query
```

## analogy | A smoke alarm, not a thermometer

A smoke alarm doesn't beep every time the kitchen warms up; it goes off when there's smoke, loudly, and you know what to do. A wall of thermometers that each beep at 25 °C trains everyone to ignore beeping.

## team | Alerting habits

- **Every page has a runbook** and an owner.
- **Review alerts weekly**: delete or tune the ones nobody acted on.
- **Severity levels**: page (wake someone), ticket (this week), info (dashboard only).
- **Test alerts**: trigger them on purpose in staging.

## traps | Alerting traps

**No `for:`**: one bad scrape pages someone.

**Alerting on causes** (CPU 80%) instead of symptoms (latency).

**Silences that never expire**, or with no comment.

**Alerts with no runbook**: the paged person starts from zero at 3 a.m.

## lab | Page the right people, once

Write an error-rate alert for the shop, route it to the on-call chat, see it fire during an incident, and silence a planned maintenance correctly.
