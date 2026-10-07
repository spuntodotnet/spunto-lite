import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Delegated work end to end, on a real container, with no forge and no API key.
//
// The project fabricates its own git repository and a bare `origin` in its postCreate (the Cloud's
// "Tasks Sandbox"), and its agent command is `fixtures/fake-claude.js` — a stand-in that speaks
// Claude Code's interactive stream-json on stdin/stdout, commits and pushes for real, and names
// the conversation in its transcript. So the default protocol (`claude-stream`) runs for real:
// the FIFO stdin, `session.ended` as the hand-back, a live reply, an interrupt, the title probe.
//
// Opt-in, like the other specs that spawn workers: E2E_DOCKER=1.

const RUN = process.env.E2E_DOCKER === "1"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE = readFileSync(path.join(__dirname, "../fixtures/fake-claude.js")).toString("base64")

const POST_CREATE = `set -e
echo ${FAKE} | base64 -d > $HOME/fake-claude.js
cd /workspace
if [ ! -d .git ]; then
  git init -q -b main .
  echo sandbox > README.md
  echo ".sandbox-origin.git/" > .gitignore
  git config user.email sandbox@spunto.test
  git config user.name "Spunto sandbox"
  git add -A && git commit -qm initial
  git init -q --bare -b main .sandbox-origin.git
  git remote add origin /workspace/.sandbox-origin.git
  git push -q -u origin main
fi`

type Task = {
  id: string
  state: string
  title: string
  workerId: string | null
  pendingAction: string | null
  error: string | null
  machine?: string | null
  canResume?: boolean
}

async function workerState(request: APIRequestContext, id: string): Promise<string> {
  return (await (await request.get(`/api/workers/${id}`)).json()).state
}

async function task(request: APIRequestContext, id: string): Promise<Task> {
  const res = await request.get(`/api/tasks/${id}`)
  expect(res.status()).toBe(200)
  return res.json()
}

async function until(request: APIRequestContext, id: string, ok: (t: Task) => boolean, timeoutMs: number): Promise<Task> {
  const deadline = Date.now() + timeoutMs
  let t = await task(request, id)
  while (!ok(t) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    t = await task(request, id)
  }
  return t
}

async function events(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/tasks/${id}/events?since=0&limit=2000`)).json()) as {
    usage: { turns: number | null; costUsd: number | null } | null
    events: { seq: number; type: string; payload: Record<string, unknown> }[]
  }
}

test.describe("task lifecycle on a real worker", () => {
  test.skip(!RUN, "Set E2E_DOCKER=1 to run — spawns a real worker.")
  test.describe.configure({ mode: "serial" })

  let projectId: string
  const workers = new Set<string>()

  test.beforeAll(async ({ request }) => {
    const res = await request.post("/api/projects", {
      data: {
        name: `e2e-tasks-lifecycle-${Date.now()}`,
        image: "node:24",
        postCreateCommand: POST_CREATE,
        taskAgentCommand: "node $HOME/fake-claude.js",
        taskFollowUpCommand: "node $HOME/fake-claude.js",
        taskValidateCommand: 'git log --oneline -1 "$SPUNTO_TASK_BRANCH" && echo accepted',
      },
    })
    expect(res.status(), await res.text()).toBe(201)
    projectId = (await res.json()).id
  })

  test.afterAll(async ({ request }) => {
    for (const id of workers) await request.delete(`/api/workers/${id}`).catch(() => {})
    if (projectId) await request.delete(`/api/projects/${projectId}`).catch(() => {})
  })

  test("delegate → running → in review → reply live → interrupt → accept", async ({ request }) => {
    test.setTimeout(12 * 60_000)
    const created = await (await request.post(`/api/projects/${projectId}/tasks`, { data: { prompt: "Write a note" } })).json()

    let t = await until(request, created.id, (x) => x.state === "in-review" || x.state === "failed", 10 * 60_000)
    expect(t.state, t.error ?? "").toBe("in-review")
    if (t.workerId) workers.add(t.workerId)
    // The session named itself, out of band, from its transcript.
    expect(t.title).toBe("Fake session names itself")
    expect(t.canResume).toBe(true)

    let log = await events(request, created.id)
    const types = log.events.map((e) => e.type)
    expect(types[0]).toBe("message") // what the human said, written by the platform
    expect(types).toEqual(expect.arrayContaining(["session.started", "tool.call", "tool.result", "usage", "session.ended", "session.title"]))
    expect(log.usage?.turns).toBe(1)

    const diff = await (await request.get(`/api/tasks/${created.id}/diff`)).json()
    expect(diff.available).toBe(true)
    expect(diff.repos[0].files.map((f: { path: string }) => f.path)).toContain(`TASK-${created.id}-1.md`)

    // The interactive session is still alive: a reply goes straight to its stdin.
    const reply = await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "And a second one" } })
    expect(reply.status(), await reply.text()).toBe(202)
    expect((await reply.json()).state).toBe("running")
    t = await until(request, created.id, (x) => x.state === "in-review", 60_000)
    log = await events(request, created.id)
    expect(log.events.filter((e) => e.type === "session.ended")).toHaveLength(2)

    // Interrupt a turn in flight: the session survives it.
    await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "do something slow" } })
    await until(request, created.id, (x) => x.state === "running", 30_000)
    await expect
      .poll(async () => (await events(request, created.id)).events.some((e) => e.payload.text === "Starting something long…"), { timeout: 30_000 })
      .toBe(true)
    expect((await request.post(`/api/tasks/${created.id}/interrupt`)).status()).toBe(202)
    t = await until(request, created.id, (x) => x.state === "in-review", 60_000)
    expect(t.state).toBe("in-review")

    // Accept runs the project's command in the task's worker; exit 0 ⇒ done.
    const accept = await request.post(`/api/tasks/${created.id}/validate`)
    expect(accept.status()).toBe(202)
    expect((await accept.json()).pendingAction).toBe("accepting")
    t = await until(request, created.id, (x) => x.state === "done", 60_000)
    expect(t.state).toBe("done")
    expect(t.pendingAction).toBeNull()
    const commands = await (await request.get(`/api/tasks/${created.id}/commands`)).json()
    expect(commands.map((c: { label: string }) => c.label)).toEqual(["Branch setup", "Agent session", "Accept command"])
    expect(commands[2].stdout).toContain("accepted")
    // Accepted, the machine goes back to the pool parked — not left running until the next task.
    await expect.poll(() => workerState(request, t.workerId!), { timeout: 60_000 }).toBe("stopped")
  })

  test("the next task recycles the pool worker, parks it for review, wakes it for a reply, and drops", async ({ request }) => {
    test.setTimeout(8 * 60_000)
    await request.patch(`/api/projects/${projectId}`, { data: { taskReviewMode: "stop", taskResetCommand: "echo reset-ran" } })
    const created = await (await request.post(`/api/projects/${projectId}/tasks`, { data: { title: "Second", prompt: "Another note" } })).json()
    let t = await until(request, created.id, (x) => x.state === "in-review" || x.state === "failed", 5 * 60_000)
    expect(t.state, t.error ?? "").toBe("in-review")
    expect(workers.has(t.workerId!)).toBe(true) // the same machine
    // A typed title is never replaced by the session's.
    expect(t.title).toBe("Second")

    const commands = await (await request.get(`/api/tasks/${created.id}/commands`)).json()
    expect(commands.find((c: { label: string }) => c.label === "Reset")?.stdout).toContain("reset-ran")
    // Review mode `stop` parks the worker.
    await expect.poll(async () => (await (await request.get(`/api/workers/${t.workerId}`)).json()).state, { timeout: 60_000 }).toBe("stopped")

    // A reply wakes it and resumes the session.
    expect((await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "One more" } })).status()).toBe(202)
    t = await until(request, created.id, (x) => x.pendingAction === null, 3 * 60_000)
    expect(t.error).toBeNull()
    const labels = (await (await request.get(`/api/tasks/${created.id}/commands`)).json()).map((c: { label: string }) => c.label)
    expect(labels).toContain("Follow-up")

    // Drop: the task ends failed, with the reason.
    expect((await request.post(`/api/tasks/${created.id}/cancel`)).status()).toBe(202)
    t = await until(request, created.id, (x) => x.state === "failed", 60_000)
    expect(t.error).toBe("Cancelled")
    // Dropped, the machine is parked again (the reply had woken it).
    await expect.poll(() => workerState(request, t.workerId!), { timeout: 60_000 }).toBe("stopped")
  })

  test("the computer restarts under a running session: stopped, not failed — a reply wakes it and goes on", async ({ request }) => {
    test.setTimeout(8 * 60_000)
    await request.patch(`/api/projects/${projectId}`, { data: { taskReviewMode: "keep" } })
    const created = await (await request.post(`/api/projects/${projectId}/tasks`, { data: { title: "Third", prompt: "A third note" } })).json()
    let t = await until(request, created.id, (x) => x.state === "in-review" || x.state === "failed", 5 * 60_000)
    expect(t.state, t.error ?? "").toBe("in-review")
    expect(t.machine).toBe("awake")
    const workerId = t.workerId!

    // A turn in flight…
    await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "do something slow" } })
    await expect
      .poll(async () => (await events(request, created.id)).events.some((e) => e.payload.text === "Starting something long…"), { timeout: 30_000 })
      .toBe(true)

    // …and the machine goes down under it, from outside Lite — what a shutdown does to every
    // container (SIGTERM, then SIGKILL: exit 143 or 137).
    const { containerId } = await (await request.get(`/api/workers/${workerId}`)).json()
    execFileSync("docker", ["stop", "-t", "1", containerId])

    // A stop, not a crash; and the task waits in review, saying how to go on.
    await expect.poll(() => workerState(request, workerId), { timeout: 30_000 }).toBe("stopped")
    t = await until(request, created.id, (x) => x.state !== "running", 60_000)
    expect(t.state).toBe("in-review")
    expect(t.machine).toBe("parked")
    expect(t.error).toContain("reply to wake it")

    // A reply wakes the machine, checks the branch, and resumes the session.
    const reply = await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "Pick it up" } })
    expect(reply.status(), await reply.text()).toBe(202)
    t = await until(request, created.id, (x) => x.pendingAction === null, 3 * 60_000)
    expect(t.error).toBeNull()
    t = await until(request, created.id, (x) => x.state === "in-review", 60_000)
    expect(t.state).toBe("in-review")
    const labels = (await (await request.get(`/api/tasks/${created.id}/commands`)).json()).map((c: { label: string }) => c.label)
    expect(labels).toEqual(expect.arrayContaining(["Branch check", "Follow-up"]))

    // Park and Wake by hand.
    expect((await request.post(`/api/tasks/${created.id}/park`)).status()).toBe(200)
    await expect.poll(() => workerState(request, workerId), { timeout: 60_000 }).toBe("stopped")
    expect((await task(request, created.id)).machine).toBe("parked")
    expect((await request.post(`/api/tasks/${created.id}/park`)).status()).toBe(409)
    expect((await request.post(`/api/tasks/${created.id}/wake`)).status()).toBe(200)
    await expect.poll(() => workerState(request, workerId), { timeout: 2 * 60_000 }).toBe("ready")

    // Accepted: done, and the machine parked for the next task.
    expect((await request.post(`/api/tasks/${created.id}/validate`)).status()).toBe(202)
    t = await until(request, created.id, (x) => x.state === "done", 60_000)
    expect(t.state, t.error ?? "").toBe("done")
    await expect.poll(() => workerState(request, workerId), { timeout: 60_000 }).toBe("stopped")
  })
})
