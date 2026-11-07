---
title: Security
description: What Spunto Lite trusts, what it protects, and why it must never face the open internet.
group: operate
order: 2
---

Lite is a **single-user tool for your own machine**. Its security model follows from that, and
it is worth knowing before you expose it to anything else.

## There is no login screen

Anyone who can reach Lite's port controls it — and Lite holds your **Docker socket**. Access to
the Docker socket is, in practice, root on the host: a container can be started with the host's
filesystem mounted.

So:

- **Keep it on `localhost`**, which is what the default `-p 80:80` on a laptop amounts to behind a
  normal firewall.
- On a **network you trust** (your home LAN, a VPN like Tailscale or WireGuard), it is your call.
- **Never on the open internet**, not even “just for a minute”, and not behind a port forward.
  If you need it remotely, put it behind a VPN, or an authenticating proxy you control.

Spunto Cloud is the version with accounts, roles and authentication in front of every workspace.

## What a workspace can do

A worker is a container on your Docker daemon, with:

- **its own network** (`mp-worker-<id>-net`), and its own ports, filesystem and clone;
- the **shared network**, on which every [shared service](/docs/shared-services) and every worker
  sits — a workspace reaches your shared Postgres by design, and can reach another worker by its
  `worker-<id>` name too. Workspaces are isolated from each other's *files*, not from each other's
  network;
- your **SSH key** (copied in) or, for a passphrase-protected key, the **agent socket**, which signs
  for as long as the key is unlocked. Code in a worker can push wherever your key can.
- the **secrets** of its project and the global ones, in its environment.

Docker-in-Docker, when a project turns it on, runs a **privileged** container.

## Agents

An agent runs with everything its worker has: your SSH key, your secrets, the network. Lite keeps
the parts it can out of its reach — **MCP tokens** stay in Lite, the worker only gets a token for
Lite's gateway, scoped to its task — but it can't make an agent harmless. Before delegating to an
agent whose output you don't trust:

- give the project only the secrets the task needs;
- use a deploy key with write access to that repository only, rather than your personal key;
- **lock** a passphrase-protected key in Settings when you don't need it unlocked.

## What is stored, and how

- **Secrets** — encrypted with AES-256-GCM under `DATA_ENCRYPTION_KEY`; set a real one.
- **A passphrase** — never stored: the decrypted key lives only in the memory of Lite's own
  `ssh-agent`, until it is locked or Lite restarts.
- **MCP connections** — OAuth tokens and header values encrypted in the database.
- **Your `~/.ssh`** — mounted read-only.

## Telemetry

None. Lite doesn't phone home. The only outbound traffic is what you cause: pulling images and
features, the extension gallery, your git remotes, your agents' providers and your MCP servers.

## Reporting a vulnerability

Please report it privately, through
[GitHub's security advisories](https://github.com/spuntodotnet/spunto-lite/security/advisories/new)
for the repository, rather than in a public issue.
