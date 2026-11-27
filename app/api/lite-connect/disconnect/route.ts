import { disconnectLiteConnect } from "@/services/lite-connect"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Forgets the tokens and closes the tunnel. Spunto keeps listing the Lite, offline, until removed there. */
export async function POST() {
  return json(disconnectLiteConnect())
}
