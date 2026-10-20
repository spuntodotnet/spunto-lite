import { docker } from "./docker"
import { agentExec, agentWorkerOf } from "./agent"
import { shellQuote as shq } from "./shell"
import {
  DEFAULT_POLL_OUTPUT_BYTES,
  MAX_READ_BYTES,
  cancelScript,
  commandExitCode,
  commandFields,
  commandRunning,
  pollScript,
  readScript,
  startScript,
  stdinScript,
} from "@spunto/build/commands"

/**
 * Command execution inside a worker, for delegated work (docs/tasks.md), in two flavours:
 *
 *  - **foreground** (`runCommand`) — wait for it, get stdout/stderr/exit code back. Branch setup,
 *    the reset, accept and drop, a `git diff`.
 *  - **background** (`startCommand` + `pollCommand` + `readCommandOutput` + `cancelCommand`) —
 *    detached inside the container, its output redirected to files, polled afterwards. The agent
 *    session: anything that outlives an HTTP request.
 *
 * The scripts are `@spunto/build/commands` — the ones Spunto Cloud runs in its workers and its
 * sandboxes — so a worker reads the same whichever control plane launched the command. The state
 * of a background command lives **in the worker**, not in this process: Spunto Lite can restart
 * mid-session and the next poll picks the output back up from the files
 * (`~/.spunto/commands/<id>/`, layout in the package).
 *
 * What is ours is the transport: the worker's agent when it carries one (lib/agent.ts), a
 * `docker exec` otherwise.
 */

const DEFAULT_MAX_OUTPUT_BYTES = DEFAULT_POLL_OUTPUT_BYTES

export { MAX_READ_BYTES }

/**
 * What every exec gets: the image's user and home, and a UTF-8 locale. Secrets are not here on
 * purpose — they are on the container's own `Env` (set at spawn), which `docker exec` inherits.
 */
const EXEC_ENV = ["HOME=/home/vscode", "USER=vscode", "LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8"]

export type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}

export type CommandStatus = {
  running: boolean
  exitCode: number | null
  /** false when the id is unknown to this worker (never started, or pruned/rebuilt). */
  found: boolean
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}

/**
 * Run a script in the container and return its two streams, demuxed, plus the real exit status.
 * Unlike `lib/docker.ts`'s `execCapture` (stdout+stderr merged, best-effort, on a timer), this
 * waits for the process and keeps the streams apart.
 */
async function execScript(
  containerId: string,
  script: string,
  opts: { env?: string[]; timeoutMs?: number } = {},
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  // Through the worker's agent, which already runs as vscode with the container's environment.
  // Its own deadline sits above the one the script enforces with `timeout`.
  const viaAgent = agentWorkerOf(containerId)
  if (viaAgent) {
    const env = Object.fromEntries((opts.env ?? []).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]))
    const r = await agentExec(viaAgent, script, { env, timeoutMs: (opts.timeoutMs ?? 120_000) + 15_000 })
    if (r.error && r.exitCode === null) throw new Error(r.error)
    return { exitCode: r.exitCode, stdout: Buffer.from(r.stdout, "utf8"), stderr: Buffer.from(r.stderr, "utf8") }
  }
  const exec = await docker.getContainer(containerId).exec({
    Cmd: ["bash", "-c", script],
    User: "vscode",
    WorkingDir: "/home/vscode",
    AttachStdout: true,
    AttachStderr: true,
    Env: [...EXEC_ENV, ...(opts.env ?? [])],
  })
  const stream: NodeJS.ReadableStream = await new Promise((resolve, reject) =>
    exec.start({ hijack: true, stdin: false }, (err, s) => (err || !s ? reject(err) : resolve(s))),
  )
  const raw: Buffer = await new Promise((resolve) => {
    const chunks: Buffer[] = []
    const done = () => resolve(Buffer.concat(chunks))
    stream.on("data", (c: Buffer) => chunks.push(c))
    stream.on("end", done)
    stream.on("error", done)
  })

  // Docker multiplexes both streams with an 8-byte header per frame (byte 0 = 1 stdout, 2 stderr).
  const out: Buffer[] = []
  const err: Buffer[] = []
  let offset = 0
  while (offset + 8 <= raw.length) {
    const type = raw[offset]
    const size = raw.readUInt32BE(offset + 4)
    offset += 8
    if (offset + size > raw.length) break
    ;(type === 2 ? err : out).push(raw.subarray(offset, offset + size))
    offset += size
  }
  if (out.length === 0 && err.length === 0 && raw.length > 0) out.push(raw)

  const info = await exec.inspect()
  return { exitCode: info.ExitCode ?? null, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }
}

function tail(buf: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (buf.length <= maxBytes) return { text: buf.toString("utf8"), truncated: false }
  return { text: buf.subarray(buf.length - maxBytes).toString("utf8"), truncated: true }
}

function envList(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`)
}

export type RunCommandParams = {
  containerId: string
  command: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
}

/**
 * Foreground: run and wait. The deadline is enforced *inside* the container by `timeout` rather
 * than by abandoning the stream here, which would leave the command running with nobody reading.
 */
export async function runCommand(params: RunCommandParams): Promise<CommandResult> {
  const timeoutSec = Math.max(1, Math.ceil((params.timeoutMs ?? 60_000) / 1000))
  const maxOutputBytes = params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const cwd = params.cwd?.trim() || "/workspace"
  const script = [
    `cd ${shq(cwd)} 2>/dev/null || cd "$HOME" || exit 1`,
    `exec timeout -k 5 ${timeoutSec}s bash -lc ${shq(params.command)}`,
  ].join("\n")
  const { exitCode, stdout, stderr } = await execScript(params.containerId, script, { env: envList(params.env), timeoutMs: timeoutSec * 1000 })
  const out = tail(stdout, maxOutputBytes)
  const err = tail(stderr, maxOutputBytes)
  return {
    exitCode,
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
    timedOut: exitCode === 124,
  }
}

export type StartCommandParams = RunCommandParams & {
  commandId: string
  /** A writable stdin — a FIFO the caller appends to with `writeCommandStdin`. Interactive harness only. */
  stdin?: boolean
}

/**
 * Background: write the command and its wrapper into the worker, detach it, return once launched.
 * `setsid` gives the wrapper its own process group so cancelling takes the whole tree down.
 *
 * `exec 9<>fifo` is the load-bearing line of interactive mode: opening a FIFO *for writing* blocks
 * until a reader shows up (so `9>` would deadlock the wrapper), and holding it open for the
 * wrapper's whole life is what stops the harness from seeing EOF between two turns.
 */
export async function startCommand(params: StartCommandParams): Promise<{ pid: number | null }> {
  const script = startScript({
    commandId: params.commandId,
    command: params.command,
    cwd: params.cwd?.trim() || "/workspace",
    env: params.env,
    timeoutMs: params.timeoutMs ?? 6 * 60 * 60 * 1000,
    stdin: params.stdin,
  })
  const { exitCode, stdout, stderr } = await execScript(params.containerId, script)
  if (exitCode !== 0) {
    throw new Error(`Failed to start command in worker: ${stderr.toString("utf8").trim() || `exit ${exitCode}`}`)
  }
  const pid = parseInt(stdout.toString("utf8").trim(), 10)
  return { pid: Number.isFinite(pid) ? pid : null }
}

const parseFields = (stdout: Buffer) => commandFields(stdout.toString("utf8"))

/**
 * The state of a background command. `exit_code` is written last by the wrapper, so its presence
 * is the completion signal — the pid alone would report "done" the instant its shell exec'd.
 */
export async function pollCommand(params: {
  containerId: string
  commandId: string
  maxOutputBytes?: number
}): Promise<CommandStatus> {
  const maxOutputBytes = params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const script = pollScript(params.commandId, maxOutputBytes)
  const fields = parseFields((await execScript(params.containerId, script)).stdout)
  if (fields.get("FOUND") !== "1") {
    return { running: false, exitCode: null, found: false, stdout: "", stderr: "", truncated: false, timedOut: false }
  }
  const exitCode = commandExitCode(fields)
  const decode = (key: string) => Buffer.from(fields.get(key) ?? "", "base64").toString("utf8")
  const sizeOut = parseInt(fields.get("SIZEOUT") ?? "0", 10) || 0
  const sizeErr = parseInt(fields.get("SIZEERR") ?? "0", 10) || 0
  return {
    running: commandRunning(fields),
    exitCode,
    found: true,
    stdout: decode("OUT"),
    stderr: decode("ERR"),
    truncated: sizeOut > maxOutputBytes || sizeErr > maxOutputBytes,
    timedOut: exitCode === 124,
  }
}

/**
 * Append to a command's stdin FIFO — one turn of a conversation, or a control message. Never
 * blocks: the wrapper holds the FIFO open. Whole lines, one write: under PIPE_BUF it is atomic.
 */
export async function writeCommandStdin(params: { containerId: string; commandId: string; data: string }): Promise<boolean> {
  const script = stdinScript(params.commandId, Buffer.from(params.data, "utf8").toString("base64"))
  const { stdout } = await execScript(params.containerId, script)
  return stdout.toString("utf8").includes("WRITTEN:1")
}

/**
 * A **byte range** of a background command's stdout, from `offset` onwards — how a streamed
 * session is ingested exactly once, with a cursor kept in the database.
 */
export async function readCommandOutput(params: {
  containerId: string
  commandId: string
  offset?: number
  maxBytes?: number
}): Promise<{ found: boolean; size: number; data: Buffer; running: boolean; exitCode: number | null }> {
  const offset = Math.max(0, Math.floor(params.offset ?? 0))
  const maxBytes = Math.min(MAX_READ_BYTES, Math.max(1, params.maxBytes ?? MAX_READ_BYTES))
  const script = readScript(params.commandId, offset, maxBytes)
  const fields = parseFields((await execScript(params.containerId, script)).stdout)
  if (fields.get("FOUND") !== "1") return { found: false, size: 0, data: Buffer.alloc(0), running: false, exitCode: null }
  return {
    found: true,
    size: parseInt(fields.get("SIZE") ?? "0", 10) || 0,
    data: Buffer.from(fields.get("DATA") ?? "", "base64"),
    running: commandRunning(fields),
    exitCode: commandExitCode(fields),
  }
}

/** TERM to the whole process group, then a KILL sweep for anything that ignored it. */
export async function cancelCommand(params: { containerId: string; commandId: string }): Promise<boolean> {
  const script = cancelScript(params.commandId)
  const { stdout } = await execScript(params.containerId, script)
  return stdout.toString("utf8").includes("SIGNALLED:1")
}
