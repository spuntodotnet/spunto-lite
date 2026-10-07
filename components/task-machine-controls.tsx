"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2Icon, MoonIcon, PowerIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { invalidateTask, patchTask, type Task } from "@/lib/task-cache"

/**
 * Park and Wake — the two moves a reader can make on the machine of a task in review, under the
 * package's `TaskMachine`. Ported from Spunto Cloud (`task-machine-controls.tsx`), which keeps it
 * in the app rather than in `@spunto/design-system/tasks` for now.
 *
 * Driven by `task.machine`, the API's derived axis, rather than by the worker row the panel above
 * reads: it is the same answer the list and the conversation get.
 */
export function TaskMachineControls({ task }: { task: Task }) {
  const queryClient = useQueryClient()
  const options = {
    onSuccess: (data: Task) => {
      patchTask(queryClient, task.id, data)
      // The worker panel above polls on its own cadence; the machine just moved, so re-read it now.
      queryClient.invalidateQueries({ queryKey: ["worker", task.workerId] })
    },
    onError: () => invalidateTask(queryClient, task.id),
  }
  const park = useMutation({ mutationFn: () => api.post<Task>(`/api/tasks/${task.id}/park`), ...options })
  const wake = useMutation({ mutationFn: () => api.post<Task>(`/api/tasks/${task.id}/wake`), ...options })

  if (task.state !== "in-review" && task.machine !== "lost") return null
  const busy = park.isPending || wake.isPending || !!task.pendingAction
  const error = park.error ?? wake.error

  return (
    <div className="space-y-1.5">
      {task.machine === "awake" && (
        <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={() => park.mutate()}>
          {park.isPending ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : <MoonIcon className="h-3.5 w-3.5" />}
          Park the machine
        </Button>
      )}
      {task.machine === "parked" && (
        <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={() => wake.mutate()}>
          {wake.isPending ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : <PowerIcon className="h-3.5 w-3.5" />}
          Wake the machine
        </Button>
      )}
      {task.machine === "lost" && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-destructive">
          <TriangleAlertIcon className="mt-0.5 h-3 w-3 shrink-0" />
          The machine is gone (deleted, or its setup failed). The task can still be dropped, but not continued.
        </p>
      )}
      {task.machine === "awake" && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Not deciding yet? Parking stops the container and keeps its disk; replying, accepting or dropping wakes it
          again.
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error.message}</p>}
    </div>
  )
}
