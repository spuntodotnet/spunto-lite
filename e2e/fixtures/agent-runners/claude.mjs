// A stand-in for `@spunto/agent-runners`' Claude runner (`claude.mjs`), with no SDK and no
// API key: it speaks the runner contract on stdin — {"type":"user","text"} · {"type":"interrupt","id"}
// · {"type":"title","id","description"} · {"type":"answer","callId","answers"} — and answers in the Spunto agent contract (`agent-v1`) on
// stdout, like the real runner since `@spunto/build` 0.23: our vocabulary, one event per line, each
// with the harness message it stands for as `source`. Under SPUNTO_AGENT_STREAM=1 it also prints its
// replies piecemeal first (`message.delta`), the way the real runner forwards partial messages. It
// stays alive between turns, honours an interrupt, commits and pushes for real — on a branch of its
// own, cut the first time it finds itself on the base, since Lite no longer cuts one (RFC 0056) —
// and names the
// conversation when asked. Told "question" (under SPUNTO_AGENT_QUESTIONS=1), it asks one, the way
// Claude's `AskUserQuestion` does, and waits: an `answer` closes it `answered`, a message
// `dismissed` — the message is the answer, in words. Told "delegate", it starts a sub-task through
// Lite's own `spunto-tasks` server; told by Spunto that a sub-task handed back (« [Spunto] Sub-task
// … in-review »), it reads its report and accepts it. Told "mcp", it lists the tools of every MCP server it was given
// (SPUNTO_AGENT_MCP), through Lite's gateway, the way the real runner's SDK would reach them.
//
// Lite bundles and runs it instead of the real runner when started with
// AGENT_RUNNERS_DIR=e2e/fixtures/agent-runners.
import { execSync } from "node:child_process"
import fs from "node:fs"
import readline from "node:readline"

const resumed = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : null
const sessionId = resumed || "fake-" + Math.random().toString(36).slice(2, 10)
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "claude-sonnet-5-5"
const stream = process.env.SPUNTO_AGENT_STREAM === "1"
let turn = 0
let started = false
let slow = null
/** The question the turn waits on: `{ callId, questions }`, or null. */
let asked = null

/** One finished assistant message — its tokens first when streaming, then the message itself. */
function say(text) {
  if (stream) {
    const words = text.split(/(?<= )/)
    words.forEach((w, i) => out({ type: "message.delta", text: w, ...(i === 0 ? { start: true } : {}) }))
  }
  out({ type: "message", role: "assistant", text, source: { type: "assistant", session_id: sessionId, text } })
  out({ type: "usage", scope: "call", model, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3000, cacheCreationTokens: 0, contextTokens: 4200 })
}

function handle(text) {
  if (!started) {
    started = true
    const init = { type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: ["Bash"], options: process.env.SPUNTO_AGENT_OPTIONS ?? null }
    out({ type: "session.started", harness: "claude-code", model, sessionId, cwd: process.cwd(), tools: ["Bash"], source: init })
  }
  turn++
  const signal = /^\[Spunto\] Sub-task (\S+) .* is now in-review/.exec(text)
  if (signal) {
    const id = signal[1]
    tasksTool("get_subtask", { taskId: id })
      .then((sub) => tasksTool("validate_subtask", { taskId: id }).then(() => finish(`Accepted sub-task ${id}: ${sub.lastMessages?.[0] ?? "(no report)"}`)))
      .catch((e) => finish(`Could not accept sub-task ${id}: ${e.message}`))
    return
  }
  if (/\bdelegate\b/i.test(text)) {
    tasksTool("create_subtask", { prompt: "Write a child note", title: "Child of " + process.env.SPUNTO_TASK_ID })
      .then((sub) => finish(`Delegated sub-task ${sub.id}.`))
      .catch((e) => finish(`Could not delegate: ${e.message}`))
    return
  }
  if (/\bmcp\b/i.test(text)) {
    listMcpTools().then((lines) => finish(lines.join("\n") || "No MCP server given."))
    return
  }
  if (/\bquestion\b/i.test(text) && process.env.SPUNTO_AGENT_QUESTIONS === "1") {
    const questions = [
      { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cold" }] },
    ]
    asked = { callId: `q${turn}`, questions }
    out({ type: "question", callId: asked.callId, status: "pending", questions })
    return
  }
  if (/slow/.test(text)) {
    say("Starting something long…")
    slow = setTimeout(() => finish("Done with the long thing."), 60_000)
    return
  }
  const file = `TASK-${process.env.SPUNTO_TASK_ID}-${turn}.md`
  fs.writeFileSync(file, `# turn ${turn}\n\n${text.split("\n---")[0]}\n`)
  // What a real agent does when the work is worth keeping: a branch it names, left as it is on the
  // turns that follow (a task recycled from another keeps whatever it is on, unless that is the base).
  const branch = `fake/${process.env.SPUNTO_TASK_ID}`
  const cmd = `(test "$(git branch --show-current)" != main || git checkout -q -b ${branch}) && git add -A && git commit -qm "turn ${turn}" && git push -q -u origin HEAD && echo pushed`
  say(`On it — turn **${turn}**.`)
  out({ type: "tool.call", callId: `t${turn}`, name: "Bash", input: JSON.stringify({ command: cmd }) })
  let result = ""
  let isError = false
  try { result = execSync(cmd, { encoding: "utf8" }) } catch (e) { result = String(e.stderr || e.message); isError = true }
  out({ type: "tool.result", callId: `t${turn}`, isError, output: result })
  finish(`Committed \`${file}\` on ${execSync("git branch --show-current", { encoding: "utf8" }).trim()}.`)
}

/** Call a tool of Lite's `spunto-tasks` server, the way the SDK would — and read its JSON answer. */
async function tasksTool(name, args) {
  const server = JSON.parse(process.env.SPUNTO_AGENT_MCP || "[]").find((s) => s.name === "spunto-tasks")
  if (!server) throw new Error("no spunto-tasks server given")
  const api = (process.env.SPUNTO_API_URL || "").replace(/\/$/, "")
  const res = await fetch(api + server.path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.SPUNTO_WORKER_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })
  const json = await res.json()
  const text = json.result?.content?.[0]?.text ?? JSON.stringify(json.error)
  if (json.result?.isError || !json.result) throw new Error(text)
  return JSON.parse(text)
}

async function listMcpTools() {
  const servers = JSON.parse(process.env.SPUNTO_AGENT_MCP || "[]")
  const api = (process.env.SPUNTO_API_URL || "").replace(/\/$/, "")
  const lines = []
  for (const { name, path } of servers) {
    try {
      const res = await fetch(api + path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.SPUNTO_WORKER_TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
      const body = await res.text()
      const json = JSON.parse(body.startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "{}")
      lines.push(`${name}: ${json.result ? json.result.tools.map((t) => t.name).join(", ") : JSON.stringify(json.error)}`)
    } catch (e) {
      lines.push(`${name}: ${e.message}`)
    }
  }
  return lines
}

function finish(text) {
  say(text)
  out({ type: "usage", scope: "session", model, costUsd: 0.0123 * turn, turns: turn, durationMs: 1500 * turn })
  out({ type: "session.ended", status: "succeeded", stopReason: null, summary: text })
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === "interrupt") {
    if (slow) clearTimeout(slow)
    slow = null
    out({ type: "session.ended", status: "failed", stopReason: "interrupted", summary: "Interrupted." })
    return
  }
  // What the real runner answers after `generateSessionTitle()`: the contract's own line.
  if (msg.type === "title") {
    out({ type: "session.title", title: "Fake session names itself" })
    return
  }
  if (msg.type === "answer" && asked && msg.callId === asked.callId) {
    const { callId, questions } = asked
    asked = null
    out({ type: "question", callId, status: "answered", questions, answers: msg.answers })
    finish(`You picked ${msg.answers.map((a) => a.selected.join(", ") || a.text).join("; ")}.`)
    return
  }
  if (msg.type === "user" && asked) {
    const { callId, questions } = asked
    asked = null
    out({ type: "question", callId, status: "dismissed", questions })
    finish(`Taken as the answer: ${msg.text}`)
    return
  }
  if (msg.type === "user") handle(msg.text)
})
