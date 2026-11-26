import { and, asc, desc, eq, isNotNull, like, sql } from "drizzle-orm"
import type { TaskAppTile, TaskAppTileItem } from "@spunto/design-system/tasks"
import { db } from "../db/index"
import { taskAttachments, taskEvents, type Task } from "../db/schema"
import { linkThread, pullRequests, type SharedLink } from "../lib/task-shared"
import { claudeTile, type SessionLines } from "../lib/claude-tile"
import { taskProtocol } from "./task-events"
import { pullRequestState } from "./integrations"
import type { PullRequestState } from "../lib/integrations"

/**
 * What circulated in a conversation, and what can be said about it — the reads behind the
 * « Shared links », « Shared files », « Pull requests » and « Claude Code » blocks of a task's
 * details (docs/taches.md § « Ce qui a circulé dans la conversation »). Spunto Cloud's
 * `task-shared.service.ts` and `task-session-lines.service.ts`, minus the Parquet archive: Lite
 * never archives a task's events, the table holds all of them.
 */

/** A file of the conversation — the attachment row without its bytes. */
export type SharedFile = {
  id: string
  filename: string | null
  mediaType: string
  bytes: number
  /** Who put it in the conversation: `user` attached it, `agent` showed it (a screenshot it read). */
  origin: "user" | "agent"
  createdAt: string
}

/**
 * Every `message` of a task, oldest first. Only `seq`, `ts` and `payload`, and only messages: a
 * long session is mostly tool calls and their output, which the thread does not read. Nor a
 * subagent's (`parentCallId`): it spoke to the agent that started it, not in the conversation.
 */
function taskMessages(taskId: string) {
  return db
    .select({ seq: taskEvents.seq, ts: taskEvents.ts, payload: taskEvents.payload })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, "message"), sql`json_extract(${taskEvents.payload}, '$.parentCallId') IS NULL`))
    .orderBy(asc(taskEvents.seq))
    .all()
    .map((e) => ({ seq: e.seq, ts: e.ts.toISOString(), role: e.payload.role, text: e.payload.text }))
}

/** The files either side put in the conversation, newest first. Never the bytes. */
function taskFiles(taskId: string): SharedFile[] {
  return db
    .select({
      id: taskAttachments.id,
      filename: taskAttachments.filename,
      mediaType: taskAttachments.mediaType,
      bytes: taskAttachments.bytes,
      origin: taskAttachments.origin,
      createdAt: taskAttachments.createdAt,
    })
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId))
    .orderBy(desc(taskAttachments.createdAt))
    .all()
    .map((f) => ({ ...f, origin: f.origin === "agent" ? "agent" : "user", createdAt: f.createdAt.toISOString() }))
}

/** What circulated in a task's conversation: the links written in it, the files passed in it. */
export function taskShared(taskId: string): { links: SharedLink[]; files: SharedFile[] } {
  return { links: linkThread(taskMessages(taskId)), files: taskFiles(taskId) }
}

// ── Tiles ─────────────────────────────────────────────────────────────────────────────────────

/** The latest harness line behind an event matching `where`. */
function latestSource(taskId: string, where: ReturnType<typeof and>): string | null {
  const row = db
    .select({ source: taskEvents.source })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), isNotNull(taskEvents.source), where))
    .orderBy(desc(taskEvents.seq))
    .limit(1)
    .get()
  return row?.source ?? null
}

/**
 * The session's own lines the Claude Code block reads: the latest `session.started` and
 * `session.ended` lines (our vocabulary picks *which*), and the latest quota line — Claude Code's
 * `rate_limit_event` has no event of ours, it lands as `raw`, found by the start of its line.
 */
export function claudeSessionLines(taskId: string): SessionLines {
  return {
    started: latestSource(taskId, eq(taskEvents.type, "session.started")),
    ended: latestSource(taskId, eq(taskEvents.type, "session.ended")),
    rateLimit: latestSource(taskId, and(eq(taskEvents.type, "raw"), like(taskEvents.source, `{"type":"rate_limit_event"%`))),
  }
}

const STATE_CHIP: Record<PullRequestState["state"], NonNullable<TaskAppTileItem["status"]>> = {
  open: { label: "Open", tone: "info" },
  draft: { label: "Draft", tone: "neutral" },
  merged: { label: "Merged", tone: "success" },
  closed: { label: "Closed", tone: "muted" },
}

/** What is left to do before it can merge — said only while it can still be merged. */
function pendingBadges(state: PullRequestState): TaskAppTileItem["badges"] {
  if (state.state !== "open" && state.state !== "draft") return undefined
  const badges: NonNullable<TaskAppTileItem["badges"]> = []
  if (state.checks === "success") badges.push({ label: "Checks passing", tone: "success" })
  if (state.checks === "failure") badges.push({ label: "Checks failing", tone: "danger" })
  if (state.checks === "pending") badges.push({ label: "Checks running", tone: "warning" })
  if (state.review === "approved") badges.push({ label: "Approved", tone: "success" })
  if (state.review === "changes_requested") badges.push({ label: "Changes requested", tone: "warning" })
  if (state.review === "required") badges.push({ label: "Review required", tone: "neutral" })
  if (state.conflicts) badges.push({ label: "Conflicts", tone: "danger" })
  return badges.length ? badges : undefined
}

/**
 * The pull requests the conversation talked about, recognised from their URL — and, for a forge
 * connected in Settings → Integrations (docs/integrations.md), where each stands: open, merged,
 * its checks, its review. Without a connection (or when the forge does not answer) a row is its
 * link only, as before: a forge that hangs holds the block for its timeout at most (`forgeFetch`).
 */
async function pullRequestTile(links: SharedLink[]): Promise<TaskAppTile | null> {
  const prs = pullRequests(links)
  if (prs.length === 0) return null
  const states = await Promise.all(prs.map((pr) => pullRequestState(pr)))
  return {
    appId: "pull-requests",
    appName: "Pull requests",
    title: "Pull requests",
    items: prs.map((pr, i) => {
      const state = states[i]
      // The forge's title first; then the link's text, usually the PR's title; a bare URL only gives its repository.
      const title = state?.title ?? pr.title
      return {
        url: pr.url,
        title: title ?? pr.repo,
        label: pr.label,
        subtitle: title ? pr.repo : pr.host === "github.com" ? undefined : pr.host,
        status: state ? STATE_CHIP[state.state] : undefined,
        badges: state ? pendingBadges(state) : undefined,
      }
    }),
  }
}

/**
 * What Lite can say about a task beyond its own facts, in the design system's tile vocabulary
 * (Cloud: `GET .../tiles`, drawn by the org's apps). Two, both read from the task's own events: the
 * harness's view of its session (Claude Code only — Codex writes none of these lines), and the
 * pull requests among the shared links, with their state when their forge is connected.
 */
export async function taskTiles(task: Pick<Task, "id" | "projectId" | "agentAppId" | "sessionProtocol" | "commandId">): Promise<TaskAppTile[]> {
  const tiles: TaskAppTile[] = []
  // On the contract (`agent-v1`) every app shares one protocol: the app says it is Claude, and each
  // event's `source` is still Claude's own message — the lines this tile reads.
  const protocol = taskProtocol(task)
  if (protocol === "agent-v1" && task.agentAppId === "claude") {
    const claude = claudeTile(claudeSessionLines(task.id))
    if (claude) tiles.push(claude)
  }
  const prs = await pullRequestTile(linkThread(taskMessages(task.id)))
  if (prs) tiles.push(prs)
  return tiles
}
