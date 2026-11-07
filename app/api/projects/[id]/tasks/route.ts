import { createTask, listProjectTasks, serializeTask } from "@/services/tasks"
import { getProjectRow } from "@/services/projects"
import { json, notFound, parseBody } from "@/lib/http"
import { CreateTaskSchema } from "@/lib/validation"
import { metadataFilter, taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** A project's tasks, most recently active first. `?metadata[key]=value` keeps those carrying every pair. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!getProjectRow(id)) return notFound("Project not found")
  const filter = metadataFilter(new URL(req.url).searchParams)
  if ("response" in filter) return filter.response
  return json((await listProjectTasks(id, 100, filter.metadata)).map(serializeTask))
}

/**
 * Delegate: `{ prompt, title?, baseBranch?, model?, agentAppId?, agentOptions?, files?, links?, metadata? }`. Answers at once with the task
 * `queued`; allocating a worker (resetting it, if recycled) and starting the session happen after
 * — no branch: the agent makes one if it wants one (RFC 0056).
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
