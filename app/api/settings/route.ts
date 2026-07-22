import { getSettingsView, updateSettings, normalizeGcpKey } from "@/services/settings"
import { SettingsSchema } from "@/lib/validation"
import { json, parseBody, badRequest } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  return json(getSettingsView())
}

export async function PATCH(req: Request) {
  const parsed = await parseBody(req, SettingsSchema)
  if ("response" in parsed) return parsed.response
  const { gcpRegistryKey } = parsed.data
  // Reject a non-empty key that is neither raw JSON nor base64 JSON, so the user
  // gets immediate feedback instead of a silently-ignored (cleared) credential.
  if (typeof gcpRegistryKey === "string" && gcpRegistryKey.trim() && normalizeGcpKey(gcpRegistryKey) === null) {
    return badRequest("Invalid GCP service-account key — expected the JSON key file or its base64 encoding")
  }
  return json(updateSettings(parsed.data))
}
