"use client"

import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AlarmClockOff, Loader2Icon, MoonIcon, PowerIcon, Timer, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { invalidateTask, patchTask, type Task } from "@/lib/task-cache"
import { machinePortsKey } from "@/hooks/use-machine-ports"

/** « in 14 min », « in under a minute » — how far off a scheduled park is, re-read every few seconds. */
function useParkCountdown(parkAt: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!parkAt) return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [parkAt])
  if (!parkAt) return null
  const ms = new Date(parkAt).getTime() - now
  // Past due: the background floor parks it on its next tick (within 10 s).
  if (ms <= 0) return "any moment now"
  const minutes = Math.ceil(ms / 60_000)
  return minutes <= 1 ? "in under a minute" : `in ${minutes} min`
}

/**
 * Park, Wake and Keep awake — the moves a reader can make on the machine of a task in review,
 * under the package's `TaskMachine`. Ported from Spunto Cloud (`task-machine-controls.tsx`), which
 * keeps it in the app rather than in `@spunto/design-system/tasks` for now.
 *
 * Driven by `task.machine`, the API's derived axis, rather than by the worker row the panel above
 * reads: it is the same answer the list and the conversation get. With review mode `stop` and a
 * delay (`taskReviewParkAfterMinutes`), the task carries `parkAt`: a countdown, and Keep awake to
 * call it off (Cloud 275d6fed).
 */
export function TaskMachineControls({ task }: { task: Task }) {
  const queryClient = useQueryClient()
  const options = {
    onSuccess: (data: Task) => {
      patchTask(queryClient, task.id, data)
      // The machine panel above polls on its own cadence; the machine just moved, so re-read it now
      // — the worker, and its ports, which go grey with it (Cloud 8f02399d: without it, a Park
      // showed "Running" until the next poll, up to 10 s after the container stopped).
      queryClient.invalidateQueries({ queryKey: ["worker", task.workerId] })
      queryClient.invalidateQueries({ queryKey: machinePortsKey(task.workerId) })
    },
    onError: () => invalidateTask(queryClient, task.id),
  }
  const park = useMutation({ mutationFn: () => api.post<Task>(`/api/tasks/${task.id}/park`), ...options })
  const wake = useMutation({ mutationFn: () => api.post<Task>(`/api/tasks/${task.id}/wake`), ...options })
  const keepAwake = useMutation({ mutationFn: () => api.post<Task>(`/api/tasks/${task.id}/keep-awake`), ...options })
  // Review mode `stop` with a delay: the machine goes down on its own at `parkAt` unless kept awake.
  const parkAt = task.state === "in-review" && task.machine === "awake" ? task.parkAt : null
  const countdown = useParkCountdown(parkAt)

  if (task.state !== "in-review" && task.machine !== "lost") return null
  const busy = park.isPending || wake.isPending || keepAwake.isPending || !!task.pendingAction
  const error = park.error ?? wake.error ?? keepAwake.error

  return (
    <div className="space-y-1.5">
      {parkAt && countdown && (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5" data-slot="task-park-countdown">
          <Timer className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground" title={new Date(parkAt).toLocaleString()}>
            Parks on its own <span className="font-medium text-foreground">{countdown}</span> unless you reply.
          </p>
          <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={busy} onClick={() => keepAwake.mutate()}>
            {keepAwake.isPending ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : <AlarmClockOff className="h-3.5 w-3.5" />}
            Keep awake
          </Button>
        </div>
      )}
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
      {task.machine === "awake" && !parkAt && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Not deciding yet? Parking stops the container and keeps its disk; replying, accepting or dropping wakes it
          again.
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error.message}</p>}
    </div>
  )
}
