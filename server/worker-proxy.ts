import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { BASE_DOMAIN } from "../lib/env"

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
  if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1])) {
    return { workerId: parts[0], port: Number(parts[1]) }
  }
  return null
}

// ─── Phase 3 will implement the actual reverse proxy to container IPs ─────────

export async function handleWorkerRequest(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(503, { "content-type": "text/plain" })
  res.end("Worker reverse-proxy not yet wired up (Phase 3).")
}

export async function handleWorkerUpgrade(_req: IncomingMessage, socket: Duplex, _head: Buffer) {
  socket.destroy()
}
