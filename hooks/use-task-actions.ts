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

type QuestionAnswer = { question: string; selected: string[]; text?: string | null }

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
  // The member's choice for a question the agent waits on: one line into the live stdin, like an
  // interrupt. The card holds its own "sent" state until the session restates the question.
  const answer = useMutation({
    mutationFn: ({ callId, answers }: { callId: string; answers: QuestionAnswer[] }) => api.post<Task>(`/api/tasks/${taskId}/answer`, { callId, answers }),
    onSuccess: (data) => patchTask(queryClient, taskId, data),
    onError: () => invalidateTask(queryClient, taskId),
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

  // On hold parks the machine too: the task is read again for its machine dot, and the lists for
  // the row that just left them.
  const hold = useMutation({
    mutationFn: (onHold: boolean) => api.post<Task>(`/api/tasks/${taskId}/${onHold ? "hold" : "unhold"}`),
    onMutate: (onHold) => patchTask(queryClient, taskId, { onHoldAt: onHold ? new Date().toISOString() : null }),
    onSuccess: (data) => patchTask(queryClient, taskId, data),
    onError: (error) => toast.error((error as Error).message),
    onSettled: () => invalidateTask(queryClient, taskId),
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
    /** Set a task in review aside, its machine parked (`true`), or back to review (`false`) — docs/taches.md § « On hold : pour plus tard ». */
    setOnHold: (onHold: boolean) => hold.mutate(onHold),
    holding: hold.isPending,
    interrupt: () => interrupt.mutate(),
    /** Answer a question the agent is waiting on. Rejects with the API's reason, which the card shows. */
    answer: async (callId: string, answers: QuestionAnswer[]) => {
      await answer.mutateAsync({ callId, answers })
    },
    replyError: followUp.error ? (followUp.error as Error).message : null,
    replyFailed: followUp.isError,
  }
}

/**
 * On hold / Back to review for a row of a list (`POST /api/tasks/:id/{hold,unhold}`). The row is
 * marked in every cache on the click — the cockpit's list filters on `onHoldAt`, so it leaves on
 * that frame — then the lists are read again, for the counts and the machine the hold just parked.
 */
export function useTaskHoldActions() {
  const queryClient = useQueryClient()
  const hold = useMutation({
    mutationFn: ({ taskId, onHold }: { taskId: string; onHold: boolean }) => api.post<Task>(`/api/tasks/${taskId}/${onHold ? "hold" : "unhold"}`),
    onMutate: ({ taskId, onHold }) => patchTask(queryClient, taskId, { onHoldAt: onHold ? new Date().toISOString() : null }),
    onError: (error: Error, { taskId }) => {
      toast.error(error.message)
      invalidateTask(queryClient, taskId)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PROJECT_TASKS_KEY })
      queryClient.invalidateQueries({ queryKey: ALL_TASKS_KEY })
    },
  })
  return { setOnHold: (task: Pick<Task, "id">, onHold: boolean) => hold.mutate({ taskId: task.id, onHold }) }
}
