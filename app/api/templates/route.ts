import { TEMPLATES } from "@/lib/templates"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"

export async function GET() {
  return json(TEMPLATES)
}
