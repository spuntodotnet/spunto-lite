import { getTask } from "@/services/tasks"
import { ingestTaskEvents, listTaskEvents, listTaskEventsBefore, listTaskEventsTail, taskProtocol, taskUsage } from "@/services/task-events"
import { json, notFound } from "@/lib/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The session, event by event (RFC 0020). Three ways to page: `?since=<seq>` forward (what a
 * poll does), `?tail=true` to open at the end, `?before=<seq>` backwards as the reader scrolls
 * up. Reading is also what ingests. `usage` is computed over the whole task, never the page.
 * `?source=true` adds the harness line each event was read from.
 */
export async function GET(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  const task = await getTask(taskId)
  if (!task) return notFound("Task not found")
  const url = new URL(req.url)
  const int = (key: string, fallback: number) => {
    const n = parseInt(url.searchParams.get(key) ?? "", 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const since = int("since", 0)
  const limit = Math.min(2000, Math.max(1, int("limit", 500)))
  const before = url.searchParams.has("before") ? int("before", 0) : undefined
  const tail = url.searchParams.get("tail") === "true"
  const withSource = url.searchParams.get("source") === "true"

  const protocol = taskProtocol(task.projectId)
  if (protocol !== "none") {
    await ingestTaskEvents(task, protocol).catch((err) => console.warn(`[task:${task.id}] event ingestion failed: ${err}`))
  }
  const { events, hasMore } =
    before !== undefined
      ? listTaskEventsBefore(task.id, before, limit)
      : tail
        ? listTaskEventsTail(task.id, limit)
        : { events: listTaskEvents(task.id, since, limit), hasMore: false }

  return json({
    protocol,
    // The page's own high-water mark: a client that got 500 of 900 must come back for the rest.
    lastSeq: events.length > 0 ? events[events.length - 1].seq : since,
    firstSeq: events.length > 0 ? events[0].seq : null,
    hasMore,
    usage: protocol === "none" ? null : taskUsage(task.id),
    events: events.map((e) => ({
      seq: e.seq,
      ts: e.ts,
      type: e.type,
      payload: e.payload,
      commandId: e.commandId,
      ...(withSource ? { source: e.source } : {}),
    })),
  })
}
