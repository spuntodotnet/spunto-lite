import { getRawTask } from "@/services/tasks"
import { taskTiles } from "@/services/task-shared"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The extra blocks of a task's details, in the design system's tile vocabulary (`TaskAppTile`):
 * Claude Code's own view of its session (quota, MCP servers, skills, cost per model…), read from
 * its lines, and the pull requests among the shared links — with where each stands when its forge
 * is connected in Settings → Integrations (docs/integrations.md).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const task = getRawTask(taskId)
  if (!task) return notFound("Task not found")
  return json(await taskTiles(task))
}
