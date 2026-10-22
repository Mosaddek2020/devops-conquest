## story | Two engineers, one assistant

During a Friday incident, a disk filled up on a payment server. Engineer A pasted the alert into an AI chat, got back `sudo rm -rf /var/log/*`, and ran it. The disk recovered. So did the attackers who had been in the system for a week: the logs that would have shown them were gone, and so was the audit trail the company needed for its compliance report.

Engineer B, on another team, used the same assistant differently. She asked it to explain an unfamiliar error, to draft a runbook from her rough notes, and to suggest *where to look*. She read every suggested command, asked "what does `-f` do here?", tried it on staging first, and kept a human decision at every step. Her team's time to recover from incidents dropped by a third.

Same tool. The difference was the person's judgment.

## model | What AI changes, and what it does not

AI assistants (chat models, code copilots, and increasingly **agents** that can run tools) are now part of everyday DevOps work. They are good at some things and dangerous at others.

| AI is strong at | AI is weak at |
|---|---|
| Explaining commands, errors and concepts | Knowing *your* systems, history and constraints |
| Drafting scripts, configs, docs and tests | Recent changes, versions and your company's rules |
| Summarising long logs, threads and diffs | Knowing when it is wrong (it sounds equally sure either way) |
| Suggesting where to look next | Understanding side effects and blast radius |

The failure mode has a name: **hallucination**, a confident answer that is simply invented, such as a flag that does not exist or an API removed two versions ago.

```diagram
ai-verify
```

The rule for the rest of this course: **the AI drafts, you decide**. Every suggestion goes through the same loop: read it, understand each part, test it somewhere safe, apply it in a small step, and observe the result.

What does not change: you still need the fundamentals. You cannot verify a command you do not understand, and you cannot debug at 3 a.m. with an assistant if you cannot tell a good answer from a bad one. That is why this course teaches the fundamentals first and the AI-assisted workflows on top.

## analogy | The brilliant new intern

Imagine an intern who has read every manual ever written, answers instantly and never gets tired, but joined this morning, has never seen your systems, and sometimes makes things up rather than say "I don't know". You would happily ask them for drafts and ideas. You would not hand them the production root password and go to lunch.

## team | How good teams use AI

- **No secrets in prompts.** No passwords, keys, tokens or customer data in a chat window.
- **Review AI output like a junior colleague's pull request**: line by line, with tests.
- **Humans approve actions.** Agents that run commands get the least privilege possible, a dry-run mode and a human approval step for anything risky.
- **Keep an audit trail** of what AI tools did and who approved it.
- **Use AI to learn, not to skip learning.** Ask it *why*, not just *what*.

## traps | AI traps

**Copy, paste, enter.** Running a command you cannot explain on a real system.

**Confidence equals correctness.** The tone of an answer tells you nothing about whether it is right.

**Fixing the symptom.** "Delete the logs" makes the alert go away; it does not answer why the disk filled up.

**Over-sharing.** Pasting a config file with database passwords into a public AI tool is a security incident.

## lab | Your new AI pair

Your laptop's disk is almost full and builds are failing. The terminal has a simulated AI assistant: type `ai "your question"` to ask it, and `ai explain "<command>"` to have any command broken down with a risk rating.

Use it the way Engineer B would: as a helper whose suggestions you check.
