import { mcpFetch } from "@/lib/mcp-oauth"
import { accessToken, getConnection, getServer, isEnabledForProject, NotConnected, resolveGatewayToken, staticHeader } from "@/services/mcp-servers"

/**
 * The gateway (docs/serveurs-mcp.md): an MCP server's Streamable HTTP endpoint, as a task session
 * reaches it. The session shows its task's gateway token (`Authorization: Bearer lmg_…`, minted
 * at session start); Lite finds the connection, refreshes its token if needed and relays the
 * exchange with **its** credential. The worker never holds the vendor's token, and `lmg_` is
 * never passed on (MCP forbids token passthrough).
 *
 * The response body is the upstream's stream, returned as-is — JSON or SSE — never buffered.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Headers of the Streamable HTTP transport that go through, each way. Never `Authorization`. */
const REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"]

/**
 * A failure the agent can read and repeat to the human: a JSON-RPC error answering its request
 * (HTTP 200), rather than an HTTP status its MCP client would turn into "server failed".
 */
function rpcError(body: ArrayBuffer | undefined, message: string): Response {
  let id: unknown = null
  try {
    const parsed = body ? JSON.parse(Buffer.from(body).toString("utf8")) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "id" in parsed) id = parsed.id
  } catch {}
  if (id === null) return Response.json({ error: message }, { status: 503 })
  return Response.json({ jsonrpc: "2.0", id, error: { code: -32001, message } })
}

async function relay(req: Request, { params }: { params: Promise<{ serverId: string }> }): Promise<Response> {
  const { serverId } = await params
  const header = req.headers.get("authorization")
  const identity = resolveGatewayToken(header?.startsWith("Bearer ") ? header.slice(7) : undefined)
  // 403, not 401: a 401 would send the agent's MCP client looking for an OAuth server here.
  if (!identity) return Response.json({ error: "Forbidden" }, { status: 403 })
  const server = getServer(serverId)
  // Only the servers the task's own project has on.
  if (!server || !isEnabledForProject(server, identity.projectId)) return Response.json({ error: "Not found" }, { status: 404 })

  const method = req.method
  const body = method === "POST" ? await req.arrayBuffer() : undefined
  const forwarded = new Headers()
  for (const h of REQUEST_HEADERS) {
    const v = req.headers.get(h)
    if (v) forwarded.set(h, v)
  }

  const reconnect = `Settings → MCP servers → ${server.name} → Connect`
  const oauth = server.auth === "oauth"
  const conn = oauth ? getConnection(server.id) : undefined
  if (oauth && conn?.status !== "ok") {
    return rpcError(body, conn ? `${server.name} needs to be connected again (${reconnect})` : `${server.name} is not connected (${reconnect})`)
  }

  let sent: string | undefined
  const send = async (refused?: string) => {
    const headers = new Headers(forwarded)
    if (oauth) {
      sent = await accessToken(server.id, refused === undefined ? {} : { refused })
      headers.set("Authorization", `Bearer ${sent}`)
    }
    const fixed = staticHeader(server)
    if (fixed) headers.set(fixed[0], fixed[1])
    return mcpFetch(server.url, { method, headers, body, signal: req.signal })
  }

  let res: Response
  try {
    res = await send()
    // An access token the server no longer takes: refresh once, whatever its expiry said.
    if (res.status === 401 && oauth) {
      await res.body?.cancel()
      res = await send(sent)
    }
  } catch (err) {
    if (err instanceof NotConnected) return rpcError(body, `${server.name} needs to be connected again (${reconnect}): ${err.message}`)
    console.warn(`[mcp-gateway] ${server.name} (${server.id}): ${(err as Error).message}`)
    return rpcError(body, `${server.name} could not be reached: ${(err as Error).message}`)
  }
  if (res.status === 401) {
    await res.body?.cancel()
    return rpcError(
      body,
      oauth
        ? `${server.name} refused the connection's credentials (${reconnect})`
        : `${server.name} refused the request (401): ${server.auth === "header" ? "its header is wrong — remove it and declare it again in Settings → MCP servers" : "it now asks for credentials — declare it again in Settings → MCP servers"}`,
    )
  }

  const headers = new Headers()
  for (const h of RESPONSE_HEADERS) {
    const v = res.headers.get(h)
    if (v) headers.set(h, v)
  }
  return new Response(res.body, { status: res.status, headers })
}

export const GET = relay
export const POST = relay
export const DELETE = relay
