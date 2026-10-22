## story | The database that forgot everything

A developer at Lumen ran Postgres in a container for the reviews service: `docker run -d --name db -e POSTGRES_PASSWORD=… postgres:16`. Weeks of test data later, they upgraded the image: `docker rm -f db` and ran the new version. Every table was gone. The data had lived in the container's writable layer, and removing the container removed it.

Meanwhile the reviews API could not reach the database at all: `getaddrinfo ENOTFOUND db`. Both containers were on Docker's **default bridge network**, where containers cannot find each other by name.

## model | Where data lives, how containers talk

**Storage**

| Kind | Syntax | Lives | Use for |
|---|---|---|---|
| writable layer | (default) | until `docker rm` | scratch only |
| **named volume** | `-v pgdata:/var/lib/postgresql/data` | until you delete the volume | databases, uploads |
| **bind mount** | `-v ./src:/app/src` | it *is* a host directory | development: live code edits |

A named volume is managed by Docker and outlives any container that uses it. Mount it at the path where the image keeps its data (each official image documents this).

**Networking**

```diagram
container-network
```

- Every container gets its own IP on a Docker network.
- On a **user-defined network** (`docker network create shop`), Docker runs a DNS server: containers reach each other **by container name** (`postgres://db:5432`).
- The default `bridge` network has no name resolution. Don't use it for multi-container apps.
- Containers on the same network talk to each other directly on their internal ports. **Publish (`-p`) only what must be reached from outside**; a database rarely needs `-p 5432:5432`.

## commands | Volumes and networks

```term
$ docker volume create pgdata
$ docker run -d --name db --network shop -e POSTGRES_PASSWORD=dev \
    -v pgdata:/var/lib/postgresql/data postgres:16
$ docker volume ls / docker volume inspect pgdata
$ docker network create shop
$ docker run -d --name api --network shop -e DATABASE_URL=postgres://postgres:dev@db:5432/postgres lumen/api
$ docker network inspect shop             # who is on it
$ docker network connect shop old-container
$ docker run --rm -v pgdata:/data alpine ls /data   # peek into a volume
```

```replay
title: A volume outlives its container
scenario: docker
show: docker
step: docker run -d --name db -e POSTGRES_PASSWORD=dev -v pgdata:/var/lib/postgresql/data postgres:16 | Postgres with a named volume at its data directory.
step: docker exec db psql -U postgres -c "CREATE TABLE notes (id int, body text); INSERT INTO notes VALUES (1, 'keep me')" | Write some data.
step: docker rm -f db | Remove the container entirely. The volume stays (see the panel).
step: docker run -d --name db -e POSTGRES_PASSWORD=dev -v pgdata:/var/lib/postgresql/data postgres:16 | A brand-new container, same volume.
step: docker exec db psql -U postgres -c "SELECT * FROM notes" | The data is still there.
```

## analogy | A hotel room and a safe-deposit box

A container is a hotel room: when you check out, housekeeping resets it and anything you left is gone. A named volume is a safe-deposit box in the hotel basement: you can check out, check into a different room tomorrow, and your valuables are still there. A user-defined network is the hotel's internal phone system: you dial "room service" by name instead of looking up an extension.

## team | Stateful containers

- **Every stateful container gets a named volume**, and the volume name is documented.
- **Back up volumes** like any database (e.g. `pg_dump` from a container on the same network), and test restores.
- **Production databases** often run on a managed service instead of a container; containers shine for the stateless parts.
- **`docker system prune --volumes` is a data-deletion command.** Treat it like `DROP DATABASE`.

## traps | Data and network traps

**No volume on a database container.** Fine until the first `docker rm`.

**Wrong mount path.** The data directory differs per image; a volume mounted at the wrong path persists nothing.

**`localhost` in a connection string inside a container** means that container, not the database container.

**Publishing the database port to the world** with `-p 5432:5432` on a server with a public IP.

**An AI's "free up disk space" one-liner** with `prune -a --volumes`. Read every flag.

## lab | Give the reviews database a memory

Run Postgres so its data survives the container, connect the reviews API to it by name on a user-defined network, and keep your data when disk space runs low.
