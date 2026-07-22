"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { LayoutGrid, Rows3, Container } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { Worker } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { WorkerCard } from "@/components/worker-card"
import { WorkerTable } from "@/components/worker-table"
import { SpawnWorkerButton } from "@/components/spawn-worker-button"

type View = "card" | "table"

export function WorkersPanel({ projectId, projectVersion }: { projectId: string; projectVersion: number }) {
  const [view, setView] = useState<View>("card")

  useEffect(() => {
    const saved = localStorage.getItem("spunto-lite:workerView") as View | null
    if (saved === "card" || saved === "table") setView(saved)
  }, [])
  const selectView = (v: View) => {
    setView(v)
    localStorage.setItem("spunto-lite:workerView", v)
  }

  const { data: workers = [] } = useQuery({
    queryKey: ["workers", projectId],
    queryFn: () => api.get<Worker[]>(`/api/projects/${projectId}/workers`),
    refetchInterval: 2500,
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Workspaces</h2>
          <Badge variant="secondary" className="text-[11px] h-5 px-1.5">
            {workers.length}
          </Badge>
        </div>
        {workers.length > 0 && (
          <div className="inline-flex items-center rounded-lg border border-border bg-muted/30 p-0.5">
            <button
              aria-pressed={view === "card"}
              onClick={() => selectView("card")}
              className={cn("flex h-6 w-6 items-center justify-center rounded-md transition-colors", view === "card" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground/60 hover:text-foreground")}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              aria-pressed={view === "table"}
              onClick={() => selectView("table")}
              className={cn("flex h-6 w-6 items-center justify-center rounded-md transition-colors", view === "table" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground/60 hover:text-foreground")}
            >
              <Rows3 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {workers.length === 0 ? (
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
      ) : view === "card" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {workers.map((w) => (
            <WorkerCard key={w.id} worker={w} projectId={projectId} projectVersion={projectVersion} />
          ))}
        </div>
      ) : (
        <WorkerTable workers={workers} projectId={projectId} projectVersion={projectVersion} />
      )}
    </div>
  )
}
