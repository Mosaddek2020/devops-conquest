## story | chmod 777, the universal "fix"

Lumen's image upload broke after a deploy: `EACCES: permission denied, open '/srv/uploads/…'`. A tired engineer ran `sudo chmod -R 777 /srv` and uploads worked again. Ticket closed.

Three months later, a vulnerability in an image library let an attacker write a file through the upload form. Normally that would have failed: the web app should only have been able to write into `/srv/uploads`. Because everything under `/srv` was writable by everyone, the attacker overwrote the app's own code. A one-line "fix" became a full compromise.

Permissions are not an obstacle to work around. They are the walls between the parts of your system, and they decide how far an attacker or a bug can spread.

## model | Users, groups and permission bits

Every process runs as a **user**, and every file has an **owner** and a **group**. Users can belong to several groups. `root` (uid 0) is the administrator and bypasses permission checks.

Each file carries three sets of three permissions:

```diagram
permissions
```

| Bit | On a file | On a directory |
|---|---|---|
| `r` read (4) | read its content | list the names inside |
| `w` write (2) | change its content | create, rename, delete files inside |
| `x` execute (1) | run it as a program | enter it (`cd`) and reach anything inside |

Linux checks **owner** first, then **group**, then **others**: the first category that applies to you decides.

Numbers add up per category: `7` = rwx, `6` = rw-, `5` = r-x, `4` = r--, `0` = ---. So:

- `644` (rw-r--r--): normal files: owner edits, everyone reads.
- `600` (rw-------): secrets, private keys: only the owner.
- `755` (rwxr-xr-x): programs and directories everyone may use.
- `750` (rwxr-x---): owner full, group can read/enter, others nothing.

**sudo** runs a single command as root, if your user is allowed to (members of the `sudo` group on Ubuntu). It is safer than logging in as root: you only become root for one command, and it is logged.

## commands | Managing access

```term
$ whoami                                # who am I?
$ id                                    # my uid, groups
$ ls -l config.yml                      # read the permissions
$ chmod 600 secrets.env                 # numbers…
$ chmod u+x deploy.sh                   # …or symbols: u/g/o/a, +/-/=, r/w/x
$ sudo useradd -m -s /bin/bash deploy   # new user with a home folder
$ sudo groupadd webteam                 # new group
$ sudo usermod -aG webteam deploy       # add deploy to webteam (-a: append!)
$ sudo chown deploy:webteam /srv/site   # change owner and group
$ sudo chown -R deploy:webteam /srv/site  # recursively
$ sudo -u deploy cat /srv/site/index.html # test access as another user
```

## analogy | An office building with badges

Every employee has a badge (user) and belongs to departments (groups). Each room has a sign: what the owner may do, what the department may do, what visitors may do. The facilities manager (root) has a master key. `sudo` is borrowing the master key for one door, while security writes down who borrowed it. `chmod 777` is propping every door open with a chair.

## team | Least privilege in practice

- **Every service gets its own user** (`www-data`, `postgres`, `lumen-api`), owning only what it needs.
- **Secrets are `600`** and owned by the service user that reads them.
- **Humans use their own accounts** with sudo, never a shared root password. Logs then show who did what.
- **Group-based access** (`webteam` can deploy to `/srv/site`) scales better than adding individuals to files.

## traps | Permission traps

**`chmod 777` as a fix.** It works by removing all protection. Find out *which* user needs *which* access, and grant exactly that.

**`usermod -G` without `-a`.** It *replaces* all of the user's groups. You can remove someone (or yourself) from `sudo` by accident.

**Forgetting directories need `x`.** A file can be `644`, but if a parent directory is `700` and owned by someone else, nobody else can reach it.

**Group changes need a new login.** After `usermod -aG docker you`, your current shell still has the old groups. Log out and back in.

**`sudo` with redirects.** `sudo echo x > /etc/file` fails: the redirect is done by *your* shell, not by sudo. Use `echo x | sudo tee /etc/file`.

## lab | Set up a team folder

The web team needs a shared folder for the site, a deploy user, and a secrets file that only that user can read. Set it up with the least privilege that works, and prove it.
