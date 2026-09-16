import { test, expect } from "@playwright/test"

// The persistent-terminal API, from the side that needs no Docker.
//
// The dtach scripts themselves are `@spunto/build/terminal` and tested there. What is Lite's is
// the wiring: that a worker with no container answers instead of throwing, and that killing a
// session is idempotent — both hit by the UI on a workspace that is still starting, which is
// exactly when nothing exists to talk to.

test.describe("terminal sessions", () => {
  let projectId = ""
  let workerId = ""

  test.beforeEach(async ({ request }) => {
    const p = await request.post("/api/projects", {
      data: { name: `e2e-term-${Date.now()}`, image: "spunto-lite.invalid/no-such-image:0" },
    })
    expect(p.status(), await p.text()).toBe(201)
    projectId = (await p.json()).id
    // Spawning fails at the pull, which is the point: the worker row exists with no container.
    const w = await request.post(`/api/projects/${projectId}/workers`, { data: {} })
    expect(w.status(), await w.text()).toBe(201)
    workerId = (await w.json()).id
  })

  test.afterEach(async ({ request }) => {
    if (projectId) await request.delete(`/api/projects/${projectId}`)
  })

  test("a workspace with no container lists no session rather than failing", async ({ request }) => {
    const res = await request.get(`/api/workers/${workerId}/sessions`)
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("killing a session is idempotent, container or not", async ({ request }) => {
    // The tab strip fires this on a tab the user closed; a 404 here would surface as a toast for
    // something that already is how the user wants it.
    expect((await request.delete(`/api/workers/${workerId}/sessions/main`)).status()).toBe(204)
    expect((await request.delete(`/api/workers/${workerId}/sessions/main`)).status()).toBe(204)
  })

  test("creating one on a workspace with no container is refused, not crashed", async ({ request }) => {
    const res = await request.post(`/api/workers/${workerId}/sessions`)
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBeTruthy()
  })
})
