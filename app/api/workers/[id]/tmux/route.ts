import { getWorkerRow } from "@/services/workers"
import { listTmuxSessions, createTmuxSession } from "@/lib/docker"
import { json } from "@/lib/http"
import { newShortId } from "@/lib/id"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = getWorkerRow(id)
  if (!w?.containerId) return json([])
  return json(await listTmuxSessions(w.containerId).catch(() => []))
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = getWorkerRow(id)
  if (!w?.containerId) return json({ error: "Worker not running" }, { status: 400 })
  const name = `work-${newShortId().slice(0, 4)}`
  await createTmuxSession(w.containerId, name)
  return json({ name }, { status: 201 })
}
