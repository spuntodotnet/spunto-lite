import { clearProjectServer } from "@/services/mcp-servers"
import { getProjectRow } from "@/services/projects"
import { notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Returns a server to its mode for this project. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  const { id, serverId } = await params
  if (!getProjectRow(id)) return notFound()
  clearProjectServer(id, serverId)
  return new Response(null, { status: 204 })
}
