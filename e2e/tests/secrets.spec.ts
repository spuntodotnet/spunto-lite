import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"

// Secrets, global (user) and per-project. The API returns only { id, name } — values are
// AES-GCM encrypted at rest and never echoed back — so these tests assert on metadata + name
// validation, not on reading a value back.

async function createProject(request: APIRequestContext, name: string) {
  const res = await request.post("/api/projects", {
    data: { name, image: "mcr.microsoft.com/devcontainers/typescript-node:20" },
  })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

test.describe("global secrets", () => {
  test("create → list → delete", async ({ request }) => {
    const name = "E2E_GLOBAL_SECRET"
    const created = await request.post("/api/secrets", { data: { name, value: "s3cr3t" } })
    expect(created.status()).toBe(201)
    const afterCreate = await created.json()
    const entry = afterCreate.find((s: { name: string }) => s.name === name)
    expect(entry).toBeTruthy()
    expect(entry.value).toBeUndefined() // value never exposed

    // Delete it and confirm it's gone from the list.
    const del = await request.delete(`/api/secrets/${entry.id}`)
    expect(del.status()).toBe(204)
    const list = await (await request.get("/api/secrets")).json()
    expect(list.find((s: { id: string }) => s.id === entry.id)).toBeUndefined()
  })

  test("rejects a non UPPER_SNAKE_CASE name", async ({ request }) => {
    const res = await request.post("/api/secrets", { data: { name: "lower-case", value: "x" } })
    expect(res.status()).toBe(400)
  })

  test("rejects an empty value", async ({ request }) => {
    const res = await request.post("/api/secrets", { data: { name: "E2E_EMPTY", value: "" } })
    expect(res.status()).toBe(400)
  })
})

test.describe("project secrets", () => {
  test("create → list → delete on a project", async ({ request }) => {
    const project = await createProject(request, "e2e-secrets")
    try {
      const name = "E2E_PROJECT_SECRET"
      const created = await request.post(`/api/projects/${project.id}/secrets`, {
        data: { name, value: "p4ss" },
      })
      expect(created.status()).toBe(201)
      const list = await created.json()
      const entry = list.find((s: { name: string }) => s.name === name)
      expect(entry).toBeTruthy()

      const del = await request.delete(`/api/projects/${project.id}/secrets/${entry.id}`)
      expect(del.status()).toBe(204)
      const after = await (await request.get(`/api/projects/${project.id}/secrets`)).json()
      expect(after.find((s: { id: string }) => s.id === entry.id)).toBeUndefined()
    } finally {
      await request.delete(`/api/projects/${project.id}`)
    }
  })
})
