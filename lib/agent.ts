import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { AgentConnection } from "@spunto/build/agent-connection"
import { AGENT_CLOSE, AGENT_HELLO_TIMEOUT_MS, type AgentMessage, type ExecResult, type ProjectPlan, type ProjectState } from "@spunto/build/agent-protocol"
import { SANDBOX_AGENT_CONTENT_TYPES, SANDBOX_AGENT_FILES, type SandboxAgentFile } from "@spunto/build/sandbox-agent"
import { and, eq } from "drizzle-orm"
import { db } from "../db/index"
import { workers } from "../db/schema"
import { LITE_INTERNAL_URL, PORT } from "./env"

/**
 * The in-box agent of a worker (`workers.data_plane = 'agent'`, RFC 0047 of coderhammer/spunto).
 *
 * The container's main process is `@spunto/build`'s `bootstrap.sh`, which runs the agent; the agent
 * dials `/api/agent/connect`, says hello with the worker's own token, and from then on carries what
 * happens inside the box: commands, terminals, listening ports, the project's setup state. It is the
 * agent a Spunto Cloud sandbox runs, served from the same package — so a fix to the terminal, to the
 * features' environment or to the setup phases lands here with a version bump, not a port.
 *
 * What stays a `docker` call is the box's lifecycle (create, start, stop, remove, build its image)
 * and code-server, which the reverse proxy still reaches on the container's own IP.
 */

/** Where the agent dials, and where the bootstrap fetches it from, under this process's URL. */
export const AGENT_CONNECT_PATH = "/api/agent/connect"
const ASSET_PATHS: Record<string, SandboxAgentFile> = { "/api/agent/agent.mjs": "agent", "/api/agent/bootstrap.sh": "bootstrap" }

/** Mounted read-only in every agent worker: the bootstrap, and a Node it needs not download. */
export const AGENT_VOLUME = "spunto-lite-agent"
export const AGENT_MOUNT = "/opt/spunto-agent"

// Kept on `globalThis`, like lib/terminal-attachments.ts: the WebSocket side runs under `tsx` from
// server.ts, the API routes are bundled by Next — same process, two module graphs.
const KEY = Symbol.for("spunto-lite.agents")
function connections(): Map<string, AgentConnection> {
  const g = globalThis as typeof globalThis & { [KEY]?: Map<string, AgentConnection> }
  return (g[KEY] ??= new Map())
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

/** A worker's agent token: given to its container once, kept here only as a hash. */
export function newAgentToken(): { token: string; hash: string } {
  const token = `lwa_${randomBytes(32).toString("base64url")}`
  return { token, hash: hashToken(token) }
}

/** How a worker's container reaches this process (see `LITE_INTERNAL_URL`). */
export function internalUrl(): string {
  if (LITE_INTERNAL_URL) return LITE_INTERNAL_URL
  return existsSync("/.dockerenv") ? `http://spunto-lite:${PORT}` : `http://host.docker.internal:${PORT}`
}

/**
 * What the agent volume holds, by content: a worker runs its bootstrap and its Node *from* the
 * volume, so a file there is never rewritten — overwriting a running executable fails, and `sh`
 * reads a script as it goes. A new bootstrap or a new Node lands next to the old ones.
 */
export function agentVolumeLayout(): { bootstrap: string; node: string | null } {
  const h = createHash("sha256").update(bootstrapScript()).digest("hex").slice(0, 12)
  // Our own Node, when it can run in a worker: a Linux binary of a glibc build (Lite's image is
  // bookworm). Elsewhere (Lite on a Mac host), the bootstrap downloads the official one.
  const node = process.platform === "linux" ? `node-${process.version}-${process.arch}` : null
  return { bootstrap: `bootstrap-${h}.sh`, node }
}

/** What the agent of a worker gets in its environment, on top of the worker's own. */
export function agentEnv(workerId: string, token: string, nodeDir: string | null): string[] {
  const url = internalUrl()
  return [
    `SPUNTO_API_URL=${url}`,
    `SPUNTO_SANDBOX_ID=${workerId}`,
    `SPUNTO_SANDBOX_TOKEN=${token}`,
    `SPUNTO_AGENT_URL=${url}/api/agent/agent.mjs`,
    `SPUNTO_AGENT_CONNECT_URL=${url.replace(/^http/, "ws")}${AGENT_CONNECT_PATH}`,
    ...(nodeDir ? [`SPUNTO_NODE=${AGENT_MOUNT}/${nodeDir}/bin/node`] : []),
  ]
}

/** The container's main process: the bootstrap from the agent volume, forever. */
export const agentCmd = (bootstrapFile: string) => ["sh", `${AGENT_MOUNT}/${bootstrapFile}`]

// ── The connection ───────────────────────────────────────────────────────────────────────────

export function agentFor(workerId: string): AgentConnection | null {
  const conn = connections().get(workerId)
  return conn?.online ? conn : null
}

export function isAgentOnline(workerId: string): boolean {
  return agentFor(workerId) !== null
}

/** Drops a worker's connection (the worker is being deleted or rebuilt). */
export function dropAgent(workerId: string): void {
  connections().get(workerId)?.drop()
  connections().delete(workerId)
}

/** Waits for a worker's agent, for a caller that just started its box. */
export async function waitForAgent(workerId: string, timeoutMs: number): Promise<AgentConnection> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const conn = agentFor(workerId)
    if (conn) return conn
    if (Date.now() > deadline) throw new Error("Worker agent is not connected")
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** The worker a container belongs to, when that worker carries the agent — else null (`docker exec`). */
export function agentWorkerOf(containerId: string): string | null {
  return (
    db
      .select({ id: workers.id })
      .from(workers)
      .where(and(eq(workers.containerId, containerId), eq(workers.dataPlane, "agent")))
      .get()?.id ?? null
  )
}

/** A script in the worker, as `vscode`, through its agent — the `docker exec` of an agent worker. */
export async function agentExec(
  workerId: string,
  script: string,
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const conn = agentFor(workerId)
  if (!conn) throw new Error("Worker agent is not connected")
  return conn.exec({ command: script, cwd: opts.cwd ?? "/home/vscode", env: opts.env, timeoutMs: opts.timeoutMs ?? 60_000 })
}

/**
 * What the project's runner printed — a worker's "container logs", since its container's own are
 * the agent's. A `logs` terminal of the agent (`tail -n 400 -F`), read for a moment and closed.
 */
export function readProjectLog(workerId: string, settleMs = 600): Promise<string> {
  const conn = agentFor(workerId)
  if (!conn) return Promise.resolve("")
  const termId = `logs-${randomBytes(6).toString("hex")}`
  let text = ""
  return new Promise((resolve) => {
    const done = () => {
      conn.closeTerminal(termId)
      resolve(text.replace(/\r\n/g, "\n"))
    }
    const timer = setTimeout(done, settleMs)
    conn.openTerminal(termId, { cols: 200, rows: 50, mode: "logs" }, {
      onData: (d) => (text += Buffer.from(d).toString("utf8")),
      onExit: () => {
        clearTimeout(timer)
        resolve(text.replace(/\r\n/g, "\n"))
      },
    })
  })
}

/** Hooks the worker service gives this module (it imports us, so not the other way round). */
export type AgentHooks = {
  /** The worker a hello's token belongs to, or null. */
  workerForToken(hash: string): { id: string } | null
  /** The project plan to hand a worker's agent, at every hello. */
  planFor(workerId: string): Promise<ProjectPlan | null>
  /** The project's state, as the agent reports it. */
  onProjectState(workerId: string, state: ProjectState): void
}
const HOOKS = Symbol.for("spunto-lite.agent-hooks")
export function setAgentHooks(hooks: AgentHooks): void {
  ;(globalThis as typeof globalThis & { [HOOKS]?: AgentHooks })[HOOKS] = hooks
}
function hooks(): AgentHooks | undefined {
  return (globalThis as typeof globalThis & { [HOOKS]?: AgentHooks })[HOOKS]
}

const wss = new WebSocketServer({ noServer: true })

/** `GET /api/agent/connect` — an agent dials in. Authenticated by its first message. */
export function handleAgentUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const helloTimer = setTimeout(() => ws.close(AGENT_CLOSE.tokenRefused, "hello expected"), AGENT_HELLO_TIMEOUT_MS)
    ws.once("message", (raw) => {
      clearTimeout(helloTimer)
      let msg: { type?: string; token?: string }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return ws.close(AGENT_CLOSE.badHello, "bad hello")
      }
      const h = hooks()
      const worker = msg.type === "hello" && msg.token && h ? h.workerForToken(hashToken(msg.token)) : null
      if (!worker || !h) return ws.close(AGENT_CLOSE.tokenRefused, "token refused")
      attach(worker.id, ws, h)
    })
  })
}

function attach(workerId: string, ws: WebSocket, h: AgentHooks): void {
  // One agent per worker: a restarted agent whose old socket has not timed out yet replaces it.
  const previous = connections().get(workerId)
  if (previous) previous.socket.close(AGENT_CLOSE.replaced, "replaced")
  const conn = new AgentConnection(ws, {
    label: "Worker",
    onMessage: (m: AgentMessage) => {
      if (m.type === "project_state") h.onProjectState(workerId, m.state)
    },
    liveness: {
      onSilent: () => console.warn(`[agent ${workerId}] silent for too long — connection dropped`),
    },
  })
  connections().set(workerId, conn)
  ws.on("message", (data, isBinary) => conn.receive(data as Buffer, isBinary))
  ws.on("pong", () => conn.heard())
  ws.on("close", () => {
    conn.closed()
    if (connections().get(workerId) === conn) connections().delete(workerId)
  })
  conn.send({ type: "welcome", sandboxId: workerId })
  // Re-sent at every hello: the current secrets, the current SSH key, the current settings.
  h.planFor(workerId)
    .then((plan) => plan && conn.send(plan))
    .catch((err) => console.error(`[agent ${workerId}] project plan failed:`, err))
}

/** `GET /api/agent/{agent.mjs,bootstrap.sh}` — read from the package at every request. */
export function handleAgentAsset(req: IncomingMessage, res: ServerResponse): boolean {
  const file = ASSET_PATHS[(req.url ?? "").split("?")[0]]
  if (!file || req.method !== "GET") return false
  res.writeHead(200, { "Content-Type": SANDBOX_AGENT_CONTENT_TYPES[file], "Cache-Control": "no-store" })
  res.end(readFileSync(SANDBOX_AGENT_FILES[file], "utf8"))
  return true
}

/** The runner script a plan carries — and a build bakes with. */
export const runnerScript = () => readFileSync(SANDBOX_AGENT_FILES.runner, "utf8")
export const bootstrapScript = () => readFileSync(SANDBOX_AGENT_FILES.bootstrap, "utf8")
