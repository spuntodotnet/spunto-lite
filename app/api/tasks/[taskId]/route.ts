import { deleteTask, getTask, renameTask, serializeTaskDetail } from "@/services/tasks"
import { json, notFound, parseBody } from "@/lib/http"
import { RenameTaskSchema } from "@/lib/validation"
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

/** Rename, in any state: `{ title }`. The branch keeps the name it was created with. */
export async function PATCH(req: Request, { params }: Params) {
  const { taskId } = await params
  const parsed = await parseBody(req, RenameTaskSchema)
  if ("response" in parsed) return parsed.response
  const task = await renameTask(taskId, parsed.data.title)
  return task ? json(serializeTaskDetail(task)) : notFound("Task not found")
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
