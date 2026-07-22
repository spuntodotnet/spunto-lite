import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"

// Full worker lifecycle against a REAL Docker daemon: create a project → spawn a worker →
// poll until it reaches "ready" → stop → delete. This is the one suite that needs the control
// plane to have a working Docker socket, and the first spawn of a fresh project pulls/builds a
// devcontainer image (minutes). It is therefore OPT-IN: set E2E_DOCKER=1 to run it. Not run in CI.
//
// HTTP-only (no browser), but isolated in its own Playwright project for the 10-min timeout.

const RUN = process.env.E2E_DOCKER === "1"
const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"

async function poll<T>(fn: () => Promise<T>, until: (v: T) => boolean, timeoutMs: number, everyMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  do {
    last = await fn()
    if (until(last)) return last
    await new Promise((r) => setTimeout(r, everyMs))
  } while (Date.now() < deadline)
  return last
}

async function workerState(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`/api/workers/${id}`)
  expect(res.status()).toBe(200)
  return (await res.json()).state
}

test.describe("worker lifecycle (Docker)", () => {
  test.skip(!RUN, "Set E2E_DOCKER=1 to run — needs a real Docker socket and pulls a large image.")

  let projectId: string
  let workerId: string

  test.beforeAll(async ({ request }) => {
    const res = await request.post("/api/projects", { data: { name: `e2e-worker-${Date.now()}`, image: IMAGE } })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterAll(async ({ request }) => {
    if (workerId) await request.delete(`/api/workers/${workerId}`).catch(() => {})
    if (projectId) await request.delete(`/api/projects/${projectId}`).catch(() => {})
  })

  test("spawn → ready → stop → delete", async ({ request }) => {
    // Spawn.
    const spawn = await request.post(`/api/projects/${projectId}/workers`, { data: {} })
    expect(spawn.status(), await spawn.text()).toBe(201)
    workerId = (await spawn.json()).id
    expect(workerId).toBeTruthy()

    // Poll until ready (or error).
    const ready = await poll(
      () => workerState(request, workerId),
      (s) => s === "ready" || s === "error",
      9 * 60_000,
    )
    expect(ready, "worker should reach ready, not error").toBe("ready")

    // Stop.
    const stop = await request.post(`/api/workers/${workerId}/stop`)
    expect(stop.status()).toBe(200)
    const stopped = await poll(() => workerState(request, workerId), (s) => s === "stopped", 60_000)
    expect(stopped).toBe("stopped")

    // Delete → 204, then 404.
    const del = await request.delete(`/api/workers/${workerId}`)
    expect(del.status()).toBe(204)
    expect((await request.get(`/api/workers/${workerId}`)).status()).toBe(404)
    workerId = "" // deleted; skip afterAll cleanup
  })
})
