## story | The backup that never ran

Lumen had a nightly database backup "for years". When they finally needed it, after a bad migration, the newest backup was 11 months old. The cron job had been added under a user who was later deleted; the script it called had moved; and its errors went to a local mailbox nobody read.

Scheduled jobs are deceptively simple to create and easy to forget. Logs are the same: easy to write, easy to let grow until they fill a disk. Both need the same discipline: decide where output goes, keep it bounded, and check that the thing actually happens.

## model | Where logs live, how they stay small, how jobs run

**Logs** come from two places on a modern Linux server:

- the **systemd journal** (`journalctl`), for everything services print;
- **files in `/var/log/`**, written by programs that manage their own logs (nginx, many apps).

**logrotate** keeps log files bounded. Its config in `/etc/logrotate.d/` says, per set of files, how often to rotate, how many old copies to keep, whether to compress them, and how to handle programs that keep the file open:

```term
/var/log/notes/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` copies the log and empties the original in place, which works for apps that never reopen their log file. The alternative is to rotate and then signal the app to reopen (a `postrotate` script).

**cron** runs commands on a schedule. Each crontab line has five time fields, then the command:

```term
# ┌ minute (0-59)
# │ ┌ hour (0-23)
# │ │ ┌ day of month (1-31)
# │ │ │ ┌ month (1-12)
# │ │ │ │ ┌ day of week (0-6, Sunday = 0)
# │ │ │ │ │
  30 2 * * *   /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1
  */5 * * * *  /usr/local/bin/healthcheck.sh
```

Cron runs with a minimal environment (a short PATH, no `.bashrc`), so scripts must use absolute paths and redirect their output somewhere you will look. (Systemd **timers** are the modern alternative, with logs in the journal.)

## commands | Logs and schedules

```term
$ journalctl -u notes -p err --since today      # only errors today
$ journalctl --disk-usage                       # how big is the journal?
$ ls -lh /var/log/notes/                        # file-based logs
$ sudo logrotate -d /etc/logrotate.d/notes      # dry run: what would happen?
$ sudo logrotate -f /etc/logrotate.d/notes      # force a rotation now
$ crontab -e                                    # edit your schedule
$ crontab -l                                    # list it
$ sudo crontab -u notes -l                      # another user's
$ grep CRON /var/log/syslog                     # did it run? (or journalctl -u cron)
```

## analogy | Newspapers and an alarm clock

Logs are a daily newspaper delivered to your door. Without rotation, the pile grows until you can't open the door; with rotation, you keep the last two weeks, bundle older ones, and recycle the rest. Cron is an alarm clock: reliable, but it rings in an empty room unless you decide where the alarm goes and check that someone heard it.

## team | Making scheduled work observable

- **Every job writes somewhere visible**: a log file you rotate, the journal, or a monitoring check.
- **Alert on missing runs**, not just failures: a "dead man's switch" check that complains when a backup has not reported in 26 hours.
- **Test restores**, not just backups. A backup you have never restored is a hope.
- **Rotation for every file-based log**, with the size budget written down.

## traps | Log and cron traps

**Relative paths and PATH in cron.** `backup.sh` works in your shell and fails from cron.

**Output to nowhere.** Without a redirect, cron mails output to a local mailbox nobody reads.

**`% ` in crontab lines** means newline to cron; escape it (`\%`) in date formats.

**Rotating without telling the app.** The app keeps writing to the renamed file; use `copytruncate` or a reopen signal.

## lab | Bounded logs, reliable backups

On web1, the notes app's log file is growing without limit and there is a backup script nobody schedules. Set up rotation, schedule the backup, and prove it runs.
