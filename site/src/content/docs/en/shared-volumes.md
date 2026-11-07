---
title: Shared volumes
description: Mount a package cache, a dataset or build artifacts in every workspace of a project — and what that does and doesn't guarantee.
group: use
order: 6
---

Each worker gets its own `mp-worker-<id>-workspace` volume on `/workspace`. Two workers of the same
project therefore download their dependencies and regenerate their artifacts separately. A project
can declare **shared volumes** to stop that.

## Declaring one

In the project form, **Runtime → Shared volumes**: a name and a mount path, for example:

| Name | Mount path |
|---|---|
| `pnpm-store` | `/home/vscode/.local/share/pnpm/store` |
| `m2` | `/home/vscode/.m2` |
| `datasets` | `/data` |

## What you get

- A named Docker volume, `mp-proj-<projectId>-<name>`, **created on demand** by the first worker that
  needs it and reused by every later one.
- Mounted in **every** worker of the project, alongside its private `/workspace`.
- It **survives** deleting a worker and rebuilding one. It is destroyed **only with the project**,
  behind an explicit confirmation in the delete dialog.
- Visible on the **Resources** page as `shared`, with its owning project, its size and how many
  workspaces mount it.
- The declaration is part of the project's version: restoring a version and exporting or importing
  a project carry it. Only the declaration travels in an export — never the data.

## Refused mount points

`/workspace` and anything under it are refused — they would shadow the worker's own volume and
break the setup's idempotent clone. So are `/var/lib/docker`, `/var/lib/containerd` and the kernel
filesystems.

## Concurrency is not managed

> Several workers write into the same volume at the same time and **nothing locks**. That is fine
> for what this is for — package caches, datasets, fixtures, build artifacts, read-mostly data. It
> is *not* a place for a shared SQLite database, a lockfile two processes rewrite, or anything that
> needs a single writer. For a database, use a [shared service](/docs/shared-services).
