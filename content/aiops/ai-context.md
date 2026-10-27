## story | The question that wasted an hour

At 2 a.m. the shop stopped taking orders. The on-call engineer typed "why is my node app crashing?" into an assistant and got ten generic causes: memory leaks, unhandled promises, wrong Node version. They tried three of them. Forty minutes later a colleague piped the last fifty lines of the service log into the same assistant. It pointed at the first error in the log, `EACCES: permission denied, open '/var/lib/shop/sessions.db'`, and at the deploy ten minutes earlier that had run as root.

The model was the same. The difference was the **context**. An assistant only knows what you tell it, and what you tell it may leave your company: the log in that story also contained the database password.

```diagram
verify-loop
```

## model | Good prompts carry evidence, not secrets

- **Give it evidence**: the exact error, the relevant log lines (`journalctl -u shop -n 50 | ai "…"`), what changed recently, versions. Ask a specific question: "why does shop.service fail to start?" beats "why is my app broken?".
- **Ask for reasoning you can check**: "which log line shows that?" and "how can I confirm it?". A cause you can verify with one command is worth more than five plausible ones.
- **Never send secrets.** Logs and configs are full of passwords, tokens and connection strings. Many companies route assistants through an **AI gateway** with data-loss prevention that blocks prompts containing secrets. Redact before you paste: `sed -E 's/(PASSWORD|SECRET|TOKEN)=[^ ]*/\1=[REDACTED]/'`.
- **Personal data** (customer emails, addresses) needs the same care: share the shape of the data, not the data.
- **The answer is a suggestion.** Before running a suggested command, read it and check its blast radius (`ai explain "…"` here, or your own knowledge). Prefer the smallest fix that works.

## commands | Ask with context, redact first

```term
$ journalctl -u shop -n 50 | ai "why does shop.service fail to start?"
$ ai -f /var/log/shop/error.log "what is the first error?"
$ journalctl -u shop -n 50 | sed -E 's/(PASSWORD|SECRET|TOKEN)=[^ ]*/\1=[REDACTED]/g' | ai "why does it fail?"
$ ai explain "sudo chmod -R 777 /var/lib/shop"
```

## analogy | Calling a colleague at night

If you wake a colleague and say "it's broken", they will ask what you see. If you read them the error, they can help in a minute. You would not read them the production password, and you would still check their advice before typing it into the root shell.

## team | Team rules for assistants

- **Know which tools are approved** and what data each may see (code yes, customer data no, secrets never).
- **Paste outputs, not credentials**: keep redaction one-liners in the runbook.
- **Record AI-suggested actions** in the incident timeline like any other action, so the postmortem can see what was tried.
- **Share good prompts**: a team prompt library for common incidents saves time at 2 a.m.

## traps | Context traps

**Vague questions** get generic answers, which cost time at exactly the wrong moment.

**Pasting the whole environment** (`env`, `.env`, `kubectl get secret -o yaml`) into a chat.

**Trusting the first cause it names** without the log line that proves it.

**Running the "quick fix"** (`chmod 777`, `--force`, `rm -rf`) that makes the error disappear and opens a hole.

## lab | The 2 a.m. question

The shop on `web1` will not start. Your assistant goes through the Lumen AI gateway, which blocks secrets. Get a useful answer by giving it the right context safely, check its suggested fix, and apply the smallest correct one.
