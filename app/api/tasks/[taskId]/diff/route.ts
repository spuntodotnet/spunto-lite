import { getTask } from "@/services/tasks"
import { taskDiff } from "@/services/task-diff"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** What the task changed since its base, read with git in its own worker — files and totals, per repository. */
export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const task = await getTask(taskId)
  if (!task) return notFound("Task not found")
  return json(await taskDiff(task))
}
