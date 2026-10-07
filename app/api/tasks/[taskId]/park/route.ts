import { parkTask, serializeTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Park the machine of a task in review: the container stops, its disk is kept, the task still holds it. */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await parkTask(taskId)))
  } catch (err) {
    return taskError(err)
  }
}
