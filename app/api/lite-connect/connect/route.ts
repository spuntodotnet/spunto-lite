import { LiteConnectError, startLiteConnect } from "@/services/lite-connect"
import { browserOrigin, json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Starts the pairing: registers this Lite at Spunto if needed, returns the consent page's URL. */
export async function POST(req: Request) {
  try {
    return json({ url: await startLiteConnect(browserOrigin(req)) })
  } catch (err) {
    if (err instanceof LiteConnectError) return Response.json({ error: err.message }, { status: err.status })
    throw err
  }
}
