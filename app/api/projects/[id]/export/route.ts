import { exportProject } from "@/services/projects"
import { projectExportFilename } from "@/lib/project-export"
import { notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Downloads the project's portable spec as a JSON file (see lib/project-export.ts). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = exportProject(id)
  if (!payload) return notFound("Project not found")

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Filename is slugified to [a-z0-9-] — safe to inline in the header.
      "content-disposition": `attachment; filename="${projectExportFilename(payload.project.name)}"`,
    },
  })
}
