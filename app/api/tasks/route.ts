import { listAllTasks, TASK_STATES, type TaskState } from "@/services/tasks"
import { json } from "@/lib/http"
import { metadataFilter, onHoldParam } from "@/lib/task-routes"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Every task of the install, filtered and paged — the agent cockpit's list.
 * `?state=running,in-review&q=login&projectId=…&parentTaskId=…&metadata[key]=value&onHold=true&limit=40&offset=0`.
 * The counts ignore `state`; `metadata[key]` (repeatable) keeps the tasks carrying every given pair;
 * `onHold` picks a side of « On hold » (the default leaves the tasks on hold out) and `onHoldCount`
 * counts them under the same filters. `parentTaskId` lists a task's sub-tasks, on hold or not.
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
  const filter = metadataFilter(url.searchParams)
  if ("response" in filter) return filter.response
  return json(
    await listAllTasks({
      metadata: filter.metadata,
      onHold: onHoldParam(url.searchParams),
      states,
      query: url.searchParams.get("q") ?? undefined,
      projectId: url.searchParams.get("projectId") ?? undefined,
      parentTaskId: url.searchParams.get("parentTaskId") ?? undefined,
      limit: int("limit"),
      offset: int("offset"),
    }),
  )
}
