## story | The service that could read everything

A vulnerability in an image-processing library let an attacker run code inside Lumen's shop process. The shop ran as **root**, so the attacker could read every file on the server, including other services' secrets and the SSH host keys, and install a backdoor. Two months later, a memory leak in the same service slowly ate the server's RAM until the kernel's OOM killer, picking the biggest process, killed it at 3 AM and nothing brought it back.

**systemd** can contain both problems with a few lines of configuration. A service can run as an unprivileged user, see most of the filesystem read-only, never gain new privileges, and live inside a memory limit that makes a leak a quick, contained restart instead of a slow, server-wide outage.

## model | Least privilege and limits for services

- **Drop-ins** change a unit without editing the packaged file: `sudo systemctl edit shop` opens `/etc/systemd/system/shop.service.d/override.conf`. Settings there override the unit file; `systemctl cat shop` shows both.
- **`User=`**: run as a dedicated, unprivileged account (the files it writes must belong to that user).
- **Sandboxing**:
  - `NoNewPrivileges=yes`: no setuid escalation;
  - `ProtectSystem=strict`: the whole filesystem read-only, except
  - `ReadWritePaths=/var/lib/shop`: the paths the service really writes;
  - `ProtectHome=yes`: no access to /home or /root;
  - `PrivateTmp=yes`: its own /tmp.
- **`systemd-analyze security shop`** scores a unit's exposure from 10 (UNSAFE) down, listing every protection it lacks.
- **Resource limits** (cgroups): `MemoryMax=300M` makes the kernel kill the service *inside its own cgroup* when it passes 300 MB, instead of the whole machine running out; `CPUQuota=50%` caps CPU.
- **`Restart=on-failure`** with `RestartSec=5` brings it back after a crash or OOM kill; `systemctl show shop -p NRestarts` counts the restarts (and an alert on that count tells you about the leak).

## commands | Harden and limit a service

```term
$ systemd-analyze security shop
$ sudo systemctl edit shop          # writes shop.service.d/override.conf and reloads
$ systemctl cat shop                # unit file + drop-ins
$ sudo systemctl restart shop && systemctl status shop
$ journalctl -u shop -n 20          # EROFS? EACCES? a path the sandbox forgot
$ systemctl show shop -p User,MemoryMax,MemoryCurrent,NRestarts
```

```ini
# /etc/systemd/system/shop.service.d/override.conf
[Service]
User=shop
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/shop
ProtectHome=yes
PrivateTmp=yes
MemoryMax=300M
Restart=on-failure
RestartSec=5
```

## analogy | A hotel room, not the master key

A guest gets one room, a key that cannot open other doors, and a minibar with a limit. If something goes wrong in that room, it stays in that room. Running a service as root with no limits hands it the master key and an open tab.

## team | Hardening in a team

- **Every service gets its own user** and a hardened unit from the start: put the drop-in in your configuration management (Ansible, image builds), not in someone's shell history.
- **Raise the score step by step**: add a protection, restart, read the journal, repeat. `EROFS` or `EACCES` in the log names the path you forgot.
- **Limits come from measurements**: set MemoryMax above normal peak use, and alert on restarts and OOM kills, so a leak becomes a ticket rather than an outage.
- **Containers and Kubernetes do the same** with users, read-only root filesystems and memory limits; the ideas carry over.

## traps | Hardening traps

**Editing the packaged unit file** in /lib/systemd/system: the next package upgrade overwrites it. Use drop-ins.

**`ProtectSystem=strict` without `ReadWritePaths`**: the service cannot write its data and crashes with `EROFS`.

**Switching `User=` without fixing ownership**: `EACCES` on the data directory.

**A memory limit without `Restart=`**: the OOM kill stops the service for good.

**A limit below normal use**: the service is killed in a loop until systemd gives up (start limit hit).

## lab | Lock down the shop

The shop on `web1` runs as root, with no sandbox and no limits, and it leaks memory. Measure its exposure, run it as its own user, sandbox it so it can only write its data directory, and contain the leak with a memory limit and automatic restarts.
