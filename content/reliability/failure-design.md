## story | The shop that lived on one server

For a year, Lumen's shop ran on `web1` behind an nginx proxy. When `web1` needed a kernel patch, the shop went down for twelve minutes "for maintenance". When its disk filled at 3 a.m., the shop was down until someone woke up. A second server, `web2`, existed, set up identically, and served nothing: nginx only knew about `web1`.

Everything fails eventually: disks, processes, networks, whole data centres. **Reliability engineering** accepts that and designs so that one failure doesn't become an outage.

## model | Designing for failure

```diagram
redundancy
```

- A **single point of failure (SPOF)** is any component whose failure takes the service down. Find them by asking "what if this dies?" for every box in your diagram.
- **Redundancy**: run at least two of everything that serves users, behind something that routes around failures (a load balancer with health checks or retries).
- **Timeouts** everywhere: a call without a timeout can hang a thread forever when the other side stalls.
- **Retries with backoff and jitter**: retry transient failures, waiting longer each time (1s, 2s, 4s… plus randomness) so thousands of clients don't hammer a recovering service in sync.
- **Graceful degradation**: if recommendations are down, show the shop without them instead of failing the whole page.
- In nginx, an `upstream` block lists servers; nginx spreads requests across them (round robin) and tries the next one when a connection fails. `backup` servers are used only when all others are down.

```term
upstream shop {
    server web1:3000;
    server web2:3000;
    server web3:3000 backup;
}
server {
    listen 80;
    location / { proxy_pass http://shop; }
}
```

## commands | Testing resilience

```term
$ ab -n 200 -c 10 http://shop.lumen.dev/          # load test: Failed / Non-2xx should be 0
$ ssh ubuntu@web1 sudo systemctl stop shop          # take one away
$ ab -n 200 -c 10 http://shop.lumen.dev/          # still 0 errors?
$ sudo tail /var/log/nginx/error.log               # nginx noticed and failed over
$ curl -sI http://shop.lumen.dev/ | grep -i upstream
```

## analogy | Spare tyres and two engines

A car carries a spare tyre because tyres fail; a passenger jet has two engines because engines fail, and it can fly on one. Nobody calls a puncture "unexpected". Design your services the same way: assume parts will fail and make sure the trip continues.

## team | Reliability habits

- **Draw the architecture and mark SPOFs**; fix the ones that matter most first.
- **N+1 capacity**: with one server down, the rest must handle the load.
- **Test failover regularly**, not only during incidents.
- **Every network call has a timeout**; retries are bounded and backed off.

## traps | Reliability traps

**A redundant server nobody routes to** (or that has drifted out of date).

**Retries without backoff**: a retry storm turns a blip into an outage.

**Health checks that always say OK**, so the load balancer keeps sending traffic to a broken instance.

**Forgetting the layer above**: two app servers behind one load balancer still have a SPOF.

## lab | Two servers are better than one

The shop goes down whenever `web1` does. Prove it, fix it with an nginx upstream, prove the fix, and find the next single point of failure.
