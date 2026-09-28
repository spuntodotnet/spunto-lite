"use client"

import { Suspense, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { TaskConversationList, TaskConversationPlaceholder, type TaskState } from "@spunto/design-system/tasks"
import { api } from "@/lib/api"
import { ALL_TASKS_KEY, taskPollInterval, type TasksPage } from "@/lib/task-cache"
import { TaskCockpit } from "@/components/task-cockpit"
import { NewTaskButton } from "@/components/new-task-button"

/**
 * The agent cockpit: every conversation on the left, the one you picked on the right. It answers
 * the question you actually have — **what are my agents doing, and which one needs me?**
 *
 * Grouped by state in the order a task travels (queued → running → in review, then failed and
 * done), most recently active first inside a group. The selection lives in the URL (`?task=`), so
 * a conversation is linkable and survives a reload. On a phone it is one pane at a time: picking a
 * conversation pushes it over the list, full screen.
 */

const PAGE_SIZE = 40

function AgentsCockpit() {
  const router = useRouter()
  const search = useSearchParams()
  const selectedId = search.get("task")

  const [states, setStates] = useState<TaskState[]>([])
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState(PAGE_SIZE)

  const params = new URLSearchParams({ limit: String(limit) })
  if (states.length > 0) params.set("state", states.join(","))
  if (query.trim()) params.set("q", query.trim())

  const { data, isLoading } = useQuery({
    queryKey: [...ALL_TASKS_KEY, params.toString()],
    queryFn: () => api.get<TasksPage>(`/api/tasks?${params}`),
    // Slow enough to watch a fleet without hammering it (each live row is a `docker exec`), a
    // second while an accept or a drop is in flight. The conversation on the right polls faster
    // and pushes what it learns into this very cache.
    refetchInterval: (q) => taskPollInterval(q.state.data?.tasks ?? [], 8_000),
    placeholderData: (previous) => previous,
  })

  const select = (taskId: string | null) => {
    const next = new URLSearchParams(search.toString())
    if (taskId) next.set("task", taskId)
    else next.delete("task")
    const qs = next.toString()
    router.replace(`/agents${qs ? `?${qs}` : ""}`, { scroll: false })
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      <TaskConversationList
        className="w-full shrink-0 lg:w-80 lg:border-r lg:border-border"
        tasks={data?.tasks ?? []}
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
        // Delegating from here is the point: the dialog asks which project, and the new
        // conversation opens straight away rather than being left to be found in the list.
        action={
          <NewTaskButton
            label="New"
            onCreated={(task) => {
              setStates([])
              setQuery("")
              select(task.id)
            }}
          />
        }
      />
      {selectedId ? (
        // Keyed: switching conversation resets the stream, the pending message, the tab.
        <TaskCockpit key={selectedId} taskId={selectedId} onBack={() => select(null)} />
      ) : (
        <TaskConversationPlaceholder className="hidden lg:flex">
          Every task is on the left, whichever project it belongs to — the ones waiting on you first. Or{" "}
          <Link href="/projects" className="text-primary hover:underline">
            open a project
          </Link>{" "}
          to delegate new work.
        </TaskConversationPlaceholder>
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
