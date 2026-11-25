import { test, expect } from "@playwright/test"

// Settings → Statistics over HTTP: the shape the page reads, and the range it accepts. What a real
// start puts in it is checked by worker-lifecycle.spec.ts (E2E_DOCKER=1).

test.describe("statistics API", () => {
  test("answers every range with the measures the page draws, and refuses another", async ({ request }) => {
    for (const range of ["24h", "7d", "30d", "90d"]) {
      const res = await request.get(`/api/statistics?range=${range}`)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.range).toBe(range)
      for (const key of ["starts", "startPoints", "setupRuns", "phases", "buildPoints", "projects"]) expect(Array.isArray(body[key]), key).toBe(true)
      expect(body.builds).toHaveProperty("count")
      expect(body.to - body.from).toBeGreaterThan(0)
    }
    expect((await (await request.get("/api/statistics")).json()).range).toBe("30d")
    expect((await request.get("/api/statistics?range=1y")).status()).toBe(400)
    // A project with nothing measured: empty, not an error.
    const empty = await (await request.get("/api/statistics?range=7d&projectId=no-such-project")).json()
    expect(empty.startPoints).toEqual([])
    expect(empty.projects).toEqual([])
  })
})
