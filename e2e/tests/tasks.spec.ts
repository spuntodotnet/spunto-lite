import { test, expect } from "@playwright/test"

// Delegated work over plain HTTP: validation, the shapes the cockpit reads, and the refusals that
// stop a click from doing the wrong thing. No Docker: a task whose project has an unbuildable image
// fails on its way to a worker, which is all these need. The full cycle on a real container is
// tasks-lifecycle.spec.ts (opt-in, E2E_DOCKER=1).

const IMAGE = "spunto-lite.invalid/no-such-image:0"

async function project(request: import("@playwright/test").APIRequestContext, overrides: Record<string, unknown> = {}) {
  const res = await request.post("/api/projects", { data: { name: `e2e-tasks-${Date.now()}`, image: IMAGE, ...overrides } })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

test.describe("tasks API", () => {
  test("a project starts on the default harness, and its task settings save without a new version", async ({ request }) => {
    const p = await project(request)
    expect(p.taskAgentProtocol).toBe("claude-stream")
    expect(p.taskReviewMode).toBe("keep")
    expect(p.taskAgentCommand).toBeNull()

    const res = await request.patch(`/api/projects/${p.id}`, {
      data: { taskAgentModel: "claude-opus-5-5", taskReviewMode: "stop", taskValidateCommand: "  echo ok  " },
    })
    expect(res.status()).toBe(200)
    const updated = await res.json()
    expect(updated.taskAgentModel).toBe("claude-opus-5-5")
    expect(updated.taskReviewMode).toBe("stop")
    expect(updated.taskValidateCommand).toBe("echo ok")
    // Nothing here goes into the image, so nothing marks the workers out of date.
    expect(updated.currentVersion).toBe(p.currentVersion)

    // Blank = back to the default.
    const cleared = await (await request.patch(`/api/projects/${p.id}`, { data: { taskAgentModel: "" } })).json()
    expect(cleared.taskAgentModel).toBeNull()

    // And they travel in the portable spec.
    const spec = await (await request.get(`/api/projects/${p.id}/export`)).json()
    expect(spec.project.taskReviewMode).toBe("stop")
    expect(spec.project.taskValidateCommand).toBe("echo ok")
    await request.delete(`/api/projects/${p.id}`)
  })

  test("rejects a bad protocol, an empty prompt and an invalid base branch", async ({ request }) => {
    const p = await project(request)
    expect((await request.patch(`/api/projects/${p.id}`, { data: { taskAgentProtocol: "telepathy" } })).status()).toBe(400)
    expect((await request.post(`/api/projects/${p.id}/tasks`, { data: { prompt: "   " } })).status()).toBe(400)
    expect((await request.post(`/api/projects/${p.id}/tasks`, { data: { prompt: "x", baseBranch: "a..b" } })).status()).toBe(400)
    expect((await request.post(`/api/projects/does-not-exist/tasks`, { data: { prompt: "x" } })).status()).toBe(404)
    await request.delete(`/api/projects/${p.id}`)
  })

  test("delegate → queued with a placeholder title and its own branch → listed → fails honestly", async ({ request }) => {
    const p = await project(request, { taskAgentModel: "claude-sonnet-5" })
    const res = await request.post(`/api/projects/${p.id}/tasks`, {
      data: { prompt: "## Fix the login on Safari\nIt breaks when the cookie is third-party." },
    })
    expect(res.status(), await res.text()).toBe(201)
    const task = await res.json()
    expect(task.state).toBe("queued")
    expect(task.title).toBe("Fix the login on Safari")
    expect(task.autoTitle).toBe(true)
    expect(task.branch).toMatch(/^task\/fix-the-login-on-safari-[a-z0-9]{6}$/)
    // The project's default model, resolved once at creation.
    expect(task.model).toBe("claude-sonnet-5")
    // Bookkeeping stays off the wire.
    expect(task).not.toHaveProperty("eventsOffset")

    const mine = await (await request.get(`/api/projects/${p.id}/tasks`)).json()
    expect(mine.map((t: { id: string }) => t.id)).toContain(task.id)
    const page = await (await request.get(`/api/tasks?projectId=${p.id}&q=safari`)).json()
    expect(page.tasks[0]).toMatchObject({ id: task.id, projectName: p.name })
    expect(Object.keys(page.counts).sort()).toEqual(["done", "failed", "in-review", "queued", "running"])

    // The image cannot be pulled, so the task never gets a machine — and says so.
    let detail = await (await request.get(`/api/tasks/${task.id}`)).json()
    for (let i = 0; i < 40 && detail.state === "queued"; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      detail = await (await request.get(`/api/tasks/${task.id}`)).json()
    }
    expect(detail.state).toBe("failed")
    expect(detail.error).toBeTruthy()
    expect(detail.canResume).toBe(false)

    // Finished: nothing to accept, drop, answer or interrupt.
    expect((await request.post(`/api/tasks/${task.id}/validate`)).status()).toBe(409)
    expect((await request.post(`/api/tasks/${task.id}/cancel`)).status()).toBe(409)
    expect((await request.post(`/api/tasks/${task.id}/messages`, { data: { prompt: "more" } })).status()).toBe(409)
    expect((await request.post(`/api/tasks/${task.id}/interrupt`)).status()).toBe(409)

    // A name typed by hand is final; the branch keeps the first one.
    const renamed = await (await request.patch(`/api/tasks/${task.id}`, { data: { title: "Safari login" } })).json()
    expect(renamed).toMatchObject({ title: "Safari login", autoTitle: false, branch: task.branch })

    const events = await (await request.get(`/api/tasks/${task.id}/events?tail=true`)).json()
    expect(events).toMatchObject({ protocol: "claude-stream", hasMore: false })
    const diff = await (await request.get(`/api/tasks/${task.id}/diff`)).json()
    expect(diff).toMatchObject({ available: false, reason: "no-machine" })

    expect((await request.delete(`/api/tasks/${task.id}`)).status()).toBe(204)
    expect((await request.get(`/api/tasks/${task.id}`)).status()).toBe(404)
    await request.delete(`/api/projects/${p.id}`)
  })

  test("the harness catalogue", async ({ request }) => {
    const packs = await (await request.get("/api/harness-packs")).json()
    expect(packs[0]).toMatchObject({ id: "claude-code", protocol: "claude-stream" })
    expect(packs[0].models.length).toBeGreaterThan(0)
  })
})
