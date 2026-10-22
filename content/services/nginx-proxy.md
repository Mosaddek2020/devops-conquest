## story | Port 3000 on the internet

Lumen's first public API listened directly on port 3000, open to the world. Then they needed HTTPS, then a second app on the same server, then a rate limit for a scraper, then gzip, then a maintenance page during deploys. Each feature meant code in each app.

The fix was a **reverse proxy**: nginx on ports 80 and 443, terminating TLS, compressing, limiting and routing; apps listening only on `127.0.0.1`, focused on business logic. Today almost every web service you will operate sits behind a proxy or load balancer like this.

## model | How nginx routes a request

```diagram
reverse-proxy
```

nginx's configuration is blocks and directives ending in `;`:

```term
server {
    listen 80;
    server_name notes.lumen.example.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location /static/ {
        root /var/www/notes;
    }
}
```

1. nginx picks the **server** block by port and `server_name` (the `Host` header), falling back to the `default_server`.
2. Inside it, the most specific **location** wins: `=` exact, then the longest prefix, then regular expressions.
3. The location either serves files (`root`, `try_files`), redirects (`return 301 …`), or forwards to an app (`proxy_pass`).

On Ubuntu, site configs live in `/etc/nginx/sites-available/`, and are switched on with a **symlink** in `sites-enabled/`. Always test before reloading: `nginx -t` checks the syntax, and `systemctl reload nginx` applies it without dropping connections. A config with an error never takes effect if you test first.

When the app behind a `proxy_pass` is down, nginx answers **502 Bad Gateway** and writes the reason to `/var/log/nginx/error.log`.

## commands | Working with nginx

```term
$ sudo nano /etc/nginx/sites-available/notes
$ sudo ln -s /etc/nginx/sites-available/notes /etc/nginx/sites-enabled/
$ sudo rm /etc/nginx/sites-enabled/default        # if you don't need the welcome page
$ sudo nginx -t                                   # syntax check
$ sudo systemctl reload nginx                     # apply without downtime
$ curl -H "Host: notes.lumen.example.com" http://localhost/   # test a server block locally
$ sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

## analogy | A hotel reception

Guests (requests) arrive at one front desk (nginx on 80/443). The receptionist checks which hotel wing they want (server_name) and which department (location), then either hands them a brochure from the rack (static files), points them to the other entrance (redirect), or phones the department and relays the answer (proxy_pass). If the department doesn't pick up, the receptionist says so politely: 502.

## team | Proxies in production

- **Apps bind to 127.0.0.1** (or a private network); only the proxy is public.
- **`nginx -t && systemctl reload nginx`** is one habit, every time.
- **Config in git**, deployed by automation, so every change is reviewed and reversible.
- At larger scale the same role is played by cloud load balancers and Kubernetes ingress controllers: same concepts, different config syntax.

## traps | nginx traps

**Missing semicolon.** `nginx -t` points at the line *after* it: `unexpected "}"`.

**Editing `sites-available` without linking it.** The file exists, nginx never reads it.

**`proxy_pass http://127.0.0.1:4000/` vs without the slash.** With a URI part, the matched location prefix is replaced: `/api/x` can become `/x`.

**Restarting instead of reloading.** Restart drops in-flight connections; reload swaps workers gracefully.

## lab | Put the notes API behind nginx

The notes API runs on web1, on 127.0.0.1:4000. Publish it at `http://notes.lumen.example.com` through nginx, serve its static files directly, and practise reading a 502.
