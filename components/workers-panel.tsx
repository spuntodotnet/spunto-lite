"use client"

import { useState } from "react"
import Link from "next/link"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Container, Play, Square, RotateCw, Trash2, Plus, ExternalLink, Loader2 } from "lucide-react"
import { api } from "@/lib/api"
import type { Worker, SetupStatus } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { workerBaseUrl } from "@/lib/worker-url"

const STATE_BADGE: Record<string, { label: string; variant: "success" | "warning" | "muted" | "destructive" | "default" }> = {
  pending: { label: "Pending", variant: "muted" },
  building: { label: "Building image", variant: "warning" },
  starting: { label: "Starting", variant: "warning" },
  ready: { label: "Ready", variant: "success" },
  stopped: { label: "Stopped", variant: "muted" },
  error: { label: "Error", variant: "destructive" },
}

export function WorkersPanel({ projectId, projectVersion }: { projectId: string; projectVersion: number }) {
  const qc = useQueryClient()
  const { data: workers = [] } = useQuery({
    queryKey: ["workers", projectId],
    queryFn: () => api.get<Worker[]>(`/api/projects/${projectId}/workers`),
    refetchInterval: 2500,
  })

  const spawn = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/workers`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workers", projectId] })
      toast.success("Worker spawning…")
    },
    onError: (e) => toast.error((e as Error).message),
  })

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Container className="size-4" /> Workers
        </CardTitle>
        <Button size="sm" onClick={() => spawn.mutate()} disabled={spawn.isPending}>
          <Plus /> Spawn worker
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {workers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workers yet. Spawn one to get a running dev container.</p>
        ) : (
          workers.map((w) => (
            <WorkerRow key={w.id} worker={w} projectId={projectId} behindVersion={w.projectVersion < projectVersion} />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function WorkerRow({ worker, projectId, behindVersion }: { worker: Worker; projectId: string; behindVersion: boolean }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const badge = STATE_BADGE[worker.state] ?? STATE_BADGE.pending
  const invalidate = () => qc.invalidateQueries({ queryKey: ["workers", projectId] })

  async function act(fn: () => Promise<unknown>, msg?: string) {
    setBusy(true)
    try {
      await fn()
      invalidate()
      if (msg) toast.success(msg)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const codeUrl = workerBaseUrl(worker.id)

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Link href={`/projects/${projectId}/workers/${worker.id}`} className="font-medium text-sm truncate hover:underline">
            {worker.name}
          </Link>
          <Badge variant={badge.variant}>
            {(worker.state === "building" || worker.state === "starting") && <Loader2 className="size-3 animate-spin" />}
            {badge.label}
          </Badge>
          {behindVersion && <Badge variant="warning">behind</Badge>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {worker.state === "ready" && (
            <a href={codeUrl} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm">
                <ExternalLink /> VS Code
              </Button>
            </a>
          )}
          {worker.state === "stopped" ? (
            <Button variant="ghost" size="icon" className="size-8" disabled={busy} onClick={() => act(() => api.post(`/api/workers/${worker.id}/start`), "Starting")}>
              <Play className="size-4" />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" className="size-8" disabled={busy} onClick={() => act(() => api.post(`/api/workers/${worker.id}/stop`), "Stopped")}>
              <Square className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-8" disabled={busy} onClick={() => act(() => api.post(`/api/workers/${worker.id}/rebuild`), "Rebuilding")}>
            <RotateCw className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" disabled={busy} onClick={() => confirm("Delete this worker?") && act(() => api.del(`/api/workers/${worker.id}`), "Deleted")}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {worker.setupStatus && worker.state !== "ready" && worker.state !== "stopped" && (
        <SetupTimeline status={worker.setupStatus} />
      )}
    </div>
  )
}

const PHASE_ORDER = ["initializing", "credentials", "dotfiles", "cloning", "lifecycle", "ready"]

export function SetupTimeline({ status }: { status: SetupStatus }) {
  const idx = PHASE_ORDER.indexOf(status.phase)
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center gap-1">
        {PHASE_ORDER.map((p, i) => (
          <div
            key={p}
            className={`h-1 flex-1 rounded-full ${
              status.phase === "error" ? "bg-destructive/40" : i <= idx ? "bg-primary" : "bg-border"
            }`}
          />
        ))}
      </div>
      <div className="text-xs text-muted-foreground capitalize">
        {status.phase === "error" ? <span className="text-destructive">Error: {status.error || "setup failed"}</span> : `${status.phase}…`}
      </div>
      {status.repos.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {status.repos.map((r) => (
            <Badge key={r.name} variant={r.state === "done" ? "success" : r.state === "error" ? "destructive" : "muted"}>
              {r.name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
