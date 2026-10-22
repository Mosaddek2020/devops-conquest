## story | The server with no screen

Nadia's first production incident at Lumen started with a message: "web3 is slow, can you have a look?" She opened the cloud console expecting a dashboard with buttons. Instead she got a black window with a blinking cursor: `ubuntu@web3:~$`.

Servers have no desktop, no mouse and no file explorer. Almost every server on the internet runs Linux, and you drive it by typing. That felt hostile for about a week. Then Nadia noticed she could do in one line what took twenty clicks, repeat it on fifty servers with a loop, and paste it into a runbook so anyone could do it at 3 a.m.

The terminal is not old-fashioned. It is the most precise, scriptable and shareable interface operations work has.

## model | Shell, prompt, filesystem

The **shell** (here: `bash`) is the program that reads what you type, runs it and shows the result. The **prompt** tells you where you are:

```term
dev@laptop:~/projects$
```

`dev` is the user, `laptop` the machine, `~/projects` the current directory (`~` means your home folder, `/home/dev`), and `$` means a normal user (`#` means root).

Everything lives in one tree that starts at `/`, the **root**:

```diagram
fs-tree
```

A **path** names a place in that tree:

- **Absolute** paths start at `/`: `/var/log/nginx/error.log` works from anywhere.
- **Relative** paths start where you are: if you are in `/var/log`, then `nginx/error.log` is the same file.
- `.` is the current directory, `..` is its parent, `~` is your home.

A command line has a shape: `command -options arguments`, for example `ls -l /etc`. Options change *how* a command behaves; arguments say *what* it works on.

## commands | Moving around

```term
$ pwd                 # where am I?
$ ls                  # what is here?
$ ls -l               # long format: permissions, owner, size, date
$ ls -la /etc         # everything in /etc, hidden files (starting with .) too
$ cd /var/log         # go to an absolute path
$ cd nginx            # go into a subfolder (relative path)
$ cd ..               # up one level
$ cd -                # back to the previous directory
$ cd                  # home (same as cd ~)
$ ls --help           # every command explains itself
$ history             # what you typed before
```

Two keys save hours: **Tab** completes commands and file names (press it twice to see the options), and **↑** brings back previous commands.

```replay
title: Walking the tree
scenario: laptop
step: pwd | You start in your home folder, /home/dev.
step: cd /var/log | An absolute path: it works from anywhere.
step: pwd | The prompt and pwd agree: you are in /var/log.
step: cd .. | Two dots: the parent directory.
step: ls | cd .. took you from /var/log up to /var; ls shows what is in it.
step: cd ~ | Tilde: straight back home.
step: ls -la | -a shows hidden files (names starting with a dot), like .bashrc.
```

## analogy | A building with corridors

The filesystem is a building. `/` is the lobby, directories are corridors and rooms, files are the documents on the desks. An **absolute path** is a full address from the lobby: "ground floor, east corridor, room 12". A **relative path** is directions from where you stand: "next door, then the second room". `pwd` is checking the room number on the door; `cd ..` is stepping back into the corridor.

## team | Habits of people who live in the terminal

- **Look before you leap**: run `pwd` and `ls` before any command that changes things.
- **Use Tab** constantly. It prevents typos and tells you whether a path exists.
- **Prefer absolute paths in scripts and runbooks**: they work no matter where the reader is.
- **Read `--help` and `man`** before asking: most answers are there, and they match the version you actually have.

## traps | Shell traps

**Spaces in names.** `cd My Documents` tries to go to `My`. Quote it: `cd "My Documents"`, or press Tab.

**Case matters.** `Readme.md` and `README.md` are different files on Linux.

**Hidden files.** Configuration often lives in dot files (`.bashrc`, `.ssh/`). Plain `ls` does not show them; `ls -a` does.

**The wrong machine.** Always read the prompt. `dev@laptop` and `ubuntu@prod-db-1` look similar at 3 a.m.

## lab | Find your way around

Your laptop's filesystem looks like any Linux server's. Explore it: the system folders, the logs, your home folder and its hidden configuration.
