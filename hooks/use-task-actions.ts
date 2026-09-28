"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import { api } from "@/lib/api"
import { ALL_TASKS_KEY, PROJECT_TASKS_KEY, invalidateTask, patchTask, taskKey, type Task, type TaskPendingAction } from "@/lib/task-cache"

/**
 * The things a human can do to a task, wired so the screen knows what it is waiting for.
 *
 * Accept, Drop and a reply answer `202` and then take their time — the accept command may wake a
 * parked machine and run a test suite. So what is waited on is `task.pendingAction`, written by
 * the server for as long as the work runs; the client only *predicts* it between the click and
 * the answer (`onMutate`), so the button reacts on the finger's frame.
 */
function useTaskMutations() {
  const queryClient = useQueryClient()
  const options = (action: TaskPendingAction) => ({
    onMutate: async (taskId: string) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: taskKey(taskId) }),
        queryClient.cancelQueries({ queryKey: PROJECT_TASKS_KEY }),
        queryClient.cancelQueries({ queryKey: ALL_TASKS_KEY }),
      ])
      patchTask(queryClient, taskId, { pendingAction: action, pendingSince: new Date().toISOString() })
    },
    onSuccess: (data: Task, taskId: string) => patchTask(queryClient, taskId, data),
    onError: (error: Error, taskId: string) => {
      toast.error(error.message)
      invalidateTask(queryClient, taskId)
    },
  })
  const validate = useMutation({ mutationFn: (taskId: string) => api.post<Task>(`/api/tasks/${taskId}/validate`), ...options("accepting") })
  const cancel = useMutation({ mutationFn: (taskId: string) => api.post<Task>(`/api/tasks/${taskId}/cancel`), ...options("dropping") })
  return { validate, cancel }
}

/** Accept and Drop for the rows of a list — `TaskList`'s `onAccept`/`onDrop`. */
export function useTaskListActions() {
  const { validate, cancel } = useTaskMutations()
  return {
    accept: (task: Pick<Task, "id" | "pendingAction">) => !task.pendingAction && validate.mutate(task.id),
    drop: (task: Pick<Task, "id" | "pendingAction">) => !task.pendingAction && cancel.mutate(task.id),
  }
}

type TurnFile = { filename: string; mediaType: string; data: string }

export function useTaskActions(taskId: string, task?: Pick<Task, "pendingAction" | "pendingSince"> | null) {
  const queryClient = useQueryClient()
  const { validate, cancel } = useTaskMutations()

  const followUp = useMutation({
    mutationFn: ({ prompt, files }: { prompt: string; files: TurnFile[] }) =>
      api.post<Task>(`/api/tasks/${taskId}/messages`, { prompt, ...(files.length > 0 ? { files } : {}) }),
    onMutate: () => patchTask(queryClient, taskId, { pendingAction: "replying", pendingSince: new Date().toISOString() }),
    onSuccess: (data) => patchTask(queryClient, taskId, data),
    onError: () => invalidateTask(queryClient, taskId),
  })
  const interrupt = useMutation({
    mutationFn: () => api.post<Task>(`/api/tasks/${taskId}/interrupt`),
    onSuccess: (data) => patchTask(queryClient, taskId, data),
    onError: (error) => toast.error((error as Error).message),
  })
  const rename = useMutation({
    mutationFn: (title: string) => api.patch<Task>(`/api/tasks/${taskId}`, { title }),
    onMutate: (title) => patchTask(queryClient, taskId, { title }),
    onSuccess: (data) => patchTask(queryClient, taskId, data),
    onError: (error) => {
      toast.error((error as Error).message)
      invalidateTask(queryClient, taskId)
    },
  })

  const pendingAction: TaskPendingAction | null =
    task?.pendingAction ??
    (validate.isPending ? "accepting" : cancel.isPending ? "dropping" : followUp.isPending ? "replying" : null)
  const busy = pendingAction !== null

  return {
    pendingAction,
    pendingSince: task?.pendingSince ?? null,
    busy,
    accept: () => !busy && validate.mutate(taskId),
    drop: () => !busy && cancel.mutate(taskId),
    reply: (prompt: string, files: TurnFile[] = []) => !busy && followUp.mutate({ prompt, files }),
    rename: (title: string) => rename.mutate(title),
    renaming: rename.isPending,
    interrupt: () => interrupt.mutate(),
    replyError: followUp.error ? (followUp.error as Error).message : null,
    replyFailed: followUp.isError,
  }
}
