import { restartService } from "@/services/services"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const s = await restartService(id)
  return s ? json(s) : notFound("Service not found")
}
