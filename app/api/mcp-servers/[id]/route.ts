import { z } from "zod"
import { deleteServer, serializeServer, setMode } from "@/services/mcp-servers"
import { json, notFound, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** `default`: every project's tasks get it unless a project turns it off. `optional`: the reverse. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, z.object({ mode: z.enum(["default", "optional"]) }))
  if ("response" in parsed) return parsed.response
  const row = setMode(id, parsed.data.mode)
  return row ? json(serializeServer(row)) : notFound()
}

/** Its connection and project settings go with it. Running sessions lose it at their next call. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return deleteServer(id) ? new Response(null, { status: 204 }) : notFound()
}
