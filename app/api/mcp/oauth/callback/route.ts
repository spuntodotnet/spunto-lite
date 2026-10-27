import { finishConnect, McpServerError, pendingServer } from "@/services/mcp-servers"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Where an MCP server's authorization page sends the browser back (registered as the client's
 * redirect URI). Finishes the connection, then returns to Settings with `?mcpConnected=<name>` or
 * `?mcpError=<why>`.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const q = Object.fromEntries(url.searchParams)
  const back = (params: Record<string, string>) =>
    // Relative: the browser resolves it against the origin it came back to.
    new Response(null, { status: 302, headers: { Location: `/settings?${new URLSearchParams(params)}` } })
  if (!q.state || !pendingServer(q.state)) return back({ mcpError: "This authorization is unknown or expired — connect again" })
  try {
    const server = await finishConnect({ state: q.state, code: q.code, iss: q.iss, error: q.error })
    return back({ mcpConnected: server.name })
  } catch (err) {
    if (err instanceof McpServerError) return back({ mcpError: err.message })
    throw err
  }
}
