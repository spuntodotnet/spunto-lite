import { serializeTask, unholdTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Back to review: take a task off hold, without waking its machine. */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await unholdTask(taskId)))
  } catch (err) {
    return taskError(err)
  }
}
