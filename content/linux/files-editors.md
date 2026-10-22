## story | The config file that was "definitely saved"

Samir changed the API timeout on a staging server from 5 to 30 seconds, closed the editor and restarted the service. Nothing changed. Twenty minutes and two colleagues later, they found it: he had edited `/etc/lumen/api.conf.bak`, a backup someone had left next to the real file. The `.bak` had sorted first in his tab completion.

Working with files is the bread and butter of operations: config files, logs, scripts, releases. Most mistakes are not exotic. They are the wrong file, the wrong folder, or a delete that took more than intended.

## model | Files, directories and wildcards

- A **file** holds content; a **directory** holds files and other directories.
- Creating, copying, moving and deleting are all one command each.
- There is **no recycle bin** on the command line. `rm` is final.

**Wildcards** (globs) let one command act on many files. The *shell* expands them before the command runs:

| Pattern | Matches |
|---|---|
| `*.log` | every name ending in `.log` |
| `report-2026-0?.csv` | `?` is exactly one character |
| `img[123].png` | one character from the set |

So `rm *.log` becomes `rm app.log error.log old.log` before `rm` even starts. That is powerful and dangerous: always preview with `ls *.log` first.

To **read** files: `cat` prints everything, `less` pages through big files (`q` quits, `/word` searches), `head` and `tail` show the start and the end.

To **edit** files in a terminal, use an editor such as `nano` (friendly) or `vim` (powerful). In this course, `nano file`, `vim file` and `code file` all open an editor panel: type, then **Ctrl+S** saves.

## commands | Creating, moving, reading

```term
$ mkdir -p projects/api/config     # create nested folders (-p: parents too)
$ touch notes.md                   # create an empty file (or update its time)
$ cp app.conf app.conf.orig        # copy (make a backup before editing!)
$ cp -r site/ site-backup/         # copy a directory: -r is recursive
$ mv draft.md README.md            # rename
$ mv *.png images/                 # move many files at once
$ rm old.txt                       # delete a file (no undo)
$ rm -r build/                     # delete a directory and its contents
$ head -n 20 app.log               # the first 20 lines
$ tail -n 50 app.log               # the last 50 lines
$ less app.log                     # page through it
$ nano app.conf                    # edit it
```

```replay
title: Organise before you delete
scenario: laptop
setup: mkdir -p ~/downloads && cd ~/downloads && touch a.log b.log photo.png notes.md
step: ls | A messy folder.
step: ls *.log | Preview what the pattern matches before acting on it.
step: mkdir -p logs && mv *.log logs/ | One command moves every match.
step: ls -R | Recursive listing: logs/ now holds both log files.
```

## analogy | Moving house

`cp` is photocopying a document and putting the copy in another room. `mv` is carrying the original to the other room (or writing a new label on it: renaming). `rm` is the shredder, and there is no bin to fish it out of. A wildcard is saying "every box labelled *kitchen*": convenient, until a box was mislabelled.

## team | Safe file habits

- **Back up before editing configs**: `cp nginx.conf nginx.conf.$(date +%F)` takes one second.
- **Preview globs** with `ls` before `rm`, `mv` or `chmod` with the same pattern.
- **Use `rm -i`** when unsure; it asks before each file.
- **Keep configs in git** (you will, later) so every change has a history and an undo.

## traps | File traps

**`rm -rf` with a variable.** `rm -rf "$DIR/"` with an empty `$DIR` becomes `rm -rf /`. Scripts must guard against that.

**Editing the wrong copy.** `.bak`, `.orig`, `.old` files sitting next to the real one. Check with `ls -l` and look at the full path.

**Overwriting on copy.** `cp new.conf app.conf` silently replaces `app.conf`. `cp -i` asks first.

**Spaces in names.** `rm my file.txt` deletes `my` and `file.txt`. Quote: `rm "my file.txt"`.

## lab | Tidy up a project

You inherited a messy project folder. Organise it, fix a config value with an editor, and clean up the junk without deleting anything that matters.
