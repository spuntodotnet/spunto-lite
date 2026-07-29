import { createService, listServicesLive } from "@/services/services"
import { CreateServiceSchema } from "@/lib/validation"
import { badRequest, json, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  return json(await listServicesLive())
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, CreateServiceSchema)
  if ("response" in parsed) return parsed.response
  try {
    // The container starts in the background (like a worker spawn), so this returns
    // as soon as the spec is persisted — the row's `state` reports the outcome.
    return json(createService(parsed.data), { status: 201 })
  } catch (err) {
    return badRequest((err as Error).message)
  }
}
