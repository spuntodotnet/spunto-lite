import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"

// Shared services — the cross-project dependencies (one Elasticsearch for every worker).
// These run in the HTTP-only project, so every fixture is created with `start: false`:
// the spec is persisted synchronously while the container start is fire-and-forget, which
// keeps the whole CRUD surface testable without a Docker socket. The reachability part
// (DNS on the shared network) is what `worker-lifecycle` covers when E2E_DOCKER=1.

const IMAGE = "postgres:16-alpine"

function slug(prefix = "e2e-svc") {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

async function createService(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/services", { data: { start: false, ...data } })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

test.describe("shared services CRUD", () => {
  test("create → list → patch → delete", async ({ request }) => {
    const s = slug()
    const created = await createService(request, {
      slug: s,
      description: "created by the e2e suite",
      image: IMAGE,
      env: [{ name: "POSTGRES_PASSWORD", value: "postgres" }],
      ports: [{ container: 5432 }],
      volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
    })

    try {
      expect(created.slug).toBe(s)
      expect(created.image).toBe(IMAGE)
      expect(created.state).toBe("stopped") // start: false
      expect(created.containerId).toBeNull()
      expect(created.restartPolicy).toBe("unless-stopped")
      expect(created.ports).toEqual([{ container: 5432 }])

      const list = (await (await request.get("/api/services")).json()) as { id: string; slug: string }[]
      expect(list.find((x) => x.id === created.id)?.slug).toBe(s)

      const one = await request.get(`/api/services/${created.id}`)
      expect(one.status()).toBe(200)
      expect((await one.json()).slug).toBe(s)

      // A PATCH that mentions nothing else must not wipe env/ports/volumes.
      const patched = await request.patch(`/api/services/${created.id}`, { data: { httpPort: 5432 } })
      expect(patched.status(), await patched.text()).toBe(200)
      const after = await patched.json()
      expect(after.httpPort).toBe(5432)
      expect(after.env).toHaveLength(1)
      expect(after.ports).toEqual([{ container: 5432 }])
      expect(after.volumes).toEqual([{ name: "data", mountPath: "/var/lib/postgresql/data" }])
    } finally {
      const del = await request.delete(`/api/services/${created.id}`)
      expect(del.status()).toBe(204)
    }
    expect((await request.get(`/api/services/${created.id}`)).status()).toBe(404)
  })

  test("an env var can reference a global secret instead of a literal value", async ({ request }) => {
    const secretName = `E2E_SVC_SECRET_${Date.now()}`
    const value = `never-echoed-${Date.now()}`
    const secrets = await (await request.post("/api/secrets", { data: { name: secretName, value } })).json()
    const secret = (secrets as { id: string; name: string }[]).find((x) => x.name === secretName)!

    const created = await createService(request, {
      slug: slug(),
      image: IMAGE,
      env: [{ name: "POSTGRES_PASSWORD", secretName }],
    })
    try {
      // The reference is stored; the value stays encrypted at rest and is only resolved
      // when the container is created.
      expect(created.env).toEqual([{ name: "POSTGRES_PASSWORD", secretName }])
      const raw = await (await request.get("/api/services")).text()
      expect(raw, "a secret value leaked through /api/services").not.toContain(value)
    } finally {
      await request.delete(`/api/services/${created.id}`)
      await request.delete(`/api/secrets/${secret.id}`)
    }
  })

  test("lifecycle endpoints answer for a declared service", async ({ request }) => {
    const created = await createService(request, { slug: slug(), image: IMAGE })
    try {
      // stop is idempotent on a service that was never started.
      const stopped = await request.post(`/api/services/${created.id}/stop`)
      expect(stopped.status(), await stopped.text()).toBe(200)
      expect((await stopped.json()).state).toBe("stopped")

      // No container → empty log tail rather than an error.
      const logs = await request.get(`/api/services/${created.id}/logs`)
      expect(logs.status()).toBe(200)
      expect(await logs.text()).toBe("")

      const stats = await request.get(`/api/services/${created.id}/stats`)
      expect(stats.status()).toBe(200)
      expect(await stats.json()).toBeNull()
    } finally {
      await request.delete(`/api/services/${created.id}`)
    }
  })

  test("404s on an unknown service", async ({ request }) => {
    expect((await request.get("/api/services/does-not-exist")).status()).toBe(404)
    expect((await request.post("/api/services/does-not-exist/start")).status()).toBe(404)
    expect((await request.patch("/api/services/does-not-exist", { data: { image: IMAGE } })).status()).toBe(404)
  })
})

test.describe("shared services validation", () => {
  test("rejects a slug that isn't a DNS label", async ({ request }) => {
    for (const bad of ["UPPER", "-leading", "trailing-", "with_underscore", "with space"]) {
      const res = await request.post("/api/services", { data: { slug: bad, image: IMAGE, start: false } })
      expect(res.status(), `slug "${bad}" should be rejected`).toBe(400)
    }
  })

  test("rejects an env var that is both literal and a secret reference — or neither", async ({ request }) => {
    const both = await request.post("/api/services", {
      data: { slug: slug(), image: IMAGE, start: false, env: [{ name: "X", value: "a", secretName: "B" }] },
    })
    expect(both.status()).toBe(400)
    const neither = await request.post("/api/services", {
      data: { slug: slug(), image: IMAGE, start: false, env: [{ name: "X" }] },
    })
    expect(neither.status()).toBe(400)
  })

  test("rejects a relative mount path and an out-of-range port", async ({ request }) => {
    const badMount = await request.post("/api/services", {
      data: { slug: slug(), image: IMAGE, start: false, volumes: [{ name: "data", mountPath: "relative/path" }] },
    })
    expect(badMount.status()).toBe(400)
    const badPort = await request.post("/api/services", {
      data: { slug: slug(), image: IMAGE, start: false, ports: [{ container: 99999 }] },
    })
    expect(badPort.status()).toBe(400)
  })

  test("rejects a duplicate slug", async ({ request }) => {
    const s = slug()
    const created = await createService(request, { slug: s, image: IMAGE })
    try {
      const dup = await request.post("/api/services", { data: { slug: s, image: IMAGE, start: false } })
      expect(dup.status()).toBe(400)
    } finally {
      await request.delete(`/api/services/${created.id}`)
    }
  })
})

test.describe("shared services elsewhere in the app", () => {
  test("show up in the resources overview and the search index", async ({ request }) => {
    const s = slug()
    const created = await createService(request, { slug: s, image: IMAGE, ports: [{ container: 5432 }] })
    try {
      const overview = await (await request.get("/api/resources")).json()
      expect(Array.isArray(overview.services)).toBe(true)
      expect(overview.totals.servicesTotal).toBe(overview.services.length)
      expect(overview.totals.servicesRunning).toBeLessThanOrEqual(overview.totals.servicesTotal)
      const entry = overview.services.find((x: { id: string }) => x.id === created.id)
      expect(entry, "new service missing from /api/resources").toBeDefined()
      // The in-cluster address is what a worker would use — no scheme without an HTTP port.
      expect(entry.address).toBe(`${s}:5432`)
      expect(entry.running).toBe(false)

      const hits = (await (await request.get("/api/search")).json()).hits as {
        id: string
        kind: string
        label: string
        href?: string
      }[]
      const hit = hits.find((h) => h.id === `service:shared:${created.id}`)
      expect(hit, "new service missing from the ⌘K index").toBeDefined()
      expect(hit!.kind).toBe("service")
      expect(hit!.label).toBe(s)
      // Not running → the palette sends you to the page where you can start it.
      expect(hit!.href).toBe("/services")
    } finally {
      await request.delete(`/api/services/${created.id}`)
    }
  })

  test("the svc-<slug> subdomain is routed by the reverse proxy", async ({ request }) => {
    // Nothing is listening, so a 502 from *our* proxy is the success condition: it proves
    // the `svc-` prefix is claimed by the proxy and never handed to the Next app (which
    // would answer 200 on /). Same BASE_DOMAIN default as lib/env.ts — the runner and the
    // app read it from the same environment.
    const baseDomain = process.env.BASE_DOMAIN || "localhost"
    const res = await request.get("/", { headers: { host: `svc-nobody-here.${baseDomain}` }, maxRedirects: 0 })
    expect(res.status()).toBe(502)
  })
})
