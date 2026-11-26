import { z } from "zod"
import { getWorkerRow } from "@/services/workers"
import { gitCredentialFor } from "@/services/integrations"
import { workerOfGitCredentialToken } from "@/lib/git-credential"
import { parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const CredentialRequest = z.object({
  protocol: z.enum(["https", "http"]),
  /** As git gives it: `gitlab.example.com`, or `host:8443` with a port. */
  host: z.string().regex(/^[A-Za-z0-9.-]+(?::\d{1,5})?$/),
})

/**
 * A worker's git credential helper asking for the host it is about to talk to
 * (lib/git-credential.ts, docs/integrations.md). Answers the token of the connection for that
 * exact origin, and nothing for any other host. 401 without a worker's token, 404 when Lite has
 * nothing for the host — the helper is silent either way, and git goes on as it would have.
 */
export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
  const workerId = workerOfGitCredentialToken(token)
  if (!workerId || !getWorkerRow(workerId)) return Response.json({ error: "Not a worker of this Lite" }, { status: 401 })
  const parsed = await parseBody(req, CredentialRequest)
  if ("response" in parsed) return parsed.response
  const origin = `${parsed.data.protocol}://${parsed.data.host.toLowerCase()}`
  const credential = gitCredentialFor(origin)
  if (!credential) return Response.json({ error: `No integration for ${origin} (Settings → Integrations)` }, { status: 404 })
  return Response.json(credential)
}
