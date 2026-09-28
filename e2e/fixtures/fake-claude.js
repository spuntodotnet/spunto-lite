// A stand-in for `claude --input-format stream-json --output-format stream-json --verbose`:
// reads turns on stdin, answers in Claude Code's own stream-json shapes, stays alive between
// turns, honours an interrupt, and names the conversation in its transcript like the real one.
const { execSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")

const sessionId = "fake-" + Math.random().toString(36).slice(2, 10)
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 }
let turn = 0
let started = false
let slow = null

function transcript(title) {
  const dir = path.join(process.env.HOME, ".claude", "projects", "-workspace")
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: "ai-title", aiTitle: title }) + "\n")
}

function handle(text) {
  if (!started) {
    started = true
    out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5", cwd: process.cwd(), tools: ["Bash"] })
  }
  turn++
  if (/slow/.test(text)) {
    out({ type: "assistant", session_id: sessionId, message: { id: `m${turn}`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Starting something long…" }], usage } })
    slow = setTimeout(() => finish("Done with the long thing."), 60_000)
    return
  }
  const file = `TASK-${process.env.SPUNTO_TASK_ID}-${turn}.md`
  fs.writeFileSync(file, `# turn ${turn}\n\n${text.split("\n---")[0]}\n`)
  const cmd = `git add -A && git commit -qm "turn ${turn}" && git push -q origin HEAD && echo pushed`
  out({ type: "assistant", session_id: sessionId, message: { id: `m${turn}a`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: `On it — turn **${turn}**.` }, { type: "tool_use", id: `t${turn}`, name: "Bash", input: { command: cmd } }], usage } })
  let result = ""
  let isError = false
  try { result = execSync(cmd, { encoding: "utf8" }) } catch (e) { result = String(e.stderr || e.message); isError = true }
  out({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${turn}`, content: result, is_error: isError }] } })
  if (turn === 1) transcript("Fake session names itself")
  finish(`Committed \`${file}\` on ${process.env.SPUNTO_TASK_BRANCH}.`)
}

function finish(text) {
  out({ type: "assistant", session_id: sessionId, message: { id: `m${turn}b`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text }], usage } })
  out({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.0123 * turn, num_turns: turn, duration_ms: 1500 * turn, usage })
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    if (slow) clearTimeout(slow)
    slow = null
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } })
    out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, num_turns: turn, duration_ms: 10 })
    return
  }
  if (msg.type === "user") handle(msg.message.content.map((c) => c.text || "").join(""))
})
