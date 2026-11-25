---
title: Changelog
description: What changed in Spunto Lite, week by week — what you can now do, see, or no longer put up with.
group: operate
order: 4
---

What changed in Lite, newest first. Everything listed here is in the `latest` image from the day
it is dated: to get it, [upgrade](/docs/installation#upgrade) — same volumes, same key, nothing to
migrate by hand.

## 2026-11-25

**The agent can ask you, and its subagents get their own block**

### New

- **Questions from the agent.** When Claude Code asks a multiple-choice question, it appears in the
  conversation as options to click, and the task shows **Asks you** in the lists. Answer in a
  click, write your own answer, or simply reply. [Details](/docs/agents#when-the-agent-asks-you)

### Improved

- **Subagents** started by Claude are grouped under their call, one row each, and open on a click.
  Their messages no longer look like the agent's, and the context shown is the session's own.
- **Context compaction** is a discreet marker instead of a long message, and a loaded **skill**
  sits under the call that loaded it.
- **Images in a conversation** keep their place while they load: the timeline no longer jumps.

### Removed

- **Tasks delegated before agent apps** (from before 2026-11, on Claude Code's CLI) can still be
  read, but no longer be resumed: delegate them again.

## 2026-11-21

**On hold, project tags, and Lite without the IDE**

### New

- **On hold.** A review that can wait goes **On hold**, from the task's header or its row: its
  machine is parked and the task leaves the default list for the **On hold** view, with its count.
  Reply, **Wake**, Accept or Drop bring it back; **Back to review** returns it without waking the
  machine. [Details](/docs/agents#on-hold-for-later)
- **Project tags.** Add tags next to a project's name; the Projects table shows them under each
  name, filters on them (every chosen tag must be there), and the search reads them. Setting a tag
  makes no version and rebuilds nothing. By the API: `PUT /api/projects/:id/tags`.
  [Details](/docs/projects#tags)
- **A project without Spunto IDE.** Switch **Spunto IDE** off under the project's extensions: its
  image is built without the editor, **Open IDE** disappears everywhere, and the terminal stays.
  It is part of the image, so changing it makes a new version. [Details](/docs/workers#the-ide)

### Improved

- **Opening a port of a stopped worker** now shows **Workspace is stopped** with a **Start
  workspace** button, then reloads the page you asked for once it is up — instead of “Not
  reachable”. Pages also say when a workspace is still starting, when nothing listens on the port
  (with **Retry**), or when there is no such workspace.

### Fixed

- **Usage no longer freezes Lite.** On a long history, opening **Usage** used to block the whole
  dashboard for seconds. The report is now computed in the background: the page says *Computing
  usage…*, you can leave it, and everything else keeps answering.

## 2026-11-12

**A page for what your agents consumed, and failed tasks that pick up again**

### New

- **Usage** in the sidebar: cost, turns, context sent (and how much was read from cache), tokens
  generated and tool calls over 1, 7, 30 or 90 days or all time; per day, per task (each row leads
  to its conversation), per project, agent and model, and per tool with its errors. Agents that
  report no cost (Codex) show their tokens, and “—” rather than a guessed price.
- **Claude Fable 5.2** in Claude Code's models. It replaces Fable 5.1: a project whose default
  model is Fable 5.1 must pick another before it can be saved; tasks already created keep theirs.
- **Opt-in telemetry**, off by default and with no destination by default: point
  `TELEMETRY_OTLP_ENDPOINT` at your own OTLP collector to receive starts, heartbeats, page views
  and actions — never names, query strings, request bodies or IPs. [Details](/docs/security#telemetry)

### Improved

- **Reply to a failed task** and it picks up again, back in review, with its conversation resumed
  — even if its worker has since gone to another task (both share it). When it can't (worker
  deleted, setup failed, no session), the task says why.
- **Docker inside the workspace comes from the feature.** There is no Docker-in-Docker switch any
  more: listing the `docker-in-docker` feature gives the workspace what it needs, as the
  devcontainer spec says. Projects that had the switch on received the feature on upgrade, with no
  new version and no rebuild. [Details](/docs/projects#docker-inside-the-workspace)

### Fixed

- **Stop then start a worker** and its `postStartCommand` runs again; it used to be skipped.
- **Resources loads in a moment**, even with large Docker volumes: lists are live, CPU and memory
  are refreshed every 15 s, and volume sizes every 10 minutes or on **Measure now**, kept across a
  restart.

## 2026-11-07

**Everything Spunto Cloud shipped in early November, locally**

### New

- **Mistral Vibe**, a third agent next to Claude Code and Codex (`MISTRAL_API_KEY`).
- **The agent's message appears as it writes it.**
- **Tasks without git.** Lite no longer creates a branch, and a task no longer needs a repository:
  the agent makes a branch if it wants one. [Details](/docs/agents#no-git-imposed)
- **In a task's details**: a **Monitoring** block (live CPU and memory, history from 1 hour to 7
  days), the links and files of the conversation with the pull requests among them, the Claude Code
  session (quota, MCP servers, skills, cost per model), and links and metadata set by whoever
  delegated it (`?metadata[k]=v` to filter tasks).
- **Named ports** (a label and a path) in the project form, green on the Machine panel when they
  listen.
- **The dashboard's colour** in **Settings → Appearance**. [Details](/docs/configuration#in-the-dashboard)

### Improved

- **Projects** is a sortable table, favourites first, with a search and shortcuts to a workspace or
  a task.
- **Park after N minutes** and **Keep awake** during a review; the countdown survives a restart of
  Lite. [Details](/docs/agents#during-review-keep-or-park)
