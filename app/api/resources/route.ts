import { getResourcesOverview, startResourcesRefresher } from "@/services/resources"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  // Started with the server (server.ts); idempotent, so a process that skipped it still measures.
  startResourcesRefresher()
  return json(await getResourcesOverview())
}
