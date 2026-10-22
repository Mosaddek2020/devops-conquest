## story | Which "latest" is running?

Lumen's events service ran `lumen/events:latest` on three servers. A bug report came in for production only. Staging was fine. Both claimed to run "latest", but production had pulled it on Monday and staging on Thursday, after two more pushes. Nobody could say which code production was actually running, and rolling back meant guessing which image "the previous latest" had been.

A **tag is a movable label**. `latest` is just the default tag name, and it moves every time someone pushes. To know what runs where, deploy **immutable version tags** (or the image **digest**), and let the registry keep every version for rollbacks.

## model | Names, tags and digests

```term
registry.lumen.dev/team/events:1.4.2
└──── registry ───┘└ repository ┘└tag┘

registry.lumen.dev/team/events@sha256:9f86d081884c7d65…
                               └──── digest: the exact bytes ────┘
```

```diagram
registry-flow
```

- With no registry in the name, Docker assumes **Docker Hub** (`docker.io`), and with no tag, it assumes **`:latest`**.
- `docker tag` adds another name to an existing image; no copy is made.
- A useful tagging scheme: the **version** (`1.4.2`) plus the **git commit** (`sha-3f9c2e1`). CI produces both; humans deploy the version, and the commit answers "what code is this?".
- Private registries need `docker login`. Give the password on **stdin** (`--password-stdin`), never as `-p` on the command line, where it ends up in shell history and process lists.
- In CI, the registry credentials are a **secret** (or, better, short-lived tokens via OIDC).

## commands | Ship an image

```term
$ docker build -t events:1.4.2 .
$ docker tag events:1.4.2 registry.lumen.dev/team/events:1.4.2
$ docker tag events:1.4.2 registry.lumen.dev/team/events:sha-$(git rev-parse --short HEAD)
$ echo "$REGISTRY_TOKEN" | docker login registry.lumen.dev -u ci --password-stdin
$ docker push registry.lumen.dev/team/events:1.4.2
$ docker pull registry.lumen.dev/team/events:1.4.2       # on the server
$ docker inspect --format '{{.Id}}' registry.lumen.dev/team/events:1.4.2
```

## analogy | A library's shelf mark

"The newest cookbook" changes every month; "shelf 641.5 copy 3" always means one physical book. `latest` is "the newest cookbook". A version tag is the shelf mark. A digest is the book's ISBN plus its serial number: it can only ever be that one copy.

## team | Registry practice

- **CI builds and pushes**; servers only pull. Nobody pushes from a laptop.
- **Immutable tags**: never re-push a version tag with different content (many registries can enforce this).
- **Retention policy**: keep enough old versions to roll back, delete the rest automatically.
- **Pull by digest in production** when you want to be certain the bytes cannot change underneath you.

## traps | Tag traps

**Deploying `:latest`.** You can't tell what is running, and `docker pull` on two days gives two different apps.

**`docker login -p hunter2`** in a script or terminal: the password lands in history and `ps`.

**Forgetting the registry prefix**: `docker push events:1.4.2` tries Docker Hub's official namespace and is denied.

**Rebuilding "the same version"** later and pushing it under the old tag: the bytes changed but the name did not.

## lab | From laptop to server through a registry

Build the events service, tag it properly, push it to Lumen's private registry and run that exact version on the app server.
