## story | The 9-minute build

Every change to Lumen's booking API took nine minutes to build, even a one-line fix to an error message. The Dockerfile copied the whole project first and ran `npm install` after it, so any code change invalidated the dependency layer and every build reinstalled 400 packages from scratch.

Moving two lines (copy `package.json` and the lockfile, install, *then* copy the code) brought builds down to 20 seconds. Understanding **layers and the build cache** is the difference between a pipeline people wait for and one they forget is there.

## model | A Dockerfile, line by line

```term
FROM node:20-slim              # start from a base image
WORKDIR /app                   # cd (and mkdir) inside the image
COPY package*.json ./          # copy only what the install needs…
RUN npm ci --omit=dev          # …so this layer stays cached
COPY . .                       # then the code, which changes often
ENV NODE_ENV=production
EXPOSE 3000                    # documentation: the app listens here
CMD ["node", "server.js"]      # what `docker run` starts
```

```diagram
image-layers
```

- Each `RUN`, `COPY` and `ADD` creates a **layer**. Docker caches layers and reuses one when the instruction and its inputs (for `COPY`, the copied files' contents) are unchanged.
- When a layer changes, **every layer after it is rebuilt**. Order instructions from least to most frequently changing.
- `RUN` executes at **build** time inside a temporary container. `CMD` runs at **container start**.
- Write `CMD` in **exec form**, `["node", "server.js"]`. The shell form `CMD node server.js` wraps your app in `/bin/sh -c`, which does not pass `docker stop`'s SIGTERM on, so your app gets killed after 10 seconds instead of shutting down cleanly.
- `EXPOSE` does not publish anything; `-p` at run time does.
- Inside a container, `localhost` is the container itself. A server must **listen on `0.0.0.0`** to be reachable through a published port.

```replay
title: Watch the cache work
scenario: docker
show: docker
cwd: ~/app
setup: printf 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nCMD ["node", "server.js"]\n' > Dockerfile
step: cat Dockerfile | Dependencies are installed before the code is copied.
step: docker build -t app:1 . | First build: every step runs. RUN npm ci installs the dependencies into their own layer.
step: sed -i 's/Hello from a container/Hello again/' server.js | Now change only the code.
step: docker build -t app:2 . | Second build: the package files did not change, so npm ci comes straight from the cache. Only COPY . . re-runs.
step: docker history app:2 | Each instruction is a layer with its own size.
```

## commands | Building

```term
$ docker build -t booking:dev .           # . is the build context
$ docker build -t booking:dev -f docker/Dockerfile .
$ docker build --no-cache -t booking:dev .   # ignore the cache (rarely needed)
$ docker history booking:dev              # layers and their sizes
$ docker run --rm -p 3000:3000 booking:dev
$ docker inspect booking:dev --format '{{.Config.Cmd}}'
```

## analogy | Saving your game

A build is a long game level with a save point after every instruction. If you die at step 6, you restart from the save at step 5, not from the beginning. But if you change something in step 3, every save point after it is invalid. Put the things you change all the time (your code) as late in the level as possible.

## team | Dockerfile standards

- **A Dockerfile lives in the repo** next to the code and is reviewed like code.
- **Pin base image versions** (`node:20.18-slim`, not `node:latest`), so a rebuild next month gives the same result.
- **`npm ci` with a lockfile**, never `npm install`, so builds are reproducible.
- **CI builds the image**; nobody pushes images from a laptop.
- When an AI assistant drafts a Dockerfile, check: base image pinned? lockfile used? cache-friendly order? exec-form CMD? listens on 0.0.0.0? not root?

## traps | Dockerfile traps

**`COPY . .` before installing dependencies** destroys the cache on every code change.

**App listens on `127.0.0.1`** inside the container: `curl` from the host gets "Connection reset by peer" even though the port is published.

**`RUN cd /app`** has no effect on the next line: each `RUN` is a new shell. Use `WORKDIR`.

**Copying `node_modules` from your laptop** into the image: wrong platform binaries, huge context. Exclude it with `.dockerignore`.

## lab | Containerise the booking API

Write a Dockerfile for `~/booking`, get it serving from a container, then fix its build cache so code changes rebuild in seconds.
