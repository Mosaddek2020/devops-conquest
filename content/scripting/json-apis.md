## story | The spreadsheet of incidents

Every Monday, someone on the Lumen platform team opened the incident tracker, filtered by severity, paged through the results and copied numbers into a spreadsheet. It took an hour. The tracker had an API, and the whole report was one `curl` piped into `jq`; nobody had written it because "APIs are for developers".

Most DevOps tools speak **HTTP and JSON**: GitHub, cloud providers, Kubernetes, monitoring, chat. `curl` makes the requests and `jq` reads the answers, which is enough to automate a surprising amount of work.

## model | Requests, tokens, JSON and pages

- **Authentication**: most APIs want a token in a header: `-H "Authorization: Bearer $TOKEN"`. Keep the token in a file readable only by you (`chmod 600`) or in an environment variable, never in the script.
- **Status codes** tell you what happened: `2xx` success (`201 Created`), `401` missing or bad token, `403` not allowed, `404` not found, `422` invalid input, `429` too many requests, `5xx` the server's fault (often worth a retry).
- **`curl -f`** makes HTTP errors fail the command (exit 22), so `set -e` scripts stop; `-s` hides progress, `-S` still shows errors; `-w '%{http_code}'` prints the status.
- **Sending JSON**: `-X POST -H 'Content-Type: application/json' -d @incident.json`.
- **`jq`**: `.data[]` iterates, `select(.state == "open")` filters, `[.id, .title] | @tsv` makes tab-separated rows, `-r` prints raw strings, `--arg name value` passes shell values in safely, `length` counts.
- **Pagination**: APIs return a page at a time with a `next` link (or a page number). Loop until there is no next page.
- **Retries**: `curl --retry 3` retries on timeouts and 5xx; scripts should give up loudly after that.

## commands | curl and jq together

```term
$ TOKEN=$(cat ~/.config/lumen/token)
$ curl -s -H "Authorization: Bearer $TOKEN" https://api.lumen.dev/v1/incidents | jq .
$ curl -s -H "Authorization: Bearer $TOKEN" https://api.lumen.dev/v1/incidents \
    | jq -r '.data[] | select(.state == "open") | [.id, .severity, .title] | @tsv'
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d @incident.json https://api.lumen.dev/v1/incidents
$ curl -fsS --retry 3 https://api.lumen.dev/v1/health
```

Following `next` links in a script:

```bash
url="/v1/incidents"
while [ -n "$url" ] && [ "$url" != "null" ]; do
  page=$(curl -fsS -H "Authorization: Bearer $TOKEN" "https://api.lumen.dev$url")
  echo "$page" | jq -c '.data[]'
  url=$(echo "$page" | jq -r '.next')
done
```

## analogy | Ordering by phone

The token is your account number, the URL is the department, the status code is the clerk's first word ("done", "who are you?", "we don't sell that", "try again later"). Pagination is the clerk reading the list ten items at a time: keep asking "and next?" until they say "that's all".

## team | APIs in a team

- **Service accounts and scoped tokens** for scripts, not your personal token, and rotate them.
- **Fail loudly**: `set -euo pipefail` plus `curl -f`, so a 401 does not silently produce an empty report.
- **Respect rate limits** and back off on `429`.
- **Check in the script, keep secrets out**: the token comes from the environment or a secrets manager at run time.

## traps | API traps

**Forgetting pagination**: the first page looks like the full answer.

**`curl` without `-f`**: an error page is printed and the script carries on with HTML in its JSON.

**Building JSON with string concatenation**: one quote in a title breaks it. Write a file, or use `jq -n --arg`.

**Tokens on the command line** end up in shell history and `ps`; read them from a file or variable.

## lab | The Monday report, automated

Lumen's incident tracker has an API at `https://api.lumen.dev`. Your token is in `~/.config/lumen/token`. Read incidents, count across every page, open a new incident, and deal with a flaky endpoint, all from the shell.
