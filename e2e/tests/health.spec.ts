import { test, expect } from "@playwright/test"

// Smoke test: the control plane is up and serving the API. Also the readiness probe the CI
// workflow polls before running the rest of the suite.
test("GET /api/health returns ok", async ({ request }) => {
  const res = await request.get("/api/health")
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ ok: true, service: "spunto-lite" })
})
