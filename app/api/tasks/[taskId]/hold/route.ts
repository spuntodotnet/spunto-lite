import { holdTask, serializeTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** On hold: park the machine of a task in review and set it aside, out of the default lists. */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await holdTask(taskId)))
  } catch (err) {
    return taskError(err)
  }
}
