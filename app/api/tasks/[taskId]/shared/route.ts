import { getRawTask } from "@/services/tasks"
import { taskShared } from "@/services/task-shared"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * What circulated in the conversation (docs/taches.md § « Ce qui a circulé dans la conversation »):
 * every http(s) link written in a message, either side, outside fenced code — deduplicated on its
 * URL, newest first — and every file attached to or shown in it, without the bytes. Derived from
 * the stored events at each read, never stored; reading it ingests nothing (the stream's poll does).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  if (!getRawTask(taskId)) return notFound("Task not found")
  return json(taskShared(taskId))
}
