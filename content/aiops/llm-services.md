## story | The summary that cost 6,000 dollars

Lumen's support team built a document summariser on top of a hosted model, behind a small gateway. A bug made it retry on timeouts without a limit, sending the same 40-page documents again and again and asking for 1,500-token answers. Error rates were fine and latency was "as usual for LLMs". The first alert was the provider's invoice.

Running AI features is operations work: **requests, latency, errors, and now tokens and money**. The same golden signals apply, plus cost, and a few new levers.

```diagram
llm-cost
```

## model | Operating an LLM gateway

- **Tokens are the unit of cost and of latency.** Input tokens (the prompt) and output tokens (the answer) are priced separately; output usually costs several times more and arrives a few dozen tokens per second.
- **Measure per client**: `llm_tokens_total{client,direction}`, `llm_cost_usd_total{client}`, `llm_requests_total{client,status}` and `llm_request_duration_seconds`.
- **Levers in the gateway**:
  - **rate limits** per client (requests per minute), so one buggy caller cannot spend for everyone;
  - **max output tokens**, to stop runaway answers;
  - **response caching** for identical prompts;
  - fallbacks to a cheaper or smaller model.
- **Alert on spend** like on errors: dollars per hour over a budget for 10 minutes pages someone, long before the invoice.
- **429 is a feature**: rate-limited callers should back off with jitter, not retry immediately.

## commands | Find the spender, add limits, alert

```term
$ promtool query instant http://mon:9090 'sum by (client) (rate(llm_cost_usd_total[5m])) * 3600'
$ promtool query instant http://mon:9090 'sum by (client, direction) (rate(llm_tokens_total[5m]))'
$ sudo nano /etc/llm-gateway/config.yaml && sudo systemctl restart llm-gateway
$ promtool check rules /etc/prometheus/rules.yml && sudo systemctl reload prometheus
```

## analogy | A shared company credit card

Every team uses the same card. Without per-team limits and a daily statement, one team's runaway subscription is discovered at the end of the month. Rate limits are the per-team limit; the spend alert is the daily statement.

## team | AI features in production

- **Budgets per feature**, with an owner, and dashboards showing cost next to traffic.
- **Load-test with realistic prompts**: token counts, not just request counts, drive cost and latency.
- **Cache and cap by default**; raise limits on request, with a reason.
- **Include cost in incident severity**: a spend spike is an incident even if users see nothing.

## traps | LLM service traps

**Retrying on timeout without a limit or backoff.**

**No max output tokens**, so one prompt can ask for an essay.

**Only watching errors and latency** while the money burns.

**One shared API key for every caller**, so you cannot tell who spends.

## lab | The runaway summariser

The LLM gateway on `ai1` is spending far too much, and Prometheus on `mon` scrapes its metrics. Find which client is spending, put limits and caching in the gateway, alert on spend, and prove the spend rate is back under budget.
