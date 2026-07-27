import { test, expect } from "@playwright/test"

// The ⌘K palette's index (GET /api/search). Built from SQLite only, so unlike
// /api/resources it doesn't depend on what Docker has running — a project created
// over the API must show up in the index immediately.
test.describe("search index", () => {
  test("GET /api/search returns a well-shaped index", async ({ request }) => {
    const res = await request.get("/api/search")
    expect(res.status()).toBe(200)
    const body = await res.json()

    expect(Array.isArray(body.hits)).toBe(true)
    expect(typeof body.generatedAt).toBe("string")
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)

    const kinds = new Set(["project", "worker", "service", "build", "secret", "template"])
    const ids = new Set<string>()
    for (const hit of body.hits) {
      expect(typeof hit.id).toBe("string")
      expect(kinds.has(hit.kind), `unexpected kind ${hit.kind}`).toBe(true)
      expect(typeof hit.label).toBe("string")
      expect(hit.label.length).toBeGreaterThan(0)
      expect(Array.isArray(hit.keywords)).toBe(true)
      // Every hit must be actionable: an in-app route, or a worker-hosted target
      // the client resolves through workerBaseUrl().
      expect(Boolean(hit.href) || Boolean(hit.target), `${hit.id} has no destination`).toBe(true)
      // The palette uses `id` as the item value — collisions would break highlighting.
      expect(ids.has(hit.id), `duplicate id ${hit.id}`).toBe(false)
      ids.add(hit.id)
    }
  })

  test("the built-in templates are always indexed", async ({ request }) => {
    const [search, templates] = await Promise.all([request.get("/api/search"), request.get("/api/templates")])
    const hits = (await search.json()).hits as { kind: string; label: string }[]
    const indexed = hits.filter((h) => h.kind === "template").map((h) => h.label)

    for (const t of (await templates.json()) as { name: string }[]) {
      expect(indexed, `template ${t.name} missing from the index`).toContain(t.name)
    }
  })

  test("a created project is indexed, and drops out once deleted", async ({ request }) => {
    const name = `e2e-search-${Date.now()}`
    const created = await request.post("/api/projects", {
      data: {
        name,
        description: "indexed by the command palette",
        image: "mcr.microsoft.com/devcontainers/typescript-node:20",
        forwardPorts: [4321],
      },
    })
    expect(created.status(), await created.text()).toBe(201)
    const project = await created.json()

    type Hit = { id: string; kind: string; label: string; href?: string; keywords: string[] }
    const hitFor = async (): Promise<Hit | undefined> =>
      ((await (await request.get("/api/search")).json()).hits as Hit[]).find((h) => h.id === `project:${project.id}`)

    const hit = await hitFor()
    expect(hit, "new project missing from the index").toBeDefined()
    expect(hit!.kind).toBe("project")
    expect(hit!.label).toBe(name)
    expect(hit!.href).toBe(`/projects/${project.id}`)
    // The image and the forwarded port are searchable without being displayed.
    expect(hit!.keywords).toContain("mcr.microsoft.com/devcontainers/typescript-node:20")
    expect(hit!.keywords).toContain("4321")

    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true)
    expect(await hitFor(), "deleted project still indexed").toBeUndefined()
  })

  test("secrets are indexed by name only — never by value", async ({ request }) => {
    const name = `E2E_SEARCH_${Date.now()}`
    const value = `never-in-the-index-${Date.now()}`
    // POST returns the refreshed list, so the id comes straight back.
    const created = await request.post("/api/secrets", { data: { name, value } })
    expect(created.status(), await created.text()).toBe(201)
    const secret = ((await created.json()) as { id: string; name: string }[]).find((s) => s.name === name)
    expect(secret).toBeDefined()

    try {
      const raw = await (await request.get("/api/search")).text()
      expect(raw, "secret name missing from the index").toContain(name)
      expect(raw, "a secret value leaked into the search index").not.toContain(value)
    } finally {
      await request.delete(`/api/secrets/${secret!.id}`)
    }
  })
})
