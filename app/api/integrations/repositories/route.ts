import { listRepositories } from "@/services/integrations"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The repositories the connected forges reach, for the project form's picker — each with the SSH
 * URL the project will store (docs/integrations.md § « Choisir un dépôt »).
 */
export async function GET() {
  return json(await listRepositories())
}
