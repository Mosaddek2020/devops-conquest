## story | The backup that was never there

Lumen ran nightly database backups for two years. The cron job wrote `/var/backups/shop.sql` on the database server itself. When a migration dropped the orders table, the team reached for the backup and found it was zero bytes: the job had been failing since a password change eight months earlier. And even if it had worked, it lived on the same disk as the database.

Backups are only real when they are **automatic, off the machine, monitored, and restore-tested**.

## model | 3-2-1, RPO and RTO

```diagram
backup-321
```

- **3-2-1**: three copies, two media, one off-site (another region or account, ideally immutable so an attacker or a bad script can't delete it).
- **RPO** (recovery point objective): how much data you may lose: the time between backups.
- **RTO** (recovery time objective): how long a restore may take.
- **Logical backups** (`pg_dump`) are portable and selective; **physical/snapshot** backups (disk snapshots, WAL archiving) restore faster and allow point-in-time recovery.
- **Restore drills**: regularly restore into a scratch environment and check the data. Alert when the newest backup is too old or too small.

## commands | Backing up and restoring PostgreSQL

```term
$ sudo -u postgres pg_dump shop -f /var/backups/shop-$(date +%F).sql
$ aws s3 cp /var/backups/shop-$(date +%F).sql s3://lumen-backups/db1/
$ aws s3 ls s3://lumen-backups/db1/
$ crontab -e                       # 0 2 * * * /usr/local/bin/backup-shop.sh
$ aws s3 cp s3://lumen-backups/db1/shop-2026-03-07.sql /tmp/restore.sql
$ sudo -u postgres psql -f /tmp/restore.sql
$ sudo -u postgres psql -c "SELECT count(*) FROM orders"
```

## analogy | A spare house key

A spare key hidden under your own doormat doesn't help when the house burns down, and a key you've never tried in the lock might not fit. Keep the spare at a friend's place (off-site) and try it once in a while (restore drills).

## team | Backup habits

- **Backups are a product with an owner**, monitored like any service.
- **Encrypt** backups and control who can read them (they contain everything).
- **Practise restores** on a schedule and record the real RTO.
- **Separate credentials**: production can write backups but not delete them.

## traps | Backup traps

**Backups on the same server or disk** as the data.

**Never testing a restore.**

**Silent failures**: a cron job that fails for months unnoticed.

**Retention too short** to recover from a problem noticed late.

## lab | Back up, break, restore

Set up off-site backups for the shop database, then recover when a migration drops the orders table, and measure what was lost.
