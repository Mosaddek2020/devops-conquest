## story | Forty-seven days for one button

Lumen's product manager asked a simple question: "Why did the *Add to calendar* button take 47 days to reach users? It was two days of coding."

The team traced the button's journey through every system it touched. Coding: 2 days. Waiting for a code review: 6 days. Waiting for the next test cycle: 9 days. Manual testing: 3 days. Waiting for the monthly release window: 22 days. Release and verification: 5 days.

Only **10 of the 47 days** involved anyone working on it. The rest was **waiting** in queues between teams. Making developers type faster would have changed almost nothing. Shrinking the queues changed everything: smaller pull requests got reviewed the same day, automated tests replaced the test cycle, and continuous delivery removed the release window. The next button took four days.

## model | The loop and the value stream

Software delivery is a loop, not a line. What you learn from running software feeds the next plan.

```diagram
devops-loop
```

| Phase | The question it answers | Typical tools (you will use all of these) |
|---|---|---|
| Plan | What should we build next, and why? | Issues, roadmaps |
| Code | How do we build it together? | Git, pull requests, code review |
| Build | Can we turn it into something runnable? | Compilers, package managers, Docker |
| Test | Does it work, and is it safe? | Unit and integration tests, scanners |
| Release | Is this exact version ready to ship? | Version tags, artifacts, registries |
| Deploy | How do we put it in front of users safely? | Pipelines, Kubernetes, rollouts |
| Operate | How do we keep it running? | Linux, systemd, cloud, infrastructure as code |
| Monitor | Is it healthy? Are users happy? | Metrics, logs, traces, alerts |

A **value stream** is every step from "someone has an idea" to "a user benefits from it". Two numbers matter:

- **Lead time**: how long the whole journey takes.
- **Process time**: how much of that someone actually worked on it.

The ratio between them, the *flow efficiency*, is usually shocking: 10 to 20% is common. The biggest wins come from removing waiting, not from working faster.

Three levers shrink waiting:

1. **Smaller batches**: small changes are reviewed, tested and deployed faster, and are easier to debug.
2. **Less work in progress**: finishing beats starting. Ten half-done things deliver nothing.
3. **Automation of handoffs**: a pipeline does not have a queue of tickets.

## analogy | The coffee shop queue

A coffee shop can have the fastest barista in the city, but if every order first waits at a cashier who takes payments one at a time, then for a manager to approve oat milk, the line still goes out the door. You speed the shop up by removing the waits between people, not by asking the barista to move faster.

## commands | Reading the evidence

DevOps work starts with evidence, and evidence usually lives in text files: logs, exports, reports. A handful of commands go a long way:

```term
$ cat feature-4521.log          # print the whole file
$ head -n 3 feature-4521.log    # just the first 3 lines
$ tail -n 2 feature-4521.log    # just the last 2 lines
$ wc -l feature-4521.log        # count the lines
$ grep -i wait feature-4521.log # only lines containing "wait" (any case)
$ echo "note" >> findings.txt   # append a line to a file
```

You will learn these properly in the Linux realm; here they help you investigate.

## team | Making flow visible

Teams that improve delivery make the work visible:

- A board where every item shows its stage, and how long it has waited there.
- A weekly look at the DORA metrics, not to blame anyone but to spot the biggest queue.
- **Work-in-progress limits**: "no more than three items in review at once" forces the team to finish reviews before starting new work.
- Retrospectives that ask "where did this wait?" rather than "who was slow?".

## traps | Flow traps

**Optimising one step.** Making builds two minutes faster does not help if changes wait two weeks for a release window.

**Big batches "to save time".** One release with 200 changes saves ceremony and costs you a week of debugging when it breaks.

**Measuring people instead of flow.** Lines of code or tickets closed per person encourage the wrong behaviour. Measure the system.

## lab | Follow the button

Lumen's tracking system exported the journey of feature **#4521** (the *Add to calendar* button) as a log file in your home folder. Investigate where the time went, and write your findings to a file.
