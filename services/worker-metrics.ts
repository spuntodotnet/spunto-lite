import { and, asc, eq, gte, lt, sql } from "drizzle-orm"
import { db } from "../db/index"
import { workerSamples, workers } from "../db/schema"
import { getContainerStats } from "../lib/docker"

/**
 * A worker's CPU and memory **over time** — the History under the live bars of a task's Monitoring
 * block (Cloud c71a888c).
 *
 * Cloud's sandboxes report a heartbeat that the API pushes to OpenObserve and reads back. Lite has
 * no telemetry backend and wants none: it samples `docker stats` itself, every 30 s, for every
 * worker that is up, into SQLite (`worker_samples`), and forgets what is older than the longest
 * range the chart offers (7 days). That is ~2 900 rows a day per running worker — small next to a
 * single session's events. One sampler for the whole process, started with the task scheduler.
 *
 * The cost is one stats call per running container per tick, in parallel; `docker stats` with
 * `stream: false` takes about a second (the daemon waits for a second reading to compute CPU), so a
 * tick never overlaps the next one.
 */

export const SAMPLE_INTERVAL_MS = 30_000
const RETENTION_MS = 7 * 24 * 3600_000
const PRUNE_EVERY_MS = 3600_000

/** The chart's ranges and the bucket each is averaged over — Cloud's `METRIC_RANGES`. */
export const METRIC_RANGES = {
  "1h": [3600_000, 60_000],
  "6h": [6 * 3600_000, 5 * 60_000],
  "24h": [24 * 3600_000, 15 * 60_000],
  "7d": [7 * 24 * 3600_000, 3600_000],
} as const
export type MetricRange = keyof typeof METRIC_RANGES

export function isMetricRange(value: string | null): value is MetricRange {
  return value !== null && value in METRIC_RANGES
}

/** One bucket of the history: averages, plus the CPU peak an average would hide. */
export type MetricPoint = {
  t: string
  cpuPercent: number | null
  cpuPercentMax: number | null
  memUsedMb: number | null
  memTotalMb: number | null
}

/** Take one sample of every running worker. Exported for tests and for a manual tick. */
export async function sampleWorkers(now = Date.now()): Promise<number> {
  const running = db
    .select({ id: workers.id, containerId: workers.containerId })
    .from(workers)
    .where(eq(workers.state, "ready"))
    .all()
    .filter((w): w is { id: string; containerId: string } => !!w.containerId)
  if (running.length === 0) return 0
  const samples = await Promise.all(
    running.map(async (w) => {
      const stats = await getContainerStats(w.containerId).catch(() => null)
      // A daemon that answers with no memory limit (some cgroup v2 setups) still has usage worth
      // drawing; a container that vanished between the select and the call has nothing.
      return stats ? { workerId: w.id, ts: new Date(now), cpuPercent: stats.cpuPercent, memUsedMb: stats.memUsageMb, memTotalMb: stats.memLimitMb } : null
    }),
  )
  const rows = samples.filter((s) => s !== null)
  if (rows.length > 0) db.insert(workerSamples).values(rows).run()
  return rows.length
}

/** Forget what no range reaches any more — and the samples of deleted workers with it, in time. */
export function pruneWorkerSamples(now = Date.now()): number {
  return db.delete(workerSamples).where(lt(workerSamples.ts, new Date(now - RETENTION_MS))).run().changes
}

/** A worker's history over `range`, averaged per bucket, oldest first. Empty buckets are absent. */
export function workerMetrics(workerId: string, range: MetricRange, now = Date.now()): MetricPoint[] {
  const [span, bucket] = METRIC_RANGES[range]
  // Spliced, not bound: better-sqlite3 binds a JS number as a REAL, and `ts / 60000.0` is no
  // bucket — every sample would be its own point. `bucket` is one of the constants above.
  const slot = sql<number>`(${workerSamples.ts} / ${sql.raw(String(bucket))}) * ${sql.raw(String(bucket))}`
  const round1 = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10)
  return db
    .select({
      t: slot,
      cpu: sql<number>`avg(${workerSamples.cpuPercent})`,
      cpuMax: sql<number>`max(${workerSamples.cpuPercent})`,
      mem: sql<number>`avg(${workerSamples.memUsedMb})`,
      memTotal: sql<number>`max(${workerSamples.memTotalMb})`,
    })
    .from(workerSamples)
    .where(and(eq(workerSamples.workerId, workerId), gte(workerSamples.ts, new Date(now - span))))
    .groupBy(slot)
    .orderBy(asc(slot))
    .all()
    .map((r) => ({
      t: new Date(Number(r.t)).toISOString(),
      cpuPercent: round1(r.cpu),
      cpuPercentMax: round1(r.cpuMax),
      memUsedMb: round1(r.mem),
      // 0 is "no limit known", not a ceiling to draw.
      memTotalMb: Number(r.memTotal) > 0 ? round1(r.memTotal) : null,
    }))
}

let sampler: ReturnType<typeof setInterval> | null = null

export function startWorkerMetricsSampler(intervalMs = SAMPLE_INTERVAL_MS): void {
  if (sampler) return
  let busy = false
  let lastPrune = 0
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await sampleWorkers()
      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now()
        pruneWorkerSamples()
      }
    } catch (err) {
      console.warn(`[metrics] worker sampling failed: ${err}`)
    } finally {
      busy = false
    }
  }
  sampler = setInterval(() => void tick(), intervalMs)
  sampler.unref?.()
  void tick()
}
