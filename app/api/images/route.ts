import { AVAILABLE_IMAGES } from "@/lib/catalogs"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"

export async function GET() {
  return json(AVAILABLE_IMAGES)
}
