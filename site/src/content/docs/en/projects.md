---
title: Projects
description: The spec a workspace is built from — image, features, extensions, repositories, hooks, ports — and how versions, templates and export work.
group: use
order: 1
---

A **project** describes an environment, in the vocabulary of the
[devcontainer spec](https://containers.dev): what to build, what to clone, what to run. Every
worker of the project is built from it. The form is split into pages — the same pages as in Spunto
Cloud:

| Page | Holds |
|---|---|
| **General** | name and description, base image, repositories |
| **Tooling** | devcontainer features, VS Code extensions |
| **Lifecycle** | `postCreateCommand`, `postStartCommand` |
| **Runtime** | named ports, Docker inside the workspace, shared volumes |
| **Agents** | how delegated tasks run, and the MCP servers they get |
| **Secrets** | the project's secrets |

## Base image

Any image Docker can pull: a [devcontainer image](https://github.com/devcontainers/images), an
official language image, or your own. The workspace image is your base image plus two
devcontainer features Lite always adds first —
[`common-utils`](https://github.com/devcontainers/features/tree/main/src/common-utils) (a
`vscode` user, a shell, the basics) and
[`spunto-pack`](https://github.com/coderhammer/features/tree/main/src/spunto-pack) (code-server,
dtach, the agent) — then the features you declare.

Images from a **private Google Artifact Registry or GCR** pull with a service-account key set in
**Settings → Container registry** (role `roles/artifactregistry.reader`). Other private
registries need the host's Docker to be logged in.

## Features and extensions

**Features** are devcontainer features picked from a catalogue (Node, Python, Go, Docker-in-Docker,
the GitHub CLI…), each with its options and an optional version. They are installed into the image,
in order, at build time.

**Extensions** are VS Code extension ids (`dbaeumer.vscode-eslint`), searched on
[Open VSX](https://open-vsx.org) by default and pre-installed in the image. To use another gallery,
see [Configuration](/docs/configuration#extension-gallery).

## Repositories

A repository is a **clone URL**, exactly as `git clone` takes it — SSH
(`git@gitlab.example.com:team/app.git`) or HTTPS — plus where to clone it under `/workspace`.
There is no forge integration: no app to install, no token to mint. Whatever your SSH key reaches
works the same way — see [SSH keys and git](/docs/ssh-and-git).

A project can have several repositories, or none: a workspace without one is just an environment.

## Lifecycle hooks

| Hook | Runs |
|---|---|
| `postCreateCommand` | once, when the workspace is created — and again on a rebuild |
| `postStartCommand` | every time the workspace starts |

Both run as the `vscode` user, in the workspace, with the project's secrets and the shared
services' addresses in the environment. Their output is the worker's **setup** log; a failing hook
puts the worker in `error` with the step it stopped at.

## Ports

Every port that listens in a worker is reachable at `http://worker-<id>-<port>.localhost` without
being declared. Declaring one under **Runtime → Ports** gives it a **label** (`Web app`) and a
**landing path** (`/dashboard`), used by the links Lite shows — on a task's Machine panel, a
declared port is green while something listens on it and greyed out while nothing does.

## Docker inside the workspace

Add the **Docker-in-Docker** feature (Tooling → Features; the template of the same name starts with
it) and `docker compose up` works inside a workspace, isolated from your host's daemon. The feature
declares itself `privileged` in its metadata, so its workers run as privileged containers with their
own Docker storage, and it waits for its daemon before your `postCreateCommand` and
`postStartCommand` run.

Any feature that declares `"privileged": true` gets the same treatment. An image that ships Docker
on its own, without the feature, gets neither: its container isn't privileged and nothing waits for
its daemon — add the feature instead.

## Shared volumes

Volumes mounted in **every** worker of the project, on top of each one's private `/workspace` — a
package cache, a dataset. See [Shared volumes](/docs/shared-volumes).

## Versions

Saving a change to anything that goes into the image (image, features, extensions, repositories,
hooks, agent harnesses…) creates a **new version** and builds its image in the background, so the
next launch is warm. Names, descriptions and port labels don't.

- Existing workers keep running on the version they were built from; their card offers
  **Update to vN**, which recreates the container on the new config and **keeps `/workspace`** —
  files and uncommitted work included.
- The project page lists past versions; **Restore** makes an old one current again (as a new
  version).
- An image build's log opens from the project page, and tails the build while it runs.

## Templates

**New project → From a template** pre-fills the form for Next.js, Vite + React, Astro, FastAPI,
Express and Docker-in-Docker. Nothing ties the project to its template afterwards.

## Export and import

**Export** on a project downloads its spec as JSON (`GET /api/projects/:id/export`). **Import** on
the dashboard, or in the new-project form, pre-fills the form from such a file. Secret **values**
are never exported — only their names, so the form lays out the rows to fill in.

The format is the one Spunto Cloud shares (`@spunto/build`'s portable project format), so a
project moves between Lite and Cloud by exporting it from one and importing it into the other.

## Deleting a project

Deleting a project removes its workers, its images and its shared volumes, behind an explicit
confirmation — the shared volumes hold data no rebuild brings back.
