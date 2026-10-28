## story | Twelve commands in a README

The notify service's README listed how to lint, test, build and deploy it: twelve commands, some of them out of date. New joiners copied them one by one. CI ran a slightly different version. Someone deployed without running the tests because the test command had moved to a different section.

A **Makefile** gives every task one name: `make test`, `make build`, `make deploy`. The commands live in one file, in git, used the same way by people and by CI. And `make` knows dependencies: `deploy` needs `test` and `build`, and `build` only re-runs when the source files changed.

## model | Targets, prerequisites and recipes

```makefile
VERSION ?= 1.0.0
SRC := $(wildcard src/*.js)

.PHONY: help lint test deploy clean

build: dist/notify-$(VERSION).tar.gz

dist/notify-$(VERSION).tar.gz: $(SRC) package.json
	mkdir -p dist
	tar czf $@ src package.json

deploy: test build
	@echo "deploying $(VERSION)"
```

- A **rule** is `target: prerequisites` followed by a **recipe**: lines indented with a **tab** (not spaces).
- `make TARGET` makes the prerequisites first. For a **file** target, the recipe runs only if the file is missing or older than a prerequisite: an **incremental build**.
- **`.PHONY`** marks targets that are not files (`test`, `clean`, `deploy`). Without it, a directory called `test/` makes `make test` think there is nothing to do.
- Variables: `VAR = value` (expanded when used), `VAR := value` (now), `VAR ?= value` (default, overridable: `make build VERSION=2.0.0`). Automatic variables: `$@` the target, `$<` the first prerequisite, `$^` all of them.
- Each recipe line runs in **its own shell**: a `cd` on one line does not affect the next. A failing line stops make (`make: *** [Makefile:12: test] Error 1`); prefix `@` to hide the command, `-` to ignore its failure.
- `make -n TARGET` (dry run) prints what would run without running it.

## commands | Everyday make

```term
$ make                         # the first target (often help or all)
$ make test
$ make build VERSION=2.1.0
$ make -n deploy               # what would deploy do?
$ make clean build             # several goals in order
$ make -C services/notify test # run in another directory
```

## analogy | A recipe book with "you will need"

Each recipe lists what you need first (prerequisites) and the steps (the recipe). If the cake from this morning is still fresh and none of its ingredients changed, you do not bake it again.

## team | Make in a team

- **One entry point** for humans and CI: the CI workflow runs `make lint test build`, exactly what you run locally.
- **A `help` target** as the first rule, so `make` alone explains the project.
- **Keep recipes short**: call scripts for anything longer than a few lines.
- **Mark everything that is not a file `.PHONY`.**

## traps | Make traps

**Spaces instead of a tab**: `*** missing separator.  Stop.` Configure your editor to keep tabs in Makefiles.

**Missing `.PHONY`**: a file or directory with the target's name makes the target "up to date" forever.

**`cd dir` on its own recipe line**: the next line runs back in the original directory. Use `cd dir && cmd`.

**Unescaped `$` for the shell**: write `$$HOME` in a recipe; `$HOME` is make's (empty) variable.

## lab | One command per task

The notify service in `~/notify` has a Makefile that someone started. Make it work, make the tasks honest, add an incremental build, and wire deploy to the steps it needs.
