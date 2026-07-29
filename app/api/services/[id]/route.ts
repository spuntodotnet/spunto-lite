import { deleteService, getServiceLive, updateService } from "@/services/services"
import { UpdateServiceSchema } from "@/lib/validation"
import { badRequest, json, notFound, parseBody } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const s = await getServiceLive(id)
  return s ? json(s) : notFound("Service not found")
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, UpdateServiceSchema)
  if ("response" in parsed) return parsed.response
  try {
    const s = await updateService(id, parsed.data)
    return s ? json(s) : notFound("Service not found")
  } catch (err) {
    return badRequest((err as Error).message)
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await deleteService(id)
  return new Response(null, { status: 204 })
}
