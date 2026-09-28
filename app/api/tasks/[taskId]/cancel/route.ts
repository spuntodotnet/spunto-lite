import { cancelTask, serializeTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Drop the task: kill the session, run the project's cleanup, mark it failed with the reason. */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await cancelTask(taskId)), { status: 202 })
  } catch (err) {
    return taskError(err)
  }
}
