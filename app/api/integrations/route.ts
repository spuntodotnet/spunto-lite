import { z } from "zod"
import { connect, IntegrationError, integrationOffers, listConnections } from "@/services/integrations"
import { json, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Integrations (docs/integrations.md): the forges Lite can connect, and the accounts connected. */
export async function GET() {
  return json({ offers: integrationOffers(), connections: listConnections() })
}

const ConnectSchema = z.object({
  kind: z.enum(["github", "gitlab"]),
  /** Absent: the public instance (github.com, gitlab.com). */
  host: z.string().max(300).optional(),
  token: z.string().min(1).max(1000),
})

/** Saves a token once the forge said whose it is. 400 when it refuses it — nothing is saved then. */
export async function POST(req: Request) {
  const parsed = await parseBody(req, ConnectSchema)
  if ("response" in parsed) return parsed.response
  try {
    return json(await connect(parsed.data), { status: 201 })
  } catch (err) {
    if (err instanceof IntegrationError) return Response.json({ error: err.message }, { status: err.status === 404 ? 400 : err.status })
    throw err
  }
}
