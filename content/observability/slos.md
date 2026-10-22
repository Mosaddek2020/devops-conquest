## story | "99.99% uptime" that nobody believed

Lumen's status page said 99.99% uptime, because the health check pinged `/` and `/` always worked. Meanwhile checkout failed for 2% of customers every evening. The numbers measured the wrong thing. When the team switched to **SLOs** based on what users experience ("99.5% of checkouts succeed within 2 seconds, over 30 days"), the numbers finally matched the complaints, and gave the team a budget for how much unreliability was acceptable.

## model | SLI, SLO, error budget, burn rate

```diagram
slo-budget
```

- **SLI** (indicator): a ratio of good events to all events, measured where users feel it. `good checkouts / all checkouts`.
- **SLO** (objective): the target for the SLI over a window: 99.5% over 30 days.
- **Error budget**: what the SLO allows to fail: 0.5% of checkouts. Spend it on releases and experiments; when it's gone, prioritise reliability.
- **Burn rate**: how fast you're spending it, `error_ratio / (1 - SLO)`. A burn rate of 1 uses exactly the budget over the window; 14.4 for an hour burns 2% of a 30-day budget.
- **Multi-window burn-rate alerts** page on fast burns (e.g. > 14.4 over 1h and 5m) and open tickets for slow burns (> 1 over 3 days), replacing dozens of threshold alerts.
- **Recording rules** precompute SLIs so dashboards and alerts are cheap:

```term
- record: sli:checkout_errors:ratio_rate5m
  expr: |
    sum(rate(http_requests_total{route="/checkout",status=~"5.."}[5m]))
      / sum(rate(http_requests_total{route="/checkout"}[5m]))
```

## commands | Working with SLOs

```term
$ promtool check rules /etc/prometheus/rules.yml
$ promtool query instant http://mon:9090 'sli:checkout_errors:ratio_rate5m'
$ promtool query instant http://mon:9090 'sli:checkout_errors:ratio_rate5m / (1 - 0.995)'   # burn rate
$ promtool query instant http://mon:9090 '1 - (sum(increase(http_requests_total{route="/checkout",status=~"5.."}[1h])) / sum(increase(http_requests_total{route="/checkout"}[1h]))) / (1 - 0.995)'
```

## analogy | A monthly data allowance

Your phone plan allows 20 GB a month. You don't panic at every video; you check whether you're burning through it faster than the month allows. Streaming 10 GB on day 2 is an alarm; 0.6 GB a day is fine. SLOs give reliability the same shape.

## team | SLO habits

- **Few SLOs, on user journeys** (checkout, search, login), agreed with product.
- **Error budget policy written down**: what happens when it's exhausted (freeze risky releases, fix reliability first).
- **Burn-rate alerts** instead of piles of threshold alerts.
- **Review SLOs quarterly**: too tight wastes effort, too loose hides pain.

## traps | SLO traps

**100% targets**: impossible, and they forbid every change.

**SLIs measured at the wrong place** (a health check) instead of real user requests.

**Too many SLOs** nobody owns.

**Ignoring the budget** once it is gone: the SLO becomes decoration.

## lab | A checkout SLO

Define the checkout SLI as a recording rule, alert on a fast budget burn, and decide whether the team may ship this week.
