## story | The server nobody was watching

When Lumen added a second web server, `web2`, someone forgot to add it to monitoring. It ran out of disk three weeks later. Every dashboard looked fine, because every dashboard was only looking at `web1`. With Prometheus, a target that isn't in the config simply doesn't exist, and a target that can't be scraped shows `up == 0`. Both are things you can check, and alert on.

## model | Targets, exporters and the exposition format

```diagram
prom-arch
```

- Prometheus **pulls**: every `scrape_interval` it fetches `http://<target>/metrics` and stores each line as a sample with `job` and `instance` labels added.
- **Exporters** translate things that don't speak Prometheus: `node_exporter` (port 9100) for Linux machines, others for databases, nginx, etc. Apps expose their own metrics with a client library (`prom-client` in Node).
- The **exposition format** is plain text: `name{label="value"} 42`. Metric **types**: counter (only goes up: requests, bytes), gauge (goes up and down: memory, queue length), histogram (bucketed observations: request durations).
- Each target gets an automatic **`up`** series: 1 if the last scrape worked, 0 if not.
- Config lives in `/etc/prometheus/prometheus.yml`; check it with `promtool check config`, then reload (`systemctl reload prometheus`). A bad config on reload keeps the old one and sets `prometheus_config_last_reload_successful` to 0.

```term
scrape_configs:
  - job_name: node
    static_configs:
      - targets: ["web1:9100", "web2:9100"]
  - job_name: shop
    static_configs:
      - targets: ["web1:3000"]
```

## commands | Running Prometheus

```term
$ sudo apt install -y prometheus prometheus-node-exporter
$ curl -s localhost:9100/metrics | grep node_load
$ sudoedit /etc/prometheus/prometheus.yml
$ promtool check config /etc/prometheus/prometheus.yml
$ sudo systemctl reload prometheus
$ curl -s localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, instance: .labels.instance, health, lastError}'
$ promtool query instant http://localhost:9090 'up == 0'
```

## analogy | A nurse's rounds

A ward nurse visits every patient on a schedule and writes down their vitals. A patient who isn't on the list is never visited. A patient who doesn't respond is itself the most urgent observation. Prometheus does rounds; `up == 0` is the patient who didn't answer.

## team | Scraping habits

- **Every new server and service is added to monitoring as part of creating it** (ideally automatically, via service discovery or the same IaC).
- **Alert on `up == 0`** for anything important.
- **Validate config in CI** with `promtool check config`.
- **Watch cardinality**: series count grows with every label value.

## traps | Scraping traps

**Forgetting to reload** after editing the config.

**Wrong port or path** in a target: `up` is 0 and `lastError` says why.

**Firewalls**: Prometheus must be able to reach every target's port.

**Assuming an absent series means "zero"**: absent means nobody reported it.

## lab | Watch every machine

Prometheus on `mon` only watches `web1`. Add `web2` (it needs an exporter first), fix a broken target, and make sure every target is up.
