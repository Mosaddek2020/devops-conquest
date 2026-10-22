## brief | The site is down

**Friday, 17:40.** Lumen's events site, `https://events.lumen.example.com`, is down. Over the afternoon the team migrated it from the old server **web-old** to a new server **web3**, and "it worked when we tested". Customers disagree.

Several things are wrong at once. That is normal in real incidents: fix one, and the next one appears. Work from the outside in: **name → network → port → process → configuration**, and confirm each fix from your laptop, the way customers see it.

Tools you have: `dig`, `curl`, `nc`, `ssh ubuntu@web3`, and the DNS provider's CLI, `dnsctl` (`dnsctl list`, `dnsctl set <name> A <ip>`).

## recap | What the Networking realm gave you

- IP addresses, ports, listening addresses (127.0.0.1 vs 0.0.0.0), DNS records, TTLs and `/etc/hosts`.
- HTTP: methods, status codes, headers, redirects; `curl -i`, `-I`, `-L`, `-v`, `-w`.
- SSH with keys, `~/.ssh/config`, `scp`, and the permission rules SSH enforces.
- Firewalls: default deny, allow SSH first, refused versus timed out, scanning from outside.
- TLS: certificates, CAs, expiry, names, certbot and automatic renewal.

## lab | Bring the events site back

Fix every layer until `curl https://events.lumen.example.com/` returns **200** from your laptop, then write a short summary in `~/postmortem.md`.
