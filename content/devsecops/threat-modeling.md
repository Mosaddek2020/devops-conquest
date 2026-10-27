## story | The redis that anyone could read

Lumen's team spent a week adding login rate limits to the shop. Meanwhile the session cache, a Redis on the same server, listened on every interface with no password. Anyone on the internet who found port 6379 could read every customer's session and log in as them. No one had attacked the login form; they never needed to.

Security work goes wrong when it starts with tools instead of questions. **Threat modelling** asks four questions before you buy or build anything: *What are we building? What can go wrong? What are we going to do about it? Did we do a good job?*

```diagram
shift-left
```

## model | Attack surface, STRIDE and least privilege

- **Attack surface** is everything an attacker can reach: open ports, logins, APIs, files readable by other users, people with access. Shrinking it is the cheapest security there is.
- **STRIDE** is a checklist for "what can go wrong" per component: **S**poofing (pretending to be someone), **T**ampering (changing data or code), **R**epudiation (denying an action, no audit trail), **I**nformation disclosure (leaks), **D**enial of service, **E**levation of privilege.
- **Least privilege**: every user, service and key gets only what it needs. Services do not run as root, databases listen on localhost, sudo is not passwordless-for-everything.
- **Defence in depth**: several independent layers (firewall *and* bind address *and* password), so one mistake is not a breach.
- **Shift left**: find problems while designing and coding, when they are cheap, not after an attacker does. Then keep checking in CI and production.
- Audit tools such as **lynis** turn a hardening checklist into a repeatable scan with a score you can track.

## commands | Measure the attack surface of a server

```term
$ sudo ss -tlnp                  # what listens, and on which address?
$ sudo lynis audit system        # hardening warnings and an index
$ sudo sshd -t                   # check sshd_config before reloading
$ sudo ufw status verbose
$ ls -l /etc/shop/               # who can read the secrets?
```

## analogy | Walking around your own house

Before buying a better front-door lock, walk around the house as a burglar would: the back door is open, the garage key hangs on a nail outside, the window to the basement does not close. Threat modelling is that walk, done on paper for every component.

## team | Threat modelling as a habit

- **Do it in design reviews**: draw the data flow, then go through STRIDE for each box and arrow. Thirty minutes beats a postmortem.
- **Record threats with owners**, like any other backlog item.
- **Rescan regularly** (lynis in CI or a nightly job) so drift shows up as a falling score.
- **AI helps brainstorm** threats from a diagram, but it does not know your network or your data: verify every claim.

## traps | Threat modelling traps

**Starting with tools.** A scanner finds what it checks for, not what matters most to you.

**Trusting the network.** "It is only reachable internally" until a VPN account, a misconfigured firewall or a compromised laptop makes it reachable.

**Locking yourself out.** Disabling root SSH or enabling a firewall without checking that your own key-based login and port 22 still work.

**One big list nobody owns.** Threats need owners and dates, like bugs.

## lab | Harden the shop server

`web1` runs the shop, nginx and Redis. Audit it with lynis, shrink its attack surface without locking yourself out, and write a short STRIDE threat model.
