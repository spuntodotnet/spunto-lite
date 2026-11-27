import { z } from "zod"
import { getLiteConnectView, LiteConnectError, updateLiteConnect } from "@/services/lite-connect"
import { json, parseBody } from "@/lib/http"
import { LITE_CAPABILITIES } from "@/lib/lite-relay"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Settings → Connect to Spunto (docs/lite-connect.md): the link, the tunnel, never a token. */
export async function GET() {
  return json(getLiteConnectView())
}

const PatchSchema = z.object({
  spuntoUrl: z.string().min(1).max(500).optional(),
  machineName: z.string().max(100).nullable().optional(),
  capabilities: z.array(z.enum(LITE_CAPABILITIES)).optional(),
})

/** The Spunto URL (while disconnected), the machine's name, the capabilities — a change of these redials. */
export async function PATCH(req: Request) {
  const parsed = await parseBody(req, PatchSchema)
  if ("response" in parsed) return parsed.response
  try {
    return json(updateLiteConnect(parsed.data))
  } catch (err) {
    if (err instanceof LiteConnectError) return Response.json({ error: err.message }, { status: err.status })
    throw err
  }
}
