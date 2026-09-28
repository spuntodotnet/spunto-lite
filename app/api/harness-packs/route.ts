import { HARNESS_PACKS } from "@/lib/harness-packs"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"

/** The harnesses a project can pick with one click — see `lib/harness-packs.ts`. */
export async function GET() {
  return json(HARNESS_PACKS)
}
