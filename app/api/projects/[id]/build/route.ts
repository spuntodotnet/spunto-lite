import { triggerBuild } from "@/services/workers"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // `?force=1` turns "pre-build" into "rebuild": without it the build is skipped outright when the
  // image is already there, which is the right default for a pre-build and useless to someone
  // asking for another one. Opt-in because it rebuilds every layer — minutes, and a fresh pull.
  const force = new URL(req.url).searchParams.get("force") === "1"
  return triggerBuild(id, force) ? json({ ok: true }, { status: 202 }) : notFound("Project not found")
}
