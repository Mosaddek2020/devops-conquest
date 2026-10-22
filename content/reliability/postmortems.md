## story | "Root cause: human error"

After INC-37, the first postmortem draft said "Root cause: Kofi carelessly deleted the config file." Kofi stopped volunteering for on-call. Three months later the same thing happened to someone else, because nothing had changed: the cleanup script still matched `*.env`, there was still no alert on the shop being down on one server, and the backups of config files were still manual.

A **blameless postmortem** assumes people did reasonable things with the information they had, and asks how the *system* allowed the failure. That's the only way people tell the full truth, and the only way to actually prevent a repeat.

## model | Anatomy of a good postmortem

- **Summary**: what happened, impact, duration, in three sentences.
- **Impact**: who was affected, how much (errors, orders lost, minutes), measured from data.
- **Timeline** (UTC): detection, key findings, mitigation, resolution, from the incident log.
- **Contributing factors** (plural): systems, processes and conditions that combined. There is rarely one root cause; "human error" is a starting point for questions, never a conclusion.
- **What went well / what was hard.**
- **Action items**: specific, owned, dated, tracked (prevent, detect faster, mitigate faster).
- AI assistants can draft a postmortem from the incident timeline in seconds. Check every fact against the record, and remove blame they copy from chat logs.

## commands | From incident to postmortem

```term
$ incident timeline INC-37
$ cat postmortems/INC-37-draft.md
$ ai "review this postmortem for blameless language"
```

## analogy | Aviation safety reports

Airlines got dramatically safer when pilots could report near-misses without being punished. Investigators ask why the cockpit design, procedures or training made the error likely, then change those. Blaming the pilot fixes nothing for the next pilot.

## team | Postmortem habits

- **Write one for every SEV1/SEV2** and for interesting near-misses, within a week.
- **Review it together**, blameless facilitation.
- **Track action items** like any other work, with owners and dates; review overdue ones.
- **Share widely**: other teams learn from your incidents.

## traps | Postmortem traps

**Naming a person as the root cause.**

**Vague actions** ("be more careful", "improve monitoring") with no owner or date.

**Wrong timeline** reconstructed from memory instead of the incident record.

**Postmortems nobody reads** and actions nobody tracks.

## lab | Fix the AI's draft

An AI assistant drafted the INC-37 postmortem from chat logs. Check it against the real incident timeline and turn it into a blameless postmortem with real action items.
