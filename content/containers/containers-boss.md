## brief | Containerise tickets

Lumen's **tickets** service still runs the old way: `node server.js` started by hand on `app2`, talking to a Postgres the team installed directly on the server. You are moving it to containers end to end:

1. A **production-grade image**: small, non-root, cache-friendly, no secrets, scanned with no critical vulnerabilities.
2. A **compose stack**: the API plus Postgres with a healthcheck and a named volume; only the API is published.
3. **Shipped through the registry** with a version tag, and running on `app2` from that tag.
4. Proven: the API answers, data survives a full `down` and `up`.

## recap | What the Containers realm gave you

- Images vs containers, the writable layer, exit codes, logs and `exec` for debugging.
- Dockerfiles with cache-friendly order, exec-form `CMD`, `0.0.0.0` binding.
- Small, safe images: `.dockerignore`, slim and distroless bases, multi-stage builds, non-root users, scanning.
- Named volumes for data, user-defined networks for name resolution, publishing only what must be public.
- Compose stacks with healthchecks, `.env` configuration and the `down -v` trap.
- Registries: tags vs digests, `--password-stdin`, immutable versions.

## lab | Ship tickets in a container

Code is in `~/tickets` on your laptop. The registry is `registry.lumen.dev` (user `ci`, token in `~/registry-token.txt`). `app2` already has Docker installed; you can SSH to it as `ubuntu`.
