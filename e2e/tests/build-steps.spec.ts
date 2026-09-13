import { test, expect } from "@playwright/test"

import { applyBuildLog, planBuildSteps, planFromLog, stampBuildSteps } from "../../lib/build-steps"

// Pure tests, no server: `lib/build-steps.ts` is the whole contract between a build log and the
// design system's `BuildSteps`. It runs on both sides — the server stamps it as the build goes,
// the client re-derives it for builds recorded before the `steps` column existed — so what it
// does to a given log is worth pinning down directly rather than through a rendered panel.

const FEATURES = [{ id: "claude-code", ociRef: "ghcr.io/x/claude-code:1" }]

const stateOf = (steps: { id: string; state: string }[], id: string) => steps.find((s) => s.id === id)?.state

test.describe("build steps", () => {
  test("the plan is fully pending before a single line is logged", () => {
    const steps = planBuildSteps({ image: "node:24", features: FEATURES, vscodeExtensions: ["a.b"] })
    // Base image, runtime, the feature, extensions, finalize — the table of contents of the image.
    expect(steps.map((s) => s.id)).toEqual(["image", "runtime", "feature:claude-code", "extensions", "finalize"])
    expect(steps.every((s) => s.state === "pending")).toBe(true)
  })

  test("a feature with no OCI ref is skipped up front, not left pending forever", () => {
    const steps = planBuildSteps({ image: "node:24", features: [{ id: "orphan" }] })
    // The install script drops it outright, so no log line will ever move it along.
    expect(stateOf(steps, "feature:orphan")).toBe("skipped")
  })

  test("a log walks the plan forward", () => {
    const plan = planBuildSteps({ image: "node:24", features: FEATURES })
    const mid = applyBuildLog(
      plan,
      ["Step 1/3 : FROM node:24", "Step 2/3 : COPY script.sh /tmp/x", "Step 3/3 : RUN bash /tmp/x", "[build] Installing feature: claude-code..."].join("\n"),
      "building"
    )
    expect(stateOf(mid, "image")).toBe("done")
    expect(stateOf(mid, "runtime")).toBe("done")
    expect(stateOf(mid, "feature:claude-code")).toBe("running")
    expect(stateOf(mid, "finalize")).toBe("pending")
  })

  test("a failed build errors where it stopped and skips what it never reached", () => {
    const plan = planBuildSteps({ image: "nope.invalid/x:0", features: FEATURES })
    const steps = applyBuildLog(plan, 'Step 1/3 : FROM nope.invalid/x:0\n[build] ERROR: failed to resolve reference', "error")
    expect(stateOf(steps, "image")).toBe("error")
    // Not "pending": the build is over, these will never run.
    expect(stateOf(steps, "feature:claude-code")).toBe("skipped")
    expect(stateOf(steps, "finalize")).toBe("skipped")
  })

  test("a failing feature is the one that errors, and the build stops there", () => {
    const plan = planBuildSteps({ image: "node:24", features: FEATURES })
    const steps = applyBuildLog(
      plan,
      ["Step 3/3 : RUN bash /tmp/x", "[build] Installing feature: claude-code...", "[feature] claude-code FAILED (exit 1)"].join("\n"),
      "error"
    )
    expect(stateOf(steps, "runtime")).toBe("done")
    expect(stateOf(steps, "feature:claude-code")).toBe("error")
  })

  test("a feature the plan never listed is appended rather than dropped", () => {
    // `buildImageScript` is free to change — a branch that rewrites it must degrade to "the
    // plan was incomplete", never to a block silently missing from the list.
    const plan = planBuildSteps({ image: "node:24", features: [] })
    const steps = applyBuildLog(plan, "Step 3/3 : RUN bash /tmp/x\n[build] Installing feature: surprise...", "building")
    expect(steps.map((s) => s.id)).toEqual(["image", "runtime", "feature:surprise", "finalize"])
    // And before finalize, not after it.
    expect(steps.findIndex((s) => s.id === "feature:surprise")).toBeLessThan(steps.findIndex((s) => s.id === "finalize"))
  })

  // ── Backward compatibility: builds stored before the `steps` column existed ──

  test("a pre-upgrade build is redrawn from its log alone", () => {
    const logs = [
      "Step 1/3 : FROM mcr.microsoft.com/devcontainers/javascript-node:20",
      "Step 2/3 : COPY script.sh /tmp/x",
      "Step 3/3 : RUN bash /tmp/x",
      "[build] Installing code-server...",
      "[build] Installing feature: claude-code...",
      "[feature] claude-code installed",
      "[build] Image build complete",
    ].join("\n")

    const steps = applyBuildLog(planFromLog(logs), logs, "ready")
    expect(steps.map((s) => s.id)).toEqual(["image", "runtime", "feature:claude-code", "finalize"])
    expect(steps.every((s) => s.state === "done")).toBe(true)
    // The base image ref survives, read back out of the FROM line.
    expect(steps[0].detail).toBe("mcr.microsoft.com/devcontainers/javascript-node:20")
    // No clock in a log, so no durations — the panel draws the blocks without them.
    expect(steps.every((s) => !s.startedAt && !s.completedAt)).toBe(true)
  })

  test("an empty log still yields a readable shape rather than throwing", () => {
    const steps = applyBuildLog(planFromLog(""), "", "building")
    expect(steps.map((s) => s.id)).toEqual(["image", "runtime", "finalize"])
    expect(steps.every((s) => s.state === "pending")).toBe(true)
  })

  // ── Stamping ──

  test("timings are sticky across snapshots of a growing log", () => {
    const plan = planBuildSteps({ image: "node:24", features: FEATURES })
    const runLog = "Step 3/3 : RUN bash /tmp/x\n[build] Installing feature: claude-code..."

    const first = stampBuildSteps(plan, applyBuildLog(plan, runLog, "building"), "2026-01-01T00:00:00.000Z")
    const started = first.find((s) => s.id === "feature:claude-code")!.startedAt

    // Same log, later snapshot: a block that already started must not be re-dated.
    const second = stampBuildSteps(first, applyBuildLog(first, runLog, "building"), "2026-01-01T00:05:00.000Z")
    expect(second.find((s) => s.id === "feature:claude-code")!.startedAt).toBe(started)

    const done = stampBuildSteps(
      second,
      applyBuildLog(second, `${runLog}\n[feature] claude-code installed`, "building"),
      "2026-01-01T00:10:00.000Z"
    )
    const step = done.find((s) => s.id === "feature:claude-code")!
    expect(step.state).toBe("done")
    expect(step.startedAt).toBe(started)
    expect(step.completedAt).toBe("2026-01-01T00:10:00.000Z")
  })

  test("a skipped block is never given a duration", () => {
    const plan = planBuildSteps({ image: "node:24", features: [{ id: "orphan" }] })
    const steps = stampBuildSteps(plan, applyBuildLog(plan, "", "building"), "2026-01-01T00:00:00.000Z")
    const orphan = steps.find((s) => s.id === "feature:orphan")!
    // It never ran, so dating it would draw elapsed time for work that did not happen.
    expect(orphan.completedAt).toBeUndefined()
  })
})
