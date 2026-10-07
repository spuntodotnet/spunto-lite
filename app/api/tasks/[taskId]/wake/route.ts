import { wakeTask, serializeTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Start the parked machine of a task in review, without doing anything else in it. */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await wakeTask(taskId)))
  } catch (err) {
    return taskError(err)
  }
}
