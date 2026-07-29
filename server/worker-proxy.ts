import http from "node:http"
import net from "node:net"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { BASE_DOMAIN } from "../lib/env"
import {
  SHARED_NETWORK_NAME,
  connectSelfToNetwork,
  resolveContainerIp,
  resolveServiceIp,
  workerNetworkName,
} from "../lib/docker"
import { getServiceBySlug, servicePrimaryPort } from "../services/services"

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
  const suffix = "." + BASE_DOMAIN
  let h = host
  if (h.endsWith(suffix)) h = h.slice(0, -suffix.length)
  else return null

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

export async function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
  const target = await resolveTarget(req.headers.host?.split(":")[0])
  if (!target) {
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
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
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
