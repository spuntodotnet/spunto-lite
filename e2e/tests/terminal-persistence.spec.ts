import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"

// What dtach is *for*, against a real container: a session outlives the browser that opened it.
//
// The scripts are unit-tested in `@spunto/build`, but nothing there can prove the whole chain —
// `docker exec` → dtach master → script(1) recording → replay on reattach — actually holds inside
// a worker. That is what this asserts, and it is the reason the terminal moved off tmux.
//
// OPT-IN like the rest of the Docker suite: E2E_DOCKER=1. The first spawn builds an image.

const RUN = process.env.E2E_DOCKER === "1"
const IMAGE = "mcr.microsoft.com/devcontainers/typescript-node:20"
const SESSION = "persist"

async function poll<T>(fn: () => Promise<T>, until: (v: T) => boolean, timeoutMs: number, everyMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  do {
    last = await fn()
    if (until(last)) return last
    await new Promise((r) => setTimeout(r, everyMs))
  } while (Date.now() < deadline)
  return last
}

/**
 * Opens the terminal WebSocket, optionally types `send`, and resolves with everything printed.
 * `holdMs` is how long to stay attached — the session keeps running after it closes, which is
 * the whole point.
 */
function attach(baseURL: string, workerId: string, send: string | null, holdMs: number): Promise<string> {
  const url = `${baseURL.replace(/^http/, "ws")}/api/workers/${workerId}/terminal?cols=100&rows=30&session=${SESSION}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let out = ""
    const timer = setTimeout(() => {
      ws.close()
      resolve(out)
    }, holdMs)
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("terminal websocket failed"))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.type === "output") out += Buffer.from(msg.data, "base64").toString("utf8")
      if (msg.type === "error") {
        clearTimeout(timer)
        reject(new Error(msg.message))
      }
      if (msg.type === "ready" && send) {
        const data = Buffer.from(send, "utf8").toString("base64")
        setTimeout(() => ws.send(JSON.stringify({ type: "input", data })), 800)
      }
    }
  })
}

async function sessions(request: APIRequestContext, workerId: string) {
  const res = await request.get(`/api/workers/${workerId}/sessions`)
  expect(res.status()).toBe(200)
  return (await res.json()) as { name: string; attached: boolean; command: string; title: string }[]
}

test.describe("terminal persistence (Docker)", () => {
  test.skip(!RUN, "Set E2E_DOCKER=1 to run — needs a real Docker socket and builds an image.")
  // Serial: the three tests share one worker and one session, and the last one kills it. Run in
  // parallel they race — the kill landing while another is still attached to the same socket.
  test.describe.configure({ mode: "serial" })

  let projectId = ""
  let workerId = ""

  test.beforeAll(async ({ request }) => {
    const p = await request.post("/api/projects", { data: { name: `e2e-term-${Date.now()}`, image: IMAGE } })
    expect(p.status(), await p.text()).toBe(201)
    projectId = (await p.json()).id
    const w = await request.post(`/api/projects/${projectId}/workers`, { data: {} })
    expect(w.status(), await w.text()).toBe(201)
    workerId = (await w.json()).id

    const state = await poll(
      async () => (await (await request.get(`/api/workers/${workerId}`)).json()).state,
      (s) => s === "ready" || s === "error",
      9 * 60_000,
    )
    expect(state, "worker should reach ready").toBe("ready")
  })

  test.afterAll(async ({ request }) => {
    if (projectId) await request.delete(`/api/projects/${projectId}`)
  })

  test("a session survives the browser that opened it, and replays what it missed", async ({ request, baseURL }) => {
    // A command that keeps printing after we disconnect — so what comes back on reattach can only
    // have been produced while nothing was attached.
    const first = await attach(baseURL!, workerId, "for i in 1 2 3 4 5 6 7 8; do echo TICK-$i; sleep 2; done\n", 6000)
    expect(first, "the shell should answer while attached").toContain("TICK-1")

    // Detached: the socket is there, nobody is on it.
    const listed = await poll(() => sessions(request, workerId), (s) => s.some((x) => x.name === SESSION), 20_000)
    const session = listed.find((s) => s.name === SESSION)!
    expect(session, "the session must outlive the websocket").toBeTruthy()
    expect(session.attached, "nothing is attached once the websocket is closed").toBe(false)

    // The last tick is printed ~16s in, well after the first attach gave up — so it is proof the
    // loop kept running with nobody watching. Waited on as an observable condition (the session
    // falls back to its shell once the loop ends) rather than a fixed sleep.
    expect(first, "the last tick cannot have been seen yet").not.toContain("TICK-8")
    await poll(() => sessions(request, workerId), (s) => s.some((x) => x.name === SESSION && x.command !== "sleep"), 40_000, 1000)

    // Reattach. The recording gives back what we did not see.
    const second = await attach(baseURL!, workerId, null, 6000)
    expect(second, "reattaching should replay the recording").toContain("── replay ──")
    expect(second, "ticks printed while detached must come back").toContain("TICK-8")
  })

  test("an attached session is reported as attached", async ({ request, baseURL }) => {
    // The one piece of metadata tmux gave away for free: with dtach it is the control plane's own
    // bookkeeping, written by the WebSocket bridge and read by an API route that does not share a
    // module graph with it.
    const attached = attach(baseURL!, workerId, null, 8000)
    const during = await poll(
      () => sessions(request, workerId),
      (s) => s.some((x) => x.name === SESSION && x.attached),
      6000,
      500,
    )
    expect(during.find((s) => s.name === SESSION)?.attached, "attached while the socket is open").toBe(true)
    await attached

    const after = await poll(() => sessions(request, workerId), (s) => s.every((x) => !x.attached), 10_000, 500)
    expect(after.find((s) => s.name === SESSION)?.attached, "released when it closes").toBe(false)
  })

  test("a session can be killed", async ({ request }) => {
    expect((await request.delete(`/api/workers/${workerId}/sessions/${SESSION}`)).status()).toBe(204)
    const gone = await poll(() => sessions(request, workerId), (s) => !s.some((x) => x.name === SESSION), 15_000)
    expect(gone.some((s) => s.name === SESSION), "the socket and its recording should be gone").toBe(false)
  })
})
