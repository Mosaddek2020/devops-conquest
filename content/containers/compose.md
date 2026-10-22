## story | The 14-step README

Lumen's onboarding doc for the shop had 14 steps: create a network, create two volumes, run Postgres with five flags, wait, run Redis, build the API, run it with seven environment variables… New developers spent their first afternoon on it, and half of them got one flag wrong.

**Docker Compose** replaces all of that with one file, `compose.yaml`, and one command: `docker compose up -d`. The file is versioned with the code, reviewed in pull requests, and it *is* the documentation of how the pieces fit together.

## model | A stack in one file

```term
services:
  api:
    build: .                      # build from ./Dockerfile
    ports:
      - "8080:3000"               # only the API is published
    env_file: .env                # configuration (not committed)
    environment:
      DATABASE_URL: postgres://shop:${DB_PASSWORD}@db:5432/shop
      REDIS_URL: redis://cache:6379
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    restart: unless-stopped
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shop"]
      interval: 5s
  cache:
    image: redis:7-alpine
volumes:
  pgdata:
```

```diagram
compose
```

- Compose creates a **network per project** (`<folder>_default`), so services reach each other by **service name**.
- Named volumes are prefixed with the project name (`shop_pgdata`).
- `depends_on` orders startup. With `condition: service_healthy`, the API waits until the database's **healthcheck** passes, not just until its container exists.
- `${VAR}` is filled from your shell or from a `.env` file next to `compose.yaml`.
- `up -d` is **declarative**: run it again after editing the file and Compose changes only what differs.

## commands | Compose

```term
$ docker compose up -d               # create/update everything, in the background
$ docker compose up -d --build       # rebuild images first
$ docker compose ps                  # services and health
$ docker compose logs api            # one service's logs (--tail 50, -f)
$ docker compose exec db psql -U shop
$ docker compose restart api
$ docker compose down                # remove containers + network, KEEP volumes
$ docker compose down -v             # ALSO delete volumes = delete data
$ docker compose config              # the merged, interpolated file
```

## analogy | A band's stage plot

A touring band sends every venue a stage plot: where the drums go, which amp plugs into which channel, who needs a monitor. The crew sets the stage the same way in every city without phoning the band. `compose.yaml` is the stage plot for your services.

## team | Compose in practice

- **Compose for local development and small single-server deployments**; Kubernetes or a platform when you need many servers.
- **`.env` is in `.gitignore`**; commit a `.env.example` with the variable names.
- **Healthchecks on every dependency** so startup order is real, not hopeful.
- **Same images in dev and prod**, different configuration.

## traps | Compose traps

**`depends_on` without a healthcheck** only waits for the container to *start*, not for Postgres to accept connections.

**`down -v` "to start fresh"** deletes the database volume.

**Published database ports** copied from a tutorial (`5432:5432`) into a server's compose file.

**Hard-coded passwords in `compose.yaml`** committed to git. Use `${VAR}` and an uncommitted `.env`.

## lab | One command for the whole shop

Turn the shop's 14-step README into a `compose.yaml`: API, Postgres with a healthcheck and a volume, and Redis. Then bring it up, restart it, and keep the data.
