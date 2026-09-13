/**
 * An image build as a list of blocks, derived from the build log.
 *
 * The log is the source of truth — every state here comes from a line `buildImageScript`
 * already printed, so nothing new has to be threaded through the Docker build stream. What the
 * *project* adds is the part a log cannot have yet: the blocks that haven't run. Hence two
 * entry points, `planBuildSteps` (what this build is going to do) and `applyBuildLog` (how far
 * it got), and a third, `planFromLog`, for builds recorded before any of this existed.
 *
 * The plan is a prediction, not a contract. A log line naming a feature the plan didn't list
 * appends it rather than being ignored, so a change to `buildImageScript` — or a branch that
 * rewrites it, like the spunto-pack one — degrades to "the plan was incomplete" instead of
 * "the build silently stalled on step 2".
 */

export type BuildStepKind = "image" | "runtime" | "feature" | "extensions" | "finalize"
export type BuildStepState = "pending" | "running" | "done" | "error" | "skipped"

/** Structurally the design system's `BuildStepItem` — passed to `BuildSteps` as-is. */
export type BuildStep = {
  id: string
  label: string
  kind: BuildStepKind
  detail?: string
  state: BuildStepState
  startedAt?: string
  completedAt?: string
}

type PlanInput = {
  image: string
  /**
   * Every feature the build installs, in order — `imageFeatures()` from `setup-script.ts`, which
   * is the same list the script itself is generated from. Passed in rather than imported so this
   * module stays free of the script builder: half of it runs in the browser, for old builds.
   */
  features: { id: string; ociRef?: string }[]
  vscodeExtensions?: string[]
}

const IMAGE_STEP_ID = "image"
const RUNTIME_STEP_ID = "runtime"
const EXTENSIONS_STEP_ID = "extensions"
const FINALIZE_STEP_ID = "finalize"

const featureStepId = (id: string) => `feature:${id}`

/** Printed only by the pre-spunto-pack script, which installed code-server and tmux itself. */
const LEGACY_RUNTIME_MARKER = /^\[build\] Installing (code-server|tmux)\.\.\.$/m

/** The blocks `buildImageScript` will run for this project, all still `pending`. */
export function planBuildSteps(project: PlanInput): BuildStep[] {
  // No block for the editor and the terminal: they are not a step of their own any more, they
  // are what `spunto-pack` installs, and it is in the list below like any other feature.
  const steps: BuildStep[] = [
    { id: IMAGE_STEP_ID, kind: "image", label: "Pull base image", detail: project.image, state: "pending" },
  ]

  for (const f of project.features) {
    steps.push({
      id: featureStepId(f.id),
      kind: "feature",
      label: f.id,
      detail: f.ociRef,
      // The install script skips a feature with no OCI ref outright, so it is known-skipped
      // before the build starts rather than a block that will never light up.
      state: f.ociRef ? "pending" : "skipped",
    })
  }

  const extensions = project.vscodeExtensions ?? []
  if (extensions.length > 0) {
    steps.push({
      id: EXTENSIONS_STEP_ID,
      kind: "extensions",
      label: "VS Code extensions",
      detail: `${extensions.length} extension${extensions.length > 1 ? "s" : ""}`,
      state: "pending",
    })
  }

  steps.push({ id: FINALIZE_STEP_ID, kind: "finalize", label: "Finalize image", state: "pending" })
  return steps
}

/**
 * The plan a log reveals on its own, for builds stored before steps were.
 *
 * Only ever as complete as the log: a build that died at its third feature mentions three, so
 * the blocks it never reached cannot be drawn. That is the whole difference with a planned
 * build, and the reason the plan is worth storing rather than re-deriving from the log.
 */
export function planFromLog(logs: string): BuildStep[] {
  const steps: BuildStep[] = [
    { id: IMAGE_STEP_ID, kind: "image", label: "Pull base image", detail: baseImageFromLog(logs), state: "pending" },
  ]

  // Releases before spunto-pack installed the editor and the terminal inline, with no feature of
  // their own — that stretch of the build is only nameable from the marker it printed. Absent on
  // any recent log, where the same work is `spunto-pack` and shows up as a feature below.
  if (LEGACY_RUNTIME_MARKER.test(logs)) {
    steps.push({
      id: RUNTIME_STEP_ID,
      kind: "runtime",
      label: "Editor and terminal",
      detail: "code-server, tmux",
      state: "pending",
    })
  }

  for (const id of featureIdsInLog(logs)) {
    steps.push({ id: featureStepId(id), kind: "feature", label: id, state: "pending" })
  }

  if (logs.includes("[build] Installing VS Code extensions...")) {
    steps.push({ id: EXTENSIONS_STEP_ID, kind: "extensions", label: "VS Code extensions", state: "pending" })
  }

  steps.push({ id: FINALIZE_STEP_ID, kind: "finalize", label: "Finalize image", state: "pending" })
  return steps
}

/** `Step 1/3 : FROM node:24-slim` → `node:24-slim`. */
function baseImageFromLog(logs: string): string | undefined {
  return /^Step \d+\/\d+ : FROM (.+)$/m.exec(logs)?.[1]?.trim()
}

/** Every feature the log says the build started installing, in log order. */
function featureIdsInLog(logs: string): string[] {
  const ids: string[] = []
  for (const m of logs.matchAll(/^\[build\] Installing feature: (.+?)\.\.\.$/gm)) {
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

/**
 * The states `logs` implies for `plan`. Pure — no clock, no I/O: the caller decides whether the
 * result is stamped (a live build) or shown as-is (an old one).
 *
 * `buildState` closes the list out. A log has no line for "and then nothing else happened", so
 * the block that was mid-flight when a build failed reads as still running until the build's own
 * verdict says otherwise, and the blocks after it are skipped rather than left pending forever.
 */
export function applyBuildLog(
  plan: BuildStep[],
  logs: string,
  buildState: "building" | "ready" | "error"
): BuildStep[] {
  const steps = plan.map((s) => ({ ...s }))
  const byId = new Map(steps.map((s) => [s.id, s]))

  // Anything the log names that the plan didn't — see the prediction/contract note above.
  for (const id of featureIdsInLog(logs)) {
    if (byId.has(featureStepId(id))) continue
    const step: BuildStep = { id: featureStepId(id), kind: "feature", label: id, state: "pending" }
    // Before `extensions`/`finalize`, which always come last in the script.
    const tail = steps.findIndex((s) => s.id === EXTENSIONS_STEP_ID || s.id === FINALIZE_STEP_ID)
    steps.splice(tail === -1 ? steps.length : tail, 0, step)
    byId.set(step.id, step)
  }

  const set = (id: string, state: BuildStepState) => {
    const step = byId.get(id)
    // Never walk a block back out of a terminal state: `skipped` is decided up front, and a
    // feature that FAILED still prints nothing afterwards to contradict it.
    if (step && step.state !== "skipped" && step.state !== "error") step.state = state
  }

  // ── Base image: the FROM layer, up to the COPY that follows it.
  if (/^Step \d+\/\d+ : FROM /m.test(logs)) set(IMAGE_STEP_ID, "running")
  if (/^Step \d+\/\d+ : (COPY|RUN) /m.test(logs)) set(IMAGE_STEP_ID, "done")

  // ── Runtime: everything between the start of the RUN layer and the first feature. It has no
  // "finished" line of its own — code-server and tmux are each installed only if missing, so on
  // a base image that ships them the block prints nothing at all. What ends it is the next
  // block starting, or the build reaching its last line.
  const runStarted = /^Step \d+\/\d+ : RUN /m.test(logs)
  const firstFeature = featureIdsInLog(logs)[0]
  const runtimeOver =
    (firstFeature != null && logs.includes(`[build] Installing feature: ${firstFeature}...`)) ||
    logs.includes("[build] Installing VS Code extensions...") ||
    logs.includes("[build] Image build complete")
  if (runStarted) set(RUNTIME_STEP_ID, runtimeOver ? "done" : "running")

  // ── Features.
  for (const step of steps) {
    if (step.kind !== "feature") continue
    const id = step.label
    if (logs.includes(`[feature] ${id} FAILED`)) set(step.id, "error")
    else if (logs.includes(`[feature] ${id} installed`)) set(step.id, "done")
    else if (logs.includes(`[build] Installing feature: ${id}...`)) set(step.id, "running")
  }

  // ── Extensions. A failed extension does not fail the build (the image still ships), but the
  // block did not do what it was asked, so it reads as an error rather than a quiet success.
  if (byId.has(EXTENSIONS_STEP_ID)) {
    if (logs.includes("[build] WARNING: VS Code extension(s) that failed to install:")) set(EXTENSIONS_STEP_ID, "error")
    else if (logs.includes("[build] All VS Code extensions installed")) set(EXTENSIONS_STEP_ID, "done")
    else if (logs.includes("[build] Installing VS Code extensions...")) set(EXTENSIONS_STEP_ID, "running")
  }

  // ── Finalize: the last line of the script, then Docker committing the image.
  if (logs.includes("[build] Image build complete")) {
    set(FINALIZE_STEP_ID, buildState === "building" ? "running" : "done")
  } else if (runStarted && steps.every((s) => s.kind !== "feature" || s.state !== "pending")) {
    // Still inside the RUN layer with every feature accounted for — finalize is next, not done.
    if (buildState !== "building") set(FINALIZE_STEP_ID, buildState === "ready" ? "done" : "pending")
  }

  if (buildState === "ready") {
    for (const s of steps) if (s.state === "pending" || s.state === "running") s.state = "done"
  } else if (buildState === "error") {
    for (const s of steps) {
      if (s.state === "running") s.state = "error"
      else if (s.state === "pending") s.state = "skipped"
    }
  }

  return steps
}

/**
 * Carries timings across two snapshots of the same build: `startedAt` the first time a block
 * runs, `completedAt` the first time it settles. Both are sticky — re-deriving the states from a
 * log that has only grown must not re-date a block that already ran.
 */
export function stampBuildSteps(previous: BuildStep[], next: BuildStep[], now: string): BuildStep[] {
  const before = new Map(previous.map((s) => [s.id, s]))
  return next.map((step) => {
    const prev = before.get(step.id)
    const startedAt = prev?.startedAt ?? (step.state === "pending" ? undefined : now)
    const settled = step.state === "done" || step.state === "error" || step.state === "skipped"
    // `skipped` is a verdict, not work: dating it would draw a duration for a block that never ran.
    const completedAt = prev?.completedAt ?? (settled && step.state !== "skipped" ? now : undefined)
    return { ...step, ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}) }
  })
}
