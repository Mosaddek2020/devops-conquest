## story | 40,000 exposed databases

Every year, security researchers scan the internet and find tens of thousands of Redis, MongoDB and Elasticsearch servers answering anyone who asks, many without a password. Most were not "hacked" in any clever way. Someone started a database on a cloud VM, it listened on all interfaces by default, and nothing stood between it and the internet.

Lumen nearly joined that list. A developer installed Redis on an app server for a quick cache experiment. A routine `nmap` from outside showed port 6379 open to the world. Nobody had decided that; nobody had blocked it either. The team made a rule that day: **every server starts with a default-deny firewall**, and every open port is a deliberate, documented decision.

## model | Default deny, explicit allow

A **firewall** decides which network traffic may reach a machine. On Ubuntu, `ufw` (uncomplicated firewall) is a friendly front end to the kernel's packet filter.

The safe model:

1. **Default deny incoming**: nothing gets in unless allowed.
2. **Allow exactly what the machine serves**: SSH for admins, 80/443 for a web server.
3. **Restrict internal services by source**: the database port only from the app servers' addresses.
4. Outgoing traffic is usually allowed (updates, APIs), though strict environments limit it too.

In the cloud you also have **security groups** (or network ACLs): firewalls in front of each VM, managed by the provider. Defense in depth means using both.

What a blocked port looks like from outside is the key debugging clue:

| What you see | Means |
|---|---|
| Connection refused | the packet arrived; nothing listens there |
| Timed out / filtered | the packet was dropped on the way: a firewall |
| Open | something listens and you are allowed in |

## commands | Building a firewall without locking yourself out

```term
$ sudo ufw status verbose                # is it on? which rules?
$ sudo ufw default deny incoming         # the safe default
$ sudo ufw allow OpenSSH                 # FIRST: keep your way in
$ sudo ufw allow 'Nginx Full'            # 80 and 443
$ sudo ufw allow from 10.0.0.21 to any port 6379   # one client only
$ sudo ufw enable                        # turn it on
$ sudo ufw status numbered               # rules with numbers
$ sudo ufw delete 3                      # remove rule number 3
$ nmap -p 1-10000 app1                   # from OUTSIDE: what is really reachable?
```

The order matters: allow SSH *before* `ufw enable` when you are connected over SSH. Otherwise the firewall drops your own session, and you need the cloud provider's console to get back in.

## analogy | A nightclub door

Default deny is a club with a guest list: if you are not on it, you do not get in, no matter how nicely you ask. Allow rules are names on the list ("anyone for the main room, ports 80 and 443"; "only the staff from the kitchen for the storeroom, port 6379"). A timeout is the bouncer ignoring you entirely. Forgetting to put yourself on the list before locking the door is how you end up calling the landlord (the cloud console) at midnight.

## team | Firewalls in a team

- **Rules as code**: firewall rules and security groups live in Terraform or Ansible (later realms), reviewed like any change.
- **Scan yourself regularly** from outside the network. What you *think* is exposed and what *is* exposed drift apart.
- **Prefer private networks** for internal traffic; then even a misconfigured service is not on the internet.
- **Document every open port** with an owner and a reason.

## traps | Firewall traps

**Locking yourself out** by enabling a default-deny firewall without an SSH rule.

**"It's behind the firewall, so no password needed."** Firewalls get misconfigured; services still need authentication.

**Opening a port to `0.0.0.0/0` "temporarily".** Temporary rules are the ones nobody removes.

**Testing from the server itself.** Local connections bypass the host firewall. Test from another machine.

## lab | Close the doors

Server **app1** runs nginx (web), an internal app on port 3000 and Redis on 6379, with no firewall at all. From your laptop, see what is exposed, then lock app1 down so the public only reaches the website, and only the worker server can reach Redis. If you lock yourself out, `console app1` opens the cloud provider's emergency console.
