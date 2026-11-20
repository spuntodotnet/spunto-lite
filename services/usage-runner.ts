import { join } from "node:path"
import { Worker } from "node:worker_threads"
import type { UsageReport, UsageSnapshot } from "../lib/types"
import type { UsagePeriod } from "./usage"

/**
 * The Usage report, computed in the background (`services/usage-worker.ts`) and kept here: the
 * page reads the last one, and is told when a newer one is on its way. On a few million
 * `task_events` the report takes tens of seconds — the route waiting for it would hold a request
 * that long, and computing it on the server's thread froze the whole app meanwhile.
 *
 *  - **One report per period and time zone**, recomputed when read once it is old enough: FRESH_MS,
 *    or five times what it took to make — a report of twenty seconds is not remade on every poll
 *    of the page, keeping a core busy for a dashboard left open. Meanwhile, the old one is
 *    served, with `computing: true`.
 *  - **One computation at a time**, the most recently asked first: clicking through the periods
 *    does not queue a report per click before the one now on screen. A report nobody asked for
 *    in WANTED_MS (the page polls) is not computed.
 */

const FRESH_MS = 30_000
const WANTED_MS = 60_000
const FORGET_MS = 30 * 60_000
const TIMEOUT_MS = 10 * 60_000

type Entry = {
  days: UsagePeriod
  timeZone: string
  report: UsageReport | null
  /** When `report` was made. */
  at: number | null
  /** When the last computation ended, made or failed. */
  triedAt: number | null
  durationMs: number | null
  error: string | null
  askedAt: number
  computing: boolean
}

type Runner = {
  entries: Map<string, Entry>
  worker: Worker | null
  job: { id: number; key: string; startedAt: number; timer: NodeJS.Timeout } | null
  nextId: number
}

// On `globalThis`, like services/resources.ts: a dev reload re-evaluates this module, and must
// find the thread and the reports already there.
const KEY = Symbol.for("spunto-lite.usage")
function runner(): Runner {
  const g = globalThis as typeof globalThis & { [KEY]?: Runner }
  return (g[KEY] ??= { entries: new Map(), worker: null, job: null, nextId: 1 })
}

/** The last report of this period, and whether a newer one is being computed. Never waits. */
export function readUsage(days: UsagePeriod, timeZone: string): UsageSnapshot {
  const r = runner()
  const key = `${days}|${timeZone}`
  const now = Date.now()
  let e = r.entries.get(key)
  if (!e) r.entries.set(key, (e = { days, timeZone, report: null, at: null, triedAt: null, durationMs: null, error: null, askedAt: now, computing: false }))
  e.askedAt = now
  for (const [k, other] of r.entries) if (now - other.askedAt > FORGET_MS) r.entries.delete(k)
  pump()
  return snapshot(e)
}

function snapshot(e: Entry): UsageSnapshot {
  return {
    report: e.report,
    computedAt: e.at === null ? null : new Date(e.at).toISOString(),
    durationMs: e.durationMs,
    computing: e.computing || stale(e),
    error: e.error,
  }
}

const stale = (e: Entry) => e.triedAt === null || Date.now() - e.triedAt > Math.max(FRESH_MS, 5 * (e.durationMs ?? 0))

function pump() {
  const r = runner()
  if (r.job) return
  const now = Date.now()
  const next = [...r.entries.entries()]
    .filter(([, e]) => stale(e) && now - e.askedAt < WANTED_MS)
    .sort(([, a], [, b]) => b.askedAt - a.askedAt)[0]
  if (!next) return
  const [key, e] = next
  const id = r.nextId++
  e.computing = true
  const timer = setTimeout(() => fail("the report took too long", true), TIMEOUT_MS)
  timer.unref()
  r.job = { id, key, startedAt: now, timer }
  thread().postMessage({ id, days: e.days, timeZone: e.timeZone })
}

function thread(): Worker {
  const r = runner()
  if (r.worker) return r.worker
  // A path, not a `new URL(…, import.meta.url)`: this module also runs from Next's bundle of the
  // route. Run by tsx (`npm run dev`, `npm run start`), whose loader the thread inherits.
  const w = new Worker(join(process.cwd(), "services", "usage-worker.ts"))
  w.unref()
  w.on("message", (m: { id: number; report?: UsageReport; error?: string }) => {
    const job = r.job
    if (!job || job.id !== m.id) return
    const e = r.entries.get(job.key)
    if (e) {
      if (m.report) {
        e.report = m.report
        e.at = e.triedAt = Date.now()
        e.durationMs = e.at - job.startedAt
        e.error = null
      } else {
        // Not retried before FRESH_MS: a report that fails fails again on the next poll.
        e.error = m.error ?? "unknown error"
        e.triedAt = Date.now()
      }
      e.computing = false
    }
    clearTimeout(job.timer)
    r.job = null
    pump()
  })
  // Only the current thread's end fails the job: a thread terminated on a timeout exits after its
  // successor took the next one.
  const end = (message: string) => {
    if (r.worker !== w) return
    r.worker = null
    fail(message, false)
  }
  w.on("error", (err) => end(err.message))
  w.on("exit", () => end("the usage thread exited"))
  r.worker = w
  return w
}

/** The running job's report failed with its thread: the next one starts on a new thread. */
function fail(message: string, terminate: boolean) {
  const r = runner()
  const job = r.job
  if (terminate && r.worker) {
    const w = r.worker
    r.worker = null
    void w.terminate()
  }
  if (!job) return
  clearTimeout(job.timer)
  r.job = null
  const e = r.entries.get(job.key)
  if (e) {
    e.error = message
    e.triedAt = Date.now()
    e.computing = false
  }
  console.error(`[usage] ${message}`)
  pump()
}
