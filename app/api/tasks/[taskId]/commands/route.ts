import { getTask } from "@/services/tasks"
import { listTaskCommands } from "@/services/task-commands"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** What the platform ran for the task — branch setup, the session, accept, drop — oldest first. */
export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  if (!(await getTask(taskId))) return notFound("Task not found")
  return json(await listTaskCommands(taskId))
}
