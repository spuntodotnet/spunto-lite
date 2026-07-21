import { deleteUserSecret } from "@/services/secrets"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  deleteUserSecret(id)
  return new Response(null, { status: 204 })
}
