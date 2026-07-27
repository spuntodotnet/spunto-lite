import { getSearchIndex } from "@/services/search"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The ⌘K palette's index. Returns everything searchable in one shot (see
 * `services/search.ts` for why it isn't a `?q=` endpoint) — cheap enough to
 * re-fetch on every open.
 */
export async function GET() {
  return json(getSearchIndex())
}
