import { z } from "zod"
import { createServer, listServers, McpServerError, serializeServer } from "@/services/mcp-servers"
import { json, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** MCP servers (docs/serveurs-mcp.md): declared once, given to task sessions through the gateway. */

const CreateMcpServerSchema = z.object({
  name: z.string().min(1).max(40),
  url: z.string().url(),
  mode: z.enum(["default", "optional"]).optional(),
  headerName: z.string().max(100).optional(),
  headerValue: z.string().max(4000).optional(),
  /** Only for an authorization server that offers no dynamic registration. */
  clientId: z.string().max(500).optional(),
  clientSecret: z.string().max(500).optional(),
})

export async function GET() {
  return json(listServers().map(serializeServer))
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, CreateMcpServerSchema)
  if ("response" in parsed) return parsed.response
  try {
    return json(serializeServer(await createServer(parsed.data)), { status: 201 })
  } catch (err) {
    if (err instanceof McpServerError) return Response.json({ error: err.message }, { status: err.status })
    throw err
  }
}
