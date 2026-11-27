// Lite Connect end to end against a fake Spunto Cloud (scripts/fake-spunto-cloud.ts): the pairing
// in OAuth, the hello, the relay and its refusals, the reconnections, 4403, the events of the Live
// Activities (`task.state`, `task.progress`, `machine.summary`), and Disconnect's revocation (RFC 7009).
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
const { emitTaskState, validateTask, cancelTask } = await import("./tasks")
const { liveEventsTick, PROGRESS_EVERY_MS, SUMMARY_DEBOUNCE_MS } = await import("./lite-events")
const { db } = await import("../db/index")
const { projects, taskEvents, tasks } = await import("../db/schema")
const { eq } = await import("drizzle-orm")

type TaskRow = typeof tasks.$inferInsert
/** A task row as `createTask` writes it — no job behind it: the tests move it by hand. */
function addTask(id: string, state: string, extra: Partial<TaskRow> = {}): TaskRow {
  const now = new Date()
  const row: TaskRow = {
    id, projectId: "p_live", title: `Task ${id}`, prompt: "do it", state,
    lastActivityAt: now, createdAt: now, startedAt: state === "queued" ? null : now, ...extra,
  }
  db.insert(tasks).values(row).run()
  return row
}
let seq = 0
function addEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
  db.insert(taskEvents).values({ taskId, seq: ++seq, ts: new Date(), type, payload }).run()
}

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
    db.insert(projects).values({ id: "p_live", name: "Live", image: "x" }).run()
    // The tick of the Live Activities' events is driven by hand, on a clock of the test's.
    startLiteTunnel({ localBase, liveTickMs: 0 })
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
    emitTaskState({ id: "t_ev", projectId: "p_ev", title: "Fix the login", error: `Agent session failed: ${"x".repeat(400)}`, startedAt: null }, "failed")
    emitTaskState({ id: "t_ev2", projectId: "p_ev", title: "Write the docs", error: null, startedAt: null }, "in-review")
    await until("two events", () => fake.eventsNamed("task.state").length >= 2)
    const [failed, review] = fake.eventsNamed("task.state").slice(-2)
    assert.equal(failed.type, "event")
    assert.equal(failed.event, "task.state")
    assert.equal(failed.taskId, "t_ev")
    assert.equal(failed.projectId, "p_ev")
    assert.equal(failed.state, "failed")
    assert.equal(failed.title, "Fix the login")
    assert.equal((failed.lastMessage as string).length, 200)
    assert.match(failed.lastMessage as string, /^Agent session failed: x+…$/)
    assert.match(review.at as string, /^\d{4}-\d\d-\d\dT/)
    assert.deepEqual({ ...review, at: "…" }, { type: "event", event: "task.state", taskId: "t_ev2", projectId: "p_ev", state: "in-review", title: "Write the docs", at: "…" })
  })

  it("task.state: every state, with startedAt once it started, and lastMessage only once it stopped", async () => {
    const startedAt = new Date("2026-11-27T10:00:00.000Z")
    const task = { id: "t_states", projectId: "p_ev", title: "All the states", error: null }
    addTask("t_ev3", "done")
    addEvent("t_ev3", "message", { role: "assistant", text: "Done.\nAll tests pass." })
    const states = () => fake.eventsNamed("task.state")
    const before = states().length
    emitTaskState({ ...task, startedAt: null }, "queued")
    emitTaskState({ ...task, startedAt }, "running")
    emitTaskState({ ...task, id: "t_ev3", startedAt }, "done")
    await until("three events", () => states().length >= before + 3)
    const [queued, running, done] = states().slice(before)
    assert.equal(queued.state, "queued")
    assert.equal("startedAt" in queued, false)
    assert.equal("lastMessage" in queued, false)
    assert.equal(running.state, "running")
    assert.equal(running.startedAt, "2026-11-27T10:00:00.000Z")
    assert.equal("lastMessage" in running, false)
    assert.equal(done.state, "done")
    assert.equal(done.lastMessage, "Done. All tests pass.")
    assert.equal(fake.liveActivities.get("t_ev3")!.state, "done")
  })

  it("task.state: one per transition — Accept sends done once; a Drop, the member's own move, sends none", async () => {
    addTask("t_accept", "in-review")
    addTask("t_drop", "in-review")
    const before = fake.eventsNamed("task.state").length
    await validateTask("t_accept")
    await until("accepted", () => db.select().from(tasks).where(eq(tasks.id, "t_accept")).get()!.state === "done")
    await assert.rejects(validateTask("t_accept"), /Task is done/)
    await cancelTask("t_drop")
    await until("dropped", () => db.select().from(tasks).where(eq(tasks.id, "t_drop")).get()!.state === "failed")
    await sleep(200)
    const sent = fake.eventsNamed("task.state").slice(before)
    assert.deepEqual(sent.map((e) => [e.taskId, e.state]), [["t_accept", "done"]])
  })

  it("task.progress: the agent's last line or tool, at most every 20 s per task, and only when it changed", async () => {
    // The summary's own sends are another test's business: this one starts from a quiet tick.
    const t0 = Date.now() + 1_000_000
    addTask("t_prog", "running")
    const progress = () => fake.eventsNamed("task.progress").filter((e) => e.taskId === "t_prog")
    liveEventsTick(t0)
    await sleep(100)
    assert.equal(progress().length, 0, "nothing said, nothing sent")

    addEvent("t_prog", "tool.call", { callId: "c1", name: "Edit", input: JSON.stringify({ file_path: "/workspace/spunto-lite/lib/foo.ts", old_string: "a" }) })
    liveEventsTick(t0 + 1_000)
    await until("the first progress", () => progress().length === 1)
    assert.deepEqual({ ...progress()[0], at: "…" }, { type: "event", event: "task.progress", taskId: "t_prog", projectId: "p_live", title: "Task t_prog", activity: "Edit lib/foo.ts", at: "…" })
    assert.equal(progress()[0].at, new Date(t0 + 1_000).toISOString())

    // Unchanged: nothing, however long.
    liveEventsTick(t0 + 1_000 + PROGRESS_EVERY_MS * 2)
    // A subagent's line is not the session's: still unchanged.
    addEvent("t_prog", "message", { role: "assistant", text: "subagent chatter", parentCallId: "c0" })
    liveEventsTick(t0 + 1_000 + PROGRESS_EVERY_MS * 2 + 1_000)
    await sleep(100)
    assert.equal(progress().length, 1)

    // Changed, but 20 s have not passed since the last send — wait; then the latest line goes.
    const t1 = t0 + 100_000
    addEvent("t_prog", "message", { role: "assistant", text: "Let me run the tests." })
    liveEventsTick(t1)
    await until("the second progress", () => progress().length === 2)
    addEvent("t_prog", "tool.call", { callId: "c2", name: "Bash", input: JSON.stringify({ command: "npm test" }) })
    liveEventsTick(t1 + 5_000)
    addEvent("t_prog", "message", { role: "assistant", text: "Tests are green.\n\n```\nok 12\n```" })
    liveEventsTick(t1 + PROGRESS_EVERY_MS - 1)
    await sleep(100)
    assert.equal(progress().length, 2, "throttled")
    liveEventsTick(t1 + PROGRESS_EVERY_MS)
    await until("the third progress", () => progress().length === 3)
    assert.deepEqual(progress().map((e) => e.activity), ["Edit lib/foo.ts", "Let me run the tests.", "Tests are green."])
    assert.equal(fake.liveActivities.get("t_prog")!.activity, "Tests are green.")

    // A long line is clipped like a notification.
    addEvent("t_prog", "message", { role: "assistant", text: `${"y".repeat(300)}` })
    liveEventsTick(t1 + PROGRESS_EVERY_MS * 2)
    await until("the fourth progress", () => progress().length === 4)
    assert.equal((progress()[3].activity as string).length, 200)
    db.update(tasks).set({ state: "in-review" }).where(eq(tasks.id, "t_prog")).run()
  })

  it("machine.summary: on change, debounced ~2 s, as the Agents page counts", async () => {
    const t0 = Date.now() + 10_000_000
    // Settle: whatever changed before this test goes out, and the next tick is quiet.
    liveEventsTick(t0)
    liveEventsTick(t0 + SUMMARY_DEBOUNCE_MS)
    const summaries = () => fake.eventsNamed("machine.summary")
    await sleep(100)
    const settled = summaries().length
    liveEventsTick(t0 + SUMMARY_DEBOUNCE_MS * 2)
    await sleep(100)
    assert.equal(summaries().length, settled, "no change, no summary")

    const t1 = t0 + 100_000
    addTask("t_sq", "queued", { lastActivityAt: new Date(t1) })
    liveEventsTick(t1)
    liveEventsTick(t1 + 1_000)
    // A second change inside the window rides along with the first.
    addTask("t_sr", "running", { lastActivityAt: new Date(t1 + 1) })
    addEvent("t_sr", "tool.call", { name: "mcp__spunto-tasks__create_subtask", input: "{}" })
    // Set aside: not on the Agents page by default, so not counted.
    addTask("t_hold", "in-review", { onHoldAt: new Date(), lastActivityAt: new Date(t1 + 2) })
    liveEventsTick(t1 + 1_500)
    await sleep(100)
    assert.equal(summaries().length, settled, "debounced")
    liveEventsTick(t1 + SUMMARY_DEBOUNCE_MS)
    await until("one summary", () => summaries().length === settled + 1)
    liveEventsTick(t1 + SUMMARY_DEBOUNCE_MS + 1_000)
    await sleep(100)
    assert.equal(summaries().length, settled + 1, "one for the two changes")

    const summary = summaries().at(-1)!
    const live = db.select().from(tasks).all().filter((t) => ["queued", "running", "in-review"].includes(t.state) && !t.onHoldAt)
    assert.equal(summary.running, live.filter((t) => t.state === "running").length)
    assert.equal(summary.queued, live.filter((t) => t.state === "queued").length)
    assert.equal(summary.inReview, live.filter((t) => t.state === "in-review").length)
    const listed = summary.tasks as Record<string, unknown>[]
    assert.equal(listed.length, 3)
    assert.deepEqual(listed.slice(0, 2), [
      { taskId: "t_sr", projectId: "p_live", title: "Task t_sr", state: "running", activity: "create_subtask" },
      { taskId: "t_sq", projectId: "p_live", title: "Task t_sq", state: "queued" },
    ])
    assert.equal(listed.some((t) => t.taskId === "t_hold"), false)
    assert.deepEqual(summary.last, { taskId: "t_prog", title: "Task t_prog", state: "in-review", at: (summary.last as { at: string }).at })
    assert.equal(summary.at, new Date(t1 + SUMMARY_DEBOUNCE_MS).toISOString())
    assert.deepEqual(fake.machine, summary)

    // A task that stops is the new `last`.
    db.update(tasks).set({ state: "failed", lastActivityAt: new Date(t1 + 10) }).where(eq(tasks.id, "t_sr")).run()
    liveEventsTick(t1 + 10_000)
    liveEventsTick(t1 + 10_000 + SUMMARY_DEBOUNCE_MS)
    await until("the next summary", () => summaries().length === settled + 2)
    const next = summaries().at(-1)!
    assert.equal(next.running, (summary.running as number) - 1)
    assert.equal((next.last as Record<string, unknown>).taskId, "t_sr")
    assert.equal((next.last as Record<string, unknown>).state, "failed")
  })

  it("machine.summary: sent right after every welcome, as the machine is now", async () => {
    const welcomes = fake.welcomes
    const before = fake.eventsNamed("machine.summary").length
    fake.closeTunnels(1012, "redeploy")
    await until("welcomed again", () => fake.welcomes > welcomes && liteTunnel()!.status().state === "online")
    await until("the summary", () => fake.eventsNamed("machine.summary").length === before + 1)
    const replayed = fake.eventsNamed("machine.summary").at(-1)!
    // Right after the welcome, before anything else this tunnel sends.
    assert.equal(fake.events.at(-1), replayed)
    assert.equal(replayed.queued, db.select().from(tasks).where(eq(tasks.state, "queued")).all().length)
    assert.equal((replayed.last as Record<string, unknown>).taskId, "t_sr")
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
    // Nothing goes up a closed tunnel — and nothing is kept for later.
    const events = fake.events.length
    emitTaskState({ id: "t_x", projectId: "p", title: "t", error: null, startedAt: null }, "in-review")
    addTask("t_off", "running")
    addEvent("t_off", "message", { role: "assistant", text: "Working offline." })
    const t = Date.now() + 100_000_000
    liveEventsTick(t)
    liveEventsTick(t + 60_000)
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

  it("a new registration gives the old client's refresh token back before replacing it", async () => {
    await pair()
    const oldClient = lc.getLiteConnect().clientId!
    const revocations = fake.revocations.length
    // Lite opened from another origin: another redirect URI, so another client.
    const authorize = new URL(await lc.startLiteConnect("http://localhost:3999"))
    const newClient = authorize.searchParams.get("client_id")!
    assert.notEqual(newClient, oldClient)
    assert.equal(fake.revocations.length, revocations + 1)
    const { params, status } = fake.revocations.at(-1)!
    assert.equal(params.client_id, oldClient)
    assert.match(params.token, /^spr_/)
    assert.equal(status, 200)
    assert.equal([...fake.refreshTokens.values()].includes(oldClient), false, "the old grant is gone at Spunto")
    const view = lc.getLiteConnectView()
    assert.equal(view.connected, false)
    assert.equal(view.lastError, null)
    await until("off", () => liteTunnel()!.status().state === "off")
    // The pairing goes on with the new client.
    const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!)
    await lc.finishLiteConnect({ state: back.searchParams.get("state")!, code: back.searchParams.get("code")! })
    await until("online", () => liteTunnel()!.status().state === "online")
  })

  it("Disconnect gives the refresh token back (RFC 7009), then closes the tunnel and forgets the tokens", async () => {
    await pair()
    assert.throws(() => lc.updateLiteConnect({ spuntoUrl: "https://elsewhere.example" }), /Disconnect before/)
    const clientId = lc.getLiteConnect().clientId!
    const held = [...fake.refreshTokens].filter(([, c]) => c === clientId).map(([t]) => t)
    assert.equal(held.length, 1)
    const revocations = fake.revocations.length
    // What the card would read while Spunto has closed the tunnel and not answered yet.
    let during: ReturnType<typeof lc.getLiteConnectView> | null = null
    fake.beforeRevokeAnswer = async () => {
      await until("the 4403 heard", () => liteTunnel()!.status().state === "off")
      during = lc.getLiteConnectView()
    }
    const view = await lc.disconnectLiteConnect()
    fake.beforeRevokeAnswer = null
    assert.equal(during!.lastError, null, "the 4403 that follows the revocation is no error")
    assert.equal(fake.revocations.length, revocations + 1)
    const call = fake.revocations.at(-1)!
    assert.equal(call.contentType, "application/x-www-form-urlencoded")
    assert.deepEqual(call.params, { token: held[0], client_id: clientId })
    assert.equal(call.status, 200)
    assert.equal(view.revoked, true)
    assert.equal(view.connected, false)
    assert.equal(view.lastError, null)
    assert.equal(view.tunnel.state, "off")
    assert.equal(lc.getLiteConnect().encryptedAccessToken, null)
    assert.equal(lc.getLiteConnect().encryptedRefreshToken, null)
    await until("closed at the fake", () => fake.online === 0)
    const hellos = fake.hellos.length
    await sleep(1_500)
    assert.equal(fake.hellos.length, hellos)
    assert.equal(lc.getLiteConnectView().lastError, null)
  })

  for (const failure of ["unreachable", 503] as const) {
    it(`Disconnect with Spunto ${failure === "unreachable" ? "unreachable" : `answering ${failure}`} forgets anyway, and says so`, async () => {
      await pair()
      fake.revokeFailure = failure
      try {
        const view = await lc.disconnectLiteConnect()
        assert.equal(fake.revocations.at(-1)!.params.client_id, lc.getLiteConnect().clientId)
        assert.equal(view.revoked, false)
        assert.equal(view.connected, false)
        assert.equal(view.tunnel.state, "off")
        assert.equal(lc.getLiteConnect().encryptedRefreshToken, null)
        assert.match(view.lastError ?? "", /may still be listed there — remove it in Account Settings → Connected apps/)
        assert.match(view.lastError ?? "", failure === "unreachable" ? /unreachable/ : /server_error/)
        await until("closed at the fake", () => fake.online === 0)
      } finally {
        fake.revokeFailure = null
      }
    })
  }

  it("Disconnect when not connected asks Spunto nothing; the URL can change again", async () => {
    const revocations = fake.revocations.length
    const view = await lc.disconnectLiteConnect()
    assert.equal(view.revoked, true)
    assert.equal(fake.revocations.length, revocations)
    assert.equal(lc.updateLiteConnect({ spuntoUrl: "https://elsewhere.example/" }).spuntoUrl, "https://elsewhere.example")
  })
})
