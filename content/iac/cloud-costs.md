## story | The bill nobody owned

Lumen's AWS bill grew 40% in six months while traffic stayed flat. Finance asked engineering why; engineering assumed finance would tell them if it mattered. When someone finally looked, they found 1.5 TB of disks attached to nothing, IP addresses reserved for servers deleted a year earlier, three years of daily snapshots, a "temporary" batch server from 2023, and web servers running at 6% CPU on instance types four times larger than needed.

**FinOps** is the practice of making cloud cost a shared engineering concern: everyone can **see** what they spend, **owns** their part of it, and **optimises** it continuously, as part of normal work rather than an annual panic.

## model | See, own, optimise

- **Visibility**: Cost Explorer (`aws ce get-cost-and-usage`) breaks spend down by **service** and by **tag**. Tags (`team`, `env`, `service`) are how cost gets an owner; untagged spend has none.
- **The usual waste**:
  - **unattached volumes** (status `available`): still billed per GB-month;
  - **idle Elastic/public IPs**: billed by the hour whether used or not;
  - **old snapshots** with no retention policy;
  - **forgotten instances** (low CPU, no owner);
  - **oversized instances**: average and peak CPU far below the type's capacity.
- **Right-sizing** uses data: CloudWatch CPU (and memory, if collected) over two weeks or more. Peak matters as much as average.
- **Price changes before you apply them**: `infracost` reads Terraform and shows the monthly cost and the **diff** of a change, so cost becomes part of code review.
- **Guard rails**: **budgets** with alerts (actual and forecast), tagging policies, and lifecycle rules (snapshots older than N days are deleted).
- Commitment discounts (Savings Plans, Reserved Instances) come *after* right-sizing: do not commit to paying for waste.

## commands | Find it, price it, cut it

```term
$ aws ce get-cost-and-usage --time-period Start=2025-12-01,End=2026-01-01 --granularity MONTHLY \
    --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
$ aws ce get-cost-and-usage ... --group-by Type=TAG,Key=team       # who owns the spend?
$ aws ec2 describe-volumes --filters Name=status,Values=available --query 'Volumes[].[VolumeId,Size]' --output text
$ aws ec2 describe-addresses                                         # no InstanceId = idle
$ aws ec2 describe-snapshots --owner-ids self | jq -r '.Snapshots[] | select(.StartTime < "2025-01-01") | .SnapshotId'
$ aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization \
    --dimensions Name=InstanceId,Value=i-0abc… --statistics Average Maximum \
    --start-time 2025-12-18T00:00:00Z --end-time 2026-01-01T00:00:00Z --period 86400
$ infracost breakdown --path . --format json --out-file infracost-base.json
$ infracost diff --path . --compare-to infracost-base.json           # after editing the .tf
$ aws budgets create-budget --account-id 123456789012 --budget file://budget.json \
    --notifications-with-subscribers file://alerts.json
```

## analogy | Lights left on

Nobody decides to waste electricity; lights stay on in empty rooms because nobody owns turning them off. Tags put a name on each room's meter, Cost Explorer is the bill per room, and a budget alert is the smart meter that texts you when a room uses more than it should.

## team | Cost in a team

- **Tag everything at creation**, in Terraform (`default_tags` in the provider), and reject untagged resources with policy.
- **Show each team its own costs** every week, next to its other metrics.
- **Price changes in pull requests** with infracost, so "this adds $400/month" is part of the review.
- **Delete with care**: snapshot before deleting a volume nobody can explain; stop before terminating an instance nobody owns (a "scream test"), with a date in a tag.
- **Lifecycle by default**: snapshot retention, log retention, S3 lifecycle rules.

## traps | Cost traps

**Stopped is not free.** A stopped instance still pays for its disks and public IP.

**Deleting the volume, keeping the snapshot policy**: snapshots keep piling up.

**Right-sizing on averages only.** A server at 5% average and 95% peak needs headroom.

**Buying reservations first**, then right-sizing: you pay for the big instances anyway.

**Cost reports nobody owns.** Without a team tag, waste is everybody's and nobody's.

## lab | Halve the bill

Lumen's account (credentials in `~/.aws`) costs far more than the traffic justifies. The web servers are managed by Terraform in `~/infra`; everything else was clicked together over the years. Find where the money goes, remove the waste safely, right-size with data, and put a budget in place.
