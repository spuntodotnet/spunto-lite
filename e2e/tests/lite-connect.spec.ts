import { test, expect } from "@playwright/test"

// Settings → Connect to Spunto (docs/lite-connect.md), without a Spunto: what the card reads and
// what it may write. The pairing and the tunnel themselves are covered against a fake Spunto Cloud
// by `npm test` (services/lite-tunnel.test.ts). Serial: a single global row.
test.describe.configure({ mode: "serial" })

test.describe("lite connect", () => {
  test("GET never carries a token, and reads the defaults on a fresh install", async ({ request }) => {
    const res = await request.get("/api/lite-connect")
    expect(res.status()).toBe(200)
    const view = await res.json()
    expect(Object.keys(view).sort()).toEqual(
      ["capabilities", "connected", "connectedAt", "connectionId", "defaultMachineName", "lastError", "machineName", "spuntoUrl", "tunnel"].sort(),
    )
    if (!view.connected) expect(view.tunnel.state).toBe("off")
  })

  test("PATCH keeps the capabilities to the known ones, and the URL to an origin", async ({ request }) => {
    const before = (await (await request.get("/api/lite-connect")).json()) as { connected: boolean; spuntoUrl: string; capabilities: string[] }
    test.skip(before.connected, "this instance is connected: its URL is locked")
    const unknown = await request.patch("/api/lite-connect", { data: { capabilities: ["read", "root"] } })
    expect(unknown.status()).toBe(400)
    const bad = await request.patch("/api/lite-connect", { data: { spuntoUrl: "ftp://spunto.net" } })
    expect(bad.status()).toBe(400)

    const ok = await request.patch("/api/lite-connect", { data: { spuntoUrl: "https://spunto.example/some/path", capabilities: ["reply", "read"] } })
    expect(ok.status()).toBe(200)
    const view = await ok.json()
    expect(view.spuntoUrl).toBe("https://spunto.example")
    expect(view.capabilities).toEqual(["read", "reply"])
    await request.patch("/api/lite-connect", { data: { spuntoUrl: before.spuntoUrl, capabilities: before.capabilities } })
  })

  test("the callback refuses an authorization it did not start", async ({ request }) => {
    const res = await request.get("/api/lite-connect/callback?state=forged&code=x", { maxRedirects: 0 })
    expect(res.status()).toBe(302)
    expect(res.headers().location).toContain("liteError=")
  })
})
