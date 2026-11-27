import { McpServerError, startConnect } from "@/services/mcp-servers"
import { browserOrigin, json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

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
