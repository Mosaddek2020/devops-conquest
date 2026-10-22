## story | The certificate nobody owned

On a Saturday morning, Lumen's checkout started failing for every customer: browsers showed a full-page warning, *Your connection is not private*. The TLS certificate had expired at midnight. It had been bought two years earlier by someone who had since left; the renewal reminders went to their old mailbox.

Expired certificates are one of the most common causes of outages, at companies of every size. The fix that day took ten minutes. The lasting fix was to stop buying certificates by hand: free, automated certificates from Let's Encrypt, renewed by a timer every 60 days, and a monitor that alerts 14 days before any certificate expires.

## model | What TLS gives you

**TLS** (the S in HTTPS) provides two things:

1. **Encryption**: nobody between client and server can read or change the traffic.
2. **Identity**: the client can be sure it is talking to the real `shop.example.com`, not an impostor.

Identity comes from a **certificate**: a document saying "this public key belongs to shop.example.com", signed by a **certificate authority (CA)** your browser or OS already trusts.

```diagram
tls
```

A client rejects a certificate when it is:

- **expired** (or not yet valid);
- **for another name** (the name must match the certificate's subject or a SAN entry);
- **self-signed** or signed by an unknown CA.

**Let's Encrypt** issues free 90-day certificates automatically. Its tool `certbot` proves you control the domain (the HTTP-01 challenge: Let's Encrypt fetches a file from `http://yourdomain/.well-known/…`, so port 80 must be reachable), installs the certificate in nginx, and renews it on a timer.

Once HTTPS works, redirect all HTTP traffic to HTTPS (`301`), so nobody keeps using the insecure version.

## commands | Inspecting and fixing TLS

```term
$ curl -I https://shop.example.com                      # does it work?
$ curl -v https://shop.example.com 2>&1 | grep -i expire
$ openssl s_client -connect shop.example.com:443 -servername shop.example.com
$ openssl x509 -in cert.pem -noout -dates -subject      # read a certificate file
$ sudo certbot --nginx -d shop.example.com              # get + install a certificate
$ sudo certbot certificates                             # what do we have, when does it expire?
$ sudo certbot renew --dry-run                          # does renewal work?
```

## analogy | A passport at the border

A certificate is a passport. The name on it must match the person (the domain), it must not be expired, and it must be issued by a country the border officer recognises (a trusted CA). A self-signed certificate is a passport you printed yourself: maybe the details are true, but no officer can trust it.

## team | Certificates as a system, not a chore

- **Automate issuance and renewal** (certbot, cert-manager in Kubernetes, managed certificates at the load balancer).
- **Monitor expiry** independently of the renewal tool, with alerts weeks ahead.
- **Own it**: certificates and DNS belong to a team, not to a person's mailbox.
- **Redirect HTTP to HTTPS** and consider HSTS once everything works over HTTPS.

## traps | TLS traps

**`curl -k` "fixes" it.** It only stops curl from checking. Browsers and other clients still fail.

**Blocking port 80 entirely.** It breaks the HTTP-01 challenge, so renewal fails silently weeks later.

**Certificate for `www` only.** `example.com` and `www.example.com` are different names; include both.

**Testing on the server.** Check from outside, with the real hostname, so SNI and DNS are exercised.

## lab | Saturday morning

`https://shop.example.com` is down for every customer with a certificate error. The site runs nginx on **web1**; you can SSH in. Diagnose it, get a fresh Let's Encrypt certificate, and make sure it renews on its own.
