import { lifecycleStats, STATISTICS_RANGES, type StatisticsRange } from "@/services/statistics"
import { badRequest, json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Settings → Statistics: how long workers take to be usable, and where the time goes —
 * `?range=24h|7d|30d|90d` (default 30d) `&projectId=`. Read from what Lite keeps of each start and
 * each image build (services/statistics.ts).
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const range = (url.searchParams.get("range") || "30d") as StatisticsRange
  if (!(STATISTICS_RANGES as readonly string[]).includes(range)) return badRequest(`range is one of ${STATISTICS_RANGES.join(", ")}`)
  return json(lifecycleStats(range, url.searchParams.get("projectId") || null))
}
