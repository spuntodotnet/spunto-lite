import { answerTask, serializeTask } from "@/services/tasks"
import { json, parseBody } from "@/lib/http"
import { TaskAnswerSchema } from "@/lib/validation"
import { taskError } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Answer a question the agent is waiting on (`pendingQuestion`, a `question` event): `{ callId,
 * answers: [{ question, selected, text? }] }`, handed to the live session (202). 409 when nothing
 * waits on that `callId` any more, or the session is gone. A plain reply answers too, in words.
 */
export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const parsed = await parseBody(req, TaskAnswerSchema)
  if ("response" in parsed) return parsed.response
  try {
    return json(serializeTask(await answerTask(taskId, parsed.data.callId, parsed.data.answers)), { status: 202 })
  } catch (err) {
    return taskError(err)
  }
}
