// A stand-in for `@spunto/build`'s Claude runner (`agent-runners/claude.mjs`), with no SDK and no
// API key: it speaks the runner contract on stdin — {"type":"user","text"} · {"type":"interrupt","id"}
// · {"type":"title","id","description"} — and answers in Claude Code's own stream-json shapes, like
// the SDK's messages the real runner forwards. It stays alive between turns, honours an interrupt,
// commits and pushes for real, and names the conversation when asked. Told "mcp", it lists the
// tools of every MCP server it was given (SPUNTO_AGENT_MCP), through Lite's gateway, the way the
// real runner's SDK would reach them.
//
// Lite runs it instead of the real runner when started with AGENT_RUNNERS_DIR=e2e/fixtures/agent-runners.
import { execSync } from "node:child_process"
import fs from "node:fs"
import readline from "node:readline"

const resumed = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : null
const sessionId = resumed || "fake-" + Math.random().toString(36).slice(2, 10)
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 }
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "claude-sonnet-5-5"
let turn = 0
let started = false
let slow = null

function handle(text) {
  if (!started) {
    started = true
    out({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: ["Bash"], options: process.env.SPUNTO_AGENT_OPTIONS ?? null })
  }
  turn++
  if (/\bmcp\b/i.test(text)) {
    listMcpTools().then((lines) => finish(lines.join("\n") || "No MCP server given."))
    return
  }
  if (/slow/.test(text)) {
    out({ type: "assistant", session_id: sessionId, message: { id: `m${turn}`, role: "assistant", model, content: [{ type: "text", text: "Starting something long…" }], usage } })
    slow = setTimeout(() => finish("Done with the long thing."), 60_000)
    return
  }
  const file = `TASK-${process.env.SPUNTO_TASK_ID}-${turn}.md`
  fs.writeFileSync(file, `# turn ${turn}\n\n${text.split("\n---")[0]}\n`)
  const cmd = `git add -A && git commit -qm "turn ${turn}" && git push -q origin HEAD && echo pushed`
  out({ type: "assistant", session_id: sessionId, message: { id: `m${turn}a`, role: "assistant", model, content: [{ type: "text", text: `On it — turn **${turn}**.` }, { type: "tool_use", id: `t${turn}`, name: "Bash", input: { command: cmd } }], usage } })
  let result = ""
  let isError = false
  try { result = execSync(cmd, { encoding: "utf8" }) } catch (e) { result = String(e.stderr || e.message); isError = true }
  out({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${turn}`, content: result, is_error: isError }] } })
  finish(`Committed \`${file}\` on ${process.env.SPUNTO_TASK_BRANCH}.`)
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
  out({ type: "assistant", session_id: sessionId, message: { id: `m${turn}b`, role: "assistant", model, content: [{ type: "text", text }], usage } })
  out({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.0123 * turn, num_turns: turn, duration_ms: 1500 * turn, usage })
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === "interrupt") {
    if (slow) clearTimeout(slow)
    slow = null
    out({ type: "control_response", response: { subtype: "success", request_id: msg.id } })
    out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, num_turns: turn, duration_ms: 10 })
    return
  }
  // What the real runner answers after `generateSessionTitle()`: the CLI's own control_response.
  if (msg.type === "title") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.id, response: { title: "Fake session names itself" } } })
    return
  }
  if (msg.type === "user") handle(msg.text)
})
