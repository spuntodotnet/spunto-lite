import { test, expect } from "@playwright/test"

// The build-step protocol, from Lite's side of it.
//
// The markers, the tracker and the plan all live in `@spunto/build/steps`, which has its own unit
// tests. What cannot be tested there is the wiring: that the plan `buildImageScript` returns is
// persisted next to the build, that it survives the round-trip through SQLite's JSON column and
// `/builds`, and that no marker ever reaches a reader as raw text.
//
// Deliberately asserts the *plan*, not the outcome — the plan is written before the daemon is
// touched, so this runs in CI, where there is no Docker socket and every build fails at the pull.

const IMAGE = "spunto-lite.invalid/no-such-image:0"

test.describe("build steps", () => {
  let projectId = ""

  test.beforeEach(async ({ request }) => {
    const res = await request.post("/api/projects", {
      data: { name: `e2e-steps-${Date.now()}`, image: IMAGE },
    })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterEach(async ({ request }) => {
    if (projectId) await request.delete(`/api/projects/${projectId}`)
  })

  test("a build records the blocks it is made of, in order", async ({ request }) => {
    expect((await request.post(`/api/projects/${projectId}/build`)).status()).toBe(202)

    // The plan is written as soon as the build row exists, before the daemon is touched.
    await expect
      .poll(
        async () => {
          const builds = await (await request.get(`/api/projects/${projectId}/builds`)).json()
          return builds[0]?.steps?.length ?? 0
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0)
    const [build] = await (await request.get(`/api/projects/${projectId}/builds`)).json()

    // Every image is made of the same two features before the project's own, so the plan is
    // knowable before a single line is logged — which is the whole reason it is stored rather
    // than parsed back out of the log afterwards.
    const labels = build.steps.map((s: { label: string }) => s.label)
    expect(labels).toEqual(["Bootstrap", "common-utils", "spunto-pack", "Finalizing image"])

    // The OCI refs ride along as the second line of each block: what a feature *is*, not just
    // that it ran.
    const byLabel = Object.fromEntries(build.steps.map((s: { label: string }) => [s.label, s]))
    expect(byLabel["common-utils"].detail).toBe("ghcr.io/devcontainers/features/common-utils:2")
    expect(byLabel["spunto-pack"].detail).toBe("ghcr.io/coderhammer/features/spunto-pack:1")
    expect(byLabel["common-utils"].kind).toBe("feature")

    // A block is one of the five states the design system draws, never a raw marker id.
    for (const s of build.steps) {
      expect(["pending", "running", "done", "error", "skipped"]).toContain(s.state)
    }
  })

  test("markers never reach a reader as raw text", async ({ request }) => {
    expect((await request.post(`/api/projects/${projectId}/build`)).status()).toBe(202)

    // This image cannot be pulled, so the build fails — which is the interesting case: the
    // tracker has to close the list out *and* flush whatever it was holding back, rather than
    // swallow a partial line or leak the marker it was still matching.
    await expect
      .poll(
        async () => {
          const builds = await (await request.get(`/api/projects/${projectId}/builds`)).json()
          return builds[0]?.state
        },
        { timeout: 60_000 },
      )
      .toBe("error")

    const [build] = await (await request.get(`/api/projects/${projectId}/builds`)).json()
    expect(build.logs).not.toContain("::spunto:step:")
    // Nothing was reached, and a build that never ran a block must not claim it did.
    expect(build.steps.every((s: { state: string }) => s.state !== "done")).toBe(true)
  })
})
