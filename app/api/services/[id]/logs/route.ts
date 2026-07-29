import { getServiceRow } from "@/services/services"
import { getContainerLogs } from "@/lib/docker"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const s = getServiceRow(id)
  if (!s?.containerId) return new Response("", { headers: { "content-type": "text/plain" } })
  const logs = await getContainerLogs(s.containerId).catch(() => "")
  return new Response(logs, { headers: { "content-type": "text/plain" } })
}
