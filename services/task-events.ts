import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm"
import {
  cleanTitle,
  parseLines,
  parseSessionTitle,
  readsTitleOutOfBand,
  resolveContextWindow,
  sessionTitleProbe,
  splitCompleteLines,
  summarizeUsage,
  type AgentProtocol,
  type ModelCredential,
  type SessionUsage,
  type SourcedEvent,
} from "@spunto/build/agent-stream"
import { db } from "../db/index"
import { projects, taskEvents, tasks, workers, type Task, type TaskEvent } from "../db/schema"
import { MAX_READ_BYTES, readCommandOutput, runCommand } from "../lib/worker-commands"
import { mayCarryFile, referenceAttachment, scanFileBlocks } from "../lib/task-attachments"
import { resolveSecretsForSpawn } from "./secrets"
import * as attachments from "./task-attachments"

/**
 * Ingesting an agent session's stream into `task_events` (RFC 0020) — Spunto Cloud's
 * `task-events.service.ts`, on a local Docker socket instead of a node agent.
 *
 * **A pull, not a push.** The harness's stdout is already written to
 * `~/.spunto/commands/<id>/stdout.log` by the background-command wrapper; ingestion reads it by
 * byte range from a cursor kept on the task row. So:
 *
 *  - **durable** — the stream lives in the worker; Lite holds only an offset. A restart resumes.
 *  - **exactly once** — the offset only advances past complete lines, by compare-and-swap.
 *  - **resumable** — `seq` is dense and monotonic per task; a reader passes `?since=`.
 *
 * The cost: events land when something *reads* the task — the cockpit polling, the background
 * floor, and one final catch-up when the session stops.
 */

const MAX_CHUNKS_PER_PASS = 6
/** Longest line assembled across reads — sized for an inline screenshot. Past it, skipped. */
const MAX_LINE_BYTES = 12 * 1024 * 1024
const MAX_EVENTS_PER_TASK = 5_000
const MAX_SOURCE_CHARS = 64 * 1024

export function taskProtocol(projectId: string): AgentProtocol {
  const p = db.select({ protocol: projects.taskAgentProtocol }).from(projects).where(eq(projects.id, projectId)).get()
  return (p?.protocol as AgentProtocol | undefined) ?? "none"
}

/**
 * Pull whatever the session wrote since the cursor, and store it. Returns how many events were
 * stored — 0 covers every uninteresting case (no protocol, no session, worker asleep, nothing new).
 */
export async function ingestTaskEvents(task: Task, protocol?: AgentProtocol): Promise<number> {
  const dialect = protocol ?? taskProtocol(task.projectId)
  if (dialect === "none") return 0
  if (!task.workerId || !task.commandId) return 0
  const worker = db.select().from(workers).where(eq(workers.id, task.workerId)).get()
  // Parked or gone: cannot be read, and the events already stored stay readable.
  if (!worker?.containerId || worker.state !== "ready") return 0

  const commandId = task.commandId
  let named: { title: string; source: string } | null = null
  let fromCommandId = task.eventsCommandId
  let rowOffset = task.eventsOffset
  // The cursor belongs to *this* command's stdout — a follow-up turn starts a new file at 0.
  const sameCommand = fromCommandId === null || fromCommandId === commandId
  let offset = sameCommand ? task.eventsOffset : 0
  let seq = task.eventsSeq
  let stored = 0
  // Bytes past the cursor with no newline yet — a line still arriving (an inline image, typically).
  let carry: Buffer | null = null

  for (let chunk = 0; chunk < MAX_CHUNKS_PER_PASS; ) {
    const readAt = offset + (carry?.length ?? 0)
    let read: Awaited<ReturnType<typeof readCommandOutput>>
    try {
      read = await readCommandOutput({ containerId: worker.containerId, commandId, offset: readAt, maxBytes: MAX_READ_BYTES })
    } catch (err) {
      console.warn(`[task:${task.id}] event read failed at offset ${readAt}: ${err}`)
      break
    }
    if (!read.found || read.data.length === 0) break

    const bytes: Buffer = carry ? Buffer.concat([carry, read.data]) : read.data
    const { lines, consumed } = splitCompleteLines(bytes)
    if (consumed === 0) {
      if (read.data.length < MAX_READ_BYTES) break
      if (bytes.length < MAX_LINE_BYTES) {
        carry = bytes
        continue
      }
      console.warn(`[task:${task.id}] event line over ${MAX_LINE_BYTES} bytes at ${offset} — skipped`)
      if (!advanceCursor(task.id, fromCommandId, commandId, rowOffset, offset + bytes.length, seq, seq)) break
      fromCommandId = commandId
      offset += bytes.length
      rowOffset = offset
      carry = null
      continue
    }
    chunk++

    const events = seq >= MAX_EVENTS_PER_TASK ? [] : parseWithFiles(task.id, commandId, dialect, lines, MAX_EVENTS_PER_TASK - seq)
    // Claimed *before* inserting: losing the race means another reader owns these rows.
    if (!advanceCursor(task.id, fromCommandId, commandId, rowOffset, offset + consumed, seq, seq + events.length)) break

    if (events.length > 0) {
      for (const event of events) {
        if (event.type !== "session.title") continue
        const title = cleanTitle(event.payload.title)
        if (title) named = { title, source: event.source }
      }
      await measureContextWindow(task, events).catch((err) => console.warn(`[task:${task.id}] could not measure the context window: ${err}`))
      const now = new Date()
      db.insert(taskEvents)
        .values(
          events.map((event, i) => ({
            taskId: task.id,
            seq: seq + i + 1,
            commandId,
            ts: now,
            type: event.type,
            payload: event.payload,
            source: event.source.length > MAX_SOURCE_CHARS ? event.source.slice(0, MAX_SOURCE_CHARS) : event.source,
          })),
        )
        .run()
    }
    fromCommandId = commandId
    offset += consumed
    rowOffset = offset
    carry = null
    seq += events.length
    stored += events.length
    if (read.size <= offset) break
  }

  if (stored > 0) {
    // The session spoke, so the task moved — a list ordered like a conversation list must hear it.
    db.update(tasks).set({ lastActivityAt: new Date() }).where(eq(tasks.id, task.id)).run()
    await adoptSessionTitle(task, dialect, worker.containerId, named).catch((err) =>
      console.warn(`[task:${task.id}] session title read failed: ${err}`),
    )
  }
  return stored
}

/**
 * Let the **session** name a task nobody named — once. Claude Code writes the name in its
 * transcript rather than on stdout, so it is read out of band with one `grep` in the worker; a
 * `jsonl` harness says it in band. Either way `auto_title` is flipped by the same statement that
 * writes the name, so the first name to land is the task's name for good.
 */
async function adoptSessionTitle(
  task: Task,
  dialect: AgentProtocol,
  containerId: string,
  inBand: { title: string; source: string } | null,
): Promise<void> {
  if (!task.autoTitle) return
  if (inBand) {
    renameFromSession(task.id, inBand.title)
    return
  }
  if (!readsTitleOutOfBand(dialect)) return
  const sessionId = latestSessionId(task.id)
  if (!sessionId) return
  const probe = sessionTitleProbe(dialect, sessionId)
  if (!probe) return
  const result = await runCommand({ containerId, command: probe, timeoutMs: 10_000, maxOutputBytes: 16 * 1024 })
  const found = parseSessionTitle(dialect, result.stdout ?? "")
  if (!found) return
  if (renameFromSession(task.id, found.title)) {
    appendPlatformEvent(task.id, task.commandId, "session.title", { title: found.title }, found.source)
    console.log(`[task:${task.id}] named by its session: ${found.title}`)
  }
}

function renameFromSession(taskId: string, title: string): boolean {
  const res = db
    .update(tasks)
    .set({ title, autoTitle: false })
    .where(and(eq(tasks.id, taskId), eq(tasks.autoTitle, true)))
    .run()
  return res.changes > 0
}

/** Parse a chunk line by line, taking inline files out of each line first (RFC 0022). */
function parseWithFiles(taskId: string, commandId: string, dialect: AgentProtocol, lines: string[], budget: number): SourcedEvent[] {
  const out: SourcedEvent[] = []
  for (const line of lines) {
    if (out.length >= budget) break
    let captured: Captured = { line, files: [] }
    try {
      captured = captureFiles(taskId, commandId, line)
    } catch (err) {
      console.warn(`[task:${taskId}] could not store a file from the stream: ${err}`)
    }
    const events = parseLines(dialect, [captured.line], budget - out.length)
    if (captured.files.length > 0) attachFiles(events, captured.files)
    out.push(...events)
  }
  return out
}

type CapturedFile = { file: attachments.StoredFile; callId: string | null }
type Captured = { line: string; files: CapturedFile[] }

function captureFiles(taskId: string, commandId: string, line: string): Captured {
  if (!mayCarryFile(line)) return { line, files: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(line.trim())
  } catch {
    return { line, files: [] }
  }
  const sites = scanFileBlocks(parsed)
  if (sites.length === 0) return { line, files: [] }
  const files: CapturedFile[] = []
  for (const site of sites) {
    const [stored] = attachments.storeFiles(taskId, commandId, "agent", [
      { filename: site.filename, mediaType: site.mediaType, data: site.data },
    ])
    if (!stored) continue
    referenceAttachment(site, stored.id)
    files.push({ file: stored, callId: site.callId })
  }
  return files.length === 0 ? { line, files: [] } : { line: JSON.stringify(parsed), files }
}

/** Put each file on the event it belongs to: the tool result it answered, else the line's first event. */
function attachFiles(events: SourcedEvent[], files: CapturedFile[]): void {
  for (const { file, callId } of files) {
    const target =
      (callId && events.find((e) => e.type === "tool.result" && e.payload.callId === callId)) ||
      events.find((e) => e.type === "message" || e.type === "tool.result") ||
      events[0]
    if (!target) continue
    const existing = Array.isArray(target.payload.files) ? (target.payload.files as unknown[]) : []
    target.payload.files = [...existing, file]
  }
}

/** Claim a byte range and the `seq` numbers it produces, by compare-and-swap. */
function advanceCursor(
  taskId: string,
  fromCommandId: string | null,
  toCommandId: string,
  fromOffset: number,
  toOffset: number,
  fromSeq: number,
  toSeq: number,
): boolean {
  const res = db
    .update(tasks)
    .set({ eventsCommandId: toCommandId, eventsOffset: toOffset, eventsSeq: toSeq })
    .where(
      and(
        eq(tasks.id, taskId),
        // `IS` is SQLite's null-safe equality: a task that never streamed has no command yet.
        sql`${tasks.eventsCommandId} IS ${fromCommandId}`,
        eq(tasks.eventsOffset, fromOffset),
        eq(tasks.eventsSeq, fromSeq),
      ),
    )
    .run()
  return res.changes > 0
}

/** Events after `since`, oldest first. */
export function listTaskEvents(taskId: string, since = 0, limit = 500): TaskEvent[] {
  return db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), gt(taskEvents.seq, since)))
    .orderBy(asc(taskEvents.seq))
    .limit(Math.min(2_000, Math.max(1, limit)))
    .all()
}

function pageOf(rows: TaskEvent[], limit: number): { events: TaskEvent[]; hasMore: boolean } {
  const hasMore = rows.length > limit
  return { events: (hasMore ? rows.slice(0, limit) : rows).reverse(), hasMore }
}

/** The **end** of the stream — where a long session opens. */
export function listTaskEventsTail(taskId: string, limit = 500): { events: TaskEvent[]; hasMore: boolean } {
  const capped = Math.min(2_000, Math.max(1, limit))
  const rows = db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(desc(taskEvents.seq)).limit(capped + 1).all()
  return pageOf(rows, capped)
}

/** The `limit` events right before `before` — older history, paged as the reader scrolls up. */
export function listTaskEventsBefore(taskId: string, before: number, limit = 500): { events: TaskEvent[]; hasMore: boolean } {
  const capped = Math.min(2_000, Math.max(1, limit))
  const rows = db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), lt(taskEvents.seq, before)))
    .orderBy(desc(taskEvents.seq))
    .limit(capped + 1)
    .all()
  return pageOf(rows, capped)
}

/**
 * Record an event the **platform** authored — what a human said, above all: a harness does not
 * echo its stdin, so a conversation read only off its output is one side talking. `source` stays
 * null: no harness line behind it. Same seq compare-and-swap as ingestion.
 */
export function appendPlatformEvent(
  taskId: string,
  commandId: string | null,
  type: string,
  payload: Record<string, unknown>,
  source: string | null = null,
): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = db.select({ seq: tasks.eventsSeq }).from(tasks).where(eq(tasks.id, taskId)).get()
    if (!row) return false
    const now = new Date()
    const claimed = db
      .update(tasks)
      .set({ eventsSeq: row.seq + 1, lastActivityAt: now })
      .where(and(eq(tasks.id, taskId), eq(tasks.eventsSeq, row.seq)))
      .run()
    if (claimed.changes === 0) continue
    db.insert(taskEvents)
      .values({
        taskId,
        seq: row.seq + 1,
        commandId,
        ts: now,
        type,
        payload,
        source: source && source.length > MAX_SOURCE_CHARS ? source.slice(0, MAX_SOURCE_CHARS) : source,
      })
      .run()
    return true
  }
  console.warn(`[task:${taskId}] could not place a platform event — lost the seq race twice`)
  return false
}

/** The harness session id, read from the last `session.started` — learnt by reading, never invented. */
export function latestSessionId(taskId: string): string | null {
  const row = db
    .select({ payload: taskEvents.payload })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, "session.started")))
    .orderBy(desc(taskEvents.seq))
    .limit(1)
    .get()
  const id = row?.payload?.sessionId
  return typeof id === "string" && id ? id : null
}

/**
 * The type of the latest event that is a moment in the session — how an interactive session's
 * turn is known to be over (`session.ended`), since its process does not exit between turns.
 * `raw` and `session.title` are facts *about* the session, and are skipped.
 */
export function lastEventType(taskId: string): string | null {
  const row = db
    .select({ type: taskEvents.type })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), sql`${taskEvents.type} NOT IN ('raw', 'session.title')`))
    .orderBy(desc(taskEvents.seq))
    .limit(1)
    .get()
  return row?.type ?? null
}

/**
 * Ask the Models API for the window a session opened with, when the task has an Anthropic
 * credential among its secrets — once per `session.started`, and written on the stored event.
 * Best-effort: the catalogue in `@spunto/build/agent-stream` answers otherwise.
 */
async function measureContextWindow(task: Task, events: SourcedEvent[]): Promise<void> {
  const started = events.filter((e) => e.type === "session.started" && typeof e.payload.model === "string")
  if (started.length === 0) return
  const credential = anthropicCredential(task.projectId)
  if (!credential) return
  for (const event of started) {
    const measured = await resolveContextWindow(event.payload.model as string, credential)
    if (measured !== null) event.payload.contextWindow = measured
  }
}

function anthropicCredential(projectId: string): ModelCredential | null {
  let secrets: Record<string, string> = {}
  try {
    secrets = resolveSecretsForSpawn(projectId)
  } catch {
    return null
  }
  const apiKey = secrets.ANTHROPIC_API_KEY?.trim()
  if (apiKey) return { kind: "api-key", value: apiKey }
  const token = secrets.CLAUDE_CODE_OAUTH_TOKEN?.trim() || secrets.ANTHROPIC_AUTH_TOKEN?.trim()
  if (token) return { kind: "oauth", value: token }
  return null
}

/**
 * What the session consumed — context, tokens, money — over the **whole** task. Summed in SQLite
 * (`json_extract`), reduced by the package's `summarizeUsage`. A `jsonl` harness writes these
 * payloads itself, so every number is shape-checked before it is added.
 */
export function taskUsage(taskId: string): SessionUsage | null {
  const total = (key: string) =>
    sql.raw(
      `COALESCE(SUM(CASE WHEN json_extract(payload, '$.scope') = 'call' AND json_type(payload, '$.${key}') IN ('integer', 'real') THEN json_extract(payload, '$.${key}') ELSE 0 END), 0)`,
    )
  const row = db
    .select({
      calls: sql<number>`COUNT(CASE WHEN json_extract(payload, '$.scope') = 'call' THEN 1 END)`,
      inputTokens: sql<number>`${total("inputTokens")}`,
      outputTokens: sql<number>`${total("outputTokens")}`,
      cacheReadTokens: sql<number>`${total("cacheReadTokens")}`,
      cacheCreationTokens: sql<number>`${total("cacheCreationTokens")}`,
    })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, "usage")))
    .get()
  if (!row) return null

  const latest = (where: ReturnType<typeof sql>) =>
    db
      .select({ payload: taskEvents.payload })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), where))
      .orderBy(desc(taskEvents.seq))
      .limit(1)
      .get()?.payload ?? null

  return summarizeUsage({
    calls: {
      count: Number(row.calls) || 0,
      inputTokens: Number(row.inputTokens) || 0,
      outputTokens: Number(row.outputTokens) || 0,
      cacheReadTokens: Number(row.cacheReadTokens) || 0,
      cacheCreationTokens: Number(row.cacheCreationTokens) || 0,
    },
    latestCall: latest(sql`${taskEvents.type} = 'usage' AND json_extract(${taskEvents.payload}, '$.scope') = 'call'`),
    latestSession: latest(sql`${taskEvents.type} = 'usage' AND json_extract(${taskEvents.payload}, '$.scope') = 'session'`),
    started: latest(sql`${taskEvents.type} = 'session.started'`),
  })
}
