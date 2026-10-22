## story | Half a deploy

Lumen used to deploy by running `git pull` inside the live app folder on the server, then restarting. One evening the pull stopped halfway when the network blipped: some files were new, some old, and the app crashed on start. Rolling back meant figuring out which files had changed, under pressure, with customers waiting.

The team switched to **release folders**: each version is unpacked into its own directory, configuration lives in a separate shared place, and a single symlink, `current`, decides which version runs. Deploying is "unpack next to the old one, switch the link, restart". Rolling back is "switch the link back". The half-deploy problem disappeared, because the live code is never edited in place.

## model | Releases, shared config, one switch

```diagram
releases-symlink
```

```term
/opt/notes/
├── releases/
│   ├── 2.0.0/        ← previous version, untouched
│   └── 2.1.0/        ← new version, unpacked complete
├── shared/
│   └── notes.env     ← secrets and settings, outside any release
└── current -> releases/2.1.0
```

- The systemd unit runs `/opt/notes/current/server.js` with `WorkingDirectory=/opt/notes/current` and `EnvironmentFile=/opt/notes/shared/notes.env`.
- `ln -sfn releases/2.1.0 current` repoints the link in one atomic step (`-n` treats an existing link as a file, so it is replaced rather than followed).
- A **health check** after the restart decides whether the deploy worked; if not, you roll back the same way.
- Keep a few old releases for rollback; delete older ones so the disk does not fill.

This is exactly what tools like Capistrano, Ansible roles and many CI pipelines do for you, and the same idea (immutable versions, one pointer) reappears with container images and Kubernetes rollouts.

## commands | A manual release

```term
$ scp notes-2.1.0.tar.gz ubuntu@web1:/tmp/
$ ssh ubuntu@web1
$ sudo -u notes mkdir -p /opt/notes/releases/2.1.0
$ sudo -u notes tar -xzf /tmp/notes-2.1.0.tar.gz -C /opt/notes/releases/2.1.0
$ cd /opt/notes && sudo -u notes ln -sfn releases/2.1.0 current
$ sudo systemctl restart notes
$ curl -s localhost:4000/health          # which version is running?
$ journalctl -u notes -n 20              # if it did not come up
$ sudo -u notes ln -sfn releases/2.0.0 current && sudo systemctl restart notes   # rollback
```

## analogy | A train switch

Two complete tracks lie side by side: the old route and the new one, both fully built. A single lever (the symlink) decides which track the train (your service) takes. You never rebuild a track while the train is on it, and if the new track has a problem, you pull the lever back.

## team | Deploys people can trust

- **Build once, deploy the same artifact everywhere** (a tarball, later a container image).
- **Config outside the release** (`shared/`), secrets with mode 600.
- **Automate the steps** into one script or pipeline job, with the health check and rollback built in.
- **Know what is running**: `/health` returning the version makes every conversation shorter.

## traps | Deploy traps

**`ln -sf` without `-n`.** If `current` is a link to a directory, `-sf` creates the new link *inside* the old release instead of replacing `current`.

**Secrets inside the release folder.** They get overwritten by the next release, or copied into every tarball.

**No health check.** "The restart command succeeded" only means systemd started the process, not that the app works.

**Deleting the previous release right after switching.** Keep it until the new one has proven itself.

## lab | Ship 2.1.0, survive 2.2.0

web1 runs notes **2.0.0** from a release folder. Deploy **2.1.0** properly, then try **2.2.0** (the team says it is "ready"), and roll back if it misbehaves. The release tarballs are in `~/releases/` on your laptop.
