## story | Twelve tabs every morning

Every morning, Priya opened twelve browser tabs to check that Lumen's sites and APIs were up: the shop, the API, the status page, the admin tools. It took ten minutes and she still missed things on days she was busy.

Her script took an afternoon: read a list of URLs from a file, `curl` each one, print `OK` or `FAIL` with the status code, and exit non-zero if anything failed. It ran from cron every five minutes and posted failures to the team channel. Loops and conditions turn a checklist into a tool.

## model | Decisions and repetition

**Conditions** use exit codes: `if command; then …; fi` runs the block when the command succeeds. The test commands:

| Test | True when |
|---|---|
| `[[ -f path ]]` / `[[ -d path ]]` | file / directory exists |
| `[[ -z "$s" ]]` / `[[ -n "$s" ]]` | string empty / not empty |
| `[[ "$a" == "$b" ]]`, `[[ "$a" != "$b" ]]` | strings equal / differ (`==` also matches globs: `== *.log`) |
| `[[ "$s" =~ ^v[0-9]+ ]]` | regex match |
| `(( n > 80 ))` | arithmetic comparison |
| `[[ … ]] && [[ … ]]`, `\|\|`, `!` | combine, negate |

**Loops**:

```term
for host in web1 web2 web3; do          # over words
  ssh "$host" uptime
done

for f in /var/log/app/*.log; do         # over files
  gzip "$f"
done

while read -r url; do                   # over lines of a file
  curl -s -o /dev/null -w "%{http_code} $url\n" "$url"
done < urls.txt

for ((i = 1; i <= 3; i++)); do          # counting
  echo "attempt $i"
done
```

**case** picks between many patterns:

```term
case "$1" in
  start)   systemctl start app ;;
  stop)    systemctl stop app ;;
  *)       echo "usage: $0 start|stop"; exit 2 ;;
esac
```

**Functions** name a piece of logic: `check() { …; return 1; }`, called like a command (`check "$url"`), with `local` variables.

## commands | Patterns you will reuse

```term
failed=0
while read -r url; do
  [[ -z "$url" || "$url" == \#* ]] && continue     # skip blanks and comments
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url" || true)
  if [[ "$code" == 200 ]]; then
    echo "OK   $code $url"
  else
    echo "FAIL $code $url"
    failed=$((failed + 1))
  fi
done < "${1:-urls.txt}"
(( failed == 0 ))                                  # exit code: 0 only if all passed
```

## analogy | A doorman with a list

A loop is a doorman going down the guest list one name at a time. A condition is the question he asks each guest ("on the list? ID matches?"). `continue` is "skip this one, next please"; `break` is "we're full, close the door". The exit code is the report to the manager at the end of the night.

## team | Loops in production

- **Make loops safe to interrupt and re-run** (see the next lesson).
- **Collect failures, report at the end, and exit non-zero** instead of stopping at the first error, when checking many things.
- **Timeouts on every network call** inside a loop (`curl -m 5`), or one dead host stalls the whole run.
- **`read -r`** always, so backslashes in input survive.

## traps | Loop traps

**`for line in $(cat file)`** splits on spaces, not lines. Use `while read -r line; do …; done < file`.

**Forgetting `|| true`** with `set -e`: a failing command inside the loop kills the whole script, even when you meant to record the failure.

**Unquoted `"$@"`.** Without quotes, arguments with spaces split apart.

**`[ $x == y ]` with an empty `$x`** becomes `[ == y ]`: a syntax error. Use `[[ "$x" == y ]]`.

## lab | site-check.sh

Write the script that replaces Priya's twelve tabs. It will be graded by running it against healthy and broken sites.
