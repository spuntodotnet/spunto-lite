import { retryTask, serializeTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Start a failed task over, from the top — one whose session never started (`retryBlocker`); 409 otherwise. */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await retryTask(taskId)), { status: 202 })
  } catch (err) {
    return taskError(err)
  }
}
