"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@spunto/design-system"
import {
  AlertTriangle,
  AlignLeft,
  ExternalLink,
  HardDrive,
  KeyRound,
  Network,
  Pencil,
  Play,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { Service } from "@/lib/types"
import { Button, buttonVariants } from "@/components/ui/button"
import { LogsPanel } from "@/components/logs-panel"
import { cfgFor, formatRelativeTime, ResourceBars, type Stats } from "@/components/worker-card"
import { serviceBaseUrl } from "@/lib/worker-url"

/** Reproduces `serviceAddress()` (services/services.ts) for display. */
function address(s: Service): string {
  if (s.httpPort) return `http://${s.slug}:${s.httpPort}`
  const port = s.ports[0]?.container
  return port ? `${s.slug}:${port}` : s.slug
}

/** `elastic-search` → `SPUNTO_SVC_ELASTIC_SEARCH`, the variable injected into workers. */
function envVarName(slug: string): string {
  return `SPUNTO_SVC_${slug.toUpperCase().replace(/-/g, "_")}`
}

function Chip({ icon: Icon, children, title }: { icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
    >
      {Icon && <Icon className="size-3 shrink-0" />}
      {children}
    </span>
  )
}

export function ServiceCard({ service, onEdit }: { service: Service; onEdit: () => void }) {
  const qc = useQueryClient()
  const [showLogs, setShowLogs] = useState(false)
  const cfg = cfgFor(service.state)
  const running = service.state === "ready"

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["services"] })
    qc.invalidateQueries({ queryKey: ["resources"] })
  }
  const lifecycle = (action: string, message: string) => ({
    mutationFn: () => api.post(`/api/services/${service.id}/${action}`),
    onSuccess: () => {
      invalidate()
      toast.success(message)
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  })

  const start = useMutation(lifecycle("start", "Starting…"))
  const stop = useMutation(lifecycle("stop", "Stopped"))
  const restart = useMutation(lifecycle("restart", "Restarting…"))
  const del = useMutation({
    mutationFn: () => api.del(`/api/services/${service.id}`),
    onSuccess: () => {
      invalidate()
      toast.success(`Service ${service.slug} deleted`)
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const { data: stats } = useQuery({
    queryKey: ["service-stats", service.id],
    queryFn: () => api.get<Stats | null>(`/api/services/${service.id}/stats`),
    enabled: running,
    refetchInterval: running ? 3000 : false,
  })

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative shrink-0">
                <div className={cn("h-2 w-2 rounded-full", cfg.dotClass)} />
                {running && <div className="absolute inset-0 h-2 w-2 rounded-full bg-green-500 animate-ping opacity-50" />}
              </div>
              <span className="font-semibold text-sm leading-none">{service.slug}</span>
              <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none", cfg.pillClass)}>
                {cfg.label}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground truncate" title={service.image}>
              {service.description ? `${service.description} · ` : ""}
              <span className="font-mono">{service.image}</span>
            </p>
          </div>
          {running && service.httpPort && (
            <a
              href={serviceBaseUrl(service.slug)}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 shrink-0 text-xs gap-1.5")}
            >
              <ExternalLink className="size-3.5" /> Open
            </a>
          )}
        </div>

        {/* What a worker needs to know: the address, and the variable carrying it. */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip icon={Network} title="Reachable at this address from any worker">
            {address(service)}
          </Chip>
          <Chip title="Injected into every worker at spawn">{envVarName(service.slug)}</Chip>
          {service.ports
            .filter((p) => p.host != null)
            .map((p) => (
              <Chip key={p.container} title={`Published on the host: ${p.host} → ${p.container}`}>
                host :{p.host}
              </Chip>
            ))}
          {service.volumes.map((v) => (
            <Chip key={v.name} icon={HardDrive} title={`Persistent volume mounted at ${v.mountPath}`}>
              {v.name}
            </Chip>
          ))}
          {service.env.some((e) => e.secretName) && (
            <Chip icon={KeyRound} title="Some variables come from your global secrets">
              {service.env.filter((e) => e.secretName).length} secret
              {service.env.filter((e) => e.secretName).length === 1 ? "" : "s"}
            </Chip>
          )}
        </div>

        {service.state === "error" && service.error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-500">
            <AlertTriangle className="size-3.5 shrink-0 mt-px" />
            <span className="font-mono break-all">{service.error}</span>
          </div>
        )}

        {running && stats ? (
          <ResourceBars stats={stats} />
        ) : (
          <div className="mt-3 rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 text-[11px] text-muted-foreground">
            Not consuming resources ({cfg.label.toLowerCase()}) · created {formatRelativeTime(service.createdAt)}
          </div>
        )}
      </div>

      {showLogs && (
        <div className="mx-4 mb-3 h-56 rounded-lg bg-[#09090b] p-2">
          <LogsPanel url={`/api/services/${service.id}/logs`} />
        </div>
      )}

      <div className="px-3 py-2 border-t border-border/50 bg-muted/20 rounded-b-xl flex items-center gap-1.5 flex-wrap">
        {running ? (
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <Button variant="default" size="sm" className="h-7 text-xs gap-1.5" onClick={() => start.mutate()} disabled={start.isPending}>
            <Play className="size-3.5" /> Start
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={() => restart.mutate()} disabled={restart.isPending}>
          <RotateCw className="size-3.5" /> Restart
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 text-xs gap-1.5", showLogs && "text-foreground bg-accent")}
          onClick={() => setShowLogs((v) => !v)}
        >
          <AlignLeft className="size-3.5" /> Logs
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={onEdit}>
          <Pencil className="size-3.5" /> Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1.5 ml-auto text-destructive hover:bg-destructive/10"
          onClick={() =>
            confirm(`Delete the service "${service.slug}"?\n\nIts container AND its persistent volumes are removed — the data is gone for good.`) &&
            del.mutate()
          }
          disabled={del.isPending}
        >
          <Trash2 className="size-3.5" /> Delete
        </Button>
      </div>
    </div>
  )
}
