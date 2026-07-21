import { listWorkersLive, spawnWorker } from "@/services/workers"
import { json, parseBody } from "@/lib/http"
import { z } from "zod"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return json(await listWorkersLive(id))
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, z.object({ name: z.string().optional() }))
  if ("response" in parsed) return parsed.response
  try {
    return json(spawnWorker(id, parsed.data.name), { status: 201 })
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 })
  }
}
