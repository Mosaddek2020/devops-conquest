## story | The hotfix that vanished

At 2 a.m. the Lumen status page showed the wrong maintenance message. Kofi ran `docker exec -it status sh`, edited the HTML file inside the container, and went back to bed. The page was right. The next morning a routine redeploy recreated the container and the wrong message was back, and nobody knew why.

A container's filesystem is the image's files plus a **thin writable layer**. Changes inside a running container live only in that layer. Remove the container and they are gone. That is a feature: every container starts from a known state. It also means that anything you want to keep must go back into the **image** (rebuild) or into a **volume** (data).

## model | The life of a container

```term
image ──run──▶ created ──▶ running ──stop──▶ exited ──rm──▶ (gone)
                             ▲  │                │
                             │  └── crashes ─────┘
                             └──── start / restart policy
```

- `docker run` = `pull` (if needed) + `create` + `start`.
- The image sets a default **command** (`CMD`). Arguments after the image name replace it: `docker run alpine ls /`.
- When the main process exits, the container stops. Its **exit code** tells you why: `0` finished normally, `1` the app failed, `137` it was killed (often out of memory), `127` the command does not exist in the image.
- `docker logs` shows what the main process printed to stdout and stderr. That is why apps in containers log to the console, not to files.
- Configuration comes in through **environment variables**: `-e DATABASE_URL=…` or `--env-file`.
- `docker exec` runs an extra process inside a running container. `exec -it … sh` gives you a shell for **debugging**, not for fixing.
- `--restart unless-stopped` (or `always`, `on-failure`) tells Docker to restart the container when it dies, and after a reboot.

## commands | Working with images and containers

```term
$ docker pull nginx:1.27                      # download an image
$ docker images                               # list images
$ docker run -it --rm alpine sh               # interactive shell, removed on exit
$ docker run -d --name api -e PORT=3000 -p 3000:3000 lumen/api:1.0
$ docker logs api                             # what it printed (add -f to follow)
$ docker exec -it api sh                      # a shell inside (if the image has one)
$ docker exec api env                         # one command inside
$ docker inspect api --format '{{.State.ExitCode}}'
$ docker restart api
$ docker run -d --restart unless-stopped …    # comes back after crashes and reboots
$ docker rm -f api                            # stop and remove in one go
```

## analogy | A recipe and a dinner

The image is a recipe card: fixed, copyable, versioned. A container is one dinner cooked from it. You can add salt to your plate (the writable layer) but that does not change the recipe, and tomorrow's dinner will taste like the recipe again. To make every future dinner saltier, you change the recipe and print a new card (rebuild the image).

## team | Habits

- **Never fix production with `exec`.** Debug with it, then fix the image or the configuration and redeploy.
- **One process per container.** The app is PID 1. Run the database in its own container.
- **Configuration via environment, secrets via your platform's secret store**, never baked into the image.
- **Read the exit code and logs first.** `docker ps -a` and `docker logs` answer most "it doesn't start" questions.

## traps | Container traps

**Editing files inside a container** and expecting them to survive a redeploy.

**`docker logs` is empty** because the app writes to a log file inside the container instead of stdout.

**Exit code 127** "executable file not found": the command is not in the image (alpine has no `bash`, distroless has no shell at all).

**A crash loop with `--restart always`** hides the problem: check `docker ps` for "Restarting" and read the logs.

## lab | Debug a container that will not stay up

The team published `lumen/notify:1.0`. Run it, read why it dies, fix the run command, and prove to yourself where changes made inside a container go.
