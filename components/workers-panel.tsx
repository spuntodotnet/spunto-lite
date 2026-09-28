"use client"

import { useEffect, useState } from "react"
import { LayoutGrid, Rows3, Container } from "lucide-react"
import type { WorkerTask } from "@spunto/design-system/tasks"
import { cn } from "@/lib/utils"
import type { Worker } from "@/lib/types"
import { WorkerCard } from "@/components/worker-card"
import { WorkerTable } from "@/components/worker-table"
import { SpawnWorkerButton } from "@/components/spawn-worker-button"

export type WorkerView = "card" | "table"

/** Cards or table, remembered across visits. */
export function useWorkerView(): [WorkerView, (view: WorkerView) => void] {
  const [view, setView] = useState<WorkerView>("card")
  useEffect(() => {
    const saved = localStorage.getItem("spunto-lite:workerView") as WorkerView | null
    if (saved === "card" || saved === "table") setView(saved)
  }, [])
  const select = (v: WorkerView) => {
    setView(v)
    localStorage.setItem("spunto-lite:workerView", v)
  }
  return [view, select]
}

/** The cards/table switch — drawn in the project's tab strip, on the Workspaces tab. */
export function WorkerViewToggle({ view, onChange, className }: { view: WorkerView; onChange: (view: WorkerView) => void; className?: string }) {
  const button = (value: WorkerView, label: string, Icon: typeof LayoutGrid) => (
    <button
      type="button"
      aria-pressed={view === value}
      aria-label={label}
      title={label}
      onClick={() => onChange(value)}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
        view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground/60 hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
  return (
    <div className={cn("inline-flex items-center rounded-lg border border-border bg-muted/30 p-0.5", className)}>
      {button("card", "Card view", LayoutGrid)}
      {button("table", "Table view", Rows3)}
    </div>
  )
}

/**
 * The machines of a project, each naming the task it is busy with. The rows come from the page,
 * which also holds the tasks: one query per list for both tabs, so the tab counts and the lists
 * under them can never disagree.
 */
export function WorkersPanel({
  projectId,
  projectVersion,
  workers,
  view,
  taskFor,
}: {
  projectId: string
  projectVersion: number
  workers: Worker[]
  view: WorkerView
  taskFor?: (worker: Worker) => WorkerTask | undefined
}) {
  if (workers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border">
        <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
          <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
            <Container className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-sm">No workspaces yet</p>
            <p className="text-sm text-muted-foreground mt-1">Spawn a workspace to get a full dev environment with code-server.</p>
          </div>
          <SpawnWorkerButton projectId={projectId} variant="outline" />
        </div>
      </div>
    )
  }
  return view === "card" ? (
    <div className="grid gap-3 sm:grid-cols-2">
      {workers.map((w) => (
        <WorkerCard key={w.id} worker={w} projectId={projectId} projectVersion={projectVersion} task={taskFor?.(w)} />
      ))}
    </div>
  ) : (
    <WorkerTable workers={workers} projectId={projectId} projectVersion={projectVersion} taskFor={taskFor} />
  )
}
