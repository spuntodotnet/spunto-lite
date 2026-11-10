import { test, expect } from "@playwright/test"

// The Usage page's report (services/usage.ts). Its numbers come from real sessions — asserted in
// tasks-lifecycle.spec.ts, on a real worker; here, the shape and the parameters, with whatever the
// control plane already holds.
test.describe("usage report", () => {
  test("GET /api/usage returns totals, every day of the period, and the breakdowns", async ({ request }) => {
    const res = await request.get("/api/usage?days=7&tz=Europe/Paris")
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.days).toBe(7)
    expect(body.timeZone).toBe("Europe/Paris")
    expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Quiet days are days at zero, not gaps: the chart's axis is the whole period.
    expect(body.daily).toHaveLength(7)
    expect(body.daily[0].day).toBe(body.from)
    for (const key of ["cost", "unpricedTasks", "tasks", "turns", "input", "output", "cacheRead", "cacheCreation", "apiCalls", "toolCalls", "toolErrors"]) {
      expect(typeof body.totals[key], key).toBe("number")
    }
    for (const key of ["tasks", "projects", "apps", "models", "tools"]) expect(Array.isArray(body[key]), key).toBe(true)
  })

  test("an unknown period falls back to 30 days, an unknown time zone to UTC", async ({ request }) => {
    const body = await (await request.get("/api/usage?days=12&tz=Not/AZone")).json()
    expect(body.days).toBe(30)
    expect(body.timeZone).toBe("UTC")
    expect(body.daily).toHaveLength(30)
  })

  test("all time has no first day", async ({ request }) => {
    const body = await (await request.get("/api/usage?days=0")).json()
    expect(body.days).toBe(0)
    expect(body.from).toBeNull()
  })
})
