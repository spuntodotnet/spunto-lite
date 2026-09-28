"use client"

import type { QueryClient } from "@tanstack/react-query"
import type { TaskItem, TaskPendingAction } from "@spunto/design-system/tasks"

export type { TaskPendingAction }

/** A task as the API returns it — the package's `TaskItem`, with what every response carries. */
export interface Task extends TaskItem {
  projectId: string
  prompt: string
  branch: string
  baseBranch: string | null
  model: string | null
  workerId: string | null
  commandId: string | null
  error: string | null
  autoTitle: boolean
  lastActivityAt: string
  startedAt: string | null
  completedAt: string | null
  pendingAction: TaskPendingAction | null
  pendingSince: string | null
  /** Only on `GET /api/tasks/:id`. */
  canResume?: boolean
}

/** A row of the agent cockpit's list: a task and the name of its project. */
export type TaskRow = Task & { projectName: string }
export type TasksPage = { tasks: TaskRow[]; total: number; counts: Record<string, number> }

/**
 * One task, three caches — and the rules that keep them telling the same story (docs/tasks.md §
 * "Réactivité"). A project's panel, the agent cockpit's list and the conversation itself each read
 * the task on their own cadence; whoever learns something new about it — a mutation's answer, the
 * conversation's faster poll — **writes it into all three** instead of waiting for their next tick.
 */
export const taskKey = (taskId: string) => ["task", taskId]
/** Prefixes: every project's list, every filter/page of the cockpit's. */
export const PROJECT_TASKS_KEY = ["project-tasks"]
export const ALL_TASKS_KEY = ["all-tasks"]

export function patchTask(queryClient: QueryClient, taskId: string, patch: Partial<Task>): void {
  queryClient.setQueryData(taskKey(taskId), (old: Task | undefined) => (old ? { ...old, ...patch } : old))
  patchTaskLists(queryClient, taskId, patch)
}

/** The same, minus the conversation's own row — for whoever is *reading* that row. */
export function patchTaskLists(queryClient: QueryClient, taskId: string, patch: Partial<Task>): void {
  queryClient.setQueriesData({ queryKey: PROJECT_TASKS_KEY }, (old: Task[] | undefined) =>
    Array.isArray(old) ? old.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) : old,
  )
  queryClient.setQueriesData({ queryKey: ALL_TASKS_KEY }, (old: TasksPage | undefined) =>
    old?.tasks ? { ...old, tasks: old.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) } : old,
  )
}

/** A task just delegated, at the top of every list that would have it — before any list is asked again. */
export function insertTask(queryClient: QueryClient, task: Task): void {
  queryClient.setQueriesData({ queryKey: [...PROJECT_TASKS_KEY, task.projectId] }, (old: Task[] | undefined) =>
    Array.isArray(old) && !old.some((t) => t.id === task.id) ? [task, ...old] : old,
  )
  queryClient.setQueriesData({ queryKey: ALL_TASKS_KEY }, (old: TasksPage | undefined) => {
    if (!old?.tasks || old.tasks.some((t) => t.id === task.id)) return old
    return {
      ...old,
      total: old.total + 1,
      counts: { ...old.counts, [task.state]: (old.counts[task.state] ?? 0) + 1 },
      tasks: [{ projectName: "", ...task }, ...old.tasks],
    }
  })
}

/** Re-read a task and every list — for when a patch isn't enough (an error, a 409). */
export function invalidateTask(queryClient: QueryClient, taskId: string): void {
  queryClient.invalidateQueries({ queryKey: taskKey(taskId) })
  queryClient.invalidateQueries({ queryKey: PROJECT_TASKS_KEY })
  queryClient.invalidateQueries({ queryKey: ALL_TASKS_KEY })
}

export function isLiveTask(state: string): boolean {
  return state === "queued" || state === "running" || state === "in-review"
}

/**
 * How often a surface showing these tasks should ask again: **1 s** while an action is in flight
 * (someone is watching for the answer), `base` while work is live, `idle` for history — slow
 * rather than never on a list, so a task delegated elsewhere still shows up; never on a finished
 * conversation, which cannot move.
 */
export function taskPollInterval(tasks: Pick<Task, "state" | "pendingAction">[], base: number, idle: number | false = 20_000) {
  if (tasks.some((t) => t.pendingAction)) return 1_000
  if (tasks.some((t) => isLiveTask(t.state))) return base
  return idle
}
