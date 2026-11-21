"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { TaskConversationList, type TaskState } from "@spunto/design-system/tasks"
import { api } from "@/lib/api"
import { ALL_TASKS_KEY, taskPollInterval, type TasksPage } from "@/lib/task-cache"
import { TaskCockpit } from "@/components/task-cockpit"
import { NewTask, NewTaskButton } from "@/components/new-task"
import { useTaskHoldActions } from "@/hooks/use-task-actions"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/**
 * The agent cockpit: every conversation on the left, the one you picked on the right. It answers
 * the question you actually have — **what are my agents doing, and which one needs me?**
 *
 * Grouped by state in the order a task travels (queued → running → in review, then failed and
 * done), most recently active first inside a group. The selection lives in the URL (`?task=`), so
 * a conversation is linkable and survives a reload. With none picked, the right is a new
 * conversation: the composer, where its session will stream once delegated. On a phone it is one
 * pane at a time: picking a conversation — or "New" (`?new=1`) — pushes it over the list.
 *
 * Tasks on hold (docs/taches.md § « On hold : pour plus tard ») have their own view, `?onHold=1`:
 * in review, their machine parked, kept out of the default list until someone comes back to them.
 */

const PAGE_SIZE = 40

function AgentsCockpit() {
  const router = useRouter()
  const search = useSearchParams()
  const selectedId = search.get("task")
  const composing = search.get("new") === "1"
  const held = search.get("onHold") === "1"
  const isMobile = useIsMobile()

  const [states, setStates] = useState<TaskState[]>([])
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState(PAGE_SIZE)

  const params = new URLSearchParams({ limit: String(limit) })
  if (states.length > 0) params.set("state", states.join(","))
  if (query.trim()) params.set("q", query.trim())
  if (held) params.set("onHold", "true")

  const { data, isLoading } = useQuery({
    queryKey: [...ALL_TASKS_KEY, params.toString()],
    queryFn: () => api.get<TasksPage>(`/api/tasks?${params}`),
    // Slow enough to watch a fleet without hammering it (each live row is a `docker exec`), a
    // second while an accept or a drop is in flight. The conversation on the right polls faster
    // and pushes what it learns into this very cache.
    refetchInterval: (q) => taskPollInterval(q.state.data?.tasks ?? [], 8_000),
    placeholderData: (previous) => previous,
  })

  const holdActions = useTaskHoldActions()
  // Filtered here too, not only by the query: a hold marks the row in the cache on the click, and
  // this is what makes it leave the list on that same frame instead of at the next read.
  const tasks = (data?.tasks ?? []).filter((t) => (t.state === "in-review" && Boolean(t.onHoldAt)) === held)

  const select = (taskId: string | null) => {
    const next = new URLSearchParams(search.toString())
    next.delete("new")
    if (taskId) next.set("task", taskId)
    else next.delete("task")
    const qs = next.toString()
    router.replace(`/agents${qs ? `?${qs}` : ""}`, { scroll: false })
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      <TaskConversationList
        className={cn("w-full shrink-0 lg:w-80 lg:border-r lg:border-border", composing && !selectedId && "max-lg:hidden")}
        tasks={tasks}
        total={data?.total}
        counts={data?.counts}
        loading={isLoading}
        selectedId={selectedId}
        onSelect={(task) => select(task.id)}
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          setLimit(PAGE_SIZE)
        }}
        states={states}
        onStatesChange={(value) => {
          setStates(value)
          setLimit(PAGE_SIZE)
        }}
        onLoadMore={() => setLimit((n) => n + PAGE_SIZE)}
        pageSize={PAGE_SIZE}
        held={held}
        onHeldChange={(value) => {
          const next = new URLSearchParams(search.toString())
          if (value) next.set("onHold", "1")
          else next.delete("onHold")
          setStates([])
          setLimit(PAGE_SIZE)
          router.replace(`/agents?${next}`, { scroll: false })
        }}
        heldCount={data?.onHoldCount}
        onHoldChange={holdActions.setOnHold}
        // Delegating from here is the point: it opens on the right, where the conversation will
        // stream, and asks which project.
        action={<NewTaskButton label="New" />}
      />
      {selectedId ? (
        // Keyed: switching conversation resets the stream, the pending message, the tab.
        <TaskCockpit key={selectedId} taskId={selectedId} onBack={() => select(null)} />
      ) : (
        // Nothing picked: a new conversation. It asks which project, since this screen has none in
        // scope — and the conversation it starts is selected straight away, so the composer gives
        // way to its cockpit in the same pane.
        <div className={cn("min-h-0 min-w-0 flex-1 flex-col", composing ? "flex" : "hidden lg:flex")}>
          <NewTask
            // Back only where the list is out of sight.
            onBack={isMobile ? () => select(null) : undefined}
            onCreated={(task) => {
              setStates([])
              setQuery("")
              select(task.id)
            }}
          />
        </div>
      )}
    </div>
  )
}

export default function AgentsPage() {
  // `useSearchParams` needs a Suspense boundary to prerender.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <AgentsCockpit />
    </Suspense>
  )
}
