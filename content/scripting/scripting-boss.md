## brief | One command to deploy

Lumen still deploys the notes service by copying and typing the release steps by hand (you did it in the Services realm). Your task: turn those steps into **`deploy.sh`**, run from your laptop:

```term
$ ./deploy.sh 2.1.0
```

It must copy the release to web1, unpack it into its own release folder, switch the `current` symlink, restart the service, check `/health` for the right version, and **roll back automatically** if the check fails, exiting non-zero so a pipeline would notice.

## recap | What the Scripting realm gave you

- Scripts: shebang, `chmod +x`, variables, arguments, `$(…)`, exit codes, `set -euo pipefail`.
- Decisions and loops: `[[ … ]]`, `(( … ))`, `if`, `case`, `for`, `while read -r`, functions.
- Robustness: guards (`${VAR:?}`), idempotency, dry runs, `trap`, and reviewing AI-written scripts like any other code.

## lab | deploy.sh

The release tarballs are in `~/releases/`. Your key works for `ubuntu@web1`, which can use sudo. Your script will be run by the grader: once with a good release, once with a broken one.
