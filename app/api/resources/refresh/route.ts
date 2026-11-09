import { getResourcesOverview, measureVolumeSizesNow } from "@/services/resources"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Measure volume sizes now rather than at the next background pass. Answers at once with the
 * overview, `freshness.sizesMeasuringSince` set: the walk can take minutes, the page polls.
 */
export async function POST() {
  void measureVolumeSizesNow()
  return json(await getResourcesOverview(), { status: 202 })
}
