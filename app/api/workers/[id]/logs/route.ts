import { getWorkerRow } from "@/services/workers"
import { getContainerLogs } from "@/lib/docker"
import { readProjectLog } from "@/lib/agent"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = getWorkerRow(id)
  if (!w?.containerId) return new Response("", { headers: { "content-type": "text/plain" } })
  // A worker that carries the agent: its container's own output is the agent's; what the setup
  // printed — the recipe, the clones, postCreate, postStart — is the runner's log, read through it.
  if (w.dataPlane === "agent") {
    const [project, agent] = await Promise.all([readProjectLog(id).catch(() => ""), getContainerLogs(w.containerId).catch(() => "")])
    const body = project || agent
    return new Response(body, { headers: { "content-type": "text/plain" } })
  }
  const logs = await getContainerLogs(w.containerId).catch(() => "")
  return new Response(logs, { headers: { "content-type": "text/plain" } })
}
