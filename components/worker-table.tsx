"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Clock, Code2, ChevronRight, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { workerBaseUrl } from "@/lib/worker-url"
import type { Worker } from "@/lib/types"
import { cfgFor, isSettingUp, phaseLabel, setupProgress, formatRelativeTime, GitStatusSummary, useWorkerMutations, type GitStatus } from "@/components/worker-card"

function StatusCell({ worker }: { worker: Worker }) {
  const settingUp = isSettingUp(worker.state)
  const running = worker.state === "ready"
  const cfg = cfgFor(worker.state)
  return (
    <div className="flex items-center gap-2">
      <div className="relative shrink-0">
        <div className={cn("h-2 w-2 rounded-full", settingUp ? "bg-yellow-400" : cfg.dotClass)} />
        {running && <div className="absolute inset-0 h-2 w-2 rounded-full bg-green-500 animate-ping opacity-50" />}
      </div>
      <span className="text-xs text-foreground/80">{settingUp ? phaseLabel(worker.setupStatus) : cfg.label}</span>
      {settingUp && <span className="text-[11px] font-mono text-muted-foreground tabular-nums">{setupProgress(worker.setupStatus)}%</span>}
    </div>
  )
}

function RowActions({ worker, projectId }: { worker: Worker; projectId: string }) {
  const running = worker.state === "ready"
  const { del } = useWorkerMutations(projectId, worker.id)
  const { data: gitStatus = [] } = useQuery({
    queryKey: ["git-status", worker.id],
    queryFn: () => api.get<GitStatus[]>(`/api/workers/${worker.id}/git-status`),
    enabled: running,
    refetchInterval: running ? 10000 : false,
  })
  return (
    <div className="flex items-center justify-end gap-1">
      {running && (
        <Tooltip content={gitStatus.length > 0 ? <GitStatusSummary gitStatus={gitStatus} /> : null} side="top">
          <a href={workerBaseUrl(worker.id)} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 text-xs gap-1")}>
            <Code2 className="h-3 w-3" /> Open
          </a>
        </Tooltip>
      )}
      <Link href={`/projects/${projectId}/workers/${worker.id}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-7 text-xs text-muted-foreground gap-1")}>
        View <ChevronRight className="h-3 w-3" />
      </Link>
      <button
        type="button"
        aria-label="Delete workspace"
        disabled={del.isPending}
        onClick={() => confirm("Delete this workspace?") && del.mutate()}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-7 w-7 px-0 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 disabled:opacity-50")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function WorkerTable({ workers, projectId }: { workers: Worker[]; projectId: string }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/60">
            {["Workspace", "Status", "Created", ""].map((h, i) => (
              <th key={i} className={cn("h-9 px-4 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70", i === 3 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={w.id} className="group border-b border-border/50 last:border-0 hover:bg-muted/20">
              <td className="px-4 py-2.5 min-w-[200px]">
                <div className="flex items-center gap-2">
                  <Link href={`/projects/${projectId}/workers/${w.id}`} className="font-medium text-sm truncate max-w-[240px] hover:text-primary">
                    {w.name}
                  </Link>
                  <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono leading-none bg-muted text-muted-foreground border-border">
                    v{w.projectVersion}
                  </span>
                </div>
              </td>
              <td className="px-4 py-2.5">
                <StatusCell worker={w} />
              </td>
              <td className="px-4 py-2.5">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" /> {formatRelativeTime(w.createdAt)}
                </span>
              </td>
              <td className="px-4 py-2.5 w-0">
                <RowActions worker={w} projectId={projectId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
