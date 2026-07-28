import { test, expect } from "@playwright/test"
import type { APIResponse } from "@playwright/test"

// /api/extensions — the extension picker's backend. Three modes: curated defaults,
// registry search (`?q=`), and an existence verdict for a hand-typed id (`?id=`).
// Plus /api/extensions/registry, which says *which* registry the other three are
// talking to: Open VSX by default, or the gallery in EXTENSIONS_GALLERY.
//
// The search modes call out to that registry over the network. The route answers
// 503 (never 500) when it can't be reached, and these tests treat that as
// "environment offline, nothing to assert" rather than a failure — the contract
// under test is the route's, not the registry's uptime.
//
// Assertions about *specific* extension ids only hold on the default registry, so
// they're gated on `custom: false`: pointed at a gallery, the suite still checks
// every shape and status code, it just stops asserting someone else's catalog.

const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"

/** true when the response is the route's "registry unreachable" answer. */
function registryOffline(res: APIResponse): boolean {
  return res.status() === 503
}

test.describe("active extension registry", () => {
  test("/api/extensions/registry names the registry the picker searches", async ({ request }) => {
    const res = await request.get("/api/extensions/registry")
    expect(res.status()).toBe(200)
    const info = await res.json()
    expect(typeof info.name).toBe("string")
    expect(info.name.length).toBeGreaterThan(0)
    expect(typeof info.custom).toBe("boolean")
    if (info.homeUrl !== undefined) expect(() => new URL(info.homeUrl)).not.toThrow()
    // Unset EXTENSIONS_GALLERY must mean Open VSX — that default is what makes the
    // curated suggestions installable with no configuration at all.
    if (!info.custom) expect(info).toMatchObject({ name: "Open VSX", homeUrl: "https://open-vsx.org" })
  })

  test("curated suggestions are linked to the active registry, not a hardcoded one", async ({ request }) => {
    const { custom, homeUrl } = await (await request.get("/api/extensions/registry")).json()
    const list = await (await request.get("/api/extensions")).json()
    for (const e of list as { url?: string }[]) {
      if (!e.url) continue // a gallery with no itemUrl can't be linked to — allowed
      if (!custom) expect(e.url.startsWith("https://open-vsx.org/")).toBe(true)
      else expect(e.url.startsWith(new URL(homeUrl).origin)).toBe(true)
    }
  })
})

test.describe("extension catalog & search", () => {
  test("no query → curated suggestions, all shaped as publisher.extension-id", async ({ request }) => {
    const res = await request.get("/api/extensions")
    expect(res.status()).toBe(200)
    const list = await res.json()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
    for (const e of list) {
      expect(e.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*$/)
      expect(typeof e.label).toBe("string")
      expect(typeof e.publisher).toBe("string")
    }
  })

  test("?q= searches the registry and returns installable ids", async ({ request }) => {
    const { custom } = await (await request.get("/api/extensions/registry")).json()
    const res = await request.get("/api/extensions?q=prettier")
    if (registryOffline(res)) test.skip(true, "registry unreachable from this runner")
    expect(res.status(), await res.text()).toBe(200)
    const hits = await res.json()
    expect(Array.isArray(hits)).toBe(true)
    expect(hits.length).toBeGreaterThan(0)
    // The search is the whole point of the endpoint: a query must not hand back
    // the eight hardcoded suggestions.
    if (!custom) expect(hits.some((e: { id: string }) => e.id === "esbenp.prettier-vscode")).toBe(true)
    for (const e of hits) expect(typeof e.publisher).toBe("string")
  })

  test("?q= with a nonsense query returns an empty list, not the defaults", async ({ request }) => {
    const res = await request.get("/api/extensions?q=zzzznotanextensionzzzz")
    if (registryOffline(res)) test.skip(true, "registry unreachable from this runner")
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("?id= verifies a real id and rejects an unknown one", async ({ request }) => {
    const known = await request.get("/api/extensions?id=esbenp.prettier-vscode")
    if (registryOffline(known)) test.skip(true, "registry unreachable from this runner")
    expect(known.status()).toBe(200)
    expect(await known.json()).toMatchObject({ valid: true, found: true })
    // The "unknown" half below is the registry-agnostic part: whatever gallery is
    // configured, a made-up id must come back as a verdict, not an error.

    const unknown = await request.get("/api/extensions?id=nosuchpublisherxyz.nosuchextensionxyz")
    expect(unknown.status()).toBe(200)
    expect(await unknown.json()).toMatchObject({ valid: true, found: false, extension: null })
  })

  test("?id= with a malformed id is invalid without hitting the registry", async ({ request }) => {
    const res = await request.get("/api/extensions?id=just-a-name")
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ valid: false, found: false })
  })

  test("every curated suggestion actually exists on Open VSX", async ({ request }) => {
    // The defaults have to be installable on a stock install, i.e. without any
    // EXTENSIONS_GALLERY — this is the regression guard against an id that only
    // exists on some other registry sneaking back into the catalog. Pointed at a
    // gallery, there is nothing to guard: its catalog isn't ours to police.
    const { custom } = await (await request.get("/api/extensions/registry")).json()
    test.skip(custom, "a custom EXTENSIONS_GALLERY is configured — Open VSX isn't the registry under test")
    const suggestions = await (await request.get("/api/extensions")).json()
    for (const s of suggestions as { id: string }[]) {
      const res = await request.get(`/api/extensions?id=${encodeURIComponent(s.id)}`)
      if (registryOffline(res)) test.skip(true, "Open VSX unreachable from this runner")
      expect(await res.json(), `${s.id} should be published on Open VSX`).toMatchObject({ found: true })
    }
  })
})

test.describe("extension id validation on the project API", () => {
  test("a malformed extension id is rejected at create time", async ({ request }) => {
    const res = await request.post("/api/projects", {
      data: { name: "e2e-bad-ext", image: IMAGE, vscodeExtensions: ["not an id"] },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe("Validation failed")
  })

  test("a well-formed extension id is accepted and stored", async ({ request }) => {
    const res = await request.post("/api/projects", {
      data: { name: "e2e-good-ext", image: IMAGE, vscodeExtensions: ["esbenp.prettier-vscode"] },
    })
    expect(res.status(), await res.text()).toBe(201)
    const created = await res.json()
    expect(created.vscodeExtensions).toEqual(["esbenp.prettier-vscode"])

    // Same rule on update.
    const bad = await request.patch(`/api/projects/${created.id}`, { data: { vscodeExtensions: ["nope"] } })
    expect(bad.status()).toBe(400)

    await request.delete(`/api/projects/${created.id}`)
  })

  test("a PATCH that doesn't mention extensions leaves them alone", async ({ request }) => {
    const created = await (
      await request.post("/api/projects", {
        data: { name: "e2e-ext-keep", image: IMAGE, vscodeExtensions: ["esbenp.prettier-vscode"], forwardPorts: [3000] },
      })
    ).json()

    const patched = await request.patch(`/api/projects/${created.id}`, { data: { description: "renamed only" } })
    expect(patched.status()).toBe(200)
    const after = await patched.json()
    // A partial update used to reset every defaulted array to [] — extensions included.
    expect(after.vscodeExtensions).toEqual(["esbenp.prettier-vscode"])
    expect(after.forwardPorts).toEqual([3000])

    await request.delete(`/api/projects/${created.id}`)
  })
})
