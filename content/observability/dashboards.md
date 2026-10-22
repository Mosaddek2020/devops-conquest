## story | Forty panels and no answer

Lumen's "Shop Overview" dashboard had grown to forty panels: CPU of every core, garbage-collection pauses, cache hit ratios, a world map. During an incident, nobody could tell from it whether customers were affected. The rewrite had four rows: **requests per second, error ratio, p99 latency**, and **saturation** (CPU, memory). Every on-call engineer could read it in five seconds.

## model | Dashboards that answer questions

- A dashboard should answer **one question**: "is the shop healthy?", "is this node overloaded?". Put the answer at the top.
- **RED** for every service: **R**ate (requests/s), **E**rrors (ratio of failed requests), **D**uration (p50/p99 latency).
- **USE** for every resource: **U**tilization (CPU %, memory %), **S**aturation (load, queue length), **E**rrors.
- Use the right **units** (seconds, percent, bytes), the same time range across panels, and few series per panel.
- Dashboards are code too: Grafana dashboards are JSON you can keep in git (provisioned, or via Terraform). Here you write them as small YAML files and the **Observe** panel draws them:

```term
title: Shop (RED)
panels:
  - title: Requests per second
    expr: sum by (route) (rate(http_requests_total{job="shop"}[5m]))
  - title: Error ratio
    expr: sum(rate(http_requests_total{job="shop",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="shop"}[5m]))
    unit: percent
  - title: p99 latency
    expr: histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket{job="shop"}[5m])))
    unit: s
```

## commands | Building a dashboard

```term
$ mkdir -p ~/dashboards && nano ~/dashboards/shop.yml   # the Observe panel draws it
$ promtool query instant http://mon:9090 '<expr>'         # test each panel query first
```

## analogy | A cockpit's primary flight display

A cockpit has hundreds of instruments, but the primary display in front of the pilot shows the few that matter every second: attitude, speed, altitude, heading. Everything else is a glance away. Your service dashboard is the primary flight display.

## team | Dashboard habits

- **One standard RED dashboard per service**, generated from a template so they all look alike.
- **Link dashboards from alerts** so the person paged lands on the right view.
- **Delete panels nobody looks at.**
- **Annotate deploys** on dashboards so changes line up with spikes.

## traps | Dashboard traps

**Averages instead of percentiles** for latency.

**Panels without units**: is that 0.4 seconds or 0.4 ms?

**Stacking unrelated series** on one panel.

**Dashboards as the only alerting**: nobody watches a screen at 3 a.m.

## lab | A dashboard on-call can read

Build a RED dashboard for the shop and a USE dashboard for the web servers, and spot what's wrong on them.
