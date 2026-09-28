import { validateTask, serializeTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Accept the work (in review only). Runs the project's accept command if it has one; exit 0 ⇒ done. */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await validateTask(taskId)), { status: 202 })
  } catch (err) {
    return taskError(err)
  }
}
