## brief | The full disk at 3 AM

**03:07.** Your phone buzzes: `DISK CRITICAL: web2 / is 97% full`. A full disk is one of the most common outages there is: databases stop writing, apps cannot create temp files, logs stop, and deploys fail.

You are already logged in to **web2** as `ubuntu` (you have sudo). Free space safely, find out what filled it, and leave things better than you found them. Remember everything from this realm: measure first, understand before deleting, and keep the evidence.

## recap | What the Linux realm gave you

- The shell and the filesystem tree; absolute and relative paths; `pwd`, `ls`, `cd`, Tab and history.
- Files and editors: `mkdir -p`, `cp`, `mv`, `rm` (no undo), globs (preview first), `less`, `head`, `tail`, `nano`.
- Users, groups and permission bits; `chmod`, `chown`, `sudo`, least privilege.
- Streams and pipes: `grep`, `awk`, `sort`, `uniq -c`, `wc`, redirects, `tee`.
- Processes and signals: `ps`, `top`, `kill` (TERM before KILL), exit codes, background jobs.
- Packages and the environment: `apt`, `PATH`, `export`, `.bashrc`.

## lab | web2 is almost full

Bring the disk under 80%. Things you may meet: huge logs, old backups, and a deleted file that still takes up space. Hint for that one: a running process may still hold a file open, so its space is not freed until the process lets go.
