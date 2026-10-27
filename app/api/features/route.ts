import { AVAILABLE_FEATURES } from "@/lib/catalogs"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"

/**
 * The features a project can pick. An agent app's feature (`injected`) is left out: it comes with
 * the app switched on in *Delegated work* (RFC 0048), never from the picker.
 */
const PICKABLE_FEATURES = AVAILABLE_FEATURES.filter((f) => !f.injected)

export async function GET() {
  return json(PICKABLE_FEATURES)
}
