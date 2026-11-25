import { test, expect } from "@playwright/test"
import type { APIRequestContext } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { usageReport } from "../helpers/usage"

// Delegated work end to end, on a real container, with no forge and no API key.
//
// The project fabricates its own git repository and a bare `origin` in its postCreate (the Cloud's
// "Tasks Sandbox"), and runs under the Claude Code app (RFC 0048): its feature is really baked into
// the image (a private Node and the SDK under /opt/spunto/agents), and the session really runs a
// runner file on that Node, written from the session's environment. Only the runner's *text* is a
// stand-in — `fixtures/agent-runners/claude.mjs`, bundled like the real one, which speaks the runner
// contract on stdin and the Spunto agent contract on stdout, with no SDK and no API key. So the
// `agent-v1` dialect runs for real: the FIFO stdin, `session.ended` as the hand-back, a live reply,
// an interrupt, the title request, a resume, and the draft of a message being written.
//
// Opt-in, like the other specs that spawn workers: E2E_DOCKER=1 — and Lite started with
// AGENT_RUNNERS_DIR=e2e/fixtures/agent-runners.

const RUN = process.env.E2E_DOCKER === "1"

const POST_CREATE = `set -e
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
  branch?: string | null
  pendingAction: string | null
  error: string | null
  machine?: string | null
  canResume?: boolean
  canReopen?: boolean
  reopenBlocker?: string | null
  onHoldAt?: string | null
  pendingQuestion?: { callId: string; question: string; header: string | null; count: number } | null
  parentTaskId?: string | null
  subtaskCount?: number
  parent?: { id: string; title: string; state: string } | null
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
        agentAppIds: ["claude"],
        // No SPUNTO_TASK_BRANCH any more (RFC 0056): the checkout says which branch the agent is on.
        // It also leaves an untracked file behind, for the next task's reset to throw away.
        taskValidateCommand:
          'test -z "${SPUNTO_TASK_BRANCH:-}" && git log --oneline -1 "$(git branch --show-current)" && echo leftover > LEFTOVER.md && echo accepted',
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
    const created = await (await request.post(`/api/projects/${projectId}/tasks`, { data: { prompt: "Write a note", agentOptions: { effort: "high" } } })).json()
    expect(created.agentAppId).toBe("claude")
    expect(created.agentOptions).toEqual({ effort: "high" })

    let t = await until(request, created.id, (x) => x.state === "in-review" || x.state === "failed", 10 * 60_000)
    expect(t.state, t.error ?? "").toBe("in-review")
    if (t.workerId) workers.add(t.workerId)
    // The session named the conversation when asked, right behind its first turn.
    expect(t.title).toBe("Fake session names itself")
    expect(t.canResume).toBe(true)

    let log = await events(request, created.id)
    const types = log.events.map((e) => e.type)
    expect(types[0]).toBe("message") // what the human said, written by the platform
    expect(types).toEqual(expect.arrayContaining(["session.started", "tool.call", "tool.result", "usage", "session.ended", "session.title"]))
    expect(log.usage?.turns).toBe(1)
    // The task's parameters reached the runner, in its environment (the fake echoes them in init).
    const raw = (await (await request.get(`/api/tasks/${created.id}/events?since=0&limit=20&source=true`)).json()) as { events: { type: string; source?: string }[] }
    expect(raw.events.find((e) => e.type === "session.started")?.source).toContain('{\\"effort\\":\\"high\\"}')

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
    // A fresh worker: nothing ran before the session — no branch, no reset (RFC 0056).
    expect(commands.map((c: { label: string }) => c.label)).toEqual(["Agent session", "Accept command"])
    expect(commands[1].stdout).toContain("accepted")
    expect(t.branch).toBeNull()

    // The usage page reads it all back: two turns that reported a cost — the fake's running total,
    // 0.0123 per turn — and the interrupted one that reported none; its calls' tokens; its tools.
    const usage = await usageReport(request, "days=1&tz=Europe/Paris", { fresh: true })
    const row = usage.tasks.find((x: { id: string }) => x.id === created.id)
    expect(row, JSON.stringify(usage.totals)).toBeTruthy()
    expect(row.cost).toBeCloseTo(0.0246, 6)
    expect(row.turns).toBe(3)
    expect(row.agentAppName).toBe("Claude Code")
    expect(row.apiCalls).toBeGreaterThanOrEqual(3)
    expect(row.input).toBe(1200 * row.apiCalls)
    expect(row.peakContext).toBe(4200)
    expect(row.toolCalls).toBeGreaterThanOrEqual(2)
    expect(usage.tools.find((x: { name: string }) => x.name === "Bash")?.n).toBeGreaterThanOrEqual(2)
    expect(usage.projects.find((x: { id: string }) => x.id === projectId)?.tasks).toBe(1)
    expect(usage.daily.at(-1).cost).toBeGreaterThanOrEqual(0.0246 - 1e-9)

    // Accepted, the machine goes back to the pool parked — not left running until the next task.
    await expect.poll(() => workerState(request, t.workerId!), { timeout: 60_000 }).toBe("stopped")
  })

  test("the next task recycles the pool worker, parks it for review, wakes it for a reply, and drops", async ({ request }) => {
    test.setTimeout(12 * 60_000)
    await request.patch(`/api/projects/${projectId}`, { data: { taskReviewMode: "stop" } })
    const created = await (await request.post(`/api/projects/${projectId}/tasks`, { data: { title: "Second", prompt: "Another note" } })).json()
    let t = await until(request, created.id, (x) => x.state === "in-review" || x.state === "failed", 5 * 60_000)
    expect(t.state, t.error ?? "").toBe("in-review")
    expect(workers.has(t.workerId!)).toBe(true) // the same machine
    // A typed title is never replaced by the session's.
    expect(t.title).toBe("Second")

    // Recycled: the checkout was put back as a fresh clone would be before the session opened on
    // it — what the first task's Accept left untracked, said and thrown away.
    const ran = await (await request.get(`/api/tasks/${created.id}/commands`)).json()
    expect(ran.map((c: { label: string }) => c.label).slice(0, 2)).toEqual(["Workspace reset", "Agent session"])
    expect(ran[0].stdout).toContain("discarding leftovers from the previous task")
    expect(ran[0].stdout).toContain("On main at")
    expect(ran[0].stdout).toContain("LEFTOVER.md")
    // On the base again, the agent cut its own branch off it (the fake does, like a real one would).
    // Said in its reply rather than read off the diff: in review mode `stop` the worker may already
    // be parked, and a parked worker has no diff to give.
    const said = (await events(request, created.id)).events.filter((e) => e.type === "message" && e.payload.role === "assistant")
    expect(String(said.at(-1)?.payload.text)).toBe(`Committed \`TASK-${created.id}-1.md\` on fake/${created.id}.`)

    // Review mode `stop` parks the worker.
    await expect.poll(async () => (await (await request.get(`/api/workers/${t.workerId}`)).json()).state, { timeout: 60_000 }).toBe("stopped")

    // A reply wakes it and resumes the session.
    expect((await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "One more" } })).status()).toBe(202)
    t = await until(request, created.id, (x) => x.pendingAction === null, 3 * 60_000)
    expect(t.error).toBeNull()
    const labels = (await (await request.get(`/api/tasks/${created.id}/commands`)).json()).map((c: { label: string }) => c.label)
    expect(labels).toContain("Follow-up")

    // The agent asks a question (Claude's `AskUserQuestion`) and its turn waits on the answer: the
    // task says so (`pendingQuestion`), the answer goes into the live session, and it carries on.
    t = await until(request, created.id, (x) => x.state === "in-review", 60_000)
    expect((await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "Ask me a question" } })).status()).toBe(202)
    t = await until(request, created.id, (x) => !!x.pendingQuestion, 3 * 60_000)
    expect(t.state).toBe("running")
    expect(t.pendingQuestion).toMatchObject({ question: "Which colour?", header: "Colour", count: 1 })
    const callId = t.pendingQuestion!.callId
    const answer = { callId, answers: [{ question: "Which colour?", selected: ["Blue"] }] }
    expect((await request.post(`/api/tasks/${created.id}/answer`, { data: { callId: "nope", answers: answer.answers } })).status()).toBe(409)
    const answered = await request.post(`/api/tasks/${created.id}/answer`, { data: answer })
    expect(answered.status(), await answered.text()).toBe(202)
    t = await until(request, created.id, (x) => x.state === "in-review", 60_000)
    expect(t.pendingQuestion).toBeNull()
    let questions = (await events(request, created.id)).events.filter((e) => e.type === "question")
    expect(questions.map((e) => e.payload.status)).toEqual(["pending", "answered"])
    expect(questions[1]!.payload.answers).toEqual([{ question: "Which colour?", selected: ["Blue"] }])
    // Answered already: nothing waits on it any more.
    expect((await request.post(`/api/tasks/${created.id}/answer`, { data: answer })).status()).toBe(409)

    // A plain reply while it waits *is* the answer, in words.
    expect((await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "Another question" } })).status()).toBe(202)
    t = await until(request, created.id, (x) => !!x.pendingQuestion, 3 * 60_000)
    expect((await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "Green, neither of those" } })).status()).toBe(202)
    t = await until(request, created.id, (x) => x.state === "in-review", 60_000)
    questions = (await events(request, created.id)).events.filter((e) => e.type === "question")
    expect(questions.map((e) => e.payload.status)).toEqual(["pending", "answered", "pending", "dismissed"])
    const last = (await events(request, created.id)).events.filter((e) => e.type === "message" && e.payload.role === "assistant").at(-1)
    expect(String(last?.payload.text)).toBe("Taken as the answer: Green, neither of those")

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

    // A reply wakes the machine and resumes the session, wherever the checkout is.
    const reply = await request.post(`/api/tasks/${created.id}/messages`, { data: { prompt: "Pick it up" } })
    expect(reply.status(), await reply.text()).toBe(202)
    t = await until(request, created.id, (x) => x.pendingAction === null, 3 * 60_000)
    expect(t.error).toBeNull()
    t = await until(request, created.id, (x) => x.state === "in-review", 60_000)
    expect(t.state).toBe("in-review")
    const labels = (await (await request.get(`/api/tasks/${created.id}/commands`)).json()).map((c: { label: string }) => c.label)
    expect(labels).toContain("Follow-up")
    expect(labels).not.toContain("Branch check")

    // Park and Wake by hand.
    expect((await request.post(`/api/tasks/${created.id}/park`)).status()).toBe(200)
    await expect.poll(() => workerState(request, workerId), { timeout: 60_000 }).toBe("stopped")
    expect((await task(request, created.id)).machine).toBe("parked")
    expect((await request.post(`/api/tasks/${created.id}/park`)).status()).toBe(409)
    expect((await request.post(`/api/tasks/${created.id}/wake`)).status()).toBe(200)
    await expect.poll(() => workerState(request, workerId), { timeout: 2 * 60_000 }).toBe("ready")

    // On hold: the machine parked, the task out of the default lists and into « On hold », still
    // in review. Wake takes it off hold, back to « In review ».
    const held = await request.post(`/api/tasks/${created.id}/hold`)
    expect(held.status(), await held.text()).toBe(200)
    expect((await held.json()).onHoldAt).toBeTruthy()
    await expect.poll(() => workerState(request, workerId), { timeout: 60_000 }).toBe("stopped")
    t = await task(request, created.id)
    expect(t.state).toBe("in-review")
    expect(t.machine).toBe("parked")
    const ids = (page: { tasks: { id: string }[] }) => page.tasks.map((x) => x.id)
    const listed = await (await request.get(`/api/tasks?projectId=${projectId}`)).json()
    expect(ids(listed)).not.toContain(created.id)
    expect(listed.onHoldCount).toBe(1)
    expect(ids(await (await request.get(`/api/tasks?projectId=${projectId}&onHold=true`)).json())).toContain(created.id)
    expect((await (await request.get(`/api/projects/${projectId}/tasks`)).json()).map((x: { id: string }) => x.id)).not.toContain(created.id)
    expect((await request.post(`/api/tasks/${created.id}/wake`)).status()).toBe(200)
    await expect.poll(() => workerState(request, workerId), { timeout: 2 * 60_000 }).toBe("ready")
    expect((await task(request, created.id)).onHoldAt).toBeNull()

    // Accepted: done, and the machine parked for the next task.
    expect((await request.post(`/api/tasks/${created.id}/validate`)).status()).toBe(202)
    t = await until(request, created.id, (x) => x.state === "done", 60_000)
    expect(t.state, t.error ?? "").toBe("done")
    await expect.poll(() => workerState(request, workerId), { timeout: 60_000 }).toBe("stopped")
  })

  test("a failed task is picked back up by a reply, even on a worker another task holds now", async ({ request }) => {
    test.setTimeout(10 * 60_000)
    await request.patch(`/api/projects/${projectId}`, { data: { taskReviewMode: "keep" } })
    const first = await (await request.post(`/api/projects/${projectId}/tasks`, { data: { title: "Fourth", prompt: "A fourth note" } })).json()
    let a = await until(request, first.id, (x) => x.state === "in-review" || x.state === "failed", 5 * 60_000)
    expect(a.state, a.error ?? "").toBe("in-review")
    const workerId = a.workerId!
    workers.add(workerId)

    // Dropped: failed, its machine handed back to the pool — and still answerable.
    expect((await request.post(`/api/tasks/${first.id}/cancel`)).status()).toBe(202)
    a = await until(request, first.id, (x) => x.state === "failed", 60_000)
    expect(a.canReopen).toBe(true)
    expect(a.reopenBlocker).toBeNull()

    // The pool gives that machine to the next task.
    const second = await (await request.post(`/api/projects/${projectId}/tasks`, { data: { title: "Fifth", prompt: "A fifth note" } })).json()
    let b = await until(request, second.id, (x) => x.state === "in-review" || x.state === "failed", 5 * 60_000)
    expect(b.state, b.error ?? "").toBe("in-review")
    expect(b.workerId).toBe(workerId)

    // A reply to the failed one puts it back in review, then to work, on the same — shared — machine.
    const reply = await request.post(`/api/tasks/${first.id}/messages`, { data: { prompt: "Pick it back up" } })
    expect(reply.status(), await reply.text()).toBe(202)
    expect((await reply.json()).state).toBe("in-review")
    a = await until(request, first.id, (x) => x.pendingAction === null, 3 * 60_000)
    expect(a.error).toBeNull()
    a = await until(request, first.id, (x) => x.state === "in-review", 60_000)
    expect(a.state).toBe("in-review")
    expect(a.workerId).toBe(workerId)
    const types = (await events(request, first.id)).events.map((e) => e.type)
    expect(types).toContain("session.reopened")
    expect(types.lastIndexOf("session.started")).toBeGreaterThan(types.indexOf("session.reopened"))
    const labels = (await (await request.get(`/api/tasks/${first.id}/commands`)).json()).map((c: { label: string }) => c.label)
    expect(labels).toContain("Follow-up")
    // The other conversation was left alone.
    b = await task(request, second.id)
    expect(b.state).toBe("in-review")
    expect(b.workerId).toBe(workerId)

    // Both dropped, then the machine deleted: nothing left to pick up, and the reply says why.
    for (const id of [first.id, second.id]) {
      expect((await request.post(`/api/tasks/${id}/cancel`)).status()).toBe(202)
      await until(request, id, (x) => x.state === "failed", 60_000)
    }
    expect((await request.delete(`/api/workers/${workerId}`)).status()).toBeLessThan(300)
    await expect.poll(async () => (await task(request, first.id)).canReopen, { timeout: 60_000 }).toBe(false)
    expect((await task(request, first.id)).reopenBlocker).toContain("no longer exists")
    const refused = await request.post(`/api/tasks/${first.id}/messages`, { data: { prompt: "Again" } })
    expect(refused.status()).toBe(409)
  })

  test("a task delegates a sub-task through spunto-tasks, is told when it hands back, and accepts it", async ({ request }) => {
    test.setTimeout(15 * 60_000)
    // The parent's agent calls `create_subtask` on Lite's own MCP server (the fake does on "delegate").
    const parent = await (await request.post(`/api/projects/${projectId}/tasks`, { data: { title: "Orchestrator", prompt: "Please delegate" } })).json()
    let p = await until(request, parent.id, (x) => x.state === "in-review" || x.state === "failed", 10 * 60_000)
    expect(p.state, p.error ?? "").toBe("in-review")
    if (p.workerId) workers.add(p.workerId)
    const said = (await events(request, parent.id)).events.filter((e) => e.type === "message" && e.payload.role === "assistant")
    const delegated = /Delegated sub-task (\S+)\./.exec(String(said.at(-1)?.payload.text))
    expect(delegated, String(said.at(-1)?.payload.text)).toBeTruthy()
    const childId = delegated![1]!

    // The family, both ways.
    expect(p.subtaskCount).toBe(1)
    const family = (await (await request.get(`/api/tasks?parentTaskId=${parent.id}`)).json()) as { tasks: Task[] }
    expect(family.tasks.map((t) => t.id)).toEqual([childId])
    let child = await task(request, childId)
    expect(child.parentTaskId).toBe(parent.id)
    expect(child.parent).toMatchObject({ id: parent.id, title: "Orchestrator" })

    // The child works and hands back; the parent is told — a turn of the platform's, not a human's
    // — reads its report and accepts it, from its own session.
    child = await until(request, childId, (x) => x.state === "done" || x.state === "failed", 10 * 60_000)
    expect(child.state, child.error ?? "").toBe("done")
    if (child.workerId) workers.add(child.workerId)
    const log = (await events(request, parent.id)).events
    const signal = log.find((e) => e.type === "message" && e.payload.auto === "subtask-signal")
    expect(signal?.payload.subtask).toMatchObject({ id: childId, state: "in-review" })
    expect(String(signal?.payload.text)).toContain(`[Spunto] Sub-task ${childId}`)
    p = await until(request, parent.id, (x) => x.state === "in-review", 3 * 60_000)
    const last = (await events(request, parent.id)).events.filter((e) => e.type === "message" && e.payload.role === "assistant").at(-1)
    expect(String(last?.payload.text)).toBe(`Accepted sub-task ${childId}: Committed \`TASK-${childId}-1.md\` on fake/${childId}.`)
    // Told once: a later read of the same hand-back sends nothing more.
    expect(log.filter((e) => e.type === "message" && e.payload.auto === "subtask-signal")).toHaveLength(1)

    for (const id of [parent.id]) {
      expect((await request.post(`/api/tasks/${id}/cancel`)).status()).toBe(202)
      await until(request, id, (x) => x.state === "failed", 60_000)
    }
  })
})
