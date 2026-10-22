## story | 1.4 GB and a password inside

A security review of Lumen's images found two problems in one afternoon. The payments image weighed 1.4 GB, mostly compilers and tools it never used at runtime, and the scanner listed 41 high and 3 critical vulnerabilities in packages the app did not even need. Worse, someone ran `docker history` and then simply opened the image: a `.env` file with the production database password had been copied in by `COPY . .`.

Anyone who can pull an image can read every file in it. And every package in it is attack surface you must patch. **Small, minimal, non-root images** are faster to ship and much safer.

## model | Four habits of good images

| Habit | How | Why |
|---|---|---|
| **Send less** | `.dockerignore` with `node_modules`, `.git`, `.env`, tests | smaller context, no secrets copied by `COPY . .` |
| **Smaller base** | `-slim`, `-alpine`, or **distroless** (no shell, no package manager) | fewer packages = fewer CVEs and faster pulls |
| **Multi-stage builds** | build in one stage, copy only the result into a clean final stage | compilers and dev dependencies never reach production |
| **Not root** | `USER node` / `USER nonroot` | a compromised app cannot modify the image's files or easily escape |

```term
# stage 1: everything needed to build
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# stage 2: only what runs
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER nonroot
CMD ["dist/server.js"]
```

**Image scanning** (`docker scout cves`, Trivy, Grype) compares the packages in an image with vulnerability databases. Run it in CI and decide what blocks a release (commonly: any critical, or high with a fix available).

Secrets never belong in an image: not in `COPY`, not in `ENV`, not in `ARG`. Even if a later step deletes a file, it is still inside an earlier layer.

## commands | Measuring and hardening

```term
$ docker images                          # SIZE column
$ docker history payments:1              # which layer is big?
$ docker run --rm payments:1 ls -la /app   # what got copied in?
$ docker run --rm payments:1 id          # who does it run as?
$ docker scout cves payments:1           # known vulnerabilities
$ docker scout quickview payments:1
$ cat .dockerignore
```

## analogy | Packing for a flight

You don't take your whole workshop on holiday, just the finished furniture. A multi-stage build is assembling the bookshelf at home (build stage, all the tools) and shipping only the bookshelf (final stage). The `.dockerignore` file is the list of things that must never go into the suitcase, like your house keys.

## team | Image policy

- **Base images from a short approved list**, pinned and rebuilt weekly to pick up patches.
- **Scan in CI**, fail on criticals; track exceptions with an owner and an expiry date.
- **Non-root by default**; anything needing root needs a reason in review.
- **Secrets at runtime** via environment or mounted files from the platform's secret store.

## traps | Image traps

**`RUN rm .env` after `COPY . .`.** The file is gone from the last layer but still in the one before. Keep it out with `.dockerignore`.

**`apt-get install` without cleaning up** `/var/lib/apt/lists` in the same `RUN`: 40 MB of package lists stay in the layer.

**Alpine surprises.** It uses musl instead of glibc and has no bash; most apps are fine, some native modules are not.

**Distroless has no shell**: `docker exec -it … sh` fails. That is the point. Debug with logs, or a debug variant of the image.

## lab | Shrink and harden the payments image

`~/payments` builds a 1.1 GB image that runs as root and contains a secret. Make it small, clean and non-root, and prove it with the scanner.
