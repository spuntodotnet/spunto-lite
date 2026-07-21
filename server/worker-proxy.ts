import http from "node:http"
import net from "node:net"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { BASE_DOMAIN } from "../lib/env"
import { connectSelfToNetwork, resolveContainerIp, workerNetworkName } from "../lib/docker"

export type WorkerRoute = { workerId: string; port: number }

/**
 * Parses a worker subdomain host into { workerId, port }.
 *   worker-<id>.<BASE_DOMAIN>          → { workerId, port: 8080 }  (code-server)
 *   worker-<id>-<port>.<BASE_DOMAIN>   → { workerId, port }
 * Worker ids are lowercase-alphanumeric (no hyphens), so the optional trailing
 * `-<digits>` segment is unambiguously the port.
 */
export function parseWorkerHost(host?: string): WorkerRoute | null {
  if (!host) return null
  const suffix = "." + BASE_DOMAIN
  let h = host
  if (h.endsWith(suffix)) h = h.slice(0, -suffix.length)
  else return null
  if (!h.startsWith("worker-")) return null
  const rest = h.slice("worker-".length)
  const parts = rest.split("-")
  if (parts.length === 1 && parts[0]) return { workerId: parts[0], port: 8080 }
  if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1])) return { workerId: parts[0], port: Number(parts[1]) }
  return null
}

/** Resolves a worker host to a reachable { ip, port }, joining the worker network first. */
async function resolveTarget(host?: string): Promise<{ ip: string; port: number } | null> {
  const route = parseWorkerHost(host)
  if (!route) return null
  await connectSelfToNetwork(workerNetworkName(route.workerId))
  const ip = await resolveContainerIp(route.workerId)
  return ip ? { ip, port: route.port } : null
}

export async function handleWorkerRequest(req: IncomingMessage, res: ServerResponse) {
  const target = await resolveTarget(req.headers.host?.split(":")[0])
  if (!target) {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end("Worker not reachable (not running yet?)")
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

export async function handleWorkerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
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
