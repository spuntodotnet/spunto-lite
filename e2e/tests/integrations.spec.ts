import { test, expect } from "@playwright/test"

// Integrations (docs/integrations.md): what can be connected, and the refusals that need no forge.
// Connecting for real asks the forge whose the token is — not something the suite has a token for.
test.describe("integrations", () => {
  test("GET lists the forges that can be connected", async ({ request }) => {
    const res = await request.get("/api/integrations")
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.offers.map((o: { kind: string }) => o.kind).sort()).toEqual(["github", "gitlab"])
    const gitlab = body.offers.find((o: { kind: string }) => o.kind === "gitlab")
    expect(gitlab).toMatchObject({ defaultHost: "gitlab.com", shortLabel: "MR", tokenEnvVar: "GITLAB_TOKEN" })
    expect(Array.isArray(body.connections)).toBe(true)
    // A connection never carries its token.
    for (const c of body.connections) expect(Object.keys(c)).not.toContain("encryptedToken")
  })

  test("POST refuses a forge without a driver, a host that is not one, an empty token", async ({ request }) => {
    const bitbucket = await request.post("/api/integrations", { data: { kind: "bitbucket", token: "x" } })
    expect(bitbucket.status()).toBe(400)

    const host = await request.post("/api/integrations", { data: { kind: "gitlab", host: "gitlab.example.com/group", token: "x" } })
    expect(host.status()).toBe(400)
    expect((await host.json()).error).toContain("Not a host")

    const empty = await request.post("/api/integrations", { data: { kind: "github", token: "   " } })
    expect(empty.status()).toBe(400)
  })

  test("GET /repositories answers its shape, even with nothing connected", async ({ request }) => {
    const res = await request.get("/api/integrations/repositories")
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.sources)).toBe(true)
    expect(Array.isArray(body.repositories)).toBe(true)
  })

  test("a worker's git credential helper is refused without a worker's token", async ({ request }) => {
    const none = await request.post("/api/workers/git-credential", { data: { protocol: "https", host: "github.com" } })
    expect(none.status()).toBe(401)
    const forged = await request.post("/api/workers/git-credential", {
      headers: { authorization: `Bearer lgc_nosuchworker_${"0".repeat(40)}` },
      data: { protocol: "https", host: "github.com" },
    })
    expect(forged.status()).toBe(401)
  })

  test("DELETE of an unknown or environment connection is a 404", async ({ request }) => {
    expect((await request.delete("/api/integrations/no-such-connection")).status()).toBe(404)
    expect((await request.delete("/api/integrations/env:github")).status()).toBe(404)
  })
})
