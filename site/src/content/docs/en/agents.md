---
title: Agent tasks
description: Delegate work to Claude Code, Codex or Mistral Vibe in a disposable workspace, watch it live, review the diff, then accept or drop it.
group: agents
order: 1
---

A **task** is a unit of work handed to a coding agent — “fix the login that breaks on Safari”. It
gets a worker from the project's pool and an agent session in it, and it ends in something for
you to review. It is the *Agents* feature of Spunto Cloud, on your own machine: same model, same
states, same screens.

## Before the first task

A project needs two things:

1. **An agent app switched on**, in the project form's **Agents → Delegated work → Harness**. A new
   project starts with Claude Code. Several can be on; the first is the default, **Make default**
   promotes another.
2. **The app's key, as a [secret](/docs/secrets)** — global or on the project:

| App | Runs on | Secret |
|---|---|---|
| **Claude Code** | the official Claude Agent SDK | `ANTHROPIC_API_KEY` |
| **Codex** | the official Codex SDK | `OPENAI_API_KEY` or `CODEX_API_KEY` |
| **Mistral Vibe** | `vibe-acp`, driven over ACP | `MISTRAL_API_KEY` |

That's all — **a repository is not required**. Without one, the session runs in `/workspace`;
with one, in the first repository, cloned with your SSH key.

Each app switched on adds its SDK to the project's image (a private Node under
`/opt/spunto/agents`, plus the CLI on the `PATH` for you in the terminal). Changing the list is
therefore a new version and a rebuild, like changing a feature.

## Delegating

**New task** on a project, or **Agents → New** in the sidebar. Write what you want, then pick:

- the **harness** (one of the project's apps), its **model**, and the parameters that app declares
  — *effort* for Claude Code, *reasoning effort* and *web search* for Codex;
- optionally a **base branch**: the branch the worker clones, and the one a recycled machine is
  reset onto. Empty means the repository's default branch.

You can attach files to the message; they are dropped into the worker.

## Watching and steering

The task's page has three tabs:

- **Session** — the conversation, with the agent's reply appearing as it is written, its tool
  calls, and a reply box: **answer** it, or **interrupt** the turn without killing the session.
- **Diff** — what changed, read with git in the machine itself, against the merge-base of the base
  branch, whatever branch the agent made.
- **Terminal** — a shell in the task's machine, on the checkout as the agent left it. These are the
  same persistent sessions as the worker page's; the agent's own session is never one of them.

The details column holds the facts about the task: the machine (its page, its named ports, Park /
Wake), the session's numbers (context, tokens, cost, turns), what Claude Code reports about itself
(plan quota, MCP servers, skills…), the pull requests and links shared in the conversation, the
prompt, and CPU / memory history.

The **Agents** page lists every conversation of every project, grouped by what needs you.

## States

| State | Means |
|---|---|
| `queued` | waiting for its machine — allocation, image build, start, reset of a recycled machine |
| `running` | the agent's session is working |
| `in-review` | it handed back cleanly: there is something to judge |
| `done` | accepted — **only** by a click |
| `failed` | the session died badly, no machine could be had, or the task was dropped |

A turn that ends with work still running in the background (a background command, a subagent) is
not a hand-back: the task stays `running` until the session really hands back. If the session's
process dies after a finished turn, the task stays in review and a reply resumes the conversation.

## Accept and Drop

- **Accept** runs the project's **accept command**, if it has one, in the task's worker — for
  example `git push origin "$(git branch --show-current)"`, or a script that opens a pull request.
  Exit code 0 ⇒ `done`. No command ⇒ Accept just closes the task.
- **Drop** kills the session, runs the project's **drop command** if there is one (cleanup), and
  marks the task `failed` (“Cancelled”).

Both commands get `SPUNTO_TASK_ID`, `SPUNTO_TASK_TITLE`, `SPUNTO_TASK_BASE_BRANCH`,
`SPUNTO_TASK_STATE`, `SPUNTO_TASK_MODEL`, `SPUNTO_TASK_METADATA` / `SPUNTO_TASK_LINKS` (JSON, when
set), and the project's secrets **as they are now**.

## No git imposed

Lite doesn't cut a branch for a task. The session starts on the checkout as the worker cloned it;
the agent creates a branch if it wants one, and names it. What Lite does tell it is a fact: this
worker goes to another task once this one is accepted or dropped, and its checkout is reset then —
anything worth keeping has to leave it before that (for code: commit it on a branch, and push it).

## The pool, and recycled machines

A task's worker comes from the project's **pool** — the workers tagged `task`. A free one is
reused (restarted if it was stopped), otherwise a new one is created. A worker you created by hand
is never taken.

The worker belongs to the task until it is `done` or `failed`; then it goes back to the pool
**parked** (stopped, disk kept), rebuilt first if it was behind the project's version. The next
task restarts it in seconds.

Before the session starts on a **recycled** machine, Lite runs **Workspace reset** in each
repository: it shows what is about to be thrown away, then `reset --hard`, `clean -fd` (never
`-x`: ignored files such as `node_modules` are the point of recycling), `fetch` and
`checkout -B <base> origin/<base>`. A fresh machine skips it.

## During review: keep or park

**Worker during review** in the project's Delegated work settings:

- **Keep** (default) — the machine stays up while you review.
- **Park it** — the container is stopped when the session hands back, and woken by a reply, Accept,
  Drop or **Wake**. **Park after N minutes** (up to 1,440) leaves it up for a while first, with a
  countdown on the Machine panel and a **Keep awake** button; replying cancels the countdown.

**Park** and **Wake** are also on the Machine panel of any task in review.

## Project settings

| Setting | Default | |
|---|---|---|
| Harness | Claude Code | the apps tasks may use, the first by default — part of the image |
| Default model | the app's default | one per app; a task can override it |
| Accept command | none | run by Accept; exit 0 ⇒ done |
| Drop command | none | cleanup run by Drop |
| Worker during review | Keep | or Park it, now or after N minutes |
| Instructions | none | appended to the standing instruction of every task |

None of these but the harness go into the image: changing them doesn't create a version.

## MCP servers

Tasks get the MCP servers switched on for their project — Notion, Linear, your own — through
Lite's gateway, without the worker ever holding the vendor's token. See
[MCP servers](/docs/mcp-servers).
