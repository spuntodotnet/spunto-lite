import { test, expect } from "@playwright/test"

// Settings read + partial update. Runs serially (not fullyParallel-safe) since settings are a
// single global row — but the fields it touches don't overlap with anything else in the suite.
test.describe.configure({ mode: "serial" })

test.describe("settings", () => {
  test("GET returns the settings view", async ({ request }) => {
    const res = await request.get("/api/settings")
    expect(res.status()).toBe(200)
    expect(typeof (await res.json())).toBe("object")
  })

  test("PATCH updates git identity fields", async ({ request }) => {
    const res = await request.patch("/api/settings", {
      data: { gitUserName: "E2E Bot", gitUserEmail: "e2e@spunto.test" },
    })
    expect(res.status()).toBe(200)
    const view = await res.json()
    expect(view.gitUserName).toBe("E2E Bot")
    expect(view.gitUserEmail).toBe("e2e@spunto.test")
  })

  test("PATCH rejects a GCP key that is neither JSON nor base64 JSON", async ({ request }) => {
    const res = await request.patch("/api/settings", { data: { gcpRegistryKey: "not-a-key" } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toContain("Invalid GCP service-account key")
  })
})
