import { and, asc, desc, eq, isNotNull, like } from "drizzle-orm"
import type { TaskAppTile } from "@spunto/design-system/tasks"
import { db } from "../db/index"
import { taskAttachments, taskEvents, type Task } from "../db/schema"
import { linkThread, pullRequests, type SharedLink } from "../lib/task-shared"
import { claudeTile, type SessionLines } from "../lib/claude-tile"
import { taskProtocol } from "./task-events"

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
 * long session is mostly tool calls and their output, which the thread does not read.
 */
function taskMessages(taskId: string) {
  return db
    .select({ seq: taskEvents.seq, ts: taskEvents.ts, payload: taskEvents.payload })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, "message")))
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

const CLAUDE_PROTOCOLS = new Set(["claude-runner", "claude-stream", "claude-json"])

/**
 * The pull requests the conversation talked about, recognised from their URL. Only the link: Lite
 * has no forge integration (the clone and the push go through the user's own SSH key), so there is
 * nothing to ask GitHub where a PR stands — no state, no checks, no review, as Cloud's GitHub app
 * draws them.
 */
function pullRequestTile(links: SharedLink[]): TaskAppTile | null {
  const prs = pullRequests(links)
  if (prs.length === 0) return null
  return {
    appId: "pull-requests",
    appName: "Pull requests",
    title: "Pull requests",
    items: prs.map((pr) => ({
      url: pr.url,
      // The link's text is usually the PR's title; a bare URL only gives its repository.
      title: pr.title ?? pr.repo,
      label: pr.label,
      subtitle: pr.title ? pr.repo : pr.host === "github.com" ? undefined : pr.host,
    })),
  }
}

/**
 * What Lite can say about a task beyond its own facts, in the design system's tile vocabulary
 * (Cloud: `GET .../tiles`, drawn by the org's apps). Two, both read from the task's own events: the
 * harness's view of its session (Claude Code only — Codex writes none of these lines), and the
 * pull requests among the shared links.
 */
export function taskTiles(task: Pick<Task, "id" | "projectId" | "agentAppId">): TaskAppTile[] {
  const tiles: TaskAppTile[] = []
  if (CLAUDE_PROTOCOLS.has(taskProtocol(task))) {
    const claude = claudeTile(claudeSessionLines(task.id))
    if (claude) tiles.push(claude)
  }
  const prs = pullRequestTile(linkThread(taskMessages(task.id)))
  if (prs) tiles.push(prs)
  return tiles
}
