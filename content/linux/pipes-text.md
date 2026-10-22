## story | Who is hammering the login page?

At 11:42 the login page slowed to a crawl. The access log had 1.2 million lines. Priya did not open it in an editor; she typed one line:

```term
$ grep 'POST /login' access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -5
```

Four seconds later she had the answer: one IP address had sent 380,000 login attempts in an hour. A credential-stuffing attack. She blocked it at the firewall, and the page recovered.

That one line is five small programs, each doing one simple job, connected by pipes. Learning to build lines like that is one of the highest-value skills in operations.

## model | Streams, pipes and redirects

Every command has three **streams**:

- **stdin** (0): input, from the keyboard or a pipe.
- **stdout** (1): normal output.
- **stderr** (2): errors and warnings.

```diagram
pipes
```

| Syntax | Meaning |
|---|---|
| `a \| b` | stdout of `a` becomes stdin of `b` |
| `> file` | write stdout to a file (replace it) |
| `>> file` | append stdout to a file |
| `2> file` | write stderr to a file |
| `> file 2>&1` | both stdout and stderr to the same file |
| `2>/dev/null` | throw errors away |
| `< file` | read stdin from a file |
| `\| tee file` | show output *and* save it |

The text toolbox:

| Tool | Does |
|---|---|
| `grep` | keep lines matching a pattern (`-i` ignore case, `-v` invert, `-c` count, `-E` extended regex) |
| `cut -d' ' -f1` | take fields by a delimiter |
| `awk '{print $1, $9}'` | take columns, compute, filter (`$9 >= 500`) |
| `sort` / `sort -n` / `sort -rn` | sort text / numbers / numbers descending |
| `uniq -c` | collapse *adjacent* duplicates and count them (so sort first) |
| `wc -l` | count lines |
| `head` / `tail` | first / last lines |
| `sed 's/old/new/g'` | replace text |
| `tr a-z A-Z` | translate characters |

## commands | Log analysis recipes

```term
$ grep -c ' 500 ' access.log                         # how many 500 errors?
$ awk '$9 >= 500' access.log | wc -l                  # the same, by status column
$ awk '{print $1}' access.log | sort | uniq -c | sort -rn | head   # top IPs
$ awk '{print $7}' access.log | sort -u | wc -l       # how many distinct paths
$ grep -i error app.log | tail -n 20                  # the latest errors
$ cut -d: -f1 /etc/passwd                             # user names
$ sed -i 's/timeout=5/timeout=30/' app.conf           # edit a file in place
$ ./deploy.sh > deploy.log 2>&1                       # keep all output for later
```

```replay
title: Building a pipeline step by step
scenario: laptop
setup: printf '10.0.0.5 GET /\n10.0.0.9 POST /login\n10.0.0.5 POST /login\n10.0.0.9 POST /login\n10.0.0.9 POST /login\n' > ~/mini.log
step: cat mini.log | Start by looking at the raw data.
step: grep login mini.log | Keep only the lines about /login.
step: grep login mini.log | awk '{print $1}' | Keep only the first column: the client IP.
step: grep login mini.log | awk '{print $1}' | sort | Sort, so identical IPs sit next to each other...
step: grep login mini.log | awk '{print $1}' | sort | uniq -c | ...because uniq -c only merges adjacent duplicates.
step: grep login mini.log | awk '{print $1}' | sort | uniq -c | sort -rn | Biggest count first: 10.0.0.9 is the noisy one.
```

## analogy | An assembly line

A pipeline is a factory line. Raw material (the log) enters at one end. The first station throws away the parts you do not need (`grep`), the next trims each part to size (`awk`), the next sorts them into order (`sort`), the next counts identical parts (`uniq -c`), and the last puts the biggest piles at the front (`sort -rn`). Each station is simple. The line is powerful.

## team | Turning one-liners into knowledge

- **Build pipelines incrementally**: add one stage at a time and look at the output.
- **Save good ones** in the team runbook or as small scripts. Today's clever one-liner is tomorrow's on-call tool.
- **Logs at scale** live in log platforms (you will meet them in the Observability realm), but the thinking is the same: filter, extract, group, count, sort.

## traps | Pipeline traps

**`uniq` without `sort`.** It only merges *adjacent* lines, so unsorted input gives wrong counts.

**`> file` when you meant `>>`.** One character, and yesterday's log is gone.

**`sort` sorts text by default.** `10` comes before `9`. Use `sort -n` for numbers.

**Redirecting into the file you read.** `sort data.txt > data.txt` empties the file before `sort` reads it. Write to a new file, then move it.

**Errors vanish into pipes.** Only stdout flows through `|`; errors still print on the screen (or nowhere, if you redirected them).

## lab | Investigate the access log

The login page was slow this morning. You have the web server's access log. Answer the team's questions with pipelines, and save a short report.
