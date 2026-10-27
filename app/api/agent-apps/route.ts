import { listAgentApps } from "@/lib/agent-apps"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"

/**
 * The agent apps a project can run its tasks under (RFC 0048), each with its catalog — the models
 * and the app's own parameters. Cloud's `GET …/integrations/agents`, minus `installed`: Lite offers
 * both builtins without an installation step.
 */
export async function GET() {
  return json(listAgentApps())
}
