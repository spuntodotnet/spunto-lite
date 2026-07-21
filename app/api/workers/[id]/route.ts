import { getWorkerLive, deleteWorker } from "@/services/workers"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = await getWorkerLive(id)
  return w ? json(w) : notFound("Worker not found")
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await deleteWorker(id)
  return new Response(null, { status: 204 })
}
