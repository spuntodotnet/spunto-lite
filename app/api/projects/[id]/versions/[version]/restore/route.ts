import { restoreVersion } from "@/services/projects"
import { json, notFound, badRequest } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(_req: Request, { params }: { params: Promise<{ id: string; version: string }> }) {
  const { id, version } = await params
  const v = Number(version)
  if (!Number.isInteger(v)) return badRequest("Invalid version")
  const restored = restoreVersion(id, v)
  return restored ? json(restored) : notFound("Project or version not found")
}
