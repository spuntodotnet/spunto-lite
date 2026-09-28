import { listAllTasks, TASK_STATES, type TaskState } from "@/services/tasks"
import { json } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Every task of the install, filtered and paged — the agent cockpit's list.
 * `?state=running,in-review&q=login&projectId=…&limit=40&offset=0`. The counts ignore `state`.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const states = (url.searchParams.get("state") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is TaskState => (TASK_STATES as readonly string[]).includes(s))
  const int = (key: string) => {
    const n = parseInt(url.searchParams.get(key) ?? "", 10)
    return Number.isFinite(n) ? n : undefined
  }
  return json(
    await listAllTasks({
      states,
      query: url.searchParams.get("q") ?? undefined,
      projectId: url.searchParams.get("projectId") ?? undefined,
      limit: int("limit"),
      offset: int("offset"),
    }),
  )
}
