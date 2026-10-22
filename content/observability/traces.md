## story | Which of the five services is slow?

A checkout at Lumen touches five services: the shop, auth, cart, payments and an external bank API. When p99 checkout latency tripled, each team looked at its own dashboard and said "we're fine". Every service *was* mostly fine; payments was waiting on the bank API, which only became slow for one card type. A single **trace** of a slow checkout showed it in one picture: 2.9 of the 3.1 seconds were inside the `bank-api: authorize card` span.

## model | Traces, spans and propagation

- A **trace** is one request's journey; it has a **trace ID**.
- Each unit of work is a **span**: service, operation name, start, duration, status, attributes. Spans nest (parent/child) into a tree.
- **Context propagation**: each service passes the trace ID to the next (the W3C `traceparent` HTTP header), so spans from different services join one trace.
- **OpenTelemetry** is the standard for producing traces (and metrics and logs); backends like Jaeger or Grafana Tempo store and show them.
- **Sampling**: storing every trace is expensive; keep a fraction, plus all errors and slow ones.
- Read a trace as a **waterfall**: the widest bar on the critical path is where the time goes.

```term
shop: POST /checkout              ████████████████████████████████████████  3104ms
  auth: verify session            ██                                          41ms
  payments: POST /charge             ████████████████████████████████████  2980ms
    bank-api: authorize card          ███████████████████████████████████  2911ms
  db: INSERT order                                                       █    22ms
```

## commands | Finding and reading traces

```term
$ traces search --service shop --route /checkout --min-duration 1s --limit 5
$ traces search --service shop --status error
$ traces show <trace-id>
$ logcli query '{app="shop"} | json | duration_ms > 2000' --limit 3    # trace_id is in the line
```

## analogy | Tracking a parcel

A parcel's tracking page lists every hop: collected, sorting centre, plane, local depot, van. When a parcel is late, you don't ask every depot whether they're slow in general; you look at this parcel's hops and see it sat at one depot for two days.

## team | Tracing habits

- **Instrument at the edges first** (incoming HTTP, outgoing HTTP and database calls); OpenTelemetry auto-instrumentation covers most of it.
- **Propagate context everywhere**, including through queues.
- **Put the trace ID in every log line** and in error responses.
- **Keep all error traces** and a sample of the rest.

## traps | Tracing traps

**Broken propagation**: each service starts its own trace and you see fragments.

**Tracing only one service**: you see that it is slow, not why.

**Too many tiny spans** (one per loop iteration): noise and cost.

**Sampling away the interesting ones**: always keep errors and slow requests.

## lab | Follow the slow checkout

Checkout p99 is high. Find slow checkout traces, read the waterfall, and confirm the culprit with a trace ID from the logs.
