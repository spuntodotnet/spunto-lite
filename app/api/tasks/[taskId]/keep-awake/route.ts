import { keepTaskAwake, serializeTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Cancel the park review mode `stop` scheduled for a task in review (its `parkAt`, set when the
 * project parks after `taskReviewParkAfterMinutes`): the machine stays awake for the rest of this
 * review. 409 unless the task is `in-review` with a park scheduled.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await keepTaskAwake(taskId)))
  } catch (err) {
    return taskError(err)
  }
}
