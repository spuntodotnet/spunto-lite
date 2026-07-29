import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import next from "next"
import { PORT, BASE_DOMAIN } from "./lib/env"
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

async function main() {
  runMigrations()
  await app.prepare()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  })

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
  })

  server.listen(PORT, () => {
    console.log(`▲ spunto-lite ready on http://localhost:${PORT}  (workers + services: *.${BASE_DOMAIN})`)
  })
}

main().catch((err) => {
  console.error("Fatal boot error:", err)
  process.exit(1)
})
