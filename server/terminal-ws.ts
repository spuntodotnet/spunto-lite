import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

// ─── Phase 3 will implement the tmux docker-exec terminal bridge ──────────────

export function handleTerminalUpgrade(_req: IncomingMessage, socket: Duplex, _head: Buffer) {
  socket.destroy()
}
