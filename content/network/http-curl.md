## story | The redirect loop that wasn't

Monday morning, the mobile app showed "too many redirects" for half the users. The developers swore nothing had changed. Amira ran one command:

```term
$ curl -sI https://api.lumen.example.com/v2/events
HTTP/1.1 301 Moved Permanently
Location: https://api.lumen.example.com/v2/events/
```

and then the same with the trailing slash, which redirected back without it. A new load balancer rule added slashes; the app removed them. Two components, each "correct", sending the client back and forth forever. Reading raw HTTP headers turned a two-day blame game into a ten-minute fix.

HTTP is the language of almost everything you will operate: websites, APIs, health checks, webhooks, Kubernetes probes, cloud APIs. Being able to speak it directly with `curl` is a superpower.

## model | Requests and responses

A **request** has a method, a path, headers and an optional body:

```term
POST /v1/tickets HTTP/1.1
Host: api.lumen.example.com
Authorization: Bearer 7f3a…
Content-Type: application/json

{"event": 42, "seats": 2}
```

A **response** has a status code, headers and a body:

```term
HTTP/1.1 201 Created
Content-Type: application/json

{"ticket": "T-9912", "seats": 2}
```

**Methods** say what you want: `GET` reads, `POST` creates, `PUT`/`PATCH` update, `DELETE` removes. `HEAD` is GET without the body.

**Status codes** say what happened:

| Range | Meaning | Common ones |
|---|---|---|
| 2xx | Success | 200 OK, 201 Created, 204 No Content |
| 3xx | Go elsewhere | 301 Moved Permanently, 302 Found, 304 Not Modified |
| 4xx | *Your* request is wrong | 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 429 Too Many Requests |
| 5xx | *The server* failed | 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout |

**Headers** carry metadata: `Content-Type`, `Location` (where a redirect points), `Authorization`, `Cache-Control`, `Set-Cookie`.

## commands | curl, the HTTP Swiss army knife

```term
$ curl https://api.example.com/v1/events            # GET, print the body
$ curl -i  URL                                      # include status line and headers
$ curl -I  URL                                      # headers only (HEAD)
$ curl -L  URL                                      # follow redirects
$ curl -v  URL                                      # the whole conversation
$ curl -s  URL | jq '.[0]'                          # quiet, pipe JSON into jq
$ curl -X POST -H "Content-Type: application/json" \
       -d '{"seats":2}' URL                         # send a body
$ curl -H "Authorization: Bearer $TOKEN" URL        # add a header
$ curl -sf URL || echo "down"                       # -f: fail on 4xx/5xx (for scripts)
$ curl -s -o /dev/null -w "%{http_code}\n" URL      # just the status code
```

## analogy | Ordering at a counter

A request is your order: what you want (method), from which menu item (path), with notes (headers) and maybe a filled-in form (body). The response starts with a one-word verdict: "here you go" (200), "it moved to the other counter" (301), "you didn't pay" (401), "we don't sell that" (404), "the kitchen is on fire" (500). Read the verdict before you look at the plate.

## team | HTTP in daily operations

- **Health endpoints** (`/health`, `/ready`) return 200 when the service can do its job. Load balancers, Kubernetes and monitors call them constantly.
- **Status codes drive alerts**: a rising share of 5xx means the server side is failing; 4xx usually means clients or bad deploys of clients.
- **`curl -v` is the first tool in any "it doesn't work" thread**: paste the exact request and response, not "the API is broken".

## traps | HTTP traps

**Reading only the body.** An error page with status 200, or JSON with status 500: always check the status line (`-i`).

**`curl -k` in scripts.** It disables certificate checks; fine for a one-off test, a security hole when left in automation.

**Not following redirects.** Without `-L`, curl shows the 301 and stops; with `-L` in a loop, you will see redirect loops quickly.

**Tokens in shell history.** `curl -H "Authorization: Bearer abc123"` lands in `~/.bash_history`. Read tokens from a file or variable.

## lab | Talk to the Lumen API

The Lumen API lives at `https://api.lumen.example.com`. Use curl to read events, follow a redirect, and buy tickets, which needs the token stored in `~/api-token.txt`.
