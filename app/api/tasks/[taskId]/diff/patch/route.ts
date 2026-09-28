import { getTask } from "@/services/tasks"
import { taskFilePatch } from "@/services/task-diff"
import { badRequest, json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** One file's patch: `?path=&repo=&oldPath=&untracked=true`. */
export async function GET(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const task = await getTask(taskId)
  if (!task) return notFound("Task not found")
  const url = new URL(req.url)
  const path = url.searchParams.get("path")
  if (!path) return badRequest("`path` is required")
  return json(
    await taskFilePatch(task, {
      path,
      repo: url.searchParams.get("repo") ?? undefined,
      oldPath: url.searchParams.get("oldPath"),
      untracked: url.searchParams.get("untracked") === "true",
    }),
  )
}
