import { McpServerError, startConnect } from "@/services/mcp-servers"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Lite's origin as the browser sees it — where the authorization server sends it back. Read from
 * the request, so it is right on `localhost`, on a local domain or behind the HTTPS listener.
 */
function browserOrigin(req: Request): string {
  const url = new URL(req.url)
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? url.protocol.replace(/:$/, "")
  return `${proto}://${host}`
}

/** Starts an OAuth connection: returns the authorization URL to send the browser to. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return json({ url: await startConnect(id, browserOrigin(req)) })
  } catch (err) {
    if (err instanceof McpServerError) return Response.json({ error: err.message }, { status: err.status })
    throw err
  }
}
