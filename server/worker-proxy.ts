import http from "node:http"
import net from "node:net"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { BASE_DOMAINS } from "../lib/env"
import {
  SHARED_NETWORK_NAME,
  connectSelfToNetwork,
  resolveContainerIp,
  resolveServiceIp,
  workerNetworkName,
} from "../lib/docker"
import { getServiceBySlug, servicePrimaryPort } from "../services/services"
import { getWorkerLive, getWorkerRow, startWorker } from "../services/workers"
import type { Worker } from "../db/schema"
import { renderPage, type ProxyPage } from "./proxy-pages"

/** A proxied subdomain either points at a worker or at a shared service. */
export type ProxyRoute = { kind: "worker"; workerId: string; port: number } | { kind: "service"; label: string }

/**
 * Parses a proxied subdomain host — a worker's, or a shared service's:
 *   worker-<id>.<BASE_DOMAIN>           → { worker, port: 8080 }  (code-server)
 *   worker-<id>-<port>.<BASE_DOMAIN>    → { worker, port }
 *   svc-<slug>[-<port>].<BASE_DOMAIN>   → { service }, label left raw
 *
 * Worker ids are lowercase-alphanumeric (no hyphens), so their optional trailing
 * `-<digits>` segment is unambiguously the port. Service slugs may themselves
 * contain hyphens *and* end in digits (`postgres-15`), so a `svc-…` label can't be
 * split here without ambiguity: it's handed over whole and `resolveServiceRoute`
 * disambiguates it against the services that actually exist.
 */
export function parseProxyHost(host?: string): ProxyRoute | null {
  if (!host) return null
  // Any configured base domain matches — a deployment answers both on `*.localhost`
  // (host browser) and on the CoreDNS-served wildcard (containers). See lib/env.ts.
  const lower = host.toLowerCase()
  const suffix = BASE_DOMAINS.map((d) => "." + d).find((s) => lower.endsWith(s))
  if (!suffix) return null
  const h = lower.slice(0, -suffix.length)
  if (!h) return null

  if (h.startsWith("svc-")) {
    const label = h.slice("svc-".length)
    return label ? { kind: "service", label } : null
  }

  if (!h.startsWith("worker-")) return null
  const rest = h.slice("worker-".length)
  const parts = rest.split("-")
  if (parts.length === 1 && parts[0]) return { kind: "worker", workerId: parts[0], port: 8080 }
  if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1]))
    return { kind: "worker", workerId: parts[0], port: Number(parts[1]) }
  return null
}

/**
 * Turns a raw `svc-` label into { slug, port }. The whole label is tried as a slug
 * first — so `svc-postgres-15` reaches the service literally named `postgres-15` on
 * its default port — and only then split on a trailing `-<digits>` to read that
 * segment as an explicit port (`svc-minio-9001` → the console of `minio`).
 */
function resolveServiceRoute(label: string): { slug: string; port: number } | null {
  const exact = getServiceBySlug(label)
  if (exact) {
    const port = exact.httpPort ?? servicePrimaryPort(exact)
    return port ? { slug: exact.slug, port } : null
  }
  const m = label.match(/^(.+)-(\d+)$/)
  if (!m) return null
  const withPort = getServiceBySlug(m[1])
  return withPort ? { slug: withPort.slug, port: Number(m[2]) } : null
}

/** Resolves a proxied host to a reachable { ip, port }, joining the right network first. */
async function resolveTarget(host?: string): Promise<{ ip: string; port: number } | null> {
  const route = parseProxyHost(host)
  if (!route) return null

  if (route.kind === "service") {
    const resolved = resolveServiceRoute(route.label)
    if (!resolved) return null
    await connectSelfToNetwork(SHARED_NETWORK_NAME)
    const ip = await resolveServiceIp(resolved.slug)
    return ip ? { ip, port: resolved.port } : null
  }

  await connectSelfToNetwork(workerNetworkName(route.workerId))
  const ip = await resolveContainerIp(route.workerId)
  return ip ? { ip, port: route.port } : null
}

/**
 * What to show instead of a worker's port, when it cannot be reached (Cloud `workerBlockPage`,
 * BAC-74) — or null to keep the plain error. `refused`: the container is up, nothing answered on
 * the port.
 */
export function workerBlockPage(worker: Pick<Worker, "id" | "state" | "containerId" | "error"> | undefined, port: number, dashboardUrl: string, refused = false): { status: number; page: ProxyPage } {
  const subject = worker ? `worker ${worker.id} · port ${port}` : `port ${port}`
  const common = { subject, dashboardUrl, state: worker?.state ?? null }
  if (!worker) {
    return { status: 404, page: { ...common, kind: "notfound", title: "No such workspace", message: "This address points at a workspace that doesn't exist — it may have been deleted." } }
  }
  if (["provisioning", "building", "starting"].includes(worker.state)) {
    return {
      status: 503,
      page: { ...common, kind: "starting", autoPoll: true, title: "Workspace is starting", message: "The workspace is coming up. This page reloads on its own once it is ready." },
    }
  }
  if (worker.state === "ready" && refused) {
    return {
      status: 502,
      page: { ...common, kind: "unavailable", canRetry: true, title: `Nothing listens on port ${port}`, message: "The workspace is running, but nothing answers on this port yet. Start the app inside it, then retry." },
    }
  }
  if (!worker.containerId) {
    return {
      status: 503,
      page: { ...common, kind: "unavailable", canRetry: true, title: "Workspace has no container", message: "This workspace was never built, so there is nothing to start.", detail: worker.error },
    }
  }
  // Stopped — by hand, by a park, or by a crash (`error`, with what Docker said): Start brings it
  // back, on the click only.
  return {
    status: 503,
    page: {
      ...common,
      kind: "stopped",
      canStart: true,
      title: worker.state === "error" ? "Workspace stopped on an error" : "Workspace is stopped",
      message: "Start it to open this port. Its disk was kept: /workspace is as it was left.",
      detail: worker.state === "error" ? worker.error : null,
    },
  }
}

/** Lite's own page for a worker, from the host the request came on (`worker-<id>-<port>.<domain>[:port]`). */
function dashboardUrlFor(req: IncomingMessage, workerId: string): string {
  const host = req.headers.host ?? ""
  const [name, port] = host.split(":")
  const base = BASE_DOMAINS.find((d) => name.toLowerCase().endsWith("." + d)) ?? "localhost"
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http"
  const projectId = getWorkerRow(workerId)?.projectId
  return `${proto}://${base}${port ? `:${port}` : ""}${projectId ? `/projects/${projectId}/workers/${workerId}` : "/"}`
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.method === "GET" || req.method === "HEAD") && (req.headers.accept ?? "").includes("text/html")
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

/**
 * The backing API of the pages above, on the worker's own host: its state, and a start. Only the
 * stopped ones start — a worker already on its way, or up, answers with its state.
 */
async function handleControl(req: IncomingMessage, res: ServerResponse, workerId: string, path: string) {
  const worker = await getWorkerLive(workerId)
  if (!worker) return sendJson(res, 404, { error: "No such workspace" })
  if (path === "/__spunto/status") return sendJson(res, 200, { state: worker.state })
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" })
  if (!["stopped", "error"].includes(worker.state)) return sendJson(res, 200, { state: worker.state })
  if (!worker.containerId) return sendJson(res, 409, { error: "This workspace has no container to start" })
  try {
    const started = await startWorker(workerId)
    console.log(`[proxy] worker ${workerId} started from its port page`)
    return sendJson(res, 200, { state: started?.state ?? "starting" })
  } catch (err) {
    return sendJson(res, 409, { error: (err as Error)?.message ?? "Start failed" })
  }
}

async function sendBlockPage(req: IncomingMessage, res: ServerResponse, route: Extract<ProxyRoute, { kind: "worker" }>, refused: boolean) {
  const worker = await getWorkerLive(route.workerId).catch(() => getWorkerRow(route.workerId))
  const { status, page } = workerBlockPage(worker, route.port, dashboardUrlFor(req, route.workerId), refused)
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  res.end(renderPage(page))
}

export async function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host?.split(":")[0]
  const route = parseProxyHost(host)
  const path = (req.url ?? "/").split("?")[0]
  if (route?.kind === "worker" && (path === "/__spunto/status" || path === "/__spunto/start")) {
    return handleControl(req, res, route.workerId, path)
  }
  const target = await resolveTarget(host)
  if (!target) {
    if (route?.kind === "worker" && wantsHtml(req)) return sendBlockPage(req, res, route, false)
    res.writeHead(502, { "content-type": "text/plain" })
    res.end("Not reachable (worker or service not running yet?)")
    return
  }
  const proxyReq = http.request(
    { host: target.ip, port: target.port, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on("error", () => {
    if (res.headersSent) return void res.end()
    if (route?.kind === "worker" && wantsHtml(req)) return void sendBlockPage(req, res, route, true).catch(() => res.end())
    res.writeHead(502, { "content-type": "text/plain" })
    res.end("Bad gateway")
  })
  req.pipe(proxyReq)
}

export async function handleProxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const target = await resolveTarget(req.headers.host?.split(":")[0])
  if (!target) return void socket.destroy()

  const upstream = net.connect(target.port, target.ip, () => {
    // Replay the request line + headers, then splice the two sockets together so
    // code-server's WebSocket (and any Upgrade) passes through transparently.
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
    raw += "\r\n"
    upstream.write(raw)
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
}
