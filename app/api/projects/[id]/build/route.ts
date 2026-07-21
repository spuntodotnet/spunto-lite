import { triggerBuild } from "@/services/workers"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return triggerBuild(id) ? json({ ok: true }, { status: 202 }) : notFound("Project not found")
}
