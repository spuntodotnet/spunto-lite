import { test, expect } from "@playwright/test"

// The cross-project Resources overview. Talks to the Docker daemon (df + per-container
// state/stats), so it asserts the aggregate shape rather than exact numbers — those depend
// on what's running on the host. On a clean control plane the lists are simply empty.
test.describe("resources overview", () => {
  test("GET /api/resources returns totals + workers/volumes/images", async ({ request }) => {
    const res = await request.get("/api/resources")
    expect(res.status()).toBe(200)
    const body = await res.json()

    expect(body).toHaveProperty("totals")
    expect(body).toHaveProperty("workers")
    expect(body).toHaveProperty("volumes")
    expect(body).toHaveProperty("images")
    expect(Array.isArray(body.workers)).toBe(true)
    expect(Array.isArray(body.volumes)).toBe(true)
    expect(Array.isArray(body.images)).toBe(true)

    const t = body.totals
    for (const key of [
      "workersTotal",
      "workersRunning",
      "cpuPercent",
      "memUsageMb",
      "volumesCount",
      "volumesSizeBytes",
      "imagesCount",
      "imagesSizeBytes",
    ]) {
      expect(typeof t[key], key).toBe("number")
    }
    // Running never exceeds total; counts mirror the array lengths.
    expect(t.workersRunning).toBeLessThanOrEqual(t.workersTotal)
    expect(t.workersTotal).toBe(body.workers.length)
    expect(t.volumesCount).toBe(body.volumes.length)
    expect(t.imagesCount).toBe(body.images.length)

    // The slow measurements come from the background: the answer says how old they are.
    const f = body.freshness
    for (const key of ["statsAt", "sizesAt", "sizesMeasuringSince", "sizesError"]) {
      expect(f[key] === null || typeof f[key] === "string", key).toBe(true)
    }

    // Every worker entry is well-shaped.
    for (const w of body.workers) {
      expect(typeof w.id).toBe("string")
      expect(typeof w.name).toBe("string")
      expect(typeof w.projectName).toBe("string")
      expect(typeof w.running).toBe("boolean")
    }
  })

  test("answers without waiting for the volume walk, and can start one", async ({ request }) => {
    const started = Date.now()
    const res = await request.post("/api/resources/refresh")
    expect(res.status()).toBe(202)
    const body = await res.json()
    expect(body).toHaveProperty("freshness")
    // Reads stay cheap while it runs: listings and cached measurements only.
    expect((await request.get("/api/resources")).status()).toBe(200)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
