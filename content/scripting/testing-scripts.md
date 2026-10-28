## story | The script that deleted the wrong backups

Lumen's `rotate-backups.sh` kept the newest seven backups and deleted the rest. It worked for a year. Then someone pointed it at a directory with a space in its name, and the unquoted variable made it run `rm` in two directories, one of them the wrong one. Another day a refactor kept six backups instead of seven, and nobody noticed until a restore needed the seventh.

Shell scripts run production. They deserve the same safety net as application code: a **linter** that catches dangerous patterns, **tests** that pin down behaviour, and **CI** that runs both on every change.

## model | Lint, test, automate

- **ShellCheck** reads a script and flags real bugs: unquoted variables that split on spaces (SC2086), `cd` without `|| exit` (SC2164), `$?` checks that can be simplified, unused variables, and more. Each warning has a code and a wiki page.
- **bats** (Bash Automated Testing System) runs test files:
  ```bash
  setup() {
    dir=$(mktemp -d)
    for d in 01 02 03 04 05; do touch "$dir/backup-2026-01-$d.tar.gz"; done
  }

  @test "keeps the newest 3 backups" {
    run ./rotate-backups.sh "$dir" 3
    [ "$status" -eq 0 ]
    [ "$(ls "$dir" | wc -l)" -eq 3 ]
  }
  ```
  `run` executes a command and stores its exit code in `$status` and its output in `$output`. Any failing line fails the test. `setup` runs before each test.
- **Test behaviour, not lines**: given these files and arguments, what remains, what is printed, what exit code?
- **Edge cases** are where scripts break: spaces in paths, empty directories, files that do not match the pattern, bad arguments.
- **CI** runs `shellcheck` and `bats` on every pull request, so a regression is a red check, not a 3 AM restore.

## commands | Lint and test scripts

```term
$ shellcheck rotate-backups.sh
$ shellcheck -S warning *.sh            # only warnings and errors
$ bats test/                             # every .bats file
$ bats test/rotate.bats
```

## analogy | A smoke detector and a fire drill

ShellCheck is the smoke detector: it beeps at known dangers before anything burns. Tests are the fire drill: you check that the procedure really works, including the awkward cases, before the day you need it.

## team | Script quality in a team

- **Scripts live in a repository** with tests next to them, not in someone's home directory.
- **ShellCheck clean is the bar** for merging; disable a check only with a comment explaining why.
- **Every bug gets a test** that reproduces it before it is fixed.
- **Scripts longer than a page** may be better as Python or Go, with a real test framework.

## traps | Testing traps

**Testing in your real backup directory.** Tests create their own temporary files (`mktemp -d`) and never touch real data.

**Tests that pass for the wrong reason**: check the exit code *and* the effect.

**Ignoring SC2086** ("double quote to prevent globbing and word splitting"): it is the most common real bug in shell scripts.

## lab | Make the backup script trustworthy

The `lumen/ops-scripts` repository (cloned in `~/ops-scripts`) holds `rotate-backups.sh` and a first bats test file. Lint it, make the tests pass, add the test that would have caught the incident, and make CI enforce all of it.
