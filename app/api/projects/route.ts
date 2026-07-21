import { listProjects, createProject } from "@/services/projects"
import { CreateProjectSchema } from "@/lib/validation"
import { json, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  return json(listProjects())
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, CreateProjectSchema)
  if ("response" in parsed) return parsed.response
  return json(createProject(parsed.data), { status: 201 })
}
