## story | The query built from a string

An API endpoint looked up an order with `"SELECT * FROM orders WHERE id = '" + req.query.id + "'"`. It passed code review and every test, because every test used a normal id. A security scan in CI flagged the line months later: the request parameter went straight into the SQL text, so the database could not tell the developer's query apart from whatever a caller sent. Fixing one line closed a hole that could have exposed every customer's order.

**Injection** has been near the top of the OWASP Top 10 for twenty years because building queries and commands out of strings looks harmless. **Static application security testing (SAST)** reads the source code and flags those patterns before they ship.

## model | Static analysis and the fixes that actually work

- **SAST** tools (semgrep, CodeQL, SonarQube) match code against rules: user input flowing into SQL, shell commands, `eval`, hard-coded secrets, weak hashing, disabled TLS checks.
- **The fix for SQL injection is a parameterized query**: `db.query('SELECT * FROM orders WHERE id = $1', [id])`. The database receives code and data separately, so data can never become code. Escaping quotes by hand is not a fix.
- **The fix for command injection** is not to build a shell command from input: call the program with an argument array (`execFile('ping', ['-c', '1', host])`) and validate the input.
- **Custom rules** encode your team's lessons: "never set `rejectUnauthorized: false`", "use our logger, not console.log". In semgrep a rule is a few lines of YAML.
- **Suppressions** (`// nosemgrep`) need a comment explaining why, and review.
- SAST finds patterns, not proof: some findings are false positives, and it misses bugs in logic. Combine it with tests and DAST.

## commands | Scan, fix, re-scan

```term
$ semgrep scan --config auto .            # registry rules for your languages
$ semgrep scan --config auto --error .    # exit 1 on findings (for CI)
$ semgrep scan --config rules/ .          # your own rules
$ semgrep scan --config auto --json . > semgrep.json
```

## analogy | Spell-check for dangerous code

A spell-checker underlines words it knows are wrong; it cannot tell you the essay is boring. SAST underlines code shapes known to be dangerous. You still need a human to read the essay.

## team | SAST that people do not mute

- **Start with high-confidence rules**, fail the build only on those, and add more as the noise drops.
- **Show findings in pull requests**, where the author still remembers the code.
- **Turn every incident into a rule** so the same mistake is caught next time.
- **AI fixes need re-scanning.** Assistants often "fix" injection by escaping quotes or validating with a regex. Run the scanner again and prefer the parameterized version.

## traps | SAST traps

**Escaping instead of parameterizing.** Hand-written escaping misses cases (encodings, numeric contexts).

**Suppressing to get green.** A `nosemgrep` without a reason is a hidden vulnerability.

**Scanning only new code forever** while the old injection keeps running in production.

**Believing a clean scan means secure.** Logic bugs and broken access control need tests and review.

## lab | Injection in the orders API

The orders API on `api1` builds SQL from the query string. Find it with semgrep, reject an AI's half-fix, fix it with a parameterized query, re-scan clean, and write a custom rule for a mistake the team keeps making.
