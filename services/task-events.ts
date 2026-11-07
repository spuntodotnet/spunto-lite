import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm"
import {
  cleanTitle,
  foldDraft,
  parseLines,
  parseSessionTitle,
  readsTitleOutOfBand,
  sessionTitleProbe,
  splitCompleteLines,
  summarizeUsage,
  type AgentDraft,
  type AgentProtocol,
  type SessionUsage,
  type SourcedEvent,
} from "@spunto/build/agent-stream"
import { readContractObject } from "@spunto/build/agent-contract"
import { db } from "../db/index"
import { projects, taskEvents, tasks, workers, type Task, type TaskEvent } from "../db/schema"
import { MAX_READ_BYTES, readCommandOutput, runCommand } from "../lib/worker-commands"
import { mayCarryFile, referenceAttachment, scanFileBlocks } from "../lib/task-attachments"
import * as attachments from "./task-attachments"
import { protocolOf } from "../lib/agent-apps"

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
const MAX_SOURCE_CHARS = 64 * 1024

/**
 * What the agent is writing right now, per task — folded from its partial messages (`foldDraft`)
 * as ingestion goes past them, and **only in memory** (Cloud ebadc730).
 *
 * Deliberately not a column: it changes on every read while a message is being written, and the
 * finished message replaces it within seconds. Losing it — Lite restarting — costs a few seconds of
 * preview, never a word of the session: the finished `message` event is stored as always.
 */
type DraftEntry = { commandId: string; draft: AgentDraft; updatedAt: number }
// On `globalThis`, like lib/agent.ts: the background floor ingests from server.ts's module graph
// (tsx), the routes from Next's — same process, two graphs, and the draft must be the one both fold.
const DRAFTS = Symbol.for("spunto-lite.task-drafts")
const drafts: Map<string, DraftEntry> = ((globalThis as typeof globalThis & { [DRAFTS]?: Map<string, DraftEntry> })[DRAFTS] ??= new Map())

/**
 * A draft nobody finished in this long is a session that died mid-sentence (no finished message,
 * no end of turn ever followed). Dropped rather than shown forever as "writing…".
 */
const DRAFT_TTL_MS = 5 * 60_000

function updateDraft(taskId: string, commandId: string, dialect: AgentProtocol, lines: string[]): void {
  const prev = drafts.get(taskId)
  const next = foldDraft(dialect, lines, prev?.commandId === commandId ? prev.draft : null)
  if (!next) drafts.delete(taskId)
  else if (next !== prev?.draft) drafts.set(taskId, { commandId, draft: next, updatedAt: Date.now() })
}

/** The text the task's session is writing right now, or null. Call after `ingestTaskEvents`. */
export function taskDraft(task: { id: string; commandId: string | null }): (AgentDraft & { updatedAt: string }) | null {
  const entry = drafts.get(task.id)
  if (!entry) return null
  if (entry.commandId !== task.commandId || Date.now() - entry.updatedAt > DRAFT_TTL_MS) {
    drafts.delete(task.id)
    return null
  }
  return { ...entry.draft, updatedAt: new Date(entry.updatedAt).toISOString() }
}

/**
 * How a task's stream is read: the dialect its current session started on (`sessionProtocol`), or
 * — a session from before that column — its agent app's previous one, or its project's.
 */
export function taskProtocol(task: Pick<Task, "projectId" | "agentAppId" | "sessionProtocol" | "commandId">): AgentProtocol {
  const p = db.select({ taskAgentProtocol: projects.taskAgentProtocol }).from(projects).where(eq(projects.id, task.projectId)).get()
  return protocolOf(task, p)
}

/**
 * Pull whatever the session wrote since the cursor, and store it. Returns how many events were
 * stored — 0 covers every uninteresting case (no protocol, no session, worker asleep, nothing new).
 */
export async function ingestTaskEvents(task: Task, protocol?: AgentProtocol): Promise<number> {
  const dialect = protocol ?? taskProtocol(task)
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

    const events = parseWithFiles(task.id, commandId, dialect, lines)
    // Claimed *before* inserting: losing the race means another reader owns these rows.
    if (!advanceCursor(task.id, fromCommandId, commandId, rowOffset, offset + consumed, seq, seq + events.length)) break
    // Right after the claim: this reader alone owns these bytes, so it is the one that folds them,
    // and in order.
    updateDraft(task.id, commandId, dialect, lines)

    if (events.length > 0) {
      for (const event of events) {
        if (event.type !== "session.title") continue
        const title = cleanTitle(event.payload.title)
        if (title) named = { title, source: event.source }
      }
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
function parseWithFiles(taskId: string, commandId: string, dialect: AgentProtocol, lines: string[]): SourcedEvent[] {
  if (dialect === "agent-v1") return parseContractWithFiles(taskId, commandId, lines)
  const out: SourcedEvent[] = []
  for (const line of lines) {
    let captured: Captured = { line, files: [] }
    try {
      captured = captureFiles(taskId, commandId, line)
    } catch (err) {
      console.warn(`[task:${taskId}] could not store a file from the stream: ${err}`)
    }
    const events = parseLines(dialect, [captured.line], Infinity)
    if (captured.files.length > 0) attachFiles(events, captured.files)
    out.push(...events)
  }
  return out
}

/**
 * The same, for a session speaking the Spunto agent contract (`agent-v1`) — Cloud's
 * `parseContractWithFiles` (cf96aa07). The files are in each line's `source`: the harness's own
 * message, which the runner keeps whole next to the event it read it into.
 *
 * One message can be several lines (a reply and its usage; two tool results), and the runner puts
 * the same `source` on each. So consecutive lines with an identical source are one **group**: its
 * files are stored once, each paired with its call across the whole group, and every line of it
 * keeps the source with the bytes swapped for the stored ids. A group cut by the end of a read is
 * the one case that stores a file twice — two rows for one picture, never a lost one.
 */
function parseContractWithFiles(taskId: string, commandId: string, lines: string[]): SourcedEvent[] {
  type Item = { line: string; obj: Record<string, unknown> | null; key: string | null }
  const items: Item[] = lines.map((line) => {
    if (!mayCarryFile(line)) return { line, obj: null, key: null }
    try {
      const parsed = JSON.parse(line.trim())
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { line, obj: null, key: null }
      const obj = parsed as Record<string, unknown>
      return { line, obj, key: obj.source === undefined ? null : JSON.stringify(obj.source) }
    } catch {
      return { line, obj: null, key: null }
    }
  })

  const out: SourcedEvent[] = []
  for (let i = 0; i < items.length; ) {
    const first = items[i]!
    if (!first.obj) {
      out.push(...parseLines("agent-v1", [first.line], Infinity))
      i++
      continue
    }
    let end = i + 1
    while (end < items.length && first.key !== null && items[end]!.obj && items[end]!.key === first.key) end++
    const group = items.slice(i, end)
    i = end

    let files: CapturedFile[] = []
    try {
      files = captureParsed(taskId, commandId, first.obj)
    } catch (err) {
      console.warn(`[task:${taskId}] could not store a file from the stream: ${err}`)
    }
    const events = group.flatMap((item) => {
      // The bytes are stored once: every line of the group points at the same, referenced, source.
      if (item !== first && first.key !== null) item.obj!.source = first.obj!.source
      return readContractObject(item.obj!, item.line.trim())
    })
    if (files.length > 0) attachFiles(events, files)
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
  const files = captureParsed(taskId, commandId, parsed)
  return files.length === 0 ? { line, files: [] } : { line: JSON.stringify(parsed), files }
}

/** Store every inline file of a parsed line and swap each blob for its id, in place. */
function captureParsed(taskId: string, commandId: string, parsed: unknown): CapturedFile[] {
  const sites = scanFileBlocks(parsed)
  if (sites.length === 0) return []
  const files: CapturedFile[] = []
  for (const site of sites) {
    const [stored] = attachments.storeFiles(taskId, commandId, "agent", [
      { filename: site.filename, mediaType: site.mediaType, data: site.data },
    ])
    if (!stored) continue
    referenceAttachment(site, stored.id)
    files.push({ file: stored, callId: site.callId })
  }
  return files
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
 * Has an **interactive** session handed back — is the agent actually done with its turn?
 *
 * The process does not exit between turns, so `session.ended` in the stream is the harness saying
 * its turn is over. Necessary, not sufficient: a turn can end with work still running behind it
 * (a `run_in_background` shell, a backgrounded subagent), and when that work finishes the harness
 * wakes itself up for another turn and another `session.ended`, nobody having said anything.
 * Taking the first one at its word put the task in review — and parked its worker — while the
 * agent was still at it. So, as in Cloud:
 *
 *  - the last *moment* is a `session.ended` (`raw`, `session.title` and `session.background` are
 *    facts *about* the session, and can all land right after the end);
 *  - nothing was left running in the background **at that end**: the latest `session.background`
 *    *before* it is absent or empty. Before, not after — a set that empties after the end is the
 *    prelude to the turn it wakes up.
 *
 * A harness that never reports background work is judged on its `session.ended` alone.
 */
export function hasHandedBack(taskId: string): boolean {
  const last = lastTurnEnd(taskId)
  if (!last) return false
  const background = db
    .select({ payload: taskEvents.payload })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, "session.background"), lt(taskEvents.seq, last.seq)))
    .orderBy(desc(taskEvents.seq))
    .limit(1)
    .get()
  const running = background?.payload?.tasks
  return !Array.isArray(running) || running.length === 0
}

/**
 * Did the session's last turn end — whatever was left running behind it? The first half of
 * `hasHandedBack`, for the one moment the second half stops mattering: the **process is gone**
 * (the 6 h timeout on a session nobody answered, a crash, a machine that went down). There is no
 * next turn coming then, and the last thing the agent did was hand back.
 */
export function hasEndedTurn(taskId: string): boolean {
  return lastTurnEnd(taskId) !== null
}

/** The last *moment* of the stream, if it is a `session.ended`. */
function lastTurnEnd(taskId: string): { seq: number } | null {
  const row = db
    .select({ type: taskEvents.type, seq: taskEvents.seq })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), sql`${taskEvents.type} NOT IN ('raw', 'session.title', 'session.background')`))
    .orderBy(desc(taskEvents.seq))
    .limit(1)
    .get()
  return row?.type === "session.ended" ? { seq: row.seq } : null
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
