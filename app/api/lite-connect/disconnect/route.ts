import { disconnectLiteConnect } from "@/services/lite-connect"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Gives the refresh token back to Spunto (RFC 7009 revocation: the machine leaves the member's
 * list), then forgets the tokens and closes the tunnel — even when Spunto could not be told
 * (`revoked: false`, the reason in `lastError`).
 */
export async function POST() {
  return json(await disconnectLiteConnect())
}
