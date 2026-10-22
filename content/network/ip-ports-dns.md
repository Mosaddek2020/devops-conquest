## story | The migration that worked everywhere except for customers

Lumen moved its API to a new server on a Tuesday evening. The team updated the DNS record, tested from their laptops, and saw the new server answer. Everyone went home.

Overnight, a third of customers kept hitting the *old* server, which had been switched off. The DNS record had a **TTL of 24 hours**: resolvers around the world had cached the old address and would not ask again until the next day. The team's laptops had asked fresh. Customers' internet providers had not.

The fix next time was simple and boring: lower the TTL to 5 minutes a day *before* a migration, move, verify, then raise it again. Networking problems are rarely mysterious once you know where each piece of information lives and how long it is remembered.

## model | Addresses, ports and names

An **IP address** identifies a machine on a network: `10.0.0.12`, `203.0.113.7`. Some ranges are **private** (`10.x`, `172.16-31.x`, `192.168.x`): reachable only inside a network, like servers in a cloud VPC. Others are **public**, reachable from the internet.

A **port** (0 to 65535) identifies a service on that machine. A program **listens** on a port; clients **connect** to address + port.

| Port | Usually |
|---|---|
| 22 | SSH |
| 80 / 443 | HTTP / HTTPS |
| 5432 | PostgreSQL |
| 6379 | Redis |
| 3000, 8080 | app servers in development |

Where a program listens matters as much as the port:

```diagram
bind-address
```

**DNS** turns names into addresses. Your machine asks a resolver, which asks the authoritative servers for the domain, and caches the answer for the record's **TTL**. Common record types:

| Record | Maps | Example |
|---|---|---|
| A | name → IPv4 address | `api.lumen.example.com → 10.0.0.12` |
| AAAA | name → IPv6 address | |
| CNAME | name → another name | `www → lumen.example.com` |
| MX | domain → mail servers | |
| TXT | name → text (verification, SPF) | |

`/etc/hosts` is checked *before* DNS: a local override, handy for testing and dangerous when forgotten.

When a connection fails, the error tells you where:

- **Could not resolve host**: DNS has no answer (wrong name, missing record).
- **Connection refused**: the machine answered "nothing listens on that port" (or only on 127.0.0.1).
- **Timed out**: nothing answered at all: usually a firewall dropping packets, or the host is down.

## commands | Looking at the network

```term
$ ip a                       # my addresses (inet 10.0.0.10/24 on eth0)
$ ip route                   # where packets go by default
$ sudo ss -tlnp              # listening TCP ports, with the owning process
$ dig +short api.lumen.example.com   # name → address
$ dig www.lumen.example.com          # full answer, including CNAMEs and TTL
$ nslookup api.lumen.example.com     # the older tool, same idea
$ cat /etc/hosts             # local overrides
$ nc -zv db.lumen.internal 5432      # is that TCP port reachable?
$ ping -c 3 web1             # does the host answer at all (if ICMP is allowed)?
```

## analogy | Apartment buildings and a phone book

An IP address is a building's street address. A port is the apartment number inside: the building can be right there, but if nobody lives in apartment 5432, your knock goes unanswered (refused). A firewall is a doorman who silently turns you away without a word (timeout). DNS is the phone book that turns "Lumen API" into an address, and the TTL is how long people keep using the page they copied before checking the book again.

## team | Network hygiene

- **Bind databases and admin tools to private interfaces** (127.0.0.1 or a private IP), never to the public internet.
- **Lower DNS TTLs before migrations**, then raise them again.
- **Name things**: use DNS names in config, not IP addresses, so you can move services without editing every app.
- **Document ports and flows**: which service talks to which, on which port. It is the map you need during incidents and security reviews.

## traps | Network traps

**"It works on my machine" with `/etc/hosts`.** A forgotten override on your laptop hides a broken DNS record.

**Testing from the server itself.** `curl localhost:3000` working proves the app runs; it says nothing about whether anyone *else* can reach it.

**Confusing refused and timed out.** They point to different causes: a stopped service versus a firewall.

**Hard-coded IPs.** They break silently when servers are replaced.

## lab | Map the network

You are on your laptop, connected to Lumen's internal network. Find your own address and listening ports, query DNS, and test which services are reachable. Pay attention to *how* each failure fails.
