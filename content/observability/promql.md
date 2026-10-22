## story | The graph that only went up

Lumen's first "requests" graph showed a line climbing steadily all day, every day. "Traffic is growing nicely!" Except it was a **counter**: the total number of requests since the process started. It only ever goes up (until a restart resets it). What people actually wanted was requests **per second**, which you get with `rate()`. Learning a handful of PromQL patterns turns raw counters into answers.

## model | The PromQL patterns you use every day

| You want | PromQL |
|---|---|
| current value of a gauge | `node_load1` |
| filter by labels | `http_requests_total{job="shop", route="/checkout"}` (`=~` for regex, `!=`, `!~`) |
| per-second rate of a counter | `rate(http_requests_total[5m])` |
| total over the window | `increase(http_requests_total[1h])` |
| add up across instances | `sum by (route) (rate(http_requests_total[5m]))` |
| error ratio | `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))` |
| latency percentile | `histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))` |
| biggest N | `topk(3, sum by (route) (rate(http_requests_total[5m])))` |
| a condition (for alerts) | `up == 0`, `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1` |

- An **instant vector** has one value per series; a **range vector** (`[5m]`) has a window of samples and must go into a function like `rate`.
- **`rate` first, then `sum`**: `sum(rate(x[5m]))`, never `rate(sum(x))`. Rates handle counter resets per series.
- `by (label)` keeps those labels; `without (label)` drops them.
- For histograms, keep `le` when you sum: `sum by (le, route) (...)`.

## commands | Querying

```term
$ promtool query instant http://mon:9090 'sum by (route) (rate(http_requests_total[5m]))'
$ curl -s --get 'http://mon:9090/api/v1/query' --data-urlencode 'query=topk(1, sum by (route) (rate(http_requests_total[5m])))'
$ curl -s 'http://mon:9090/api/v1/label/__name__/values' | jq -r '.data[]' | head
```

## analogy | An odometer and a speedometer

A counter is a car's odometer: total kilometres, always increasing. `rate()` turns it into a speedometer. Nobody drives by the odometer; nobody alerts on a raw counter.

## team | Query habits

- **Save good queries** as recording rules or dashboard panels, with names (`job:http_requests:rate5m`).
- **Use `[5m]` or longer windows** for rates scraped every 15 s, so you have enough samples.
- **Check queries against reality** (a curl, a log count) before trusting a dashboard someone, or an AI, wrote.

## traps | PromQL traps

**Graphing a counter without `rate`.**

**`rate(sum(...))`**: counter resets get lost; always rate before sum.

**Dropping `le`** before `histogram_quantile`: nonsense results.

**Dividing vectors with different labels**: no matches, empty result. Aggregate both sides to the same labels.

## lab | Answer the product team

The product team has questions about the shop. Answer each with one PromQL query against Prometheus on `mon`.
