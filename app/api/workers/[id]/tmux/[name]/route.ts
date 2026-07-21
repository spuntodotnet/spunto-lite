import { getWorkerRow } from "@/services/workers"
import { killTmuxSession } from "@/lib/docker"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params
  const w = getWorkerRow(id)
  if (w?.containerId) await killTmuxSession(w.containerId, name).catch(() => {})
  return new Response(null, { status: 204 })
}
