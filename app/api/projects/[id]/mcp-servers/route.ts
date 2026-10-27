import { z } from "zod"
import { getServer, projectServers, serializeServer, setProjectServer } from "@/services/mcp-servers"
import { getProjectRow } from "@/services/projects"
import { json, notFound, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Which MCP servers this project's tasks get. Saved per switch, outside the project's versions:
 * read at the next session of a task — no version, no rebuild.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!getProjectRow(id)) return notFound()
  return json(projectServers(id).map((s) => ({ ...s, server: serializeServer(s.server) })))
}

/** Turns a server on or off for this project. Back to what its mode says = the exception is removed. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!getProjectRow(id)) return notFound()
  const parsed = await parseBody(req, z.object({ serverId: z.string().min(1), enabled: z.boolean() }))
  if ("response" in parsed) return parsed.response
  const server = getServer(parsed.data.serverId)
  if (!server) return notFound("Unknown MCP server")
  setProjectServer(id, server, parsed.data.enabled)
  return new Response(null, { status: 204 })
}
