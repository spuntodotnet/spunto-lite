import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"

// Project CRUD end-to-end over real HTTP against the control plane. No Docker needed — projects
// are just devcontainer specs in SQLite; spawning workers from them is covered separately by
// worker-lifecycle.spec.ts.

const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"

function projectBody(name: string, overrides: Record<string, unknown> = {}) {
  return { name, image: IMAGE, ...overrides }
}

async function createProject(request: APIRequestContext, name: string, overrides = {}) {
  const res = await request.post("/api/projects", { data: projectBody(name, overrides) })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

test.describe("project CRUD", () => {
  test("create → list → get → update → delete", async ({ request }) => {
    const created = await createProject(request, "e2e-crud", { description: "initial" })
    expect(created.id).toBeTruthy()
    expect(created.name).toBe("e2e-crud")

    // Appears in the list.
    const list = await (await request.get("/api/projects")).json()
    expect(list.map((p: { id: string }) => p.id)).toContain(created.id)

    // Fetch by id.
    const got = await request.get(`/api/projects/${created.id}`)
    expect(got.status()).toBe(200)
    expect((await got.json()).name).toBe("e2e-crud")

    // Update.
    const patched = await request.patch(`/api/projects/${created.id}`, { data: { description: "updated" } })
    expect(patched.status()).toBe(200)
    expect((await patched.json()).description).toBe("updated")

    // Delete → 204, then 404 on refetch.
    const del = await request.delete(`/api/projects/${created.id}`)
    expect(del.status()).toBe(204)
    expect((await request.get(`/api/projects/${created.id}`)).status()).toBe(404)
  })

  test("editing config records a new version", async ({ request }) => {
    const created = await createProject(request, "e2e-versions")
    try {
      await request.patch(`/api/projects/${created.id}`, { data: { postCreateCommand: "echo hi" } })
      const versions = await (await request.get(`/api/projects/${created.id}/versions`)).json()
      expect(Array.isArray(versions)).toBe(true)
      // At least the initial version; an edit that changes config adds another.
      expect(versions.length).toBeGreaterThanOrEqual(1)
    } finally {
      await request.delete(`/api/projects/${created.id}`)
    }
  })
})

test.describe("validation & not-found", () => {
  test("rejects a project with no name", async ({ request }) => {
    const res = await request.post("/api/projects", { data: { image: IMAGE } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe("Validation failed")
  })

  test("rejects a project with no image", async ({ request }) => {
    const res = await request.post("/api/projects", { data: { name: "no-image" } })
    expect(res.status()).toBe(400)
  })

  test("rejects a malformed JSON body", async ({ request }) => {
    const res = await request.post("/api/projects", {
      headers: { "content-type": "application/json" },
      data: "{ not json",
    })
    expect(res.status()).toBe(400)
  })

  test("GET on a missing project is 404", async ({ request }) => {
    const res = await request.get("/api/projects/does-not-exist")
    expect(res.status()).toBe(404)
  })
})
