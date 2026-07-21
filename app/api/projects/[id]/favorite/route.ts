import { setFavorite } from "@/services/projects"
import { json, parseBody, notFound } from "@/lib/http"
import { z } from "zod"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, z.object({ favorite: z.boolean() }))
  if ("response" in parsed) return parsed.response
  const updated = setFavorite(id, parsed.data.favorite)
  return updated ? json(updated) : notFound("Project not found")
}
