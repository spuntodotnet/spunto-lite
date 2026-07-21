import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { docker } from "../lib/docker"
import { getWorkerRow } from "../services/workers"

// Terminal bridge, ported from apps/agent/src/terminal.ts. A throwaway `docker exec`
// client attaches to a persistent tmux session inside the worker; when the browser
// disconnects the tmux client exits and the session detaches (keeps running).

const wss = new WebSocketServer({ noServer: true })

// Docker multiplexes exec output with 8-byte frame headers; strip them so header
// bytes don't leak into xterm as visible characters.
class Demuxer {
  private buf = Buffer.alloc(0)
  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: Buffer[] = []
    while (this.buf.length >= 8) {
      const size = this.buf.readUInt32BE(4)
      if (this.buf.length < 8 + size) break
      out.push(this.buf.subarray(8, 8 + size))
      this.buf = this.buf.subarray(8 + size)
    }
    return out
  }
}

function sanitizeSessionName(name: string | undefined): string {
  const cleaned = (name ?? "main").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return cleaned || "main"
}

function parseTerminalUrl(url: string): { workerId: string; cols: number; rows: number; session: string } | null {
  const m = url.match(/^\/api\/workers\/([^/]+)\/terminal/)
  if (!m) return null
  const q = new URL(url, "http://x").searchParams
  return {
    workerId: m[1],
    cols: Number(q.get("cols")) || 80,
    rows: Number(q.get("rows")) || 24,
    session: sanitizeSessionName(q.get("session") || "main"),
  }
}

export function handleTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const parsed = parseTerminalUrl(req.url || "")
  if (!parsed) return void socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => void bridge(ws, parsed))
}

async function bridge(
  ws: WebSocket,
  { workerId, cols, rows, session }: { workerId: string; cols: number; rows: number; session: string },
) {
  const w = getWorkerRow(workerId)
  if (!w?.containerId) {
    ws.send(JSON.stringify({ type: "error", message: "Worker not running" }))
    return ws.close()
  }

  const container = docker.getContainer(w.containerId)
  const shellCmd =
    `if command -v tmux >/dev/null 2>&1; then exec tmux -u new-session -A -s "$MP_TMUX_SESSION"; ` +
    `else _SH=$(getent passwd vscode 2>/dev/null | cut -d: -f7); exec \${_SH:-/bin/bash}; fi`

  let execRef: Awaited<ReturnType<typeof container.exec>>
  try {
    execRef = await container.exec({
      Cmd: ["/bin/sh", "-c", shellCmd],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: "vscode",
      WorkingDir: "/home/vscode",
      Env: [
        "TERM=xterm-256color",
        "COLORTERM=truecolor",
        "LANG=en_US.UTF-8",
        "LC_ALL=en_US.UTF-8",
        `COLUMNS=${cols}`,
        `LINES=${rows}`,
        `MP_TMUX_SESSION=${session}`,
      ],
    })
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: (err as Error).message }))
    return ws.close()
  }

  const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) =>
    execRef.start({ hijack: true, stdin: true }, (err, s) => (err || !s ? reject(err) : resolve(s as NodeJS.ReadWriteStream))),
  ).catch(() => null)
  if (!stream) return ws.close()

  try {
    await execRef.resize({ w: cols, h: rows })
  } catch {}

  ws.send(JSON.stringify({ type: "ready" }))

  const demux = new Demuxer()
  stream.on("data", (chunk: Buffer) => {
    for (const payload of demux.push(chunk)) {
      if (payload.length > 0 && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "output", data: payload.toString("base64") }))
      }
    }
  })
  stream.on("end", () => ws.readyState === ws.OPEN && ws.close())
  stream.on("error", () => ws.readyState === ws.OPEN && ws.close())

  ws.on("message", (raw) => {
    let msg: { type: string; data?: string; cols?: number; rows?: number }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === "input" && msg.data) {
      stream.write(Buffer.from(msg.data, "base64"))
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      execRef.resize({ w: msg.cols, h: msg.rows }).catch(() => {})
    }
  })

  ws.on("close", () => {
    try {
      stream.end()
    } catch {}
  })
}
