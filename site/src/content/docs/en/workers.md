---
title: Workers
description: The life of a workspace — its states, its IDE and terminal, its ports and URLs, and what stop, rebuild, update and delete keep.
group: use
order: 2
---

A **worker** (a *workspace* in the dashboard) is a Docker container built from a project, with its
own `/workspace` volume, its own network, an IDE and terminals. It is meant to be disposable:
launch one per branch, per experiment, per agent, and delete it when you're done.

## Launching one

**New workspace** on the project page. You can name it and pick a **branch** to check out in every
repository; otherwise each repository's default branch is used. The branch is remembered, so a
rebuild checks out the same one.

## States

| State | Means |
|---|---|
| `provisioning` | the row exists, nothing has started yet |
| `building` | the project's image is being built (only once per version — later workers reuse it) |
| `starting` | the container is up and the setup runs: clone, features, `postCreateCommand`, `postStartCommand` |
| `ready` | setup done — the IDE and the terminal are available |
| `stopped` | stopped by you; the disk is kept |
| `error` | the setup failed (the worker page says at which step), or the container died on its own (with the exit code or the daemon's message) |

The state is read from Docker and from the setup's status file on every look, so it can't drift
from reality.

## The IDE

**Open IDE** opens code-server — VS Code in the browser — at `http://worker-<id>.localhost`, on
`/workspace`, with the project's extensions installed. It is branded *Spunto*, with a *Spunto
Light* theme by default and *Spunto Dark* available; a `settings.json` you already have in the
workspace is never overwritten.

## The terminal

The worker page's **Terminal** tab gives you persistent shells, in tabs. Persistence comes from
dtach rather than a multiplexer:

- closing the browser tab doesn't kill what runs in it — a build, a dev server, a REPL;
- coming back re-attaches to the same session and replays the end of its output;
- because the browser does the drawing, the mouse wheel scrolls history, text selection and search
  work as in any web page.

Sessions are listed and closed from the tab strip. They are the same sessions a task's Terminal
tab shows.

## URLs

| What | URL |
|---|---|
| IDE | `http://worker-<id>.localhost` |
| a port | `http://worker-<id>-<port>.localhost` — any port that listens, declared or not |
| a shared service | `http://svc-<slug>.localhost` |

`localhost` is whatever `BASE_DOMAIN` says — see [Configuration](/docs/configuration). Inside the
worker, `WORKER_SLUG` and `BASE_DOMAIN` are set, so an app can build its own public URL.

## Stop, start, rebuild, update, delete

| Action | What happens | `/workspace` |
|---|---|---|
| **Stop** | the container stops | kept |
| **Start** | it starts again; `postStartCommand` runs | kept |
| **Rebuild** | the container is recreated on the same version; `postCreateCommand` runs again | kept |
| **Update to vN** | recreated on the project's latest version | kept |
| **Delete** | container, network and volume removed | **gone** |

Files outside `/workspace` (and outside the project's shared volumes) live in the container and
don't survive a rebuild or an update — install tools through features or hooks, not by hand.

## Watching a worker

The worker page shows the **setup** steps as they run, the container's **logs**, live **CPU and
memory** (with a short history), and the git status of each repository. The **Resources** page
lists every container, image and volume Lite owns, with its size — the place to see what is taking
the disk.

## Tags

Workers can carry tags. Lite uses one itself: `task` marks the workers that make up a project's
pool for [agent tasks](/docs/agents). A worker without it is yours, and a task never takes it.

## Environment of a worker

Every worker gets, as environment variables:

- the global [secrets](/docs/secrets), then the project's (a project secret wins over a global one
  of the same name);
- `SPUNTO_SVC_<SLUG>`, `_HOST` and `_PORT` for each [shared service](/docs/shared-services);
- `SSH_AUTH_SOCK`, pointing at the SSH agent socket Lite serves;
- `WORKER_SLUG` and `BASE_DOMAIN`.

They are set when the container is created: a secret added later reaches a worker after a
**Rebuild**.
