---
title: Quick start
description: From an empty dashboard to an editor in a workspace, in three steps.
group: start
order: 3
---

This assumes Lite is running and open at **http://localhost** — see [Installation](/docs/installation).

## 1. Check your SSH key

Open **Settings**. Lite lists the keys it found in `~/.ssh` and which one it hands to workers. Add
that key's public half to your git host (GitHub, GitLab, a self-hosted forge…) if it isn't there
already: it is the only credential Lite uses to clone and push.

A key protected by a passphrase shows a *passphrase* badge: unlock it there once, or forward your
host's agent — see [SSH keys and git](/docs/ssh-and-git). You can skip this step entirely for a
project with no repository.

## 2. Create a project

**Projects → New project**. Either:

- **start from a template** — Next.js, Vite + React, Astro, FastAPI, Express or Docker-in-Docker
  (base image, features and ports already filled in), or
- **fill in the form** — a name, a base image (any image works; the
  [devcontainer images](https://mcr.microsoft.com/en-us/catalog?search=devcontainers) are a good
  start, e.g. `mcr.microsoft.com/devcontainers/typescript-node:22`), and a repository by its clone
  URL, such as `git@github.com:you/app.git`.

Hooks are optional: `postCreateCommand` runs once when a workspace is created (install the
dependencies), `postStartCommand` on every start (start the dev server). Saving the project
creates **version 1** and starts building its image in the background.

## 3. Launch a workspace

On the project page, **New workspace**. Optionally pick a branch to check out; otherwise each
repository's default branch is used. The worker goes through `building` (only the first time for a
given version), `starting` (the setup script: clone, features, hooks) and `ready`.

Then:

- **Open IDE** — VS Code in the browser at `http://worker-<id>.localhost`, opened on
  `/workspace`.
- **Terminal** — the worker page's terminal tab. It survives closing the tab: come back and
  the session, and its scrollback, are still there.
- **Ports** — anything listening in the worker is at `http://worker-<id>-<port>.localhost`,
  declared or not.

When you're done, **Stop** keeps the workspace's disk for later; **Delete** removes the container
and its volume.

## What next

- Change the project and launch again: a new version means a new image, and existing workers
  offer to **update** — see [Projects](/docs/projects).
- Share one Postgres between all your projects: [Shared services](/docs/shared-services).
- Delegate a change to an agent and review it: [Agents](/docs/agents).
