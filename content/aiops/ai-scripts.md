## story | Seven days of logs, and then everything

An assistant wrote a tidy cleanup script: "delete shop logs older than seven days". It looked right and was reviewed in ten seconds. It set `LOG_DIR` at the top and used `$LOGDIR` further down. On the first night, `cd $LOGDIR` failed quietly (an empty variable means `cd` to the home directory), and `rm -rf $LOGDIR/*` became `rm -rf /*`. The cron job ran as root.

AI-written code fails in the same ways as human code, just faster and with more confidence: typos in variable names, unquoted expansions, missing error handling, options that do not exist. The fixes are the same too: **linters, dry runs and tests**.

## model | How to review generated automation

- **Read it line by line.** Ask "what if this variable is empty?" and "what if this command fails?" for every line that deletes, moves or overwrites.
- **Lint it**: `shellcheck` catches the classics:
  - SC2115: `rm -rf "$DIR"/*` with a possibly empty `DIR`.
  - SC2154 and SC2034: a variable used but never set, or set but never used (a typo).
  - SC2086: unquoted `$var` (word splitting and globbing).
  - SC2164: `cd` without `|| exit`.
- **Make it fail safely**: `set -euo pipefail` (unset variables become errors), `"${DIR:?}"` (abort if empty), `cd "$DIR" || exit 1`.
- **Prefer narrow tools**: `find "$DIR" -name '*.log' -mtime +7 -delete` deletes only what matches, instead of `rm -rf` plus a glob.
- **Dry-run first**: print what would be deleted (`-print` instead of `-delete`), or run it against a copy.
- **Test the edge cases**: empty directory, missing directory, file names with spaces.

## commands | Lint, dry-run, then run

```term
$ shellcheck cleanup.sh
$ bash -n cleanup.sh
$ DRY_RUN=1 ./cleanup.sh
$ find /var/log/shop -name '*.log' -mtime +7 -print
$ sudo ./cleanup.sh
```

## analogy | A new colleague's first script

A capable new colleague wrote the script. You would still review it, run it on staging, and not hand it root on day one. The assistant is that colleague every single day.

## team | Generated code in the team

- **Same review bar** for AI-written and human-written code; mark AI-written changes in the PR so reviewers look harder at the edges.
- **Lint in CI** (`shellcheck`, `hadolint`, `tflint`, `yamllint`), so the checks run even when review is rushed.
- **Ask the assistant for tests and a dry-run mode**, not just the script.
- **Keep destructive automation boring**: small, single-purpose scripts with explicit paths.

## traps | Script traps

**"It ran fine on my machine"** where the variable happened to be set.

**`rm -rf $VAR/*`** without `${VAR:?}`.

**Silencing shellcheck** with a disable comment instead of fixing the line.

**Testing on production** because "it's only deleting old logs".

## lab | The cleanup script

The assistant writes a log-cleanup script for `web1`. Lint it, find the bug that would have wiped the server, fix it so it fails safely, dry-run it, and run it for real so only the old logs disappear.
