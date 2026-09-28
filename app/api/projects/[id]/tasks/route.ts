import { createTask, listProjectTasks, serializeTask } from "@/services/tasks"
import { getProjectRow } from "@/services/projects"
import { json, notFound, parseBody } from "@/lib/http"
import { CreateTaskSchema } from "@/lib/validation"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** A project's tasks, most recently active first. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!getProjectRow(id)) return notFound("Project not found")
  return json((await listProjectTasks(id)).map(serializeTask))
}

/**
 * Delegate: `{ prompt, title?, baseBranch?, model?, files? }`. Answers at once with the task
 * `queued`; allocating a worker, creating the branch and starting the session happen after.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsed = await parseBody(req, CreateTaskSchema)
  if ("response" in parsed) return parsed.response
  try {
    return json(serializeTask(createTask(id, parsed.data)), { status: 201 })
  } catch (err) {
    return taskError(err)
  }
}
