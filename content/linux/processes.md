## story | The report that ate the server

Every night at 2 a.m., a reporting script ran on Lumen's admin server. One night a change made it loop forever, pinning both CPUs at 100%. The admin site slowed to a crawl, and the on-call engineer got paged at 2:20.

She logged in, ran `top`, and saw it at once: `report.py` using 199% CPU for 18 minutes. She tried `kill` with its process ID; the script ignored the polite request because it was stuck in a tight loop without checking signals. `kill -9` ended it instantly. Then, instead of going back to sleep, she disabled the cron job so it would not start again at 2 a.m. tomorrow, and left a note for the team.

Finding a process, understanding what it is doing, and stopping it safely are daily operations skills.

## model | Processes, signals and exit codes

A **process** is a running program. It has:

- a **PID** (process ID) and a **parent** (PPID): processes form a tree, with `systemd` (PID 1) at the root;
- an **owner** (the user it runs as), which limits what it can touch;
- **resources**: CPU time, memory, open files, network sockets.

You talk to processes with **signals**:

```diagram
signals
```

When a process ends, it returns an **exit code**: `0` means success, anything else means some kind of failure. The shell keeps the last one in `$?`, and `&&`, `||` and scripts make decisions with it.

**Foreground and background**: a command normally runs in the foreground and holds your terminal. Add `&` to run it in the background, `jobs` lists background jobs, `nohup` keeps one running after you log out. (For real services you will use systemd instead, in the Services realm.)

**Load average** (from `uptime` or `top`) is how many processes, on average, wanted CPU over the last 1, 5 and 15 minutes. Compare it with the number of CPUs (`nproc`): a load of 2.0 on 2 CPUs is busy; on 16 CPUs it is idle.

## commands | Watching and controlling processes

```term
$ ps aux                          # every process: user, PID, %CPU, %MEM, command
$ ps aux --sort=-%cpu | head -5   # the five hungriest
$ pgrep -a report                 # find PIDs by name
$ top                             # live view (q quits); htop is friendlier
$ uptime                          # load average
$ kill 4312                       # SIGTERM: please stop
$ kill -9 4312                    # SIGKILL: stop now (last resort)
$ pkill -f report.py              # by name / command line
$ sleep 300 &                     # run in the background
$ jobs                            # background jobs in this shell
$ echo $?                         # exit code of the last command
$ false; echo $?                  # 1
$ ls /nope && echo found || echo missing
```

```replay
title: Exit codes drive decisions
scenario: laptop
step: ls /etc/hostname; echo "exit code: $?" | Success: exit code 0.
step: ls /nope; echo "exit code: $?" | Failure: a non-zero exit code (2 for ls).
step: ls /etc/hostname && echo "it exists" | && runs the next command only after a success.
step: ls /nope 2>/dev/null || echo "not there" | || runs the next command only after a failure.
```

## analogy | A busy kitchen

Processes are cooks. Each has a name tag (PID), works for a department (user) and uses burners and counter space (CPU and memory). `ps` is the kitchen roster, `top` is looking around the room to see who is sweating. `kill` (TERM) is asking a cook to finish the current plate and leave; `kill -9` is security escorting them out mid-sauce, burner still on. The exit code is the cook's note on the way out: "0, all done" or "1, something went wrong".

## team | Process hygiene

- **Measure before you kill**: note the PID, the user, the command line and how long it has run. That is your evidence for the follow-up.
- **TERM first, KILL last.** Give the process a chance to clean up (close files, finish requests, release locks).
- **Fix the cause.** Killing a runaway process is mitigation; the cron job, deploy or bug that started it is the real fix.
- **Long-running things belong in systemd**, not in a forgotten `nohup` in someone's shell.

## traps | Process traps

**Killing the wrong PID.** PIDs are reused. Re-check with `ps -p PID -o pid,user,cmd` right before you kill.

**`kill -9` as a habit.** Databases and queues can corrupt data or lose messages when killed without cleanup.

**`grep` finds itself.** `ps aux | grep report` lists the grep process too. Use `pgrep -a report`.

**Load average without context.** A number means nothing without the CPU count.

## lab | The runaway job

Your laptop's fans are screaming and everything is slow. Find out what is eating the CPU, stop it properly, and practise background jobs and exit codes.
