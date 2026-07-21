import { listUserSecrets, setUserSecret } from "@/services/secrets"
import { SecretInputSchema } from "@/lib/validation"
import { json, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  return json(listUserSecrets())
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, SecretInputSchema)
  if ("response" in parsed) return parsed.response
  setUserSecret(parsed.data.name, parsed.data.value)
  return json(listUserSecrets(), { status: 201 })
}
