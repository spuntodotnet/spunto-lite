import { deleteTask, getTask, updateTask, serializeTaskDetail } from "@/services/tasks"
import { json, notFound, parseBody } from "@/lib/http"
import { UpdateTaskSchema } from "@/lib/validation"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type Params = { params: Promise<{ taskId: string }> }

/** One task, re-derived from its session, plus `canResume`. */
export async function GET(_req: Request, { params }: Params) {
  const { taskId } = await params
  const task = await getTask(taskId)
  return task ? json(serializeTaskDetail(task)) : notFound("Task not found")
}

/**
 * `{ title?, links?, metadata? }`, in any state: rename (nothing else is renamed — a task has no
 * branch of its own), replace the links as a whole, merge the metadata key by key — a string sets a
 * key, `null` or `""` removes it, an absent key is left alone (docs/taches.md § « Liens et
 * métadonnées »).
 */
export async function PATCH(req: Request, { params }: Params) {
  const { taskId } = await params
  const parsed = await parseBody(req, UpdateTaskSchema)
  if ("response" in parsed) return parsed.response
  try {
    const task = await updateTask(taskId, parsed.data)
    return task ? json(serializeTaskDetail(task)) : notFound("Task not found")
  } catch (err) {
    return taskError(err)
  }
}

/** Forget a finished task and its history. A live one has to be dropped first (409). */
export async function DELETE(_req: Request, { params }: Params) {
  const { taskId } = await params
  try {
    return deleteTask(taskId) ? new Response(null, { status: 204 }) : notFound("Task not found")
  } catch (err) {
    return taskError(err)
  }
}
