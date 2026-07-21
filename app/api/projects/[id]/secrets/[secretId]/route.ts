import { deleteProjectSecret } from "@/services/secrets"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; secretId: string }> }) {
  const { id, secretId } = await params
  deleteProjectSecret(id, secretId)
  return new Response(null, { status: 204 })
}
