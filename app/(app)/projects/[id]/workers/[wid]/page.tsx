"use client"

import { use } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ArrowLeft, ExternalLink, Play, Square, RotateCw, Trash2, GitBranch, Cpu } from "lucide-react"
import { api } from "@/lib/api"
import type { Worker, Project, ProjectImageBuild } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { LogsPanel } from "@/components/logs-panel"
import { SetupTimeline } from "@/components/workers-panel"
import { WorkerTerminal } from "@/components/worker-terminal"
import { workerBaseUrl } from "@/lib/worker-url"

type GitStatus = { path: string; branch: string; modified: number; ahead: number; behind: number }
type Stats = { cpuPercent: number; memUsageMb: number; memLimitMb: number; memPercent: number }

export default function WorkerCockpit({ params }: { params: Promise<{ id: string; wid: string }> }) {
  const { id, wid } = use(params)
  const router = useRouter()
  const qc = useQueryClient()

  const { data: worker } = useQuery({
    queryKey: ["worker", wid],
    queryFn: () => api.get<Worker>(`/api/workers/${wid}`),
    refetchInterval: 2500,
  })
  const { data: project } = useQuery({ queryKey: ["project", id], queryFn: () => api.get<Project>(`/api/projects/${id}`) })
  const { data: builds = [] } = useQuery({
    queryKey: ["builds", id],
    queryFn: () => api.get<ProjectImageBuild[]>(`/api/projects/${id}/builds`),
    refetchInterval: worker?.state === "building" ? 2000 : false,
  })
  const { data: gitStatus = [] } = useQuery({
    queryKey: ["git-status", wid],
    queryFn: () => api.get<GitStatus[]>(`/api/workers/${wid}/git-status`),
    refetchInterval: worker?.state === "ready" ? 5000 : false,
    enabled: worker?.state === "ready",
  })
  const { data: stats } = useQuery({
    queryKey: ["stats", wid],
    queryFn: () => api.get<Stats | null>(`/api/workers/${wid}/stats`),
    refetchInterval: worker?.state === "ready" ? 3000 : false,
    enabled: worker?.state === "ready",
  })
  const { data: ports = [] } = useQuery({
    queryKey: ["ports", wid],
    queryFn: () => api.get<number[]>(`/api/workers/${wid}/ports`),
    refetchInterval: worker?.state === "ready" ? 5000 : false,
    enabled: worker?.state === "ready",
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ["worker", wid] })
  const act = (fn: () => Promise<unknown>, msg: string) =>
    fn().then(() => { invalidate(); toast.success(msg) }).catch((e) => toast.error((e as Error).message))
  const del = useMutation({
    mutationFn: () => api.del(`/api/workers/${wid}`),
    onSuccess: () => { toast.success("Worker deleted"); router.push(`/projects/${id}`) },
  })

  if (!worker) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const running = worker.state === "ready"
  const building = worker.state === "building"
  const latestBuild = builds[0]

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={`/projects/${id}`}>
            <Button variant="ghost" size="icon" className="size-8">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <div className="font-medium truncate">{worker.name}</div>
            <div className="text-xs text-muted-foreground">{project?.name}</div>
          </div>
          <StateBadge state={worker.state} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {running && (
            <a href={workerBaseUrl(worker.id)} target="_blank" rel="noreferrer">
              <Button size="sm">
                <ExternalLink /> Open VS Code
              </Button>
            </a>
          )}
          {worker.state === "stopped" ? (
            <Button variant="outline" size="sm" onClick={() => act(() => api.post(`/api/workers/${wid}/start`), "Starting")}>
              <Play /> Start
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => act(() => api.post(`/api/workers/${wid}/stop`), "Stopped")}>
              <Square /> Stop
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-8" onClick={() => act(() => api.post(`/api/workers/${wid}/rebuild`), "Rebuilding")}>
            <RotateCw className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => confirm("Delete worker?") && del.mutate()}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-4 min-h-0">
        <div className="min-h-0 flex flex-col gap-2">
          {running ? (
            <WorkerTerminal workerId={wid} />
          ) : building ? (
            <div className="flex-1 min-h-0 rounded-lg border border-dashed border-border flex items-center justify-center text-sm text-muted-foreground">
              Building the project image… (see logs below)
            </div>
          ) : (
            <LogsPanel url={`/api/workers/${wid}/logs`} />
          )}
          {building && latestBuild && (
            <div className="h-48 shrink-0">
              <div className="text-xs text-muted-foreground mb-1">Image build logs</div>
              <BuildLogs logs={latestBuild.logs} />
            </div>
          )}
        </div>

        <div className="space-y-4 overflow-auto">
          {worker.setupStatus && worker.state !== "ready" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Setup</CardTitle>
              </CardHeader>
              <CardContent>
                <SetupTimeline status={worker.setupStatus} />
              </CardContent>
            </Card>
          )}
          {running && stats && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Cpu className="size-4" /> Resources
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Meter label="CPU" value={stats.cpuPercent} suffix="%" />
                <Meter label="Memory" value={stats.memPercent} suffix="%" sub={`${stats.memUsageMb} / ${stats.memLimitMb} MB`} />
              </CardContent>
            </Card>
          )}
          {running && gitStatus.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <GitBranch className="size-4" /> Git
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                {gitStatus.map((g) => (
                  <div key={g.path} className="flex items-center justify-between">
                    <span className="font-mono truncate">{g.path.replace("/workspace/", "")}</span>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span>{g.branch || "—"}</span>
                      {g.modified > 0 && <Badge variant="warning">{g.modified}★</Badge>}
                      {g.ahead > 0 && <Badge variant="muted">↑{g.ahead}</Badge>}
                      {g.behind > 0 && <Badge variant="muted">↓{g.behind}</Badge>}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          {running && ports.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Open ports</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {ports.map((p) => (
                  <a key={p} href={workerBaseUrl(worker.id, p)} target="_blank" rel="noreferrer">
                    <Badge variant="default">:{p} ↗</Badge>
                  </a>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, "success" | "warning" | "muted" | "destructive"> = {
    ready: "success",
    building: "warning",
    starting: "warning",
    stopped: "muted",
    error: "destructive",
    pending: "muted",
  }
  return <Badge variant={map[state] ?? "muted"}>{state}</Badge>
}

function Meter({ label, value, suffix, sub }: { label: string; value: number; suffix: string; sub?: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span>
          {value}
          {suffix} {sub && <span className="text-muted-foreground">· {sub}</span>}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-border mt-1">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  )
}

function BuildLogs({ logs }: { logs: string }) {
  return (
    <pre className="h-full overflow-auto bg-[oklch(0.17_0.012_52)] text-zinc-200 text-[11px] font-mono p-3 rounded-lg whitespace-pre-wrap break-words">
      {logs || "Building…"}
    </pre>
  )
}
