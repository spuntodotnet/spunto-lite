import { SUGGESTED_EXTENSIONS } from "@/lib/catalogs"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"

export async function GET() {
  return json(SUGGESTED_EXTENSIONS)
}
