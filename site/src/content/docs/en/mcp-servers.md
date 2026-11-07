---
title: MCP servers
description: Declare MCP servers once, connect them in OAuth from Settings, and give them to your projects' agent tasks through Lite's gateway.
group: agents
order: 2
---

Declare an MCP server by its URL, connect to it from **Settings**, and the sessions of your
[agent tasks](/docs/agents) — Claude Code, Codex and Mistral Vibe alike — get it without a line of
config in the repository. The session never sees the vendor's server or token: it calls Lite's
**gateway** with its task's own token, and Lite relays the call with the token it holds.

## Declaring a server

**Settings → MCP servers → Add**, with the server's URL. Lite sends it an `initialize` without a
token and works out how it authenticates:

| Auth | When |
|---|---|
| **none** | the server answers |
| **OAuth** | it answers `401` and advertises OAuth metadata |
| **header** | you gave a header (an API key) — required if the server wants a credential without advertising OAuth. Name and value are stored encrypted |

## Connecting in OAuth

**Connect** opens the vendor's consent page. The OAuth client is either registered automatically
(Dynamic Client Registration) on the first connection, or — when the vendor doesn't support it —
one you registered yourself (*“I registered a client myself”*), with the redirect URI:

```text
http://localhost/api/mcp/oauth/callback
```

(`localhost` being the origin you open Lite at.) PKCE, resource indicators and issuer checks are
done for you. **Reconnect** appears when a connection needs re-authorisation; **Disconnect**
forgets the tokens, effective on the next call.

## Per project

Each server has a **mode**, the switch on its row in Settings:

- **default** — given to the tasks of every project, unless a project turns it off;
- **optional** — given only to the projects that turn it on.

A project departs from the mode in its form's **Agents → MCP servers**. This is outside the
versioned config: no new version, no rebuild — it applies to the next session.

## In the session

At every session start (first turn and every resume), the session receives the list of its
project's servers, each as a path on Lite's gateway, and a fresh token scoped to the task. The
runner turns that into the harness's own MCP configuration. A server whose OAuth connection isn't
valid is left out: a session without the tool is better than one with a broken tool.

The gateway refuses a token whose project has the server turned off.
