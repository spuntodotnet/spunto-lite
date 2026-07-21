import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import next from "next"
import { PORT, BASE_DOMAIN } from "./lib/env"
import { runMigrations } from "./db/index"
import { handleWorkerRequest, handleWorkerUpgrade, parseWorkerHost } from "./server/worker-proxy"
import { handleTerminalUpgrade } from "./server/terminal-ws"

const dev = process.env.NODE_ENV !== "production"
const app = next({ dev })
const handle = app.getRequestHandler()

/** True for hostnames like `worker-<slug>.localhost` / `worker-<slug>-3000.localhost`. */
function isWorkerHost(host: string | undefined): boolean {
  return parseWorkerHost(host) !== null
}

async function main() {
  runMigrations()
  await app.prepare()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host?.split(":")[0]
    if (isWorkerHost(host)) {
      handleWorkerRequest(req, res).catch((err) => {
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
    if (!isWorkerHost(host) && url.startsWith("/api/workers/") && url.includes("/terminal")) {
      handleTerminalUpgrade(req, socket, head)
      return
    }

    // code-server (and its WebSockets) behind a worker subdomain.
    if (isWorkerHost(host)) {
      handleWorkerUpgrade(req, socket, head).catch((err) => {
        console.error("[proxy] upgrade error", err)
        socket.destroy()
      })
      return
    }

    // Let Next handle HMR websockets in dev.
    app.getUpgradeHandler()(req, socket, head)
  })

  server.listen(PORT, () => {
    console.log(`▲ spunto-lite ready on http://localhost:${PORT}  (workers: *.${BASE_DOMAIN})`)
  })
}

main().catch((err) => {
  console.error("Fatal boot error:", err)
  process.exit(1)
})
