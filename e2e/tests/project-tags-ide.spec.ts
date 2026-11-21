import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"

// Two project fields from Spunto Cloud, over plain HTTP. Tags (Cloud 7e4f8da5): labels outside the
// versioned config. Spunto IDE (Cloud RFC 0064): part of the image, so a version. No Docker.

const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"

async function createProject(request: APIRequestContext, overrides: Record<string, unknown> = {}) {
  const res = await request.post("/api/projects", { data: { name: `e2e-tags-ide-${Date.now()}`, image: IMAGE, ...overrides } })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

test.describe("project tags", () => {
  test("replaced as a whole, tidied, never a version", async ({ request }) => {
    const p = await createProject(request)
    expect(p.tags).toEqual([])

    const res = await request.put(`/api/projects/${p.id}/tags`, { data: { tags: ["  front end ", "API", "api", "API", ""] } })
    expect(res.status(), await res.text()).toBe(200)
    // Trimmed, inner whitespace collapsed, empties and duplicates dropped — case kept: two tags.
    expect(await res.json()).toEqual({ tags: ["front end", "API", "api"] })

    const got = await (await request.get(`/api/projects/${p.id}`)).json()
    expect(got.tags).toEqual(["front end", "API", "api"])
    expect(got.currentVersion).toBe(p.currentVersion)
    const listed = (await (await request.get("/api/projects")).json()).find((x: { id: string }) => x.id === p.id)
    expect(listed.tags).toEqual(["front end", "API", "api"])

    // An edit of the recipe leaves them alone.
    await request.patch(`/api/projects/${p.id}`, { data: { description: "changed" } })
    expect((await (await request.get(`/api/projects/${p.id}`)).json()).tags).toEqual(["front end", "API", "api"])

    expect((await request.put(`/api/projects/${p.id}/tags`, { data: { tags: [] } })).status()).toBe(200)
    expect((await (await request.get(`/api/projects/${p.id}`)).json()).tags).toEqual([])

    // Too long, too many, not a list, no such project.
    expect((await request.put(`/api/projects/${p.id}/tags`, { data: { tags: ["x".repeat(41)] } })).status()).toBe(400)
    expect((await request.put(`/api/projects/${p.id}/tags`, { data: { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) } })).status()).toBe(400)
    expect((await request.put(`/api/projects/${p.id}/tags`, { data: { tags: "a" } })).status()).toBe(400)
    expect((await request.put(`/api/projects/no-such-project/tags`, { data: { tags: ["a"] } })).status()).toBe(404)
    await request.delete(`/api/projects/${p.id}`)
  })
})

test.describe("Spunto IDE per project", () => {
  test("on by default; turning it off is a version, travels in the export, and comes back on restore", async ({ request }) => {
    const p = await createProject(request)
    expect(p.ide).toBe(true)
    // At its default, the export says nothing.
    expect((await (await request.get(`/api/projects/${p.id}/export`)).json()).project).not.toHaveProperty("ide")

    const off = await (await request.patch(`/api/projects/${p.id}`, { data: { ide: false } })).json()
    expect(off.ide).toBe(false)
    expect(off.currentVersion).toBe(p.currentVersion + 1)
    const versions = await (await request.get(`/api/projects/${p.id}/versions`)).json()
    expect(versions[0].config.ide).toBe(false)
    expect((await (await request.get(`/api/projects/${p.id}/export`)).json()).project.ide).toBe(false)

    // Restoring the first version brings the IDE back, as a new version.
    const restored = await request.post(`/api/projects/${p.id}/versions/${p.currentVersion}/restore`)
    expect(restored.status(), await restored.text()).toBe(200)
    const back = await (await request.get(`/api/projects/${p.id}`)).json()
    expect(back).toMatchObject({ ide: true, currentVersion: p.currentVersion + 2 })

    // Created without it.
    const bare = await createProject(request, { ide: false })
    expect(bare.ide).toBe(false)
    await request.delete(`/api/projects/${p.id}`)
    await request.delete(`/api/projects/${bare.id}`)
  })
})

test.describe("a worker's port page", () => {
  // The proxy answers on `worker-<id>[-<port>].localhost`: a host header is enough to reach it.
  test("a browser asking for a worker that doesn't exist gets a page, an API client the plain error", async ({ request }) => {
    const host = "worker-nosuchworker-3000.localhost"
    const page = await request.get("/", { headers: { host, accept: "text/html" } })
    expect(page.status()).toBe(404)
    expect(page.headers()["content-type"]).toContain("text/html")
    const html = await page.text()
    expect(html).toContain("No such workspace")
    expect(html).toContain("Open in Spunto Lite")

    const plain = await request.get("/", { headers: { host, accept: "application/json" } })
    expect(plain.status()).toBe(502)
    expect(await plain.text()).toContain("Not reachable")

    const status = await request.get("/__spunto/status", { headers: { host } })
    expect(status.status()).toBe(404)
    expect((await request.post("/__spunto/start", { headers: { host } })).status()).toBe(404)
  })
})
