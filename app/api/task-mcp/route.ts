import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { resolveGatewayToken } from "@/services/mcp-servers"
import { subtasksServer } from "@/services/task-subtasks-mcp"
import { getRawTask } from "@/services/tasks"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * `spunto-tasks`, the sub-tasks MCP server (docs/taches.md § « Sous-tâches »): Streamable HTTP, a
 * task's own session reaches it with its gateway token (`Authorization: Bearer $SPUNTO_WORKER_TOKEN`)
 * and its tools act on that task's sub-tasks only. Stateless: POST only, one server per request.
 */
export async function POST(req: Request): Promise<Response> {
  const header = req.headers.get("authorization")
  const identity = resolveGatewayToken(header?.startsWith("Bearer ") ? header.slice(7) : undefined)
  // 403, not 401: a 401 would send the agent's MCP client looking for an OAuth server here.
  if (!identity) return Response.json({ error: "Forbidden" }, { status: 403 })
  const parent = getRawTask(identity.taskId)
  if (!parent) return Response.json({ error: "Not found" }, { status: 404 })

  const server = subtasksServer(parent)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    return await transport.handleRequest(req)
  } finally {
    await transport.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

const notAllowed = () =>
  Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed — this MCP server is stateless (POST only)." }, id: null }, { status: 405 })
export const GET = notAllowed
export const DELETE = notAllowed
