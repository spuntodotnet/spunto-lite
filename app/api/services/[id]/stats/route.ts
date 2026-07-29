import { getServiceRow } from "@/services/services"
import { getContainerStats } from "@/lib/docker"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const s = getServiceRow(id)
  if (!s?.containerId) return json(null)
  return json(await getContainerStats(s.containerId).catch(() => null))
}
