## story | rm -rf "$STEAMROOT/"*

In 2015, a popular game launcher's update script contained the line `rm -rf "$STEAMROOT/"*`. On some machines `$STEAMROOT` came out empty, and the line became `rm -rf "/"*`: it deleted every file the user could write, including mounted backup drives.

That bug appears in scripts everywhere, now including scripts written by AI assistants, which happily produce `rm -rf $BUILD_DIR/*` without a second thought. The defences are simple and boring: refuse to run with empty variables, check inputs, make every step safe to repeat, and show what you would do before you do it.

## model | Idempotent, guarded, observable

A robust automation script is:

1. **Guarded**: it checks its inputs and environment before touching anything.
   - `set -u` turns unset variables into errors; `${DIR:?DIR must be set}` gives a clear message.
   - Refuse dangerous values explicitly: `[[ "$DIR" == / ]] && exit 1`.
2. **Idempotent**: running it twice leaves the system in the same state as running it once.
   - `mkdir -p` instead of `mkdir`; `useradd` only `if ! id user`; append a config line only `if ! grep -q …`.
   - This lets you re-run after a failure without fear, which is the foundation of every automation tool you will meet (Ansible, Terraform, Kubernetes).
3. **Observable**: it says what it does (`log() { echo "[$(date +%T)] $*"; }`), and supports a **dry run** (`--dry-run` prints actions instead of doing them).
4. **Clean on exit**: `trap cleanup EXIT` removes temp files whether the script succeeds, fails or is interrupted.

## commands | Building blocks

```term
#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

run() {                       # print, and only execute when not a dry run
  echo "+ $*"
  if [[ "$DRY_RUN" == false ]]; then "$@"; fi
}

TARGET="${TARGET:?TARGET must be set}"
[[ "$TARGET" == "/" ]] && { echo "refusing to touch /" >&2; exit 1; }

id deploy >/dev/null 2>&1 || run sudo useradd -m deploy          # only if missing
grep -q '^max_conn=' app.conf || run sh -c 'echo max_conn=100 >> app.conf'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT    # always clean up
```

## analogy | A pilot's checklist

Pilots run the same checklist every flight, even after ten thousand flights. Before take-off they verify inputs (fuel, weather, flaps): guards. Each item is "set to X", not "move up a notch", so doing it twice is harmless: idempotent. They call out each action aloud: observable. A robust script is a checklist the computer runs for you.

## team | Reviewing automation, including AI-written automation

- **Review generated scripts line by line**, especially every `rm`, `chmod`, `>` and loop over files. Ask "what if this variable is empty?"
- **Run new automation with `--dry-run` first**, then on staging, then in production.
- **Lint with shellcheck** in CI; it flags `rm -rf "$VAR/"*` and unquoted variables.
- **Prefer purpose-built tools** (Ansible, Terraform) once scripts grow beyond a page: they give you idempotency and dry runs for free.

## traps | Robustness traps

**`rm -rf "$DIR/"*` without a guard.** Use `"${DIR:?}"` and reject `/`.

**`set -e` surprises.** It does not stop on failures inside `if` conditions or before `&&`/`||`; it also stops on harmless non-zero exits like `grep` finding nothing. Add `|| true` where a non-zero result is expected.

**Non-idempotent appends.** `echo line >> file` on every run adds the line again and again.

**Trusting the AI's confidence.** "This script safely cleans your build directory" is a claim, not a test.

## lab | Review the AI's cleanup script

Your teammate asked the AI assistant for a script that cleans the build directory and sets up the build user. It "works on their machine". Review it, make it safe and idempotent, and add a dry-run mode. It will be graded by running it, including with a missing variable.
