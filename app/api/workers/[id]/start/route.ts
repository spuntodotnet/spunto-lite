import { startWorker } from "@/services/workers"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const w = await startWorker(id)
  return w ? json(w) : notFound("Worker not found")
}
