---
title: Introduction
description: What Spunto Lite is, what it runs on, and how these docs are organised.
group: start
order: 1
---

**Spunto Lite** is a local control plane for development environments. It is one container that
talks to your machine's Docker daemon: you describe a **project** once — a base image,
devcontainer features, the repositories to clone, ports, lifecycle hooks, secrets — and launch
disposable **workers** from it. Each worker is a Docker container with **VS Code in the browser**
(code-server) on its own subdomain, a **persistent terminal**, and your **own SSH key** so that
`git clone` and `git push` just work.

On top of that, Lite can hand a worker to a **coding agent** — Claude Code, Codex or Mistral Vibe —
and let you review what it did before you accept it.

It is the *Build* pillar of [Spunto](https://spunto.net), collapsed onto a single machine. It is
released under the MIT license, and the image is public on GitHub Container Registry.

## What you need

- **Docker** — Docker Desktop on macOS or Windows, Docker Engine on Linux — with its socket at
  `/var/run/docker.sock`.
- **Port 80 free** on the host. Another port works too, at the cost of a `:port` in every URL.
- A browser. `*.localhost` resolves to `127.0.0.1` on its own in Chrome, Edge and Firefox, so
  there is no DNS to set up.
- Optionally, an SSH key in `~/.ssh` that your git host accepts.

The image is published for `linux/amd64` and `linux/arm64` (Apple Silicon included).

## The vocabulary

| Word | Means |
|---|---|
| **Project** | A devcontainer-style spec: base image, features, extensions, repositories, ports, hooks, secrets. Versioned. |
| **Worker** | A container built from a project: a private `/workspace` volume, code-server, terminals. Disposable. |
| **Image build** | The project's image, built once per version and reused by every worker of that version. |
| **Service** | A long-lived shared container (Postgres, Redis…) that every worker reaches by name. |
| **Secret** | An encrypted value injected as an environment variable — global, or per project. |
| **Task** | Work delegated to an agent, in a worker of the project's pool, that ends in a review. |

## How it works, in one paragraph

A single Next.js process serves the dashboard and reverse-proxies the workers' subdomains. It
drives Docker through the socket for the workers' **lifecycle** only — create, start, stop,
remove, build. Inside each worker runs a small **agent** (the same one a Spunto Cloud sandbox
runs) that dials back to Lite over a WebSocket and carries everything else: commands, terminals,
listening ports, the progress of the setup. Projects, workers and secrets live in **SQLite**, in
one Docker volume. Nothing leaves your machine.

## Where to go next

- [Installation](/docs/installation) — run it, with `docker run` or compose.
- [Quick start](/docs/quick-start) — from an empty dashboard to an editor in three minutes.
- [Agents](/docs/agents) — delegate a task to Claude Code, Codex or Mistral Vibe.
- [Security](/docs/security) — read this before exposing Lite to anything but `localhost`.
