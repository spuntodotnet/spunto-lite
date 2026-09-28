import { docker } from "./docker"
import { shellQuote as shq } from "./shell"

/**
 * Command execution inside a worker, for delegated work (docs/tasks.md), in two flavours:
 *
 *  - **foreground** (`runCommand`) — wait for it, get stdout/stderr/exit code back. Branch setup,
 *    the reset, accept and drop, a `git diff`.
 *  - **background** (`startCommand` + `pollCommand` + `readCommandOutput` + `cancelCommand`) —
 *    detached inside the container, its output redirected to files, polled afterwards. The agent
 *    session: anything that outlives an HTTP request.
 *
 * Ported from Spunto Cloud's node agent (`apps/agent/src/worker-commands.ts`) with the same file
 * layout, so a worker reads the same whichever control plane launched the command. The state of
 * a background command lives **in the worker**, not in this process: Spunto Lite can restart
 * mid-session and the next poll picks the output back up from the files.
 *
 *   ~/.spunto/commands/<id>/cmd.sh      the command, verbatim
 *   ~/.spunto/commands/<id>/run.sh      the wrapper (cd + timeout + exit code)
 *   ~/.spunto/commands/<id>/stdin       a FIFO, for an interactive harness only
 *   ~/.spunto/commands/<id>/stdout.log  stdout of the wrapper
 *   ~/.spunto/commands/<id>/stderr.log  stderr of the wrapper
 *   ~/.spunto/commands/<id>/pid         pid of the wrapper, for cancellation
 *   ~/.spunto/commands/<id>/exit_code   written last — its presence means "done"
 */

const COMMANDS_DIR = "$HOME/.spunto/commands"

/** How long finished command directories are kept in the worker before pruning. */
const RETENTION_DAYS = 7

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** Ceiling on one `readCommandOutput` round-trip — base64 inflates it by a third. */
export const MAX_READ_BYTES = 256 * 1024

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

/** Command ids come from us, but they end up in a shell-built path — validated, not trusted. */
function assertSafeId(commandId: string): void {
  if (!/^[a-z0-9]{6,40}$/.test(commandId)) throw new Error(`Invalid command id: ${commandId}`)
}

/**
 * Run a script in the container and return its two streams, demuxed, plus the real exit status.
 * Unlike `lib/docker.ts`'s `execCapture` (stdout+stderr merged, best-effort, on a timer), this
 * waits for the process and keeps the streams apart.
 */
async function execScript(
  containerId: string,
  script: string,
  opts: { env?: string[]; stdin?: Buffer } = {},
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
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
  const { exitCode, stdout, stderr } = await execScript(params.containerId, script, { env: envList(params.env) })
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
  assertSafeId(params.commandId)
  const timeoutSec = Math.max(1, Math.ceil((params.timeoutMs ?? 6 * 60 * 60 * 1000) / 1000))
  const cwd = params.cwd?.trim() || "/workspace"
  const dir = `${COMMANDS_DIR}/${params.commandId}`

  const exports = Object.entries(params.env ?? {})
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join("\n")

  const runner = [
    `#!/usr/bin/env bash`,
    exports,
    `cd ${shq(cwd)} 2>/dev/null || cd "$HOME"`,
    ...(params.stdin
      ? [
          `exec 9<>"$(dirname "$0")/stdin"`,
          `timeout -k 5 ${timeoutSec}s bash -l "$(dirname "$0")/cmd.sh" < "$(dirname "$0")/stdin"`,
        ]
      : [`timeout -k 5 ${timeoutSec}s bash -l "$(dirname "$0")/cmd.sh"`]),
    `echo $? > "$(dirname "$0")/exit_code"`,
  ].join("\n")

  const script = [
    `set -e`,
    `mkdir -p ${dir}`,
    ...(params.stdin ? [`[ -p ${dir}/stdin ] || mkfifo ${dir}/stdin`] : []),
    `find ${COMMANDS_DIR} -mindepth 1 -maxdepth 1 -type d -mtime +${RETENTION_DAYS} -exec rm -rf {} + 2>/dev/null || true`,
    `printf %s ${shq(Buffer.from(params.command, "utf8").toString("base64"))} | base64 -d > ${dir}/cmd.sh`,
    `printf %s ${shq(Buffer.from(runner, "utf8").toString("base64"))} | base64 -d > ${dir}/run.sh`,
    `: > ${dir}/stdout.log`,
    `: > ${dir}/stderr.log`,
    `if command -v setsid >/dev/null 2>&1; then`,
    `  setsid bash ${dir}/run.sh > ${dir}/stdout.log 2> ${dir}/stderr.log < /dev/null &`,
    `else`,
    `  nohup bash ${dir}/run.sh > ${dir}/stdout.log 2> ${dir}/stderr.log < /dev/null &`,
    `fi`,
    `echo $! > ${dir}/pid`,
    `cat ${dir}/pid`,
  ].join("\n")

  const { exitCode, stdout, stderr } = await execScript(params.containerId, script)
  if (exitCode !== 0) {
    throw new Error(`Failed to start command in worker: ${stderr.toString("utf8").trim() || `exit ${exitCode}`}`)
  }
  const pid = parseInt(stdout.toString("utf8").trim(), 10)
  return { pid: Number.isFinite(pid) ? pid : null }
}

function parseFields(stdout: Buffer): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of stdout.toString("utf8").split("\n")) {
    const idx = line.indexOf(":")
    if (idx > 0) fields.set(line.slice(0, idx), line.slice(idx + 1).trim())
  }
  return fields
}

/**
 * The state of a background command. `exit_code` is written last by the wrapper, so its presence
 * is the completion signal — the pid alone would report "done" the instant its shell exec'd.
 */
export async function pollCommand(params: {
  containerId: string
  commandId: string
  maxOutputBytes?: number
}): Promise<CommandStatus> {
  assertSafeId(params.commandId)
  const maxOutputBytes = params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const dir = `${COMMANDS_DIR}/${params.commandId}`
  const script = [
    `if [ ! -d ${dir} ]; then echo "FOUND:0"; exit 0; fi`,
    `echo "FOUND:1"`,
    `if [ -f ${dir}/exit_code ]; then echo "EXIT:$(cat ${dir}/exit_code)"; else echo "EXIT:-"; fi`,
    `pid=$(cat ${dir}/pid 2>/dev/null || echo "")`,
    `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "ALIVE:1"; else echo "ALIVE:0"; fi`,
    `echo "SIZEOUT:$(wc -c < ${dir}/stdout.log 2>/dev/null || echo 0)"`,
    `echo "SIZEERR:$(wc -c < ${dir}/stderr.log 2>/dev/null || echo 0)"`,
    `echo "OUT:$(tail -c ${maxOutputBytes} ${dir}/stdout.log 2>/dev/null | base64 | tr -d '\\n')"`,
    `echo "ERR:$(tail -c ${maxOutputBytes} ${dir}/stderr.log 2>/dev/null | base64 | tr -d '\\n')"`,
  ].join("\n")

  const fields = parseFields((await execScript(params.containerId, script)).stdout)
  if (fields.get("FOUND") !== "1") {
    return { running: false, exitCode: null, found: false, stdout: "", stderr: "", truncated: false, timedOut: false }
  }
  const rawExit = fields.get("EXIT")
  const exitCode = rawExit && rawExit !== "-" ? parseInt(rawExit, 10) : null
  const decode = (key: string) => Buffer.from(fields.get(key) ?? "", "base64").toString("utf8")
  const sizeOut = parseInt(fields.get("SIZEOUT") ?? "0", 10) || 0
  const sizeErr = parseInt(fields.get("SIZEERR") ?? "0", 10) || 0
  return {
    running: exitCode === null && fields.get("ALIVE") === "1",
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
  assertSafeId(params.commandId)
  const dir = `${COMMANDS_DIR}/${params.commandId}`
  const script = [
    `if [ ! -p ${dir}/stdin ]; then echo "WRITTEN:0"; exit 0; fi`,
    `printf %s ${shq(Buffer.from(params.data, "utf8").toString("base64"))} | base64 -d > ${dir}/stdin`,
    `echo "WRITTEN:1"`,
  ].join("\n")
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
  assertSafeId(params.commandId)
  const offset = Math.max(0, Math.floor(params.offset ?? 0))
  const maxBytes = Math.min(MAX_READ_BYTES, Math.max(1, params.maxBytes ?? MAX_READ_BYTES))
  const dir = `${COMMANDS_DIR}/${params.commandId}`
  const script = [
    `if [ ! -d ${dir} ]; then echo "FOUND:0"; exit 0; fi`,
    `echo "FOUND:1"`,
    `echo "SIZE:$(wc -c < ${dir}/stdout.log 2>/dev/null || echo 0)"`,
    `if [ -f ${dir}/exit_code ]; then echo "EXIT:$(cat ${dir}/exit_code)"; else echo "EXIT:-"; fi`,
    `pid=$(cat ${dir}/pid 2>/dev/null || echo "")`,
    `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "ALIVE:1"; else echo "ALIVE:0"; fi`,
    // `tail -c +N` counts bytes from 1, so an offset of 0 is `+1`.
    `echo "DATA:$(tail -c +${offset + 1} ${dir}/stdout.log 2>/dev/null | head -c ${maxBytes} | base64 | tr -d '\\n')"`,
  ].join("\n")
  const fields = parseFields((await execScript(params.containerId, script)).stdout)
  if (fields.get("FOUND") !== "1") return { found: false, size: 0, data: Buffer.alloc(0), running: false, exitCode: null }
  const rawExit = fields.get("EXIT")
  const exitCode = rawExit && rawExit !== "-" ? parseInt(rawExit, 10) : null
  return {
    found: true,
    size: parseInt(fields.get("SIZE") ?? "0", 10) || 0,
    data: Buffer.from(fields.get("DATA") ?? "", "base64"),
    running: exitCode === null && fields.get("ALIVE") === "1",
    exitCode,
  }
}

/** TERM to the whole process group, then a KILL sweep for anything that ignored it. */
export async function cancelCommand(params: { containerId: string; commandId: string }): Promise<boolean> {
  assertSafeId(params.commandId)
  const dir = `${COMMANDS_DIR}/${params.commandId}`
  const script = [
    `pid=$(cat ${dir}/pid 2>/dev/null || echo "")`,
    `[ -z "$pid" ] && { echo "SIGNALLED:0"; exit 0; }`,
    `pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')`,
    `if [ -n "$pgid" ]; then kill -TERM -"$pgid" 2>/dev/null || true; fi`,
    `kill -TERM "$pid" 2>/dev/null || true`,
    `sleep 2`,
    `if [ -n "$pgid" ]; then kill -KILL -"$pgid" 2>/dev/null || true; fi`,
    `kill -KILL "$pid" 2>/dev/null || true`,
    // The wrapper is gone, so nothing will write exit_code — record the cancellation ourselves.
    `[ -f ${dir}/exit_code ] || echo 143 > ${dir}/exit_code`,
    `echo "SIGNALLED:1"`,
  ].join("\n")
  const { stdout } = await execScript(params.containerId, script)
  return stdout.toString("utf8").includes("SIGNALLED:1")
}
