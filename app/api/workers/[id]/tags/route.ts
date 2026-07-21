import { setWorkerTags } from "@/services/workers"
import { json, parseBody, notFound } from "@/lib/http"
import { z } from "zod"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, z.object({ tags: z.array(z.string()) }))
  if ("response" in parsed) return parsed.response
  const w = setWorkerTags(id, parsed.data.tags)
  return w ? json(w) : notFound("Worker not found")
}
