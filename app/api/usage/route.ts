import { safeTimeZone, usageReport, USAGE_PERIODS, type UsagePeriod } from "@/services/usage"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** `?days=1|7|30|90|0` (0 = all time, default 30) · `?tz=` the reader's time zone, for the days. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const asked = Number(params.get("days") ?? 30)
  const days = (USAGE_PERIODS as readonly number[]).includes(asked) ? (asked as UsagePeriod) : 30
  return json(usageReport(days, safeTimeZone(params.get("tz"))))
}
