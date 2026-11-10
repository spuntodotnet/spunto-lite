import type { SetupStatus } from "../db/schema"
import type { BuildStep } from "../lib/types"
import { track } from "../lib/telemetry"

/**
 * How long a worker takes to come up, and where the time goes — for the opt-in telemetry
 * (lib/telemetry.ts). Two halves stitched together:
 *
 *  - **Lite's side**, marked here as the spawn pipeline (services/workers.ts) enters each phase:
 *    `image` (built, or found in the cache), `container` (created and started), `boot` (the
 *    container is up, waiting for its agent's first hello), `recipe` (the agent has its plan: it
 *    bakes what the image lacks, then starts the setup script).
 *  - **The container's side**, which the setup script stamps itself as it enters each phase, in
 *    `setupStatus.timings`
 *    (`initializing`, `credentials`, `shell`, `dotfiles`, `cloning`, `postCreate`, `postStart`,
 *    `ready`), and which reaches us with the status.
 *
 * A run starts with a spawn, a rebuild or a start, and is settled the first time the worker reads
 * `ready` or `error`: one `worker.start` event with the total and every phase as a column, and
 * one `worker.start_phase` per segment (what a "group by phase" wants). Runs are kept in memory —
 * a start that a Lite restart interrupts is simply not reported. Nothing is recorded when
 * telemetry is off, since `track` drops it.
 */

export type StartKind = "spawn" | "rebuild" | "start"

type Run = {
  kind: StartKind
  projectId: string
  t0: number
  /** Lite-side milestones, in the order they were passed: name → ms epoch. */
  marks: [string, number][]
  attrs: Record<string, string | number | boolean | null>
}

// On `globalThis`, like lib/agent.ts: the pipeline runs in Next's module graph (the routes that
// spawn), the agent's hello and its status arrive in server.ts's.
const KEY = Symbol.for("spunto-lite.start-timings")
function runs(): Map<string, Run> {
  const g = globalThis as typeof globalThis & { [KEY]?: Map<string, Run> }
  return (g[KEY] ??= new Map())
}

/** The container's clock is the host's, but Docker Desktop's VM can drift a little behind. */
const CLOCK_SKEW_MS = 2_000

export function beginWorkerStart(workerId: string, kind: StartKind, projectId: string): void {
  runs().set(workerId, { kind, projectId, t0: Date.now(), marks: [], attrs: {} })
}

/** The worker enters a Lite-side phase — `image`, `container`, `boot`, `recipe` — with what is known. */
export function markWorkerStart(workerId: string, mark: string, attrs: Run["attrs"] = {}): void {
  const run = runs().get(workerId)
  if (!run) return
  // The first time only: an agent that reconnects mid-setup must not move its first hello.
  if (!run.marks.some(([m]) => m === mark)) run.marks.push([mark, Date.now()])
  Object.assign(run.attrs, attrs)
}

/** Stop timing without reporting: the worker was stopped or deleted before it came up. */
export function dropWorkerStart(workerId: string): void {
  runs().delete(workerId)
}

/**
 * The worker reached `ready` or `error`: report the run, if one is open. Called by every path that
 * settles a worker's state (the agent's status, the exec path's poll, a spawn that threw).
 */
export function settleWorkerStart(workerId: string, outcome: "ready" | "error", setup: SetupStatus | null): void {
  const run = runs().get(workerId)
  if (!run) return
  runs().delete(workerId)
  const now = Date.now()

  // Every phase start on one line: Lite's, then the container's own — those of *this* start only,
  // since a restarted container keeps the stamps of the setup before. Each phase lasts until the
  // next one starts; `ready` (stamped inside, or now) closes the last.
  const inside = Object.entries(setup?.timings ?? {})
    .filter(([, t]) => typeof t === "number" && t >= run.t0 - CLOCK_SKEW_MS)
    .sort((a, b) => a[1] - b[1])
  const points: [string, number][] = [...run.marks, ...inside].sort((a, b) => a[1] - b[1])
  const end = points.findIndex(([m]) => m === "ready")
  const endsAt = end >= 0 ? points[end][1] : now
  const open = end >= 0 ? points.slice(0, end) : points

  const phases = open.map(([phase, t], i) => ({ phase, ms: Math.max(0, (open[i + 1]?.[1] ?? endsAt) - t) }))
  const total = Math.max(0, endsAt - run.t0)
  const common = { kind: run.kind, outcome, project_id: run.projectId, worker_id: workerId }
  track(
    "worker.start",
    {
      ...common,
      ...run.attrs,
      total_ms: total,
      failed_phase: outcome === "error" ? (setup?.phase ?? null) : null,
      ...Object.fromEntries(phases.map((p) => [`phase_${p.phase.replace(/[^a-z0-9]/gi, "_")}_ms`, p.ms])),
    },
    outcome === "error" ? "WARN" : "INFO",
  )
  phases.forEach((p, i) => track("worker.start_phase", { ...common, phase: p.phase, order: i, duration_ms: p.ms }))
}

// ─── Image builds ────────────────────────────────────────────────────────────

/**
 * A finished image build: one `image.build` with the total, one `image.build_step` per block of
 * the recipe (the base image, the runtime, each feature, the extensions…), from the timestamps the
 * step tracker stamps as it reads the markers out of the log.
 */
export function reportImageBuild(b: {
  buildId: string
  projectId: string
  version: number
  forced: boolean
  trigger: "spawn" | "manual"
  outcome: "ready" | "error"
  durationMs: number
  steps: BuildStep[]
}): void {
  const ms = (s: BuildStep) =>
    s.startedAt && s.completedAt ? Math.max(0, Date.parse(s.completedAt) - Date.parse(s.startedAt)) : null
  const common = { build_id: b.buildId, project_id: b.projectId, outcome: b.outcome }
  const stepsMs = b.steps.reduce((sum, s) => sum + (ms(s) ?? 0), 0)
  track(
    "image.build",
    {
      ...common,
      version: b.version,
      forced: b.forced,
      trigger: b.trigger,
      duration_ms: b.durationMs,
      steps: b.steps.length,
      // What no step covers: pulling the base image before the first marker, committing the layer
      // after the last — often the bigger half of a build.
      outside_steps_ms: Math.max(0, b.durationMs - stepsMs),
      steps_done: b.steps.filter((s) => s.state === "done").length,
      failed_step: b.steps.find((s) => s.state === "error")?.id ?? null,
    },
    b.outcome === "error" ? "WARN" : "INFO",
  )
  b.steps.forEach((s, i) =>
    track("image.build_step", { ...common, step: s.id, label: s.label, step_kind: s.kind, state: s.state, order: i, duration_ms: ms(s) }),
  )
}
