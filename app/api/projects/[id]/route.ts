import { getProject, updateProject, deleteProject } from "@/services/projects"
import { UpdateProjectSchema } from "@/lib/validation"
import { json, parseBody, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = getProject(id)
  return project ? json(project) : notFound("Project not found")
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, UpdateProjectSchema)
  if ("response" in parsed) return parsed.response
  const updated = updateProject(id, parsed.data)
  return updated ? json(updated) : notFound("Project not found")
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  deleteProject(id)
  return new Response(null, { status: 204 })
}
