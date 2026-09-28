import { interruptTask, serializeTask } from "@/services/tasks"
import { json } from "@/lib/http"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Stop the current turn without killing the session (interactive harness only). */
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return json(serializeTask(await interruptTask(taskId)), { status: 202 })
  } catch (err) {
    return taskError(err)
  }
}
