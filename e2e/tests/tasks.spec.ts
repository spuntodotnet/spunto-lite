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
  test("a project starts on Claude Code, and its task settings save without a new version", async ({ request }) => {
    const p = await project(request)
    expect(p.agentAppIds).toEqual(["claude"])
    expect(p.taskReviewMode).toBe("keep")
    expect(p.taskAgentModels).toEqual({})
    // The CLI-era fields are gone from the wire.
    expect(p).not.toHaveProperty("taskAgentCommand")

    const res = await request.patch(`/api/projects/${p.id}`, {
      data: { taskAgentModels: { claude: "claude-opus-5-5" }, taskReviewMode: "stop", taskValidateCommand: "  echo ok  " },
    })
    expect(res.status()).toBe(200)
    const updated = await res.json()
    expect(updated.taskAgentModels).toEqual({ claude: "claude-opus-5-5" })
    expect(updated.taskReviewMode).toBe("stop")
    expect(updated.taskValidateCommand).toBe("echo ok")
    // Nothing here goes into the image, so nothing marks the workers out of date.
    expect(updated.currentVersion).toBe(p.currentVersion)

    // Blank = back to the default.
    const cleared = await (await request.patch(`/api/projects/${p.id}`, { data: { taskAgentModels: { claude: "" } } })).json()
    expect(cleared.taskAgentModels).toEqual({})

    // And they travel in the portable spec.
    const spec = await (await request.get(`/api/projects/${p.id}/export`)).json()
    expect(spec.project.taskReviewMode).toBe("stop")
    expect(spec.project.taskValidateCommand).toBe("echo ok")
    await request.delete(`/api/projects/${p.id}`)
  })

  test("the harnesses go into the image: changing them makes a version, and models follow their app", async ({ request }) => {
    const p = await project(request)
    // A model of another app, an app the project does not allow, an unknown app: refused.
    expect((await request.patch(`/api/projects/${p.id}`, { data: { taskAgentModels: { claude: "gpt-5.5" } } })).status()).toBe(400)
    expect((await request.patch(`/api/projects/${p.id}`, { data: { taskAgentModels: { codex: "gpt-5.5" } } })).status()).toBe(400)
    expect((await request.patch(`/api/projects/${p.id}`, { data: { agentAppIds: ["telepathy"] } })).status()).toBe(400)

    const both = await (await request.patch(`/api/projects/${p.id}`, { data: { agentAppIds: ["codex", "claude"], taskAgentModels: { claude: "claude-opus-5-5" } } })).json()
    expect(both.agentAppIds).toEqual(["codex", "claude"])
    expect(both.currentVersion).toBe(p.currentVersion + 1)
    const versions = await (await request.get(`/api/projects/${p.id}/versions`)).json()
    expect(versions[0].config.agentAppIds).toEqual(["codex", "claude"])

    // Switched off, an app takes its default model with it.
    const codexOnly = await (await request.patch(`/api/projects/${p.id}`, { data: { agentAppIds: ["codex"] } })).json()
    expect(codexOnly.taskAgentModels).toEqual({})

    // No harness: nothing can be delegated.
    await request.patch(`/api/projects/${p.id}`, { data: { agentAppIds: [] } })
    const refused = await request.post(`/api/projects/${p.id}/tasks`, { data: { prompt: "x" } })
    expect(refused.status()).toBe(400)
    expect((await refused.json()).error).toContain("no harness")
    await request.delete(`/api/projects/${p.id}`)
  })

  test("a task picks its harness, its model and the app's own parameters — checked against the catalog", async ({ request }) => {
    const p = await project(request, { agentAppIds: ["claude", "codex"], taskAgentModels: { codex: "gpt-5.5" } })
    const post = (data: Record<string, unknown>) => request.post(`/api/projects/${p.id}/tasks`, { data: { prompt: "x", ...data } })

    // Not a harness of this project, a parameter of another app, a value the app does not have: 400.
    expect((await post({ agentAppId: "gemini" })).status()).toBe(400)
    expect((await post({ agentOptions: { reasoningEffort: "high" } })).status()).toBe(400)
    expect((await post({ agentOptions: { effort: "enormous" } })).status()).toBe(400)

    // The default harness is the first; the model is its own default (none set for Claude here).
    const claude = await (await post({ agentOptions: { effort: "high" } })).json()
    expect(claude).toMatchObject({ agentAppId: "claude", model: null, agentOptions: { effort: "high" } })
    // Picking Codex gets Codex's default model from the project.
    const codex = await (await post({ agentAppId: "codex", agentOptions: { webSearch: "live" } })).json()
    expect(codex).toMatchObject({ agentAppId: "codex", model: "gpt-5.5", agentOptions: { webSearch: "live" } })

    const events = await (await request.get(`/api/tasks/${codex.id}/events?tail=true`)).json()
    expect(events.protocol).toBe("codex-runner")
    await request.delete(`/api/projects/${p.id}`)
  })

  test("rejects an empty prompt and an invalid base branch", async ({ request }) => {
    const p = await project(request)
    expect((await request.post(`/api/projects/${p.id}/tasks`, { data: { prompt: "   " } })).status()).toBe(400)
    expect((await request.post(`/api/projects/${p.id}/tasks`, { data: { prompt: "x", baseBranch: "a..b" } })).status()).toBe(400)
    expect((await request.post(`/api/projects/does-not-exist/tasks`, { data: { prompt: "x" } })).status()).toBe(404)
    await request.delete(`/api/projects/${p.id}`)
  })

  test("delegate → queued with a placeholder title and its own branch → listed → fails honestly", async ({ request }) => {
    const p = await project(request, { taskAgentModels: { claude: "claude-sonnet-5-5" } })
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
    expect(task.model).toBe("claude-sonnet-5-5")
    expect(task.agentAppId).toBe("claude")
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
    expect(events).toMatchObject({ protocol: "claude-runner", hasMore: false })
    const diff = await (await request.get(`/api/tasks/${task.id}/diff`)).json()
    expect(diff).toMatchObject({ available: false, reason: "no-machine" })

    expect((await request.delete(`/api/tasks/${task.id}`)).status()).toBe(204)
    expect((await request.get(`/api/tasks/${task.id}`)).status()).toBe(404)
    await request.delete(`/api/projects/${p.id}`)
  })

  test("the agent apps and their catalogs", async ({ request }) => {
    const apps = await (await request.get("/api/agent-apps")).json()
    expect(apps.map((a: { id: string }) => a.id)).toEqual(["claude", "codex"])
    expect(apps[0]).toMatchObject({ name: "Claude Code", credentials: ["ANTHROPIC_API_KEY"] })
    expect(apps[0].catalog.models.some((m: { default?: boolean }) => m.default)).toBe(true)
    expect(apps[0].catalog.params.map((p: { id: string }) => p.id)).toContain("effort")
    expect((await request.get("/api/harness-packs")).status()).toBe(404)
  })
})
