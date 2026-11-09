import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import { DATA_DIR } from "./env"

/**
 * Opt-in usage telemetry: events sent as OTLP/HTTP logs to a collector *you* point it at — an
 * OpenObserve, a Grafana/Loki, any OpenTelemetry collector. Off unless `TELEMETRY_OTLP_ENDPOINT`
 * is set: there is no default endpoint, nothing is ever sent to Spunto.
 *
 * What goes out is usage, never content: which pages are opened and which actions are taken (the
 * route with its ids masked, the status, the duration), a heartbeat with counts, how long the slow
 * background measurements take. No names, no query strings, no request bodies, no IPs.
 *
 *   TELEMETRY_OTLP_ENDPOINT  base URL; events are POSTed to `<endpoint>/v1/logs`
 *                            (OpenObserve: `https://<host>/api/<org>`)
 *   TELEMETRY_OTLP_HEADERS   `key=value,key2=value2`, as OTEL_EXPORTER_OTLP_HEADERS
 *                            (OpenObserve: `Authorization=Basic <base64 of email:token>`)
 *   TELEMETRY_STREAM         sent as `stream-name`, the stream OpenObserve files them in
 *                            (default `spunto_lite`)
 *   TELEMETRY_INSTANCE       a name for this install (default: a random id kept in DATA_DIR)
 *
 * Events are batched and sent every FLUSH_INTERVAL_MS. A collector that is down costs a warning
 * and the batch, never a request: tracking is synchronous and only appends to a buffer.
 */

const ENDPOINT = (process.env.TELEMETRY_OTLP_ENDPOINT || "").trim().replace(/\/+$/, "")
const STREAM = (process.env.TELEMETRY_STREAM || "spunto_lite").trim()
const FLUSH_INTERVAL_MS = 10_000
const MAX_BUFFER = 2_000

export const TELEMETRY_ENABLED = ENDPOINT !== ""

/** `TELEMETRY_OTLP_HEADERS`, parsed like OTEL_EXPORTER_OTLP_HEADERS (values may be URL-encoded). */
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of raw.split(",")) {
    const i = pair.indexOf("=")
    if (i <= 0) continue
    const key = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}

type Value = string | number | boolean | null | undefined
export type Attributes = Record<string, Value>

type LogRecord = { timeUnixNano: string; severityNumber: number; severityText: string; body: { stringValue: string }; attributes: unknown[] }

type State = { buffer: LogRecord[]; timer: ReturnType<typeof setInterval> | null; resource: unknown[] | null; lastWarn: number }

// On `globalThis`, like lib/agent.ts: events come from server.ts's module graph (requests, the
// heartbeat) and from Next's (route handlers) — one buffer, one flush loop.
const KEY = Symbol.for("spunto-lite.telemetry")
function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State }
  return (g[KEY] ??= { buffer: [], timer: null, resource: null, lastWarn: 0 })
}

function otlpValue(v: Exclude<Value, null | undefined>) {
  if (typeof v === "boolean") return { boolValue: v }
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  return { stringValue: v }
}

function otlpAttributes(attrs: Attributes) {
  return Object.entries(attrs)
    .filter((e): e is [string, Exclude<Value, null | undefined>] => e[1] !== null && e[1] !== undefined)
    .map(([key, v]) => ({ key, value: otlpValue(v) }))
}

/** A random id for this install, kept next to the database so it survives image updates. */
function instanceId(): string {
  const named = process.env.TELEMETRY_INSTANCE?.trim()
  if (named) return named
  const file = join(DATA_DIR, "telemetry-id")
  try {
    const saved = readFileSync(file, "utf8").trim()
    if (saved) return saved
  } catch {}
  const id = randomUUID()
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(file, id)
  } catch {}
  return id
}

/** Record an event. A no-op when telemetry is off. */
export function track(event: string, attrs: Attributes = {}, severity: "INFO" | "WARN" | "ERROR" = "INFO"): void {
  if (!TELEMETRY_ENABLED) return
  const s = state()
  if (s.buffer.length >= MAX_BUFFER) s.buffer.shift()
  s.buffer.push({
    timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
    severityNumber: severity === "ERROR" ? 17 : severity === "WARN" ? 13 : 9,
    severityText: severity,
    body: { stringValue: event },
    attributes: otlpAttributes({ event, ...attrs }),
  })
}

/** Send what is buffered now. Exported for the flush loop, shutdown and tests. */
export async function flushTelemetry(): Promise<void> {
  const s = state()
  if (!TELEMETRY_ENABLED || s.buffer.length === 0 || !s.resource) return
  const batch = s.buffer.splice(0, s.buffer.length)
  const body = {
    resourceLogs: [{ resource: { attributes: s.resource }, scopeLogs: [{ scope: { name: "spunto-lite" }, logRecords: batch }] }],
  }
  try {
    const res = await fetch(`${ENDPOINT}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", "stream-name": STREAM, ...parseHeaders(process.env.TELEMETRY_OTLP_HEADERS || "") },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`)
  } catch (err) {
    // Once a minute at most: a collector that is down shouldn't fill the logs.
    if (Date.now() - s.lastWarn > 60_000) {
      s.lastWarn = Date.now()
      console.warn(`[telemetry] could not send ${batch.length} event(s) to ${ENDPOINT}: ${err}`)
    }
  }
}

/** Start the flush loop, with what describes this install on every event. Once per process. */
export function startTelemetry(resource: Attributes): void {
  if (!TELEMETRY_ENABLED) return
  const s = state()
  if (s.timer) return
  s.resource = otlpAttributes({ "service.name": "spunto-lite", "service.instance.id": instanceId(), ...resource })
  s.timer = setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS)
  s.timer.unref?.()
  console.log(`[telemetry] on — usage events go to ${ENDPOINT} (stream ${STREAM})`)
}

// ─── HTTP requests ───────────────────────────────────────────────────────────

/**
 * The route a path belongs to, with what identifies a record masked: `/projects/:id/workers/:id`.
 * Ids here are 12 (or 8) lowercase alphanumerics (lib/id.ts) — a segment with a digit in it, so
 * `settings` or `workers` stay as they are — plus UUIDs and plain numbers.
 */
export function routeOf(path: string): string {
  return path
    .split("/")
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
      /^\d+$/.test(seg) ||
      (/^[0-9a-z]{8,}$/.test(seg) && /\d/.test(seg)) ||
      seg.length > 40
        ? ":id"
        : seg,
    )
    .join("/")
}

/**
 * What a request to the app (not to a worker) is worth reporting as: a page opened, an action
 * taken, an API call that failed — or nothing. Reads the dashboard polls every few seconds are
 * left out on purpose, they would bury what was actually done.
 */
function requestKind(req: IncomingMessage, path: string, status: number): "page" | "action" | "error" | null {
  if (path.startsWith("/_next/") || path === "/favicon.ico" || /\.[a-z0-9]+$/i.test(path)) return null
  const method = req.method || "GET"
  if (path.startsWith("/api/")) {
    if (status >= 500) return "error"
    return method === "GET" || method === "HEAD" || method === "OPTIONS" ? null : "action"
  }
  if (method !== "GET") return null
  // A full load, or a client-side navigation (an RSC fetch) — not the prefetch of a link in view.
  const h = req.headers
  if (h["next-router-prefetch"]) return null
  if (h["sec-fetch-dest"] === "document" || h["rsc"] === "1") return "page"
  return null
}

/** Report this request once it has been answered. A no-op when telemetry is off. */
export function trackRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!TELEMETRY_ENABLED) return
  const started = Date.now()
  res.once("finish", () => {
    const path = (req.url || "/").split("?")[0]
    const kind = requestKind(req, path, res.statusCode)
    if (!kind) return
    track(
      kind === "page" ? "page.view" : "api.request",
      { kind, method: req.method, route: routeOf(path), status: res.statusCode, duration_ms: Date.now() - started },
      kind === "error" ? "ERROR" : "INFO",
    )
  })
}
