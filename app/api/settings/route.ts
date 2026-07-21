import { getSettings, updateSettings } from "@/services/settings"
import { SettingsSchema } from "@/lib/validation"
import { json, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  return json(getSettings())
}

export async function PATCH(req: Request) {
  const parsed = await parseBody(req, SettingsSchema)
  if ("response" in parsed) return parsed.response
  return json(updateSettings(parsed.data))
}
