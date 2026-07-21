import { listBuilds } from "@/services/workers"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return json(listBuilds(id))
}
