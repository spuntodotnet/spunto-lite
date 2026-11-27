import { WebSocket } from "ws"
import { PORT } from "../lib/env"
import { relayCapability, type LiteCapability } from "../lib/lite-relay"
import { localRequestUrl } from "../lib/lite-relay-url"
import { setLiteTunnel, type LiteTunnelStatus } from "../lib/lite-connect-hooks"
import { liteVersion } from "./telemetry"
import { sendMachineSummary, startLiveEvents } from "./lite-events"
import {
  capabilitiesOf,
  forgetLiteConnect,
  freshAccessToken,
  getLiteConnect,
  isConnected,
  LiteRefreshRefused,
  machineNameOf,
  recordWelcome,
} from "./lite-connect"

/**
 * The Lite Connect tunnel (docs/lite-connect.md): one WebSocket Lite opens to Spunto Cloud
 * (`wss://<spunto>/api/lite/connect`), over which Cloud relays the member's devices' requests.
 *
 *   → { type: "hello", token, name, version, capabilities }   ← { type: "welcome", connectionId }
 *   ← { type: "request", id, method, path, query, contentType?, body? }      body: utf-8 text
 *   → { type: "response", id, status, contentType, body }                    body: base64
 *   → { type: "event", event: "task.state", … }                              (services/tasks.ts)
 *   → { type: "event", event: "task.progress" | "machine.summary", … }      (services/lite-events.ts)
 *
 * Every request is checked again against the list (lib/lite-relay.ts) and the capabilities this
 * hello announced — Lite has the last word — then served by Lite's own listener on loopback,
 * the very routes the dashboard calls. Never anything else.
 *
 * Closes: 4401 (token refused) → one forced refresh, then the usual backoff; a refused refresh →
 * disconnected. 4403 (the member disconnected this Lite in Spunto) → tokens forgotten, no redial.
 * 4409 (a newer tunnel replaced this one) → the longest wait, so two Lites sharing a link don't
 * take turns every second. Anything else → 1 s, 2 s, 4 s… up to 30 s.
 *
 * Runs in server.ts's module graph; its controls are on `globalThis` (lib/lite-connect-hooks.ts)
 * for the routes, and its state too, so a dev reload of this module does not open a second tunnel.
 */

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
/** Cloud pings every 25 s: two missed pings and the socket is taken for dead. */
const SILENCE_MS = 60_000
/** Cloud answers 504 after 30 s: a local route that takes longer is cut a little before. */
const LOCAL_TIMEOUT_MS = 28_000
/** Cloud's message limit is 16 MB; base64 makes 4 bytes of 3. */
const MAX_RESPONSE_BYTES = 11 * 1024 * 1024

type State = {
  /** Bumped by every start/stop: a callback of an older attempt finds it changed and does nothing. */
  generation: number
  ws: WebSocket | null
  status: LiteTunnelStatus
  backoffMs: number
  retryTimer: NodeJS.Timeout | null
  silenceTimer: NodeJS.Timeout | null
  /** Where relayed requests are served: Lite's own listener. */
  localBase: string
  /** Disconnect is revoking the token: the 4403 that follows is expected (`revoking`). */
  revoking: boolean
}

const KEY = Symbol.for("spunto-lite.lite-tunnel-state")
function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State }
  return (g[KEY] ??= {
    generation: 0,
    ws: null,
    status: { state: "off", error: null, nextRetryAt: null },
    backoffMs: MIN_BACKOFF_MS,
    retryTimer: null,
    silenceTimer: null,
    localBase: `http://127.0.0.1:${PORT}`,
    revoking: false,
  })
}

export const tunnelUrlOf = (spuntoUrl: string) => `${spuntoUrl.replace(/^http/, "ws")}/api/lite/connect`

const log = (msg: string) => console.log(`[lite-connect] ${msg}`)

function setStatus(s: State, status: Partial<LiteTunnelStatus>): void {
  s.status = { error: null, nextRetryAt: null, ...status } as LiteTunnelStatus
}

function clearTimers(s: State): void {
  if (s.retryTimer) clearTimeout(s.retryTimer)
  if (s.silenceTimer) clearTimeout(s.silenceTimer)
  s.retryTimer = s.silenceTimer = null
}

/** Ends the current attempt: its socket is closed and its callbacks will be ignored. */
function halt(s: State): void {
  s.generation++
  s.revoking = false
  clearTimers(s)
  const ws = s.ws
  s.ws = null
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    ws.removeAllListeners()
    ws.on("error", () => {})
    ws.close(1000, "lite closing")
    // A socket still connecting cannot close cleanly; don't wait on it.
    setTimeout(() => ws.terminate(), 2_000).unref()
  }
}

function stop(): void {
  const s = state()
  halt(s)
  setStatus(s, { state: "off" })
}

function restart(): void {
  const s = state()
  halt(s)
  s.backoffMs = MIN_BACKOFF_MS
  if (!isConnected()) {
    setStatus(s, { state: "off" })
    return
  }
  void dial(s, s.generation, false)
}

function retryLater(s: State, generation: number, error: string, waitMs = s.backoffMs): void {
  if (generation !== s.generation) return
  clearTimers(s)
  s.ws = null
  s.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(waitMs, s.backoffMs) * 2)
  setStatus(s, { state: "retrying", error, nextRetryAt: Date.now() + waitMs })
  s.retryTimer = setTimeout(() => void dial(s, generation, false), waitMs)
  s.retryTimer.unref?.()
}

async function dial(s: State, generation: number, forceRefresh: boolean): Promise<void> {
  if (generation !== s.generation) return
  setStatus(s, { state: "connecting" })
  const row = getLiteConnect()
  let token: string
  try {
    token = await freshAccessToken({ force: forceRefresh })
  } catch (err) {
    if (generation !== s.generation) return
    if (err instanceof LiteRefreshRefused) {
      // The row already says why (forgetLiteConnect): the card shows "disconnected" with it.
      log("refresh refused — disconnected")
      setStatus(s, { state: "off" })
      return
    }
    return retryLater(s, generation, (err as Error).message)
  }
  if (generation !== s.generation) return

  const capabilities = capabilitiesOf(row)
  const ws = new WebSocket(tunnelUrlOf(row.spuntoUrl), { handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 })
  s.ws = ws
  let lastError: string | null = null

  const heard = () => {
    if (s.silenceTimer) clearTimeout(s.silenceTimer)
    s.silenceTimer = setTimeout(() => ws.terminate(), SILENCE_MS)
    s.silenceTimer.unref?.()
  }

  ws.on("open", () => {
    heard()
    ws.send(JSON.stringify({ type: "hello", token, name: machineNameOf(row), version: liteVersion(), capabilities }))
  })
  ws.on("ping", heard)
  ws.on("message", (data) => {
    heard()
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (msg.type === "welcome" && typeof msg.connectionId === "string") {
      if (generation !== s.generation) return
      s.backoffMs = MIN_BACKOFF_MS
      recordWelcome(msg.connectionId)
      setStatus(s, { state: "online" })
      log(`online as ${msg.connectionId} (${capabilities.join(", ") || "no capability"})`)
      // A Cloud that restarted, or a Lite back online, starts again from the machine as it is.
      sendMachineSummary()
    } else if (msg.type === "request" && typeof msg.id === "string") {
      const id = msg.id
      void serve(s.localBase, capabilities, msg).then((res) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", id, ...res }))
      })
    }
  })
  ws.on("error", (err) => {
    lastError = err.message
  })
  ws.on("close", (code, reasonBuf) => {
    if (generation !== s.generation || s.ws !== ws) return
    const reason = reasonBuf.toString() || lastError || `closed (${code})`
    if (code === 4403 && s.revoking) {
      log("token given back — tunnel closed by Spunto (4403)")
      halt(s)
      setStatus(s, { state: "off" })
      return
    }
    if (code === 4403) {
      log("disconnected from Spunto (4403) — tokens forgotten")
      halt(s)
      forgetLiteConnect("This Lite was disconnected from Spunto — connect again to relay it")
      setStatus(s, { state: "off" })
      return
    }
    if (code === 4401 && !forceRefresh) {
      // The token was refused: refresh once and say hello again, now.
      clearTimers(s)
      s.ws = null
      void dial(s, generation, true)
      return
    }
    if (code === 4409) return retryLater(s, generation, "Replaced by another tunnel for this Lite", MAX_BACKOFF_MS)
    log(`tunnel closed: ${code} ${reason} — retrying in ${s.backoffMs / 1000} s`)
    retryLater(s, generation, code === 4401 ? "Spunto refused the token" : reason)
  })
}

type Reply = { status: number; contentType: string; body: string }

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): Reply => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify({ error, ...extra })).toString("base64"),
})

/**
 * One relayed request: refused unless the list has it *and* this hello granted its capability;
 * else served by Lite's own route on loopback, its answer sent back as is.
 */
export async function serve(localBase: string, granted: LiteCapability[], msg: Record<string, unknown>): Promise<Reply> {
  const method = typeof msg.method === "string" ? msg.method : ""
  const path = typeof msg.path === "string" ? msg.path : ""
  const query = typeof msg.query === "string" ? msg.query : ""
  const capability = relayCapability(method, path)
  if (!capability) return refuse(403, "not_relayed")
  if (!granted.includes(capability)) return refuse(403, "capability_not_granted", { capability })
  const url = localRequestUrl(localBase, path, query)
  if (!url) return refuse(403, "not_relayed")

  const headers: Record<string, string> = { Accept: "application/json" }
  if (typeof msg.contentType === "string") headers["Content-Type"] = msg.contentType
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" && typeof msg.body === "string" ? msg.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    })
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > MAX_RESPONSE_BYTES) return refuse(502, "response_too_large")
    return { status: res.status, contentType: res.headers.get("content-type") ?? "application/octet-stream", body: body.toString("base64") }
  } catch (err) {
    return refuse(502, "lite_route_failed", { detail: (err as Error).message })
  }
}

function emit(message: Record<string, unknown>): boolean {
  const s = state()
  if (s.status.state !== "online" || s.ws?.readyState !== WebSocket.OPEN) return false
  s.ws.send(JSON.stringify(message))
  return true
}

/**
 * At boot (server.ts): registers the controls and dials if a link is stored — and only then: the
 * relay is off until someone connects it in Settings. Starts the tick of the Live Activities'
 * events too (services/lite-events.ts), idle while offline. `localBase`, `liveTickMs` are for the tests.
 */
export function startLiteTunnel(opts: { localBase?: string; liveTickMs?: number } = {}): void {
  const s = state()
  if (opts.localBase) s.localBase = opts.localBase
  setLiteTunnel({ restart, stop, revoking: () => void (state().revoking = true), status: () => state().status, emit })
  startLiveEvents(opts.liveTickMs)
  restart()
}
