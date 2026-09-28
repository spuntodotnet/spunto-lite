import { followUpTask, serializeTask } from "@/services/tasks"
import { json, parseBody } from "@/lib/http"
import { TaskMessageSchema } from "@/lib/validation"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Talk to the session: `{ prompt, files? }`. An interactive session that is still alive gets it
 * on its stdin straight away, even mid-turn; otherwise a new turn resumes it (202).
 */
export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const parsed = await parseBody(req, TaskMessageSchema)
  if ("response" in parsed) return parsed.response
  try {
    return json(serializeTask(await followUpTask(taskId, parsed.data.prompt, parsed.data.files ?? [])), { status: 202 })
  } catch (err) {
    return taskError(err)
  }
}
