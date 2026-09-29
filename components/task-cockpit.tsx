"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { SquareArrowOutUpRight } from "lucide-react"
import {
  TaskBoot,
  TaskCockpit as TaskCockpitDesktop,
  TaskCockpitMobile,
  TaskComposer,
  TaskDetails,
  TaskDiffPanel,
  TaskEventStream,
  TaskMachine,
  TaskTerminalPanel,
  type PendingMessage,
  type TaskCockpitView,
  type TaskCommand,
  type TaskDiff,
  type TaskDiffFile,
  type TaskEvent,
  type TaskFilePatch,
  type TaskSessionUsageData,
} from "@spunto/design-system/tasks"
import type { WorkerStats } from "@spunto/design-system/workers"
import { api } from "@/lib/api"
import { nextLink } from "@/lib/link-render"
import { patchTaskLists, taskKey, taskPollInterval, type Task } from "@/lib/task-cache"
import { workerBaseUrl } from "@/lib/worker-url"
import type { Worker } from "@/lib/types"
import { useTaskActions } from "@/hooks/use-task-actions"
import { useIsMobile } from "@/hooks/use-mobile"
import { TerminalSessions } from "@/components/terminal-sessions"

/**
 * One conversation with an agent, filling whatever box it is given.
 *
 * Everything it draws comes from `@spunto/design-system/tasks` — the layout (`TaskCockpit`, or
 * `TaskCockpitMobile` on a phone) and every panel in its slots. What stays here is what only Lite
 * knows: its routes, its caches, and how a Lite worker maps onto the package's machine panel.
 *
 * A component rather than a page because it has two homes: its own URL
 * (`/projects/:id/tasks/:taskId`) and the right-hand side of the agent cockpit (`/agents`).
 */

const EVENTS_PAGE_SIZE = 150

type EventsPage = {
  protocol: string
  lastSeq: number
  firstSeq: number | null
  hasMore: boolean
  usage: TaskSessionUsageData | null
  events: TaskEvent[]
}

const fetchEvents = (taskId: string, query: string) => api.get<EventsPage>(`/api/tasks/${taskId}/events?${query}`)

/**
 * The event stream: opened at its **end**, polled forward from there, paged backward on demand.
 * The cursor and the accumulated list live in refs and are merged inside the query function, so
 * the key stays stable and a poll that brings nothing new re-renders nothing.
 */
function useTaskEvents(taskId: string, live: boolean) {
  const queryClient = useQueryClient()
  const queryKey = ["task-events", taskId]
  const cursor = useRef(0)
  const oldestSeq = useRef<number | null>(null)
  const accumulated = useRef<TaskEvent[]>([])
  const opened = useRef(false)
  const loading = useRef(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState(false)

  const { data } = useQuery({
    queryKey,
    queryFn: async () => {
      const page = opened.current
        ? await fetchEvents(taskId, `since=${cursor.current}`)
        : await fetchEvents(taskId, `tail=true&limit=${EVENTS_PAGE_SIZE}`)
      if (!opened.current) {
        opened.current = true
        accumulated.current = page.events
        oldestSeq.current = page.firstSeq
        setHasMore(page.hasMore)
      } else if (page.events.length > 0) {
        accumulated.current = [...accumulated.current, ...page.events]
      }
      cursor.current = Math.max(cursor.current, page.lastSeq)
      return { protocol: page.protocol, usage: page.usage, events: accumulated.current }
    },
    // The part that is supposed to feel alive; nothing left to arrive once the task is terminal.
    refetchInterval: live ? 2_000 : false,
    staleTime: 0,
  })

  const loadOlder = async () => {
    if (oldestSeq.current === null || loading.current) return
    loading.current = true
    setLoadingOlder(true)
    setOlderError(false)
    try {
      const page = await fetchEvents(taskId, `before=${oldestSeq.current}&limit=${EVENTS_PAGE_SIZE}`)
      accumulated.current = [...page.events, ...accumulated.current]
      oldestSeq.current = page.firstSeq ?? oldestSeq.current
      // An empty page that still claims more would be a request loop, not a paginator.
      setHasMore(page.hasMore && page.events.length > 0)
      queryClient.setQueryData(queryKey, (old: { protocol: string; usage: TaskSessionUsageData | null; events: TaskEvent[] } | undefined) =>
        old ? { ...old, events: accumulated.current } : old,
      )
    } catch {
      setOlderError(true)
    } finally {
      loading.current = false
      setLoadingOlder(false)
    }
  }

  return {
    events: data?.events ?? [],
    protocol: data?.protocol ?? "none",
    usage: data?.usage ?? null,
    hasMore,
    loadingOlder,
    olderError,
    loadOlder,
  }
}

/** The diff summary, read only while the Diff tab is open, and the per-file patch loader. */
function useTaskDiff(taskId: string, { open, live }: { open: boolean; live: boolean }) {
  const queryClient = useQueryClient()
  const { data, isLoading, isFetching, refetch } = useQuery<TaskDiff>({
    queryKey: ["task-diff", taskId],
    enabled: open,
    refetchInterval: open && live ? 30_000 : false,
    queryFn: () => api.get<TaskDiff>(`/api/tasks/${taskId}/diff`),
  })
  const loadPatch = useCallback(
    ({ repo, file }: { repo: string; file: TaskDiffFile }) =>
      queryClient.fetchQuery<TaskFilePatch>({
        queryKey: ["task-patch", taskId, repo, file.path],
        staleTime: 30_000,
        queryFn: () => {
          const query = new URLSearchParams({ path: file.path })
          if (repo) query.set("repo", repo)
          if (file.oldPath) query.set("oldPath", file.oldPath)
          if (file.status === "untracked") query.set("untracked", "true")
          return api.get<TaskFilePatch>(`/api/tasks/${taskId}/diff/patch?${query}`)
        },
      }),
    [queryClient, taskId],
  )
  return { data, isLoading, isFetching, refetch: () => void refetch(), loadPatch }
}

/**
 * The machine behind the task. A Lite worker has no separate Docker state, so the package's
 * `dockerState` is read off its state: a container exists and is not stopped.
 */
function useTaskMachine(task: Task | undefined) {
  const workerId = task?.workerId ?? null
  const booting = task?.state === "queued"
  const live = booting || task?.state === "running" || task?.state === "in-review"
  const { data: worker = null } = useQuery({
    queryKey: ["worker", workerId],
    queryFn: () => api.get<Worker>(`/api/workers/${workerId}`),
    enabled: !!workerId,
    refetchInterval: workerId && live ? (booting || task?.pendingAction ? 2_000 : 10_000) : false,
  })
  const running = !!worker?.containerId && worker.state !== "stopped" && worker.state !== "error"
  const { data: stats = null } = useQuery({
    queryKey: ["worker-stats", workerId],
    queryFn: () => api.get<WorkerStats | null>(`/api/workers/${workerId}/stats`),
    enabled: !!workerId && running && live,
    refetchInterval: 3_000,
  })
  const { data: ports = [] } = useQuery({
    queryKey: ["worker-ports", workerId],
    queryFn: () => api.get<number[]>(`/api/workers/${workerId}/ports`),
    enabled: !!workerId && running && live,
    refetchInterval: 10_000,
  })
  return {
    worker: worker
      ? {
          ...worker,
          dockerState: running ? "running" : "stopped",
          // The package tells "recycled from the pool" from "spawned for this task" by comparing
          // dates. A Lite worker's `createdAt` is stored to the second, so a worker spawned 200 ms
          // after its task reads as *older* than it; the real instant is anywhere in that second,
          // so it is read as the end of it.
          createdAt: new Date(new Date(worker.createdAt).getTime() + 999).toISOString(),
        }
      : null,
    stats: running && live ? stats : null,
    // The editor and SSH are the package's to filter; everything else is something the agent started.
    ports: running && live ? ports.map((port) => ({ port })) : [],
    running,
  }
}

/**
 * Push what the conversation just read into the lists that also hold this task, guarded on the
 * facts a row draws so an unchanged poll writes nothing.
 */
function usePublishTask(task: Task | undefined) {
  const queryClient = useQueryClient()
  const signature = task
    ? [task.state, task.pendingAction, task.pendingSince, task.lastActivityAt, task.title, task.error, task.workerId].join("|")
    : null
  const published = useRef<string | null>(null)
  useEffect(() => {
    if (!task || signature === null || published.current === signature) return
    published.current = signature
    patchTaskLists(queryClient, task.id, task)
  }, [queryClient, task, signature])
}

export function TaskCockpit({
  taskId,
  backHref,
  onBack,
}: {
  taskId: string
  /** A back arrow in the top bar. Omitted when the cockpit sits next to its own list. */
  backHref?: string
  /** Phone: how to go back when there is no URL to go back *to* (the agent cockpit's own list). */
  onBack?: () => void
}) {
  const isMobile = useIsMobile()
  const { data: task, isLoading } = useQuery({
    queryKey: taskKey(taskId),
    queryFn: () => api.get<Task>(`/api/tasks/${taskId}`),
    // A second while an action is in flight, three while live, nothing once finished.
    refetchInterval: (q) => taskPollInterval(q.state.data ? [q.state.data] : [], 3_000, false),
    retry: false,
  })
  const poll = taskPollInterval(task ? [task] : [], 3_000, false)
  const { data: commands = [] } = useQuery({
    queryKey: ["task-commands", taskId],
    queryFn: () => api.get<TaskCommand[]>(`/api/tasks/${taskId}/commands`),
    refetchInterval: poll,
  })
  usePublishTask(task)

  const live = task?.state === "queued" || task?.state === "running" || task?.state === "in-review"
  const stream = useTaskEvents(taskId, !!live)
  const machine = useTaskMachine(task)
  const [view, setView] = useState<TaskCockpitView>("session")
  const diff = useTaskDiff(taskId, { open: view === "diff", live: !!live })
  const actions = useTaskActions(taskId, task)

  // What was just sent, drawn before the round trip comes back; the composer hands its thumbnails'
  // object URLs over with it, released when the next turn replaces them.
  const [pending, setPending] = useState<PendingMessage | null>(null)
  const previews = useRef<string[]>([])
  const showPending = useCallback((next: PendingMessage) => {
    previews.current.forEach((url) => URL.revokeObjectURL(url))
    previews.current = next.previews ?? []
    setPending(next)
  }, [])
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), [])

  const worker = machine.worker
  const editorHref = worker && machine.running ? workerBaseUrl(worker.id) : undefined
  const Cockpit = isMobile ? TaskCockpitMobile : TaskCockpitDesktop
  const attachmentUrl = (attachmentId: string) => `/api/tasks/${taskId}/attachments/${attachmentId}`

  return (
    <Cockpit
      task={task}
      loading={isLoading}
      pendingAction={actions.pendingAction}
      pendingSince={actions.pendingSince}
      onAccept={actions.accept}
      onDrop={actions.drop}
      onTitleChange={actions.rename}
      titleUpdating={actions.renaming}
      backHref={backHref}
      onBack={onBack}
      render={{ link: nextLink }}
      view={view}
      onViewChange={setView}
      session={(tabs) => (
        <TaskEventStream
          key={taskId}
          tabs={tabs}
          events={stream.events}
          protocol={stream.protocol}
          attachmentUrl={attachmentUrl}
          live={!!live}
          hasMore={stream.hasMore}
          loadingOlder={stream.loadingOlder}
          olderError={stream.olderError}
          onLoadOlder={stream.loadOlder}
          pending={actions.replyFailed ? null : pending}
          // No session yet is not an empty stream, it is a machine being built.
          emptyState={task && !task.startedAt ? <TaskBoot task={task} worker={worker} commands={commands} /> : undefined}
        />
      )}
      diff={(tabs) => (
        <TaskDiffPanel
          tabs={tabs}
          diff={diff.data}
          loading={diff.isLoading}
          fetching={diff.isFetching}
          onRefresh={diff.refetch}
          loadPatch={diff.loadPatch}
        />
      )}
      // The same persistent dtach sessions as the worker page: a shell opened here is still there
      // there, and the agent's own session is never one of them. No machine, no tab.
      terminal={
        worker
          ? (tabs) => (
              <TaskTerminalPanel
                tabs={tabs}
                actions={
                  <Link
                    href={`/projects/${worker.projectId}/workers/${worker.id}`}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Worker <SquareArrowOutUpRight className="h-3 w-3" />
                  </Link>
                }
              >
                {/* Nothing rather than `false`: the panel's placeholder says why there is no shell. */}
                {machine.running ? <TerminalSessions workerId={worker.id} enabled /> : undefined}
              </TaskTerminalPanel>
            )
          : undefined
      }
      composer={
        task && (
          <TaskComposer
            layout={isMobile ? "compact" : "default"}
            state={task.state}
            canResume={task.canResume}
            protocol={stream.protocol}
            pending={actions.pendingAction === "replying"}
            pendingAction={actions.pendingAction}
            onInterrupt={actions.interrupt}
            error={actions.replyError}
            onSubmit={(prompt, files) => {
              showPending({
                text: prompt,
                sinceSeq: stream.events.length > 0 ? stream.events[stream.events.length - 1].seq : 0,
                previews: files.map((f) => f.previewUrl).filter((u): u is string => u !== null),
              })
              actions.reply(
                prompt,
                files.map(({ name, mediaType, data }) => ({ filename: name, mediaType, data })),
              )
            }}
          />
        )
      }
      details={
        task && (
          <TaskDetails
            variant={isMobile ? "sheet" : "sidebar"}
            task={task}
            usage={stream.usage}
            commands={commands}
            protocol={stream.protocol}
            onDrop={isMobile ? actions.drop : undefined}
            pendingAction={actions.pendingAction}
            machine={
              <TaskMachine
                task={task}
                worker={worker}
                node={{ name: "local · Docker", online: true }}
                stats={machine.stats}
                ports={machine.ports}
                workerHref={worker ? `/projects/${task.projectId}/workers/${worker.id}` : undefined}
                editorHref={editorHref}
                portHref={worker ? (port) => workerBaseUrl(worker.id, port) : undefined}
                render={{ link: nextLink }}
              />
            }
          />
        )
      }
    />
  )
}
