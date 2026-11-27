---
title: Connect to Spunto
description: Reach your Lite's agent tasks from your phone — the Spunto Lite iPhone app — through your Spunto account, without opening a port.
group: agents
order: 3
---

Lite runs on your machine, behind your router, with no login screen. **Connect to Spunto** makes its
agent tasks reachable from the devices where you are signed in to [Spunto](https://spunto.net) —
first of all the **Spunto Lite** iPhone app — without opening a port or exposing Lite:

- Lite opens a tunnel **to** Spunto (outgoing, like a browser tab);
- Spunto relays to it a short list of task requests from your devices, and keeps nothing of what
  passes;
- Lite checks each request again, and answers only what you allowed.

It is **off until you connect it**.

## Connecting

1. **Settings → Connect to Spunto.** Optionally give the machine a name (what your phone will list
   it as); the Spunto URL stays `https://spunto.net`.
2. Tick **what your devices may do** (below). Only *Read* is ticked at first.
3. **Connect to Spunto**: you land on Spunto's consent page (sign in if needed), which presents the
   app as a *Spunto Lite*. **Allow** brings you back to Settings, connected.

The status then reads **Online**, with the connection's id. If the tunnel drops (Wi-Fi, a Spunto
update), Lite reconnects on its own, waiting a little longer each time, up to 30 seconds.

Open Lite at `http://localhost` (the default) or over `https://` to connect: Spunto only sends you
back to an address it can trust, and plain `http://` is accepted on `localhost` only.

## What your devices may do

| | What it allows |
|---|---|
| **Read** | list projects and tasks, read a conversation, its diff and attachments |
| **Reply** | answer a task, interrupt it, Accept or Drop it |
| **Create tasks** | delegate a new task to a project |

**Create tasks** starts an agent on this machine, from your phone, with your SSH key and your
secrets — tick it only if that is what you want.

A change applies at once: the tunnel reconnects with the new list. Whatever is ticked, **secrets,
settings (where your SSH key is), workers, terminals and services are never reachable** this way.

## Notifications

When a task hands back (**In review**) or **fails**, Lite tells Spunto — the task's title and the
first words of the agent's last message — so your phone can notify you. Nothing is sent while Lite
is offline, and dropping a task yourself sends nothing.

## Disconnecting

- **Disconnect** in Settings forgets the tokens and closes the tunnel. Spunto keeps listing the
  machine, offline, until you remove it there.
- Removing it in Spunto (**Account Settings → Connected apps**) closes the tunnel at once; Lite then
  shows *Disconnected* and does not try again until you connect it anew.
- If Spunto stops accepting Lite's credentials (unused for 30 days, for instance), Lite shows
  *Disconnected* with the reason: connect again.

Lite's tokens are stored encrypted in its database, never in its logs. The technical side — the
tunnel's protocol, the routes relayed — is in the repository's
[`docs/lite-connect.md`](https://github.com/spuntodotnet/spunto-lite/blob/main/docs/lite-connect.md).
