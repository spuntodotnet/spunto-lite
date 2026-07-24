import { getResourcesOverview } from "@/services/resources"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  return json(await getResourcesOverview())
}
