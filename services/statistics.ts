import { and, eq, gte, isNotNull } from "drizzle-orm"
import { db } from "../db/index"
import { projectImageBuilds, workerStarts } from "../db/schema"

/**
 * Settings → Statistics (Cloud #802, #803): how long workers take to be usable, and where that
 * time goes. Cloud reads its sandboxes' lifecycle back from OpenObserve; Lite keeps what it measures
 * itself — every start of a worker (`worker_starts`, written by `settleWorkerStart`) and every
 * image build (`project_image_builds.duration_ms`) — and summarizes them here, telemetry or not.
 */

export const STATISTICS_RANGES = ["24h", "7d", "30d", "90d"] as const
export type StatisticsRange = (typeof STATISTICS_RANGES)[number]
const SPAN_MS: Record<StatisticsRange, number> = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5, "90d": 90 * 864e5 }

/**
 * A start's phases, in the order a new worker goes through them: Lite's side (the image, the
 * container, its agent's first hello, the recipe), then the setup script's own stamps.
 */
export const PHASES = ["image", "container", "boot", "recipe", "initializing", "credentials", "shell", "dotfiles", "cloning", "postCreate", "postStart"] as const

/** Nearest-rank percentile, as Cloud's `percentile`. */
export function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(p * s.length) - 1)] ?? 0
}

export type PhaseSummary = { phase: string; count: number; p50Ms: number; p95Ms: number; maxMs: number }

/** The phases measured in these runs, each summarized, in the order a start goes through them. */
export function summarizePhases(runs: { phases: Record<string, number> }[]): PhaseSummary[] {
  const by = new Map<string, number[]>()
  for (const r of runs) for (const [phase, ms] of Object.entries(r.phases)) by.set(phase, [...(by.get(phase) ?? []), ms])
  const order = (phase: string) => {
    const i = (PHASES as readonly string[]).indexOf(phase)
    return i < 0 ? PHASES.length : i
  }
  return [...by]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([phase, v]) => ({ phase, count: v.length, p50Ms: percentile(v, 0.5), p95Ms: percentile(v, 0.95), maxMs: Math.max(...v) }))
}

export function lifecycleStats(range: StatisticsRange, projectId?: string | null) {
  const from = Date.now() - SPAN_MS[range]
  const starts = db
    .select()
    .from(workerStarts)
    .where(and(gte(workerStarts.at, from), projectId ? eq(workerStarts.projectId, projectId) : undefined))
    .orderBy(workerStarts.at)
    .all()
  const ready = starts.filter((s) => s.outcome === "ready")

  // One chart per kind × origin: a start from disk (seconds) and a new worker whose image is built
  // for it (minutes) never share a scale.
  const groups = new Map<string, number[]>()
  for (const s of ready) groups.set(`${s.kind}/${s.origin}`, [...(groups.get(`${s.kind}/${s.origin}`) ?? []), s.totalMs])
  const startSummaries = [...groups].map(([key, v]) => {
    const [kind, origin] = key.split("/") as [string, string]
    return { kind, origin, count: v.length, p50Ms: percentile(v, 0.5), p95Ms: percentile(v, 0.95), failed: starts.filter((s) => s.kind === kind && s.origin === origin && s.outcome === "error").length }
  })

  // A setup is what a new container runs: a spawn or a rebuild. A start of a stopped worker only
  // replays its postStart — counted with the starts, not the setups.
  const setupRuns = ready.filter((s) => s.kind !== "start").map((s) => ({ at: s.at, projectId: s.projectId, totalMs: s.totalMs, phases: s.phases }))

  const builds = db
    .select({ projectId: projectImageBuilds.projectId, state: projectImageBuilds.state, durationMs: projectImageBuilds.durationMs, createdAt: projectImageBuilds.createdAt })
    .from(projectImageBuilds)
    .where(
      and(
        gte(projectImageBuilds.createdAt, new Date(from)),
        isNotNull(projectImageBuilds.durationMs),
        projectId ? eq(projectImageBuilds.projectId, projectId) : undefined,
      ),
    )
    .all()
    .map((b) => ({ at: b.createdAt.getTime() + (b.durationMs ?? 0), projectId: b.projectId, ms: b.durationMs ?? 0, outcome: b.state }))
  const okBuilds = builds.filter((b) => b.outcome === "ready")

  const projectIds = [...new Set([...starts.map((s) => s.projectId), ...builds.map((b) => b.projectId)])]
  const p50 = (v: number[]) => (v.length ? percentile(v, 0.5) : null)
  const projects = projectIds.map((id) => {
    const runs = setupRuns.filter((r) => r.projectId === id)
    return {
      projectId: id,
      setups: runs.length,
      starts: ready.filter((s) => s.projectId === id && s.kind === "start").length,
      setupP50Ms: p50(runs.map((r) => r.totalMs)),
      buildP50Ms: p50(okBuilds.filter((b) => b.projectId === id).map((b) => b.ms)),
      postCreateP50Ms: p50(runs.flatMap((r) => (r.phases.postCreate != null ? [r.phases.postCreate] : []))),
      postStartP50Ms: p50(runs.flatMap((r) => (r.phases.postStart != null ? [r.phases.postStart] : []))),
    }
  })

  return {
    range,
    from,
    to: Date.now(),
    starts: startSummaries,
    startPoints: ready.map((s) => ({ at: s.at, ms: s.totalMs, kind: s.kind, origin: s.origin })),
    setupRuns,
    phases: summarizePhases(setupRuns),
    builds: { count: okBuilds.length, failed: builds.length - okBuilds.length, p50Ms: p50(okBuilds.map((b) => b.ms)), p95Ms: okBuilds.length ? percentile(okBuilds.map((b) => b.ms), 0.95) : null },
    buildPoints: okBuilds.map((b) => ({ at: b.at, ms: b.ms })),
    projects,
  }
}

export type LifecycleStats = ReturnType<typeof lifecycleStats>
