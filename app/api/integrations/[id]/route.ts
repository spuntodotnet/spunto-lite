import { disconnect } from "@/services/integrations"
import { notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Forgets a saved token. A connection from the environment (`env:…`) is not one: 404. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return disconnect(id) ? new Response(null, { status: 204 }) : notFound("No saved connection with this id")
}
