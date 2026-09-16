import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { buildDtachCommand, makeAttachClearStripper, sanitizeSessionName } from "@spunto/build/terminal"
import { docker } from "../lib/docker"
import { markAttached } from "../lib/terminal-attachments"
import { getWorkerRow } from "../services/workers"

// Terminal bridge: a throwaway `docker exec` attaches to a persistent session inside the worker,
// so closing a browser tab doesn't kill a build. When the browser disconnects the exec dies and
// the session detaches, still running.
//
// The shell that gets attached is `@spunto/build/terminal` — dtach, not tmux. tmux's only knob for
// "the wheel scrolls history" is `mouse on`, which also makes it swallow every drag: the selection
// a user expects stops being the browser's. dtach only does persistence and forwards every byte,
// so xterm keeps the mouse, its own scrollback and its own search. What dtach doesn't do is
// remember the screen, so the session is recorded container-side with script(1) and the tail of
// that recording is replayed just before attaching.

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
  // Built by the package, so the replay buffer, the trimming and the "no dtach here" fallback are
  // the same script both control planes run. The session name travels in the environment rather
  // than in the command, which is what keeps it out of the shell it would otherwise be
  // interpolated into.
  const shellCmd = buildDtachCommand()

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
        `MP_TERM_SESSION=${session}`,
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

  // The session now has a client. tmux reported this itself; a dtach socket cannot, so the
  // process holding the WebSocket is the one that records it — see lib/terminal-attachments.ts.
  const detach = markAttached(workerId, session)

  const demux = new Demuxer()
  // dtach clears the screen the moment a client attaches (a bare `ESC[H ESC[J`, hardcoded in its
  // source). That write lands *after* the replay the attach script just printed, and would wipe
  // exactly what the replay exists to show — so the first one is dropped, within a few seconds of
  // attaching only, leaving a program that legitimately clears its screen later alone.
  const stripAttachClear = makeAttachClearStripper()
  stream.on("data", (chunk: Buffer) => {
    for (const payload of demux.push(chunk)) {
      const data = Buffer.from(stripAttachClear(payload))
      if (data.length > 0 && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "output", data: data.toString("base64") }))
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
    detach()
    try {
      stream.end()
    } catch {}
  })
}
