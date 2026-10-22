## story | The shared password

When Lumen had five servers, everyone logged in as `root` with the same password, kept in a spreadsheet. Then a contractor left on bad terms. Changing the password meant updating five servers and telling twelve people. Two weeks later they found a cron job, added under root, that no one could attribute to anyone.

The team switched to **SSH keys**: each person has their own key pair, each server lists exactly which public keys may log in as which user, password login is disabled, and root login is off. When someone leaves, you remove one line. Every login is logged with the key that was used.

## model | How SSH keys work

**SSH** gives you an encrypted shell on a remote machine. With key authentication:

```diagram
ssh-keys
```

- `ssh-keygen` creates a **key pair**: a **private key** (`~/.ssh/id_ed25519`) that never leaves your machine, and a **public key** (`id_ed25519.pub`) you can share freely.
- The server lists allowed public keys in `~/.ssh/authorized_keys` of the account you log into.
- At login, the server sends a challenge only your private key can sign. No secret crosses the network.

SSH is strict about permissions, because a key anyone can read is not private:

| Path | Mode |
|---|---|
| `~/.ssh/` | `700` |
| `~/.ssh/id_ed25519` (private key) | `600` |
| `~/.ssh/authorized_keys` | `600` |

The first time you connect, SSH records the server's **host key** in `~/.ssh/known_hosts`. If it ever changes unexpectedly, SSH refuses loudly: it could be a reinstalled server, or someone in the middle.

`~/.ssh/config` saves typing: aliases, users, key files and ports per host.

## commands | Everyday SSH

```term
$ ssh-keygen -t ed25519 -C "dev@lumen"        # make a key pair (add a passphrase!)
$ ssh-copy-id ubuntu@web1                     # install your public key (needs password login once)
$ ssh ubuntu@web1                             # log in
$ ssh ubuntu@web1 "uptime && df -h /"         # run one command and come back
$ ssh -i ~/.ssh/deploy_key deploy@web1        # use a specific key
$ ssh -v ubuntu@web1                          # verbose: see why authentication fails
$ scp notes.md ubuntu@web1:/tmp/              # copy a file over SSH
$ rsync -avz site/ ubuntu@web1:/srv/site/     # sync a folder efficiently
$ exit                                        # leave the remote shell
```

An entry in `~/.ssh/config`:

```term
Host prod-web
    HostName web1
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
```

then simply `ssh prod-web`.

## analogy | A wax seal

Your private key is your personal wax-seal stamp; the public key is a picture of the seal that you hand out. The server keeps the pictures of seals it accepts. To get in, you stamp a fresh piece of wax in front of the guard, who compares it with the picture. Nobody ever needs your stamp, and a lost picture is harmless. A lost stamp is not: that is why the private key is `600` and protected by a passphrase.

## team | SSH at scale

- **One key per person** (and per laptop), never shared keys. Remove a person's key when they leave.
- **No password logins, no root logins** on servers (`PasswordAuthentication no`, `PermitRootLogin no`).
- **Bastion hosts** (jump boxes) or session managers for production access, with logging.
- Bigger teams move to **SSH certificates** or identity-aware access, where short-lived credentials expire on their own.

## traps | SSH traps

**`UNPROTECTED PRIVATE KEY FILE`.** Your key is readable by others: `chmod 600` it.

**Wrong user.** `ssh web1` uses your local username; the server may expect `ubuntu`, `ec2-user` or `admin`.

**Ignoring `REMOTE HOST IDENTIFICATION HAS CHANGED`.** Find out why before you `ssh-keygen -R` it away.

**Copying the private key to a server** so you can "hop" further. Use `ssh -J` (jump) or agent forwarding carefully instead.

## lab | Keys, not passwords

A new server, **web1**, still allows a password login for the initial setup. Create your key, install it, connect, make yourself an alias, copy a file, and fix a teammate's key that SSH refuses to use.
