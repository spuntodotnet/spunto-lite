import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { db } from "../db/index"
import { taskEvents, tasks } from "../db/schema"
import { liteTunnel } from "../lib/lite-connect-hooks"

/**
 * What Lite tells Spunto Cloud about its tasks, for the Live Activities of the member's iPhone
 * (docs/lite-connect.md § « Événements »): Cloud does not see the tasks run, so it shows what it
 * hears. Three events, sent only while the tunnel is online — nothing is queued while it is not,
 * and an older Cloud ignores what it does not know:
 *
 *  - `task.state` on every transition — services/tasks.ts (`emitTaskState`), where the
 *    conditional write that made it is;
 *  - `task.progress` while a task runs: what its agent is at, from the `task_events` already
 *    ingested — at most every 20 s per task, and only when it changed;
 *  - `machine.summary`: the counts and the few tasks the Agents page shows on top, on every change
 *    (debounced ~2 s), and once right after every `welcome` (`sendMachineSummary`).
 *
 * Both of the last two are read off the database by one tick (`liveEventsTick`, every second while
 * online, started with the tunnel): nothing new is stored, the last sends are kept in memory.
 */

/** A notification's worth: what a Live Activity's line holds. */
export const EVENT_TEXT_CHARS = 200
export const PROGRESS_EVERY_MS = 20_000
export const SUMMARY_DEBOUNCE_MS = 2_000
export const LIVE_TICK_MS = 1_000
/** How many tasks a `machine.summary` lists. */
export const SUMMARY_TASKS = 3

/** One line, no runs of whitespace, clipped to `EVENT_TEXT_CHARS` with an ellipsis. */
export function eventText(text: string | null | undefined): string | undefined {
  const line = text?.replace(/\s+/g, " ").trim()
  if (!line) return undefined
  return line.length > EVENT_TEXT_CHARS ? `${line.slice(0, EVENT_TEXT_CHARS - 1).trimEnd()}…` : line
}

// ─── What the agent is at ─────────────────────────────────────────────────────

/** The arguments that say what a call is about — the cockpit's `toolSubject` (@spunto/design-system). */
const SUBJECT_KEYS = ["skill", "command", "file_path", "path", "pattern", "query", "url", "description", "prompt"]

/** `/workspace/<repo>/lib/foo.ts` → `lib/foo.ts`: the checkout is where every task works. */
const relative = (path: string) => path.replace(/^\/workspace\/[^/\s]+\/(?=\S)/, "").replace(/^\/workspace\/(?=\S)/, "")

/** « Edit lib/foo.ts », « Bash npm test », « create_subtask » — a tool call, as a line. */
export function toolActivity(name: string, input: string): string | undefined {
  // An MCP tool: `mcp__<server>__<tool>` — the tool is what reads.
  const tool = name.startsWith("mcp__") ? name.split("__").at(-1) || name : name
  let subject: string | null = null
  if (!input.trimStart().startsWith("{")) subject = input
  else {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>
      for (const key of SUBJECT_KEYS) {
        const value = parsed[key]
        if (typeof value === "string" && value.trim()) {
          subject = key === "file_path" || key === "path" ? relative(value.trim()) : value
          break
        }
      }
    } catch {
      // Clipped, or not JSON after all: the tool's name alone.
    }
  }
  return eventText(subject?.trim() ? `${tool} ${subject}` : tool)
}

/** The last thing an agent's message says: its last line of prose, without the Markdown around it. */
export function messageActivity(text: string): string | undefined {
  let inFence = false
  let last: string | null = null
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence || !line || /^[-*_]{3,}$/.test(line) || line.startsWith("|")) continue
    last = line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").replace(/\*\*|__|`/g, "")
  }
  return eventText(last)
}

/**
 * What a task's agent is at: its latest message or tool call on the session's own thread (a
 * subagent's are its business), as one readable line. Undefined before it said or did anything.
 */
export function currentActivity(taskId: string): string | undefined {
  const rows = db
    .select({ type: taskEvents.type, payload: taskEvents.payload })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        inArray(taskEvents.type, ["message", "tool.call"]),
        sql`json_extract(${taskEvents.payload}, '$.parentCallId') IS NULL`,
      ),
    )
    .orderBy(desc(taskEvents.seq))
    .limit(10)
    .all()
  for (const { type, payload } of rows) {
    const line =
      type === "tool.call"
        ? toolActivity(String(payload.name ?? ""), String(payload.input ?? ""))
        : payload.role === "assistant"
          ? messageActivity(String(payload.text ?? ""))
          : undefined
    if (line) return line
  }
  return undefined
}

// ─── The state the tick keeps ─────────────────────────────────────────────────

type SentProgress = { activity: string; at: number }

type EventsState = {
  /** The last `task.progress` sent, per running task. */
  progress: Map<string, SentProgress>
  /** The last `machine.summary` sent, as compared (`summaryKey`). */
  summaryKey: string | null
  /** When a summary different from the last one sent was first seen: it goes out 2 s after. */
  changedSince: number | null
  timer: NodeJS.Timeout | null
}

const KEY = Symbol.for("spunto-lite.lite-events-state")
function state(): EventsState {
  const g = globalThis as typeof globalThis & { [KEY]?: EventsState }
  return (g[KEY] ??= { progress: new Map(), summaryKey: null, changedSince: null, timer: null })
}

/** Forgets every send — for the tests. */
export function resetLiveEvents(): void {
  const s = state()
  s.progress.clear()
  s.summaryKey = null
  s.changedSince = null
}

const isOnline = () => liteTunnel()?.status().state === "online"
const emit = (message: Record<string, unknown>) => liteTunnel()?.emit(message) ?? false

// ─── task.progress ────────────────────────────────────────────────────────────

function sendProgress(s: EventsState, now: number): void {
  const running = db.select({ id: tasks.id, projectId: tasks.projectId, title: tasks.title }).from(tasks).where(eq(tasks.state, "running")).all()
  const live = new Set(running.map((t) => t.id))
  // A task that stopped running starts over: its next run is news from its first line.
  for (const id of s.progress.keys()) if (!live.has(id)) s.progress.delete(id)
  for (const task of running) {
    const activity = currentActivity(task.id)
    const sent = s.progress.get(task.id)
    if (!activity || activity === sent?.activity) continue
    if (sent && now - sent.at < PROGRESS_EVERY_MS) continue
    if (!emit({ type: "event", event: "task.progress", taskId: task.id, projectId: task.projectId, title: task.title, activity, at: new Date(now).toISOString() })) return
    s.progress.set(task.id, { activity, at: now })
  }
}

// ─── machine.summary ──────────────────────────────────────────────────────────

/** Set aside, as the Agents page reads it: the flag *and* still in review (services/tasks.ts `ON_HOLD`). */
const NOT_ON_HOLD = or(isNull(tasks.onHoldAt), ne(tasks.state, "in-review"))

type SummaryTask = { taskId: string; projectId: string; title: string; state: string; activity?: string }
type Summary = {
  running: number
  queued: number
  inReview: number
  tasks: SummaryTask[]
  last?: { taskId: string; title: string; state: string; at: string }
}

/**
 * The machine as the Agents page shows it by default (tasks on hold left out): the counts, the
 * `SUMMARY_TASKS` live tasks most recently active, and the last one that stopped. A running task's
 * activity is the one its `task.progress` last said, so the summary moves no faster than those.
 */
export function machineSummary(): Summary {
  const s = state()
  const live = db
    .select({ id: tasks.id, projectId: tasks.projectId, title: tasks.title, state: tasks.state })
    .from(tasks)
    .where(and(inArray(tasks.state, ["queued", "running", "in-review"]), NOT_ON_HOLD))
    .orderBy(desc(tasks.lastActivityAt), desc(tasks.createdAt))
    .all()
  const count = (state: string) => live.filter((t) => t.state === state).length
  const stopped = db
    .select({ id: tasks.id, title: tasks.title, state: tasks.state, at: tasks.lastActivityAt })
    .from(tasks)
    .where(and(inArray(tasks.state, ["in-review", "failed", "done"]), NOT_ON_HOLD))
    .orderBy(desc(tasks.lastActivityAt), desc(tasks.createdAt))
    .limit(1)
    .get()
  return {
    running: count("running"),
    queued: count("queued"),
    inReview: count("in-review"),
    tasks: live.slice(0, SUMMARY_TASKS).map((t) => {
      const activity = t.state === "running" ? s.progress.get(t.id)?.activity : undefined
      return { taskId: t.id, projectId: t.projectId, title: t.title, state: t.state, ...(activity ? { activity } : {}) }
    }),
    ...(stopped ? { last: { taskId: stopped.id, title: stopped.title, state: stopped.state, at: stopped.at.toISOString() } } : {}),
  }
}

/**
 * What a change is judged on: the counts, which tasks are listed and what they show — not their
 * order, which every ingested line can shuffle; the next summary sent carries it anyway.
 */
function summaryKey(summary: Summary): string {
  return JSON.stringify({ ...summary, tasks: [...summary.tasks].sort((a, b) => a.taskId.localeCompare(b.taskId)) })
}

function send(s: EventsState, summary: Summary, now: number): boolean {
  if (!emit({ type: "event", event: "machine.summary", ...summary, at: new Date(now).toISOString() })) return false
  s.summaryKey = summaryKey(summary)
  s.changedSince = null
  return true
}

/** Right after a `welcome` (services/lite-tunnel.ts): Cloud starts from the machine as it is now. */
export function sendMachineSummary(now = Date.now()): void {
  try {
    send(state(), machineSummary(), now)
  } catch (err) {
    console.warn(`[lite-connect] could not send machine.summary: ${(err as Error)?.message ?? err}`)
  }
}

// ─── The tick ─────────────────────────────────────────────────────────────────

/** One pass: the progress of the running tasks, then the summary if it changed 2 s ago or more. */
export function liveEventsTick(now = Date.now()): void {
  if (!isOnline()) return
  const s = state()
  try {
    sendProgress(s, now)
    const summary = machineSummary()
    if (summaryKey(summary) === s.summaryKey) {
      s.changedSince = null
      return
    }
    s.changedSince ??= now
    if (now - s.changedSince >= SUMMARY_DEBOUNCE_MS) send(s, summary, now)
  } catch (err) {
    console.warn(`[lite-connect] live events tick failed: ${(err as Error)?.message ?? err}`)
  }
}

/** With the tunnel (server.ts's module graph). `tickMs: 0` leaves the ticking to the caller — the tests. */
export function startLiveEvents(tickMs = LIVE_TICK_MS): void {
  const s = state()
  if (s.timer) clearInterval(s.timer)
  s.timer = null
  if (tickMs <= 0) return
  s.timer = setInterval(() => liveEventsTick(), tickMs)
  s.timer.unref?.()
}
