import { getWorkerRow } from "@/services/workers"
import { detectListeningPorts } from "@/lib/docker"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = getWorkerRow(id)
  if (!w?.containerId) return json([])
  return json(await detectListeningPorts(w.containerId).catch(() => []))
}
