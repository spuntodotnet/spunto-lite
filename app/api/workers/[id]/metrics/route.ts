import { getWorkerRow } from "@/services/workers"
import { isMetricRange, workerMetrics } from "@/services/worker-metrics"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * A worker's CPU and memory history, `?range=1h|6h|24h|7d` (default `1h`), averaged per bucket
 * (1 min, 5 min, 15 min, 1 h): what Lite sampled itself every 30 s (services/worker-metrics.ts).
 * `available` is always true — the field is Cloud's, where the samples live in a backend that may
 * be unreachable; it keeps the two answers the same shape.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!getWorkerRow(id)) return notFound("Worker not found")
  const asked = new URL(req.url).searchParams.get("range")
  const range = isMetricRange(asked) ? asked : "1h"
  return json({ available: true, range, points: workerMetrics(id, range) })
}
