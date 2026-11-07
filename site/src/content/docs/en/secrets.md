---
title: Secrets
description: Global and per-project secrets, how they are encrypted, and how they reach a workspace.
group: use
order: 4
---

A secret is a name and a value — an API key, a database password, a token — that lands in a
workspace as an **environment variable**. Values are write-only: once saved, the dashboard shows
the name, never the value again.

## Two scopes

| Scope | Where | Reaches |
|---|---|---|
| **Global** | **Secrets** in the sidebar | every worker of every project |
| **Project** | the project form's **Secrets** page | that project's workers |

When both define the same name, **the project's wins**. Adding a secret under an existing name
replaces its value.

## When they are read

Secrets are injected when a worker's container is **created**. A secret added or changed later
reaches an existing worker after a **Rebuild** (its `/workspace` is kept), and every new worker
right away. They are in the environment of everything that runs in the worker: the lifecycle
hooks, the terminals, the IDE, an agent's session.

## Encryption

Values are encrypted at rest with **AES-256-GCM**, under the key in `DATA_ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

Set it before storing anything, and keep it: recreating the container with another key makes the
stored secrets unreadable. Without it, Lite uses a built-in development key — fine for a try,
not for real credentials.

## Secrets in shared services

A [shared service](/docs/shared-services)'s environment variable is either a literal value or a
**reference to a global secret** by name — decrypted only when the service's container is created.
Put a real password in a global secret and reference it, rather than typing it into the service.
A reference to a secret that no longer exists is dropped with a warning instead of being injected
empty.

## Secrets and agents

A coding agent reads its provider's key from an ordinary secret — `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` (or `CODEX_API_KEY`), `MISTRAL_API_KEY` — global or per project. See
[Agents](/docs/agents).

## In an export

[Exporting a project](/docs/projects#export-and-import) carries its secrets' **names only**. The
import lays out the rows so you can fill the values in again.
