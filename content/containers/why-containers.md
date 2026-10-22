## story | "But it works on my machine"

Lumen's new search service worked perfectly on Priya's laptop. On the staging server it crashed at startup: the server had Node 18, Priya had Node 20. They fixed that, and it crashed again because a system library was a different version. Then production needed a third set of fixes. Each server had become a slightly different snowflake, set up by hand at different times.

Containers solve this by shipping **the app together with everything it needs**: the runtime, the libraries, the files. That bundle is an **image**. The image runs the same on a laptop, a CI runner, a staging VM and a production cluster, because the machine only provides a Linux kernel and a container runtime. Everything above that comes from the image.

Today almost everything you deploy ends up in a container: Kubernetes, most cloud platforms and most CI systems run them. AI assistants write Dockerfiles in seconds, and many of them are subtly wrong. This realm teaches you to write, read and fix them yourself.

## model | Images, containers and the kernel

```diagram
vm-vs-container
```

- An **image** is a read-only template: a filesystem plus settings (which command to run, which user, which ports). It is built once and stored in a **registry**.
- A **container** is a running (or stopped) instance of an image: an ordinary Linux process with its own view of the world.
- The kernel creates that view with **namespaces**: the container sees its own processes (its app is PID 1), its own filesystem, its own network interface and hostname. **cgroups** limit how much CPU and memory it may use.
- A container is **not a VM**. There is no guest OS to boot, so it starts in milliseconds and uses megabytes, not gigabytes. All containers on a host share that host's kernel.

Docker is a **daemon** (`dockerd`) plus a **CLI** (`docker`). The CLI talks to the daemon over a socket, `/var/run/docker.sock`. Only root and members of the `docker` group may use that socket, so after installing Docker you add yourself to the group.

| Word | Means |
|---|---|
| image | the packaged app: files + metadata, read-only |
| container | a process started from an image, with a writable layer on top |
| registry | a server that stores images (Docker Hub, GitHub's ghcr.io, a company registry) |
| tag | a human name for an image version: `nginx:1.27`, `myapp:2.3.1` |
| `-p 8080:80` | publish: host port 8080 forwards to port 80 inside the container |

## commands | First containers

```term
$ sudo apt install -y docker.io            # install the engine
$ sudo usermod -aG docker $USER            # use docker without sudo
$ docker run alpine echo hello             # pull alpine, run one command, exit
$ docker run -d --name web -p 8080:80 nginx   # -d: in the background
$ docker ps                                # running containers
$ docker ps -a                             # including stopped ones
$ docker logs web                          # what it printed
$ docker stop web && docker rm web         # stop, then remove
$ docker images                            # images on this machine
```

```replay
title: A container's life, step by step
scenario: docker
show: docker
step: docker run -d --name web -p 8080:80 nginx | -d starts it in the background and prints the new container's ID. The panel shows it running, with host port 8080 published to port 80 inside.
step: curl -s localhost:8080 | Your laptop's port 8080 forwards into the container, where nginx answers.
step: docker exec web cat /etc/os-release | The container has its own filesystem: a Debian userland, whatever your laptop runs.
step: ps aux | grep nginx | Yet it is an ordinary process on your laptop: the host's ps sees nginx too.
step: docker stop web | Stopped, but not gone: the panel still lists it as exited.
step: docker rm web | Now it is removed. The nginx image stays, ready for the next run.
```

## analogy | Shipping containers

Before standard shipping containers, every cargo was loaded differently: sacks, barrels, crates, each needing its own handling at every port. The steel box changed everything because the crane, the ship and the truck no longer care what is inside. A Docker container is the same deal for software: the server does not care whether it is Node, Python or Go inside. It knows how to run a container.

## team | Containers in a team

- **The image is the release.** You build it once in CI and the same image moves to staging and production.
- **Servers become boring.** They need Docker (or Kubernetes) and nothing app-specific, so they can be replaced at any time.
- **Use the `docker` group carefully.** Being in it is effectively root on that machine, because you can start a container that mounts the host's filesystem.
- **Containers are not a security boundary as strong as a VM.** They share a kernel. Treat untrusted code with care.

## traps | First-day traps

**`sudo docker` everywhere.** It works, but files you create via volumes end up root-owned and you get used to typing sudo. Join the `docker` group instead (log out and back in in real life).

**Forgetting `-d`.** The terminal is attached to the container's output until it stops.

**`-p 80:8080` the wrong way round.** It is always `HOST:CONTAINER`.

**Thinking `docker stop` deletes the container.** It only stops it. `docker ps -a` still shows it, and the name is taken until you `docker rm` it.

## lab | Your first containers

Your laptop has no Docker yet. Install it, make it usable without sudo, run your first containers and serve a web page from one.
