import { test, expect } from "@playwright/test"

// The static catalog endpoints the "new project" UI populates from. Pure reads, no Docker —
// they just assert the catalogs are served and well-shaped.
test.describe("catalog endpoints", () => {
  test("GET /api/images lists dev images with an id + image ref", async ({ request }) => {
    const res = await request.get("/api/images")
    expect(res.status()).toBe(200)
    const images = await res.json()
    expect(Array.isArray(images)).toBe(true)
    expect(images.length).toBeGreaterThan(0)
    for (const img of images) {
      expect(typeof img.id).toBe("string")
      expect(typeof img.image).toBe("string")
    }
    // A known catalog entry the other tests rely on.
    expect(images.map((i: { id: string }) => i.id)).toContain("typescript-node-20")
  })

  test("GET /api/templates lists project templates", async ({ request }) => {
    const res = await request.get("/api/templates")
    expect(res.status()).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test("GET /api/features lists devcontainer features", async ({ request }) => {
    const res = await request.get("/api/features")
    expect(res.status()).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test("GET /api/extensions lists suggested VS Code extensions", async ({ request }) => {
    const res = await request.get("/api/extensions")
    expect(res.status()).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })
})
