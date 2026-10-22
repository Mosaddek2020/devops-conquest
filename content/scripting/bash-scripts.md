## story | The runbook that was really a script

Lumen's on-call runbook for "disk almost full" had nine steps: check `df`, find the big folders, check the log sizes, compare with a threshold, and so on. Every on-call engineer ran them by hand, slightly differently, at 3 a.m.

Jonas turned the first five steps into a 20-line script, `check-disk.sh`. It printed the numbers in the same order every time, exited with code 1 when a disk was over the threshold, and so could be called from monitoring, from cron, or by a tired human. The runbook shrank to "run `check-disk.sh`, then decide". The best scripts start as exactly this: something you typed twice.

## model | What a script is

A **bash script** is a text file of commands, run top to bottom by bash. The same commands you type, plus variables, decisions and loops.

```diagram
script-anatomy
```

The pieces you need first:

- **Shebang**: the first line, `#!/usr/bin/env bash`, tells the system which interpreter runs the file.
- **Executable bit**: `chmod +x script.sh` lets you run it as `./script.sh`.
- **Variables**: `name=value` (no spaces around `=`), used as `"$name"`. Always quote them.
- **Arguments**: `$1`, `$2`… are the arguments, `$#` how many, `"$@"` all of them, `$0` the script's name.
- **Defaults and required values**: `${1:-80}` uses 80 if `$1` is empty; `${1:?usage: …}` stops with a message if it is missing.
- **Command substitution**: `used=$(df --output=pcent / | tail -1)` captures a command's output.
- **Exit codes**: `exit 0` for success, non-zero for failure. Callers (cron, CI, monitoring, `&&`) decide based on it.
- **Strict mode**: `set -euo pipefail` makes the script stop at the first failing command (`-e`), on unset variables (`-u`), and when any part of a pipeline fails (`pipefail`). It turns silent mistakes into loud ones.

## commands | Writing and running scripts

```term
$ nano ~/bin/hello.sh
#!/usr/bin/env bash
set -euo pipefail
name="${1:-world}"
echo "Hello, $name! You are $(whoami) on $(hostname)."

$ chmod +x ~/bin/hello.sh
$ ~/bin/hello.sh            # Hello, world! …
$ ~/bin/hello.sh Amira      # Hello, Amira! …
$ bash -x ~/bin/hello.sh    # trace: print each command before running it
$ echo $?                   # exit code of the last command
```

Arithmetic and tests:

```term
pct=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
if (( pct > 80 )); then
  echo "disk at ${pct}%"
  exit 1
fi
```

## analogy | A recipe card

A script is a recipe card instead of cooking from memory. The shebang says which kitchen it is for. Arguments are the blanks ("serves ___"). `set -e` is the rule "if a step fails, stop: do not serve a half-cooked dish". The exit code is the note you leave for whoever comes next: "done" or "something went wrong".

## team | Scripts others can rely on

- **Start every script with `set -euo pipefail`** (and know its quirks).
- **Print a usage line** when arguments are missing.
- **Exit codes are an API**: 0 only when it really worked.
- **Keep scripts in git**, reviewed like code, with a comment on what they are for.
- **Run `shellcheck`** (a linter for shell scripts) in CI; it catches most quoting bugs.

## traps | Script traps

**Spaces around `=`.** `name = value` runs a command called `name`.

**Unquoted variables.** `rm $file` with `file="my report.pdf"` removes two files that don't exist, or worse.

**Forgetting the exit code.** A script that prints "ERROR" but exits 0 looks green to cron and CI.

**Windows line endings** in scripts edited elsewhere: `/bin/bash^M: bad interpreter`.

## lab | check-disk.sh

Write the disk check the on-call team has been doing by hand. Your script will be graded by running it, so its output and exit code both matter.
