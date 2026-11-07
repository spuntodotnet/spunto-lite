import { getWorkerRow } from "@/services/workers"
import { getProjectRow } from "@/services/projects"
import { detectListeningPorts } from "@/lib/docker"
import { mergePortViews } from "@/lib/ports"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * A worker's ports as a task's Machine panel shows them (Cloud's `GET …/sandboxes/{id}/ports`,
 * c429724d): what the project declares, with its labels and landing paths, merged with what
 * listens inside the worker right now. `GET …/ports` stays the bare list of listening numbers.
 *
 * Answers for a worker that is not up too — the declared ports, none of them listening — so a
 * parked task still shows what its app will serve. Asked of the worker only when it is `ready`.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = getWorkerRow(id)
  if (!w) return notFound()
  const project = getProjectRow(w.projectId)
  const listening = w.containerId && w.state === "ready" ? await detectListeningPorts(w.containerId).catch(() => []) : []
  return json({ ports: mergePortViews(project?.forwardPorts ?? [], project?.portsAttributes ?? {}, listening) })
}
