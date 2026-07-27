import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"

// The *creation* half of a worker: what POST /api/projects/:id/workers accepts and persists.
// No Docker needed — the row is written and returned synchronously, the container spawn is
// fire-and-forget (and simply errors out in the background where there is no daemon). The
// container side of the story is worker-lifecycle.spec.ts (opt-in, real Docker).

const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"

async function createProject(request: APIRequestContext, name: string) {
  const res = await request.post("/api/projects", {
    data: {
      name,
      image: IMAGE,
      repositories: [{ id: "r1", provider: "github", project: "octocat/Hello-World", workspacePath: "app" }],
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

test.describe("worker creation options", () => {
  let projectId: string
  const workerIds: string[] = []

  test.beforeAll(async ({ request }) => {
    projectId = (await createProject(request, `e2e-spawn-${Date.now()}`)).id
  })

  test.afterAll(async ({ request }) => {
    for (const id of workerIds) await request.delete(`/api/workers/${id}`).catch(() => {})
    if (projectId) await request.delete(`/api/projects/${projectId}`).catch(() => {})
  })

  test("name and branch are persisted on the worker", async ({ request }) => {
    const res = await request.post(`/api/projects/${projectId}/workers`, {
      data: { name: "e2e-named", branch: "feature/some-branch" },
    })
    expect(res.status(), await res.text()).toBe(201)
    const worker = await res.json()
    workerIds.push(worker.id)
    expect(worker.name).toBe("e2e-named")
    expect(worker.branch).toBe("feature/some-branch")

    // Survives a read-back (the column, not just the response body).
    const got = await request.get(`/api/workers/${worker.id}`)
    expect(got.status()).toBe(200)
    expect((await got.json()).branch).toBe("feature/some-branch")

    const list = await (await request.get(`/api/projects/${projectId}/workers`)).json()
    expect(list.find((w: { id: string }) => w.id === worker.id).branch).toBe("feature/some-branch")
  })

  test("an empty body still spawns on the default branch", async ({ request }) => {
    const res = await request.post(`/api/projects/${projectId}/workers`, { data: {} })
    expect(res.status(), await res.text()).toBe(201)
    const worker = await res.json()
    workerIds.push(worker.id)
    expect(worker.name).toBeTruthy() // generated
    expect(worker.branch).toBeNull()
  })

  test("a blank branch is stored as no branch", async ({ request }) => {
    const res = await request.post(`/api/projects/${projectId}/workers`, { data: { branch: "   " } })
    expect(res.status(), await res.text()).toBe(201)
    const worker = await res.json()
    workerIds.push(worker.id)
    expect(worker.branch).toBeNull()
  })

  test("a non-string branch is rejected", async ({ request }) => {
    const res = await request.post(`/api/projects/${projectId}/workers`, { data: { branch: 42 } })
    expect(res.status()).toBe(400)
  })
})
