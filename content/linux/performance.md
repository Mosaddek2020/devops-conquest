## story | "The server is slow"

At 10:40 on a Monday the shop took six seconds per page. The team restarted the app (no change), then added CPUs (no change), then started a bigger instance (still slow, and twice the bill). The cause was a backup job that had overrun into business hours and was saturating the disk; and in passing, nobody noticed that the queue worker had silently stopped processing orders an hour earlier.

Performance problems need a **method**, not guesses. Look at the whole machine first, find the **saturated resource**, then the **process** using it, then **what that process is doing**.

## model | The USE method and the usual suspects

- **USE**: for every resource (CPU, memory, disk, network) check **U**tilization (how busy), **S**aturation (how much work is waiting) and **E**rrors.
- **Load average** (`uptime`): the number of tasks running *or waiting* (for CPU **or disk**), averaged over 1, 5 and 15 minutes. Compare it with the CPU count (`nproc`): 8 on 4 CPUs means work is queuing.
- **`vmstat 1 5`**: `r` = runnable tasks (CPU queue), `b` = tasks blocked on I/O, `si/so` = swapping, `us/sy/id/wa` = user, system, idle and **I/O wait** time.
  - High `us`, `r` > CPUs: CPU-bound.
  - High `wa`, `b` > 0: waiting on disk.
  - `si/so` not zero: out of memory, swapping.
- **`iostat -x`**: per device: `%util` near 100 and growing `await` (milliseconds per request) mean the disk is saturated. **`pidstat -d`** or **`iotop`** show *which* process does the I/O.
- **Being nice**: `renice` lowers a process's CPU priority; `ionice -c3` puts its I/O in the *idle* class, so it only uses the disk when nobody else wants it.
- **`strace -p PID`** shows the system calls a process makes right now: a stuck process often sits in `connect()`, `poll()`, `read()` or `futex()`, which tells you what it is waiting for.
- **`tcpdump`** shows the packets themselves. A `SYN` repeated with no `SYN-ACK` means something drops them (a firewall); a `SYN` answered by `RST` means nothing listens.
- **The kernel log** (`dmesg -T`, `journalctl -k`) records hardware errors and the **OOM killer**, which kills a process when memory runs out.

## commands | From machine to process to system call

```term
$ uptime; nproc                       # load vs CPUs
$ vmstat 1 5                          # r, b, wa, si/so
$ iostat -x 1 3                       # %util and await per disk
$ pidstat -d 1 3                      # disk I/O per process  (or: sudo iotop -o)
$ top                                 # CPU and memory per process
$ sudo ionice -c3 -p 4242             # idle I/O class
$ sudo renice -n 10 -p 4242           # lower CPU priority
$ sudo strace -p 5150                 # what is it doing?
$ sudo tcpdump -n -i eth0 port 5432 -c 5
$ sudo dmesg -T | grep -i -E "killed process|error"
```

## analogy | A traffic jam

Load average is the number of cars on the road, waiting or moving. `vmstat` tells you whether they are stuck at the traffic lights (CPU) or at the toll booth (disk). `iostat` shows which booth is jammed, `pidstat` which truck is blocking it, and `strace` is asking the driver what they are waiting for.

## team | Performance in a team

- **Measure before you scale.** A bigger machine does not fix a saturated disk or a blocked connection.
- **Schedule heavy jobs** (backups, reports) outside peak hours, at low priority, and alert when they overrun.
- **Dashboards for USE metrics** on every host (node_exporter), so the first look takes seconds.
- **Write down the findings** in the incident timeline: "10:52 iostat: xvda 99.8% util, tar backup".

## traps | Performance traps

**Load average = CPU usage.** It also counts tasks waiting on disk. High load with idle CPUs means I/O.

**Killing the backup** (or the database) to make the graph go down. Lower its priority; then find out why it overran.

**strace on a busy production process for long periods**: it slows the process down. Attach briefly.

**Assuming "no errors" means healthy**: a worker blocked in `connect()` logs nothing until it times out, and uses no CPU.

## lab | Slow Monday on app1

The shop on `app1` is slow, and orders are piling up. Work from the whole machine down to the cause: the disk, the process, the system call, the packets. Fix what you find without killing anything important, then find out what happened overnight.
