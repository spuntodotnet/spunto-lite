import { getWorkerRow } from "@/services/workers"
import { getProjectRow } from "@/services/projects"
import { getGitStatus } from "@/lib/docker"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = getWorkerRow(id)
  if (!w?.containerId) return json([])
  const project = getProjectRow(w.projectId)
  const paths = (project?.repositories ?? []).map((r) => `/workspace/${r.workspacePath}`)
  return json(await getGitStatus(w.containerId, paths).catch(() => []))
}
