import { getWorkerRow } from "@/services/workers"
import { listTerminalSessions, createTerminalSession } from "@/lib/docker"
import { isAttached } from "@/lib/terminal-attachments"
import { json } from "@/lib/http"
import { newShortId } from "@/lib/id"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = getWorkerRow(id)
  if (!w?.containerId) return json([])
  // Whether a session has a client is the WebSocket bridge's knowledge, not the container's —
  // a dtach socket says who could connect, never who is.
  return json(await listTerminalSessions(w.containerId, (name) => isAttached(id, name)).catch(() => []))
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = getWorkerRow(id)
  if (!w?.containerId) return json({ error: "Worker not running" }, { status: 400 })
  const name = `work-${newShortId().slice(0, 4)}`
  await createTerminalSession(w.containerId, name)
  return json({ name }, { status: 201 })
}
