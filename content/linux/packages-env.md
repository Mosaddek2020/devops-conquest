## story | "It works on my machine"

Jonas's deploy script worked perfectly on his laptop and failed on the build server with `jq: command not found`. He installed jq; next it failed with `API_URL: unbound variable`. On his laptop, `API_URL` was set in his `.bashrc` months ago and he had forgotten. On the server, nobody had set it.

Two invisible things make a command behave differently on two machines: **which software is installed** (and which version), and **which environment variables are set**. Making both explicit is the first step towards reproducible systems, and later towards containers, which package both.

## model | Packages, PATH and environment variables

**Packages** are software prepared for your distribution, installed with a **package manager**. On Ubuntu that is `apt`: it downloads packages from repositories, resolves dependencies, verifies signatures, and can update or remove them cleanly. Never download random binaries when a package exists.

When you type `jq`, the shell searches the directories listed in the **PATH** variable, in order, for a file called `jq`. `which jq` shows which one it found. If none: `command not found`.

**Environment variables** are key=value pairs every process inherits from its parent:

| Variable | Typical use |
|---|---|
| `PATH` | where to look for commands |
| `HOME`, `USER` | who and where you are |
| `LANG` | language and character encoding |
| `API_URL`, `DATABASE_URL`, `PORT` | configuration for your apps |

Apps read their configuration from the environment: the **Twelve-Factor** principle "store config in the environment" lets the same code run in development, staging and production with different settings.

- `NAME=value` sets a shell variable, visible only in this shell.
- `export NAME=value` makes it part of the environment, so programs you start inherit it.
- `NAME=value command` sets it for that one command only.
- Put permanent settings in `~/.bashrc` (for your interactive shells), then `source ~/.bashrc` to reload it now.

## commands | Installing and configuring

```term
$ sudo apt update                 # refresh the list of available packages
$ sudo apt install -y jq tree     # install (-y: don't ask)
$ apt list --installed | grep jq  # is it installed?
$ which jq                        # where does the command come from?
$ echo $PATH                      # the search path
$ env | sort                      # the whole environment
$ export API_URL=https://api.lumen.example.com
$ PORT=8080 ./server.sh           # one-off setting for one command
$ echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
$ source ~/.bashrc                # apply it to the current shell
```

## analogy | The kitchen and the order slip

Installed packages are the equipment in the kitchen: no blender, no smoothies, no matter how good the recipe. `PATH` is the list of cupboards the cook checks, in order, when the recipe says "get the blender". Environment variables are the order slip that comes with each dish: same recipe, but table 4 wants it without nuts and table 7 wants it extra spicy.

## team | Making environments reproducible

- **Write down dependencies**: a setup script, a package list, later a Dockerfile. Nothing should live only in someone's head or `.bashrc`.
- **Same config mechanism everywhere**: environment variables (or files generated from them) in dev, CI and production.
- **Pin versions** where behaviour matters, and update deliberately.
- **Keep secrets out of `.bashrc`** and out of git; use a secret store (Security realm).

## traps | Environment traps

**`sudo` resets the environment.** `sudo mycommand` may not see your exported variables or your custom PATH. Use `sudo -E` carefully, or pass what is needed explicitly.

**Editing `.bashrc` and forgetting to reload.** Changes apply to new shells, or after `source ~/.bashrc`.

**Overwriting PATH.** `export PATH=$HOME/bin` (without `:$PATH`) removes every other directory; suddenly `ls` is "not found".

**Unquoted variables.** `cd $DIR` breaks if `DIR` contains a space. Quote: `cd "$DIR"`.

## lab | Make the script work

A teammate's health-check script fails on your laptop. Install what is missing, configure the environment it expects, and make your own scripts folder part of your PATH.
