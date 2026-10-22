## story | "Is the shop slow, or is it just me?"

At 19:40 on a Friday, three customers tweeted that Lumen's checkout "hangs". The on-call engineer SSH-ed into the web servers: CPU fine, memory fine, nginx running, no errors in the last 20 lines of the log. Everything looked healthy, and yet one checkout in ten was taking eight seconds. It took two hours to find out that a payment provider had become slow, because nothing measured how long checkouts took.

**Monitoring** is watching known things: is the server up, is the disk full. **Observability** is being able to answer *new* questions about your system from the outside ("which requests are slow, for whom, since when, and where does the time go?") using the signals it emits: **metrics, logs and traces**.

## model | Signals and the golden four

```diagram
obs-pillars
```

```diagram
golden-signals
```

- **Metrics** are numbers sampled over time with labels: `http_requests_total{route="/checkout",status="500"}`. Cheap to store, great for trends and alerts.
- **Logs** are timestamped events with details (ideally structured JSON with a `trace_id`).
- **Traces** follow one request through every service it touches, as a tree of timed **spans**.
- For every service, start with the **golden signals**: latency, traffic, errors, saturation. Look at **percentiles** (p99) for latency, never only averages.
- **Prometheus** is the standard open-source metrics system: it *scrapes* `/metrics` endpoints and lets you query with **PromQL**.

In the age of AI, assistants can summarise dashboards and suggest causes, but only if the signals exist. Instrumentation is the foundation; an AI with no data can only guess.

## commands | A first look at the signals

```term
$ curl -s web1:3000/metrics | head                 # what an app exposes
$ promtool query instant http://mon:9090 'up'       # which targets are up
$ promtool query instant http://mon:9090 'sum(rate(http_requests_total[5m]))'
$ promtool query instant http://mon:9090 \
    'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))'
$ curl -s 'http://mon:9090/api/v1/query?query=up'   # same, over the HTTP API
```

## analogy | A car dashboard and a mechanic

The speedometer and fuel gauge are metrics: always on, glanceable. The service history booklet is logs: what happened, when. A mechanic following one strange noise from the engine through the gearbox to the wheel is a trace. You need the dashboard to notice a problem and the other two to explain it.

## team | Observability habits

- **Instrument when you build**, not after the first outage: every service exposes RED metrics and structured logs.
- **Consistent labels** (`service`, `env`, `route`) across metrics, logs and traces.
- **Dashboards per service** that answer "is it healthy?" in five seconds.
- **Alert on symptoms users feel** (errors, latency), investigate causes with the rest.

## traps | Observability traps

**Averages**: a 120 ms average hides one user in a hundred waiting 8 seconds.

**SSH-ing around** instead of looking at history: by the time you log in, the spike is over.

**Labels with unbounded values** (user IDs, full URLs) explode the number of time series.

**Collecting everything, looking at nothing**: signals only help when someone has decided what "healthy" means.

## lab | The golden signals tour

Prometheus on `mon` already scrapes the shop on `web1`. Use PromQL to read the four golden signals before anyone complains.
