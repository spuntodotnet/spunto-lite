// Lite Connect end to end against a fake Spunto Cloud (scripts/fake-spunto-cloud.ts): the pairing
// in OAuth, the hello, the relay and its refusals, the reconnections, 4403, `task.state`.
// Lite's own routes are a stub listener here, so the test sees exactly what reaches them. `npm test`.
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeSpuntoCloud } from "../scripts/fake-spunto-cloud"

const dataDir = mkdtempSync(join(tmpdir(), "lite-connect-test-"))
process.env.DATA_DIR = dataDir
process.env.DB_PATH = join(dataDir, "test.db")

// After the environment: the database opens on first use, at DB_PATH.
const { runMigrations } = await import("../db/index")
const lc = await import("./lite-connect")
const { startLiteTunnel } = await import("./lite-tunnel")
const { liteTunnel } = await import("../lib/lite-connect-hooks")
const { emitTaskState } = await import("./tasks")

async function until<T>(what: string, probe: () => T | undefined | null | false, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("Lite Connect, against a fake Spunto Cloud", () => {
  const fake = new FakeSpuntoCloud()
  let spuntoUrl = ""
  /** What reached Lite's own routes. */
  const served: { method: string; url: string; body: string }[] = []
  let local: Server
  let localBase = ""

  before(async () => {
    runMigrations()
    spuntoUrl = await fake.listen()
    local = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        served.push({ method: req.method!, url: req.url!, body })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ served: `${req.method} ${req.url}` }))
      })
    })
    await new Promise<void>((r) => local.listen(0, "127.0.0.1", r))
    localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`
    startLiteTunnel({ localBase })
  })

  after(async () => {
    liteTunnel()?.stop()
    await fake.close()
    await new Promise((r) => local.close(r))
    rmSync(dataDir, { recursive: true, force: true })
  })

  it("is off by default: nothing dials before Connect", async () => {
    const view = lc.getLiteConnectView()
    assert.equal(view.connected, false)
    assert.equal(view.spuntoUrl, "https://spunto.net")
    assert.deepEqual(view.capabilities, ["read"])
    assert.equal(view.tunnel.state, "off")
    await sleep(300)
    assert.equal(fake.hellos.length, 0)
  })

  it("pairs in OAuth (register, PKCE, callback, token), then says hello with read only", async () => {
    lc.updateLiteConnect({ spuntoUrl, machineName: "Test laptop" })
    const authorize = new URL(await lc.startLiteConnect("http://localhost:3000"))
    assert.equal(authorize.origin + authorize.pathname, `${spuntoUrl}/api/oauth/authorize`)
    assert.equal(authorize.searchParams.get("scope"), "lite")
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256")
    assert.equal(authorize.searchParams.get("redirect_uri"), "http://localhost:3000/api/lite-connect/callback")
    // The member allows it (the fake does at once) and the browser comes back with a code.
    const consent = await fetch(authorize, { redirect: "manual" })
    const back = new URL(consent.headers.get("location")!)
    assert.equal(back.pathname, "/api/lite-connect/callback")
    await lc.finishLiteConnect({ state: back.searchParams.get("state")!, code: back.searchParams.get("code")! })

    await until("welcome", () => liteTunnel()!.status().state === "online")
    const hello = fake.hellos.at(-1)!
    assert.match(hello.token, /^spo_/)
    assert.equal(fake.accessTokens.has(hello.token), true)
    assert.equal(hello.name, "Test laptop")
    assert.ok(hello.version)
    assert.deepEqual(hello.capabilities, ["read"])
    const view = lc.getLiteConnectView()
    assert.equal(view.connected, true)
    assert.equal(view.connectionId, hello.connectionId)
    assert.equal(JSON.stringify(view).includes(hello.token), false, "the view never carries a token")
  })

  it("reuses its registration on the next Connect, and refuses a state it did not issue", async () => {
    const clients = fake.clients.size
    await lc.startLiteConnect("http://localhost:3000")
    assert.equal(fake.clients.size, clients)
    await assert.rejects(lc.finishLiteConnect({ state: "forged", code: "x" }), /unknown or expired/)
    assert.equal(lc.getLiteConnectView().connected, true, "a bad callback does not undo the link")
  })

  it("relays a read to Lite's own route, with its query", async () => {
    const before = served.length
    const res = await fake.relay({ method: "GET", path: "/api/tasks", query: "?state=running" })
    assert.equal(res.status, 200)
    assert.equal(res.contentType, "application/json")
    assert.deepEqual(res.json, { served: "GET /api/tasks?state=running" })
    assert.equal(served.length, before + 1)
  })

  it("refuses a route off the list, before it reaches Lite", async () => {
    const before = served.length
    for (const req of [
      { method: "GET", path: "/api/settings" },
      { method: "GET", path: "/api/projects/p1/secrets" },
      { method: "GET", path: "/api/tasks/../settings" },
      { method: "GET", path: "/api/tasks/a%2F..%2Fsettings" },
      { method: "DELETE", path: "/api/tasks/t_1" },
      { method: "GET", path: "/api/tasks", query: "?a=1#/../settings" },
    ]) {
      const res = await fake.relay(req)
      assert.equal(res.status, 403, `${req.method} ${req.path}`)
      assert.deepEqual(res.json, { error: "not_relayed" })
    }
    assert.equal(served.length, before)
  })

  it("refuses a capability it was not given; a new one takes a new hello", async () => {
    const before = served.length
    const refused = await fake.relay({ method: "POST", path: "/api/tasks/t_1/messages", contentType: "application/json", body: '{"text":"hi"}' })
    assert.equal(refused.status, 403)
    assert.deepEqual(refused.json, { error: "capability_not_granted", capability: "reply" })
    assert.equal(served.length, before)

    const hellos = fake.hellos.length
    lc.updateLiteConnect({ capabilities: ["read", "reply"] })
    await until("a new hello", () => fake.hellos.length > hellos && liteTunnel()!.status().state === "online")
    assert.deepEqual(fake.hellos.at(-1)!.capabilities, ["read", "reply"])

    const ok = await fake.relay({ method: "POST", path: "/api/tasks/t_1/messages", contentType: "application/json", body: '{"text":"hi"}' })
    assert.equal(ok.status, 200)
    assert.deepEqual(served.at(-1), { method: "POST", url: "/api/tasks/t_1/messages", body: '{"text":"hi"}' })
    const create = await fake.relay({ method: "POST", path: "/api/projects/p1/tasks", body: "{}" })
    assert.deepEqual(create.json, { error: "capability_not_granted", capability: "create" })
  })

  it("reconnects after a cut", async () => {
    const hellos = fake.hellos.length
    fake.dropTunnels()
    await until("the redial", () => fake.hellos.length > hellos && liteTunnel()!.status().state === "online")
    assert.equal((await fake.relay({ method: "GET", path: "/api/projects" })).status, 200)
  })

  it("on 4401, refreshes its token (keeping the turned refresh token) and says hello again", async () => {
    const refreshes = fake.refreshCount
    const oldToken = fake.hellos.at(-1)!.token
    fake.expireAccessTokens()
    fake.closeTunnels(1012, "redeploy")
    await until("a hello with a new token", () => fake.hellos.at(-1)!.token !== oldToken && liteTunnel()!.status().state === "online")
    assert.equal(fake.refreshCount, refreshes + 1)
    // The refresh token in hand is the one the last refresh gave: the next refresh works.
    fake.expireAccessTokens()
    fake.closeTunnels(1012, "redeploy")
    await until("the second refresh", () => fake.refreshCount === refreshes + 2 && liteTunnel()!.status().state === "online")
  })

  it("emits task.state once online, with the agent's last words clipped", async () => {
    emitTaskState({ id: "t_ev", projectId: "p_ev", title: "Fix the login", error: `Agent session failed: ${"x".repeat(400)}` }, "failed")
    emitTaskState({ id: "t_ev2", projectId: "p_ev", title: "Write the docs", error: null }, "in-review")
    await until("two events", () => fake.events.length >= 2)
    const [failed, review] = fake.events.slice(-2)
    assert.equal(failed.type, "event")
    assert.equal(failed.event, "task.state")
    assert.equal(failed.taskId, "t_ev")
    assert.equal(failed.projectId, "p_ev")
    assert.equal(failed.state, "failed")
    assert.equal(failed.title, "Fix the login")
    assert.equal((failed.lastMessage as string).length, 200)
    assert.match(failed.lastMessage as string, /^Agent session failed: x+…$/)
    assert.deepEqual(review, { type: "event", event: "task.state", taskId: "t_ev2", projectId: "p_ev", state: "in-review", title: "Write the docs" })
  })

  it("on 4409 (another tunnel took over), waits before redialing", async () => {
    const hellos = fake.hellos.length
    fake.closeTunnels(4409, "replaced by a newer connection")
    await until("retrying", () => liteTunnel()!.status().state === "retrying")
    assert.ok(liteTunnel()!.status().nextRetryAt! - Date.now() > 20_000)
    await sleep(1_500)
    assert.equal(fake.hellos.length, hellos)
    liteTunnel()!.restart()
    await until("online again", () => liteTunnel()!.status().state === "online")
  })

  it("on 4403 (disconnected in Spunto), forgets its tokens and stops", async () => {
    fake.closeTunnels(4403, "disconnected")
    await until("off", () => liteTunnel()!.status().state === "off")
    const view = lc.getLiteConnectView()
    assert.equal(view.connected, false)
    assert.match(view.lastError ?? "", /disconnected from Spunto/)
    const hellos = fake.hellos.length
    await sleep(2_500)
    assert.equal(fake.hellos.length, hellos, "no redial after 4403")
    // Nothing goes up a closed tunnel.
    const events = fake.events.length
    emitTaskState({ id: "t_x", projectId: "p", title: "t", error: null }, "in-review")
    await sleep(100)
    assert.equal(fake.events.length, events)
  })

  async function pair() {
    const authorize = await lc.startLiteConnect("http://localhost:3000")
    const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!)
    await lc.finishLiteConnect({ state: back.searchParams.get("state")!, code: back.searchParams.get("code")! })
    await until("online", () => liteTunnel()!.status().state === "online")
  }

  it("a refused refresh disconnects, and says so", async () => {
    await pair()
    fake.refuseRefresh = true
    fake.expireAccessTokens()
    fake.closeTunnels(1012)
    await until("off", () => liteTunnel()!.status().state === "off")
    const view = lc.getLiteConnectView()
    assert.equal(view.connected, false)
    assert.match(view.lastError ?? "", /refused to renew/)
    fake.refuseRefresh = false
  })

  it("Disconnect closes the tunnel and forgets the tokens; the URL can change again", async () => {
    await pair()
    assert.throws(() => lc.updateLiteConnect({ spuntoUrl: "https://elsewhere.example" }), /Disconnect before/)
    const view = lc.disconnectLiteConnect()
    assert.equal(view.connected, false)
    assert.equal(view.lastError, null)
    await until("closed at the fake", () => fake.online === 0)
    const hellos = fake.hellos.length
    await sleep(1_500)
    assert.equal(fake.hellos.length, hellos)
    assert.equal(lc.updateLiteConnect({ spuntoUrl: "https://elsewhere.example/" }).spuntoUrl, "https://elsewhere.example")
  })
})
