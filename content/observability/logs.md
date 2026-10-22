## story | grep across eight servers

When checkout broke, the team's log investigation was eight SSH sessions and `grep error /var/log/shop/*.log`. The messages said `Error: undefined` with no request ID, no route, no customer. Nobody could tell which errors belonged to the incident.

Useful logs are **structured** (one JSON object per line with consistent fields), **centralised** (shipped to one searchable store like Loki or Elasticsearch), and **correlated** (a `trace_id` ties a log line to the request's trace).

## model | Structured, central, correlated

```term
{"ts":"2026-03-07T19:41:02Z","level":"error","msg":"payment provider timeout",
 "route":"/checkout","status":502,"duration_ms":2000,"trace_id":"4ef68c36def6…"}
```

- **Labels** identify the stream (`{app="shop", host="web1", level="error"}`); keep them few and low-cardinality.
- **Fields** inside the JSON carry the details; query them after parsing.
- **LogQL** (Loki's query language): a stream selector, then a pipeline:

```term
{app="shop"} |= "timeout"                                   # lines containing text
{app="shop", level="error"} | json | route="/checkout"      # parse JSON, filter on a field
{app="shop"} | json | duration_ms > 1000                    # slow requests
sum by (status) (count_over_time({app="shop"} | json [5m])) # turn logs into numbers
```

- Logs are expensive at volume: **sample** successful requests, keep all errors, set retention.
- **Never log secrets** or full personal data.

## commands | Searching logs

```term
$ logcli query '{app="shop", level="error"}' --since=30m --limit=20
$ logcli query '{app="shop"} | json | route="/checkout" | status >= 500'
$ logcli query 'sum by (msg) (count_over_time({app="shop", level="error"} | json [10m]))'
$ journalctl -u shop -o json | jq -r '.MESSAGE' | head     # on one machine
```

## analogy | A ship's logbook

A ship's log is useful because every entry has the same shape: time, position, heading, event. A pile of sticky notes ("engine weird??") is not. And when the coast guard asks about one particular night, the entries are all in one book, not in each sailor's pocket.

## team | Logging habits

- **One JSON format** across services, with `ts`, `level`, `msg`, `service`, `trace_id`.
- **Log levels mean something**: error = a human may need to look.
- **Centralise** with an agent (Promtail, Fluent Bit, Vector) and set **retention** per environment.
- **Link logs ↔ traces** via `trace_id`.

## traps | Logging traps

**Unstructured text** that needs regexes to parse.

**High-cardinality labels** (user IDs as labels): use fields instead.

**Logging every success at info in hot paths**: cost explodes, signal drowns.

**Passwords, tokens or card numbers in logs.**

## lab | What the errors say

The shop's error rate is up. Use LogQL to find which route fails, what the error says, and one request's trace ID.
