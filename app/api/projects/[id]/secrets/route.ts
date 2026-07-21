import { listProjectSecrets, setProjectSecret } from "@/services/secrets"
import { SecretInputSchema } from "@/lib/validation"
import { json, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return json(listProjectSecrets(id))
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, SecretInputSchema)
  if ("response" in parsed) return parsed.response
  setProjectSecret(id, parsed.data.name, parsed.data.value)
  return json(listProjectSecrets(id), { status: 201 })
}
