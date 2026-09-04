import { createServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { existsSync, readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Server } from "node:http"
import type { Duplex } from "node:stream"
import next from "next"
import { PORT, BASE_DOMAIN, BASE_DOMAINS, TLS_CERT_FILE, TLS_KEY_FILE, TLS_PORT } from "./lib/env"
import { runMigrations } from "./db/index"
import { handleProxyRequest, handleProxyUpgrade, parseProxyHost } from "./server/worker-proxy"
import { handleTerminalUpgrade } from "./server/terminal-ws"

const dev = process.env.NODE_ENV !== "production"
const app = next({ dev })
const handle = app.getRequestHandler()

/**
 * True for the hostnames the reverse proxy owns: `worker-<slug>.localhost`,
 * `worker-<slug>-3000.localhost`, and `svc-<slug>[-<port>].localhost` for a shared
 * service. Everything else is the app itself.
 */
function isProxyHost(host: string | undefined): boolean {
  return parseProxyHost(host) !== null
}

/**
 * Cert/key for the optional HTTPS listener, or null when TLS isn't configured (the
 * default) or the files aren't there. A configured-but-missing pair is a warning and
 * not a boot failure on purpose: the certs are generated locally by
 * `local-https/generate-certs.sh`, and a stack that comes up on plain HTTP is far
 * more useful than one that refuses to start because that script hasn't run yet.
 */
function readTlsMaterial(): { cert: Buffer; key: Buffer } | null {
  if (!TLS_CERT_FILE || !TLS_KEY_FILE) return null
  if (!existsSync(TLS_CERT_FILE) || !existsSync(TLS_KEY_FILE)) {
    console.warn(
      `[tls] TLS_CERT_FILE/TLS_KEY_FILE are set but missing on disk (${TLS_CERT_FILE}, ${TLS_KEY_FILE}) — ` +
        `serving plain HTTP only. Run local-https/generate-certs.sh to create them.`,
    )
    return null
  }
  try {
    return { cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) }
  } catch (err) {
    console.warn(`[tls] could not read the cert/key pair — serving plain HTTP only.`, err)
    return null
  }
}

async function main() {
  runMigrations()
  await app.prepare()

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host?.split(":")[0]
    if (isProxyHost(host)) {
      handleProxyRequest(req, res).catch((err) => {
        console.error("[proxy] error", err)
        if (!res.headersSent) res.writeHead(502)
        res.end("Bad gateway")
      })
      return
    }
    handle(req, res)
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = req.headers.host?.split(":")[0]
    const url = req.url || "/"

    // Our own terminal WebSocket (served on the app host).
    if (!isProxyHost(host) && url.startsWith("/api/workers/") && url.includes("/terminal")) {
      handleTerminalUpgrade(req, socket, head)
      return
    }

    // code-server (and its WebSockets) behind a worker or service subdomain.
    if (isProxyHost(host)) {
      handleProxyUpgrade(req, socket, head).catch((err) => {
        console.error("[proxy] upgrade error", err)
        socket.destroy()
      })
      return
    }

    // Let Next handle HMR websockets in dev.
    app.getUpgradeHandler()(req, socket, head)
  }

  const server = createServer(onRequest)
  server.on("upgrade", onUpgrade)

  const domains = BASE_DOMAINS.map((d) => `*.${d}`).join(", ")
  server.listen(PORT, () => {
    console.log(`▲ spunto-lite ready on http://localhost:${PORT}  (workers + services: ${domains})`)
  })

  // Same app, same proxy, same WebSocket routing — just terminated with TLS.
  const tls = readTlsMaterial()
  if (tls) {
    const secure: Server = createHttpsServer(tls, onRequest)
    secure.on("upgrade", onUpgrade)
    secure.listen(TLS_PORT, () => {
      console.log(`▲ spunto-lite also on https://${BASE_DOMAIN}:${TLS_PORT}  (workers + services: ${domains})`)
    })
  }
}

main().catch((err) => {
  console.error("Fatal boot error:", err)
  process.exit(1)
})
