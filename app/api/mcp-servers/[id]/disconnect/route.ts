import { disconnect } from "@/services/mcp-servers"
import { notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Forgets the connection's tokens. Effective at the gateway's next call. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return disconnect(id) ? new Response(null, { status: 204 }) : notFound()
}
